/**
 * db.mjs —— SQLite 数据层（自托管 D1 等价物）
 *
 * 替代 Cloudflare KV：src/index.js 里所有 kvXxx 数据访问函数统一转发到这里。
 * 使用 Node 内置 node:sqlite（同步 API），零 npm 依赖。
 *
 *   启动要求：
 *     Node 22.5+      需要 --experimental-sqlite 启动参数
 *     Node 23.4+ / 24  默认可用，无需参数
 *
 * server.mjs 会把实例挂到 globalThis.__db，供 src/index.js 使用。
 * 表结构即为 README 里 KV key 约定的关系化版本：
 *   user:{openid}     → users    表（openid UNIQUE）
 *   id2openid:{id}    → users.id（派生，不再单独存）
 *   counter:user_id   → counters 表（nextUserId 原子自增）
 *   app:products      → products 表
 *   order:{id}        → orders 表
 *   order_out / order_wx / order_user  → orders 的列 + 索引（派生，不再单独存）
 *   log:{rev_ts}:{r}  → logs 表
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { currentDevice } from './meta.mjs';
import path from 'node:path';

/** 后台「导出全部数据」白名单：key=下载标识，value=导出 SQL（只导业务列，不导 session_key 等敏感字段） */
const EXPORT_TABLES = {
  users:     'SELECT id,openid,nickname,phone,xpay_count,xpay_total,xpay_spent,status,remark,created_at FROM users ORDER BY id',
  orders:    'SELECT id,outTradeNo,userId,openid,productId,productName,goodsPrice,buyQuantity,times,status,mock,note,createdAt,deliveredAt FROM orders ORDER BY createdAt DESC',
  serials:   'SELECT id,user_id,openid,serial,category,version,source,cost,status,activated_at,claimed_at,remark FROM user_serials ORDER BY id',
  codes:     'SELECT id,user_id,openid,kind,mac,code,cost,created_at,remark FROM user_codes ORDER BY id',
  referrals: 'SELECT id,inviter_id,invitee_id,wish,created_at FROM referrals ORDER BY id',
  logs:      'SELECT id,user_id,action,detail,ip,nickname,openid,device,created_at FROM logs ORDER BY id',
};

/**
 * 整表恢复导入白名单：key=与导出一致的标识，table=真实表名，columns=按导出列原样写回。
 * 整表替换：先 DELETE 再 INSERT（保留原 id / 时间），users 不走这里（按ID更新，见 importUsers）。
 */
const IMPORT_TABLES = {
  logs:      { table: 'logs',         columns: ['id','user_id','action','detail','ip','nickname','openid','device','created_at'] },
  orders:    { table: 'orders',       columns: ['id','outTradeNo','userId','openid','productId','productName','goodsPrice','buyQuantity','times','status','mock','note','createdAt','deliveredAt'] },
  serials:   { table: 'user_serials', columns: ['id','user_id','openid','serial','category','version','source','cost','status','activated_at','claimed_at','remark'] },
  codes:     { table: 'user_codes',   columns: ['id','user_id','openid','kind','mac','code','cost','created_at','remark'] },
  referrals: { table: 'referrals',    columns: ['id','inviter_id','invitee_id','wish','created_at'] },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  openid        TEXT NOT NULL UNIQUE,
  unionid       TEXT,
  session_key   TEXT,
  nickname      TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  xpay_count    INTEGER NOT NULL DEFAULT 0,
  xpay_total    INTEGER NOT NULL DEFAULT 0,
  xpay_spent    INTEGER NOT NULL DEFAULT 0,
  -- 直购模型（2026-08）：不再有「愿望余额」，只有「免费次数」+「累计实付」
  free_serial   INTEGER NOT NULL DEFAULT 0,   -- 剩余免费取号次数（邀请好友获得）
  free_socket   INTEGER NOT NULL DEFAULT 0,   -- 剩余免费验证码次数
  serial_earned INTEGER NOT NULL DEFAULT 0,   -- 累计已发放免费取号次数（防重复发放）
  socket_earned INTEGER NOT NULL DEFAULT 0,   -- 累计已发放免费验证码次数
  status        INTEGER NOT NULL DEFAULT 0,
  remark        TEXT NOT NULL DEFAULT '',
  last_login_at INTEGER,
  created_at    INTEGER,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  outTradeNo   TEXT UNIQUE,
  userId       INTEGER,
  openid       TEXT,
  productId    TEXT,
  productName  TEXT,
  goodsPrice   INTEGER NOT NULL DEFAULT 0,
  buyQuantity  INTEGER NOT NULL DEFAULT 1,
  times        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',
  wxOrderId    TEXT,            -- 平台单号；允许多行同值（mock 同秒碰撞），查单取最新
  mock         INTEGER NOT NULL DEFAULT 0,
  note         TEXT,            -- 发货异常备注（原 order.note）
  -- 直购模型：一笔订单 = 一次具体服务（付完直接发结果，不产生余额）
  kind          TEXT NOT NULL DEFAULT '',   -- serial 取号 / socket 验证码 / '' 历史愿望单
  payload       TEXT NOT NULL DEFAULT '',   -- JSON：发号参数（category/version/链接）或 MAC 列表
  deliver_status TEXT NOT NULL DEFAULT '',  -- pending 待发 / issued 已发 / failed 发货失败
  deliver_result TEXT NOT NULL DEFAULT '',  -- 发号结果摘要（序列号 / 验证码 / 失败原因）
  createdAt    INTEGER,
  deliveredAt  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(userId, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_wx     ON orders(wxOrderId);

CREATE TABLE IF NOT EXISTS products (
  productId   TEXT PRIMARY KEY,
  name        TEXT,
  goodsPrice  INTEGER,
  buyQuantity INTEGER,
  times       INTEGER,
  sort        INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT,
  detail     TEXT,
  ip         TEXT,
  nickname   TEXT,
  openid     TEXT,
  device     TEXT DEFAULT '',
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- 后台可配置项（key-value）：如取号消耗 serial_wish_cost、单个验证码消耗 socket_cost
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 用户领取的序列号（一期：首绑手机号免费 1 个）
--   serial       与序列号后台的号一一对应，UNIQUE 兜住"并发拿到同一个号"
--   request_id   幂等键，连点/重试不会重复发号
--   status       issued 未激活 / activated 已激活 / void 已作废 / missing 后台查不到
--   activated_at 直接存序列号后台返回的北京时间字符串，避免时区换算出错
CREATE TABLE IF NOT EXISTS user_serials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  openid       TEXT    NOT NULL,
  serial       TEXT    NOT NULL UNIQUE,
  category     TEXT    NOT NULL DEFAULT '',
  version      TEXT    NOT NULL DEFAULT '',   -- 用户取号时选的版本（如 BarTender 2022 · R8 Full x64）
  download_url TEXT    NOT NULL DEFAULT '',   -- 该版本的下载地址（领取后只在「我的」里可见）
  key_url      TEXT    NOT NULL DEFAULT '',   -- 该版本的激活/注册地址
  hidden       INTEGER NOT NULL DEFAULT 0,    -- 1 = 用户在客户端删除了（只在客户端隐藏，后台不删）
  source       TEXT    NOT NULL DEFAULT 'free',
  cost         INTEGER NOT NULL DEFAULT 0,
  request_id   TEXT    UNIQUE,
  status       TEXT    NOT NULL DEFAULT 'issued',
  device_id    TEXT    NOT NULL DEFAULT '',
  activated_at TEXT    NOT NULL DEFAULT '',
  claimed_at   INTEGER,
  synced_at    INTEGER NOT NULL DEFAULT 0,
  remark       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_us_user ON user_serials(user_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_us_status ON user_serials(status);
-- 免费额度：同一用户只允许一条 source='free'（数据库兜底，防清缓存/并发绕过）
CREATE UNIQUE INDEX IF NOT EXISTS idx_us_free ON user_serials(user_id) WHERE source = 'free';

-- 智能插座验证码生成记录（和上表的「标签软件序列号」是两个不同功能）
--   kind   功能标识：socket = 智能插座验证码
--   mac    标准化后的 12 位大写 MAC
--   code   六位纯数字验证码（算法见 src/index.js 的 socketCodeOf）
CREATE TABLE IF NOT EXISTS user_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  openid     TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'socket',
  mac        TEXT    NOT NULL,
  code       TEXT    NOT NULL,
  cost       INTEGER NOT NULL DEFAULT 1,
  request_id TEXT,
  created_at INTEGER,
  hidden     INTEGER NOT NULL DEFAULT 0,   -- 1 = 用户在客户端删除了（只在客户端隐藏，后台不删）
  remark     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_uc_user ON user_codes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uc_mac  ON user_codes(mac);
CREATE INDEX IF NOT EXISTS idx_uc_req  ON user_codes(request_id);

-- 一次「生成」请求（批量）一行，request_id 唯一 → 连点/重试不会重复扣愿望
CREATE TABLE IF NOT EXISTS code_batches (
  request_id TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  cost       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);

-- 邀请记录：一个被邀请人只能绑一个邀请人（UNIQUE 兜住并发/重复提交）
--   wish 发放当时后台配置的邀请奖励（0 = 只是记录，不给愿望）
CREATE TABLE IF NOT EXISTS referrals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_id INTEGER NOT NULL,
  invitee_id INTEGER NOT NULL UNIQUE,
  wish       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ref_inviter ON referrals(inviter_id, created_at DESC);
`;

export class SQLiteDB {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');   // WAL：读写不互斥，单文件 + -wal/-shm 两个附属文件
    this.db.exec('PRAGMA busy_timeout = 5000;');  // 写锁竞争时最多等 5 秒
    this.db.exec(SCHEMA);
    this.migrate();
  }
  close() {
    try { this.db.close(); } catch {}
  }

  /**
   * 轻量迁移：老库（已上线跑过数据的）不会因为 CREATE TABLE IF NOT EXISTS 拿到新列，
   * 这里按需 ALTER TABLE 补上。只加列，不动数据，可重复执行。
   */
  migrate() {
    const addCol = (table, name, ddl) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(name)) {
        try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch { /* 并发启动时可能已被别人加过 */ }
      }
    };
    addCol('user_serials', 'version', "version TEXT NOT NULL DEFAULT ''");
    addCol('user_serials', 'download_url', "download_url TEXT NOT NULL DEFAULT ''");
    addCol('user_serials', 'key_url', "key_url TEXT NOT NULL DEFAULT ''");
    // 客户端删除（软删除）：只在用户自己那边隐藏，后台照样能看到
    addCol('user_serials', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
    addCol('user_codes', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
    // 邀请制：邀请人ID / 绑定时间 / 是否已发过「新用户注册赠送愿望」
    addCol('users', 'invited_by', 'invited_by INTEGER NOT NULL DEFAULT 0');
    addCol('users', 'invited_at', 'invited_at INTEGER NOT NULL DEFAULT 0');
    addCol('users', 'new_gift', 'new_gift INTEGER NOT NULL DEFAULT 0');
    // 审计日志：客户端设备串（平台|厂商|机型|系统|微信版本|基础库|屏幕）
    // 不加 NOT NULL：导入旧 CSV（没有 device 列）时会是 NULL，避免整表导入报错
    addCol('logs', 'device', "device TEXT DEFAULT ''");

    // 一次性改名：旧道具名「愿望N个」统一改成中性名，避免被判定为虚拟货币。
    // 只改还能匹配旧命名的行，所以可重复执行；后台自定义过的名字不会被覆盖。
    try {
      this.db.prepare("UPDATE products SET name = '高级功能1次' WHERE name LIKE '愿望%'").run();
    } catch { /* products 表还不存在时忽略 */ }
    // 直购模型（2026-08）：免费次数 + 累计实付；orders 区分服务类型与发货结果
    addCol('users', 'free_serial', 'free_serial INTEGER NOT NULL DEFAULT 0');
    addCol('users', 'free_socket', 'free_socket INTEGER NOT NULL DEFAULT 0');
    addCol('users', 'serial_earned', 'serial_earned INTEGER NOT NULL DEFAULT 0');
    addCol('users', 'socket_earned', 'socket_earned INTEGER NOT NULL DEFAULT 0');
    addCol('orders', 'kind', "kind TEXT NOT NULL DEFAULT ''");
    addCol('orders', 'payload', "payload TEXT NOT NULL DEFAULT ''");
    addCol('orders', 'deliver_status', "deliver_status TEXT NOT NULL DEFAULT ''");
    addCol('orders', 'deliver_result', "deliver_result TEXT NOT NULL DEFAULT ''");
  }

  // ─────────── settings（后台可配置项 key-value） ───────────

  getSetting(key, def = '') {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    return row ? String(row.value) : def;
  }

  setSetting(key, value) {
    this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(String(key), String(value), Math.floor(Date.now() / 1000));
  }

  // ─────────── users ───────────

  getUserByOpenid(openid) {
    return this.db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
  }
  getUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  }
  putUser(u) {
    // 按 openid 冲突时只更新业务字段，id 保持首次注册时分配的值不变
    this.db.prepare(`
      INSERT INTO users (id, openid, unionid, session_key, nickname, phone,
                         xpay_count, xpay_total, xpay_spent,
                         free_serial, free_socket, serial_earned, socket_earned,
                         status, remark,
                         last_login_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(openid) DO UPDATE SET
        unionid=excluded.unionid, session_key=excluded.session_key,
        nickname=excluded.nickname, phone=excluded.phone,
        xpay_count=excluded.xpay_count, xpay_total=excluded.xpay_total,
        xpay_spent=excluded.xpay_spent,
        free_serial=excluded.free_serial, free_socket=excluded.free_socket,
        serial_earned=excluded.serial_earned, socket_earned=excluded.socket_earned,
        status=excluded.status,
        remark=excluded.remark, last_login_at=excluded.last_login_at,
        updated_at=excluded.updated_at
    `).run(
      Number(u.id), u.openid, u.unionid ?? null, u.session_key ?? null,
      String(u.nickname ?? ''), String(u.phone ?? ''),
      Number(u.xpay_count ?? 0), Number(u.xpay_total ?? 0), Number(u.xpay_spent ?? 0),
      Number(u.free_serial ?? 0), Number(u.free_socket ?? 0),
      Number(u.serial_earned ?? 0), Number(u.socket_earned ?? 0),
      Number(u.status ?? 0), String(u.remark ?? ''),
      Number(u.last_login_at ?? 0), Number(u.created_at ?? 0), Number(u.updated_at ?? 0)
    );
  }
  /** 原子自增用户 ID（KV 版计数器非原子、并发可能重号，这里用 RETURNING 一步完成） */
  nextUserId() {
    const r = this.db.prepare(`
      INSERT INTO counters (name, value) VALUES ('user_id', 1)
      ON CONFLICT(name) DO UPDATE SET value = value + 1
      RETURNING value
    `).get();
    return Number(r.value);
  }

  /**
   * 找从 1 起最小未被占用的用户ID（删除用户后补空洞，而不是一直往后增长）。
   * 仅计算候选号，真正落库由调用方完成；并发撞号时调用方重算重试。
   */
  findFreeUserId() {
    const rows = this.db.prepare('SELECT id FROM users').all();
    const used = new Set(rows.map(r => Number(r.id)));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /**
   * 改用户ID（管理员在编辑里手动指定）。
   * 事务内改 users.id，并级联 orders.userId / user_serials.user_id / user_codes.user_id，
   * 保证订单、领号、插座记录不断链；logs 保留原值（审计留痕）。
   * @returns {boolean} false = 源不存在 / 新号非法 / 新号已被占用
   */
  renameUserId(oldId, newId) {
    oldId = Number(oldId); newId = Number(newId);
    if (!Number.isInteger(oldId) || !Number.isInteger(newId) || oldId <= 0 || newId <= 0 || oldId === newId) return false;
    if (!this.db.prepare('SELECT id FROM users WHERE id = ?').get(oldId)) return false;
    if (this.db.prepare('SELECT id FROM users WHERE id = ?').get(newId)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE users SET id = ? WHERE id = ?').run(newId, oldId);
      this.db.prepare('UPDATE orders SET userId = ? WHERE userId = ?').run(newId, oldId);
      this.db.prepare('UPDATE user_serials SET user_id = ? WHERE user_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE user_codes SET user_id = ? WHERE user_id = ?').run(newId, oldId);
      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }
  listAllUsers(limit) {
    return this.db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT ?').all(Number(limit) || 1000);
  }

  /** 今日新增（数据库按时间全表统计，不受列表扫描上限限制）：created_at >= 起始秒 */
  countUsersCreatedAfter(ts) {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM users WHERE created_at >= ?').get(Number(ts) || 0).c || 0);
  }

  /** 合计：总用户数 / 累计消费(分) / 当前剩余愿望，一条 SQL 聚合（全表，突破扫描上限） */
  getUserTotals() {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(xpay_spent),0) AS spent, COALESCE(SUM(xpay_count),0) AS count FROM users'
    ).get();
    return {
      total: Number(row.total || 0),
      spent: Number(row.spent || 0),
      count: Number(row.count || 0)
    };
  }

  /** 清空全部订单（后台「清空订单列表」），返回删除条数。事务执行。 */
  clearAllOrders() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare('DELETE FROM orders').run();
      this.db.exec('COMMIT');
      return Number(r.changes || 0);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** 清空全部审计日志（后台「清空审计日志」），返回删除条数。事务执行。 */
  clearAllLogs() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare('DELETE FROM logs').run();
      this.db.exec('COMMIT');
      return Number(r.changes || 0);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /**
   * 批量导入 / 修改用户（按用户ID匹配，只更新已存在用户，ID 不存在则跳过）。
   * @param {Array<{id:number|string, free_serial?:number|string, free_socket?:number|string,
   *                nickname?:string, phone?:string}>} rows
   *   免费次数提供即「设置为该值」（非负整数），留空不改；nickname/phone 留空不改。
   *   已经不再接受「愿望余额」字段（模型已下线）。
   * @returns {{updated:number, skipped:number, errors:string[]}}
   */
  importUsers(rows) {
    let updated = 0, skipped = 0;
    const errors = [];
    const now = Math.floor(Date.now() / 1000);
    const sel = this.db.prepare('SELECT * FROM users WHERE id = ?');
    const upd = this.db.prepare(
      'UPDATE users SET free_serial = ?, free_socket = ?, nickname = ?, phone = ?, updated_at = ? WHERE id = ?'
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows || []) {
        const id = Number(row.id);
        if (!Number.isInteger(id) || id <= 0) { errors.push(`非法用户ID：${row.id}`); skipped++; continue; }
        const cur = sel.get(id);
        if (!cur) { errors.push(`ID ${id} 不存在，已跳过`); skipped++; continue; }

        let freeSerial = Number(cur.free_serial || 0);
        let freeSocket = Number(cur.free_socket || 0);
        let nick = cur.nickname || '';
        let phone = cur.phone || '';

        /** 解析非负整数：空 → null（不改）；非法 → undefined（跳过整行） */
        const readNum = (raw, label) => {
          if (raw === undefined || raw === null || String(raw).trim() === '') return null;
          const n = Math.floor(Number(raw));
          if (!Number.isInteger(n) || n < 0) {
            errors.push(`ID ${id} ${label}「${raw}」非法，已跳过该行`);
            return undefined;
          }
          return n;
        };
        const fs = readNum(row.free_serial, '免费取号次数');
        if (fs === undefined) { skipped++; continue; }
        if (fs !== null) freeSerial = fs;

        const fk = readNum(row.free_socket, '免费验证码次数');
        if (fk === undefined) { skipped++; continue; }
        if (fk !== null) freeSocket = fk;

        if (row.nickname !== undefined && String(row.nickname).trim() !== '') nick = String(row.nickname).slice(0, 100);
        if (row.phone !== undefined && String(row.phone).trim() !== '') phone = String(row.phone).slice(0, 30);
        upd.run(freeSerial, freeSocket, nick, phone, now, id);
        updated++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { updated, skipped, errors };
  }

  /**
   * 整表恢复导入（先清空该表，再按 CSV 原样写回，保留原 id / 时间）。
   * @param {string} key IMPORT_TABLES 的标识：logs/orders/serials/codes/referrals
   * @param {Array<object>} rows 已按列名映射好的行对象
   * @returns {{ok:boolean,table?:string,inserted:number,error?:string}}
   */
  replaceTable(key, rows) {
    const map = IMPORT_TABLES[key];
    if (!map) return { ok: false, error: 'unknown_table', inserted: 0 };
    const cols = map.columns;
    const ph = cols.map(() => '?').join(',');
    const ins = this.db.prepare(`INSERT INTO ${map.table} (${cols.join(',')}) VALUES (${ph})`);
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM ${map.table}`).run();
      try { this.db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(map.table); } catch {}
      for (const row of rows || []) {
        const vals = cols.map(c => (row[c] === undefined || row[c] === null || row[c] === '') ? null : row[c]);
        ins.run(...vals);
        inserted++;
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { ok: true, table: map.table, inserted };
  }

  /**
   * 全表导出（白名单），返回 { columns, rows }；不在白名单内的表返回 null。
   */
  dumpTable(name) {
    const sql = EXPORT_TABLES[name];
    if (!sql) return null;
    const stmt = this.db.prepare(sql);
    let columns = [];
    try { columns = (stmt.columns() || []).map(c => c.name); } catch { columns = []; }
    const rows = stmt.all();
    if (!columns.length && rows.length) columns = Object.keys(rows[0]);
    return { columns, rows };
  }


  /**
   * 批量硬删除用户（管理员后台「批量删除」）。
   * 事务内清理 users 及其领取记录：user_serials / user_codes / code_batches；
   * orders（支付与对账凭证）与 logs（审计留痕）保留，不因删用户而丢失。
   * @param {number[]} ids 用户ID数组（内部去重、过滤非正整数）
   * @returns {{deleted:number, removed:Array<{id:number,openid:string,nickname:string,phone:string,xpay_count:number}>}}
   */
  deleteUsers(ids) {
    const idList = [...new Set((ids || [])
      .map(x => Number(x))
      .filter(n => Number.isInteger(n) && n > 0))];
    if (!idList.length) return { deleted: 0, removed: [] };

    const placeholders = idList.map(() => '?').join(',');
    // 先取快照（审计日志 / 回显用），再在同一事务里删除
    const removed = this.db.prepare(
      `SELECT id, openid, nickname, phone, xpay_count FROM users WHERE id IN (${placeholders})`
    ).all(...idList);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM user_serials WHERE user_id IN (${placeholders})`).run(...idList);
      this.db.prepare(`DELETE FROM user_codes WHERE user_id IN (${placeholders})`).run(...idList);
      this.db.prepare(`DELETE FROM code_batches WHERE user_id IN (${placeholders})`).run(...idList);
      const r = this.db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...idList);
      this.db.exec('COMMIT');
      return { deleted: Number(r.changes) || 0, removed };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
  }

  // ─────────── orders ───────────

  getOrder(id) {
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  }
  getOrderByOutTradeNo(no) {
    return this.db.prepare('SELECT * FROM orders WHERE outTradeNo = ?').get(no);
  }
  getOrderByWxOrderId(wx) {
    // wxOrderId 不设 UNIQUE（mock 同秒碰撞场景），取最新一条，幂等语义与原 KV key 覆盖一致
    return this.db.prepare('SELECT * FROM orders WHERE wxOrderId = ? ORDER BY createdAt DESC LIMIT 1').get(wx);
  }
  putOrder(o) {
    this.db.prepare(`
      INSERT INTO orders (id, outTradeNo, userId, openid, productId, productName,
                          goodsPrice, buyQuantity, times, status, wxOrderId,
                          mock, note, kind, payload, deliver_status, deliver_result,
                          createdAt, deliveredAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        outTradeNo=excluded.outTradeNo, userId=excluded.userId,
        openid=excluded.openid, productId=excluded.productId,
        productName=excluded.productName, goodsPrice=excluded.goodsPrice,
        buyQuantity=excluded.buyQuantity, times=excluded.times,
        status=excluded.status, wxOrderId=excluded.wxOrderId,
        mock=excluded.mock, note=excluded.note,
        kind=excluded.kind, payload=excluded.payload,
        deliver_status=excluded.deliver_status, deliver_result=excluded.deliver_result,
        createdAt=excluded.createdAt, deliveredAt=excluded.deliveredAt
    `).run(
      o.id, o.outTradeNo ?? null, Number(o.userId ?? 0), o.openid ?? null,
      o.productId ?? null, o.productName ?? null,
      Number(o.goodsPrice ?? 0), Number(o.buyQuantity ?? 1), Number(o.times ?? 0),
      o.status ?? 'pending', o.wxOrderId || null,     // 空串转 NULL，避免 UNIQUE/查询歧义
      o.mock ? 1 : 0, o.note ?? null,
      String(o.kind ?? ''), String(o.payload ?? ''),
      String(o.deliver_status ?? ''), String(o.deliver_result ?? ''),
      Number(o.createdAt ?? 0), Number(o.deliveredAt ?? 0)
    );
  }
  listOrders(limit) {
    return this.db.prepare('SELECT * FROM orders ORDER BY createdAt DESC LIMIT ?').all(Number(limit) || 500);
  }

  // ─────────── products ───────────

  getProducts() {
    return this.db.prepare('SELECT * FROM products ORDER BY sort ASC').all();
  }
  saveProducts(list) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM products').run();
      const ins = this.db.prepare(
        'INSERT INTO products (productId, name, goodsPrice, buyQuantity, times, sort) VALUES (?,?,?,?,?,?)'
      );
      for (const p of list) {
        ins.run(p.productId, String(p.name ?? ''), Number(p.goodsPrice ?? 0),
                Number(p.buyQuantity ?? 1), Number(p.times ?? 1), Number(p.sort ?? 0));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ─────────── logs ───────────

  addLog({ userId, action, detail, ip, nickname, openid, device }) {
    // device 不传就取当前请求的设备串（见 meta.mjs），调用点无需关心
    const dev = String(device == null ? currentDevice() : device);
    this.db.prepare(`
      INSERT INTO logs (user_id, action, detail, ip, nickname, openid, device, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      Number(userId ?? 0), String(action ?? ''), String(detail ?? ''),
      String(ip ?? ''), String(nickname ?? ''), String(openid ?? ''),
      dev.slice(0, 200),
      Math.floor(Date.now() / 1000)
    );
  }
  /**
   * 审计日志分页
   * @param {number} limit
   * @param {number} offset
   * @param {'ios'|'android'|'other'|''} platform 按设备平台筛选（对应 device 列的前缀）
   */
  listLogs(limit, offset, platform) {
    const where = [];
    const args = [];
    if (platform === 'ios')    { where.push("device LIKE 'ios|%'");     }
    else if (platform === 'android') { where.push("device LIKE 'android|%'"); }
    else if (platform === 'other')   { where.push("device <> '' AND device NOT LIKE 'ios|%' AND device NOT LIKE 'android|%'"); }
    const sql = 'SELECT * FROM logs'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
    args.push(Number(limit) || 20, Number(offset) || 0);
    return this.db.prepare(sql).all(...args);
  }

  // ─────────── user_serials（用户领取的序列号） ───────────

  getUserSerialByRequestId(requestId) {
    if (!requestId) return undefined;
    return this.db.prepare('SELECT * FROM user_serials WHERE request_id = ?').get(String(requestId));
  }
  getUserSerial(serial) {
    return this.db.prepare('SELECT * FROM user_serials WHERE serial = ?').get(String(serial));
  }
  /** 该用户是否已经用过免费额度 */
  hasFreeSerial(userId) {
    return !!this.db.prepare(
      "SELECT 1 FROM user_serials WHERE user_id = ? AND source = 'free' LIMIT 1"
    ).get(Number(userId));
  }
  /**
   * 新增一条领取记录。
   * 唯一约束冲突会抛错，调用方据此区分：
   *   serial 冲突 → 号被别人同时领走（换一个号重试）
   *   免费索引冲突 → 免费额度已用
   */
  addUserSerial(row) {
    this.db.prepare(`
      INSERT INTO user_serials (user_id, openid, serial, category, version, download_url, key_url,
                                source, cost, request_id,
                                status, device_id, activated_at, claimed_at, synced_at, remark)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      Number(row.user_id), String(row.openid || ''), String(row.serial), String(row.category || ''),
      String(row.version || ''), String(row.download_url || ''), String(row.key_url || ''),
      String(row.source || 'free'), Number(row.cost || 0),
      row.request_id == null ? null : String(row.request_id),
      String(row.status || 'issued'), String(row.device_id || ''), String(row.activated_at || ''),
      Number(row.claimed_at || 0), Number(row.synced_at || 0), String(row.remark || '')
    );
  }
  /** 用户自己的序列号列表（hidden=1 表示用户在客户端删掉了，不再返回） */
  listUserSerials(userId, limit, offset) {
    return this.db.prepare(
      'SELECT * FROM user_serials WHERE user_id = ? AND hidden = 0 '
      + 'ORDER BY claimed_at DESC, id DESC LIMIT ? OFFSET ?'
    ).all(Number(userId), Number(limit) || 100, Number(offset) || 0);
  }
  /** 该用户一共领了多少个（分页用，不含客户端已删除的） */
  countUserSerials(userId) {
    return Number(this.db.prepare(
      'SELECT COUNT(*) AS c FROM user_serials WHERE user_id = ? AND hidden = 0'
    ).get(Number(userId)).c || 0);
  }
  /** 客户端删除：只把这一条标记成 hidden，后台记录保留 */
  hideUserSerial(serial, userId) {
    return this.db.prepare(
      'UPDATE user_serials SET hidden = 1 WHERE serial = ? AND user_id = ? AND hidden = 0'
    ).run(String(serial), Number(userId)).changes;
  }
  /** 客户端删除：插座验证码 */
  hideUserCode(id, userId) {
    return this.db.prepare(
      'UPDATE user_codes SET hidden = 1 WHERE id = ? AND user_id = ? AND hidden = 0'
    ).run(Number(id), Number(userId)).changes;
  }
  /** 用序列号后台返回的状态回写本地 */
  updateUserSerialSync(serial, patch) {
    return this.db.prepare(`
      UPDATE user_serials SET status = ?, device_id = ?, activated_at = ?, synced_at = ?
      WHERE serial = ?
    `).run(
      String(patch.status || 'issued'), String(patch.device_id || ''),
      String(patch.activated_at || ''), Number(patch.synced_at || Math.floor(Date.now() / 1000)),
      String(serial)
    ).changes;
  }

  /**
   * 取号落库 + 扣免费次数，同一个事务里做完，任何一步失败全部撤销。
   *   credit = 1：先扣 users.free_serial，没有免费次数直接返回 need_credit（不发号、不扣）
   *   返回值 error：
   *     need_credit     没有免费取号次数（调用方应转成付费下单）
   *     serial_taken    这个号已经被别人领走（不是我们的号，别动它）
   *     free_taken      免费额度被别人并发抢了（这条调用方应改成付费重试）
   *     duplicate_request  同一个 request_id 已经发过（幂等）
   *     db_error        其它数据库错误
   */
  claimSerialTx({ userId, credit = 0, cost = 0, row }) {
    const ts = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 只认「免费次数」；cost 仅用于记录这一单实付金额（不再扣任何余额）
      void cost;
      if (Number(credit) > 0) {
        const r = this.db.prepare(
          'UPDATE users SET free_serial = free_serial - 1, updated_at = ? WHERE id = ? AND free_serial > 0'
        ).run(ts, Number(userId));
        if (Number(r.changes) !== 1) {
          this.db.exec('ROLLBACK');
          return { ok: false, error: 'need_credit' };
        }
      }
      this.addUserSerial(row);
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      const msg = String((e && e.message) || e);
      if (/user_serials\.serial/i.test(msg)) return { ok: false, error: 'serial_taken' };
      if (/user_serials\.user_id/i.test(msg)) return { ok: false, error: 'free_taken' };
      if (/user_serials\.request_id/i.test(msg)) return { ok: false, error: 'duplicate_request' };
      return { ok: false, error: 'db_error', message: msg };
    }
  }
  /** 后台：删除一条发放记录（删掉 source='free' 后，该用户就能重新领免费额度） */
  deleteUserSerial(serial) {
    return this.db.prepare('DELETE FROM user_serials WHERE serial = ?').run(String(serial)).changes;
  }

  // ─────────── 邀请制（referrals / users.invited_by） ───────────

  /** 这个用户是被谁邀请的（没绑过返回 undefined） */
  getReferralByInvitee(inviteeId) {
    return this.db.prepare('SELECT * FROM referrals WHERE invitee_id = ?').get(Number(inviteeId));
  }

  /** 我邀请了几个人 */
  countInvited(inviterId) {
    return Number(this.db.prepare(
      'SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ?'
    ).get(Number(inviterId)).c || 0);
  }

  /** 我靠邀请一共拿到多少份额（旧字段，保留兼容；新逻辑看 free_serial / free_socket） */
  sumInviteWish(inviterId) {
    return Number(this.db.prepare(
      'SELECT COALESCE(SUM(wish), 0) AS s FROM referrals WHERE inviter_id = ?'
    ).get(Number(inviterId)).s || 0);
  }

  /**
   * 发放免费次数（邀请奖励）：把用户剩余次数加上 add，并把「累计已发放」同步为 earned。
   * 用 earned 做幂等依据：应发 = floor(邀请人数 / 门槛)，只补发差额，重复调用不会多发。
   * @param {'serial'|'socket'} kind
   */
  grantFreeCreditsTx({ userId, kind, add = 0, earned = 0 }) {
    const isSocket = kind === 'socket';
    const col = isSocket ? 'free_socket' : 'free_serial';
    const ecol = isSocket ? 'socket_earned' : 'serial_earned';
    const n = Math.max(0, Math.floor(Number(add) || 0));
    const e = Math.max(0, Math.floor(Number(earned) || 0));
    const ts = Math.floor(Date.now() / 1000);
    this.db.prepare(
      `UPDATE users SET ${col} = ${col} + ?, ${ecol} = ?, updated_at = ? WHERE id = ?`
    ).run(n, e, ts, Number(userId));
    return { ok: true, add: n, earned: e };
  }

  /**
   * 新用户注册赠送愿望：只发一次（new_gift 标记兜底，重启/并发都不会重复发）
   * @returns {{ok:boolean, granted:boolean, wish:number}}
   */
  grantNewUserGiftTx({ userId, wish }) {
    const w = Math.max(0, Math.floor(Number(wish) || 0));
    const ts = Math.floor(Date.now() / 1000);
    if (w === 0) {
      // 配置为 0：只打标记，不加愿望
      this.db.prepare('UPDATE users SET new_gift = 1, updated_at = ? WHERE id = ? AND new_gift = 0')
        .run(ts, Number(userId));
      return { ok: true, granted: false, wish: 0 };
    }
    const r = this.db.prepare(
      'UPDATE users SET xpay_count = xpay_count + ?, new_gift = 1, updated_at = ? WHERE id = ? AND new_gift = 0'
    ).run(w, ts, Number(userId));
    return { ok: true, granted: Number(r.changes) === 1, wish: Number(r.changes) === 1 ? w : 0 };
  }

  /**
   * 绑定邀请关系 + 给邀请人发愿望（一个事务）
   * 失败原因：self / already_bound / inviter_not_found / invitee_missing / window_expired(调用方判)
   */
  bindReferralTx({ inviterId, inviteeId, wish }) {
    const inviter = Number(inviterId);
    const invitee = Number(inviteeId);
    const w = Math.max(0, Math.floor(Number(wish) || 0));
    const ts = Math.floor(Date.now() / 1000);

    if (!inviter || !invitee) return { ok: false, error: 'bad_id' };
    if (inviter === invitee) return { ok: false, error: 'self' };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const me = this.db.prepare('SELECT id, invited_by FROM users WHERE id = ?').get(invitee);
      if (!me) { this.db.exec('ROLLBACK'); return { ok: false, error: 'invitee_missing' }; }
      if (Number(me.invited_by) > 0) { this.db.exec('ROLLBACK'); return { ok: false, error: 'already_bound' }; }

      const other = this.db.prepare('SELECT id FROM users WHERE id = ?').get(inviter);
      if (!other) { this.db.exec('ROLLBACK'); return { ok: false, error: 'inviter_not_found' }; }

      this.db.prepare(
        'INSERT INTO referrals (inviter_id, invitee_id, wish, created_at) VALUES (?, ?, ?, ?)'
      ).run(inviter, invitee, w, ts);

      const r = this.db.prepare(
        'UPDATE users SET invited_by = ?, invited_at = ?, updated_at = ? WHERE id = ? AND invited_by = 0'
      ).run(inviter, ts, ts, invitee);
      if (Number(r.changes) !== 1) { this.db.exec('ROLLBACK'); return { ok: false, error: 'already_bound' }; }

      // 直购模型：这里只落绑定关系，不再动任何余额。
      // 免费次数由调用方按「邀请门槛」算好，再调 grantFreeCreditsTx 发放（幂等）。
      void w;

      this.db.exec('COMMIT');
      return { ok: true, wish: w, at: ts };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      const msg = String((e && e.message) || e);
      if (/referrals\.invitee_id/i.test(msg)) return { ok: false, error: 'already_bound' };
      return { ok: false, error: 'db_error', message: msg };
    }
  }

  /** 后台：邀请记录（带昵称/手机号，便于查异常） */  listReferrals({ limit = 100, offset = 0 } = {}) {
    return this.db.prepare(`
      SELECT r.*, i.nickname AS inviter_nick, i.phone AS inviter_phone,
             e.nickname AS invitee_nick, e.phone AS invitee_phone
        FROM referrals r
        LEFT JOIN users i ON i.id = r.inviter_id
        LEFT JOIN users e ON e.id = r.invitee_id
       ORDER BY r.id DESC LIMIT ? OFFSET ?
    `).all(Number(limit) || 100, Number(offset) || 0);
  }

  countReferrals() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM referrals').get().c || 0);
  }

  /**
   * 后台：取消一条邀请绑定（解绑）
   *   · 删掉 referrals 记录 + 把被邀请人的 invited_by 清 0（他之后可以重新填邀请人）
   *   · reclaim=true 时向邀请人收回当初发的愿望；余额不够就按现有余额收回（不扣成负数）
   * @returns {{ok:boolean, error?:string, inviter_id?:number, wish?:number, reclaimed?:number}}
   */
  cancelReferralTx({ inviteeId, reclaim = false }) {
    const id = Number(inviteeId);
    const ts = Math.floor(Date.now() / 1000);
    if (!id) return { ok: false, error: 'bad_id' };

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ref = this.db.prepare('SELECT * FROM referrals WHERE invitee_id = ?').get(id);
      if (!ref) {
        this.db.exec('ROLLBACK');
        return { ok: false, error: 'not_bound' };
      }

      this.db.prepare('DELETE FROM referrals WHERE invitee_id = ?').run(id);
      this.db.prepare(
        'UPDATE users SET invited_by = 0, invited_at = 0, updated_at = ? WHERE id = ?'
      ).run(ts, id);

      let reclaimed = 0;
      const wish = Number(ref.wish || 0);
      if (reclaim && wish > 0) {
        const row = this.db.prepare('SELECT xpay_count FROM users WHERE id = ?').get(Number(ref.inviter_id));
        const bal = Number((row && row.xpay_count) || 0);
        reclaimed = Math.max(0, Math.min(bal, wish));
        if (reclaimed > 0) {
          this.db.prepare('UPDATE users SET xpay_count = xpay_count - ?, updated_at = ? WHERE id = ?')
            .run(reclaimed, ts, Number(ref.inviter_id));
        }
      }

      this.db.exec('COMMIT');
      return { ok: true, inviter_id: Number(ref.inviter_id), wish, reclaimed };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      return { ok: false, error: 'db_error', message: String((e && e.message) || e) };
    }
  }

  /** 后台：每个用户邀请了多少人（user_id → 数量） */
  countInvitesByUser() {
    const rows = this.db.prepare(
      'SELECT inviter_id, COUNT(*) AS c FROM referrals GROUP BY inviter_id'
    ).all();
    const map = {};
    for (const r of rows) map[Number(r.inviter_id)] = Number(r.c);
    return map;
  }
  /** 后台：每个用户领了多少个（user_id → 数量） */
  countSerialsByUser() {
    const rows = this.db.prepare(
      'SELECT user_id, COUNT(*) AS c FROM user_serials GROUP BY user_id'
    ).all();
    const map = {};
    for (const r of rows) map[Number(r.user_id)] = Number(r.c);
    return map;
  }
  /** 后台：序列号列表（按序列号 / 分类 / 版本 / 手机号 / 用户ID 过滤） */
  listAllSerials({ search = '', limit = 200, offset = 0 } = {}) {
    const q = String(search || '').trim();
    const base = 'SELECT s.*, u.nickname AS nickname, u.phone AS phone FROM user_serials s '
      + 'LEFT JOIN users u ON u.id = s.user_id ';
    if (!q) {
      return this.db.prepare(base + 'ORDER BY s.id DESC LIMIT ? OFFSET ?')
        .all(Number(limit) || 200, Number(offset) || 0);
    }
    const like = '%' + q + '%';
    return this.db.prepare(
      base + 'WHERE s.serial LIKE ? OR s.category LIKE ? OR s.version LIKE ? OR u.phone LIKE ? OR CAST(s.user_id AS TEXT) = ? '
      + 'ORDER BY s.id DESC LIMIT ? OFFSET ?'
    ).all(like, like, like, like, q, Number(limit) || 200, Number(offset) || 0);
  }
  countAllSerials() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM user_serials').get().c || 0);
  }

  // ─────────── 智能插座验证码（user_codes / code_batches） ───────────

  /**
   * 生成验证码的记录 + 扣免费次数，一个事务做完：
   *   request_id 已存在   → duplicate_request（调用方返回上次结果，不重复扣）
   *   没有免费次数        → need_credit（不落库、不扣）
   *   rows 里的 mac/code 由调用方算好传入
   */
  createCodeBatchTx({ userId, requestId, credit = 0, cost = 0, rows = [] }) {
    const ts = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        'INSERT INTO code_batches (request_id, user_id, count, cost, created_at) VALUES (?,?,?,?,?)'
      ).run(String(requestId), Number(userId), rows.length, Number(cost), ts);

      // 只认「免费次数」；cost 仅记录本单实付金额（不再扣任何余额）
      if (Number(credit) > 0) {
        const r = this.db.prepare(
          'UPDATE users SET free_socket = free_socket - 1, updated_at = ? WHERE id = ? AND free_socket > 0'
        ).run(ts, Number(userId));
        if (Number(r.changes) !== 1) {
          this.db.exec('ROLLBACK');
          return { ok: false, error: 'need_credit' };
        }
      }

      const ins = this.db.prepare(`
        INSERT INTO user_codes (user_id, openid, kind, mac, code, cost, request_id, created_at, remark)
        VALUES (?,?,?,?,?,?,?,?,?)
      `);
      for (const row of rows) {
        ins.run(
          Number(userId), String(row.openid || ''), String(row.kind || 'socket'),
          String(row.mac), String(row.code), Number(cost) > 0 ? 1 : 0,
          String(requestId), ts, String(row.remark || '')
        );
      }
      this.db.exec('COMMIT');
      return { ok: true, created_at: ts };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      const msg = String((e && e.message) || e);
      if (/code_batches\.request_id/i.test(msg) || /PRIMARY KEY/i.test(msg)) {
        return { ok: false, error: 'duplicate_request' };
      }
      return { ok: false, error: 'db_error', message: msg };
    }
  }

  /** 某个 request_id 生成的验证码（幂等重放用） */
  listCodesByRequest(requestId) {
    return this.db.prepare(
      'SELECT * FROM user_codes WHERE request_id = ? ORDER BY id ASC'
    ).all(String(requestId));
  }
  getCodeBatch(requestId) {
    return this.db.prepare('SELECT * FROM code_batches WHERE request_id = ?').get(String(requestId));
  }
  /** 用户自己的验证码列表（hidden=1 表示用户在客户端删掉了，不再返回） */
  listUserCodes(userId, limit, offset) {
    return this.db.prepare(
      'SELECT * FROM user_codes WHERE user_id = ? AND hidden = 0 ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(Number(userId), Number(limit) || 20, Number(offset) || 0);
  }
  countUserCodes(userId) {
    return Number(this.db.prepare(
      'SELECT COUNT(*) AS c FROM user_codes WHERE user_id = ? AND hidden = 0'
    ).get(Number(userId)).c || 0);
  }
  /** 后台：每个用户生成了多少个验证码（user_id → 数量） */
  countCodesByUser() {
    const rows = this.db.prepare(
      'SELECT user_id, COUNT(*) AS c FROM user_codes GROUP BY user_id'
    ).all();
    const map = {};
    for (const r of rows) map[Number(r.user_id)] = Number(r.c);
    return map;
  }
  /** 后台：验证码记录（按 验证码 / MAC / 手机号 / 用户ID 过滤） */
  listAllCodes({ search = '', limit = 200, offset = 0 } = {}) {
    const q = String(search || '').trim();
    const base = 'SELECT c.*, u.nickname AS nickname, u.phone AS phone FROM user_codes c '
      + 'LEFT JOIN users u ON u.id = c.user_id ';
    if (!q) {
      return this.db.prepare(base + 'ORDER BY c.id DESC LIMIT ? OFFSET ?')
        .all(Number(limit) || 200, Number(offset) || 0);
    }
    const like = '%' + q + '%';
    const cleaned = q.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    return this.db.prepare(
      base + 'WHERE c.code LIKE ? OR c.mac LIKE ? OR u.phone LIKE ? OR CAST(c.user_id AS TEXT) = ? '
      + 'ORDER BY c.id DESC LIMIT ? OFFSET ?'
    ).all(like, cleaned ? '%' + cleaned + '%' : like, like, q, Number(limit) || 200, Number(offset) || 0);
  }
  countAllCodes() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM user_codes').get().c || 0);
  }
  /**
   * 有效用户（去重并集）：购买过(已发货订单) / 取过号(user_serials) / 生成过验证码(user_codes)。
   * 不再以"当前剩余愿望>0"判定，避免用完余额就被算作无效。
   */
  countActiveUsers() {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT uid) AS c FROM (
        SELECT userId AS uid FROM orders WHERE status = 'delivered'
        UNION
        SELECT user_id AS uid FROM user_serials
        UNION
        SELECT user_id AS uid FROM user_codes
      )
    `).get();
    return Number(row.c || 0);
  }
  /** 后台：删掉一条验证码记录（不改愿望余额） */
  deleteUserCode(id) {
    return this.db.prepare('DELETE FROM user_codes WHERE id = ?').run(Number(id)).changes;
  }
  getCodeById(id) {
    return this.db.prepare('SELECT * FROM user_codes WHERE id = ?').get(Number(id));
  }
  countCodesByRequest(requestId) {
    return Number(this.db.prepare(
      'SELECT COUNT(*) AS c FROM user_codes WHERE request_id = ?'
    ).get(String(requestId)).c || 0);
  }
  /** 一次生成请求的记录都删光后，把批次行也清掉（幂等表不留孤儿） */
  deleteCodeBatch(requestId) {
    return this.db.prepare('DELETE FROM code_batches WHERE request_id = ?').run(String(requestId)).changes;
  }

  /** 清理 N 天前的订单（原 KV 对订单设 180 天 TTL，SQLite 需要手动清理，返回删除条数） */
  purgeOldOrders(days) {
    const cutoff = Math.floor(Date.now() / 1000) - (Number(days) || 180) * 86400;
    return this.db.prepare('DELETE FROM orders WHERE createdAt < ?').run(cutoff).changes;
  }
}

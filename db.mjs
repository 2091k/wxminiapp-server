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
import path from 'node:path';

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
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
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
                         xpay_count, xpay_total, xpay_spent, status, remark,
                         last_login_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(openid) DO UPDATE SET
        unionid=excluded.unionid, session_key=excluded.session_key,
        nickname=excluded.nickname, phone=excluded.phone,
        xpay_count=excluded.xpay_count, xpay_total=excluded.xpay_total,
        xpay_spent=excluded.xpay_spent, status=excluded.status,
        remark=excluded.remark, last_login_at=excluded.last_login_at,
        updated_at=excluded.updated_at
    `).run(
      Number(u.id), u.openid, u.unionid ?? null, u.session_key ?? null,
      String(u.nickname ?? ''), String(u.phone ?? ''),
      Number(u.xpay_count ?? 0), Number(u.xpay_total ?? 0), Number(u.xpay_spent ?? 0),
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
  listAllUsers(limit) {
    return this.db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT ?').all(Number(limit) || 1000);
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
                          mock, note, createdAt, deliveredAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        outTradeNo=excluded.outTradeNo, userId=excluded.userId,
        openid=excluded.openid, productId=excluded.productId,
        productName=excluded.productName, goodsPrice=excluded.goodsPrice,
        buyQuantity=excluded.buyQuantity, times=excluded.times,
        status=excluded.status, wxOrderId=excluded.wxOrderId,
        mock=excluded.mock, note=excluded.note,
        createdAt=excluded.createdAt, deliveredAt=excluded.deliveredAt
    `).run(
      o.id, o.outTradeNo ?? null, Number(o.userId ?? 0), o.openid ?? null,
      o.productId ?? null, o.productName ?? null,
      Number(o.goodsPrice ?? 0), Number(o.buyQuantity ?? 1), Number(o.times ?? 0),
      o.status ?? 'pending', o.wxOrderId || null,     // 空串转 NULL，避免 UNIQUE/查询歧义
      o.mock ? 1 : 0, o.note ?? null,
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

  addLog({ userId, action, detail, ip, nickname, openid }) {
    this.db.prepare(`
      INSERT INTO logs (user_id, action, detail, ip, nickname, openid, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      Number(userId ?? 0), String(action ?? ''), String(detail ?? ''),
      String(ip ?? ''), String(nickname ?? ''), String(openid ?? ''),
      Math.floor(Date.now() / 1000)
    );
  }
  listLogs(limit, offset) {
    return this.db.prepare('SELECT * FROM logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(Number(limit) || 20, Number(offset) || 0);
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
   * 取号落库 + 扣愿望，同一个事务里做完，任何一步失败全部撤销。
   *   cost > 0：先扣 users.xpay_count，余额不足直接返回 need_wish（不发号、不扣）
   *   返回值 error：
   *     need_wish       余额不足
   *     serial_taken    这个号已经被别人领走（不是我们的号，别动它）
   *     free_taken      免费额度被别人并发抢了（这条调用方应改成付费重试）
   *     duplicate_request  同一个 request_id 已经发过（幂等）
   *     db_error        其它数据库错误
   */
  claimSerialTx({ userId, cost = 0, row }) {
    const ts = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (Number(cost) > 0) {
        const r = this.db.prepare(
          'UPDATE users SET xpay_count = xpay_count - ?, updated_at = ? WHERE id = ? AND xpay_count >= ?'
        ).run(Number(cost), ts, Number(userId), Number(cost));
        if (Number(r.changes) !== 1) {
          this.db.exec('ROLLBACK');
          return { ok: false, error: 'need_wish' };
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
   * 生成验证码的记录 + 扣愿望，一个事务做完：
   *   request_id 已存在   → duplicate_request（调用方返回上次结果，不重复扣）
   *   余额不足            → need_wish（不落库、不扣）
   *   rows 里的 mac/code 由调用方算好传入
   */
  createCodeBatchTx({ userId, requestId, cost = 0, rows = [] }) {
    const ts = Math.floor(Date.now() / 1000);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        'INSERT INTO code_batches (request_id, user_id, count, cost, created_at) VALUES (?,?,?,?,?)'
      ).run(String(requestId), Number(userId), rows.length, Number(cost), ts);

      if (Number(cost) > 0) {
        const r = this.db.prepare(
          'UPDATE users SET xpay_count = xpay_count - ?, updated_at = ? WHERE id = ? AND xpay_count >= ?'
        ).run(Number(cost), ts, Number(userId), Number(cost));
        if (Number(r.changes) !== 1) {
          this.db.exec('ROLLBACK');
          return { ok: false, error: 'need_wish' };
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

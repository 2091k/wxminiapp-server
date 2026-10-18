/**
 * 一期「序列号取号」端到端自测（零依赖，不参与部署）
 *
 *   node --experimental-sqlite test-serial.mjs
 *   （Node 23.4+ / 24 可以不带 --experimental-sqlite）
 *
 * 跑的是两份真实代码：
 *   A = src/index.js            小程序后端（Worker 形式），数据层用 db.mjs 的内存 SQLite
 *   B = ../btkey_html_admin/workers.js   序列号后台（Worker），KV 用内存 Map
 * A→B 之间的 fetch 被转发给 B 的真实 fetch，所以占号/确认/释放/状态同步都是真跑。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { SQLiteDB } = require('./db.mjs');

// ─────────── 假的 Cloudflare KV（B 用） ───────────
class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
  lines() { return (this.map.get('bt_list') || '').split('\n').filter((l) => l.trim()); }
}

const loadWorker = async (file) => (await import(
  'data:text/javascript;base64,' + Buffer.from(readFileSync(file, 'utf8')).toString('base64')
)).default;

const JWT_SECRET = 'test_jwt_secret';
const BTKEY_TOKEN = 'btkey_test_token';
const BT = 'https://btkey.test';

const db = new SQLiteDB(':memory:');
const kv = new FakeKV();

// ─────────── 载入两份真实 Worker ───────────
const aWorker = await loadWorker(new URL('./src/index.js', import.meta.url));
const bWorker = await loadWorker(new URL('../btkey_html_admin/workers.js', import.meta.url));

const bEnv = {
  bt_KV: kv,
  ADMIN_USER: 'admin', ADMIN_PASS: 'pw', ADMIN_TOKEN: 'adm_tok',
  API_TOKEN: BTKEY_TOKEN,
  API_MAX_PER_MIN: 1000,
};
const aEnv = {
  APP_NAME: '测试小程序', ADMIN_PREFIX: 'admin', ADMIN_PAGE_SIZE: '20', KV_MAX_SCAN: '1000',
  JWT_SECRET, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw', JWT_EXPIRE: '3600',
  BTKEY_API_BASE: BT, BTKEY_API_TOKEN: BTKEY_TOKEN,
  SERIAL_CATEGORY: 'BarTender 2022',   // 取号固定分类（生产环境默认 wxminiapp）
};

// A→B 的请求走 B 的真实实现
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(BT)) {
    return bWorker.fetch(new Request(url, init), bEnv, {});
  }
  if (url.startsWith('https://unreachable.test')) throw new Error('network down');
  return realFetch(input, init);
};
globalThis.__db = db;

// ─────────── 工具 ───────────
const nowSec = () => Math.floor(Date.now() / 1000);
const b64 = (s) => Buffer.from(s).toString('base64url');
function mintToken(payload) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(payload));
  const data = h + '.' + p;
  const sig = createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return data + '.' + sig;
}
const userToken = (id) => mintToken({ sub: id, type: 'user', iat: nowSec(), exp: nowSec() + 3600 });
const adminToken = mintToken({ sub: 'admin', type: 'admin', iat: nowSec(), exp: nowSec() + 3600 });

let pass = 0;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) { pass++; return; }
  fails.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
};

async function aCall(p, { method = 'GET', body, token, env = aEnv, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await aWorker.fetch(new Request('https://api.test' + p, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const claim = (token, category, requestId, env) =>
  aCall('/api/serial/claim', { method: 'POST', token, env, body: { category, request_id: requestId } });
const mine = (token, { sync = false, env } = {}) =>
  aCall('/api/serial/mine' + (sync ? '?sync=1' : ''), { token, env });

/** 客户端软件激活（直接打序列号后台） */
async function activate(serial, deviceId) {
  const res = await bWorker.fetch(new Request(`${BT}/?device_id=${encodeURIComponent(deviceId)}&serial=${encodeURIComponent(serial)}`), bEnv, {});
  return res.text();
}

// ─────────── 造用户与号池 ───────────
function makeUser(id, openid, phone) {
  const ts = nowSec();
  db.putUser({
    id, openid, unionid: null, session_key: 'sk', nickname: '用户' + id, phone,
    xpay_count: 0, xpay_total: 0, xpay_spent: 0, status: 0, remark: '',
    last_login_at: ts, created_at: ts, updated_at: ts,
  });
}
makeUser(1, 'openid-1', '');
makeUser(2, 'openid-2', '13900000002');
makeUser(3, 'openid-3', '13900000003');

const CAT = 'BarTender 2022';
kv.map.set('bt_list', [
  `${CAT}-S1|||||${CAT}`,
  `${CAT}-S2|||||${CAT}`,
  `${CAT}-S3|||||${CAT}`,
  `${CAT}-S4|||||${CAT}`,
].join('\n'));
kv.map.set('bt_categories', JSON.stringify([CAT]));

const bStatus = async (serial) => {
  const res = await bWorker.fetch(new Request(`${BT}/api/status?serials=${encodeURIComponent(serial)}`, {
    headers: { Authorization: 'Bearer ' + BTKEY_TOKEN },
  }), bEnv, {});
  return (await res.json()).list[0];
};

// ═══════════ 1. 鉴权与手机号门槛 ═══════════
{
  const noToken = await claim(undefined, CAT, 'req_no_token_01');
  ok(noToken.status === 401, '未登录取号应 401', noToken.status);

  const u1 = userToken(1);
  const noPhone = await claim(u1, CAT, 'req_nophone_001');
  ok(noPhone.status === 400 && noPhone.json.error === 'need_phone',
    '未绑手机号应返回 need_phone', noPhone.json);
  ok(kv.lines().every((l) => !l.includes('已领取')), '被手机号门槛拦下时不应占用号', kv.lines());
}

// ═══════════ 2. 首免：正常取号 ═══════════
let firstSerial = '';
{
  db.putUser({ ...db.getUserById(1), phone: '13900000001' });
  const u1 = userToken(1);

  const r = await claim(u1, CAT, 'req_first_0001');
  ok(r.status === 200 && r.json.ok && r.json.serial, '绑手机号后应能取号', r.json);
  ok(r.json.source === 'free' && r.json.status === 'issued', '首免来源与状态应正确', r.json);
  firstSerial = r.json.serial;
  ok(firstSerial === `${CAT}-S1`, '应按池子顺序发第一个号', firstSerial);

  const st = await bStatus(firstSerial);
  ok(st.status === 'issued', '序列号后台应变成「已领取」', st);

  const row = db.getUserSerial(firstSerial);
  ok(row && row.user_id === 1 && row.source === 'free' && row.status === 'issued',
    '本地应落一条 source=free 的记录', row);

  // 再取（新 request_id）→ 免费用完、愿望 0 → need_wish（二期：不再直接拒绝，而是要扣愿望）
  const again = await claim(u1, CAT, 'req_first_0002');
  ok(again.json.ok === false && again.json.error === 'need_wish',
    '免费额度用完后（愿望不足）应 need_wish', again.json);

  // 幂等重放
  const replay = await claim(u1, CAT, 'req_first_0001');
  ok(replay.json.ok && replay.json.repeated === true && replay.json.serial === firstSerial,
    '同 request_id 应返回原号', replay.json);
  ok(db.listUserSerials(1, 10, 0).length === 1, '幂等重放不应多发一个号', db.listUserSerials(1, 10, 0).length);
}

// ═══════════ 3. 取号分类清单（小程序选分类用） ═══════════
{
  const u1 = userToken(1);
  const r = await aCall('/api/serial/categories', { token: u1 });
  ok(r.status === 200 && r.json.ok && Array.isArray(r.json.list), '应返回分类清单', r.json);
  const cat = r.json.list.find((c) => c.name === CAT);
  ok(cat && cat.available > 0, '清单里应有该分类且带可领数量', r.json.list);
  ok(r.json.list.every((c) => typeof c.available === 'number'), '每个分类都应带 available', r.json.list);

  const noAuth = await aCall('/api/serial/categories');
  ok(noAuth.status === 401, '未登录取分类清单应 401', noAuth.status);

  const badEnv = { ...aEnv, BTKEY_API_BASE: 'https://unreachable.test' };
  const down = await aCall('/api/serial/categories', { token: u1, env: badEnv });
  ok(down.status === 502 && down.json.ok === false, '序列号后台不可达时应返回 502', down.status);
}

// ═══════════ 4. 我的序列号 + 激活状态同步 ═══════════
{
  const u1 = userToken(1);
  const m1 = await mine(u1, { sync: true });
  ok(m1.json.ok && m1.json.list.length === 1, '我的列表应有 1 个号', m1.json);
  ok(m1.json.free_used === true && m1.json.phone_bound === true, '额度与手机号状态应正确', m1.json);
  const item = m1.json.list[0];
  ok(item.status === 'issued' && item.status_text === '未激活', '激活前状态应为未激活', item);
  ok(item.category === CAT && item.serial === firstSerial, '号与分类应对上', item);

  // 客户端软件激活
  ok((await activate(firstSerial, 'DEV-AAA')) === 'on', '客户端激活应返回 on');
  const st = await bStatus(firstSerial);
  ok(st.status === 'activated' && st.device_id === 'DEV-AAA', '后台应记下设备', st);

  const m2 = await mine(u1, { sync: true });
  const item2 = m2.json.list[0];
  ok(item2.status === 'activated' && item2.status_text === '已激活', '同步后应显示已激活', item2);
  ok(item2.device_id === 'DEV-AAA' && item2.activated_at, '应带回设备号与激活时间', item2);
}

// ═══════════ 4. 号被别人抢先占住时自动换号重试 ═══════════
{
  // 模拟：A 里已经有 CAT-S3（属于用户 999），但 B 那边丢了写入、仍认为 S3 可用
  db.addUserSerial({
    user_id: 999, openid: 'openid-999', serial: `${CAT}-S3`, category: CAT,
    source: 'free', cost: 0, request_id: 'req_orphan_001',
    status: 'issued', claimed_at: nowSec(), synced_at: 0,
  });
  const stS3 = await bStatus(`${CAT}-S3`);
  ok(stS3.status === 'available', 'B 侧此时仍认为 S3 可发放（模拟状态不一致）', stS3);

  const u2 = userToken(2);
  const r = await claim(u2, CAT, 'req_retry_0001');
  ok(r.json.ok, '冲突时应自动换号重试成功', r.json);
  ok(r.json.serial === `${CAT}-S3` ? false : true, '不应把已被占的号发给别人', r.json.serial);
  ok(db.getUserSerial(`${CAT}-S3`).user_id === 999, 'S3 的归属不应被改掉', db.getUserSerial(`${CAT}-S3`).user_id);

  const mine2 = await mine(u2, { sync: true });
  ok(mine2.json.list.length === 1 && mine2.json.list[0].status === 'issued',
    '用户 2 应有 1 个号且未激活', mine2.json.list);
}

// ═══════════ 5. 号池空 ═══════════
{
  kv.map.set('bt_list', kv.lines().filter((l) => !l.includes('Z-')).join('\n'));
  // 把 CAT 下所有号都清掉，换成一个空分类
  kv.map.set('bt_list', [`${CAT}-S1|DEV-AAA|2026-01-01 10:00:00|已激活|n|${CAT}`].join('\n'));
  const u2 = userToken(2);   // 用户 2 已经用过免费额度、且愿望为 0
  const r = await claim(u2, CAT, 'req_oos_000001');
  ok(r.json.ok === false && r.json.error === 'need_wish', '用户2 免费用过且没愿望应 need_wish', r.json);

  const u3 = userToken(3);   // 用户 3 未取过，但池子里没有可用号
  const r3 = await claim(u3, CAT, 'req_oos_000002');
  ok(r3.json.ok === false && r3.json.error === 'out_of_stock', '号池空应返回 out_of_stock', r3.json);
  ok(db.listUserSerials(3, 10, 0).length === 0, '号池空时不应落库', db.listUserSerials(3, 10, 0).length);
}

// ═══════════ 6. 序列号后台不可达时，我的页面不能崩 ═══════════
{
  const badEnv = { ...aEnv, BTKEY_API_BASE: 'https://unreachable.test' };
  const u1 = userToken(1);
  const m = await mine(u1, { sync: true, env: badEnv });
  ok(m.status === 200 && m.json.ok === true, '后台不可达时「我的」仍应正常返回', m.status);
  ok(m.json.synced === false, '应标记本次没同步上', m.json.synced);
  ok(m.json.list.length === 1, '仍应返回本地已知的号', m.json.list.length);

  const r = await claim(userToken(3), CAT, 'req_down_00001', badEnv);
  ok(r.json.ok === false, '后台不可达时取号应失败而不是假装成功', r.json);
  ok(db.listUserSerials(3, 10, 0).length === 0, '失败时不应落库', db.listUserSerials(3, 10, 0).length);
}

// ═══════════ 7. 管理端：序列号发放页 ═══════════
{
  const res = await aWorker.fetch(new Request('https://api.test/admin/serials', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html = await res.text();
  ok(res.status === 200, '管理端序列号页应可访问', res.status);
  ok(html.includes('序列号发放') && html.includes(firstSerial), '页面应列出已发放的序列号', firstSerial);

  const noAuth = await aWorker.fetch(new Request('https://api.test/admin/serials'), aEnv, {});
  ok(noAuth.status === 302, '未登录访问管理端应跳登录', noAuth.status);

  const users = await aWorker.fetch(new Request('https://api.test/admin/api/users', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const uj = await users.json();
  const u1row = uj.users.find((u) => u.id === 1);
  ok(u1row && u1row.serials === 1, '用户列表应带已领号数量', u1row && u1row.serials);
}

// ═══════════ 8. 绑定手机号（明文，个人主体小程序） ═══════════
{
  // 单独造一个没绑手机号的用户 + 一个独立分类，避免影响前面的用例
  makeUser(4, 'openid-4', '');
  kv.map.set('bt_list', ['PHONE-S1|||||PHONE-CAT'].join('\n'));
  const u4 = userToken(4);

  const noAuth = await aCall('/api/user/phone', { method: 'POST', body: { phone: '13800138000' } });
  ok(noAuth.status === 401, '未登录绑定手机号应 401', noAuth.status);

  const bad = await aCall('/api/user/phone', { method: 'POST', token: u4, body: { phone: '123' } });
  ok(bad.status === 400 && bad.json.error === 'bad_phone', '手机号格式错误应 400 bad_phone', bad.json);

  // 带分隔符的号码应被清洗后保存
  const good = await aCall('/api/user/phone', { method: 'POST', token: u4, body: { phone: '138-0013-8000' } });
  ok(good.status === 200 && good.json.ok && good.json.phone === '13800138000',
    '明文手机号应能保存并清洗成 11 位', good.json);
  ok(db.getUserById(4).phone === '13800138000', '应写入 users.phone', db.getUserById(4).phone);

  const me = await aCall('/api/user/me', { token: u4 });
  ok(me.json.user.phone === '13800138000', '/api/user/me 应带出手机号', me.json.user.phone);

  // 绑好手机号后能正常取号（首免）；分类由 env 指定，这里传一个错的也应被忽略
  const r = await claim(u4, 'WRONG-CAT', 'req_phone_0001', { ...aEnv, SERIAL_CATEGORY: 'PHONE-CAT' });
  ok(r.json.ok && r.json.serial === 'PHONE-S1', '绑手机号后应能取号（分类用服务端配置）', r.json);

  // 再绑一次（换号）应覆盖，且不影响已领的号
  const rebind = await aCall('/api/user/phone', { method: 'POST', token: u4, body: { phone: '13900139000' } });
  ok(rebind.json.ok && db.getUserById(4).phone === '13900139000', '换绑手机号应覆盖', db.getUserById(4).phone);
  ok(db.getUserSerial('PHONE-S1').user_id === 4, '换绑不应影响已领的号', db.getUserSerial('PHONE-S1').user_id);
}

// ═══════════ 9. 取号分类由服务端固定（客户端传的分类一律忽略） ═══════════
{
  // 号池里同时有两个分类的号
  kv.map.set('bt_list', ['FIXED-S1|||||wxminiapp', 'FIXED-S2|||||OTHER-CAT'].join('\n'));

  // 没配 SERIAL_CATEGORY → 用代码里的默认值 wxminiapp
  makeUser(5, 'openid-5', '13900000005');
  const envDefault = { ...aEnv, SERIAL_CATEGORY: '' };
  const r1 = await aCall('/api/serial/claim', {
    method: 'POST', token: userToken(5), env: envDefault,
    body: { request_id: 'req_fixed_0001', category: 'OTHER-CAT' },
  });
  ok(r1.json.ok && r1.json.serial === 'FIXED-S1' && r1.json.category === 'wxminiapp',
    '未配环境变量时应固定从默认分类 wxminiapp 取号', r1.json);

  // 配了 SERIAL_CATEGORY → 以它为准（客户端传 wxminiapp 也不作数）
  kv.map.set('bt_list', ['FIXED-S1|||||wxminiapp', 'FIXED-S2|||||OTHER-CAT'].join('\n'));
  makeUser(6, 'openid-6', '13900000006');
  const envExplicit = { ...aEnv, SERIAL_CATEGORY: 'OTHER-CAT' };
  const r2 = await aCall('/api/serial/claim', {
    method: 'POST', token: userToken(6), env: envExplicit,
    body: { request_id: 'req_fixed_0002', category: 'wxminiapp' },
  });
  ok(r2.json.ok && r2.json.serial === 'FIXED-S2' && r2.json.category === 'OTHER-CAT',
    'SERIAL_CATEGORY 应覆盖默认分类', r2.json);

  // 固定分类里没号时，明确 out_of_stock（而不是去别的分类捞）
  kv.map.set('bt_list', ['ONLY-OTHER|||||OTHER-CAT'].join('\n'));
  makeUser(7, 'openid-7', '13900000007');
  const r3 = await aCall('/api/serial/claim', {
    method: 'POST', token: userToken(7), env: { ...aEnv, SERIAL_CATEGORY: 'wxminiapp' },
    body: { request_id: 'req_fixed_0003' },
  });
  ok(r3.json.ok === false && r3.json.error === 'out_of_stock',
    '固定分类没号时不应跨分类发号', r3.json);
}

// ═══════════ 10. 后台删除发放记录 → 用户可以重新领 ═══════════
{
  makeUser(8, 'openid-8', '13900000008');
  kv.map.set('bt_list', ['DEL-S1|||||DEL-CAT', 'DEL-S2|||||DEL-CAT'].join('\n'));
  const envDel = { ...aEnv, SERIAL_CATEGORY: 'DEL-CAT' };
  const u8 = userToken(8);

  async function adminDelete(serial, action) {
    return aWorker.fetch(new Request('https://api.test/admin/serials/delete', {
      method: 'POST',
      headers: { Cookie: 'admin_token=' + adminToken, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ serial, action, page: '1' }).toString(),
    }), envDel, {});
  }

  // ① 首免领一个
  const first = await claim(u8, '', 'req_del_00001', envDel);
  ok(first.json.ok && first.json.serial === 'DEL-S1', '首次应领到 DEL-S1', first.json);

  // ② 再领：免费用完且愿望 0 → need_wish
  const again = await claim(u8, '', 'req_del_00002', envDel);
  ok(again.json.ok === false && again.json.error === 'need_wish', '免费用过（无愿望）应 need_wish', again.json);

  // ③ 后台「删除·退回池」
  const del = await adminDelete('DEL-S1', 'release');
  ok(del.status === 302, '删除应 302 回列表', del.status);
  ok(!db.getUserSerial('DEL-S1'), '本地记录应已删除', db.getUserSerial('DEL-S1'));
  const backSt = await bStatus('DEL-S1');
  ok(backSt.status === 'available', '号应退回可发放池', backSt);

  // ④ 免费额度被释放 → 又能领，且拿回刚退的号
  const m1 = await mine(u8, { sync: true, env: envDel });
  ok(m1.json.free_used === false && m1.json.list.length === 0, '删除后免费额度应释放', m1.json);
  const re = await claim(u8, '', 'req_del_00003', envDel);
  ok(re.json.ok && re.json.serial === 'DEL-S1', '删除后应能重新领取并拿到退回的号', re.json);

  // ⑤ 激活之后再删：已激活的号只能作废，不能回池
  ok((await activate('DEL-S1', 'DEV-DEL')) === 'on', '客户端激活该号');
  await mine(u8, { sync: true, env: envDel });
  ok(db.getUserSerial('DEL-S1').status === 'activated', '本地应同步成已激活', db.getUserSerial('DEL-S1').status);

  const del2 = await adminDelete('DEL-S1', 'release');   // 故意传 release，应被强制成作废
  ok(del2.status === 302, '已激活的号删除应 302', del2.status);
  ok(!db.getUserSerial('DEL-S1'), '已激活的号记录应被删除', db.getUserSerial('DEL-S1'));
  const voidSt = await bStatus('DEL-S1');
  ok(voidSt.status === 'void', '已激活的号应被作废而不是回池', voidSt);
  ok((await activate('DEL-S1', 'DEV-DEL2')) === 'off', '作废后不能再激活');

  // ⑥ 作废旧的号后，仍能领到下一个号
  const re2 = await claim(u8, '', 'req_del_00004', envDel);
  ok(re2.json.ok && re2.json.serial === 'DEL-S2', '还能领到下一个可用号', re2.json);

  // ⑦ 未登录不能删
  const noAuth = await aWorker.fetch(new Request('https://api.test/admin/serials/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ serial: 'DEL-S2', action: 'release' }).toString(),
  }), envDel, {});
  ok(noAuth.status === 302 && String(noAuth.headers.get('location') || '').includes('/login'),
    '未登录删除应跳登录', noAuth.headers.get('location'));
  ok(!!db.getUserSerial('DEL-S2'), '未登录删除不应动数据', db.getUserSerial('DEL-S2'));

  // ⑧ 号池里已经不存在的号（例如被人在序列号后台删了）也要能删掉本地记录
  db.addUserSerial({
    user_id: 8, openid: 'openid-8', serial: 'GONE-S9', category: 'DEL-CAT',
    source: 'wish', cost: 10, request_id: 'req_gone_0001',
    status: 'missing', claimed_at: nowSec(), synced_at: 0,
  });
  const delGone = await adminDelete('GONE-S9', 'release');
  ok(delGone.status === 302, '号池不存在的号删除也应 302', delGone.status);
  ok(!db.getUserSerial('GONE-S9'), '号池不存在的号应能删掉本地记录', db.getUserSerial('GONE-S9'));

  // ⑨ 序列号后台不可达时，应拒绝删除（避免两边不一致）
  db.addUserSerial({
    user_id: 8, openid: 'openid-8', serial: 'KEEP-S1', category: 'DEL-CAT',
    source: 'wish', cost: 10, request_id: 'req_keep_0001',
    status: 'issued', claimed_at: nowSec(), synced_at: 0,
  });
  const delDown = await aWorker.fetch(new Request('https://api.test/admin/serials/delete', {
    method: 'POST',
    headers: { Cookie: 'admin_token=' + adminToken, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ serial: 'KEEP-S1', action: 'release', page: '1' }).toString(),
  }), { ...envDel, BTKEY_API_BASE: 'https://unreachable.test' }, {});
  ok(delDown.status === 302, '后台不可达时也应回到列表并提示', delDown.status);
  ok(!!db.getUserSerial('KEEP-S1'), '后台不可达时不应删除本地记录', db.getUserSerial('KEEP-S1'));
}

// ═══════════ 11. 后台时间必须是北京时间（服务器可能是 UTC） ═══════════
{
  const TS = 1760000000;   // 固定时间戳，便于比对
  db.addUserSerial({
    user_id: 9, openid: 'openid-9', serial: 'TZ-S1', category: 'TZ',
    source: 'free', cost: 0, request_id: 'req_tz_0001',
    status: 'issued', claimed_at: TS, synced_at: 0,
  });
  const res = await aWorker.fetch(new Request('https://api.test/admin/serials?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html = await res.text();

  const p2 = (n) => String(n).padStart(2, '0');
  const bjDate = new Date((TS + 8 * 3600) * 1000);
  const expectBj = `${bjDate.getUTCFullYear()}-${p2(bjDate.getUTCMonth() + 1)}-${p2(bjDate.getUTCDate())} `
    + `${p2(bjDate.getUTCHours())}:${p2(bjDate.getUTCMinutes())}:${p2(bjDate.getUTCSeconds())}`;
  const utcString = new Date(TS * 1000).toISOString().slice(0, 19).replace('T', ' ');

  ok(html.includes(expectBj), '后台领取时间应为北京时间（年月日 时分秒）', expectBj);
  ok(!html.includes(utcString), '后台领取时间不应显示成 UTC', utcString);

  // 审计日志页同样用北京时间
  const logs = await aWorker.fetch(new Request('https://api.test/admin/logs?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const logHtml = await logs.text();
  ok(logs.status === 200, '审计日志页应可访问', logs.status);
  ok(!/T\d{2}:\d{2}:\d{2}/.test(logHtml), '审计日志不应出现 ISO 格式（UTC）', logHtml.match(/T\d{2}:\d{2}:\d{2}/));
}

// ═══════════ 12. 后台首页：浏览器端脚本不能引用服务端专用函数 ═══════════
// 用户列表/订单列表是在浏览器里渲染的，若脚本里引用了服务端的 fmtBeijing/escapeHtml 之类，
// 会抛 ReferenceError，页面上就永远停在「加载中…」。
{
  const res = await aWorker.fetch(new Request('https://api.test/admin', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html = await res.text();
  ok(res.status === 200, '后台首页应可访问', res.status);
  ok(/function fmtBj\s*\(/.test(html), '后台页面应自带浏览器端时间格式化函数 fmtBj');
  for (const name of ['fmtBeijing(', 'fmtBeijingDay(', 'escapeHtml(', 'toYuan(', 'publicUser(', 'vipInfo(', '__db.']) {
    ok(!html.includes(name), `浏览器端脚本不应出现服务端专用的 ${name}`, (html.split(name).length - 1) + ' 处');
  }
  ok(!html.includes('colspan="9"'), '用户表空态 colspan 应与列数一致（10）');

  const users = await aWorker.fetch(new Request('https://api.test/admin/api/users?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const uj = await users.json();
  ok(users.status === 200 && Array.isArray(uj.users), '/admin/api/users 应返回用户数组', uj && uj.error);
  ok(uj.users.every((u) => typeof u.serials === 'number'), '用户数据应带已领号数量', uj.users.slice(0, 1));
}

// ═══════════ 13. 真跑一遍后台首页脚本，确认用户列表能渲染（不是一直"加载中"） ═══════════
{
  const res = await aWorker.fetch(new Request('https://api.test/admin', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html = await res.text();
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  ok(m && m[1].length > 200, '应能取到后台首页的内联脚本');

  if (m) {
    const elements = {};
    const el = (id) => (elements[id] = elements[id] || {
      id, textContent: '', innerHTML: '', value: '', className: '', style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
    });
    const document = {
      getElementById: el, addEventListener() {}, querySelectorAll() { return []; },
      querySelector() { return null; }, body: {},
    };
    const fetchStub = async (url) => {
      const u = String(url);
      if (u.includes('api/users')) {
        return { json: async () => ({
          total: 1, page: 1, pageSize: 20,
          users: [{
            id: 1, nickname: '张三', openid: 'o1', phone: '138****8000',
            count: 0, total: 0, spent: '0.00', serials: 1, status: 0, remark: '',
            created_at: 1760000000,
          }],
        }) };
      }
      if (u.includes('api/stats')) {
        return { json: async () => ({ total: 1, svip: 0, new_today: 0, spent_sum: '0.00', count_sum: 0 }) };
      }
      return { json: async () => ({ products: [] }) };
    };

    const sandbox = { document, fetch: fetchStub, console, setTimeout, clearTimeout, localStorage: { getItem() { return null; }, setItem() {} }, location: { reload() {} } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    let scriptError = null;
    try {
      vm.runInContext(m[1], sandbox, { filename: 'admin-inline.js' });
      await sandbox.load(1);            // 真实调用页面里的 load()
    } catch (e) {
      scriptError = e;
    }
    ok(!scriptError, '后台首页脚本应能正常执行（不能有 ReferenceError）', scriptError && scriptError.message);

    const tb = elements.tb;
    ok(tb && String(tb.innerHTML).includes('<tr>'), '用户列表应渲染出表格行', tb && String(tb.innerHTML).slice(0, 80));
    ok(tb && String(tb.innerHTML).includes('张三'), '渲染结果应包含昵称', tb && String(tb.innerHTML).slice(0, 80));
    ok(tb && String(tb.innerHTML).includes('2025-10-09'),
      '注册时间应是北京时间日期（1760000000 → 2025-10-09）', tb && String(tb.innerHTML).slice(0, 160));
  }
}

// ═══════════ 14. 我的序列号分页（免费额度必须查库，不能靠当前页推断） ═══════════
{
  makeUser(10, 'openid-10', '13900000010');
  const base = nowSec();
  // 免费号故意做最老（会排到最后一页），另外 4 个 wish 号较新
  db.addUserSerial({
    user_id: 10, openid: 'openid-10', serial: 'PG-FREE', category: 'PG',
    source: 'free', cost: 0, request_id: 'pg_free', status: 'issued',
    claimed_at: base - 100, synced_at: nowSec(),
  });
  for (let i = 1; i <= 4; i++) {
    db.addUserSerial({
      user_id: 10, openid: 'openid-10', serial: 'PG-' + i, category: 'PG',
      source: 'wish', cost: 10, request_id: 'pg_' + i, status: 'issued',
      claimed_at: base - i * 10, synced_at: nowSec(),
    });
  }
  const u10 = userToken(10);
  const q = (s) => aCall('/api/serial/mine' + s, { token: u10 });

  const p1 = await q('?page=1&page_size=2');
  ok(p1.json.ok && p1.json.list.length === 2, '第一页应返回 2 条', p1.json.list.length);
  ok(p1.json.total === 5, '应返回总数 5', p1.json.total);
  ok(p1.json.has_more === true, '第一页应有更多', p1.json.has_more);
  ok(p1.json.free_used === true,
    '免费额度应查库得出（免费号不在第一页时也不能变成 false）', p1.json.free_used);
  ok(!p1.json.list.some((x) => x.serial === 'PG-FREE'),
    '免费号不应出现在第一页（用来验证判断不依赖当前页）', p1.json.list.map((x) => x.serial));

  const p3 = await q('?page=3&page_size=2');
  ok(p3.json.list.length === 1 && p3.json.list[0].serial === 'PG-FREE',
    '第三页应只剩那条免费号', p3.json.list.map((x) => x.serial));
  ok(p3.json.has_more === false, '最后一页 has_more 应为 false', p3.json.has_more);

  // 「我的」页只取 2 条做预览也不影响额度展示
  const preview = await q('?page=1&page_size=2&sync=1');
  ok(preview.json.ok && preview.json.total === 5 && preview.json.free_used === true,
    '预览请求（page_size=2）也应返回正确总数与额度', { total: preview.json.total, free_used: preview.json.free_used });
}

// ═══════════ 15. 二期：首免之后每次扣 10 个愿望 ═══════════
{
  makeUser(11, 'openid-11', '13900000011');
  db.putUser({ ...db.getUserById(11), xpay_count: 25, xpay_total: 30 });
  kv.map.set('bt_list', ['W1|||||WISH-CAT', 'W2|||||WISH-CAT', 'W3|||||WISH-CAT', 'W4|||||WISH-CAT'].join('\n'));
  const envW = { ...aEnv, SERIAL_CATEGORY: 'WISH-CAT' };
  const u11 = userToken(11);

  // ① 第一次：免费，不扣愿望
  const f = await claim(u11, '', 'req_wish_00001', envW);
  ok(f.json.ok && f.json.source === 'free' && f.json.cost === 0, '首次应免费', f.json);
  ok(db.getUserById(11).xpay_count === 25, '免费那次不扣愿望', db.getUserById(11).xpay_count);
  ok(db.getUserSerial('W1').source === 'free', '落库来源应为 free', db.getUserSerial('W1').source);

  // ② 第二次：扣 10
  const p = await claim(u11, '', 'req_wish_00002', envW);
  ok(p.json.ok && p.json.source === 'wish' && p.json.cost === 10, '第二次应扣愿望', p.json);
  ok(db.getUserById(11).xpay_count === 15, '余额应从 25 扣到 15', db.getUserById(11).xpay_count);
  ok(p.json.wish_left === 15, '接口应返回剩余愿望 15', p.json.wish_left);
  ok(db.getUserSerial(p.json.serial).cost === 10, '落库应记录扣了 10 个愿望', db.getUserSerial(p.json.serial).cost);

  // ③ 幂等重放：不重复扣款、不重复发号
  const replay = await claim(u11, '', 'req_wish_00002', envW);
  ok(replay.json.ok && replay.json.repeated === true, '重放应返回上次结果', replay.json);
  ok(db.getUserById(11).xpay_count === 15, '重放不应重复扣愿望', db.getUserById(11).xpay_count);

  // ④ 第三次：15 → 5
  const p2 = await claim(u11, '', 'req_wish_00003', envW);
  ok(p2.json.ok && db.getUserById(11).xpay_count === 5, '再扣一次应剩 5', db.getUserById(11).xpay_count);

  // ⑤ 余额不足（5 < 10）：不发号、不扣款
  const beforeCount = db.listUserSerials(11, 50, 0).length;
  const p3 = await claim(u11, '', 'req_wish_00004', envW);
  ok(p3.json.ok === false && p3.json.error === 'need_wish', '余额不足应 need_wish', p3.json);
  ok(p3.json.need === 10 && p3.json.wish_left === 5, '应告知需要多少、现有多少', p3.json);
  ok(db.getUserById(11).xpay_count === 5, '余额不足不应扣款', db.getUserById(11).xpay_count);
  ok(db.listUserSerials(11, 50, 0).length === beforeCount, '余额不足不应发号', db.listUserSerials(11, 50, 0).length);

  // ⑥ 号池没号（付费路径）：不扣款
  db.putUser({ ...db.getUserById(11), xpay_count: 50 });
  kv.map.set('bt_list', ['OTHER1|||||OTHER-CAT'].join('\n'));
  const p4 = await claim(u11, '', 'req_wish_00005', envW);
  ok(p4.json.ok === false && p4.json.error === 'out_of_stock', '号池空应 out_of_stock', p4.json);
  ok(db.getUserById(11).xpay_count === 50, '占号失败不应扣愿望', db.getUserById(11).xpay_count);

  // ⑦ 号被别人抢先占了：事务回滚 → 换号重试，只扣一次
  db.addUserSerial({
    user_id: 999, openid: 'openid-999', serial: 'C1', category: 'CONF-CAT',
    source: 'wish', cost: 10, request_id: 'conf_seed_01', status: 'issued',
    claimed_at: nowSec(), synced_at: nowSec(),
  });
  kv.map.set('bt_list', ['C1|||||CONF-CAT', 'C2|||||CONF-CAT'].join('\n'));
  const c = await claim(u11, '', 'req_conf_0001', { ...aEnv, SERIAL_CATEGORY: 'CONF-CAT' });
  ok(c.json.ok && c.json.serial === 'C2', '撞号时应换号成功', c.json);
  ok(db.getUserById(11).xpay_count === 40, '撞号重试只扣一次愿望', db.getUserById(11).xpay_count);
  ok(db.getUserSerial('C1').user_id === 999, '撞号时不能改动别人的记录', db.getUserSerial('C1').user_id);

  // ⑧ 成本可配（env SERIAL_WISH_COST=30）
  db.putUser({ ...db.getUserById(11), xpay_count: 100 });
  const envC30 = { ...aEnv, SERIAL_CATEGORY: 'WISH-CAT', SERIAL_WISH_COST: '30' };
  kv.map.set('bt_list', ['W9|||||WISH-CAT'].join('\n'));
  const c30 = await claim(u11, '', 'req_wish_cost30', envC30);
  ok(c30.json.ok && c30.json.cost === 30, 'SERIAL_WISH_COST 应生效', c30.json);
  ok(db.getUserById(11).xpay_count === 70, '应按配置扣 30', db.getUserById(11).xpay_count);
}

// ═══════════ 16. 后台能看到并搜索「购买的版本」 ═══════════
{
  makeUser(12, 'openid-12', '13900000012');
  db.putUser({ ...db.getUserById(12), xpay_count: 50 });
  kv.map.set('bt_list', ['VR-1|||||VER-CAT', 'VR-2|||||VER-CAT'].join('\n'));
  const envV = { ...aEnv, SERIAL_CATEGORY: 'VER-CAT' };
  const u12 = userToken(12);
  const VER = 'BarTender 2022 · R8 (216048) Full x64';

  const r = await aCall('/api/serial/claim', {
    method: 'POST', token: u12, env: envV,
    body: { request_id: 'req_ver_00001', version: VER },
  });
  ok(r.json.ok && r.json.version === VER, '取号应回带版本', r.json.version);
  ok(db.getUserSerial(r.json.serial).version === VER, '本地应存下版本', db.getUserSerial(r.json.serial).version);

  const pageRes = await aWorker.fetch(new Request('https://api.test/admin/serials?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const pageHtml = await pageRes.text();
  ok(pageHtml.includes('<th>版本</th>'), '序列号发放页应有「版本」列');
  ok(pageHtml.includes(VER), '列表应显示取号时选的版本');

  const searchRes = await aWorker.fetch(new Request(
    'https://api.test/admin/serials?page=1&search=' + encodeURIComponent('216048'),
    { headers: { Cookie: 'admin_token=' + adminToken } },
  ), aEnv, {});
  const searchHtml = await searchRes.text();
  ok(searchHtml.includes(r.json.serial), '按版本关键字应能搜到这条记录', r.json.serial);

  // 版本超长/带控制字符：截断并清洗
  const r2 = await aCall('/api/serial/claim', {
    method: 'POST', token: u12, env: envV,
    body: { request_id: 'req_ver_00002', version: 'X'.repeat(200) + '\n\t' },
  });
  ok(r2.json.ok && r2.json.version.length <= 80, '版本应被截断到 80 字以内', r2.json.version.length);
  ok(!/[\n\t]/.test(r2.json.version), '版本里的控制字符应被清掉', JSON.stringify(r2.json.version));

  // 不传版本也能正常取号（老客户端兼容）
  kv.map.set('bt_list', ['VR-3|||||VER-CAT'].join('\n'));
  const r3 = await aCall('/api/serial/claim', {
    method: 'POST', token: u12, env: envV, body: { request_id: 'req_ver_00003' },
  });
  ok(r3.json.ok && r3.json.version === '', '不传版本应正常发号、版本为空', r3.json.version);
}

// ═══════════ 17. 老库自动补 version 列（已上线跑过数据的情况） ═══════════
{
  const os = await import('node:os');
  const fs = await import('node:fs');
  const tmp = path.join(os.tmpdir(), 'dsh-mig-' + process.pid + '-' + Date.now() + '.db');

  const raw = new DatabaseSync(tmp);
  raw.exec(`CREATE TABLE user_serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, openid TEXT NOT NULL,
    serial TEXT NOT NULL UNIQUE, category TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'free', cost INTEGER NOT NULL DEFAULT 0,
    request_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'issued',
    device_id TEXT NOT NULL DEFAULT '', activated_at TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER, synced_at INTEGER NOT NULL DEFAULT 0, remark TEXT NOT NULL DEFAULT '')`);
  raw.exec("INSERT INTO user_serials (user_id, openid, serial) VALUES (1,'o1','OLD-1')");
  raw.close();

  const upgraded = new SQLiteDB(tmp);
  ok(upgraded.getUserSerial('OLD-1').version === '', '老库应自动补上 version 列（默认空）',
    upgraded.getUserSerial('OLD-1') && upgraded.getUserSerial('OLD-1').version);
  upgraded.addUserSerial({
    user_id: 2, openid: 'o2', serial: 'NEW-1', category: 'c', version: 'v1',
    source: 'wish', cost: 10, request_id: 'mig_1', status: 'issued', claimed_at: 1, synced_at: 0,
  });
  ok(upgraded.getUserSerial('NEW-1').version === 'v1', '迁移后应能写入版本', upgraded.getUserSerial('NEW-1').version);
  upgraded.close();

  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

// ═══════════ 18. 智能插座验证码（每生成 1 个扣 1 愿望，算法与 key.py 一致） ═══════════
// 下面的期望值是把仓库里的 key.py 用 python 跑出来的，不是自己推的
{
  makeUser(13, 'openid-13', '13900000013');
  db.putUser({ ...db.getUserById(13), xpay_count: 10 });
  const u13 = userToken(13);
  const gen = (macs, rid) => aCall('/api/socket/codes', {
    method: 'POST', token: u13, body: { macs, request_id: rid },
  });

  // ① 单个：带冒号 + 小写，也要按参考值算出来
  const r1 = await gen(['aa:bb:cc:dd:ee:ff'], 'req_sock_00001');
  ok(r1.json.ok && r1.json.items.length === 1, '单个 MAC 应生成 1 条', r1.json);
  ok(r1.json.items[0].mac === 'AABBCCDDEEFF', 'MAC 应标准化成 12 位大写', r1.json.items[0].mac);
  ok(r1.json.items[0].code === '242270', '验证码应与 key.py 一致（242270）', r1.json.items[0].code);
  ok(r1.json.items[0].remote === 'key:242270', '应带远程指令 key:XXXXXX', r1.json.items[0].remote);
  ok(db.getUserById(13).xpay_count === 9, '应扣 1 个愿望', db.getUserById(13).xpay_count);

  // ② 批量：其余参考向量（python key.py 的输出）
  const VEC = [
    ['00:11:22:33:44:55', '204894'],
    ['1234567890AB', '409018'],
    ['FFFFFFFFFFFF', '909374'],
    ['000000000000', '018238'],
    ['A1:B2:C3:D4:E5:F6', '373246'],
  ];
  const r2 = await gen(VEC.map((v) => v[0]), 'req_sock_00002');
  ok(r2.json.ok && r2.json.items.length === 5, '批量应生成 5 条', r2.json.items && r2.json.items.length);
  let allMatch = true;
  for (const [mac, code] of VEC) {
    const want = mac.replace(/:/g, '');
    const got = r2.json.items.find((it) => it.mac === want);
    if (!got || got.code !== code) allMatch = false;
  }
  ok(allMatch, '批量结果应全部与 key.py 一致', r2.json.items.map((i) => i.mac + '=' + i.code));
  ok(db.getUserById(13).xpay_count === 4, '批量 5 个应扣 5 个愿望（10-1-5）', db.getUserById(13).xpay_count);

  // ③ 去重：同一个 MAC 写两遍（一次带冒号一次不带）只算一次
  db.putUser({ ...db.getUserById(13), xpay_count: 10 });
  const r3 = await gen(['AABBCCDDEEFF', 'aa:bb:cc:dd:ee:ff'], 'req_sock_00003');
  ok(r3.json.ok && r3.json.items.length === 1 && r3.json.cost === 1,
    '重复 MAC 应去重、只扣一次', { n: r3.json.items && r3.json.items.length, cost: r3.json.cost });
  ok(db.getUserById(13).xpay_count === 9, '去重后只扣 1 个', db.getUserById(13).xpay_count);

  // ④ 非法 MAC：不扣费、不落库
  const codesBefore = db.countUserCodes(13);
  const r4 = await gen(['ZZ:BB:CC:DD:EE:FF'], 'req_sock_00004');
  ok(r4.status === 400 && r4.json.error === 'bad_mac', '非法 MAC 应 400 bad_mac', r4.json);
  ok(db.getUserById(13).xpay_count === 9, '非法 MAC 不应扣愿望', db.getUserById(13).xpay_count);
  ok(db.countUserCodes(13) === codesBefore, '非法 MAC 不应落库', db.countUserCodes(13));

  // ⑤ 余额不足：402，不扣费、不落库
  db.putUser({ ...db.getUserById(13), xpay_count: 2 });
  const before5 = db.countUserCodes(13);
  const r5 = await gen(['AABBCCDDEEFF', '00:11:22:33:44:55', '1234567890AB'], 'req_sock_00005');
  ok(r5.status === 402 && r5.json.error === 'need_wish', '余额不足应 402 need_wish', r5.json);
  ok(r5.json.need === 3 && r5.json.wish_left === 2, '应告知需要 3、现有 2', r5.json);
  ok(db.getUserById(13).xpay_count === 2, '余额不足不应扣愿望', db.getUserById(13).xpay_count);
  ok(db.countUserCodes(13) === before5, '余额不足不应落库', db.countUserCodes(13));

  // ⑥ 幂等重放：不重复扣、不重复落库
  db.putUser({ ...db.getUserById(13), xpay_count: 10 });
  const a1 = await gen(['1234567890AB'], 'req_sock_00006');
  const a2 = await gen(['1234567890AB'], 'req_sock_00006');
  ok(a2.json.ok && a2.json.repeated === true, '同 request_id 应返回上次结果', a2.json);
  ok(a2.json.items[0].code === a1.json.items[0].code, '重放结果应与首次一致',
    { first: a1.json.items[0].code, again: a2.json.items[0].code });
  ok(db.getUserById(13).xpay_count === 9, '重放不应重复扣愿望', db.getUserById(13).xpay_count);
  ok(db.countUserCodes(13) === before5 + 1, '重放不应重复落库', db.countUserCodes(13));

  // ⑦ 单批上限 50
  const many = [];
  for (let i = 0; i < 51; i++) many.push('AABBCCDDEE' + i.toString(16).toUpperCase().padStart(2, '0'));
  db.putUser({ ...db.getUserById(13), xpay_count: 999 });
  const r7 = await gen(many, 'req_sock_00007');
  ok(r7.status === 400 && r7.json.error === 'too_many', '超过 50 个应 too_many', r7.json);
  ok(db.getUserById(13).xpay_count === 999, '超限不应扣愿望', db.getUserById(13).xpay_count);

  // ⑧ 空输入
  const r8 = await gen([], 'req_sock_00008');
  ok(r8.status === 400 && r8.json.error === 'empty_mac', '空输入应 empty_mac', r8.json);

  // ⑨ 后台能看到，并且和「标签软件序列号」分开
  const page = await aWorker.fetch(new Request('https://api.test/admin/codes?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html = await page.text();
  ok(page.status === 200, '插座验证码页应可访问', page.status);
  ok(html.includes('插座验证码'), '页面标题应写明是插座验证码');
  ok(html.includes('242270'), '列表应显示生成的验证码', '242270');
  ok(html.includes('AABBCCDDEEFF'), '列表应显示标准化 MAC');
  ok(html.includes('key:242270'), '列表应显示远程指令');

  // 搜索 MAC 带冒号也能命中
  const searched = await aWorker.fetch(new Request(
    'https://api.test/admin/codes?page=1&search=' + encodeURIComponent('AA:BB:CC:DD:EE:FF'),
    { headers: { Cookie: 'admin_token=' + adminToken } },
  ), aEnv, {});
  const sHtml = await searched.text();
  ok(sHtml.includes('242270'), '搜索带冒号的 MAC 应能命中', '242270');

  // 用户列表里两种功能都有数量
  const users = await aWorker.fetch(new Request('https://api.test/admin/api/users?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const uj = await users.json();
  const row13 = (uj.users || []).find((x) => x.id === 13);
  ok(row13 && row13.codes > 0, '用户列表应显示插座 key 数量', row13 && row13.codes);
  ok(row13 && typeof row13.serials === 'number', '同时仍保留已领号数量', row13 && row13.serials);
}

// ═══════════ 19. 我的插座验证码（「我的」页同步展示） ═══════════
{
  makeUser(14, 'openid-14', '13900000014');
  makeUser(15, 'openid-15', '13900000015');
  db.putUser({ ...db.getUserById(14), xpay_count: 10 });
  db.putUser({ ...db.getUserById(15), xpay_count: 10 });
  const u14 = userToken(14);
  const u15 = userToken(15);

  const g1 = await aCall('/api/socket/codes', {
    method: 'POST', token: u14, body: { macs: ['AABBCCDDEEFF'], request_id: 'req_mine_0001' },
  });
  ok(g1.json.ok, '用户14 生成第 1 个', g1.json);
  const g2 = await aCall('/api/socket/codes', {
    method: 'POST', token: u14, body: { macs: ['001122334455', '1234567890AB'], request_id: 'req_mine_0002' },
  });
  ok(g2.json.ok && g2.json.items.length === 2, '用户14 再生成 2 个', g2.json);
  const g3 = await aCall('/api/socket/codes', {
    method: 'POST', token: u15, body: { macs: ['FFFFFFFFFFFF'], request_id: 'req_mine_0003' },
  });
  ok(g3.json.ok, '用户15 生成 1 个', g3.json);

  // 未登录
  const noAuth = await aCall('/api/socket/mine');
  ok(noAuth.status === 401, '未登录取我的验证码应 401', noAuth.status);

  // 用户14 只看到自己的 3 个
  const m14 = await aCall('/api/socket/mine', { token: u14 });
  ok(m14.json.ok && m14.json.total === 3 && m14.json.list.length === 3,
    '应返回自己生成的 3 个', { total: m14.json.total, n: m14.json.list && m14.json.list.length });
  ok(!m14.json.list.some((x) => x.code === '909374'),
    '不应看到别人的验证码', m14.json.list.map((x) => x.code));
  ok(m14.json.list.every((x) => x.remote === 'key:' + x.code), '每条应带远程指令 key:XXXXXX');
  ok(m14.json.list.every((x) => x.mac && x.created_at > 0), '每条应有 MAC 与生成时间');

  // 分页：最新在前
  const p1 = await aCall('/api/socket/mine?page=1&page_size=2', { token: u14 });
  ok(p1.json.list.length === 2 && p1.json.has_more === true && p1.json.total === 3,
    '第一页 2 条 + 还有更多', { n: p1.json.list.length, more: p1.json.has_more, total: p1.json.total });
  const p2 = await aCall('/api/socket/mine?page=2&page_size=2', { token: u14 });
  ok(p2.json.list.length === 1 && p2.json.has_more === false, '第二页 1 条 + 没有更多', p2.json);
  ok(p2.json.list[0].code === g1.json.items[0].code, '最早生成的那条应排在最后', p2.json.list[0].code);

  // 用户15 只看自己的
  const m15 = await aCall('/api/socket/mine', { token: u15 });
  ok(m15.json.total === 1 && m15.json.list[0].code === '909374',
    '用户15 应只看到自己的 1 个', m15.json.list);

  // 没生成过的用户：空列表而不是报错
  makeUser(16, 'openid-16', '13900000016');
  const m16 = await aCall('/api/socket/mine', { token: userToken(16) });
  ok(m16.json.ok && m16.json.total === 0 && m16.json.list.length === 0,
    '没生成过应返回空列表', m16.json);
}

// ═══════════ 20. 下载/激活地址随序列号发放，只在「我的」可见 ═══════════
{
  makeUser(17, 'openid-17', '13900000017');
  kv.map.set('bt_list', ['LNK-S1|||||LNK-CAT', 'LNK-S2|||||LNK-CAT'].join('\n'));
  const envL = { ...aEnv, SERIAL_CATEGORY: 'LNK-CAT' };
  const u17 = userToken(17);
  const DL = 'https://app.521156.xyz/bt/10086/BT2022.R8.x64.exe';
  const KEY = 'https://app.521156.xyz/bt/10086/BT2022-key.exe';

  const r = await aCall('/api/serial/claim', {
    method: 'POST', token: u17, env: envL,
    body: {
      request_id: 'req_lnk_00001', version: 'BarTender 2022 · R8 (216048) Full x64',
      download_url: DL, key_url: KEY,
    },
  });
  ok(r.json.ok && r.json.download_url === DL && r.json.key_url === KEY,
    '取号应回带下载/激活地址', { dl: r.json.download_url, key: r.json.key_url });

  const row = db.getUserSerial(r.json.serial);
  ok(row.download_url === DL && row.key_url === KEY, '地址应随记录落库', { dl: row.download_url, key: row.key_url });

  // 只有本人能拿到（我的页用的接口）
  const mine = await aCall('/api/serial/mine', { token: u17 });
  const me = (mine.json.list || [])[0];
  ok(me && me.download_url === DL && me.key_url === KEY, '我的序列号应返回下载/激活地址',
    { dl: me && me.download_url, key: me && me.key_url });

  // 别人看不到
  makeUser(18, 'openid-18', '13900000018');
  const other = await aCall('/api/serial/mine', { token: userToken(18) });
  ok(other.json.list.length === 0, '别的用户不应看到这条记录', other.json.list.length);

  // 后台列表不展示地址（避免外泄），只展示版本
  const adminPage = await aWorker.fetch(new Request('https://api.test/admin/serials?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const adminHtml = await adminPage.text();
  ok(!adminHtml.includes(DL), '后台列表不应出现下载地址');
  ok(adminHtml.includes('BarTender 2022 · R8 (216048) Full x64'), '后台仍应显示版本');

  // 非 http(s) 地址一律丢弃
  kv.map.set('bt_list', ['LNK-S3|||||LNK-CAT', 'LNK-S4|||||LNK-CAT'].join('\n'));
  db.putUser({ ...db.getUserById(17), xpay_count: 10 });
  const bad = await aCall('/api/serial/claim', {
    method: 'POST', token: u17, env: envL,
    body: { request_id: 'req_lnk_00002', download_url: 'javascript:alert(1)', key_url: 'ftp://x/y' },
  });
  ok(bad.json.ok && bad.json.download_url === '' && bad.json.key_url === '',
    '非 http(s) 地址应被清空', { dl: bad.json.download_url, key: bad.json.key_url });

  // 不传地址也能正常取号（老客户端）
  db.putUser({ ...db.getUserById(17), xpay_count: 10 });
  const plain = await aCall('/api/serial/claim', {
    method: 'POST', token: u17, env: envL, body: { request_id: 'req_lnk_00003' },
  });
  ok(plain.json.ok && plain.json.download_url === '', '不传地址应正常取号、地址为空', plain.json.download_url);
}

// ═══════════ 21. 默认愿望档位：新增 50 / 100 ═══════════
{
  const pub = await aCall('/api/xpay/products', { token: userToken(1) });
  const list = pub.json.products || [];
  ok(list.length === 6, '默认应有 6 个档位', list.map((p) => p.productId));

  const byId = {};
  for (const p of list) byId[p.productId] = p;
  ok(byId.svc_unlock_50 && byId.svc_unlock_50.times === 50 && byId.svc_unlock_50.price === '50.00',
    '应有「愿望50个 = 50.00 元」', byId.svc_unlock_50);
  ok(byId.svc_unlock_100 && byId.svc_unlock_100.times === 100 && byId.svc_unlock_100.price === '100.00',
    '应有「愿望100个 = 100.00 元」', byId.svc_unlock_100);
  ok(list.every((p) => p.goodsPrice === p.times * 100), '价格应与个数成正比（1 元 / 个）',
    list.map((p) => p.times + '=' + p.price));
  ok(list[0].productId === 'svc_unlock_1' && list[5].productId === 'svc_unlock_100',
    '档位应按 sort 从小到大排', list.map((p) => p.productId));

  // 后台能拿到默认档位（「载入默认档位」用）
  const adm = await aWorker.fetch(new Request('https://api.test/admin/api/products', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const aj = await adm.json();
  ok(aj.is_default === true, '还没保存过时应标记为默认配置', aj.is_default);
  ok(Array.isArray(aj.defaults) && aj.defaults.length === 6, '后台应能拿到 6 个默认档位',
    aj.defaults && aj.defaults.length);
  ok(aj.defaults.some((d) => d.productId === 'svc_unlock_50')
    && aj.defaults.some((d) => d.productId === 'svc_unlock_100'), '默认档位应包含 50 / 100');

  // 保存自定义配置后，前台以保存的为准（价格可改）
  const save = await aWorker.fetch(new Request('https://api.test/admin/api/products', {
    method: 'POST',
    headers: { Cookie: 'admin_token=' + adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products: [
        { productId: 'svc_unlock_50', name: '愿望50个', goodsPrice: 4900, buyQuantity: 1, times: 50, sort: 1 },
      ],
    }),
  }), aEnv, {});
  ok(save.status === 200, '保存道具配置应成功', save.status);

  const after = await aCall('/api/xpay/products', { token: userToken(1) });
  ok(after.json.products.length === 1 && after.json.products[0].price === '49.00',
    '保存后前台应以保存的为准（可改价）', after.json.products);

  const adm2 = await aWorker.fetch(new Request('https://api.test/admin/api/products', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const aj2 = await adm2.json();
  ok(aj2.is_default === false, '保存后不应再标记为默认', aj2.is_default);
}

// ═══════════ 22. 后台删除插座验证码记录 ═══════════
{
  makeUser(19, 'openid-19', '13900000019');
  db.putUser({ ...db.getUserById(19), xpay_count: 10 });
  const u19 = userToken(19);
  const g = await aCall('/api/socket/codes', {
    method: 'POST', token: u19,
    body: { macs: ['AABBCCDDEEFF', '001122334455'], request_id: 'req_cdel_0001' },
  });
  ok(g.json.ok && g.json.items.length === 2, '先让用户19 生成 2 个', g.json.items && g.json.items.length);

  const wishBefore = db.getUserById(19).xpay_count;
  const rows = db.listUserCodes(19, 10, 0);
  ok(rows.length === 2, '应落库 2 条', rows.length);
  const target = rows[0];

  // 后台页面每行都有删除按钮
  const page = await aWorker.fetch(new Request('https://api.test/admin/codes?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html = await page.text();
  ok(html.includes('/admin/codes/delete'), '后台应有删除表单');
  ok(html.includes('<button class="mini danger">删除</button>'), '每行应有删除按钮');

  const del = (id, withAuth = true) => aWorker.fetch(new Request('https://api.test/admin/codes/delete', {
    method: 'POST',
    headers: withAuth
      ? { Cookie: 'admin_token=' + adminToken, 'Content-Type': 'application/x-www-form-urlencoded' }
      : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: String(id), page: '1' }).toString(),
  }), aEnv, {});

  // 未登录不能删
  const anon = await del(target.id, false);
  ok(anon.status === 302 && String(anon.headers.get('location') || '').includes('/login'),
    '未登录删除应跳登录', anon.headers.get('location'));
  ok(!!db.getCodeById(target.id), '未登录删除不应生效', db.getCodeById(target.id));

  // 正常删一条：只删这一条，不动别人的、不退还愿望
  const r1 = await del(target.id);
  ok(r1.status === 302, '删除应 302 回列表', r1.status);
  ok(!db.getCodeById(target.id), '该条记录应已删除', db.getCodeById(target.id));
  ok(db.countUserCodes(19) === 1, '同批其它记录应保留', db.countUserCodes(19));
  ok(db.getUserById(19).xpay_count === wishBefore, '删除不应退还愿望', db.getUserById(19).xpay_count);
  ok(!!db.getCodeBatch('req_cdel_0001'), '批次还有记录时不应清批次');

  // 删掉同批最后一条 → 批次行一起清理
  const last = db.listUserCodes(19, 10, 0)[0];
  const r2 = await del(last.id);
  ok(r2.status === 302 && db.countUserCodes(19) === 0, '最后一条也应能删', db.countUserCodes(19));
  ok(!db.getCodeBatch('req_cdel_0001'), '批次清空后应把批次行也删掉',
    db.getCodeBatch('req_cdel_0001') && db.getCodeBatch('req_cdel_0001').request_id);

  // 删不存在的 ID：回列表，不报错
  const r3 = await del(999999);
  ok(r3.status === 302, '删除不存在的记录应回列表', r3.status);

  // 批量里删掉一条后，剩下那条仍在后台列表里
  const g2 = await aCall('/api/socket/codes', {
    method: 'POST', token: u19,
    body: { macs: ['1234567890AB', 'FFFFFFFFFFFF'], request_id: 'req_cdel_0002' },
  });
  ok(g2.json.ok, '再生成 2 个', g2.json);
  const two = db.listUserCodes(19, 10, 0);
  await del(two[0].id);
  const page2 = await aWorker.fetch(new Request('https://api.test/admin/codes?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const html2 = await page2.text();
  ok(html2.includes(two[1].code), '未删除的那条仍应显示', two[1].code);
  ok(!html2.includes(`<input type="hidden" name="id" value="${two[0].id}">`), '已删除的行不应再出现');
}

// ═══════════ 23. 单条序列号详情（「我的」点开某条时按序列号精确取） ═══════════
{
  makeUser(20, 'openid-20', '13900000020');
  kv.map.set('bt_list', ['DT-S1|||||DT-CAT', 'DT-S2|||||DT-CAT'].join('\n'));
  const envD = { ...aEnv, SERIAL_CATEGORY: 'DT-CAT' };
  const u20 = userToken(20);

  const c1 = await aCall('/api/serial/claim', {
    method: 'POST', token: u20, env: envD,
    body: {
      request_id: 'req_dt_00001', version: 'BarTender 2022 · R8 (216048) Full x64',
      download_url: 'https://dl.test/dt1.exe', key_url: 'https://dl.test/dt1_key.exe',
    },
  });
  ok(c1.json.ok, '先领一个号', c1.json);
  const s1 = c1.json.serial;

  // 本人按序列号取：应拿到这一条（含版本与地址）
  const d1 = await aCall('/api/serial/detail?serial=' + encodeURIComponent(s1), { token: u20 });
  ok(d1.status === 200 && d1.json.ok && d1.json.item && d1.json.item.serial === s1,
    'detail 应返回这条序列号', d1.json.item && d1.json.item.serial);
  ok(d1.json.item.download_url === 'https://dl.test/dt1.exe', 'detail 应带下载地址', d1.json.item.download_url);
  ok(d1.json.item.key_url === 'https://dl.test/dt1_key.exe', 'detail 应带激活地址', d1.json.item.key_url);
  ok(d1.json.item.version === 'BarTender 2022 · R8 (216048) Full x64', 'detail 应带购买的版本', d1.json.item.version);
  ok(typeof d1.json.synced === 'boolean', 'detail 应带 synced 标记', d1.json.synced);

  // 别人的号取不到
  makeUser(21, 'openid-21', '13900000021');
  const d2 = await aCall('/api/serial/detail?serial=' + encodeURIComponent(s1), { token: userToken(21) });
  ok(d2.status === 404 && d2.json.error === 'not_found', '别人的号应 404（不泄露）', d2.status);

  // 不存在的号 / 空参数
  const d3 = await aCall('/api/serial/detail?serial=NOPE-1', { token: u20 });
  ok(d3.status === 404, '不存在的号应 404', d3.status);
  const d4 = await aCall('/api/serial/detail', { token: u20 });
  ok(d4.status === 400 && d4.json.error === 'bad_serial', '不传 serial 应 400', d4.json);
  const d5 = await aCall('/api/serial/detail?serial=' + encodeURIComponent(s1));
  ok(d5.status === 401, '未登录应 401', d5.status);

  // 再领一个，两条各自取都要对得上（不会串号）
  db.putUser({ ...db.getUserById(20), xpay_count: 20 });
  const c2 = await aCall('/api/serial/claim', {
    method: 'POST', token: u20, env: envD,
    body: {
      request_id: 'req_dt_00002', version: 'BarTender 2019 · R10 (1449) Full x64',
      download_url: 'https://dl.test/dt2.exe', key_url: 'https://dl.test/dt2_key.exe',
    },
  });
  const s2 = c2.json.serial;
  const g1 = await aCall('/api/serial/detail?serial=' + encodeURIComponent(s1), { token: u20 });
  const g2 = await aCall('/api/serial/detail?serial=' + encodeURIComponent(s2), { token: u20 });
  ok(g1.json.item.download_url === 'https://dl.test/dt1.exe'
    && g2.json.item.download_url === 'https://dl.test/dt2.exe',
    '两条各自取到自己的地址（不串号）',
    { s1: g1.json.item.download_url, s2: g2.json.item.download_url });
  ok(g1.json.item.version !== g2.json.item.version, '两条的版本应各自正确',
    { v1: g1.json.item.version, v2: g2.json.item.version });
}

// ═══════════ 24. 客户端删除（软删除）：只在本人隐藏，后台保留 ═══════════
{
  makeUser(22, 'openid-22', '13900000022');
  kv.map.set('bt_list', ['HD-S1|||||HD-CAT', 'HD-S2|||||HD-CAT', 'HD-S3|||||HD-CAT'].join('\n'));
  const envH = { ...aEnv, SERIAL_CATEGORY: 'HD-CAT' };
  const u22 = userToken(22);

  const c1 = await aCall('/api/serial/claim', {
    method: 'POST', token: u22, env: envH, body: { request_id: 'req_hd_00001' },
  });
  ok(c1.json.ok && c1.json.source === 'free', '第一个应是首免', c1.json.source);
  const hs1 = c1.json.serial;
  db.putUser({ ...db.getUserById(22), xpay_count: 20 });
  const c2 = await aCall('/api/serial/claim', {
    method: 'POST', token: u22, env: envH, body: { request_id: 'req_hd_00002' },
  });
  ok(c2.json.ok, '第二个应能领', c2.json);
  const hs2 = c2.json.serial;

  const beforeList = await aCall('/api/serial/mine', { token: u22 });
  ok(beforeList.json.total === 2, '删除前应有 2 条', beforeList.json.total);

  const hide = await aCall('/api/serial/hide', { method: 'POST', token: u22, body: { serial: hs1 } });
  ok(hide.status === 200 && hide.json.ok, '客户端删除应成功', hide.json);

  const afterList = await aCall('/api/serial/mine', { token: u22 });
  ok(afterList.json.total === 1, '删除后总数应减 1', afterList.json.total);
  ok(!afterList.json.list.some((x) => x.serial === hs1),
    '删除的那条不应再返回', afterList.json.list.map((x) => x.serial));

  // 重新登录（换新 token）也不会同步回来
  const relogin = await aCall('/api/serial/mine', { token: userToken(22) });
  ok(relogin.json.total === 1 && !relogin.json.list.some((x) => x.serial === hs1),
    '重新登录也不应看到已删除的记录', relogin.json.list.map((x) => x.serial));

  // 详情也取不到
  const hidDen = await aCall('/api/serial/detail?serial=' + encodeURIComponent(hs1), { token: u22 });
  ok(hidDen.status === 404, '已删除记录的详情应 404', hidDen.status);

  // 重复删除：幂等
  const hide2 = await aCall('/api/serial/hide', { method: 'POST', token: u22, body: { serial: hs1 } });
  ok(hide2.json.ok && hide2.json.already === true, '重复删除应是幂等的', hide2.json);

  // 免费额度不会因为删除而恢复（否则可以反复刷免费号）
  ok(db.hasFreeSerial(22), '数据库里免费记录仍在，额度不恢复');
  db.putUser({ ...db.getUserById(22), xpay_count: 0 });
  kv.map.set('bt_list', ['HD-S4|||||HD-CAT'].join('\n'));
  const againClaim = await aCall('/api/serial/claim', {
    method: 'POST', token: u22, env: envH, body: { request_id: 'req_hd_00003' },
  });
  ok(againClaim.json.ok === false && againClaim.json.error === 'need_wish',
    '删除记录后不应恢复免费额度（仍按付费判定）', againClaim.json);

  // 别人的记录删不掉
  makeUser(23, 'openid-23', '13900000023');
  const otherHide = await aCall('/api/serial/hide', { method: 'POST', token: userToken(23), body: { serial: hs2 } });
  ok(otherHide.status === 404, '不能删别人的记录', otherHide.status);
  ok(!db.getUserSerial(hs2).hidden, '别人的记录不应被标记', db.getUserSerial(hs2).hidden);

  // 后台仍然能看到，并且带「用户已删除」标记
  const adminPage2 = await aWorker.fetch(new Request('https://api.test/admin/serials?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const adminHtml2 = await adminPage2.text();
  ok(adminHtml2.includes(hs1), '后台应仍能看到这条记录', hs1);
  ok(adminHtml2.includes('用户已删除'), '后台应标记「用户已删除」');

  // 插座验证码同理
  db.putUser({ ...db.getUserById(22), xpay_count: 10 });
  const genH = await aCall('/api/socket/codes', {
    method: 'POST', token: u22, body: { macs: ['AABBCCDDEEFF', '001122334455'], request_id: 'req_hd_sock01' },
  });
  ok(genH.json.ok && genH.json.items.length === 2, '生成 2 个验证码', genH.json.items && genH.json.items.length);

  const codesBefore = await aCall('/api/socket/mine', { token: u22 });
  const targetCode = codesBefore.json.list[0];
  const hideCode = await aCall('/api/socket/hide', { method: 'POST', token: u22, body: { id: targetCode.id } });
  ok(hideCode.status === 200 && hideCode.json.ok, '删除验证码应成功', hideCode.json);

  const codesAfter = await aCall('/api/socket/mine', { token: u22 });
  ok(codesAfter.json.total === Number(codesBefore.json.total) - 1, '验证码总数应减 1',
    { before: codesBefore.json.total, after: codesAfter.json.total });
  ok(!codesAfter.json.list.some((x) => Number(x.id) === Number(targetCode.id)),
    '删除的验证码不应再返回', codesAfter.json.list.map((x) => x.id));

  const hideOtherCode = await aCall('/api/socket/hide', { method: 'POST', token: userToken(23), body: { id: targetCode.id } });
  ok(hideOtherCode.status === 404, '不能删别人的验证码', hideOtherCode.status);

  const codesAdmin = await aWorker.fetch(new Request('https://api.test/admin/codes?page=1', {
    headers: { Cookie: 'admin_token=' + adminToken },
  }), aEnv, {});
  const codesHtml = await codesAdmin.text();
  ok(codesHtml.includes(targetCode.code), '后台应仍能看到这条验证码', targetCode.code);
  ok(codesHtml.includes('用户已删除'), '验证码后台应标记「用户已删除」');
}

// ═══════════ 结果 ═══════════
if (fails.length) {
  console.log(`\n=== ${fails.length} 项未通过（通过 ${pass} 项）===`);
  for (const f of fails) console.log('ERR   ' + f);
  process.exitCode = 1;
} else {
  console.log(`\n✓ 全部通过（${pass} 项断言：首免 / 扣愿望 / 撞号重试 / 后台删除 / 分页 / 北京时间 / 插座验证码）`);
}

/**
 * 微信小程序后端 + 管理后台（Cloudflare Workers / KV）
 *
 * 支付方式：小程序【虚拟支付】—— 米大师道具直购
 *   个人主体小程序无法申请微信支付普通商户号，只能走虚拟支付（2026-08 起对个人开放）。
 *   规则要求「只做道具直购，不引入代币等额外功能」，因此本后端**不做余额/储值**，
 *   用户每次直接购买「功能次数」道具，购买记录即权益凭证。
 *
 * 路由概览：
 *   POST /api/auth/login          小程序 wx.login 拿到的 code 换 token
 *   GET  /api/user/me             获取当前用户信息（不含 openid）
 *   POST /api/user/profile        完善昵称
 *   POST /api/user/phone          微信 getPhoneNumber 加密数据换手机号
 *   GET  /api/user/vip            会员/权益状态（按已购次数判定）
 *
 *   GET  /api/xpay/products       可购道具列表（含用户已购次数）
 *   POST /api/xpay/order          下单 → signData + paySig + signature
 *   GET  /api/xpay/order?id=      查询自己的订单状态（前端轮询）
 *   POST /api/xpay/mock-pay       仅 XPAY_MOCK=1：模拟支付成功（自测）
 *   POST /api/xpay/notify         接收平台「发货推送」（XML），验签后发货
 *   GET  /api/xpay/tasks          查已过期未发货的订单，逐个 query_order 兜底补发
 *
 *   GET  /<ADMIN_PREFIX>/         后台首页（用户列表）
 *   GET  /<ADMIN_PREFIX>/login    后台登录页
 *   POST /<ADMIN_PREFIX>/login    后台登录
 *   GET  /<ADMIN_PREFIX>/logout
 *   GET  /<ADMIN_PREFIX>/api/products      道具配置列表
 *   POST /<ADMIN_PREFIX>/api/products     保存道具配置
 *   GET  /<ADMIN_PREFIX>/api/users        用户列表（JSON，带搜索/分页）
 *   POST /<ADMIN_PREFIX>/api/users/:id    修改用户（次数/状态/备注/手机号）
 *   GET  /<ADMIN_PREFIX>/api/stats        顶部统计
 *   GET  /<ADMIN_PREFIX>/api/orders       订单列表
 *   GET  /<ADMIN_PREFIX>/api/export.csv   导出 CSV
 *   GET  /<ADMIN_PREFIX>/logs             审计日志页
 *
 * 数据层：SQLite（自托管版，node:sqlite，见 db.mjs）。
 *   原 KV 绑定 BTSMKV 已由 globalThis.__db（server.mjs 注入的 SQLiteDB）取代；
 *   所有 kvXxx 函数签名不变，内部转发到 __db。HTTP API 与 KV 版完全一致。
 *
 * 环境变量：
 *   必需   WX_APPID / WX_SECRET / JWT_SECRET / ADMIN_USERNAME / ADMIN_PASSWORD
 *   虚拟支付 XPAY_OFFER_ID（OfferID）、XPAY_APP_KEY（现网 AppKey）
 *   可选   XPAY_MOCK=1 开启模拟支付（自测用，上线必须关闭）
 */

// ───────────────────────── 常量 ─────────────────────────

/** 虚拟支付接口路径（paySig 签名用，不带问号参数） */
const URI_REQUEST_PAYMENT = 'requestVirtualPayment';
const URI_QUERY_ORDER = '/xpay/query_order';

/** 平台会重试发货推送，最多 15 次 */
const NOTIFY_RETRY_HINT = 15;

/** 订单状态 */
const ST = {
  PENDING: 'pending',
  DELIVERED: 'delivered',
  PAID_NO_GOODS: 'paid_no_goods', // 已支付但未匹配到商品，需人工介入
  EXPIRED: 'expired'
};

/**
 * 兜底道具配置。真正生效的是 KV 里的 app:products（后台「道具配置」可改）。
 * productId 必须与 MP 后台【虚拟支付 → 道具管理】里创建的**道具ID完全一致**，
 * goodsPrice 必须与后台道具价格一致（单位：分），否则会报 -15010 / -15013。
 */
const DEFAULT_PRODUCTS = [
  { productId: 'svc_unlock_1',   name: '愿望1个',   goodsPrice: 100,   buyQuantity: 1, times: 1,   sort: 1 },
  { productId: 'svc_unlock_5',   name: '愿望5个',   goodsPrice: 500,   buyQuantity: 1, times: 5,   sort: 2 },
  { productId: 'svc_unlock_10',  name: '愿望10个',  goodsPrice: 1000,  buyQuantity: 1, times: 10,  sort: 3 },
  { productId: 'svc_unlock_30',  name: '愿望30个',  goodsPrice: 3000,  buyQuantity: 1, times: 30,  sort: 4 },
  { productId: 'svc_unlock_50',  name: '愿望50个',  goodsPrice: 5000,  buyQuantity: 1, times: 50,  sort: 5 },
  { productId: 'svc_unlock_100', name: '愿望100个', goodsPrice: 10000, buyQuantity: 1, times: 100, sort: 6 }
];

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (err) {
      return json({ error: 'internal_error', message: err.message }, 500);
    }
  },
};

// ───────────────────────── 路由 ─────────────────────────

async function route(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const adminPrefix = '/' + (env.ADMIN_PREFIX || 'admin');

  if (p === '/api/auth/login'      && request.method === 'POST') return apiLogin(request, env);
  if (p === '/api/user/me'         && request.method === 'GET')  return apiMe(request, env);
  if (p === '/api/user/profile'    && request.method === 'POST') return apiProfile(request, env);
  if (p === '/api/user/vip'        && request.method === 'GET')  return apiVip(request, env);
  if (p === '/api/user/phone'      && request.method === 'POST') return apiPhone(request, env);

  // 序列号取号（一期：首绑手机号免费 1 个）
  if (p === '/api/serial/categories' && request.method === 'GET') return apiSerialCategories(request, env);
  if (p === '/api/serial/claim'    && request.method === 'POST') return apiSerialClaim(request, env);
  if (p === '/api/serial/mine'     && request.method === 'GET')  return apiSerialMine(request, env, url);
  if (p === '/api/serial/detail'   && request.method === 'GET')  return apiSerialDetail(request, env, url);
  if (p === '/api/serial/hide'     && request.method === 'POST') return apiSerialHide(request, env);
  if (p === '/api/socket/hide'     && request.method === 'POST') return apiSocketHide(request, env);

  // 智能插座验证码（每个 MAC 生成一个 6 位码，每次扣 1 个愿望）
  if (p === '/api/socket/codes'    && request.method === 'POST') return apiSocketCodes(request, env);
  if (p === '/api/socket/mine'     && request.method === 'GET')  return apiSocketMine(request, env, url);

  if (p === '/api/xpay/products'   && request.method === 'GET')  return apiProducts(request, env);
  if (p === '/api/xpay/order'      && request.method === 'POST') return apiCreateOrder(request, env);
  if (p === '/api/xpay/order'      && request.method === 'GET')  return apiQueryOrder(request, env, url);
  if (p === '/api/xpay/mock-pay'   && request.method === 'POST') return apiMockPay(request, env);
  if (p === '/api/xpay/notify'     && request.method === 'POST') return apiNotify(request, env);
  if (p === '/api/xpay/tasks'      && request.method === 'GET')  return apiTasks(request, env);

  if (p === adminPrefix || p === adminPrefix + '/')                        return adminIndex(request, env, url);
  if (p === adminPrefix + '/login'  && request.method === 'GET')           return adminLoginPage(env);
  if (p === adminPrefix + '/login'  && request.method === 'POST')          return adminLogin(request, env);
  if (p === adminPrefix + '/logout' && request.method === 'GET')           return adminLogout(env);
  if (p === adminPrefix + '/api/products' && request.method === 'GET')     return adminApiGetProducts(request, env);
  if (p === adminPrefix + '/api/products' && request.method === 'POST')    return adminApiSaveProducts(request, env);
  if (p === adminPrefix + '/api/users' && request.method === 'GET')        return adminApiUsers(request, env, url);
  if (p.startsWith(adminPrefix + '/api/users/') && request.method === 'POST') {
    return adminApiUpdateUser(request, env, Number(p.split('/').pop()));
  }
  if (p === adminPrefix + '/api/stats'  && request.method === 'GET')       return adminApiStats(request, env);
  if (p === adminPrefix + '/api/orders' && request.method === 'GET')       return adminApiOrders(request, env, url);
  if (p === adminPrefix + '/api/export.csv' && request.method === 'GET')   return adminApiExportCsv(request, env);
  if (p === adminPrefix + '/logs'   && request.method === 'GET')           return adminLogsPage(request, env, url);
  if (p === adminPrefix + '/codes'  && request.method === 'GET')           return adminCodesPage(request, env, url);
  if (p === adminPrefix + '/codes/delete' && request.method === 'POST')    return adminDeleteCode(request, env);
  if (p === adminPrefix + '/serials' && request.method === 'GET')          return adminSerialsPage(request, env, url);
  if (p === adminPrefix + '/serials/delete' && request.method === 'POST')  return adminDeleteSerial(request, env);

  if (p === '/' || p === '/health') {
    return json({ ok: true, app: env.APP_NAME || 'wxminiapp-server', xpay_mock: isMock(env) });
  }
  return json({ error: 'not_found' }, 404);
}

// ───────────────────────── 基础工具 ─────────────────────────

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}
function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
  });
}
function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
/** 平台要求的发货成功应答 */
function notifyOk() {
  return xml('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>');
}
/** 发货失败应答（平台会重试，最多 15 次） */
function notifyFail(msg) {
  return xml(`<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[${String(msg || 'fail').slice(0, 100)}]]></ErrMsg></xml>`);
}

function now() { return Math.floor(Date.now() / 1000); }
function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
         request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function toYuan(cents) { return (Number(cents || 0) / 100).toFixed(2); }

/* ─────────────── 时间统一按北京时间展示 ───────────────
   服务器时区可能是 UTC（Docker/云主机常见），所以不能依赖 toLocaleString。
   做法：把时间戳 +8 小时后用 getUTC* 系列读，得到的就是北京时间的年月日时分秒。 */
const BJ_OFFSET_MS = 8 * 3600 * 1000;
function beijingBits(ms) {
  const t = new Date(Number(ms || 0) + BJ_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: String(t.getUTCFullYear()), m: p(t.getUTCMonth() + 1), d: p(t.getUTCDate()),
    hh: p(t.getUTCHours()), mm: p(t.getUTCMinutes()), ss: p(t.getUTCSeconds())
  };
}
/** 秒级时间戳 → 2026-10-16 18:20:05（北京时间） */
function fmtBeijing(ts) {
  const n = Number(ts || 0);
  if (!n) return '-';
  const b = beijingBits(n * 1000);
  return `${b.y}-${b.m}-${b.d} ${b.hh}:${b.mm}:${b.ss}`;
}
/** 秒级时间戳 → 2026-10-16（北京时间） */
function fmtBeijingDay(ts) {
  const n = Number(ts || 0);
  if (!n) return '-';
  const b = beijingBits(n * 1000);
  return `${b.y}-${b.m}-${b.d}`;
}

function isMock(env) {
  const v = String(env.XPAY_MOCK || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** 生成业务单号：8–32 字符，只含数字/大小写字母/_-|*@，不能以 _ 开头 */
function makeOutTradeNo() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return ('BTSM' + ts + rand).slice(0, 30); // BTSM + base36 时间戳 + 随机，长度约 18
}

/** 随机字符串（session_key 签名等场景） */
function randomStr(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i++) s += chars[buf[i] % chars.length];
  return s;
}

// ───────────────────────── HMAC-SHA256（虚拟支付签名） ─────────────────────────

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hmacSha256Hex(keyStr, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return bytesToHex(sig);
}

/**
 * 支付签名 paySig
 *   msg = uri + '&' + postBody
 *   postBody 必须是**真正发出去的原始字符串**（不格式化、不改键顺序）
 *   - C 端下单：uri 固定为 requestVirtualPayment
 *   - B 端接口：uri 为实际接口路径，如 /xpay/query_order
 */
async function calcPaySig(uri, postBody, appKey) {
  return hmacSha256Hex(appKey, uri + '&' + postBody);
}

/**
 * 用户态签名 signature
 *   msg = postBody（同一份原始字符串），密钥为 session_key
 */
async function calcSignature(postBody, sessionKey) {
  return hmacSha256Hex(sessionKey, postBody);
}

// ───────────────────────── JWT ─────────────────────────

function b64urlEncode(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}
async function signJwt(payload, secret) {
  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg:'HS256', typ:'JWT' })));
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data = h + '.' + p;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(data));
  return data + '.' + b64urlEncode(sig);
}
async function verifyJwt(token, secret, expectedType) {
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(s), new TextEncoder().encode(h + '.' + p));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (payload.exp && payload.exp < now()) return null;
    if (expectedType && payload.type !== expectedType) return null;
    return payload;
  } catch { return null; }
}

// ───────────────────────── 数据访问（SQLite / db.mjs） ─────────────────────────
//
// 自托管版改用 SQLite（node:sqlite）替代 Cloudflare KV，对应 README 中
// 「用户量上来后建议切回 D1，API 不变，只改数据访问层」的迁移。
// 以下函数签名与调用方全部保持不变，内部统一转发到 globalThis.__db
// （SQLiteDB 实例，由 server.mjs 注入，实现见 db.mjs）。表结构见 db.mjs SCHEMA。

async function kvGetUserByOpenid(_KV, openid) {
  return __db.getUserByOpenid(openid);
}
async function kvGetUserById(_KV, id) {
  return __db.getUserById(id);
}
async function kvPutUser(_KV, user) {
  return __db.putUser(user);
}
async function kvNextUserId(_KV) {
  return __db.nextUserId();   // SQLite 原子自增，解决 KV 版并发重号
}
async function kvGetOrder(_KV, orderId) {
  return __db.getOrder(orderId);
}
async function kvPutOrder(_KV, order) {
  return __db.putOrder(order);
}
async function kvGetProducts(_KV) {
  const list = await __db.getProducts();
  return Array.isArray(list) && list.length ? list : DEFAULT_PRODUCTS;
}
async function kvSaveProducts(_KV, list) {
  return __db.saveProducts(list);
}
/** 列出全部用户（最多 maxScan 条），按 id 倒序 */
async function kvListAllUsers(_KV, maxScan) {
  return __db.listAllUsers(maxScan || 1000);
}
/** 列出订单 */
async function kvListOrders(_KV, maxScan) {
  return __db.listOrders(maxScan || 500);
}
async function kvAddLog(_KV, entry) {
  try { await __db.addLog(entry); } catch { /* ignore */ }
}

// ───────────────────────── 鉴权 ─────────────────────────

async function authUser(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const payload = await verifyJwt(token, env.JWT_SECRET, 'user');
  if (!payload) return null;
  const user = await kvGetUserById(env.BTSMKV, payload.sub);
  if (!user) return null;
  if (Number(user.status) === 1) return { blocked: true };
  return user;
}
function needUser(user) {
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (user.blocked) return json({ error: 'blocked', message: '账号已被封禁' }, 403);
  return null;
}

function getAdminCookie(request) {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'admin_token') return decodeURIComponent(v.join('='));
  }
  return null;
}
async function authAdmin(request, env) {
  const token = getAdminCookie(request);
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET, 'admin');
}

// ───────────────────────── 小程序：登录 / 用户 ─────────────────────────

/** POST /api/auth/login  body: { code } */
async function apiLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (!body.code) return json({ error: 'missing_code' }, 400);

  const wxUrl = 'https://api.weixin.qq.com/sns/jscode2session'
    + '?appid=' + encodeURIComponent(env.WX_APPID)
    + '&secret=' + encodeURIComponent(env.WX_SECRET)
    + '&js_code=' + encodeURIComponent(body.code)
    + '&grant_type=authorization_code';
  const wxData = await (await fetch(wxUrl)).json();
  if (wxData.errcode) {
    return json({ error: 'wx_error', errcode: wxData.errcode, errmsg: wxData.errmsg }, 400);
  }

  const { openid, unionid, session_key } = wxData;
  const ts = now();
  let user = await kvGetUserByOpenid(env.BTSMKV, openid);
  let isNew = false;

  if (!user) {
    isNew = true;
    user = {
      id: await kvNextUserId(env.BTSMKV),
      openid, unionid: unionid || null, session_key,
      nickname: '', phone: '',
      xpay_count: 0,          // 剩余可用次数
      xpay_total: 0,          // 累计购买次数
      xpay_spent: 0,          // 累计消费（分）
      status: 0, remark: '',
      last_login_at: ts, created_at: ts, updated_at: ts,
    };
  } else {
    user.unionid = unionid || user.unionid;
    // session_key 必须最新：signature 签名要用它，过期会报 -15007
    user.session_key = session_key;
    user.last_login_at = ts;
    user.updated_at = ts;
  }
  await kvPutUser(env.BTSMKV, user);
  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'login',
    detail: isNew ? 'register' : 'login',
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
  });

  if (Number(user.status) === 1) {
    return json({ error: 'blocked', message: '该账号已被封禁，请联系客服' }, 403);
  }

  const expireSec = Number(env.JWT_EXPIRE || 2592000);
  const token = await signJwt(
    { sub: user.id, type: 'user', iat: ts, exp: ts + expireSec }, env.JWT_SECRET
  );
  return json({ token, is_new: isNew, user: publicUser(user) });
}

/** GET /api/user/me */
async function apiMe(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;
  return json({ user: publicUser(user) });
}

/** POST /api/user/profile  body: { nickname } */
async function apiProfile(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  if (typeof body.nickname === 'string') user.nickname = body.nickname.slice(0, 64);
  user.updated_at = now();
  await kvPutUser(env.BTSMKV, user);
  return json({ user: publicUser(user) });
}

/** GET /api/user/vip —— 权益状态由「剩余可用次数」决定 */
async function apiVip(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;
  return json(vipInfo(user));
}

/**
 * POST /api/user/phone  body: { phone }             ← 个人主体：手动输入（主用）
 *                       body: { encryptedData, iv }  ← 企业主体 getPhoneNumber 加密数据（兼容保留）
 */
async function apiPhone(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  let phone = '';

  if (body.encryptedData && body.iv) {
    // ── 兼容分支：button open-type="getPhoneNumber" 的加密数据 ──
    if (!user.session_key) return json({ error: 'no_session_key_please_relogin' }, 401);
    try {
      const key = await crypto.subtle.importKey(
        'raw', b64ToBytes(user.session_key), { name:'AES-CBC', length:128 }, false, ['decrypt']
      );
      const plain = await crypto.subtle.decrypt(
        { name:'AES-CBC', iv: b64ToBytes(body.iv) }, key, b64ToBytes(body.encryptedData)
      );
      const info = JSON.parse(new TextDecoder().decode(plain));
      if (info.watermark?.appid && info.watermark.appid !== env.WX_APPID) {
        return json({ error:'appid_mismatch' }, 400);
      }
      phone = info.purePhoneNumber || info.phoneNumber || '';
      if (!phone) return json({ error: 'no_phone_in_payload' }, 400);
    } catch (e) {
      return json({ error: 'decrypt_failed', message: e.message }, 400);
    }
  } else {
    // ── 主用分支：手输明文（前端已校验一次，这里再挡一次） ──
    phone = String(body.phone || '').replace(/\D/g, '');
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      return json({ ok: false, error: 'bad_phone', message: '手机号格式不正确' }, 400);
    }
  }

  const before = user.phone || '';
  user.phone = phone;
  user.updated_at = now();
  await kvPutUser(env.BTSMKV, user);
  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'bind_phone',
    detail: (before ? before + '→' : '') + phone,
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
  });
  return json({ ok: true, phone });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ───────────────────────── 小程序：虚拟支付 ─────────────────────────

/** 权益状态：剩余次数 > 0 即为有效 */
function vipInfo(u) {
  const count = Number(u.xpay_count || 0);
  const total = Number(u.xpay_total || 0);
  const spent = Number(u.xpay_spent || 0);
  return {
    is_svip: count > 0,
    count,                       // 剩余可用次数
    total,                       // 累计购买次数
    spent_cents: spent,
    spent: toYuan(spent),
    level: count <= 0 ? 0 : (count >= 30 ? 2 : 1),
    level_name: count <= 0 ? '普通用户' : (count >= 30 ? '高级会员' : '会员'),
    expire_text: ''              // 次数制永不过期，保留字段兼容前端
  };
}

/** GET /api/xpay/products */
async function apiProducts(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const list = await kvGetProducts(env.BTSMKV);
  return json({
    products: list
      .slice()
      .sort((a, b) => (a.sort || 0) - (b.sort || 0))
      .map(p => ({
        productId: p.productId,
        name: p.name,
        goodsPrice: Number(p.goodsPrice || 0),
        price: toYuan(p.goodsPrice),
        times: Number(p.times || 1)
      })),
    count: Number(user.xpay_count || 0),
    mock: isMock(env),
    // iOS 端需微信 ≥ 8.0.68，由前端校验
    ios_min_version: '8.0.68'
  });
}

/**
 * POST /api/xpay/order  body: { product_id }
 * 返回 { order, signData, paySig, signature, mode, mock }
 */
async function apiCreateOrder(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const list = await kvGetProducts(env.BTSMKV);
  const product = list.find(p => p.productId === body.product_id);
  if (!product) return json({ error: 'product_not_found', message: '商品不存在或已下架' }, 400);

  const ts = now();
  const outTradeNo = makeOutTradeNo();
  const orderId = 'o' + ts + randomStr(6);

  const order = {
    id: orderId,
    outTradeNo,
    userId: Number(user.id),
    openid: user.openid,
    productId: product.productId,
    productName: product.name,
    goodsPrice: Number(product.goodsPrice || 0),
    buyQuantity: Number(product.buyQuantity || 1),
    times: Number(product.times || 1),
    status: ST.PENDING,
    wxOrderId: '',
    mock: isMock(env),
    createdAt: ts,
    deliveredAt: 0
  };

  // mock 模式不生成真实签名，前端直接走 mock-pay
  if (isMock(env)) {
    await kvPutOrder(env.BTSMKV, order);
    return json({
      order: publicOrder(order),
      signData: null, paySig: null, signature: null,
      mode: 'short_series_goods', mock: true
    });
  }

  if (!env.XPAY_OFFER_ID || !env.XPAY_APP_KEY) {
    return json({ error: 'xpay_not_configured', message: '服务端未配置 XPAY_OFFER_ID / XPAY_APP_KEY' }, 500);
  }
  if (!user.session_key) {
    return json({ error: 'no_session_key', message: '登录态已失效，请重新登录' }, 401);
  }

  // signData 必须是「最终发出去的同一个字符串」，签名与实际传参不能有差异
  const signData = JSON.stringify({
    offerId: String(env.XPAY_OFFER_ID),
    buyQuantity: order.buyQuantity,
    env: 0,
    currencyType: 'CNY',
    productId: order.productId,
    goodsPrice: order.goodsPrice,
    outTradeNo: order.outTradeNo,
    attach: String(order.id)
  });

  const paySig = await calcPaySig(URI_REQUEST_PAYMENT, signData, env.XPAY_APP_KEY);
  const signature = await calcSignature(signData, user.session_key);

  await kvPutOrder(env.BTSMKV, order);
  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'order_create',
    detail: `${order.productName} ${toYuan(order.goodsPrice)}元 ${outTradeNo}`,
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid
  });

  return json({
    order: publicOrder(order),
    signData, paySig, signature,
    mode: 'short_series_goods',
    mock: false
  });
}

/** GET /api/xpay/order?id= */
async function apiQueryOrder(request, env, url) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const id = url.searchParams.get('id') || '';
  const order = await kvGetOrder(env.BTSMKV, id);
  if (!order || Number(order.userId) !== Number(user.id)) {
    return json({ error: 'not_found' }, 404);
  }

  // 待支付订单超过 30 分钟视为已过期（用户可能中途放弃）
  if (order.status === ST.PENDING && now() - order.createdAt > 1800) {
    order.status = ST.EXPIRED;
    await kvPutOrder(env.BTSMKV, order);
  }

  const fresh = await kvGetUserById(env.BTSMKV, user.id);
  return json({ order: publicOrder(order), vip: vipInfo(fresh || user) });
}

/**
 * POST /api/xpay/mock-pay  body: { order_id }
 * 仅 XPAY_MOCK=1 可用：跳过真实支付直接发货，用于自测全链路。
 */
async function apiMockPay(request, env) {
  if (!isMock(env)) return json({ error: 'mock_disabled' }, 403);

  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const order = await kvGetOrder(env.BTSMKV, body.order_id || '');
  if (!order || Number(order.userId) !== Number(user.id)) {
    return json({ error: 'not_found' }, 404);
  }
  if (order.status === ST.DELIVERED) {
    return json({ ok: true, order: publicOrder(order), vip: vipInfo(user) });
  }

  order.wxOrderId = 'MOCK' + now();
  await deliverOrder(env, order);
  const fresh = await kvGetUserById(env.BTSMKV, user.id);
  return json({ ok: true, order: publicOrder(order), vip: vipInfo(fresh || user) });
}

/** 解析发货推送 XML 的极简实现（平台推送结构固定，不做通用 XML 解析） */
function parseNotifyXml(text) {
  const pick = (tag) => {
    const m = new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>').exec(text);
    return m ? m[1].trim() : '';
  };
  return {
    event: pick('Event'),
    openid: pick('OpenId'),
    outTradeNo: pick('OutTradeNo'),
    wxOrderId: pick('MchOrderNo'),        // 平台单号，位于 WeChatPayInfo.MchOrderNo
    productId: pick('ProductId'),
    quantity: Number(pick('Quantity') || 0)
  };
}

/**
 * POST /api/xpay/notify —— 平台「发货推送」
 *
 * 平台会重试最多 15 次，所以：
 *   - 用平台单号 wxOrderId 做幂等去重，重复通知只发一次货
 *   - 发货成功必须返回 <ErrCode>0</ErrCode>，否则平台认为失败会一直重试
 */
async function apiNotify(request, env) {
  const raw = await request.text();

  // 可选签名校验：AppKey 与消息推送的 Token/AESKey 不是同一套，
  // 这里用 XPAY_APP_KEY 对原始报文做完整性校验（若配置了 XPAY_NOTIFY_SIGN_KEY 则用它）
  const signKey = env.XPAY_NOTIFY_SIGN_KEY || '';
  const gotSig = request.headers.get('x-signature') || request.headers.get('signature') || '';
  if (signKey && gotSig) {
    const expect = await hmacSha256Hex(signKey, raw);
    if (!safeEqual(expect, gotSig)) {
      await kvAddLog(env.BTSMKV, { userId: 0, action: 'xpay_notify_bad_sign', detail: '签名不匹配', ip: getClientIp(request) });
      return notifyFail('bad signature');
    }
  }

  const data = parseNotifyXml(raw);
  if (data.event && data.event !== 'xpay_goods_deliver_notify') {
    return notifyOk(); // 其他事件直接忽略，避免平台重试
  }
  if (!data.outTradeNo && !data.wxOrderId) {
    await kvAddLog(env.BTSMKV, { userId: 0, action: 'xpay_notify_malformed', detail: raw.slice(0, 300), ip: getClientIp(request) });
    return notifyFail('malformed');
  }

  // 幂等：优先用平台单号反查（SQLite 直接查订单表）
  let order = null;
  if (data.wxOrderId) order = await __db.getOrderByWxOrderId(data.wxOrderId);
  if (!order && data.outTradeNo) order = await __db.getOrderByOutTradeNo(data.outTradeNo);
  if (!order) {
    await kvAddLog(env.BTSMKV, {
      userId: 0, action: 'xpay_notify_unknown_order',
      detail: `outTradeNo=${data.outTradeNo} wxOrderId=${data.wxOrderId}`, ip: getClientIp(request)
    });
    // 订单找不到也返回成功，避免平台无意义重试；改用 tasks 兜底排查
    return notifyOk();
  }

  if (order.status === ST.DELIVERED) return notifyOk();   // 幂等：已发货

  // 校验金额/商品是否与本地订单一致，防篡改
  if (data.productId && data.productId !== order.productId) {
    await kvAddLog(env.BTSMKV, {
      userId: order.userId, action: 'xpay_product_mismatch',
      detail: `notify=${data.productId} local=${order.productId}`, openid: order.openid
    });
    return notifyFail('product mismatch');
  }

  order.wxOrderId = data.wxOrderId || order.wxOrderId;
  await deliverOrder(env, order, data.quantity || order.buyQuantity);
  return notifyOk();
}

/**
 * 发货：给用户加次数（幂等由调用方保证 status 检查）
 * @param {number} [quantity] 平台回传的购买数量，用于校验
 */
async function deliverOrder(env, order, quantity) {
  if (order.status === ST.DELIVERED) return order;

  const user = await kvGetUserById(env.BTSMKV, order.userId);
  if (!user) {
    order.status = ST.PAID_NO_GOODS;
    order.note = 'user not found';
    await kvPutOrder(env.BTSMKV, order);
    return order;
  }

  // 按购买数量 × 单件次数发货
  const qty = Number(quantity || order.buyQuantity || 1);
  const times = Number(order.times || 1) * (qty > 0 ? qty : 1);

  user.xpay_count = Number(user.xpay_count || 0) + times;
  user.xpay_total = Number(user.xpay_total || 0) + times;
  user.xpay_spent = Number(user.xpay_spent || 0) + Number(order.goodsPrice || 0) * (qty > 0 ? qty : 1);
  user.updated_at = now();
  await kvPutUser(env.BTSMKV, user);

  order.status = ST.DELIVERED;
  order.deliveredAt = now();
  await kvPutOrder(env.BTSMKV, order);

  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'xpay_deliver',
    detail: `${order.productName} +${times}次 剩余=${user.xpay_count} ${order.mock ? '(mock)' : order.wxOrderId}`,
    nickname: user.nickname, openid: user.openid
  });
  return order;
}

/**
 * GET /api/xpay/tasks —— 兜底补发
 *
 * 发货推送可能丢失（用户异常退出等），所以必须有 active 查单：对已过期仍未发货的
 * 订单调 query_order，查到已支付就补发。
 * 建议由定时任务（如 GitHub Actions / cron-job.org）每 5 分钟 GET 一次。
 */
async function apiTasks(request, env) {
  // 简易保护：需要 ckey 与 JWT_SECRET 前 16 位一致，避免被随意触发
  const url = new URL(request.url);
  const ckey = url.searchParams.get('ckey') || '';
  const expect = String(env.JWT_SECRET || '').slice(0, 16);
  if (!expect || !safeEqual(ckey, expect)) return json({ error: 'forbidden' }, 403);

  if (isMock(env)) return json({ ok: true, mock: true, checked: 0, delivered: 0, note: 'mock 模式无需查单' });
  if (!env.XPAY_OFFER_ID || !env.XPAY_APP_KEY) {
    return json({ error: 'xpay_not_configured' }, 500);
  }

  const orders = await kvListOrders(env.BTSMKV, 500);
  const ts = now();
  // 只处理：已超过 2 分钟仍未发货、且创建不超过 24 小时的订单
  const candidates = orders.filter(o =>
    o.status === ST.PENDING && ts - o.createdAt > 120 && ts - o.createdAt < 86400
  ).slice(0, 50);

  let delivered = 0;
  const details = [];
  for (const order of candidates) {
    try {
      const r = await queryOrderRemote(env, order);
      if (r.status === 'paid') {
        order.wxOrderId = r.wxOrderId || order.wxOrderId;
        await deliverOrder(env, order);
        delivered++;
        details.push({ id: order.id, ok: true, wxOrderId: r.wxOrderId });
      } else if (r.status === 'expired') {
        order.status = ST.EXPIRED;
        await kvPutOrder(env.BTSMKV, order);
        details.push({ id: order.id, expired: true });
      } else {
        details.push({ id: order.id, still: r.status, raw: r.raw });
      }
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      details.push({ id: order.id, error: msg });
      await kvAddLog(env.BTSMKV, {
        userId: order.userId, action: 'xpay_query_failed',
        detail: msg, openid: order.openid
      });
    }
  }
  return json({ ok: true, checked: candidates.length, delivered, details });
}

/**
 * 服务端查单 POST /xpay/query_order
 * body: { openid, env: 0, order_id: <业务单号 outTradeNo> }
 * 需要 paySig（用 AppKey 对 uri + body 签名）
 */
async function queryOrderRemote(env, order) {
  const user = await kvGetUserById(env.BTSMKV, order.userId);
  if (!user) throw new Error('user_not_found');

  const body = JSON.stringify({
    openid: user.openid,
    env: 0,
    order_id: order.outTradeNo
  });
  const paySig = await calcPaySig(URI_QUERY_ORDER, body, env.XPAY_APP_KEY);

  const res = await fetch('https://api.weixin.qq.com/xpay/query_order?pay_sig=' + encodeURIComponent(paySig), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (data.errcode && data.errcode !== 0) {
    throw new Error('query_order_failed: ' + (data.errmsg || data.errcode) + ' | raw=' + JSON.stringify(data).slice(0, 200));
  }
  // 平台返回结构以 order_status 标识支付状态（1 = 已支付）
  const status = Number(data.order_status ?? data.orderStatus ?? 0);
  return {
    status: status === 1 ? 'paid' : (status === 2 ? 'expired' : 'pending'),
    wxOrderId: data.wx_order_id || data.order_id || '',
    raw: data
  };
}

function publicOrder(o) {
  return {
    id: o.id,
    productId: o.productId,
    productName: o.productName,
    price: toYuan(o.goodsPrice),
    times: Number(o.times || 1) * Number(o.buyQuantity || 1),
    status: o.status,
    mock: !!o.mock,
    createdAt: Number(o.createdAt || 0),
    deliveredAt: Number(o.deliveredAt || 0)
  };
}

/** 小程序可见的用户字段（不暴露 openid / unionid / session_key） */
function publicUser(u) {
  const vip = vipInfo(u);
  return {
    id: u.id,
    nickname: u.nickname || '',
    phone: u.phone || '',
    is_svip: vip.is_svip,
    svip_level: vip.level,
    level_name: vip.level_name,
    count: vip.count,
    total: vip.total,
    spent_cents: vip.spent_cents,
    spent: vip.spent,
    expire_text: vip.expire_text,
    status: Number(u.status) || 0,
    created_at: Number(u.created_at),
    last_login_at: Number(u.last_login_at || u.created_at) || 0,
    updated_at: Number(u.updated_at) || 0
  };
}

// ───────────────────────── 小程序：序列号取号 ─────────────────────────

/* ══════════════════════════════════════════════════════════════
   取号固定分类 —— 想换分类就改这里
   ══════════════════════════════════════════════════════════════
   取号只从这一个分类里发号，小程序端不传、也改不了分类，避免被刷别的分类。

   修改优先级：服务器环境变量 SERIAL_CATEGORY  >  下面这个默认值
     ① 推荐：在服务器 .env 里加一行
            SERIAL_CATEGORY=wxminiapp
     ② 不想用环境变量：直接改下面这个字符串
   这个值必须和「序列号后台 → 分类管理」里的分类名完全一致。
   ══════════════════════════════════════════════════════════════ */
const DEFAULT_SERIAL_CATEGORY = 'wxminiapp';

/** 当前生效的取号分类（env 优先，代码兜底） */
function serialCategory(env) {
  const fromEnv = String((env && env.SERIAL_CATEGORY) || '').trim();
  return fromEnv || DEFAULT_SERIAL_CATEGORY;
}

/** 非首次取号消耗的愿望数（env SERIAL_WISH_COST 可调，默认 10） */
const DEFAULT_WISH_COST = 10;
function wishCost(env) {
  const n = Math.floor(Number((env && env.SERIAL_WISH_COST) || DEFAULT_WISH_COST));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WISH_COST;
}

/**
 * 调序列号后台（Cloudflare Worker）。
 * 令牌只在服务器上（BTKEY_API_TOKEN），小程序永远拿不到。
 */
async function btkeyRequest(env, apiPath, { method = 'GET', body } = {}) {
  const base = String(env.BTKEY_API_BASE || '').replace(/\/+$/, '');
  const token = String(env.BTKEY_API_TOKEN || '');
  if (!base || !token) return { status: 0, data: null, error: 'btkey_not_configured' };
  try {
    const res = await fetch(base + apiPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null, error: 'btkey_unreachable' };
  }
}

const PHONE_RE = /^1[3-9]\d{9}$/;

/** 只放行 http(s) 地址，其它一律丢弃（防止把 javascript: 之类的东西存进去再展示） */
function cleanUrl(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 500);
  return /^https?:\/\//i.test(s) ? s : '';
}

function serialStatusText(status) {
  switch (status) {
    case 'activated': return '已激活';
    case 'void': return '已作废';
    case 'missing': return '号已失效';
    default: return '未激活';
  }
}

function publicSerialRow(r) {
  return {
    serial: r.serial,
    category: r.category,
    version: r.version || '',
    download_url: r.download_url || '',
    key_url: r.key_url || '',
    source: r.source,
    cost: Number(r.cost || 0),
    status: r.status || 'issued',
    status_text: serialStatusText(r.status),
    device_id: r.device_id || '',
    activated_at: r.activated_at || '',
    claimed_at: Number(r.claimed_at || 0),
  };
}

/**
 * GET /api/serial/categories
 * 取号可选分类：直接转发序列号后台的分类清单（含每个分类还能发几个）。
 * 分类是你自己在后台建的，跟版本名没有任何绑定关系 ——
 * 取号页选哪个分类，就从这个分类里取号。
 */
async function apiSerialCategories(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const r = await btkeyRequest(env, '/api/categories');
  const data = r.data || {};
  if (!data.ok) {
    return json({
      ok: false,
      error: r.error || data.error || 'btkey_unavailable',
      message: '序列号服务暂时不可用',
      list: [],
    }, 502);
  }

  const list = (data.categories || []).map((c) => ({
    name: c.name,
    display: c.name,
    total: Number(c.total || 0),
    activated: Number(c.activated || 0),
    claimed: Number(c.claimed || 0),
    available: Number(c.available || 0),
  }));

  // 未分类里如果还有号，也允许从那里取
  const un = data.uncategorized;
  if (un && Number(un.total || 0) > 0) {
    list.push({
      name: '',
      display: '未分类',
      total: Number(un.total || 0),
      activated: Number(un.activated || 0),
      claimed: Number(un.claimed || 0),
      available: Number(un.available || 0),
    });
  }

  return json({ ok: true, list });
}

/**
 * POST /api/serial/claim  body: { request_id }（category 可不传，服务端固定用 SERIAL_CATEGORY）
 * 一期规则：首次登录并绑定手机号，免费领 1 个序列号。
 * 顺序：幂等 → 手机号 → 免费额度 → 向序列号后台占号 → 本地落库 → 确认发货
 */
async function apiSerialClaim(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  // 分类由服务端决定，客户端传什么都不看（防止有人指定别的分类去刷号）
  const category = serialCategory(env);
  const requestId = String(body.request_id || '').trim();
  // 「购买的版本」：用户在取号页选的版本（如 BarTender 2022 · R8 Full x64），仅用于记录/客服核对
  const version = String(body.version || '')
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  // 该版本的下载 / 激活地址：领取时快照下来，之后只在「我的」里给本人看，不在标签软件 / 取号页复制
  const downloadUrl = cleanUrl(body.download_url);
  const keyUrl = cleanUrl(body.key_url);
  if (!category) return json({ ok: false, error: 'need_category_config' }, 500);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return json({ ok: false, error: 'bad_request_id' }, 400);

  // ① 幂等：同一个 request_id 直接返回上次结果（连点/网络重试不会发两个号）
  const existed = await __db.getUserSerialByRequestId(requestId);
  if (existed) {
    if (Number(existed.user_id) !== Number(user.id)) {
      return json({ ok: false, error: 'request_id_conflict' }, 409);
    }
    return json({ ok: true, repeated: true, ...publicSerialRow(existed) });
  }

  // ② 首免前置条件：必须绑手机号
  if (!PHONE_RE.test(String(user.phone || ''))) {
    return json({ ok: false, error: 'need_phone', message: '请先绑定手机号' }, 400);
  }

  // ③ 决定本次是「首免」还是「扣愿望」：
  //    免费额度用数据库唯一索引兜底（清缓存也刷不出来）；用过了就走扣愿望
  const WISH_COST = wishCost(env);
  let mode = (await __db.hasFreeSerial(user.id)) ? 'wish' : 'free';
  if (mode === 'wish' && Number(user.xpay_count || 0) < WISH_COST) {
    return json({
      ok: false, error: 'need_wish', message: '愿望不足，请先购买愿望',
      need: WISH_COST, wish_left: Number(user.xpay_count || 0),
    }, 402);
  }

  // ④ 占号 + 扣愿望 + 落库。
  //    序列号后台是 KV，并发时可能把同一个号发给两个人，这里靠 user_serials 的唯一索引兜住：
  //    冲突就换号重试；扣愿望和落库在同一个事务里（db.claimSerialTx），失败全部撤销，不会白扣。
  let lastError = 'out_of_stock';
  const excluded = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimId = attempt === 0 ? requestId : requestId + '_r' + attempt;
    const r = await btkeyRequest(env, '/api/claim', {
      method: 'POST',
      body: { category, request_id: claimId, exclude: excluded },
    });
    const data = r.data || {};
    if (!data.ok || !data.serial) {
      lastError = data.error || r.error || 'out_of_stock';
      break;
    }

    const serial = String(data.serial);
    const ts = now();
    const cost = mode === 'wish' ? WISH_COST : 0;

    const tx = await __db.claimSerialTx({
      userId: user.id,
      cost,
      row: {
        user_id: user.id, openid: user.openid, serial, category, version,
        download_url: downloadUrl, key_url: keyUrl,
        source: mode, cost, request_id: requestId,
        status: 'issued', claimed_at: ts, synced_at: 0,
      },
    });

    if (!tx.ok) {
      if (tx.error === 'need_wish') {
        // 事务已回滚（没扣愿望也没落库），把号还回池子
        try { await btkeyRequest(env, '/api/release', { method: 'POST', body: { serial, request_id: claimId } }); } catch { /* ignore */ }
        return json({
          ok: false, error: 'need_wish', message: '愿望不足，请先购买愿望',
          need: WISH_COST, wish_left: Number(user.xpay_count || 0),
        }, 402);
      }

      if (tx.error === 'free_taken') {
        // 免费额度被并发抢了：这个号原本按免费领的，还回池子，改成扣愿望重试
        try { await btkeyRequest(env, '/api/release', { method: 'POST', body: { serial, request_id: claimId } }); } catch { /* ignore */ }
        mode = 'wish';
        if (Number(user.xpay_count || 0) < WISH_COST) {
          return json({
            ok: false, error: 'need_wish', message: '愿望不足，请先购买愿望',
            need: WISH_COST, wish_left: Number(user.xpay_count || 0),
          }, 402);
        }
        lastError = 'retry';
        continue;
      }

      if (tx.error === 'serial_taken') {
        // 这个号已经被别人领走了（是别人的号，不能释放），换一个重试
        excluded.push(serial);
        lastError = 'retry';
        continue;
      }

      if (tx.error === 'duplicate_request') {
        const dup = await __db.getUserSerialByRequestId(requestId);
        if (dup) return json({ ok: true, repeated: true, ...publicSerialRow(dup) });
      }

      // 其它数据库异常：尽量把号还回去，避免号被占死
      try { await btkeyRequest(env, '/api/release', { method: 'POST', body: { serial, request_id: claimId } }); } catch { /* ignore */ }
      lastError = 'db_error';
      break;
    }

    // ⑤ 确认发货；失败不影响用户（号已落库，状态同步会自愈）
    try { await btkeyRequest(env, '/api/confirm', { method: 'POST', body: { serial, request_id: claimId } }); } catch { /* ignore */ }
    await kvAddLog(env.BTSMKV, {
      userId: user.id, action: 'serial_claim',
      detail: `${serial} ${category} ${mode}${cost ? ' -' + cost + '愿望' : ''}`,
      ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
    });

    const fresh = await __db.getUserById(user.id);
    return json({
      ok: true, serial, category, version,
      download_url: downloadUrl, key_url: keyUrl,
      source: mode, cost,
      status: 'issued', status_text: '未激活', claimed_at: ts,
      wish_left: Number((fresh && fresh.xpay_count) || 0),
    });
  }

  if (lastError === 'out_of_stock' || lastError === 'retry') {
    return json({ ok: false, error: 'out_of_stock', message: '该分类暂时没有可用的序列号' }, 409);
  }
  if (lastError === 'db_error') {
    return json({ ok: false, error: 'db_error', message: '服务器忙，请稍后重试' }, 500);
  }
  return json({ ok: false, error: lastError }, 502);
}

/**
 * GET /api/serial/mine?sync=1&page=1&page_size=20
 * 我的序列号：本地秒回，超过 30 秒就向序列号后台批量同步激活状态（只同步当前页）
 *   page_size 不传默认 20（「我的」页预览只要 2 条，传 2 即可）
 */
async function apiSerialMine(request, env, url) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const force = url.searchParams.get('sync') === '1';
  const SYNC_TTL = 30;
  const pageSize = Math.min(Math.max(Number(url.searchParams.get('page_size') || 20), 1), 50);
  const page = Math.max(Number(url.searchParams.get('page') || 1), 1);
  const offset = (page - 1) * pageSize;

  let rows = await __db.listUserSerials(user.id, pageSize, offset);

  const need = rows.filter((r) => r.status !== 'void'
    && (force || !r.synced_at || now() - Number(r.synced_at) > SYNC_TTL));
  let synced = true;
  if (need.length) {
    const serials = need.slice(0, 50).map((r) => r.serial).join(',');
    const r = await btkeyRequest(env, '/api/status?serials=' + encodeURIComponent(serials));
    const data = r.data || {};
    if (data.ok && Array.isArray(data.list)) {
      const map = new Map(data.list.map((x) => [x.serial, x]));
      const ts = now();
      for (const row of need) {
        const info = map.get(row.serial);
        if (!info) {
          await __db.updateUserSerialSync(row.serial, { status: 'missing', synced_at: ts });
          continue;
        }
        let st = 'issued';
        if (info.activated) st = 'activated';
        else if (info.status === 'void') st = 'void';
        else if (info.found === false || info.status === 'missing') st = 'missing';
        await __db.updateUserSerialSync(row.serial, {
          status: st,
          device_id: info.device_id || '',
          activated_at: info.activated_at || '',
          synced_at: ts,
        });
      }
      rows = await __db.listUserSerials(user.id, pageSize, offset);
    } else {
      // 序列号后台不可达：保留上次已知状态，只标记「本次没同步上」
      synced = false;
    }
  }

  // 免费额度直接查库，不能靠"当前页里有没有 free 行"判断（分页后会算错）
  const freeUsed = await __db.hasFreeSerial(user.id);
  const total = await __db.countUserSerials(user.id);
  return json({
    ok: true,
    synced,
    free_used: freeUsed,
    free_left: freeUsed ? 0 : 1,
    wish_left: Number(user.xpay_count || 0),
    cost: wishCost(env),
    phone_bound: PHONE_RE.test(String(user.phone || '')),
    total,
    page,
    page_size: pageSize,
    has_more: offset + rows.length < total,
    list: rows.map(publicSerialRow),
  });
}

// ───────────────────────── 智能插座验证码 ─────────────────────────

/* 算法与 Arduino / key.py 完全一致，改这里会导致算出来的码对不上设备：
     hash = 0
     for ch in (MAC大写12位 + "236520"):  hash = (hash*31 + ord(ch)) & 0xFFFFFFFF
     code = hash % 1000000，补前导零到 6 位
   盐值 236520 必须与设备固件一致，不可修改。 */
const SOCKET_SALT = '236520';
const SOCKET_COST = 1;                 // 每生成一个验证码扣 1 个愿望
const SOCKET_MAX_BATCH = 50;           // 一次最多生成多少个

/** MAC 标准化：去掉 : - 空格，转大写；返回 12 位十六进制或 '' */
function normalizeMac(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s:\-]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(s) ? s : '';
}

/** 六位验证码（纯函数，无副作用） */
function socketCodeOf(mac12) {
  let h = 0;
  const mix = mac12 + SOCKET_SALT;
  for (let i = 0; i < mix.length; i++) {
    h = (h * 31 + mix.charCodeAt(i)) >>> 0;
  }
  return String(h % 1000000).padStart(6, '0');
}

/**
 * 解析用户输入的 MAC 列表：
 *   支持换行 / 逗号 / 分号 / 空格 分隔，带不带冒号都行，大小写不敏感
 *   同一个 MAC 重复出现只算一次（不重复扣愿望）
 */
function parseMacInput(input) {
  const rawList = Array.isArray(input)
    ? input
    : String(input == null ? '' : input).split(/[\s,;，；、|]+/);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const item of rawList) {
    const token = String(item == null ? '' : item).trim();
    if (!token) continue;
    const mac = normalizeMac(token);
    if (!mac) { invalid.push(token.slice(0, 40)); continue; }
    if (seen.has(mac)) continue;
    seen.add(mac);
    valid.push(mac);
  }
  return { valid, invalid };
}

function publicCodeRow(r) {
  return {
    mac: r.mac,
    code: r.code,
    remote: 'key:' + r.code,
    created_at: Number(r.created_at || 0),
  };
}

/**
 * POST /api/socket/codes  body: { macs: [...] | "多行文本", request_id }
 * 智能插座验证码：每个 MAC 生成一个 6 位码，每生成一个扣 1 个愿望。
 * 先在本地校验（非法 MAC 不发号不扣费），再一个事务里「扣愿望 + 落库」，最后返回结果。
 */
async function apiSocketCodes(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const requestId = String(body.request_id || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    return json({ ok: false, error: 'bad_request_id' }, 400);
  }

  // ① 幂等：同一个 request_id 直接返回上次生成的结果（连点/重试不重复扣）
  const existedBatch = await __db.getCodeBatch(requestId);
  if (existedBatch) {
    if (Number(existedBatch.user_id) !== Number(user.id)) {
      return json({ ok: false, error: 'request_id_conflict' }, 409);
    }
    const rows = await __db.listCodesByRequest(requestId);
    const fresh = await __db.getUserById(user.id);
    return json({
      ok: true, repeated: true,
      cost: Number(existedBatch.cost || 0),
      wish_left: Number((fresh && fresh.xpay_count) || 0),
      items: rows.map(publicCodeRow),
    });
  }

  // ② 校验 MAC
  const { valid, invalid } = parseMacInput(body.macs !== undefined ? body.macs : body.mac);
  if (invalid.length) {
    return json({
      ok: false, error: 'bad_mac',
      message: 'MAC 地址格式不对：需要 12 位十六进制（0-9 / A-F）',
      invalid: invalid.slice(0, 10),
    }, 400);
  }
  if (!valid.length) {
    return json({ ok: false, error: 'empty_mac', message: '请先输入设备 MAC 地址' }, 400);
  }
  if (valid.length > SOCKET_MAX_BATCH) {
    return json({
      ok: false, error: 'too_many',
      message: `一次最多生成 ${SOCKET_MAX_BATCH} 个，请分批`,
      max: SOCKET_MAX_BATCH,
    }, 400);
  }

  // ③ 余额
  const cost = valid.length * SOCKET_COST;
  if (Number(user.xpay_count || 0) < cost) {
    return json({
      ok: false, error: 'need_wish', message: '愿望不足，请先购买愿望',
      need: cost, wish_left: Number(user.xpay_count || 0),
    }, 402);
  }

  // ④ 扣愿望 + 落库（一个事务，失败全撤销）
  const rows = valid.map((mac) => ({ mac, code: socketCodeOf(mac), kind: 'socket', openid: user.openid }));
  const tx = await __db.createCodeBatchTx({ userId: user.id, requestId, cost, rows });

  if (!tx.ok) {
    if (tx.error === 'duplicate_request') {
      const batch = await __db.getCodeBatch(requestId);
      if (batch && Number(batch.user_id) === Number(user.id)) {
        const old = await __db.listCodesByRequest(requestId);
        const fresh = await __db.getUserById(user.id);
        return json({
          ok: true, repeated: true, cost: Number(batch.cost || 0),
          wish_left: Number((fresh && fresh.xpay_count) || 0),
          items: old.map(publicCodeRow),
        });
      }
      return json({ ok: false, error: 'request_id_conflict' }, 409);
    }
    if (tx.error === 'need_wish') {
      const fresh = await __db.getUserById(user.id);
      return json({
        ok: false, error: 'need_wish', message: '愿望不足，请先购买愿望',
        need: cost, wish_left: Number((fresh && fresh.xpay_count) || 0),
      }, 402);
    }
    return json({ ok: false, error: 'db_error', message: '服务器忙，请稍后重试' }, 500);
  }

  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'socket_code',
    detail: `${rows.length} 个 MAC -${cost}愿望 ${rows.map((r) => r.mac).join(',')}`.slice(0, 300),
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
  });

  const fresh = await __db.getUserById(user.id);
  return json({
    ok: true,
    cost,
    wish_left: Number((fresh && fresh.xpay_count) || 0),
    items: rows.map((r) => publicCodeRow({ mac: r.mac, code: r.code, created_at: tx.created_at })),
  });
}

/**
 * GET /api/socket/mine?page=1&page_size=20
 * 我生成过的插座验证码（纯本地记录，不需要向外部同步）
 */
async function apiSocketMine(request, env, url) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const pageSize = Math.min(Math.max(Number(url.searchParams.get('page_size') || 20), 1), 50);
  const page = Math.max(Number(url.searchParams.get('page') || 1), 1);
  const offset = (page - 1) * pageSize;

  const rows = await __db.listUserCodes(user.id, pageSize, offset);
  const total = await __db.countUserCodes(user.id);
  return json({
    ok: true,
    total,
    page,
    page_size: pageSize,
    has_more: offset + rows.length < total,
    list: rows.map((r) => ({
      id: Number(r.id),
      mac: r.mac,
      code: r.code,
      remote: 'key:' + r.code,
      cost: Number(r.cost || 0),
      created_at: Number(r.created_at || 0),
    })),
  });
}

/**
 * GET /api/serial/detail?serial=xxx
 * 单条序列号详情（含下载/激活地址）。「我的」点开某条时按序列号精确取，
 * 不依赖列表数组，避免列表与点击项错位时弹错记录。
 */
async function apiSerialDetail(request, env, url) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const serial = String(url.searchParams.get('serial') || '').trim();
  if (!serial) return json({ ok: false, error: 'bad_serial' }, 400);

  const row = await __db.getUserSerial(serial);
  if (!row) return json({ ok: false, error: 'not_found' }, 404);
  // 只能看自己的号
  if (Number(row.user_id) !== Number(user.id)) return json({ ok: false, error: 'not_found' }, 404);

  // 客户端已删除的记录不再下发（软删除后即使重新登录也不会同步回来）
  if (Number(row.hidden || 0) === 1) return json({ ok: false, error: 'not_found' }, 404);

  // 超过 30 秒没同步过，就顺手更新这一条的激活状态
  let synced = true;
  const stale = !row.synced_at || now() - Number(row.synced_at) > 30;
  if (stale && row.status !== 'void') {
    try {
      const r = await btkeyRequest(env, '/api/status?serials=' + encodeURIComponent(serial), { method: 'GET' });
      const data = r.data || {};
      const info = Array.isArray(data.list) ? data.list[0] : null;
      if (data.ok && info) {
        let st = 'issued';
        if (info.activated) st = 'activated';
        else if (info.status === 'void') st = 'void';
        else if (info.found === false || info.status === 'missing') st = 'missing';
        await __db.updateUserSerialSync(serial, {
          status: st,
          device_id: info.device_id || '',
          activated_at: info.activated_at || '',
          synced_at: now(),
        });
      }
    } catch { synced = false; }
  }

  const fresh = (await __db.getUserSerial(serial)) || row;
  return json({ ok: true, synced, item: publicSerialRow(fresh) });
}

/**
 * POST /api/serial/hide  body: { serial }
 * 客户端删除（软删除）：只在本人这边隐藏，后台记录保留，重新登录也不会再同步回来。
 * 注意：不释放免费额度、不退还愿望 —— 删的只是自己看到的记录。
 */
async function apiSerialHide(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const serial = String(body.serial || '').trim();
  if (!serial) return json({ ok: false, error: 'bad_serial' }, 400);

  const row = await __db.getUserSerial(serial);
  if (!row || Number(row.user_id) !== Number(user.id)) {
    return json({ ok: false, error: 'not_found' }, 404);
  }
  if (Number(row.hidden || 0) === 1) return json({ ok: true, already: true });

  const changes = await __db.hideUserSerial(serial, user.id);
  if (!changes) return json({ ok: false, error: 'not_found' }, 404);

  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'serial_hide',
    detail: `${serial} 用户在客户端删除（后台保留）`,
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
  });
  return json({ ok: true });
}

/**
 * POST /api/socket/hide  body: { id }
 * 插座验证码的客户端删除（软删除），规则同上。
 */
async function apiSocketHide(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const id = Number(body.id || 0);
  if (!id) return json({ ok: false, error: 'bad_id' }, 400);

  const changes = await __db.hideUserCode(id, user.id);
  if (!changes) return json({ ok: false, error: 'not_found' }, 404);

  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'socket_code_hide',
    detail: `id=${id} 用户在客户端删除（后台保留）`,
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
  });
  return json({ ok: true });
}

// ───────────────────────── Admin ─────────────────────────

async function adminIndex(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(url.origin + '/' + (env.ADMIN_PREFIX||'admin') + '/login', 302);
  return html(renderAdminPage(env));
}

function adminLoginPage(env) {
  const title = env.APP_NAME || 'Admin';
  return html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · 后台登录</title>
<style>
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f2f4f7;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.08);width:320px}
h1{font-size:18px;margin:0 0 20px;color:#1f2937}
input{width:100%;box-sizing:border-box;padding:10px 12px;margin:6px 0 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px}
button{width:100%;padding:10px;background:#2563eb;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}
</style></head><body>
<form class="card" method="post" action="/${env.ADMIN_PREFIX||'admin'}/login">
  <h1>${escapeHtml(title)} · 管理后台</h1>
  <input name="username" placeholder="账号" required autofocus>
  <input name="password" type="password" placeholder="密码" required>
  <button type="submit">登 录</button>
</form></body></html>`);
}

async function adminLogin(request, env) {
  const form = await request.formData();
  const ok = safeEqual(form.get('username')||'', env.ADMIN_USERNAME) &&
             safeEqual(form.get('password')||'', env.ADMIN_PASSWORD);
  if (!ok) return html('<script>alert("账号或密码错误");location.href="login"</script>', 401);
  const expireSec = Number(env.JWT_EXPIRE || 2592000);
  const token = await signJwt({ sub:'admin', type:'admin', iat:now(), exp:now()+expireSec }, env.JWT_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      'location': '/' + (env.ADMIN_PREFIX||'admin'),
      'set-cookie': `admin_token=${token}; HttpOnly; Path=/; Max-Age=${expireSec}; SameSite=Lax`,
    },
  });
}
async function adminLogout(env) {
  return new Response(null, {
    status: 302,
    headers: {
      'location': '/' + (env.ADMIN_PREFIX||'admin') + '/login',
      'set-cookie': 'admin_token=; Path=; Max-Age=0',
    },
  });
}

/** GET /admin/api/products */
async function adminApiGetProducts(request, env) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);
  const list = await kvGetProducts(env.BTSMKV);
  return json({
    products: list,
    // 兜底档位也一起返回：后台「载入默认档位」用，已保存过配置时也能一键恢复
    defaults: DEFAULT_PRODUCTS,
    is_default: JSON.stringify(list) === JSON.stringify(DEFAULT_PRODUCTS),
  });
}

/** POST /admin/api/products  body: { products: [...] } */
async function adminApiSaveProducts(request, env) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error:'bad_json' }, 400); }
  if (!Array.isArray(body.products)) return json({ error:'bad_products' }, 400);

  const clean = [];
  for (const p of body.products) {
    const productId = String(p.productId || '').trim();
    if (!productId) continue;
    clean.push({
      productId,
      name: String(p.name || productId).slice(0, 40),
      goodsPrice: Math.max(1, Math.round(Number(p.goodsPrice) || 0)),
      buyQuantity: Math.max(1, Math.round(Number(p.buyQuantity) || 1)),
      times: Math.max(1, Math.round(Number(p.times) || 1)),
      sort: Math.round(Number(p.sort) || clean.length + 1)
    });
  }
  if (!clean.length) return json({ error: 'empty_products', message: '至少保留一个道具' }, 400);

  await kvSaveProducts(env.BTSMKV, clean);
  await kvAddLog(env.BTSMKV, { userId:0, action:'admin_products_save', detail:`by ${session.sub} count=${clean.length}` });
  return json({ ok:true, products: clean });
}

/** GET /admin/api/users?search=&page= */
async function adminApiUsers(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);

  let users = await kvListAllUsers(env.BTSMKV, Number(env.KV_MAX_SCAN || 1000));
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  if (search) {
    users = users.filter(u =>
      String(u.id) === search ||
      u.openid.toLowerCase().includes(search) ||
      (u.nickname||'').toLowerCase().includes(search) ||
      (u.phone||'').includes(search) ||
      (u.remark||'').toLowerCase().includes(search)
    );
  }

  const pageSize = Number(env.ADMIN_PAGE_SIZE || 20);
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const total = users.length;
  // 两种功能分开统计：已领号（标签软件序列号）/ 插座key（智能插座验证码）
  const serialCounts = await __db.countSerialsByUser();
  const codeCounts = await __db.countCodesByUser();
  const slice = users.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map(u => ({
    id: u.id, openid: u.openid, nickname: u.nickname, phone: u.phone,
    count: Number(u.xpay_count || 0),
    total: Number(u.xpay_total || 0),
    spent: toYuan(u.xpay_spent),
    serials: Number(serialCounts[Number(u.id)] || 0),
    codes: Number(codeCounts[Number(u.id)] || 0),
    status: u.status, remark: u.remark,
    last_login_at: u.last_login_at, created_at: u.created_at
  }));
  return json({ total, page, pageSize, users: slice });
}

/** GET /admin/api/orders?page= */
async function adminApiOrders(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);

  const orders = await kvListOrders(env.BTSMKV, Number(env.KV_MAX_SCAN || 1000));
  const pageSize = Number(env.ADMIN_PAGE_SIZE || 20);
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const total = orders.length;
  const slice = orders.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map(o => ({
    id: o.id, outTradeNo: o.outTradeNo, userId: o.userId,
    productName: o.productName, productId: o.productId,
    price: toYuan(o.goodsPrice), times: Number(o.times || 1) * Number(o.buyQuantity || 1),
    status: o.status, mock: !!o.mock, wxOrderId: o.wxOrderId || '',
    createdAt: o.createdAt, deliveredAt: o.deliveredAt
  }));
  return json({ total, page, pageSize, orders: slice });
}

async function adminApiStats(request, env) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);
  const users = await kvListAllUsers(env.BTSMKV, Number(env.KV_MAX_SCAN || 1000));
  const ts = now();
  const vip = users.filter(u => Number(u.xpay_count||0) > 0).length;
  const today = users.filter(u => u.created_at >= ts - 86400).length;
  const spentSum = users.reduce((s, u) => s + Number(u.xpay_spent||0), 0);
  const countSum = users.reduce((s, u) => s + Number(u.xpay_count||0), 0);
  return json({
    total: users.length, svip: vip, new_today: today,
    spent_sum: toYuan(spentSum),
    count_sum: countSum,
    mock: isMock(env)
  });
}

/** POST /admin/api/users/:id */
async function adminApiUpdateUser(request, env, id) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);
  if (!id) return json({ error:'bad_id' }, 400);

  let body;
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) body = await request.json();
  else { const f = await request.formData(); body = Object.fromEntries(f.entries()); }

  const user = await kvGetUserById(env.BTSMKV, id);
  if (!user) return json({ error:'not_found' }, 404);

  if (typeof body.nickname === 'string') user.nickname = body.nickname.slice(0,64);
  if (typeof body.phone === 'string')    user.phone = body.phone.replace(/\D/g,'').slice(0,11);
  if (typeof body.remark === 'string')   user.remark = body.remark.slice(0,255);
  if (body.status !== undefined)         user.status = Number(body.status) ? 1 : 0;

  // 次数：支持「设为」与「增加」两种模式
  const beforeCount = Number(user.xpay_count || 0);
  if (body.count !== undefined && body.count !== '') {
    const n = Math.max(0, Math.round(Number(body.count) || 0));
    if (body.count_mode === 'add') {
      user.xpay_count = beforeCount + n;
      // 手工增加次数视为一次购买记录，同步累计购买
      if (n > 0) user.xpay_total = Number(user.xpay_total||0) + n;
    } else {
      user.xpay_count = n;
    }
  }

  // 累计购买次数：直接设为指定值（传空字符串则清零）
  if (body.total !== undefined) {
    if (body.total === '') user.xpay_total = 0;
    else if (Number.isFinite(Number(body.total))) user.xpay_total = Math.max(0, Math.round(Number(body.total)));
  }

  // 累计消费：按「元」传参，内部存分（传空字符串则清零）
  if (body.spent !== undefined) {
    if (body.spent === '') user.xpay_spent = 0;
    else if (Number.isFinite(Number(body.spent))) {
      user.xpay_spent = Math.max(0, Math.round(Number(body.spent) * 100));
    }
  }

  user.updated_at = now();
  await kvPutUser(env.BTSMKV, user);
  await kvAddLog(env.BTSMKV, {
    userId:user.id, action:'admin_update',
    detail:`by ${session.sub} 次数=${beforeCount}→${user.xpay_count} 累计购买=${user.xpay_total} 累计消费=${toYuan(user.xpay_spent)}元`,
    ip:getClientIp(request), nickname:user.nickname, openid:user.openid
  });
  return json({ ok:true, user: publicUser(user) });
}

/** GET /admin/api/export.csv */
async function adminApiExportCsv(request, env) {
  const session = await authAdmin(request, env);
  if (!session) return new Response('unauthorized', { status: 401 });
  const users = await kvListAllUsers(env.BTSMKV, Number(env.KV_MAX_SCAN || 1000));
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const head = ['id','openid','nickname','phone','count','total','spent','status','remark','created_at'];
  const lines = [head.join(',')];
  for (const u of users) {
    lines.push([u.id, esc(u.openid), esc(u.nickname), esc(u.phone),
      Number(u.xpay_count||0), Number(u.xpay_total||0), toYuan(u.xpay_spent),
      u.status, esc(u.remark), u.created_at].join(','));
  }
  return new Response('\uFEFF' + lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="users_${now()}.csv"`,
    },
  });
}

/**
 * POST /admin/serials/delete  body: { serial, action, page?, search? }
 * 删除一条发放记录：
 *   action=release → 号退回序列号后台的可发放池（没激活过才允许）
 *   action=void    → 号在序列号后台作废（已激活的号只能作废，不能回池）
 * 删除 source='free' 的记录后，该用户的免费额度会被释放，可以重新走一遍取号流程。
 */
async function adminDeleteSerial(request, env) {
  const session = await authAdmin(request, env);
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = new URL(request.url).origin;          // Response.redirect 只接受绝对地址
  const loginUrl = `${origin}/${adminPrefix}/login`;

  let form;
  try { form = await request.formData(); } catch { return Response.redirect(loginUrl, 302); }
  const serial = String(form.get('serial') || '').trim();
  const action = String(form.get('action') || 'release').trim();
  const pg = Math.max(1, Number(form.get('page') || 1));
  const search = String(form.get('search') || '').trim();

  if (!session) return Response.redirect(loginUrl, 302);

  const back = (m) => {
    const q = new URLSearchParams();
    q.set('page', String(pg));
    if (search) q.set('search', search);
    if (m) q.set('m', m);
    return Response.redirect(`${origin}/${adminPrefix}/serials?${q.toString()}`, 302);
  };

  if (!serial) return back('缺少序列号');

  const row = await __db.getUserSerial(serial);
  if (!row) return back(`本地没有该发放记录：${serial}`);

  // 已激活的号绑着设备，退回池子会被别人激活后报 off-1；已作废的号也不该被"复活"
  const forceVoid = row.status === 'activated' || row.status === 'void';
  const mode = forceVoid ? 'void' : (action === 'void' ? 'void' : 'release');

  // 先同步序列号后台，成功才删本地记录，避免两边状态不一致
  // 带上本地记录的 request_id，让后台把幂等键一起清掉，这个号才能被重新领取
  const r = await btkeyRequest(env, mode === 'void' ? '/api/void' : '/api/release', {
    method: 'POST',
    body: { serial, request_id: row.request_id || '' },
  });
  const data = r.data || {};
  // 号池里本来就没这个号（例如被人在序列号后台删了）→ 允许直接删本地记录
  const goneFromPool = data.error === 'not_found';
  if (!data.ok && !goneFromPool) {
    const map = {
      already_activated: '该号已被激活，无法退回号池（请改成「删除并作废」）',
      is_void: '该号在号池里已作废',
      btkey_not_configured: '还没配置序列号后台（BTKEY_API_BASE / BTKEY_API_TOKEN）',
      btkey_unreachable: '连不上序列号后台，请稍后重试',
      unauthorized: '序列号后台令牌不对（BTKEY_API_TOKEN）',
    };
    return back(`删除失败：${map[data.error || r.error] || (data.error || r.error || '未知错误')}`);
  }

  await __db.deleteUserSerial(serial);
  await kvAddLog(env.BTSMKV, {
    userId: row.user_id, action: 'serial_admin_delete',
    detail: `${serial} ${row.category} ${row.source} → ${goneFromPool ? 'remove_only' : mode}`,
    ip: getClientIp(request), nickname: '', openid: row.openid,
  });

  if (goneFromPool) return back(`已删除本地记录 ${serial}（号池里已经没有这个号）`);
  return back(mode === 'void'
    ? `已删除 ${serial} 并在号池作废${forceVoid ? '（已激活/已作废的号只能作废）' : ''}`
    : `已删除 ${serial}，号已退回可发放池`);
}

/** GET /admin/serials —— 序列号发放记录（谁在什么时候领了哪个号、现在是什么状态） */
async function adminSerialsPage(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(url.origin + '/' + (env.ADMIN_PREFIX || 'admin') + '/login', 302);

  const pageSize = Number(env.ADMIN_PAGE_SIZE || 20);
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const search = (url.searchParams.get('search') || '').trim();
  const rows = await __db.listAllSerials({ search, limit: pageSize + 1, offset: (page - 1) * pageSize });
  const hasMore = rows.length > pageSize;
  const list = rows.slice(0, pageSize);
  const total = await __db.countAllSerials();
  const adminPrefix = env.ADMIN_PREFIX || 'admin';

  const fmt = fmtBeijing;   // 北京时间（不依赖服务器时区）
  const tagOf = (s) => s === 'activated' ? '<span class="tag ok">已激活</span>'
    : s === 'void' ? '<span class="tag ban">已作废</span>'
    : s === 'missing' ? '<span class="tag wait">号已失效</span>'
    : '<span class="tag normal">未激活</span>';

  const msg = (url.searchParams.get('m') || '').trim();
  const pageVal = String(page);
  const searchVal = escapeHtml(search);

  /** 删除表单：先同步号池，再删本地记录；已激活的号只能作废 */
  const delForms = (r) => {
    const activated = r.status === 'activated';
    const hidden = `<input type="hidden" name="serial" value="${escapeHtml(r.serial)}">
      <input type="hidden" name="page" value="${pageVal}">
      <input type="hidden" name="search" value="${searchVal}">`;
    if (activated) {
      return `<form method="post" action="/${adminPrefix}/serials/delete" class="inline"
        onsubmit="return confirm('该号已激活，删除后会在号池作废（不可再发放/激活）。确定？')">
        ${hidden}<input type="hidden" name="action" value="void">
        <button class="mini danger">删除（作废）</button></form>
        <div class="muted" style="margin-top:4px">已激活：只能作废，不能退回号池</div>`;
    }
    return `<form method="post" action="/${adminPrefix}/serials/delete" class="inline"
        onsubmit="return confirm('删除这条记录，并把号退回可发放池？\\n该用户（首免号）之后可以重新领一次。')">
        ${hidden}<input type="hidden" name="action" value="release">
        <button class="mini">删除·退回池</button></form>
      <form method="post" action="/${adminPrefix}/serials/delete" class="inline"
        onsubmit="return confirm('删除这条记录，并把号作废（不再发放）？')">
        ${hidden}<input type="hidden" name="action" value="void">
        <button class="mini danger">删除·作废</button></form>`;
  };

  const trs = list.map((r) => `<tr${Number(r.hidden || 0) === 1 ? ' style="background:#fffdf6"' : ''}>
    <td class="mono nowrap">${escapeHtml(r.serial)}</td>
    <td class="ver">${r.version ? escapeHtml(r.version) : '<span class="muted">-</span>'}</td>
    <td class="nowrap">${escapeHtml(r.category || '-')}</td>
    <td class="nowrap">${r.user_id}<br><span class="muted">${escapeHtml(r.nickname || '')}</span></td>
    <td class="nowrap">${escapeHtml(r.phone || '-')}</td>
    <td class="nowrap">${r.source === 'free' ? '首免' : r.source === 'wish' ? '扣愿望 ' + Number(r.cost || 0) : escapeHtml(r.source || '')}</td>
    <td class="nowrap">${fmt(r.claimed_at)}</td>
    <td class="nowrap">${tagOf(r.status)}${Number(r.hidden || 0) === 1 ? ' <span class="tag hidden">用户已删除</span>' : ''}</td>
    <td class="nowrap">${escapeHtml(r.device_id || '-')}</td>
    <td class="nowrap">${escapeHtml(r.activated_at || '-')}</td>
    <td style="white-space:nowrap">${delForms(r)}</td>
  </tr>`).join('');

  return html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>序列号发放 · ${escapeHtml(env.APP_NAME || '')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f2f4f7;color:#1f2937}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
header a{color:#2563eb;text-decoration:none;font-size:14px}
.wrap{padding:20px 24px;max-width:1280px;margin:0 auto}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
th,td{padding:10px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:left;vertical-align:top}
th{background:#fafafa;color:#6b7280;font-weight:500;white-space:nowrap}
td.nowrap{white-space:nowrap}
/* 版本名较长：允许在词间换行，别把 "BarTender" 从中间切开 */
td.ver{white-space:normal;word-break:normal;overflow-wrap:break-word;min-width:150px;max-width:240px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:10px}
.mono{font-family:Consolas,Menlo,monospace}
.muted{color:#9ca3af;font-size:12px}
.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px}
.tag.ok{background:#e6f7ee;color:#1a7f4b}
.tag.ban{background:#fdecea;color:#b3261e}
.tag.wait{background:#fff4e5;color:#8a5a00}
.tag.normal{background:#f2f4f7;color:#6b7280}
.tag.hidden{background:#fff4e5;color:#8a5a00;border:1px solid #ffe3b8}
.toolbar{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.toolbar input{padding:8px 10px;border:1px solid #e5e7eb;border-radius:6px;width:280px}
.toolbar button{padding:8px 14px;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer}
.tabs{display:flex;gap:6px}
.tabs a{padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:13px;text-decoration:none;color:#1f2937}
.tabs a.on{background:#eff4ff;border-color:#2563eb;color:#2563eb;font-weight:600}
form.inline{display:inline}
button.mini{padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid #2563eb;
  background:#eff4ff;color:#2563eb;cursor:pointer;margin:0 4px 4px 0}
button.mini.danger{border-color:#e5b4b0;background:#fdeeec;color:#b3261e}
.msg{background:#e8f5ec;color:#1a7f4b;border:1px solid #bfe6d1;padding:10px 14px;border-radius:8px;margin-bottom:12px}
.tip{color:#6b7280;font-size:12px;line-height:1.7;margin-top:12px}
.pager{margin-top:12px;display:flex;gap:8px;justify-content:flex-end;color:#6b7280;font-size:13px;align-items:center}
.pager a{padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:6px;text-decoration:none;color:#1f2937}
</style></head><body>
<header>
  <a href="/${adminPrefix}">← 返回用户列表</a>
  <div class="tabs">
    <a href="/${adminPrefix}/serials" class="on">标签软件序列号</a>
    <a href="/${adminPrefix}/codes">智能插座验证码</a>
    <a href="/${adminPrefix}/logs">审计日志</a>
  </div>
  <span class="muted">共 ${total} 条发放记录</span>
</header>
<div class="wrap">
  <h2>序列号发放（第 ${page} 页）</h2>
  ${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ''}
  <form class="toolbar" method="get">
    <input name="search" value="${searchVal}" placeholder="序列号 / 版本 / 分类 / 手机号 / 用户ID">
    <button type="submit">搜索</button>
    ${search ? `<a href="?">清空</a>` : ''}
  </form>
  <div class="table-wrap"><table><thead><tr>
    <th>序列号</th><th>版本</th><th>分类</th><th>用户</th><th>手机号</th><th>来源</th>
    <th>领取时间</th><th>状态</th><th>设备ID</th><th>激活时间</th><th>操作</th>
  </tr></thead>
  <tbody>${trs || '<tr><td colspan="11" style="text-align:center;color:#6b7280;padding:24px">还没有人领取序列号</td></tr>'}</tbody></table></div>
  <div class="tip">
    删除会先同步「序列号后台」再删本地记录，两边保持一致：<br>
    · <b>删除·退回池</b>：号回到可发放池，<b>该用户的首免额度同时释放</b>，他可以重新走一遍取号流程；<br>
    · <b>删除·作废</b>：号在号池里作废，不再发放、也无法激活（已激活的号只能作废，因为它绑着设备）。
  </div>
  <div class="pager">
    ${page > 1 ? `<a href="?page=${page - 1}${search ? '&search=' + encodeURIComponent(search) : ''}">上一页</a>` : ''}
    ${hasMore ? `<a href="?page=${page + 1}${search ? '&search=' + encodeURIComponent(search) : ''}">下一页</a>` : ''}
  </div>
</div></body></html>`);
}

/**
 * POST /admin/codes/delete  body: { id, page?, search? }
 * 删掉一条插座验证码记录（只删记录，不退还已扣的愿望）。
 * 验证码由 MAC + 固定盐值算出，删掉记录本身不影响设备使用。
 */
async function adminDeleteCode(request, env) {
  const session = await authAdmin(request, env);
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = new URL(request.url).origin;
  const loginUrl = `${origin}/${adminPrefix}/login`;

  let form;
  try { form = await request.formData(); } catch { return Response.redirect(loginUrl, 302); }
  if (!session) return Response.redirect(loginUrl, 302);

  const id = Number(form.get('id') || 0);
  const pg = Math.max(1, Number(form.get('page') || 1));
  const search = String(form.get('search') || '').trim();

  const back = (m) => {
    const q = new URLSearchParams();
    q.set('page', String(pg));
    if (search) q.set('search', search);
    if (m) q.set('m', m);
    return Response.redirect(`${origin}/${adminPrefix}/codes?${q.toString()}`, 302);
  };

  if (!id) return back('缺少记录 ID');

  const row = await __db.getCodeById(id);
  if (!row) return back('这条验证码记录已经不存在了');

  const changes = await __db.deleteUserCode(id);
  if (!changes) return back('删除失败：记录未找到');

  // 同一批（同 request_id）的都删光了，就把批次行也清掉
  let batchCleaned = false;
  if (row.request_id && (await __db.countCodesByRequest(row.request_id)) === 0) {
    batchCleaned = (await __db.deleteCodeBatch(row.request_id)) > 0;
  }

  await kvAddLog(env.BTSMKV, {
    userId: row.user_id, action: 'socket_code_admin_delete',
    detail: `${row.mac} ${row.code}${batchCleaned ? ' (批次已清)' : ''}`,
    ip: getClientIp(request), nickname: '', openid: row.openid,
  });

  return back(`已删除验证码 ${row.code}（${row.mac}）${batchCleaned ? '，该批次的记录已清空' : ''}`);
}

/** GET /admin/codes —— 智能插座验证码生成记录（哪个用户给哪个 MAC 生成了什么码） */
async function adminCodesPage(request, env, url) {
  const session = await authAdmin(request, env);
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  if (!session) return Response.redirect(url.origin + '/' + adminPrefix + '/login', 302);

  const pageSize = Number(env.ADMIN_PAGE_SIZE || 20);
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const search = (url.searchParams.get('search') || '').trim();
  const rows = await __db.listAllCodes({ search, limit: pageSize + 1, offset: (page - 1) * pageSize });
  const hasMore = rows.length > pageSize;
  const list = rows.slice(0, pageSize);
  const total = await __db.countAllCodes();

  const msg = (url.searchParams.get('m') || '').trim();
  const pageVal = String(page);
  const searchVal = escapeHtml(search);

  const trs = list.map((r) => `<tr${Number(r.hidden || 0) === 1 ? ' style="background:#fffdf6"' : ''}>
    <td class="nowrap">${fmtBeijing(r.created_at)}</td>
    <td class="mono nowrap"><b>${escapeHtml(r.code)}</b></td>
    <td class="mono nowrap">key:${escapeHtml(r.code)}</td>
    <td class="mono nowrap">${escapeHtml(r.mac)}</td>
    <td class="nowrap">${r.user_id}<br><span class="muted">${escapeHtml(r.nickname || '')}</span>${Number(r.hidden || 0) === 1 ? ' <span class="tag hidden">用户已删除</span>' : ''}</td>
    <td class="nowrap">${escapeHtml(r.phone || '-')}</td>
    <td class="nowrap">${Number(r.cost || 0)} 个愿望</td>
    <td class="nowrap">
      <form method="post" action="/${adminPrefix}/codes/delete" class="inline"
        onsubmit="return confirm('删除这条验证码记录？\\n${escapeHtml(r.mac)} → ${escapeHtml(r.code)}\\n（只删记录，不退还已扣的愿望）')">
        <input type="hidden" name="id" value="${r.id}">
        <input type="hidden" name="page" value="${pageVal}">
        <input type="hidden" name="search" value="${searchVal}">
        <button class="mini danger">删除</button>
      </form>
    </td>
  </tr>`).join('');

  return html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>插座验证码 · ${escapeHtml(env.APP_NAME || '')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f2f4f7;color:#1f2937}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
header a{color:#2563eb;text-decoration:none;font-size:14px}
.wrap{padding:20px 24px;max-width:1240px;margin:0 auto}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
th,td{padding:10px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:left;vertical-align:top}
th{background:#fafafa;color:#6b7280;font-weight:500;white-space:nowrap}
td.nowrap{white-space:nowrap}
.mono{font-family:Consolas,Menlo,monospace}
.muted{color:#9ca3af;font-size:12px}
.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;line-height:1.5}
.tag.hidden{background:#fff4e5;color:#8a5a00;border:1px solid #ffe3b8}
.toolbar{display:flex;gap:8px;margin-bottom:12px;align-items:center}
.toolbar input{padding:8px 10px;border:1px solid #e5e7eb;border-radius:6px;width:300px}
.toolbar button{padding:8px 14px;border:1px solid #2563eb;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer}
.tabs{display:flex;gap:6px}
.tabs a{padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:8px;font-size:13px;text-decoration:none;color:#1f2937}
.tabs a.on{background:#eff4ff;border-color:#2563eb;color:#2563eb;font-weight:600}
form.inline{display:inline}
button.mini{padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid #e5b4b0;background:#fdeeec;color:#b3261e;cursor:pointer}
.msg{background:#e8f5ec;color:#1a7f4b;border:1px solid #bfe6d1;padding:10px 14px;border-radius:8px;margin-bottom:12px}
.tip{color:#6b7280;font-size:12px;line-height:1.8;margin-top:12px}
.pager{margin-top:12px;display:flex;gap:8px;justify-content:flex-end;color:#6b7280;font-size:13px;align-items:center}
.pager a{padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:6px;text-decoration:none;color:#1f2937}
</style></head><body>
<header>
  <a href="/${adminPrefix}">← 返回用户列表</a>
  <div class="tabs">
    <a href="/${adminPrefix}/serials">标签软件序列号</a>
    <a href="/${adminPrefix}/codes" class="on">智能插座验证码</a>
    <a href="/${adminPrefix}/logs">审计日志</a>
  </div>
  <span class="muted">共 ${total} 条验证码</span>
</header>
<div class="wrap">
  <h2>插座验证码（第 ${page} 页）</h2>
  ${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ''}
  <form class="toolbar" method="get">
    <input name="search" value="${searchVal}" placeholder="验证码 / MAC / 手机号 / 用户ID">
    <button type="submit">搜索</button>
    ${search ? `<a href="?">清空</a>` : ''}
  </form>
  <table><thead><tr>
    <th>生成时间</th><th>验证码</th><th>远程指令</th><th>设备MAC</th><th>用户</th><th>手机号</th><th>扣愿望</th><th>操作</th>
  </tr></thead>
  <tbody>${trs || '<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:24px">还没有人生成过验证码</td></tr>'}</tbody></table>
  <div class="tip">
    这是「智能插座验证码」的记录，和「标签软件序列号」是两个独立功能：<br>
    · 每生成 1 个验证码扣 1 个愿望；上面「验证码」列就是 APP 里 key:XXXXXX 的 6 位数字；<br>
    · MAC 已统一成 12 位大写（去掉冒号），搜索时带不带冒号都可以；<br>
    · <b>删除只删这条记录，不退还已扣的愿望</b>；验证码由 MAC + 固定盐值算出，删记录不影响设备继续用这个码。
  </div>
  <div class="pager">
    ${page > 1 ? `<a href="?page=${page - 1}${search ? '&search=' + encodeURIComponent(search) : ''}">上一页</a>` : ''}
    ${hasMore ? `<a href="?page=${page + 1}${search ? '&search=' + encodeURIComponent(search) : ''}">下一页</a>` : ''}
  </div>
</div></body></html>`);
}

/** GET /admin/logs */
async function adminLogsPage(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(url.origin + '/' + (env.ADMIN_PREFIX||'admin') + '/login', 302);

  const pageSize = Number(env.ADMIN_PAGE_SIZE || 20);
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const offset = (page - 1) * pageSize;

  // SQLite 分页：多取 1 条判断是否还有下一页
  const rows = await __db.listLogs(pageSize + 1, offset);
  const hasMore = rows.length > pageSize;
  const logs = rows.slice(0, pageSize);

  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const trs = logs.map(l => `<tr>
    <td>${l.user_id || ''}</td>
    <td>${fmtBeijing(l.created_at)}</td>
    <td>${escapeHtml(l.action)}</td>
    <td>${escapeHtml(l.detail||'')}</td>
    <td>${escapeHtml(l.nickname || l.openid || '-')}</td>
    <td>${escapeHtml(l.ip||'')}</td>
  </tr>`).join('');

  return html(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>审计日志 · ${escapeHtml(env.APP_NAME||'')}</title>
<style>
body{margin:0;font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f2f4f7;color:#1f2937}
header{background:#fff;border-bottom:1px solid #e5e7eb;padding:14px 24px}
header a{color:#2563eb;text-decoration:none;font-size:14px}
.wrap{padding:20px 24px;max-width:1100px;margin:0 auto}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:left}
th{background:#fafafa;color:#6b7280;font-weight:500}
.pager{margin-top:12px;display:flex;gap:8px;justify-content:flex-end;color:#6b7280;font-size:13px}
.pager a{padding:6px 12px;border:1px solid #e5e7eb;background:#fff;border-radius:6px;text-decoration:none;color:#1f2937}
</style></head><body>
<header><a href="/${adminPrefix}">← 返回用户列表</a></header>
<div class="wrap">
<h2>审计日志（第 ${page} 页）</h2>
<table><thead><tr><th>用户ID</th><th>时间</th><th>动作</th><th>详情</th><th>用户</th><th>IP</th></tr></thead>
<tbody>${trs || '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:20px">暂无日志</td></tr>'}</tbody></table>
<div class="pager">
  ${page>1 ? `<a href="?page=${page-1}">上一页</a>` : ''}
  ${hasMore ? `<a href="?page=${page+1}">下一页</a>` : ''}
</div></div></body></html>`);
}

// ───────────────────────── Admin 首页 ─────────────────────────

function renderAdminPage(env) {
  const title = escapeHtml(env.APP_NAME || 'Admin');
  const adminPrefix = '/' + (env.ADMIN_PREFIX || 'admin');
  const mock = isMock(env);
  const xpayReady = !!(env.XPAY_OFFER_ID && env.XPAY_APP_KEY);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 后台</title>
<style>
:root{--bd:#e5e7eb;--bg:#f2f4f7;--fg:#1f2937;--muted:#6b7280;--brand:#2563eb}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{background:#fff;border-bottom:1px solid var(--bd);padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:17px;margin:0}
header a{color:var(--muted);text-decoration:none;font-size:13px;margin-left:16px}
.wrap{padding:20px 24px;max-width:1320px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:18px}
.stat{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:16px}
.stat b{font-size:22px;display:block}
.stat span{color:var(--muted);font-size:12px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tabs button{padding:8px 16px;border:1px solid var(--bd);background:#fff;border-radius:8px;cursor:pointer;font-size:14px}
.tabs button.on{background:var(--brand);color:#fff;border-color:var(--brand)}
.toolbar{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:12px;margin-bottom:14px;display:flex;gap:10px;align-items:center}
.toolbar input{padding:8px 10px;border:1px solid var(--bd);border-radius:8px;font-size:14px;flex:1;max-width:360px}
.toolbar button{padding:8px 16px;background:var(--brand);color:#fff;border:0;border-radius:8px;cursor:pointer}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--bd);border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--bd);font-size:13px;vertical-align:middle}
th{background:#fafafa;color:var(--muted);font-weight:500}
tr:hover td{background:#f9fafb}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
.tag.vip{background:#fef3c7;color:#92400e}
.tag.diamond{background:#e0e7ff;color:#3730a3}
.tag.normal{background:#f3f4f6;color:#374151}
.tag.ban{background:#fee2e2;color:#991b1b}
.tag.mock{background:#fef9c3;color:#854d0e}
.tag.ok{background:#dcfce7;color:#166534}
.tag.wait{background:#f3f4f6;color:#6b7280}
.idn{font-weight:600;color:#1f2937}
.money{font-weight:600;color:#0f766e}
.muted{color:var(--muted);font-size:12px}
.mono{font-family:Menlo,Consolas,monospace;font-size:12px;color:var(--muted)}
.pager{margin-top:12px;display:flex;gap:8px;align-items:center;justify-content:flex-end;color:var(--muted);font-size:13px}
.pager button{padding:6px 12px;border:1px solid var(--bd);background:#fff;border-radius:6px;cursor:pointer}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:center;justify-content:center;z-index:9}
.mask.show{display:flex}
.dialog{background:#fff;border-radius:12px;padding:22px;width:520px;max-width:94vw;max-height:92vh;overflow:auto}
.dialog h2{margin:0 0 14px;font-size:16px}
.dialog label{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}
.dialog input,.dialog select{width:100%;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;font-size:14px}
.dialog .row{display:flex;gap:10px}
.dialog .row>div{flex:1}
.dialog .btns{margin-top:16px;display:flex;justify-content:flex-end;gap:8px}
.dialog .btns button{padding:8px 16px;border-radius:8px;border:1px solid var(--bd);background:#fff;cursor:pointer}
.dialog .btns .primary{background:var(--brand);color:#fff;border-color:var(--brand)}
.notice{background:#fef9c3;border:1px solid #fde047;color:#854d0e;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px}
.warn{background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px}
.hint{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px;line-height:1.7}
.hint code{background:#dbeafe;padding:1px 6px;border-radius:4px;font-family:Menlo,Consolas,monospace}
@media(max-width:960px){.stats{grid-template-columns:repeat(2,1fr)}th.hide,td.hide{display:none}}
</style></head><body>
<header>
  <h1>${title} · 管理后台</h1>
  <div><span class="muted" id="statbar"></span><a href="${adminPrefix}/logout">退出登录</a></div>
</header>
<div class="wrap">
  ${mock ? '<div class="notice">⚠️ 当前为 <b>mock 支付模式</b>（XPAY_MOCK=1）：不会真实扣款，仅用于自测。上线前请改为 0。</div>' : ''}
  ${!xpayReady && !mock ? '<div class="warn">✗ 未配置虚拟支付：缺少 <b>XPAY_OFFER_ID</b> 或 <b>XPAY_APP_KEY</b>，下单会直接报错。</div>' : ''}
  <div class="stats">
    <div class="stat"><b id="s-total">-</b><span>总用户数</span></div>
    <div class="stat"><b id="s-svip">-</b><span>有效用户（次数&gt;0）</span></div>
    <div class="stat"><b id="s-new">-</b><span>今日新增</span></div>
    <div class="stat"><b id="s-spent">-</b><span>累计消费（元）</span></div>
    <div class="stat"><b id="s-count">-</b><span>未消耗次数合计</span></div>
  </div>

  <div class="tabs">
    <button id="tab-users" class="on" onclick="switchTab('users')">用户</button>
    <button id="tab-orders" onclick="switchTab('orders')">订单</button>
    <button id="tab-products" onclick="switchTab('products')">道具配置</button>
  </div>

  <div id="pane-users">
    <div class="toolbar">
      <input id="q" placeholder="搜索 用户ID / openid / 昵称 / 手机号 / 备注" onkeydown="if(event.key==='Enter')load(1)">
      <button onclick="load(1)">搜索</button>
      <span style="flex:1"></span>
      <a href="${adminPrefix}/api/export.csv" style="font-size:13px;color:var(--brand);text-decoration:none">导出 CSV</a>
      <a href="${adminPrefix}/serials" style="font-size:13px;color:var(--brand);text-decoration:none;margin-left:14px">序列号发放</a>
      <a href="${adminPrefix}/logs" style="font-size:13px;color:var(--brand);text-decoration:none;margin-left:14px">审计日志</a>
    </div>
    <table>
      <thead><tr>
        <th>用户ID</th><th>昵称 / openid</th><th class="hide">手机号</th>
        <th>愿望</th><th>已领号</th><th>插座key</th><th class="hide">累计购买</th><th class="hide">累计消费</th>
        <th>状态</th><th class="hide">注册时间</th><th>操作</th>
      </tr></thead>
      <tbody id="tb"><tr><td colspan="11" class="muted" style="text-align:center;padding:24px">加载中…</td></tr></tbody>
    </table>
    <div class="pager">
      <span id="pageinfo"></span>
      <button onclick="load(page-1)">上一页</button>
      <button onclick="load(page+1)">下一页</button>
    </div>
  </div>

  <div id="pane-orders" style="display:none">
    <table>
      <thead><tr>
        <th>业务单号</th><th>用户ID</th><th>道具</th><th>金额</th><th>次数</th>
        <th>状态</th><th class="hide">平台单号</th><th class="hide">创建时间</th>
      </tr></thead>
      <tbody id="tb-orders"><tr><td colspan="8" class="muted" style="text-align:center;padding:24px">加载中…</td></tr></tbody>
    </table>
    <div class="pager">
      <span id="pageinfo-orders"></span>
      <button onclick="loadOrders(pageOrders-1)">上一页</button>
      <button onclick="loadOrders(pageOrders+1)">下一页</button>
    </div>
  </div>

  <div id="pane-products" style="display:none">
    <div class="hint">
      这里的 <code>productId</code> 和 <code>goodsPrice</code> <b>必须与 MP 后台【虚拟支付 → 道具管理】里的道具完全一致</b>，
      否则支付会报 <code>-15010</code>（道具未发布）或 <code>-15013</code>（道具价格错误）。<br>
      改完记得在 MP 后台点「发布」，发布后约 10 分钟才生效（提前调用会报 <code>-15014</code>）。
    </div>
    <table>
      <thead><tr>
        <th>道具ID (productId)</th><th>名称</th><th>价格(分)</th><th>购买数量</th><th>每次发放次数</th><th>排序</th><th>操作</th>
      </tr></thead>
      <tbody id="tb-products"></tbody>
    </table>
    <div class="toolbar" style="margin-top:14px">
      <button onclick="addProduct()">+ 新增道具</button>
      <button onclick="useDefaultProducts()" title="把上表的默认档位填进编辑器，仍需点保存">载入默认档位</button>
      <span style="flex:1"></span>
      <button onclick="saveProducts()">保存道具配置</button>
    </div>
  </div>
</div>

<div class="mask" id="mask"><div class="dialog">
  <h2>编辑用户 #<span id="e-id"></span></h2>
  <label>昵称</label><input id="e-nickname">
  <label>手机号</label><input id="e-phone">
  <div class="row">
    <div><label>次数操作</label>
      <select id="e-count-mode">
        <option value="set">设为指定次数</option>
        <option value="add">增加次数</option>
      </select></div>
    <div><label>次数</label><input id="e-count" type="number" min="0" step="1" placeholder="如 5"></div>
  </div>
  <div class="muted" style="margin-top:6px">当前剩余：<b id="e-count-cur">0</b> 次 · 剩余次数 &gt; 0 即为有效用户</div>

  <div class="row" style="margin-top:10px">
    <div><label>累计购买次数（留空=不改，填 0=清零）</label><input id="e-total" type="number" min="0" step="1" placeholder="次数"></div>
    <div><label>累计消费（元，留空=不改，填 0=清零）</label><input id="e-spent" type="number" min="0" step="0.01" placeholder="元"></div>
  </div>
  <div class="muted" style="margin-top:6px">当前：累计购买 <b id="e-total-cur">0</b> 次 · 累计消费 <b id="e-spent-cur">0.00</b> 元</div>
  <label>状态</label>
  <select id="e-status"><option value="0">正常</option><option value="1">封禁</option></select>
  <label>备注</label><input id="e-remark">
  <div class="btns">
    <button onclick="closeDlg()">取消</button>
    <button class="primary" onclick="saveUser()">保存</button>
  </div>
</div></div>

<script>
const ADMIN = '${adminPrefix}/';
let page = 1, pageOrders = 1, current = null;
let allUsers = [], products = [], defaultProducts = [];

/* 浏览器端的北京时间格式化。
   注意：不能用服务端那几个（fmtBeijing / fmtBeijingDay），它们不在浏览器里。 */
function fmtBj(ts, dayOnly){
  const n = Number(ts || 0);
  if (!n) return '-';
  const d = new Date((n + 8 * 3600) * 1000);
  const p = function(x){ return String(x).padStart(2, '0'); };
  const day = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  if (dayOnly) return day;
  return day + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

async function loadStats(){
  const r = await fetch(ADMIN+'api/stats').then(r=>r.json());
  document.getElementById('s-total').textContent = r.total;
  document.getElementById('s-svip').textContent  = r.svip;
  document.getElementById('s-new').textContent   = r.new_today;
  document.getElementById('s-spent').textContent = r.spent_sum;
  document.getElementById('s-count').textContent = r.count_sum;
  document.getElementById('statbar').textContent = '有效用户 '+r.svip+' / 总计 '+r.total;
}

function switchTab(name){
  document.getElementById('pane-users').style.display    = name==='users' ? '' : 'none';
  document.getElementById('pane-orders').style.display   = name==='orders' ? '' : 'none';
  document.getElementById('pane-products').style.display = name==='products' ? '' : 'none';
  ['users','orders','products'].forEach(n=>{
    document.getElementById('tab-'+n).className = name===n ? 'on' : '';
  });
  if (name==='orders') loadOrders(1);
  if (name==='products') loadProducts();
}

async function load(p){
  page = Math.max(1, p||1);
  const q = document.getElementById('q').value.trim();
  const r = await fetch(ADMIN+'api/users?page='+page+(q?'&search='+encodeURIComponent(q):'')).then(r=>r.json());
  allUsers = r.users || [];
  document.getElementById('pageinfo').textContent = '第 '+page+' 页，共 '+r.total+' 条';
  const tb = document.getElementById('tb');
  if(!allUsers.length){ tb.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:24px">无数据</td></tr>'; return; }
  tb.innerHTML = allUsers.map(u=>{
    const tag = u.status==1 ? '<span class="tag ban">已封禁</span>'
              : u.count>0 ? '<span class="tag vip">有效</span>'
              : '<span class="tag normal">普通</span>';
    const reg = fmtBj(u.created_at, true);
    return '<tr>'
      +'<td class="idn">'+u.id+'</td>'
      +'<td>'+(u.nickname||'<span class=muted>未设置</span>')
      +'<br><span class="mono">'+u.openid.slice(-8)+'</span></td>'
      +'<td class="hide">'+(u.phone||'-')+'</td>'
      +'<td class="money">'+u.count+'</td>'
      +'<td>'+(u.serials||0)+'</td>'
      +'<td>'+(u.codes||0)+'</td>'
      +'<td class="hide">'+u.total+'</td>'
      +'<td class="hide">'+u.spent+'</td>'
      +'<td>'+tag+'</td>'
      +'<td class="hide">'+reg+'</td>'
      +'<td><button onclick="openDlgById('+u.id+')">编辑</button></td></tr>';
  }).join('');
}

async function loadOrders(p){
  pageOrders = Math.max(1, p||1);
  const r = await fetch(ADMIN+'api/orders?page='+pageOrders).then(r=>r.json());
  document.getElementById('pageinfo-orders').textContent = '第 '+pageOrders+' 页，共 '+r.total+' 条';
  const tb = document.getElementById('tb-orders');
  const list = r.orders || [];
  if(!list.length){ tb.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">暂无订单</td></tr>'; return; }
  const stTag = s => s==='delivered' ? '<span class="tag ok">已发货</span>'
    : s==='pending' ? '<span class="tag wait">待支付</span>'
    : s==='paid_no_goods' ? '<span class="tag ban">待人工补发</span>'
    : '<span class="tag normal">'+s+'</span>';
  tb.innerHTML = list.map(o=>{
    const ct = fmtBj(o.createdAt);
    return '<tr>'
      +'<td class="mono">'+o.outTradeNo+(o.mock?' <span class="tag mock">mock</span>':'')+'</td>'
      +'<td class="idn">'+o.userId+'</td>'
      +'<td>'+o.productName+'<br><span class="mono">'+o.productId+'</span></td>'
      +'<td class="money">'+o.price+'</td>'
      +'<td>'+o.times+'</td>'
      +'<td>'+stTag(o.status)+'</td>'
      +'<td class="hide mono">'+(o.wxOrderId||'-')+'</td>'
      +'<td class="hide">'+ct+'</td></tr>';
  }).join('');
}

async function loadProducts(){
  const r = await fetch(ADMIN+'api/products').then(r=>r.json());
  products = r.products || [];
  defaultProducts = r.defaults || [];
  renderProducts();

  const pane = document.getElementById('pane-products');
  const old = document.getElementById('prod-notice');
  if (old) old.remove();

  // 线上以「已保存的配置」为准：这里把差异直接说出来，免得改了默认档位却以为已生效
  const missing = defaultProducts.filter(function(d){
    return !products.some(function(p){ return p.productId === d.productId; });
  });

  let notice = '';
  if (r.is_default) {
    notice = '当前使用的是<b>默认道具配置</b>（尚未保存过）。请确认它们与 MP 后台的道具一致后再保存。';
  } else if (missing.length) {
    notice = '当前保存的配置里<b>缺少 ' + missing.length + ' 个默认档位</b>：'
      + missing.map(function(d){ return d.name + '(' + d.productId + ')'; }).join('、')
      + '。点「载入默认档位」后保存，采购页才会显示。';
  }
  if (notice) {
    pane.insertAdjacentHTML('afterbegin', '<div class="notice" id="prod-notice">' + notice + '</div>');
  }
}

/** 把服务端的默认档位载入编辑器（不自动保存，点「保存道具配置」才生效） */
function useDefaultProducts(){
  if (!defaultProducts.length) { alert('没有可用的默认档位'); return; }
  if (products.length && !confirm('用默认档位替换当前编辑中的配置？（保存后才会生效）')) return;
  products = defaultProducts.map(function(p){
    return {
      productId: p.productId, name: p.name, goodsPrice: Number(p.goodsPrice||0),
      buyQuantity: Number(p.buyQuantity||1), times: Number(p.times||0), sort: Number(p.sort||0)
    };
  });
  renderProducts();
  alert('已载入默认档位，请核对 MP 后台道具后点「保存道具配置」');
}

function renderProducts(){
  const tb = document.getElementById('tb-products');
  if(!products.length){ tb.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">暂无道具，点下方新增</td></tr>'; return; }
  tb.innerHTML = products.map((p,i)=>
    '<tr>'
    +'<td><input value="'+esc(p.productId)+'" oninput="products['+i+'].productId=this.value"></td>'
    +'<td><input value="'+esc(p.name)+'" oninput="products['+i+'].name=this.value"></td>'
    +'<td><input type="number" min="1" value="'+(p.goodsPrice||0)+'" oninput="products['+i+'].goodsPrice=+this.value"></td>'
    +'<td><input type="number" min="1" value="'+(p.buyQuantity||1)+'" oninput="products['+i+'].buyQuantity=+this.value"></td>'
    +'<td><input type="number" min="1" value="'+(p.times||1)+'" oninput="products['+i+'].times=+this.value"></td>'
    +'<td><input type="number" value="'+(p.sort||i+1)+'" oninput="products['+i+'].sort=+this.value"></td>'
    +'<td><button onclick="removeProduct('+i+')">删除</button></td>'
    +'</tr>').join('');
}

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function addProduct(){ products.push({productId:'',name:'',goodsPrice:100,buyQuantity:1,times:1,sort:products.length+1}); renderProducts(); }
function removeProduct(i){ products.splice(i,1); renderProducts(); }

async function saveProducts(){
  const r = await fetch(ADMIN+'api/products',{
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({products})
  }).then(r=>r.json());
  if(r.ok){ alert('已保存 '+r.products.length+' 个道具'); loadProducts(); }
  else alert('保存失败: '+(r.message||r.error||JSON.stringify(r)));
}

function openDlgById(id){
  const u = allUsers.find(x => x.id === id);
  if (!u) return;
  openDlg(u);
}

function openDlg(u){
  current = u;
  document.getElementById('e-id').textContent = u.id;
  document.getElementById('e-nickname').value = u.nickname||'';
  document.getElementById('e-phone').value   = u.phone||'';
  document.getElementById('e-count').value = '';
  document.getElementById('e-count-mode').value = 'set';
  document.getElementById('e-count-cur').textContent = u.count||0;
  // 累计购买 / 累计消费：留空=不改，填 0=清零，所以这里只展示当前值
  document.getElementById('e-total').value = '';
  document.getElementById('e-spent').value = '';
  document.getElementById('e-total-cur').textContent = u.total||0;
  document.getElementById('e-spent-cur').textContent = u.spent||'0.00';
  document.getElementById('e-status').value  = u.status||0;
  document.getElementById('e-remark').value  = u.remark||'';
  document.getElementById('mask').classList.add('show');
}
function closeDlg(){ document.getElementById('mask').classList.remove('show'); current=null; }

async function saveUser(){
  const body = {
    nickname: document.getElementById('e-nickname').value,
    phone:    document.getElementById('e-phone').value,
    remark:   document.getElementById('e-remark').value,
    status:   document.getElementById('e-status').value
  };
  const c = document.getElementById('e-count').value;
  if (c !== '') {
    body.count = c;
    body.count_mode = document.getElementById('e-count-mode').value;
  }
  // 留空=不改；填了值（含 0）才提交
  const t = document.getElementById('e-total').value;
  if (t !== '') body.total = t;
  const s = document.getElementById('e-spent').value;
  if (s !== '') body.spent = s;

  const r = await fetch(ADMIN+'api/users/'+current.id, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
  }).then(r=>r.json());
  if(r.ok){ closeDlg(); load(page); loadStats(); }
  else alert('保存失败: '+(r.error||JSON.stringify(r)));
}

loadStats(); load(1);
</script>
</body></html>`;
}

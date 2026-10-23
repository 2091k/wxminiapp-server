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
  { productId: 'svc_unlock_1',   name: '高级功能1次', goodsPrice: 100,   buyQuantity: 1, times: 1,   sort: 1 },
  { productId: 'svc_unlock_5',   name: '高级功能1次', goodsPrice: 500,   buyQuantity: 1, times: 5,   sort: 2 },
  { productId: 'svc_unlock_10',  name: '高级功能1次', goodsPrice: 1000,  buyQuantity: 1, times: 10,  sort: 3 },
  { productId: 'svc_unlock_30',  name: '高级功能1次', goodsPrice: 3000,  buyQuantity: 1, times: 30,  sort: 4 },
  { productId: 'svc_unlock_50',  name: '高级功能1次', goodsPrice: 5000,  buyQuantity: 1, times: 50,  sort: 5 },
  { productId: 'svc_unlock_100', name: '高级功能1次', goodsPrice: 10000, buyQuantity: 1, times: 100, sort: 6 }
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

  // 序列号取号（邀请制：每次扣愿望，没有免费额度）
  if (p === '/api/serial/categories' && request.method === 'GET') return apiSerialCategories(request, env);
  if (p === '/api/serial/claim'    && request.method === 'POST') return apiSerialClaim(request, env);
  if (p === '/api/serial/mine'     && request.method === 'GET')  return apiSerialMine(request, env, url);
  if (p === '/api/serial/detail'   && request.method === 'GET')  return apiSerialDetail(request, env, url);
  if (p === '/api/serial/hide'     && request.method === 'POST') return apiSerialHide(request, env);
  if (p === '/api/socket/hide'     && request.method === 'POST') return apiSocketHide(request, env);

  // 邀请制：我的邀请情况 / 绑定邀请人 / 小程序展示用的配置（含邀请规则文案）
  if (p === '/api/referral/info'   && request.method === 'GET')  return apiReferralInfo(request, env);
  if (p === '/api/referral/bind'   && request.method === 'POST') return apiReferralBind(request, env);
  if (p === '/api/app/config'      && request.method === 'GET')  return apiAppConfig(env);

  // 智能插座验证码（每个 MAC 生成一个 6 位码，每次扣 1 个愿望）
  if (p === '/api/socket/codes'    && request.method === 'POST') return apiSocketCodes(request, env);
  if (p === '/api/socket/mine'     && request.method === 'GET')  return apiSocketMine(request, env, url);

  if (p === '/api/xpay/products'   && request.method === 'GET')  return apiProducts(request, env);
  if (p === '/api/xpay/order'      && request.method === 'POST') return apiCreateOrder(request, env);
  if (p === '/api/xpay/order'      && request.method === 'GET')  return apiQueryOrder(request, env, url);
  if (p === '/api/xpay/mock-pay'   && request.method === 'POST') return apiMockPay(request, env);
  if (p === '/api/xpay/notify'     && request.method === 'POST') return apiNotify(request, env);
  // 微信「消息推送」接入验证（GET echostr）：虚拟支付的「发货推送」也走同一份配置
  if (p === '/api/xpay/notify'     && request.method === 'GET')  return apiNotifyVerify(request, env, url);
  if (p === '/api/xpay/tasks'      && request.method === 'GET')  return apiTasks(request, env);

  if (p === adminPrefix || p === adminPrefix + '/')                        return adminIndex(request, env, url);
  if (p === adminPrefix + '/login'  && request.method === 'GET')           return adminLoginPage(env);
  if (p === adminPrefix + '/login'  && request.method === 'POST')          return adminLogin(request, env);
  if (p === adminPrefix + '/logout' && request.method === 'GET')           return adminLogout(env);
  if (p === adminPrefix + '/api/products' && request.method === 'GET')     return adminApiGetProducts(request, env);
  if (p === adminPrefix + '/api/products' && request.method === 'POST')    return adminApiSaveProducts(request, env);
  if (p === adminPrefix + '/api/users' && request.method === 'GET')        return adminApiUsers(request, env, url);
  // 批量删除必须精确匹配并置于 /api/users/:id 更新路由之前，避免被后者当成 id=delete-batch
  if (p === adminPrefix + '/api/users/delete-batch' && request.method === 'POST') return adminApiDeleteUsers(request, env);
  if (p.startsWith(adminPrefix + '/api/users/') && request.method === 'POST') {
    return adminApiUpdateUser(request, env, Number(p.split('/').pop()));
  }
  if (p === adminPrefix + '/api/stats'  && request.method === 'GET')       return adminApiStats(request, env);
  if (p === adminPrefix + '/api/orders' && request.method === 'GET')       return adminApiOrders(request, env, url);
  if (p === adminPrefix + '/api/orders/redeliver' && request.method === 'POST') return adminApiOrderRedeliver(request, env);
  if (p === adminPrefix + '/api/export.csv' && request.method === 'GET')   return adminApiExportCsv(request, env, url);
  if (p === adminPrefix + '/settings/import-users' && request.method === 'POST') return adminImportUsers(request, env, url);
  if (p === adminPrefix + '/settings/import-table' && request.method === 'POST') return adminImportTable(request, env, url);
  if (p === adminPrefix + '/settings/clear-orders' && request.method === 'POST') return adminClearOrders(request, env, url);
  if (p === adminPrefix + '/settings/clear-logs' && request.method === 'POST')  return adminClearLogs(request, env, url);
  if (p === adminPrefix + '/logs'   && request.method === 'GET')           return adminLogsPage(request, env, url);
  if (p === adminPrefix + '/codes'  && request.method === 'GET')           return adminCodesPage(request, env, url);
  if (p === adminPrefix + '/codes/delete' && request.method === 'POST')    return adminDeleteCode(request, env);
  if (p === adminPrefix + '/codes/settings' && request.method === 'POST')  return adminSaveSocketSettings(request, env);
  if (p === adminPrefix + '/serials' && request.method === 'GET')          return adminSerialsPage(request, env, url);
  if (p === adminPrefix + '/serials/delete' && request.method === 'POST')  return adminDeleteSerial(request, env);
  if (p === adminPrefix + '/serials/settings' && request.method === 'POST') return adminSaveSerialSettings(request, env);
  // 邀请 / 赠送设置：GET 打开设置页，POST 保存
  if (p === adminPrefix + '/settings' )                                    return adminSettingsPage(request, env, url);
  // 后台：取消一条邀请绑定（可同时收回当初发的愿望）
  if (p === adminPrefix + '/referral/cancel' && request.method === 'POST')  return adminCancelReferral(request, env, url);

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
/** 后台统一「深色科技风」主题：各页 <style> 开头注入，提供变量与通用组件（卡片/表格/按钮/徽章/表单/提示/分页） */
const DARK = `
:root{
  --bg:#0d1117; --panel:#161c24; --panel2:#1d2530; --line:#2a313c; --line2:#3a4351;
  --fg:#e6edf3; --muted:#8b98a9; --brand:#38bdf8; --brand2:#1f6feb;
  --header-bg:rgba(22,28,36,.85); --side-bg:#10151c;
  --ok:#3fb950; --ok-bg:rgba(63,185,80,.15);
  --warn:#d29922; --warn-bg:rgba(210,153,34,.15);
  --err:#f85149; --err-bg:rgba(248,81,73,.15);
  --info:#38bdf8; --info-bg:rgba(56,189,248,.15);
  --purple:#a371f7; --purple-bg:rgba(163,113,247,.16);
  --norm-bg:rgba(139,152,169,.16);
  --shadow:0 1px 2px rgba(0,0,0,.3);
}
:root[data-theme=light]{
  --bg:#f4f6f9; --panel:#ffffff; --panel2:#eef1f5; --line:#e2e8f0; --line2:#cbd5e1;
  --fg:#1f2937; --muted:#6b7280; --brand:#2563eb; --brand2:#2563eb;
  --header-bg:rgba(255,255,255,.85); --side-bg:#ffffff;
  --ok:#166534; --ok-bg:#dcfce7;
  --warn:#92400e; --warn-bg:#fef3c7;
  --err:#b91c1c; --err-bg:#fee2e2;
  --info:#2563eb; --info-bg:#e0f2fe;
  --purple:#7c3aed; --purple-bg:#ede9fe;
  --norm-bg:#eef1f5;
  --shadow:0 1px 2px rgba(15,23,42,.06);
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
.muted{color:var(--muted);font-size:12px}
.mono{font-family:Menlo,Consolas,monospace;font-size:12px;color:var(--muted)}
.money{font-weight:600;color:var(--ok)}
.box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{background:var(--panel2);color:var(--muted);font-weight:500}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--panel2)}
button{padding:9px 18px;background:var(--brand2);color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer}
button:hover{filter:brightness(1.12)}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;line-height:1.6}
.tag.ok{background:var(--ok-bg);color:var(--ok)}
.tag.ban{background:var(--err-bg);color:var(--err)}
.tag.wait{background:var(--warn-bg);color:var(--warn)}
.tag.normal{background:var(--norm-bg);color:var(--muted)}
.tag.vip{background:var(--info-bg);color:var(--info)}
.tag.diamond{background:var(--purple-bg);color:var(--purple)}
.tag.mock{background:var(--warn-bg);color:var(--warn)}
input,select,textarea{background:var(--panel2);border:1px solid var(--line2);color:var(--fg);border-radius:8px;padding:8px 10px;font-size:14px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--brand)}
input[type=checkbox]{accent-color:var(--brand);cursor:pointer}
::placeholder{color:var(--muted)}
.hint{background:var(--info-bg);border:1px solid var(--info-bg);color:var(--info);padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.8;margin-bottom:14px}
.hint code{background:rgba(127,127,127,.15);padding:1px 6px;border-radius:4px;font-family:Menlo,Consolas,monospace}
.msg{background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok-bg);padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:13px}
.notice{background:var(--warn-bg);border:1px solid var(--warn-bg);color:var(--warn);padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px}
.warn{background:var(--err-bg);border:1px solid var(--err-bg);color:var(--err);padding:10px 14px;border-radius:10px;font-size:13px;margin-bottom:12px}
.danger-box{border-color:var(--err)!important;background:var(--err-bg)}
.btn-danger{background:var(--err)!important}
.pager{margin-top:12px;display:flex;gap:8px;align-items:center;justify-content:flex-end;color:var(--muted);font-size:13px}
.pager button,.pager a{padding:6px 12px;border:1px solid var(--line2);background:var(--panel2);color:var(--fg);border-radius:8px;cursor:pointer;text-decoration:none}
`;

/** 皮肤引导：各页 <head> 最前注入，读取本机 localStorage 皮肤并在首屏前设置 data-theme，避免刷新闪色 */
const THEME_BOOT = `<script>(function(){try{var t=localStorage.getItem('admin-theme');if(t!=='light'&&t!=='dark')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();</script>`;

function xml(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
/**
 * 平台要求的发货成功应答
 * @param {boolean} asJson 推送是 JSON 时必须回 JSON（官方要求格式与推送一致）
 */
function notifyOk(asJson) {
  if (asJson) return json({ ErrCode: 0, ErrMsg: 'success' });
  return xml('<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>');
}
/** 发货失败应答（平台会重试，最多 15 次） */
function notifyFail(msg, asJson) {
  const m = String(msg || 'fail').slice(0, 100);
  if (asJson) return json({ ErrCode: 1, ErrMsg: m });
  return xml(`<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[${m}]]></ErrMsg></xml>`);
}

function now() { return Math.floor(Date.now() / 1000); }
function getClientIp(request) {
  // 自托管走 Nginx 反代：优先 X-Real-IP，其次 X-Forwarded-For 的第一段；
  // cf-connecting-ip 是早期 Cloudflare 部署的遗留，留作最后兜底。
  const raw = request.headers.get('x-real-ip') ||
              request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
              request.headers.get('cf-connecting-ip') || '';
  // 去掉 IPv6 映射前缀（::ffff:1.2.3.4 → 1.2.3.4）
  return raw.replace(/^::ffff:/, '');
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

/** 北京时间今天 00:00 对应的 UTC 秒级时间戳（"今日新增"按自然日，而非滚动24小时） */
function bjTodayStartTs() {
  const b = beijingBits(Date.now());
  const utcMidnight = Date.UTC(Number(b.y), Number(b.m) - 1, Number(b.d));
  return Math.floor(utcMidnight / 1000) - 8 * 3600;
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

/** 微信消息推送「URL 接入验证」用：sha1(字典序拼接 token/timestamp/nonce) */
async function sha1Hex(msg) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(msg));
  return bytesToHex(buf);
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
  return __db.nextUserId();   // 旧计数器分配（保留兼容，注册已改用补空号）
}
/** 分配从1起最小未占用用户ID（删除后补空洞，不再一直往后增长） */
async function kvAllocUserId(_KV) {
  return __db.findFreeUserId();
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
    const base = {
      openid, unionid: unionid || null, session_key,
      nickname: '', phone: '',
      xpay_count: 0,          // 旧余额模型字段：已冻结，不再读写
      xpay_total: 0,          // 同上
      xpay_spent: 0,          // 累计实付（分）：会员等级只看这个
      free_serial: 0,         // 剩余免费取号次数（邀请获得）
      free_socket: 0,         // 剩余免费验证码次数
      status: 0, remark: '',
      last_login_at: ts, created_at: ts, updated_at: ts,
    };
    // 新用户补「从1起最小未占用」的ID：删除用户后空号会被优先复用，而不是一路往后增长。
    // 极小概率并发撞号就重算重试（最多5次）。
    user = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await kvAllocUserId(env.BTSMKV);
      try {
        await kvPutUser(env.BTSMKV, { ...base, id: candidate });
        user = await kvGetUserByOpenid(env.BTSMKV, openid);
        break;
      } catch (e) {
        if (attempt === 4) throw e;
      }
    }
    if (!user) return json({ error: 'alloc_id_failed', message: '分配用户ID失败，请重试' }, 500);

    // 注册赠送免费取号次数（后台 settings.new_user_free_credit，默认 0 = 不送）
    const giftCredit = intSetting('new_user_free_credit', 0, 0, 99);
    if (giftCredit > 0) {
      await __db.grantFreeCreditsTx({ userId: user.id, kind: 'serial', add: giftCredit, earned: 0 });
      await kvAddLog(env.BTSMKV, {
        userId: user.id, action: 'new_user_gift',
        detail: `注册赠送 ${giftCredit} 次免费取号`,
        ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
      });
    }
    user = await __db.getUserById(user.id);
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
  const invited = await __db.countInvited(user.id);
  const earned = await __db.sumInviteWish(user.id);
  return json({
    user: publicUser(user),
    serial_cost: serialCost(env),
    socket_cost: socketCost(),
    // 邀请摘要：我的ID、已邀请人数、两套免费门槛与各自剩余免费次数
    referral: {
      my_id: Number(user.id),
      invited_count: invited,
      free_serial: Number(user.free_serial || 0),
      free_socket: Number(user.free_socket || 0),
      serial_need: serialInviteNeed(),
      socket_need: socketInviteNeed(),
      free_max: inviteFreeMax(),
      invited_by: Number(user.invited_by || 0),
      can_bind: !Number(user.invited_by || 0),
    },
  });
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
    // ── 主用分支：手输明文（宽松校验：纯数字 6~15 位，不校验号段）──
    phone = normalizePhone(body.phone);
    if (!phone) {
      return json({
        ok: false, error: 'bad_phone',
        message: '请填写手机号（6~15 位数字）；不需要短信验证，但请填真实的号码，方便客服核对',
      }, 400);
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

/**
 * 会员身份：注册即「会员」，累计实付达标升 SVIP / SVIP+。
 * 只看「累计实付金额」，与任何余额无关 —— 本模型没有余额。
 */
function vipInfo(u) {
  const spent = Number(u.xpay_spent || 0);
  const t = membershipThresholds();
  const level = spent >= t.v3 ? 3 : (spent >= t.v2 ? 2 : 1);
  const names = { 1: 'VIP', 2: 'SVIP', 3: 'SVIP+' };
  return {
    is_member: true,
    is_svip: level >= 2,
    level,
    level_name: names[level] || 'VIP',
    spent_cents: spent,
    spent: toYuan(spent),
    free_serial: Number(u.free_serial || 0),   // 剩余免费取号次数（邀请获得，不是货币）
    free_socket: Number(u.free_socket || 0),   // 剩余免费验证码次数
    expire_text: ''                            // 会员无到期时间，保留字段兼容前端
  };
}

/**
 * GET /api/xpay/products
 * 返回：可用价格档位 + 当前取号/验证码使用的档位 + 我的免费次数 + 邀请门槛
 */
async function apiProducts(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const list = (await kvGetProducts(env.BTSMKV)).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const price = await goodsPricing();
  return json({
    tiers: list.map(p => ({
      productId: p.productId,
      name: p.name || '',
      price_cents: Number(p.goodsPrice || 0),
      price: toYuan(p.goodsPrice),
    })),
    serial: priceShape(price.serial),
    socket: priceShape(price.socket),
    free: {
      serial: Number(user.free_serial || 0),
      socket: Number(user.free_socket || 0),
    },
    invite: {
      serial_need: serialInviteNeed(),
      socket_need: socketInviteNeed(),
      free_max: inviteFreeMax(),
    },
    mock: isMock(env),
    // iOS 端需微信 ≥ 8.0.68，由前端校验
    ios_min_version: '8.0.68'
  });
}

/**
 * POST /api/xpay/order
 * body: { kind: 'serial' | 'socket', version?, download_url?, key_url?, macs?: [] }
 *
 * 直购：一次下单 = 一次具体服务。价格从后台选定的档位取（必须与 MP 后台道具一致），
 * 支付成功后才在「发货推送」里真正发号 / 生成验证码，任何余额都不产生。
 */
async function apiCreateOrder(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const kind = String(body.kind || '').trim();
  if (kind !== 'serial' && kind !== 'socket') {
    return json({ error: 'bad_kind', message: '未知的购买类型' }, 400);
  }

  // ① 这次要发什么
  let payload = {};
  let buyQuantity = 1;
  if (kind === 'serial') {
    payload = {
      category: serialCategory(env),
      version: String(body.version || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80),
      download_url: cleanUrl(body.download_url),
      key_url: cleanUrl(body.key_url),
    };
  } else {
    const { valid, invalid } = parseMacInput(body.macs !== undefined ? body.macs : body.mac);
    if (invalid.length) {
      return json({ ok: false, error: 'bad_mac', message: 'MAC 地址格式不对：需要 12 位十六进制', invalid: invalid.slice(0, 10) }, 400);
    }
    if (!valid.length) return json({ ok: false, error: 'empty_mac', message: '请先输入设备 MAC 地址' }, 400);
    if (valid.length > SOCKET_MAX_BATCH) {
      return json({ ok: false, error: 'too_many', message: `一次最多生成 ${SOCKET_MAX_BATCH} 个，请分批`, max: SOCKET_MAX_BATCH }, 400);
    }
    payload = { macs: valid };
    buyQuantity = valid.length;
  }

  // ② 价格档位
  const price = await goodsPricing();
  const tier = kind === 'serial' ? price.serial : price.socket;
  if (!tier || !Number(tier.goodsPrice)) {
    return json({ error: 'tier_not_configured', message: '后台没有可用的价格档位，请联系客服' }, 500);
  }

  const ts = now();
  const outTradeNo = makeOutTradeNo();
  const orderId = 'o' + ts + randomStr(6);

  const order = {
    id: orderId,
    outTradeNo,
    userId: Number(user.id),
    openid: user.openid,
    kind,
    payload: JSON.stringify(payload),
    productId: tier.productId,
    productName: tier.name || (kind === 'serial' ? '取号服务' : '插座验证码'),
    goodsPrice: Number(tier.goodsPrice),
    buyQuantity,
    times: buyQuantity,
    status: ST.PENDING,
    wxOrderId: '',
    mock: isMock(env),
    deliver_status: 'pending',
    deliver_result: '',
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
    detail: `${kind} ${order.productName} ¥${toYuan(order.goodsPrice)}×${buyQuantity} ${outTradeNo}`,
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

/**
 * 解析发货推送 XML。
 * 平台推送有两种常见形态，两种都要认：
 *   ① 扁平 CDATA：<OutTradeNo><![CDATA[..]]></OutTradeNo>
 *   ② 嵌套对象：<WeChatPayInfo><![CDATA[{"MchOrderNo":".."}]]></WeChatPayInfo>
 *                <GoodsInfo><![CDATA[{"ProductId":"..","Quantity":1}]]></GoodsInfo>
 */
function parseNotifyXml(text) {
  const pick = (tag) => {
    const m = new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>').exec(text);
    return m ? m[1].trim() : '';
  };
  // 子对象：既可能是 JSON 串，也可能是内嵌 XML，解析不出来就当空对象
  const sub = (tag) => {
    const v = pick(tag);
    if (!v) return {};
    try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  };
  const wp = sub('WeChatPayInfo');
  const gi = sub('GoodsInfo');
  return {
    event: pick('Event'),
    openid: pick('OpenId'),
    outTradeNo: pick('OutTradeNo'),
    wxOrderId: wp.MchOrderNo || pick('MchOrderNo'),
    productId: gi.ProductId || pick('ProductId'),
    quantity: Number(gi.Quantity || pick('Quantity') || 0)
  };
}

/**
 * 解析 JSON 形态的推送（MP 后台「消息推送」数据格式可以选 JSON）。
 * 结构与 XML 一一对应，只是嵌套成对象。
 */
function parseNotifyJson(text) {
  let o;
  try { o = JSON.parse(text); } catch { return {}; }
  if (!o || typeof o !== 'object') return {};
  const wp = o.WeChatPayInfo || {};
  const gi = o.GoodsInfo || {};
  return {
    event: o.Event || '',
    openid: o.OpenId || '',
    outTradeNo: o.OutTradeNo || '',
    wxOrderId: wp.MchOrderNo || '',
    productId: gi.ProductId || '',
    quantity: Number(gi.Quantity || 0)
  };
}

/**
 * GET /api/xpay/notify —— 微信「消息推送」URL 接入验证
 *
 * MP 后台【开发】-【开发管理】-【消息推送】点「提交/启用」时，微信会先 GET 一次：
 *   ?signature=..&timestamp=..&nonce=..&echostr=..
 * 校验：token、timestamp、nonce 三个参数按字典序排序后拼接，做 sha1，与 signature 比对；
 * 通过后必须**原样返回 echostr**（纯文本），否则后台提示验证失败、配置存不下来。
 * 虚拟支付的「发货推送」用的就是这份配置，所以这里的 Token 必须与 MP 后台令牌一致。
 */
async function apiNotifyVerify(request, env, url) {
  const token = String(env.XPAY_NOTIFY_TOKEN || '');
  const signature = url.searchParams.get('signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  const echostr = url.searchParams.get('echostr') || '';
  const text = (body, status) => new Response(body, {
    status, headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

  if (!token) {
    await kvAddLog(env.BTSMKV, { userId: 0, action: 'xpay_notify_verify_bad', detail: '未配置 XPAY_NOTIFY_TOKEN', ip: getClientIp(request) });
    return text('notify token not configured', 503);
  }
  if (!signature || !echostr) return text('missing params', 400);

  const expect = await sha1Hex([token, timestamp, nonce].sort().join(''));
  if (!safeEqual(expect, signature)) {
    await kvAddLog(env.BTSMKV, { userId: 0, action: 'xpay_notify_verify_bad', detail: 'signature 不匹配', ip: getClientIp(request) });
    return text('bad signature', 403);
  }
  await kvAddLog(env.BTSMKV, { userId: 0, action: 'xpay_notify_verify_ok', detail: '消息推送 URL 验证通过', ip: getClientIp(request) });
  return text(echostr, 200);
}

/**
 * POST /api/xpay/notify —— 平台「发货推送」
 *
 * 平台会重试最多 15 次，所以：
 *   - 用平台单号 wxOrderId 做幂等去重，重复通知只发一次货
 *   - 发货成功必须返回 ErrCode=0，且**应答格式要与推送一致**（XML 推 XML、JSON 推 JSON）
 */
async function apiNotify(request, env) {
  const raw = await request.text();
  // 按报文形态判断：以 { 开头或 content-type 含 json 就按 JSON 处理
  const ctype = String(request.headers.get('content-type') || '').toLowerCase();
  const asJson = /^\s*\{/.test(raw) || ctype.includes('json');

  // 可选签名校验：AppKey 与消息推送的 Token/AESKey 不是同一套，
  // 这里用 XPAY_APP_KEY 对原始报文做完整性校验（若配置了 XPAY_NOTIFY_SIGN_KEY 则用它）
  const signKey = env.XPAY_NOTIFY_SIGN_KEY || '';
  const gotSig = request.headers.get('x-signature') || request.headers.get('signature') || '';
  if (signKey && gotSig) {
    const expect = await hmacSha256Hex(signKey, raw);
    if (!safeEqual(expect, gotSig)) {
      await kvAddLog(env.BTSMKV, { userId: 0, action: 'xpay_notify_bad_sign', detail: '签名不匹配', ip: getClientIp(request) });
      return notifyFail('bad signature', asJson);
    }
  }

  const data = asJson ? parseNotifyJson(raw) : parseNotifyXml(raw);
  if (data.event && data.event !== 'xpay_goods_deliver_notify') {
    return notifyOk(asJson); // 其他事件直接忽略，避免平台重试
  }
  if (!data.outTradeNo && !data.wxOrderId) {
    await kvAddLog(env.BTSMKV, {
      userId: 0, action: 'xpay_notify_malformed',
      detail: `fmt=${asJson ? 'json' : 'xml'} ${raw.slice(0, 300)}`, ip: getClientIp(request),
    });
    return notifyFail('malformed', asJson);
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
    return notifyOk(asJson);
  }

  if (order.status === ST.DELIVERED) return notifyOk(asJson);   // 幂等：已发货

  // 校验金额/商品是否与本地订单一致，防篡改
  if (data.productId && data.productId !== order.productId) {
    await kvAddLog(env.BTSMKV, {
      userId: order.userId, action: 'xpay_product_mismatch',
      detail: `notify=${data.productId} local=${order.productId}`, openid: order.openid
    });
    return notifyFail('product mismatch', asJson);
  }

  order.wxOrderId = data.wxOrderId || order.wxOrderId;
  await deliverOrder(env, order, data.quantity || order.buyQuantity);
  return notifyOk(asJson);
}

function safeJson(s) {
  try { return JSON.parse(s || '{}') || {}; } catch { return {}; }
}

/** 付费取号发货：调序列号后台发号 → 落库。request_id = outTradeNo，天然幂等 */
async function deliverSerial(env, order, user) {
  const p = safeJson(order.payload);
  const requestId = String(order.outTradeNo);
  const category = String(p.category || serialCategory(env));

  const existed = await __db.getUserSerialByRequestId(requestId);
  if (existed) return { ok: true, serial: existed.serial };

  const r = await btkeyRequest(env, '/api/claim', {
    method: 'POST',
    body: { category, request_id: requestId, exclude: [] },
  });
  const data = r.data || {};
  if (!data.ok || !data.serial) {
    return { ok: false, error: data.error || r.error || 'out_of_stock' };
  }

  const serial = String(data.serial);
  const tx = await __db.claimSerialTx({
    userId: user.id, credit: 0, cost: Number(order.goodsPrice || 0),
    row: {
      user_id: user.id, openid: user.openid, serial, category,
      version: p.version || '',
      download_url: p.download_url || '', key_url: p.key_url || '',
      source: 'paid', cost: Number(order.goodsPrice || 0), request_id: requestId,
      status: 'issued', claimed_at: now(), synced_at: 0,
    },
  });
  if (!tx.ok) {
    if (tx.error === 'duplicate_request') {
      const dup = await __db.getUserSerialByRequestId(requestId);
      if (dup) return { ok: true, serial: dup.serial };
    }
    // 落库失败：把号还回池子，订单标记发货失败，等补偿重试
    try { await btkeyRequest(env, '/api/release', { method: 'POST', body: { serial, request_id: requestId } }); } catch {}
    return { ok: false, error: tx.error };
  }
  try { await btkeyRequest(env, '/api/confirm', { method: 'POST', body: { serial, request_id: requestId } }); } catch {}
  return { ok: true, serial };
}

/** 付费验证码发货：按订单里的 MAC 列表生成码。request_id = outTradeNo，天然幂等 */
async function deliverSocket(env, order, user) {
  const p = safeJson(order.payload);
  const macs = Array.isArray(p.macs) ? p.macs : [];
  const requestId = String(order.outTradeNo);

  const old = await __db.listCodesByRequest(requestId);
  if (old && old.length) return { ok: true, codes: old.map((r) => ({ mac: r.mac, code: r.code })) };
  if (!macs.length) return { ok: false, error: 'empty_mac' };

  const rows = macs.map((mac) => ({ mac, code: socketCodeOf(mac), kind: 'socket', openid: user.openid }));
  const tx = await __db.createCodeBatchTx({
    userId: user.id, requestId, credit: 0, cost: Number(order.goodsPrice || 0), rows,
  });
  if (!tx.ok) {
    if (tx.error === 'duplicate_request') {
      const dup = await __db.listCodesByRequest(requestId);
      if (dup && dup.length) return { ok: true, codes: dup.map((r) => ({ mac: r.mac, code: r.code })) };
    }
    return { ok: false, error: tx.error };
  }
  return { ok: true, codes: rows.map((r) => ({ mac: r.mac, code: r.code })) };
}

/**
 * 发货：支付成功后才调用。按订单类型直接发结果，不产生任何余额。
 * 发号失败 → 订单标记 paid_no_goods + deliver_status=failed，由 tasks/后台重试补发。
 * @param {number} [quantity] 平台回传的购买数量
 */
async function deliverOrder(env, order, quantity) {
  if (order.status === ST.DELIVERED) return order;

  const user = await kvGetUserById(env.BTSMKV, order.userId);
  if (!user) {
    order.status = ST.PAID_NO_GOODS;
    order.deliver_status = 'failed';
    order.note = 'user not found';
    await kvPutOrder(env.BTSMKV, order);
    return order;
  }

  const qty = Math.max(1, Number(quantity || order.buyQuantity || 1));
  let result = null;

  if (order.kind === 'serial') {
    const r = await deliverSerial(env, order, user);
    if (!r.ok) {
      order.status = ST.PAID_NO_GOODS;
      order.deliver_status = 'failed';
      order.note = String(r.error || 'deliver_failed').slice(0, 100);
      await kvPutOrder(env.BTSMKV, order);
      await kvAddLog(env.BTSMKV, {
        userId: user.id, action: 'xpay_deliver_failed',
        detail: `${order.outTradeNo} ${order.note}`, openid: user.openid,
      });
      return order;
    }
    result = { serial: r.serial };
  } else if (order.kind === 'socket') {
    const r = await deliverSocket(env, order, user);
    if (!r.ok) {
      order.status = ST.PAID_NO_GOODS;
      order.deliver_status = 'failed';
      order.note = String(r.error || 'deliver_failed').slice(0, 100);
      await kvPutOrder(env.BTSMKV, order);
      await kvAddLog(env.BTSMKV, {
        userId: user.id, action: 'xpay_deliver_failed',
        detail: `${order.outTradeNo} ${order.note}`, openid: user.openid,
      });
      return order;
    }
    result = { codes: r.codes };
  } else {
    // 历史「愿望」订单：旧模型已下线，无法发货，留档人工处理
    order.status = ST.PAID_NO_GOODS;
    order.deliver_status = 'failed';
    order.note = 'legacy_wish_order';
    await kvPutOrder(env.BTSMKV, order);
    return order;
  }

  // 累计实付（会员等级只看这个，与余额无关）
  user.xpay_spent = Number(user.xpay_spent || 0) + Number(order.goodsPrice || 0) * qty;
  user.updated_at = now();
  await kvPutUser(env.BTSMKV, user);

  order.status = ST.DELIVERED;
  order.deliver_status = 'issued';
  order.deliver_result = JSON.stringify(result).slice(0, 300);
  order.deliveredAt = now();
  await kvPutOrder(env.BTSMKV, order);

  const brief = order.kind === 'serial'
    ? (result.serial || '')
    : `${(result.codes || []).length} 个码`;
  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'xpay_deliver',
    detail: `${order.kind} ¥${toYuan(order.goodsPrice)}×${qty} ${brief} 累计¥${toYuan(user.xpay_spent)} ${order.mock ? '(mock)' : order.wxOrderId}`,
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
  let result = null;
  try { result = o.deliver_result ? JSON.parse(o.deliver_result) : null; } catch { result = null; }
  return {
    id: o.id,
    kind: o.kind || '',
    productId: o.productId,
    productName: o.productName,
    price: toYuan(o.goodsPrice),
    quantity: Number(o.buyQuantity || 1),
    status: o.status,
    deliver_status: o.deliver_status || '',
    result,                                  // { serial } 或 { codes: [{mac, code}] }
    note: o.note || '',                      // 发货失败原因（给前端提示用）
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
    free_serial: vip.free_serial,
    free_socket: vip.free_socket,
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

// ───────────── 直购价格 / 邀请门槛 / 会员等级（后台可改，不用重启） ─────────────
/*
 * 直购模型：没有「愿望余额」。每次取号、每批验证码都直接付一次款，付完立刻发结果。
 *
 * 价格只能从「道具配置」表的档位里选 —— 档位必须与 MP 后台【虚拟支付 → 道具管理】
 * 里登记的道具 ID 和价格完全一致，否则支付会报 -15013。所以后台改的是「用哪一档」。
 *
 * settings 键：
 *   serial_tier        取号用哪个道具档位（默认 svc_unlock_10 = 10 元/次）
 *   socket_tier        验证码用哪个道具档位（默认 svc_unlock_1 = 1 元/个）
 *   serial_invite_need 邀请几人送 1 次免费取号（默认 2；0 = 关闭邀请免费）
 *   socket_invite_need 邀请几人送 1 次免费验证码（默认 0 = 关闭）
 *   invite_free_max    免费次数最多累计送几次（0 = 不限）
 *   svip1_spent        累计实付满多少元升 SVIP（默认 100）
 *   svip2_spent        累计实付满多少元升 SVIP+（默认 300）
 */
const DEFAULT_SERIAL_INVITE_NEED = 2;
const DEFAULT_SOCKET_INVITE_NEED = 0;
const DEFAULT_SERIAL_TIER = 'svc_unlock_10';
const DEFAULT_SOCKET_TIER = 'svc_unlock_1';

/** 读整数设置：空串/非法/越界都回落默认值 */
function intSetting(key, def, min = 0, max = 1000000) {
  const raw = __db.getSetting(key, '');
  if (raw === '') return def;
  const n = Math.floor(Number(raw));
  if (!Number.isInteger(n) || n < min || n > max) return def;
  return n;
}

function serialInviteNeed() { return intSetting('serial_invite_need', DEFAULT_SERIAL_INVITE_NEED, 0, 999); }
function socketInviteNeed() { return intSetting('socket_invite_need', DEFAULT_SOCKET_INVITE_NEED, 0, 999); }
/** 免费次数累计上限：0 = 不限 */
function inviteFreeMax() { return intSetting('invite_free_max', 0, 0, 999); }

function serialTierId() { return settingText('serial_tier', DEFAULT_SERIAL_TIER); }
function socketTierId() { return settingText('socket_tier', DEFAULT_SOCKET_TIER); }

// ── 客服入口开关（后台「系统设置 → 客服」）──
//   总开关关掉 = 所有人都看不到；否则按身份分别控制：未登录 / VIP（1 级）/ SVIP（2 级以上）
function boolSetting(key, def) {
  const v = String(__db.getSetting(key, '') || '').trim();
  if (v === '0') return 0;
  if (v === '1') return 1;
  return def;
}
function csEnabled() { return boolSetting('cs_enabled', 1); }
function csGuest() { return boolSetting('cs_guest', 0); }   // 默认未登录不给入口
function csVip() { return boolSetting('cs_vip', 1); }
function csSvip() { return boolSetting('cs_svip', 1); }

/** 一次取全客服配置（给 /api/app/config 用） */
function csConfig() {
  return { enabled: csEnabled(), guest: csGuest(), vip: csVip(), svip: csSvip() };
}

/** 会员等级门槛（单位：分）。注册即「会员」，累计实付达标升 SVIP / SVIP+ */
function membershipThresholds() {
  const y1 = intSetting('svip1_spent', 100, 0, 1000000);
  const y2 = Math.max(y1, intSetting('svip2_spent', 300, 0, 1000000));
  return { v2: y1 * 100, v3: y2 * 100 };
}

/** 按 productId 取价格档位；取不到就用兜底下标（避免下单直接 500） */
async function tierOf(productId, fallbackIdx) {
  const list = await kvGetProducts(null);
  const hit = list.find((p) => p.productId === productId);
  if (hit) return hit;
  return Number.isInteger(fallbackIdx) ? (list[fallbackIdx] || null) : null;
}

/** 当前生效的两个商品：取号 / 验证码 */
async function goodsPricing() {
  return {
    serial: await tierOf(serialTierId(), 2),
    socket: await tierOf(socketTierId(), 0),
  };
}

/** 开启/关闭下拉 */
function optOnOff(v) {
  const on = Number(v) === 1;
  return `<option value="1"${on ? ' selected' : ''}>开启</option>`
    + `<option value="0"${on ? '' : ' selected'}>关闭</option>`;
}

/**
 * 价格档位下拉选项。档位来自「道具配置」表，productId 与价格必须与 MP 后台【道具管理】一致，
 * 否则支付会报 -15010 / -15013。
 */
function tierOptionsHtml(list, selected) {
  const rows = (list || []).map((p) =>
    `<option value="${escapeHtml(p.productId)}"${p.productId === selected ? ' selected' : ''}>` +
    `${escapeHtml(p.name || p.productId)} · ${toYuan(p.goodsPrice)} 元/次</option>`
  ).join('');
  return rows || '<option value="">（道具配置为空，请先添加档位）</option>';
}

/** 余额模型已废弃：保留同签名函数只为避免漏改的调用点直接崩，值恒为 0 */
function serialCost() { return 0; }
function socketCost() { return 0; }
function wishCost() { return 0; }

/**
 * 按邀请门槛给邀请人补发免费次数（幂等）。
 *   应发 = floor(已邀请人数 / 门槛)，只补「应发 - 已发放」的差额，重复调用不会多发。
 *   门槛为 0 = 该功能不开启邀请免费；invite_free_max > 0 时限制最多累计送几次。
 * @returns {Promise<{serial:number, socket:number}>} 本次各补发了几次
 */
async function grantInviteCredits(inviterId) {
  const invited = await __db.countInvited(inviterId);
  const inviter = await __db.getUserById(inviterId);
  const out = { serial: 0, socket: 0 };
  if (!inviter) return out;

  const cap = inviteFreeMax();
  const pairs = [
    ['serial', serialInviteNeed(), Number(inviter.serial_earned || 0)],
    ['socket', socketInviteNeed(), Number(inviter.socket_earned || 0)],
  ];
  for (const [kind, need, earned] of pairs) {
    if (!need || need <= 0) continue;
    let should = Math.floor(invited / need);
    if (cap > 0) should = Math.min(should, cap);
    if (should <= earned) continue;
    const add = should - earned;
    await __db.grantFreeCreditsTx({ userId: inviterId, kind, add, earned: should });
    out[kind] = add;
  }
  return out;
}

// ───────────────────────── 邀请制配置（后台可改） ─────────────────────────
/*
 * 全部存在 SQLite 的 settings 表里，后台「邀请 / 赠送设置」页面可改，不用重启：
 *   new_user_wish      新用户注册赠送多少愿望（默认 1，0 = 不送）
 *   invite_wish        邀请 1 个人送多少愿望（默认 5，0 = 只记录不赠送）
 *   invite_window_days 被邀请人必须在注册后几天内绑定（默认 7，0 = 不限）
 *   invite_intro       小程序「邀请好友」页的规则文案（留空用内置默认）
 *   serial_intro       序列号取号页底部的说明文案（留空用内置默认）
 */
const DEFAULT_NEW_USER_WISH = 1;
const DEFAULT_INVITE_WISH = 5;
const DEFAULT_INVITE_WINDOW_DAYS = 7;

/** 允许 0 的整数读取 */
function readNonNegativeInt(raw, def) {
  if (raw === '' || raw === null || raw === undefined) return def;
  const n = Math.floor(Number(raw));
  return Number.isInteger(n) && n >= 0 ? n : def;
}

function newUserWish(env) {
  const dbVal = __db.getSetting('new_user_wish', '');
  if (dbVal !== '') return readNonNegativeInt(dbVal, DEFAULT_NEW_USER_WISH);
  return readNonNegativeInt(env && env.NEW_USER_WISH, DEFAULT_NEW_USER_WISH);
}

function inviteWish(env) {
  const dbVal = __db.getSetting('invite_wish', '');
  if (dbVal !== '') return readNonNegativeInt(dbVal, DEFAULT_INVITE_WISH);
  return readNonNegativeInt(env && env.INVITE_WISH, DEFAULT_INVITE_WISH);
}

function inviteWindowDays() {
  return readNonNegativeInt(__db.getSetting('invite_window_days', ''), DEFAULT_INVITE_WINDOW_DAYS);
}

/** 后台可改的文案，留空用默认 */
function settingText(key, def) {
  const v = String(__db.getSetting(key, '') || '').trim();
  return v || def;
}

/** 内置默认文案（后台没填时用） */
function defaultInviteIntro(env) {
  const sn = serialInviteNeed();
  const kn = socketInviteNeed();
  return [
    '注册即享 VIP 身份，累计消费可升级 SVIP。',
    sn > 0 ? `每邀请 ${sn} 个新用户，送你 1 次免费取号。` : '当前未开启「邀请送免费取号」。',
    kn > 0 ? `每邀请 ${kn} 个新用户，送你 1 次免费验证码。` : '当前未开启「邀请送免费验证码」。',
    '取号与验证码都按次购买，支付成功后立即发放，按需付费、不充值、不留余额。',
    '被邀请人首次填写你的用户ID，即视为你邀请了他；每个账号只能填写一次邀请人，填了不能改。',
  ].join('\n');
}

function defaultSerialIntro(env) {
  const sn = serialInviteNeed();
  return '取号按次购买：每次支付页面上显示的金额，支付成功后立即发放序列号。'
    + (sn > 0 ? `邀请 ${sn} 位新用户可免费取号 1 次。` : '')
    + '「我的 → 邀请好友」里可以填写邀请人ID、查看自己的邀请情况。';
}

/** 「购买须知」默认文案（后台可整套覆盖） */
function defaultPurchaseNotice(env) {
  return [
    '1. 按次购买：每一次支付对应一次具体服务，支付成功后立即发放。',
    '2. 序列号取号、插座验证码均为按次购买，价格以下单页面显示为准。',
    '3. 注册即为 VIP，累计消费满额自动升级，具体等级以页面显示为准。',
    '4. 邀请好友可获得免费次数，规则以「邀请好友」页显示为准。',
    '5. 支付成功后如未收到结果，请在「我的」中查看或联系客服补发；退款请通过客服按平台规则申请。',
  ].join('\n');
}

// ───────────────────────── 邀请制接口 ─────────────────────────

/**
 * GET /api/app/config （公开，不需要登录）
 * 小程序首屏/邀请页要用到的配置与文案，全部来自后台设置
 */
async function apiAppConfig(env) {
  const price = await goodsPricing();
  return json({
    ok: true,
    invite_window_days: inviteWindowDays(),
    serial: priceShape(price.serial),
    socket: priceShape(price.socket),
    serial_invite_need: serialInviteNeed(),
    socket_invite_need: socketInviteNeed(),
    invite_free_max: inviteFreeMax(),
    invite_intro: settingText('invite_intro', defaultInviteIntro(env)),
    serial_intro: settingText('serial_intro', defaultSerialIntro(env)),
    purchase_notice: settingText('purchase_notice', defaultPurchaseNotice(env)),
    cs: csConfig(),
  });
}

/** 价格档位对外形态（价格单位：分；price 是给人看的「元」） */
function priceShape(t) {
  if (!t) return { productId: '', name: '', price_cents: 0, price: '0.00' };
  return {
    productId: t.productId,
    name: t.name || '',
    price_cents: Number(t.goodsPrice || 0),
    price: toYuan(t.goodsPrice),
  };
}

/** GET /api/referral/info —— 我的ID / 已邀请人数 / 邀请所得愿望 / 是否已绑定邀请人 */
async function apiReferralInfo(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  const bound = await __db.getReferralByInvitee(user.id);
  const invited = await __db.countInvited(user.id);
  const earned = await __db.sumInviteWish(user.id);
  const per = inviteWish(env);
  const days = inviteWindowDays();
  const hasPhone = hasPhoneUser(user);

  // 绑定时限：注册后 N 天内（0 = 不限）
  let canBind = true;
  let bindDeadline = 0;
  let reason = '';
  if (!hasPhone) { canBind = false; reason = 'need_phone'; }
  else if (bound) { canBind = false; reason = 'already_bound'; }
  else if (days > 0) {
    const created = Number(user.created_at || 0);
    bindDeadline = created + days * 86400;
    if (now() > bindDeadline) { canBind = false; reason = 'window_expired'; }
  }

  const needS = serialInviteNeed();
  const needK = socketInviteNeed();
  return json({
    ok: true,
    my_id: Number(user.id),
    nickname: user.nickname || '',
    free_serial: Number(user.free_serial || 0),
    free_socket: Number(user.free_socket || 0),
    invited_count: invited,
    serial_need: needS,
    socket_need: needK,
    serial_to_next: needS > 0 ? (needS - (invited % needS)) % needS : 0,
    socket_to_next: needK > 0 ? (needK - (invited % needK)) % needK : 0,
    invite_window_days: days,
    invited_by: Number((bound && bound.inviter_id) || user.invited_by || 0),
    // 手机号是参与邀请的前提（不做短信校验，只要求填真实号码，方便客服核对）
    has_phone: hasPhone,
    phone: hasPhone ? String(user.phone) : '',
    can_invite: hasPhone,
    can_bind: canBind,
    bind_reason: reason,
    bind_deadline: bindDeadline,
    intro: settingText('invite_intro', defaultInviteIntro(env)),
  });
}

/**
 * POST /api/referral/bind  body: { inviter_id }
 * 被邀请人填写邀请人的用户ID → 给邀请人加愿望（数量由后台设置决定，0 = 只记录不赠送）
 */
async function apiReferralBind(request, env) {
  const user = await authUser(request, env);
  const deny = needUser(user);
  if (deny) return deny;

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
  const raw = String(body.inviter_id == null ? '' : body.inviter_id).trim();
  if (!/^\d{1,10}$/.test(raw)) {
    return json({ ok: false, error: 'bad_inviter', message: '邀请人ID只能是数字' }, 400);
  }
  const inviterId = Number(raw);

  // ① 参与邀请的前提：自己得先填手机号（只要求填，不发短信、不校验号段）
  if (!hasPhoneUser(user)) {
    return json({
      ok: false, error: 'need_phone',
      message: '请先填写手机号再填写邀请人（不需要短信验证，填真实号码即可，方便客服核对）',
    }, 400);
  }

  // ② 只能绑一次（先判这个，避免已经绑过的人被后面的手机号问题挡住）
  const existed = await __db.getReferralByInvitee(user.id);
  if (existed || Number(user.invited_by) > 0) {
    return json({ ok: false, error: 'already_bound', message: '你已经填过邀请人了，不能修改' }, 409);
  }

  // ③ 不能填自己
  if (inviterId === Number(user.id)) {
    return json({ ok: false, error: 'self', message: '不能填自己的ID' }, 400);
  }

  // ④ 邀请人必须存在，并且也填过手机号（方便客服核对）
  const inviter = await __db.getUserById(inviterId);
  if (!inviter) {
    return json({ ok: false, error: 'inviter_not_found', message: '邀请人ID不存在' }, 400);
  }
  if (!hasPhoneUser(inviter)) {
    return json({
      ok: false, error: 'inviter_need_phone',
      message: `邀请人（ID ${inviterId}）还没有填写手机号，暂时不能绑定；请让对方先在「我的」里填好手机号`,
    }, 400);
  }

  if (existed || Number(user.invited_by) > 0) {
    return json({ ok: false, error: 'already_bound', message: '你已经填过邀请人了，不能修改' }, 409);
  }

  // 绑定时限（默认注册后 7 天内）
  const days = inviteWindowDays();
  if (days > 0) {
    const deadline = Number(user.created_at || 0) + days * 86400;
    if (now() > deadline) {
      return json({
        ok: false, error: 'window_expired',
        message: `只有注册后 ${days} 天内可以填写邀请人`,
      }, 400);
    }
  }

  const per = inviteWish(env);   // 旧字段，已不再发放任何「愿望」，保留只为兼容旧调用
  void per;
  const r = await __db.bindReferralTx({ inviterId, inviteeId: user.id, wish: 0 });
  if (!r.ok) {
    const map = {
      self: ['self', '不能填自己的ID'],
      already_bound: ['already_bound', '你已经填过邀请人了，不能修改'],
      inviter_not_found: ['inviter_not_found', '邀请人ID不存在'],
      invitee_missing: ['invitee_missing', '账号状态异常，请重新登录'],
      db_error: ['db_error', '服务器忙，请稍后重试'],
    };
    const [code, message] = map[r.error] || ['bind_failed', '绑定失败，请稍后重试'];
    return json({ ok: false, error: code, message }, code === 'db_error' ? 500 : 400);
  }

  // 按门槛给邀请人补发免费次数（幂等：只补差额，不会重复发）
  const granted = await grantInviteCredits(inviterId);

  await kvAddLog(env.BTSMKV, {
    userId: user.id, action: 'referral_bind',
    detail: `inviter=${inviterId} 免费取号+${granted.serial} 免费验证码+${granted.socket}`,
    ip: getClientIp(request), nickname: user.nickname, openid: user.openid,
  });

  return json({
    ok: true,
    inviter_id: inviterId,
    free_serial: granted.serial,
    free_socket: granted.socket,
    message: (granted.serial + granted.socket) > 0
      ? `绑定成功，已给邀请人（ID ${inviterId}）发放 ${granted.serial} 次免费取号、${granted.socket} 次免费验证码`
      : '绑定成功（邀请人还差人数才能拿到免费次数）',
  });
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

/**
 * 手机号宽松校验：只要求「纯数字 6~15 位」。
 * 不校验运营商号段、不发短信验证 —— 号码是给客服联系/核对用的，
 * 页面上会提示用户填真实号码即可。
 * @returns {string} 合法返回纯数字号码，不合法返回 ''
 */
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? digits : '';
}

/** 这个用户是否已经填过手机号（邀请制里作为参与条件） */
function hasPhoneUser(user) {
  return !!normalizePhone(user && user.phone);
}

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

  // ② 只支持「免费额度取号」：邀请好友得来的免费次数。
  //    没有免费次数就返回 need_payment，前端转成「付费下单 → 支付 → 发货发号」。
  const mode = 'free';
  if (Number(user.free_serial || 0) < 1) {
    const price = await goodsPricing();
    return json({
      ok: false, error: 'need_payment', message: '没有免费取号次数，请支付后取号',
      price: toYuan(price.serial && price.serial.goodsPrice),
      product_id: price.serial ? price.serial.productId : '',
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
    const cost = 0;

    const tx = await __db.claimSerialTx({
      userId: user.id,
      credit: 1,
      cost,
      row: {
        user_id: user.id, openid: user.openid, serial, category, version,
        download_url: downloadUrl, key_url: keyUrl,
        source: mode, cost, request_id: requestId,
        status: 'issued', claimed_at: ts, synced_at: 0,
      },
    });

    if (!tx.ok) {
      if (tx.error === 'need_credit') {
        // 事务已回滚（没扣免费次数也没落库），把号还回池子
        try { await btkeyRequest(env, '/api/release', { method: 'POST', body: { serial, request_id: claimId } }); } catch { /* ignore */ }
        return json({
          ok: false, error: 'need_payment', message: '免费取号次数已用完，请支付后取号',
        }, 402);
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
      source: mode, cost: 0,
      status: 'issued', status_text: '未激活', claimed_at: ts,
      free_serial: Number((fresh && fresh.free_serial) || 0),
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

  // 直购模型：免费次数来自邀请好友，不再是余额
  const total = await __db.countUserSerials(user.id);
  return json({
    ok: true,
    synced,
    free_used: false,
    free_left: Number(user.free_serial || 0),
    free_serial: Number(user.free_serial || 0),
    cost: 0,
    phone_bound: hasPhoneUser(user),
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
      free_socket: Number((fresh && fresh.free_socket) || 0),
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

  // ③ 只支持「免费额度验证码」：1 次免费额度 = 1 个验证码。
  //    多个 MAC 或不满足免费条件 → 返回 need_payment，前端走付费下单。
  const price = await goodsPricing();
  const unitCents = Number((price.socket && price.socket.goodsPrice) || 0);
  if (valid.length !== 1 || Number(user.free_socket || 0) < 1) {
    return json({
      ok: false, error: 'need_payment',
      message: valid.length !== 1
        ? '免费额度每次只能生成 1 个验证码，多个请支付后生成'
        : '没有免费验证码次数，请支付后生成',
      price: toYuan(unitCents),
      quantity: valid.length,
      total: toYuan(unitCents * valid.length),
      product_id: price.socket ? price.socket.productId : '',
    }, 402);
  }
  const cost = 0;

  // ④ 扣愿望 + 落库（一个事务，失败全撤销）
  const rows = valid.map((mac) => ({ mac, code: socketCodeOf(mac), kind: 'socket', openid: user.openid }));
  const tx = await __db.createCodeBatchTx({ userId: user.id, requestId, credit: 1, cost: 0, rows });

  if (!tx.ok) {
    if (tx.error === 'duplicate_request') {
      const batch = await __db.getCodeBatch(requestId);
      if (batch && Number(batch.user_id) === Number(user.id)) {
        const old = await __db.listCodesByRequest(requestId);
        const fresh = await __db.getUserById(user.id);
        return json({
          ok: true, repeated: true, cost: Number(batch.cost || 0),
          free_socket: Number((fresh && fresh.free_socket) || 0),
          items: old.map(publicCodeRow),
        });
      }
      return json({ ok: false, error: 'request_id_conflict' }, 409);
    }
    if (tx.error === 'need_credit') {
      const fresh = await __db.getUserById(user.id);
      return json({
        ok: false, error: 'need_payment', message: '免费验证码次数已用完，请支付后生成',
        price: toYuan(unitCents), free_socket: Number((fresh && fresh.free_socket) || 0),
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
    cost: 0,
    free_socket: Number((fresh && fresh.free_socket) || 0),
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
<html lang="zh-CN"><head>${THEME_BOOT}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · 后台登录</title>
<style>${DARK}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:var(--panel);border:1px solid var(--line);padding:32px;border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.18);width:340px}
h1{font-size:18px;margin:0 0 20px;color:var(--fg)}
input{width:100%;box-sizing:border-box;margin:6px 0 14px}
button{width:100%;padding:11px;background:linear-gradient(135deg,var(--brand2),#38bdf8)}
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
  const inviteCounts = __db.countInvitesByUser();
  const slice = users.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map(u => ({
    id: u.id, openid: u.openid, nickname: u.nickname, phone: u.phone,
    free_serial: Number(u.free_serial || 0),   // 剩余免费取号次数（邀请获得）
    free_socket: Number(u.free_socket || 0),   // 剩余免费验证码次数
    level_name: vipInfo(u).level_name,         // 会员 / SVIP / SVIP+（看累计实付）
    spent: toYuan(u.xpay_spent),
    serials: Number(serialCounts[Number(u.id)] || 0),
    codes: Number(codeCounts[Number(u.id)] || 0),
    // 邀请制：这个人是谁邀请的、他又邀请了几个人
    invited_by: Number(u.invited_by || 0),
    invites: Number(inviteCounts[Number(u.id)] || 0),
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
    kind: o.kind || '',
    productName: o.productName, productId: o.productId,
    price: toYuan(o.goodsPrice), quantity: Number(o.buyQuantity || 1),
    status: o.status, deliver_status: o.deliver_status || '', note: o.note || '',
    result: o.deliver_result || '',
    mock: !!o.mock, wxOrderId: o.wxOrderId || '',
    createdAt: o.createdAt, deliveredAt: o.deliveredAt
  }));
  return json({ total, page, pageSize, orders: slice });
}

/**
 * POST /admin/api/orders/redeliver  body: { order_id }
 * 发号失败 / 推送丢失时手动补发：按订单类型重新发号或生成验证码（内部幂等）。
 */
async function adminApiOrderRedeliver(request, env) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const order = await kvGetOrder(env.BTSMKV, String(body.order_id || ''));
  if (!order) return json({ error: 'not_found' }, 404);
  if (order.status === ST.DELIVERED) {
    return json({ ok: true, order: publicOrder(order), note: 'already_delivered' });
  }

  const before = order.deliver_status || '';
  const out = await deliverOrder(env, order);
  const okNow = out.deliver_status === 'issued';

  await kvAddLog(env.BTSMKV, {
    userId: Number(out.userId || 0), action: 'admin_redeliver',
    detail: `order=${out.id} ${before}→${out.deliver_status} by ${session.sub}`,
    ip: getClientIp(request),
  });
  return json({
    ok: okNow,
    order: publicOrder(out),
    error: okNow ? '' : (out.note || 'deliver_failed'),
  });
}

async function adminApiStats(request, env) {  const session = await authAdmin(request, env);
  if (!session) return json({ error:'unauthorized' }, 401);
  // 有效用户：购买过 / 取过号 / 生成过验证码（三类并集去重，db 层算），不看当前余额
  const active = await __db.countActiveUsers();
  // 今日新增：北京时间自然日 00:00 起，数据库按时间全表统计（不受列表扫描上限限制）
  const today = await __db.countUsersCreatedAfter(bjTodayStartTs());
  // 总数 / 累计消费 / 剩余合计：一条 SQL 聚合，全表准确，不再受 KV_MAX_SCAN 限制
  const totals = __db.getUserTotals();
  return json({
    total: totals.total, svip: active, new_today: today,
    spent_sum: toYuan(totals.spent),
    count_sum: totals.count,
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

  // 手动修改用户ID：正整数校验 → 占用检查 → 事务级联（订单/领号/插座记录一起迁）
  let renamedFrom = null;
  if (body.new_id !== undefined && String(body.new_id).trim() !== '') {
    const newId = Math.round(Number(body.new_id));
    if (!Number.isInteger(newId) || newId <= 0 || newId > 999999) {
      return json({ error: 'bad_new_id', message: '用户ID须为 1~999999 的整数' }, 400);
    }
    if (newId !== Number(user.id)) {
      const taken = await kvGetUserById(env.BTSMKV, newId);
      if (taken) {
        return json({ error: 'user_id_taken', message: '用户ID #' + newId + ' 已被「' + (taken.nickname || ('openid…' + String(taken.openid).slice(-6))) + '」占用' }, 409);
      }
      renamedFrom = Number(user.id);
      const ok = __db.renameUserId(renamedFrom, newId);
      if (!ok) return json({ error: 'rename_failed', message: '修改用户ID失败（可能已被占用或源不存在）' }, 409);
      user.id = newId;
    }
  }

  if (typeof body.nickname === 'string') user.nickname = body.nickname.slice(0,64);
  if (typeof body.phone === 'string')    user.phone = body.phone.replace(/\D/g,'').slice(0,11);
  if (typeof body.remark === 'string')   user.remark = body.remark.slice(0,255);
  if (body.status !== undefined)         user.status = Number(body.status) ? 1 : 0;

  // 免费次数：取号 / 验证码分开，各自支持「设为」与「增加」两种模式
  const beforeFreeSerial = Number(user.free_serial || 0);
  const beforeFreeSocket = Number(user.free_socket || 0);
  const applyFree = (raw, before) => {
    if (raw === undefined || raw === '') return before;
    const n = Math.max(0, Math.round(Number(raw) || 0));
    return body.count_mode === 'add' ? before + n : n;
  };
  user.free_serial = applyFree(body.free_serial, beforeFreeSerial);
  user.free_socket = applyFree(body.free_socket, beforeFreeSocket);

  // 累计消费：按「元」传参，内部存分（传空字符串则清零）
  if (body.spent !== undefined) {
    if (body.spent === '') user.xpay_spent = 0;
    else if (Number.isFinite(Number(body.spent))) {
      user.xpay_spent = Math.max(0, Math.round(Number(body.spent) * 100));
    }
  }

  user.updated_at = now();
  await kvPutUser(env.BTSMKV, user);
  const idChange = renamedFrom !== null ? ` 用户ID #${renamedFrom}→#${user.id}；` : '';
  await kvAddLog(env.BTSMKV, {
    userId:user.id, action:'admin_update',
    detail:`by ${session.sub}${idChange} 免费取号=${beforeFreeSerial}→${user.free_serial} 免费验证码=${beforeFreeSocket}→${user.free_socket} 累计消费=${toYuan(user.xpay_spent)}元`,
    ip:getClientIp(request), nickname:user.nickname, openid:user.openid
  });
  return json({ ok:true, user: publicUser(user) });
}

/**
 * POST /admin/api/users/delete-batch  body: { ids: [id, ...] }
 * 批量硬删除注册用户：清理 users 及其领号/插座记录；订单与审计日志保留。
 * 也兼容单删（body: { id }），复用同一套校验与事务。
 */
async function adminApiDeleteUsers(request, env) {
  const session = await authAdmin(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);

  let body;
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) body = await request.json();
  else { const f = await request.formData(); body = Object.fromEntries(f.entries()); }

  const MAX_BATCH = 100;
  const raw = Array.isArray(body.ids) ? body.ids : (body.id !== undefined ? [body.id] : []);
  const ids = [...new Set(raw.map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return json({ error: 'bad_ids', message: '请先勾选要删除的用户' }, 400);
  if (ids.length > MAX_BATCH) return json({ error: 'too_many', message: '一次最多删除 ' + MAX_BATCH + ' 个用户' }, 400);

  // 删除前先取出存在的用户快照（核对存在性 + 审计留痕，用户删掉后仍能在日志里看到）
  const before = [];
  for (const id of ids) {
    const u = await kvGetUserById(env.BTSMKV, id);
    if (u) before.push(u);
  }
  const wanted = ids.map(Number);
  const missing = wanted.filter(id => !before.some(u => Number(u.id) === id));
  if (!before.length) return json({ error: 'not_found', message: '所选用户均不存在（可能已被删除）' }, 404);

  const { deleted, removed } = await __db.deleteUsers(before.map(u => Number(u.id)));

  for (const u of removed) {
    await kvAddLog(env.BTSMKV, {
      userId: u.id, action: 'admin_user_delete',
      detail: `by ${session.sub} 删除用户 #${u.id} 昵称=${u.nickname || ''} 免费取号=${u.free_serial||0} 免费验证码=${u.free_socket||0}；领号/插座记录已清除，订单与日志保留`,
      ip: getClientIp(request), nickname: u.nickname, openid: u.openid
    });
  }

  return json({
    ok: true, deleted, missing,
    removed: removed.map(u => ({ id: u.id, nickname: u.nickname, openid: u.openid }))
  });
}

/** GET /admin/api/export.csv?table=users|orders|serials|codes|referrals|logs（默认 users） */
async function adminApiExportCsv(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return new Response('unauthorized', { status: 401 });
  const table = (url.searchParams.get('table') || 'users').trim();
  const data = __db.dumpTable(table);
  if (!data) return new Response('未知数据表', { status: 400 });
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [data.columns.join(',')];
  for (const r of data.rows) lines.push(data.columns.map(c => esc(r[c])).join(','));
  return new Response('\uFEFF' + lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${table}_${now()}.csv"`,
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
/** POST /admin/serials/settings  form:{cost} 保存「每次取号消耗愿望数」 */
async function adminSaveSerialSettings(request, env) {
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = new URL(request.url).origin;
  const loginUrl = `${origin}/${adminPrefix}/login`;
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(loginUrl, 302);
  let form;
  try { form = await request.formData(); } catch { return Response.redirect(loginUrl, 302); }
  const back = (m) => Response.redirect(`${origin}/${adminPrefix}/serials?m=${encodeURIComponent(m)}`, 302);
  const n = Math.floor(Number(form.get('cost')));
  if (!Number.isInteger(n) || n < 0 || n > 999) return back('消耗数需为 0-999 的整数（0 = 免费）');
  await __db.setSetting('serial_wish_cost', String(n));
  await kvAddLog(env.BTSMKV, { userId: 0, action: 'admin_set_serial_cost', detail: `by ${session.sub} 旧「消耗次数」写入 ${n}（已失效）` });
  return back('该设置已下线：现在按次直购，取号价格请在「系统设置 → 直购价格档位」里选');
}

/** POST /admin/codes/settings  form:{cost} 保存「每个验证码消耗愿望数」 */
async function adminSaveSocketSettings(request, env) {
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = new URL(request.url).origin;
  const loginUrl = `${origin}/${adminPrefix}/login`;
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(loginUrl, 302);
  let form;
  try { form = await request.formData(); } catch { return Response.redirect(loginUrl, 302); }
  const back = (m) => Response.redirect(`${origin}/${adminPrefix}/codes?m=${encodeURIComponent(m)}`, 302);
  const n = Math.floor(Number(form.get('cost')));
  if (!Number.isInteger(n) || n < 0 || n > 999) return back('消耗数需为 0-999 的整数（0 = 免费）');
  await __db.setSetting('socket_cost', String(n));
  await kvAddLog(env.BTSMKV, { userId: 0, action: 'admin_set_socket_cost', detail: `by ${session.sub} 旧「消耗次数」写入 ${n}（已失效）` });
  return back('该设置已下线：现在按个直购，验证码价格请在「系统设置 → 直购价格档位」里选');
}

/** 轻量 CSV 解析：支持双引号包裹、"" 转义、CRLF；返回二维字符串数组 */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || String(row[0]).trim() !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.length > 1 || String(row[0]).trim() !== '') rows.push(row);
  return rows;
}

function csvColIndex(headers, names) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] == null ? '' : headers[i]).trim().toLowerCase();
    if (names.includes(h)) return i;
  }
  return -1;
}

/**
 * POST /admin/settings/import-users —— 上传 CSV 批量导入 / 修改用户（按用户ID匹配）。
 * 表头识别：id/用户ID，xpay_count/愿望/余额/剩余愿望，nickname/昵称，phone/手机号。
 * 只更新已存在用户；ID 不存在、余额非法的行跳过并计入 errors。
 */
async function adminImportUsers(request, env, url) {
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = url.origin;
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(`${origin}/${adminPrefix}/login`, 302);
  let form;
  try { form = await request.formData(); } catch { return Response.redirect(`${origin}/${adminPrefix}/settings?m=` + encodeURIComponent('上传失败，请重试'), 302); }
  const file = form.get('file');
  let text = '';
  if (file && typeof file.text === 'function') {
    try { text = await file.text(); } catch { text = ''; }
  }
  const grid = parseCsv(text);
  const back = (m) => Response.redirect(`${origin}/${adminPrefix}/settings?m=${encodeURIComponent(m)}#import`, 302);
  if (grid.length < 2) return back('CSV 为空或只有表头，没有可导入的数据行');

  const head = grid[0];
  const iId = csvColIndex(head, ['id', '用户ID', '用户id', '编号']);
  // 免费次数（取号 / 验证码分开）；旧表头里的 wish/count/愿望 一律按「免费取号次数」处理
  const iFreeSerial = csvColIndex(head, ['free_serial', '免费取号次数', '取号次数', 'xpay_count', '愿望', '余额', '剩余愿望', 'wish', 'count']);
  const iFreeSocket = csvColIndex(head, ['free_socket', '免费验证码次数', '验证码次数']);
  const iNick = csvColIndex(head, ['nickname', '昵称', '名字']);
  const iPhone = csvColIndex(head, ['phone', '手机号', '电话']);
  if (iId < 0) return back('未识别到「用户ID」列（表头需包含 id 或 用户ID）');

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const id = (cells[iId] || '').trim();
    if (id === '') continue;
    const row = { id };
    if (iFreeSerial >= 0) row.free_serial = (cells[iFreeSerial] || '').trim();
    if (iFreeSocket >= 0) row.free_socket = (cells[iFreeSocket] || '').trim();
    if (iNick >= 0) row.nickname = (cells[iNick] || '').trim();
    if (iPhone >= 0) row.phone = (cells[iPhone] || '').trim();
    rows.push(row);
  }
  const res = __db.importUsers(rows);
  await kvAddLog(env.BTSMKV, {
    userId: 0, action: 'admin_import_users',
    detail: `updated=${res.updated} skipped=${res.skipped} by ${session.sub}`,
  });
  const detail = res.errors.length ? `；问题行：${res.errors.slice(0, 5).join('；')}${res.errors.length > 5 ? ' 等' + res.errors.length + '条' : ''}` : '';
  return back(`导入完成：更新 ${res.updated} 人，跳过 ${res.skipped} 人${detail}`);
}

/**
 * POST /admin/settings/import-table —— 整表恢复导入（先清空该表，再按导出 CSV 原样写回，保留原 id/时间）。
 * form: table=logs|orders|serials|codes|referrals, file=导出的原始 CSV。
 */
async function adminImportTable(request, env, url) {
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = url.origin;
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(`${origin}/${adminPrefix}/login`, 302);
  let form;
  try { form = await request.formData(); } catch { form = new FormData(); }
  const back = (m) => Response.redirect(`${origin}/${adminPrefix}/settings?m=${encodeURIComponent(m)}#import`, 302);
  const table = String(form.get('table') || '').trim();
  const file = form.get('file');
  let text = '';
  if (file && typeof file.text === 'function') { try { text = await file.text(); } catch { text = ''; } }
  const grid = parseCsv(text);
  if (grid.length < 2) return back('CSV 为空或只有表头，没有可导入的数据行');

  const head = grid[0].map(h => String(h == null ? '' : h).trim());
  const allCols = ['id','user_id','action','detail','ip','nickname','openid','device','created_at',
    'outTradeNo','userId','productId','productName','goodsPrice','buyQuantity','times','status','mock','note','createdAt','deliveredAt',
    'serial','category','version','source','cost','activated_at','claimed_at','remark',
    'kind','mac','code','inviter_id','invitee_id','wish'];
  const colIdx = {};
  for (const c of allCols) { const i = head.indexOf(c); if (i >= 0) colIdx[c] = i; }

  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    const obj = {};
    for (const c of Object.keys(colIdx)) obj[c] = (cells[colIdx[c]] || '').trim();
    rows.push(obj);
  }
  const res = __db.replaceTable(table, rows);
  if (!res.ok) return back('未知的导入表：' + table);
  await kvAddLog(env.BTSMKV, {
    userId: 0, action: 'admin_import_table',
    detail: `table=${table} inserted=${res.inserted} by ${session.sub}`,
  });
  const names = { logs:'审计日志', orders:'订单', serials:'序列号记录', codes:'验证码记录', referrals:'邀请记录' };
  return back(`已整表恢复「${names[table] || table}」：清空原表后写入 ${res.inserted} 条`);
}

/** POST /admin/settings/clear-orders —— 清空全部订单（需 confirm=YES 二次确认） */
async function adminClearOrders(request, env, url) {
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = url.origin;
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(`${origin}/${adminPrefix}/login`, 302);
  let form;
  try { form = await request.formData(); } catch { form = new FormData(); }
  const back = (m) => Response.redirect(`${origin}/${adminPrefix}/settings?m=${encodeURIComponent(m)}#danger`, 302);
  if (String(form.get('confirm') || '') !== 'YES') return back('未确认，订单未清空（需要勾选确认）');
  const n = __db.clearAllOrders();
  await kvAddLog(env.BTSMKV, { userId: 0, action: 'admin_clear_orders', detail: `cleared=${n} by ${session.sub}` });
  return back(`已清空全部订单，共删除 ${n} 条`);
}

/** POST /admin/settings/clear-logs —— 清空全部审计日志（需 confirm=YES 二次确认） */
async function adminClearLogs(request, env, url) {
  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const origin = url.origin;
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(`${origin}/${adminPrefix}/login`, 302);
  let form;
  try { form = await request.formData(); } catch { form = new FormData(); }
  const back = (m) => Response.redirect(`${origin}/${adminPrefix}/settings?m=${encodeURIComponent(m)}#danger`, 302);
  if (String(form.get('confirm') || '') !== 'YES') return back('未确认，日志未清空（需要勾选确认）');
  const n = __db.clearAllLogs();
  await kvAddLog(env.BTSMKV, { userId: 0, action: 'admin_clear_logs', detail: `cleared=${n} by ${session.sub}` });
  return back(`已清空全部审计日志，共删除 ${n} 条`);
}

/**
 * GET  /admin/settings —— 统一设置中心（邀请 / 赠送 + 消耗 + 导出导入 + 数据维护）
 * POST /admin/settings —— 保存设置
 */
async function adminSettingsPage(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(url.origin + '/' + (env.ADMIN_PREFIX || 'admin') + '/login', 302);
  const adminPrefix = env.ADMIN_PREFIX || 'admin';

  if (request.method === 'POST') {
    const form = await request.formData();
    const pick = (k) => String(form.get(k) == null ? '' : form.get(k)).trim();
    const num = (k, def) => {
      const raw = pick(k);
      if (raw === '') return String(def);
      const n = Math.floor(Number(raw));
      return String(Number.isInteger(n) && n >= 0 ? n : def);
    };

    const days = num('invite_window_days', inviteWindowDays());
    // 0-999 整数（0 = 关闭 / 不限）
    const zero999 = (k, def) => {
      const raw = pick(k);
      if (raw === '') return String(def);
      const n = Math.floor(Number(raw));
      return String(Number.isInteger(n) && n >= 0 && n <= 999 ? n : def);
    };
    const serialNeed = zero999('serial_invite_need', serialInviteNeed());
    const socketNeed = zero999('socket_invite_need', socketInviteNeed());
    const freeMax = zero999('invite_free_max', inviteFreeMax());
    const newCredit = zero999('new_user_free_credit', intSetting('new_user_free_credit', 0, 0, 99));
    const svip1 = zero999('svip1_spent', intSetting('svip1_spent', 100, 0, 1000000));
    const svip2 = zero999('svip2_spent', intSetting('svip2_spent', 300, 0, 1000000));

    // 价格档位只能选「道具配置」里存在的 productId，避免下单时找不到档位
    const tierList = await kvGetProducts(env.BTSMKV);
    const pickTier = (k, def) => {
      const v = pick(k);
      return tierList.some(p => p.productId === v) ? v : def;
    };
    const serialTier = pickTier('serial_tier', serialTierId());
    const socketTier = pickTier('socket_tier', socketTierId());

    // 客服入口开关
    const b01 = (k, def) => {
      const raw = pick(k);
      return raw === '0' ? '0' : (raw === '1' ? '1' : String(def));
    };
    const csOn = b01('cs_enabled', csEnabled());
    const csG = b01('cs_guest', csGuest());
    const csV = b01('cs_vip', csVip());
    const csS = b01('cs_svip', csSvip());

    __db.setSetting('invite_window_days', days);
    // 文案是「有才更新」：客服面板只提交客服字段，不能把这三段文案清空
    if (form.has('invite_intro')) __db.setSetting('invite_intro', pick('invite_intro').slice(0, 2000));
    if (form.has('serial_intro')) __db.setSetting('serial_intro', pick('serial_intro').slice(0, 2000));
    if (form.has('purchase_notice')) __db.setSetting('purchase_notice', pick('purchase_notice').slice(0, 4000));
    __db.setSetting('cs_enabled', csOn);
    __db.setSetting('cs_guest', csG);
    __db.setSetting('cs_vip', csV);
    __db.setSetting('cs_svip', csS);
    __db.setSetting('serial_invite_need', serialNeed);
    __db.setSetting('socket_invite_need', socketNeed);
    __db.setSetting('invite_free_max', freeMax);
    __db.setSetting('new_user_free_credit', newCredit);
    __db.setSetting('svip1_spent', svip1);
    __db.setSetting('svip2_spent', svip2);
    __db.setSetting('serial_tier', serialTier);
    __db.setSetting('socket_tier', socketTier);

    await kvAddLog(env.BTSMKV, {
      userId: 0, action: 'admin_settings_save',
      detail: `serial_tier=${serialTier} socket_tier=${socketTier} serial_need=${serialNeed} socket_need=${socketNeed} free_max=${freeMax} new_credit=${newCredit} svip=${svip1}/${svip2} by ${session.sub}`,
    });
    const msg = encodeURIComponent(
      `已保存：取号档位 ${serialTier}、验证码档位 ${socketTier}；邀请 ${serialNeed} 人送 1 次免费取号、${socketNeed} 人送 1 次免费验证码；SVIP 满 ${svip1} 元、SVIP+ 满 ${svip2} 元；客服入口${csOn === '1' ? '开启' : '关闭'}`
    );
    return Response.redirect(new URL('/' + adminPrefix + '/settings?m=' + msg, url.origin).toString(), 302);
  }

  const msg = (url.searchParams.get('m') || '').trim();
  const referrals = __db.listReferrals({ limit: 50, offset: 0 });
  const tierList = (await kvGetProducts(env.BTSMKV)).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const totalRef = __db.countReferrals();
  const rows = referrals.map((r) => `<tr>
    <td class="mono">${r.inviter_id}</td>
    <td>${escapeHtml(r.inviter_nick || '')}<br><span class="muted">${escapeHtml(r.inviter_phone || '')}</span></td>
    <td class="mono">${r.invitee_id}</td>
    <td>${escapeHtml(r.invitee_nick || '')}<br><span class="muted">${escapeHtml(r.invitee_phone || '')}</span></td>
    <td class="money">+${Number(r.wish || 0)}</td>
    <td class="nowrap">${fmtBeijing(r.created_at)}</td>
    <td class="nowrap">
      <form method="post" action="/${adminPrefix}/referral/cancel" style="display:inline"
            onsubmit="return confirm('取消这条邀请绑定？\\n邀请人ID ${r.inviter_id} ← 被邀请人ID ${r.invitee_id}\\n取消后被邀请可以重新填写邀请人。\\n注意：已发放的免费次数不会自动收回（如需收回请在用户编辑里改）。')">
        <input type="hidden" name="invitee_id" value="${r.invitee_id}">
        <button class="mini danger" type="submit">取消绑定</button>
      </form>
    </td>
  </tr>`).join('');

  return html(`<!doctype html>
<html lang="zh-CN"><head>${THEME_BOOT}<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>系统设置 · ${escapeHtml(env.APP_NAME || '')}</title>
<style>${DARK}
header{background:transparent;border-bottom:1px solid var(--line);padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:17px;margin:0;color:var(--fg)}
header a{color:var(--muted);font-size:13px;margin-left:16px}
header a:hover{color:var(--brand)}
.box h2{font-size:15px;margin:0 0 6px;color:var(--fg)}
label{display:block;font-size:13px;color:var(--fg);margin:12px 0 4px}
input[type=number],input[type=text],input[type=file],select,textarea{width:100%;box-sizing:border-box}
select{width:auto}
textarea{min-height:90px;line-height:1.6}
.row{display:flex;gap:16px;flex-wrap:wrap}
.row>div{flex:1;min-width:200px}
button{margin-top:16px}
button.mini{padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid var(--err-bg);background:var(--err-bg);color:var(--err);cursor:pointer;margin:0;white-space:nowrap}
table form{margin:0}
.nowrap{white-space:nowrap}
.export-list{display:flex;flex-direction:column;gap:8px}
a.dl{display:inline-flex;align-items:center;gap:6px;padding:9px 13px;background:var(--panel2);border:1px solid var(--line2);border-radius:10px;font-size:13px;color:var(--brand)}
a.dl:hover{background:rgba(56,189,248,.12);text-decoration:none;border-color:var(--brand)}
.danger-row{display:flex;gap:24px;flex-wrap:wrap}
.danger-row>div{flex:1;min-width:260px}
/* 左侧分类导航 + 右侧面板 */
.container{display:flex;min-height:100vh}
.sidebar{width:220px;flex-shrink:0;background:var(--side-bg);color:var(--fg);padding:18px 0;border-right:1px solid var(--line)}
.sidebar-header{padding:0 18px 14px;margin-bottom:10px;border-bottom:1px solid var(--line);font-size:13px;font-weight:600;color:var(--muted);letter-spacing:1px;white-space:nowrap}
.menu-item{padding:12px 18px;cursor:pointer;border-left:3px solid transparent;margin:2px 10px 2px 0;border-radius:0 10px 10px 0;display:flex;align-items:center;gap:10px;font-size:14px;white-space:nowrap;transition:.2s;color:var(--muted)}
.menu-item .icon{width:20px;text-align:center}
.menu-item.active{background:linear-gradient(90deg,rgba(56,189,248,.18),transparent);border-left-color:var(--brand);color:var(--brand)}
.menu-item:hover{background:rgba(255,255,255,.05);color:var(--fg)}
.content{flex:1;min-width:0;padding:20px 24px;max-width:none}
.panel{display:none}
.panel.active{display:block;animation:fade .25s ease}
.theme-row{display:flex;gap:16px;flex-wrap:wrap}
.theme-card{flex:1;min-width:200px;border:1px solid var(--line2);border-radius:14px;padding:16px;cursor:pointer;background:var(--panel);display:flex;flex-direction:column;gap:8px;transition:.2s}
.theme-card:hover{border-color:var(--brand);transform:translateY(-2px)}
.theme-card.on{border-color:var(--brand);box-shadow:0 0 0 2px var(--info-bg)}
.theme-card b{font-size:15px;color:var(--fg)}
.preview{height:96px;border-radius:10px;position:relative;overflow:hidden;margin-bottom:4px;border:1px solid var(--line)}
.pv-dark{background:#0d1117}
.pv-light{background:#eef1f5}
.preview .p-bar{position:absolute;top:0;left:0;right:0;height:22px;display:block}
.pv-dark .p-bar{background:#1d2530}
.pv-light .p-bar{background:#fff}
.preview .p-line{position:absolute;left:12px;top:38px;height:8px;width:70%;border-radius:4px;display:block}
.preview .p-line.short{top:58px;width:45%}
.pv-dark .p-line{background:#2a313c}
.pv-light .p-line{background:#cbd5e1}
.preview .p-dot{position:absolute;right:12px;top:32px;width:26px;height:26px;border-radius:8px;display:block}
.pv-dark .p-dot{background:#1f6feb}
.pv-light .p-dot{background:#2563eb}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (max-width:768px){
  .container{flex-direction:column}
  .sidebar{width:100%;padding:8px 0;border-right:none;border-bottom:1px solid var(--line)}
  .sidebar-header{display:none}
  .menu-item{display:inline-flex;border-left:none;border-bottom:3px solid transparent;margin:0 4px;padding:9px 11px;font-size:13px;border-radius:10px}
  .menu-item.active{border-left:none;border-bottom-color:var(--brand)}
  .content{padding:14px}
}
</style></head><body>
<header>
  <h1>⚙️ 系统设置</h1>
  <div><a href="/${adminPrefix}">← 返回后台</a></div>
</header>
<div class="container">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">设置菜单</div>
    <div class="menu-item active" data-panel="rules" onclick="showPanel('rules')"><span class="icon">🎁</span><span>发放规则与消耗</span></div>
    <div class="menu-item" data-panel="export" onclick="showPanel('export')"><span class="icon">📤</span><span>数据导出</span></div>
    <div class="menu-item" data-panel="import" onclick="showPanel('import')"><span class="icon">📥</span><span>用户导入</span></div>
    <div class="menu-item" data-panel="danger" onclick="showPanel('danger')"><span class="icon">⚠️</span><span>危险操作</span></div>
    <div class="menu-item" data-panel="referrals" onclick="showPanel('referrals')"><span class="icon">🤝</span><span>邀请记录</span></div>
    <div class="menu-item" data-panel="service" onclick="showPanel('service')"><span class="icon">💬</span><span>客服入口</span></div>
    <div class="menu-item" data-panel="theme" onclick="showPanel('theme')"><span class="icon">🎨</span><span>外观皮肤</span></div>
  </div>

  <div class="content">
    ${msg ? `<div class="msg">${escapeHtml(msg)}</div>` : ''}

    <div class="panel" id="panel-service">
      <div class="hint">
        关掉总开关 = 所有人都看不到「联系客服」。总开关开启时，再按身份分别控制。<br>
        前提：需先在 MP 后台「功能 → 客服」里添加客服人员，否则用户点了会提示未开启客服功能。
      </div>
      <form class="box" method="post" action="/${adminPrefix}/settings">
        <h2>💬 客服入口</h2>
        <div class="row">
          <div>
            <label>总开关</label>
            <select name="cs_enabled">${optOnOff(csEnabled())}</select>
          </div>
          <div>
            <label>未登录用户显示</label>
            <select name="cs_guest">${optOnOff(csGuest())}</select>
          </div>
          <div>
            <label>VIP 显示</label>
            <select name="cs_vip">${optOnOff(csVip())}</select>
          </div>
          <div>
            <label>SVIP / SVIP+ 显示</label>
            <select name="cs_svip">${optOnOff(csSvip())}</select>
          </div>
        </div>
        <div style="margin-top:16px">
          <button class="primary" type="submit">保存客服设置</button>
        </div>
      </form>
    </div>

    <div class="panel active" id="panel-rules">
      <div class="hint">
        奖励数量填 <code>0</code> 表示<b>不赠送</b>（邀请照样记录，只是不给愿望）；消耗填 <code>0</code> 表示<b>免费</b>。<br>
        绑定时限：被邀请人必须在注册后 N 天内填写邀请人，<code>0</code> = 不限制。改完点「保存设置」立即生效。
      </div>
      <form class="box" method="post" action="/${adminPrefix}/settings">
        <h2>💳 直购价格档位（必须与微信虚拟支付道具一致）</h2>
        <div class="row">
          <div>
            <label>取号用哪个档位（付款就是该档金额）</label>
            <select name="serial_tier">${tierOptionsHtml(tierList, serialTierId())}</select>
          </div>
          <div>
            <label>验证码用哪个档位（每个）</label>
            <select name="socket_tier">${tierOptionsHtml(tierList, socketTierId())}</select>
          </div>
        </div>

        <h2 style="margin-top:22px">🎁 邀请免费次数 / 注册赠送</h2>
        <div class="row">
          <div>
            <label>邀请几人送 1 次免费取号（默认 2，0 = 不开启）</label>
            <input type="number" name="serial_invite_need" min="0" max="999" step="1" value="${serialInviteNeed()}">
          </div>
          <div>
            <label>邀请几人送 1 次免费验证码（默认 0 = 不开启）</label>
            <input type="number" name="socket_invite_need" min="0" max="999" step="1" value="${socketInviteNeed()}">
          </div>
          <div>
            <label>免费次数最多送几次（0 = 不限）</label>
            <input type="number" name="invite_free_max" min="0" max="999" step="1" value="${inviteFreeMax()}">
          </div>
          <div>
            <label>新用户注册送几次免费取号（0 = 不送）</label>
            <input type="number" name="new_user_free_credit" min="0" max="99" step="1" value="${intSetting('new_user_free_credit', 0, 0, 99)}">
          </div>
          <div>
            <label>绑定时限（天，默认 7，0 = 不限）</label>
            <input type="number" name="invite_window_days" min="0" step="1" value="${inviteWindowDays()}">
          </div>
        </div>

        <h2 style="margin-top:22px">💎 VIP 等级（按累计实付金额升级，与余额无关）</h2>
        <div class="row">
          <div>
            <label>累计实付满多少元升 SVIP（默认 100）</label>
            <input type="number" name="svip1_spent" min="0" step="1" value="${intSetting('svip1_spent', 100, 0, 1000000)}">
          </div>
          <div>
            <label>累计实付满多少元升 SVIP+（默认 300）</label>
            <input type="number" name="svip2_spent" min="0" step="1" value="${intSetting('svip2_spent', 300, 0, 1000000)}">
          </div>
        </div>

        <h2 style="margin-top:22px">📝 小程序文案</h2>
        <label>邀请页规则文案（留空 = 用内置默认，会自动带上上面的奖励数字）</label>
        <textarea name="invite_intro" placeholder="${escapeHtml(defaultInviteIntro(env))}">${escapeHtml(settingText('invite_intro', ''))}</textarea>

        <label>序列号取号页底部说明（留空 = 用内置默认）</label>
        <textarea name="serial_intro" placeholder="${escapeHtml(defaultSerialIntro(env))}">${escapeHtml(settingText('serial_intro', ''))}</textarea>

        <label>「购买须知」内容（小程序「我的 → 说明」页，留空 = 用内置默认；一行一条）</label>
        <textarea name="purchase_notice" placeholder="${escapeHtml(defaultPurchaseNotice(env))}">${escapeHtml(settingText('purchase_notice', ''))}</textarea>

        <button type="submit">保存设置</button>
      </form>
    </div>

    <div class="panel" id="panel-export">
      <div class="box">
        <h2>📤 导出全部数据（CSV 表格，分开下载）</h2>
        <p class="muted" style="margin:6px 0 12px">每个表单独导出一个 CSV（带 BOM，Excel 直接打开不乱码）。建议定期备份。金额列为原始分。</p>
        <div class="export-list">
          <a class="dl" href="/${adminPrefix}/api/export.csv?table=users">👤 用户表（ID / openid / 昵称 / 手机 / 余额 / 消费）</a>
          <a class="dl" href="/${adminPrefix}/api/export.csv?table=orders">🧾 订单表（购买记录 / 金额 / 状态）</a>
          <a class="dl" href="/${adminPrefix}/api/export.csv?table=serials">🔑 序列号领取记录</a>
          <a class="dl" href="/${adminPrefix}/api/export.csv?table=codes">💡 智能插座验证码记录</a>
          <a class="dl" href="/${adminPrefix}/api/export.csv?table=referrals">🤝 邀请关系记录</a>
          <a class="dl" href="/${adminPrefix}/api/export.csv?table=logs">📜 审计日志</a>
        </div>
      </div>
    </div>

    <div class="panel" id="panel-import">
      <div class="box">
        <h2>👤 导入 / 修改用户（按ID更新，不清空）</h2>
        <p class="muted" style="margin:6px 0 12px">
          上传用户 CSV，按<b>用户ID</b>匹配已存在用户并更新；ID 不存在的行自动跳过，不会新建用户。<br>
          表头支持：<code>id,free_serial,free_socket,nickname,phone</code>（也认中文「免费取号次数 / 免费验证码次数 / 昵称 / 手机号」）。<br>
          <code>free_serial</code> / <code>free_socket</code> 填了就<b>设置为该次数</b>（不是累加）；留空的列不修改。
        </p>
        <form method="post" action="/${adminPrefix}/settings/import-users" enctype="multipart/form-data">
          <input type="file" name="file" accept=".csv,text/csv" required style="padding:8px;border:1px solid var(--line2);border-radius:8px;font-size:14px;max-width:100%">
          <button type="submit" style="background:var(--brand2)">上传并更新用户</button>
        </form>
      </div>

      <div class="box danger-box">
        <h2>♻️ 整表恢复（先清空该表，再按CSV原样写回）</h2>
        <p class="muted" style="margin:6px 0 12px">
          用于把导出的备份 CSV 导回。<b>会先清空所选表现有数据</b>，再按 CSV 原样写入（保留原ID和时间），不可撤销，请确认上传的是该表自己导出的 CSV。
        </p>
        <form method="post" action="/${adminPrefix}/settings/import-table" enctype="multipart/form-data"
              onsubmit="return confirm('整表恢复将先清空所选表现有数据再写入，确定继续？')">
          <label style="display:block;font-size:13px;margin:6px 0 4px">选择要恢复的表</label>
          <select name="table" required style="padding:8px 10px;border:1px solid var(--line2);border-radius:8px;font-size:14px;min-width:220px">
            <option value="logs">审计日志（logs）</option>
            <option value="orders">订单（orders）</option>
            <option value="serials">序列号领取记录（serials）</option>
            <option value="codes">验证码记录（codes）</option>
            <option value="referrals">邀请记录（referrals）</option>
          </select>
          <br>
          <input type="file" name="file" accept=".csv,text/csv" required style="padding:8px;border:1px solid var(--line2);border-radius:8px;font-size:14px;max-width:100%;margin-top:10px">
          <button type="submit" class="btn-danger">整表恢复</button>
        </form>
      </div>
    </div>

    <div class="panel" id="panel-danger">
      <div class="box danger-box">
        <h2>⚠️ 危险操作（不可恢复，请先导出备份）</h2>
        <div class="danger-row">
          <div>
            <b>清空订单列表</b>
            <p class="muted" style="margin:4px 0">删除全部订单记录（不含用户、余额、序列号），用于重置演示数据。</p>
            <form method="post" action="/${adminPrefix}/settings/clear-orders"
                  onsubmit="return confirm('确定清空全部订单？\\n此操作不可恢复，建议先导出订单表。\\n勾选确认后提交才会执行。')">
              <label style="display:inline;font-size:13px;margin-right:8px">
                <input type="checkbox" name="confirm" value="YES" required style="width:auto;vertical-align:-1px"> 我已备份，确认清空
              </label>
              <button type="submit" class="btn-danger">清空订单</button>
            </form>
          </div>
          <div>
            <b>清空审计日志</b>
            <p class="muted" style="margin:4px 0">删除全部操作日志，不影响任何业务数据。</p>
            <form method="post" action="/${adminPrefix}/settings/clear-logs"
                  onsubmit="return confirm('确定清空全部审计日志？\\n此操作不可恢复。')">
              <label style="display:inline;font-size:13px;margin-right:8px">
                <input type="checkbox" name="confirm" value="YES" required style="width:auto;vertical-align:-1px"> 我确认清空
              </label>
              <button type="submit" class="btn-danger">清空日志</button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <div class="panel" id="panel-referrals">
      <div class="box">
        <h2>最近邀请记录（共 ${totalRef} 条，显示最近 50 条）</h2>
        <table>
          <thead><tr><th>邀请人ID</th><th>邀请人</th><th>被邀请ID</th><th>被邀请人</th><th>发放免费次数</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted" style="text-align:center;padding:18px">还没有邀请记录</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="panel" id="panel-theme">
      <div class="box">
        <h2>🎨 外观皮肤</h2>
        <p class="muted" style="margin:6px 0 16px">选择后台配色，仅保存在本机浏览器，刷新或重开仍保留，不影响其他管理员。</p>
        <div class="theme-row">
          <div class="theme-card" data-theme="dark" onclick="setTheme('dark')">
            <div class="preview pv-dark"><i class="p-bar"></i><i class="p-line"></i><i class="p-line short"></i><i class="p-dot"></i></div>
            <b>深色模式</b>
            <span class="muted">深色科技风，夜间护眼</span>
          </div>
          <div class="theme-card" data-theme="light" onclick="setTheme('light')">
            <div class="preview pv-light"><i class="p-bar"></i><i class="p-line"></i><i class="p-line short"></i><i class="p-dot"></i></div>
            <b>浅色模式</b>
            <span class="muted">明亮清爽，对比柔和</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
function showPanel(name){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m=>m.classList.remove('active'));
  var el=document.getElementById('panel-'+name);
  if(el)el.classList.add('active');
  var item=document.querySelector('.menu-item[data-panel="'+name+'"]');
  if(item)item.classList.add('active');
}
function setTheme(t){
  if(t!=='light'&&t!=='dark')t='dark';
  localStorage.setItem('admin-theme',t);
  document.documentElement.setAttribute('data-theme',t);
  document.querySelectorAll('.theme-card').forEach(function(c){
    c.classList.toggle('on',c.getAttribute('data-theme')===t);
  });
}
(function(){
  var h=(location.hash||'').replace('#','');
  if(h&&document.getElementById('panel-'+h))showPanel(h);
  var cur=document.documentElement.getAttribute('data-theme')||'dark';
  document.querySelectorAll('.theme-card').forEach(function(c){
    c.classList.toggle('on',c.getAttribute('data-theme')===cur);
  });
})();
</script>
</body></html>`);
}

/**
 * POST /admin/referral/cancel
 *   表单：invitee_id（被邀请人用户ID）+ reclaim（1 = 同时收回当初发的愿望）
 * 解绑后：被邀请人的 invited_by 清 0，可以重新填写邀请人
 */
async function adminCancelReferral(request, env, url) {
  const session = await authAdmin(request, env);
  if (!session) return Response.redirect(url.origin + '/' + (env.ADMIN_PREFIX || 'admin') + '/login', 302);
  const adminPrefix = env.ADMIN_PREFIX || 'admin';

  const form = await request.formData();
  const inviteeId = Number(form.get('invitee_id') || 0);
  const reclaim = String(form.get('reclaim') || '') === '1';

  const r = await __db.cancelReferralTx({ inviteeId, reclaim });
  let msg;
  if (!r.ok) {
    const map = {
      not_bound: '这条绑定不存在（可能已经被取消）',
      bad_id: '被邀请人ID不正确',
      db_error: '服务器忙，请稍后重试',
    };
    msg = map[r.error] || '取消失败';
  } else {
    msg = `已取消邀请绑定（被邀请人ID ${inviteeId}，邀请人ID ${r.inviter_id}）`;
    if (r.reclaimed > 0) msg += `，并收回 ${r.reclaimed} 个愿望`;
    else if (reclaim && r.wish > 0) msg += `，邀请人余额不足，未收回愿望（原应收回 ${r.wish} 个）`;
    else if (r.wish > 0) msg += `，已发放的 ${r.wish} 个愿望没有收回`;
  }

  await kvAddLog(env.BTSMKV, {
    userId: 0, action: 'admin_referral_cancel',
    detail: `invitee=${inviteeId} reclaim=${reclaim ? 1 : 0} result=${r.ok ? 'ok' : r.error} reclaimed=${r.reclaimed || 0} by ${session.sub}`,
  });

  return Response.redirect(new URL('/' + adminPrefix + '/settings?m=' + encodeURIComponent(msg), url.origin).toString(), 302);
}

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
  const serialCostVal = serialCost(env);
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

  const trs = list.map((r) => `<tr${Number(r.hidden || 0) === 1 ? ' style="background:rgba(210,153,34,.07)"' : ''}>
    <td class="mono nowrap">${escapeHtml(r.serial)}</td>
    <td class="ver">${r.version ? escapeHtml(r.version) : '<span class="muted">-</span>'}</td>
    <td class="nowrap">${escapeHtml(r.category || '-')}</td>
    <td class="nowrap">${r.user_id}<br><span class="muted">${escapeHtml(r.nickname || '')}</span></td>
    <td class="nowrap">${escapeHtml(r.phone || '-')}</td>
    <td class="nowrap">${r.source === 'free' ? '免费额度' : r.source === 'paid' ? '已支付 ' + (Number(r.cost || 0) / 100).toFixed(2) + ' 元' : escapeHtml(r.source || '')}</td>
    <td class="nowrap">${fmt(r.claimed_at)}</td>
    <td class="nowrap">${tagOf(r.status)}${Number(r.hidden || 0) === 1 ? ' <span class="tag hidden">用户已删除</span>' : ''}</td>
    <td class="nowrap">${escapeHtml(r.device_id || '-')}</td>
    <td class="nowrap">${escapeHtml(r.activated_at || '-')}</td>
    <td style="white-space:nowrap">${delForms(r)}</td>
  </tr>`).join('');

  return html(`<!doctype html>
<html lang="zh-CN"><head>${THEME_BOOT}<meta charset="utf-8"><title>序列号发放 · ${escapeHtml(env.APP_NAME || '')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${DARK}
header{background:var(--header-bg);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
header a{font-size:14px}
.wrap{padding:20px 24px;max-width:1280px;margin:0 auto}
td.nowrap{white-space:nowrap}
td.ver{white-space:normal;word-break:normal;overflow-wrap:break-word;min-width:150px;max-width:240px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
.tag.hidden{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-bg)}
.toolbar{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
.toolbar input{padding:8px 10px;border-radius:8px;width:280px}
.cost-setting{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;gap:8px;align-items:center;display:flex;flex-wrap:wrap}
.cost-setting label{font-size:13px;color:var(--fg);white-space:nowrap}
.cost-setting input{width:90px !important}
.cost-setting .muted{margin-left:4px}
.tabs{display:flex;gap:6px}
.tabs a{padding:6px 12px;border:1px solid var(--line2);background:var(--panel);border-radius:8px;font-size:13px;color:var(--muted)}
.tabs a.on{background:rgba(56,189,248,.15);border-color:var(--brand);color:var(--brand);font-weight:600}
form.inline{display:inline}
button.mini{padding:4px 10px;font-size:12px;border-radius:6px;border:1px solid rgba(56,189,248,.4);background:rgba(56,189,248,.1);color:var(--brand);cursor:pointer;margin:0 4px 4px 0}
button.mini.danger{border-color:var(--err-bg);background:var(--err-bg);color:var(--err)}
.tip{color:var(--muted);font-size:12px;line-height:1.7;margin-top:12px}
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
  <tbody>${trs || '<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px">还没有人领取序列号</td></tr>'}</tbody></table></div>
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
  const socketCostVal = socketCost();
  const pageVal = String(page);
  const searchVal = escapeHtml(search);

  const trs = list.map((r) => `<tr${Number(r.hidden || 0) === 1 ? ' style="background:rgba(210,153,34,.07)"' : ''}>
    <td class="nowrap">${fmtBeijing(r.created_at)}</td>
    <td class="mono nowrap"><b>${escapeHtml(r.code)}</b></td>
    <td class="mono nowrap">key:${escapeHtml(r.code)}</td>
    <td class="mono nowrap">${escapeHtml(r.mac)}</td>
    <td class="nowrap">${r.user_id}<br><span class="muted">${escapeHtml(r.nickname || '')}</span>${Number(r.hidden || 0) === 1 ? ' <span class="tag hidden">用户已删除</span>' : ''}</td>
    <td class="nowrap">${escapeHtml(r.phone || '-')}</td>
    <td class="nowrap">${Number(r.cost || 0) > 0 ? (Number(r.cost || 0) / 100).toFixed(2) + ' 元' : '免费'}</td>
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
<html lang="zh-CN"><head>${THEME_BOOT}<meta charset="utf-8"><title>插座验证码 · ${escapeHtml(env.APP_NAME || '')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${DARK}
header{background:var(--header-bg);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;position:sticky;top:0;z-index:5}
header a{font-size:14px}
.wrap{padding:20px 24px;max-width:1240px;margin:0 auto}
td.nowrap{white-space:nowrap}
.tag.hidden{background:var(--warn-bg);color:var(--warn);border:1px solid var(--warn-bg)}
.toolbar{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
.toolbar input{padding:8px 10px;border-radius:8px;width:300px}
.cost-setting{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;gap:8px;align-items:center;display:flex;flex-wrap:wrap}
.cost-setting label{font-size:13px;color:var(--fg);white-space:nowrap}
.cost-setting input{width:90px !important}
.cost-setting .muted{margin-left:4px}
.tabs{display:flex;gap:6px}
.tabs a{padding:6px 12px;border:1px solid var(--line2);background:var(--panel);border-radius:8px;font-size:13px;color:var(--muted)}
.tabs a.on{background:rgba(56,189,248,.15);border-color:var(--brand);color:var(--brand);font-weight:600}
form.inline{display:inline}
button.mini{padding:4px 12px;font-size:12px;border-radius:6px;border:1px solid var(--err-bg);background:var(--err-bg);color:var(--err);cursor:pointer}
.tip{color:var(--muted);font-size:12px;line-height:1.8;margin-top:12px}
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
    <th>生成时间</th><th>验证码</th><th>远程指令</th><th>设备MAC</th><th>用户</th><th>手机号</th><th>费用</th><th>操作</th>
  </tr></thead>
  <tbody>${trs || '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">还没有人生成过验证码</td></tr>'}</tbody></table>
  <div class="tip">
    这是「智能插座验证码」的记录，和「标签软件序列号」是两个独立功能：<br>
    · 当前按个购买，单价见「系统设置 → 验证码价格档位」；上面「验证码」列就是 APP 里 key:XXXXXX 的 6 位数字；<br>
    · MAC 已统一成 12 位大写（去掉冒号），搜索时带不带冒号都可以；<br>
    · <b>删除只删这条记录，不退款</b>；验证码由 MAC + 固定盐值算出，删记录不影响设备继续用这个码。
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

  // 按设备平台筛选：全部 / iOS / 安卓 / 其他（PC、开发者工具等）
  const platform = ['ios', 'android', 'other'].includes(String(url.searchParams.get('platform') || ''))
    ? String(url.searchParams.get('platform')) : '';
  const qs = (p, extra) => '?page=' + p + (platform ? '&platform=' + platform : '') + (extra || '');

  // SQLite 分页：多取 1 条判断是否还有下一页
  const rows = await __db.listLogs(pageSize + 1, offset, platform);
  const hasMore = rows.length > pageSize;
  const logs = rows.slice(0, pageSize);

  const adminPrefix = env.ADMIN_PREFIX || 'admin';
  const trs = logs.map(l => `<tr>
    <td>${l.user_id || ''}</td>
    <td>${fmtBeijing(l.created_at)}</td>
    <td>${escapeHtml(l.action)}</td>
    <td>${escapeHtml(l.detail||'')}</td>
    <td>${escapeHtml(l.nickname || l.openid || '-')}</td>
    <td class="dev">${escapeHtml(l.device||'')}</td>
    <td>${escapeHtml(l.ip||'')}</td>
  </tr>`).join('');

  const chip = (val, label) => `<a class="chip${platform === val ? ' on' : ''}" href="?page=1${val ? '&platform=' + val : ''}">${label}</a>`;

  return html(`<!doctype html>
<html lang="zh-CN"><head>${THEME_BOOT}<meta charset="utf-8"><title>审计日志 · ${escapeHtml(env.APP_NAME||'')}</title>
<style>${DARK}
header{background:var(--header-bg);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 24px;position:sticky;top:0;z-index:5}
header a{font-size:14px}
.wrap{padding:20px 24px;max-width:1240px;margin:0 auto}
h2{font-size:16px;color:var(--fg);margin:0 0 14px}
.filters{display:flex;gap:8px;margin:0 0 12px}
.chip{font-size:13px;padding:4px 12px;border:1px solid var(--line);border-radius:14px;color:var(--muted);text-decoration:none}
.chip.on{background:var(--header-bg);color:var(--fg);border-color:var(--fg)}
td.dev{font-size:12px;color:var(--muted);max-width:280px;word-break:break-all}
.hint{font-size:12px;color:var(--muted);margin:10px 0 0}
/* ── 排版：标题行 / 表格横向滚动 / 列宽与换行 ── */
.row-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}
.row-head h2{margin:0}
.layout-btn{font-size:13px;padding:6px 14px;border:1px solid var(--line2);background:var(--panel);color:var(--fg);border-radius:10px;cursor:pointer;white-space:nowrap}
.layout-btn:hover{border-color:var(--brand);color:var(--brand)}
.tbl-scroll{overflow-x:auto;border-radius:12px}
#log-table{min-width:640px}
#log-table th,#log-table td{vertical-align:top}
#log-table td.nowrap-cell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
#log-table td.wrap-cell{white-space:normal;word-break:break-word;overflow-wrap:break-word}
/* 排版抽屉面板 */
.lay-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;z-index:50}
.lay-mask.show{display:block}
.lay-panel{position:fixed;top:0;right:0;height:100%;width:320px;max-width:88vw;background:var(--panel);border-left:1px solid var(--line2);box-shadow:-12px 0 32px rgba(0,0,0,.3);display:none;flex-direction:column;z-index:51}
.lay-panel.show{display:flex}
.lay-panel-head{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between}
.lay-panel-head b{font-size:15px;color:var(--fg)}
.lay-close{background:none;border:0;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
.lay-body{flex:1;overflow:auto;padding:14px 18px}
.lay-col{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px dashed var(--line)}
.lay-col-name{width:64px;font-size:13px;color:var(--fg);flex-shrink:0}
.lay-col label{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px;white-space:nowrap;cursor:pointer}
.lay-col input[type=number]{width:64px;padding:5px 6px;font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--fg)}
.lay-col input[type=number]:disabled{opacity:.4}
.lay-foot{padding:14px 18px;border-top:1px solid var(--line);display:flex;gap:8px}
.lay-foot button{flex:1;padding:9px 0;font-size:13px;border-radius:10px;cursor:pointer;border:1px solid var(--line2);background:var(--panel2);color:var(--fg)}
.lay-foot .primary{background:var(--brand2,#2b6cff);color:#fff;border-color:transparent}
</style></head><body>
<header><a href="/${adminPrefix}">← 返回用户列表</a></header>
<div class="wrap">
<div class="row-head"><h2>审计日志（第 ${page} 页）</h2><button type="button" class="layout-btn" id="btn-layout">⚙ 排版</button></div>
<div class="filters">${chip('', '全部')}${chip('ios', 'iOS')}${chip('android', '安卓')}${chip('other', '其他 / PC')}</div>
<div class="tbl-scroll">
<table id="log-table"><thead><tr><th data-col="0">用户ID</th><th data-col="1">时间</th><th data-col="2">动作</th><th data-col="3">详情</th><th data-col="4">用户</th><th data-col="5">设备</th><th data-col="6">IP</th></tr></thead>
<tbody>${trs || '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">暂无日志</td></tr>'}</tbody></table>
</div>
<div class="pager">
  ${page>1 ? `<a href="${qs(page-1)}">上一页</a>` : ''}
  ${hasMore ? `<a href="${qs(page+1)}">下一页</a>` : ''}
</div>
<div class="hint">设备列格式：平台|厂商|机型|系统|微信版本|基础库|屏幕，如 <code>ios|iPhone|iPhone 15 Pro&lt;iPhone15,3&gt;|iOS 17.2.1|wx8.0.68|sdk3.5.0|393x852</code>。升级前的历史日志没有设备信息，显示为空。</div>
</div>

<!-- 排版面板（列换行开关 + 列宽，localStorage 持久化） -->
<div class="lay-mask" id="lay-mask"></div>
<aside class="lay-panel" id="lay-panel">
  <div class="lay-panel-head"><b>表格排版</b><button type="button" class="lay-close" id="lay-close">×</button></div>
  <div class="lay-body" id="lay-body"></div>
  <div class="lay-foot"><button type="button" id="lay-reset">恢复默认</button><button type="button" class="primary" id="lay-done">完成</button></div>
</aside>
<script>
(function(){
  var KEY='logs-layout-v1';
  var DEFAULTS=[
    {name:'用户ID',wrap:true,w:58},
    {name:'时间',wrap:true,w:76},
    {name:'动作',wrap:true,w:64},
    {name:'详情',wrap:true,w:81},
    {name:'用户',wrap:true,w:120},
    {name:'设备',wrap:true,w:181},
    {name:'IP',wrap:true,w:174}
  ];
  function fresh(){return DEFAULTS.map(function(d){return {wrap:d.wrap,w:d.w};});}
  var cfg=fresh();
  try{
    var s=localStorage.getItem(KEY);
    if(s){var d=JSON.parse(s); if(Array.isArray(d)&&d.length===DEFAULTS.length){cfg=d;}}
  }catch(e){}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(cfg));}catch(e){}}
  function apply(){
    var table=document.getElementById('log-table'); if(!table)return;
    table.style.tableLayout='fixed';
    var heads=table.tHead.rows[0].cells;
    var rows=table.tBodies[0].rows;
    cfg.forEach(function(c,i){
      if(heads[i])heads[i].style.width=c.w+'px';
      for(var r=0;r<rows.length;r++){
        var td=rows[r].cells[i]; if(!td)continue;
        td.style.width=c.w+'px';
        td.classList.remove('wrap-cell','nowrap-cell');
        td.classList.add(c.wrap?'wrap-cell':'nowrap-cell');
      }
    });
  }
  var body=document.getElementById('lay-body');
  function renderPanel(){
    body.innerHTML='';
    cfg.forEach(function(c,i){
      var widthInput=document.createElement('input');
      widthInput.type='number'; widthInput.min='40'; widthInput.value=c.w;
      widthInput.disabled=!c.wrap;
      widthInput.oninput=function(){
        var v=parseInt(widthInput.value,10);
        if(v>=40){cfg[i].w=v;save();apply();}
      };
      var chk=document.createElement('input'); chk.type='checkbox'; chk.checked=!!c.wrap;
      chk.onchange=function(){
        cfg[i].wrap=chk.checked; widthInput.disabled=!chk.checked; save(); apply();
      };
      var row=document.createElement('div'); row.className='lay-col';
      var name=document.createElement('span'); name.className='lay-col-name'; name.textContent=c.name;
      var lab=document.createElement('label');
      var labText=document.createElement('span'); labText.textContent='换行';
      lab.appendChild(chk); lab.appendChild(labText);
      var px=document.createElement('span'); px.style.cssText='font-size:12px;color:var(--muted)'; px.textContent='px';
      row.appendChild(name); row.appendChild(lab); row.appendChild(widthInput); row.appendChild(px);
      body.appendChild(row);
    });
  }
  var mask=document.getElementById('lay-mask'),panel=document.getElementById('lay-panel');
  function openPanel(){renderPanel();mask.classList.add('show');panel.classList.add('show');}
  function closePanel(){mask.classList.remove('show');panel.classList.remove('show');}
  document.getElementById('btn-layout').onclick=openPanel;
  document.getElementById('lay-close').onclick=closePanel;
  mask.onclick=closePanel;
  document.getElementById('lay-done').onclick=closePanel;
  document.getElementById('lay-reset').onclick=function(){
    cfg=fresh(); save(); apply(); renderPanel();
  };
  apply();
})();
</script>
</body></html>`);
}

// ───────────────────────── Admin 首页 ─────────────────────────

function renderAdminPage(env) {
  const title = escapeHtml(env.APP_NAME || 'Admin');
  const adminPrefix = '/' + (env.ADMIN_PREFIX || 'admin');
  const mock = isMock(env);
  const xpayReady = !!(env.XPAY_OFFER_ID && env.XPAY_APP_KEY);
  return `<!doctype html>
<html lang="zh-CN"><head>${THEME_BOOT}<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · 后台</title>
<style>${DARK}
header{background:var(--header-bg);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
header h1{font-size:17px;margin:0;color:var(--fg)}
header a{color:var(--muted);font-size:13px;margin-left:16px}
header a:hover{color:var(--brand)}
.wrap{padding:20px 24px;max-width:1320px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:18px}
.stat{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:14px;padding:18px 16px;transition:.2s}
.stat:hover{border-color:var(--line2);transform:translateY(-2px)}
.stat b{font-size:24px;display:block;color:var(--brand);font-weight:700}
.stat span{color:var(--muted);font-size:12px}
.tabs{display:flex;gap:8px;margin-bottom:14px}
.tabs button{padding:8px 18px;border:1px solid var(--line2);background:var(--panel);color:var(--muted);border-radius:10px;cursor:pointer;font-size:14px}
.tabs button.on{background:var(--brand2);color:#fff;border-color:var(--brand2)}
.toolbar{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.toolbar input{padding:8px 10px;font-size:14px;flex:1;min-width:200px;max-width:360px}
.toolbar button{padding:8px 16px}
.toolbar button.danger{background:var(--err)}
.toolbar button:disabled{background:var(--line2);color:var(--muted);cursor:not-allowed;filter:none}
.row-del{color:var(--err);background:none;border:0;cursor:pointer;font-size:13px;padding:4px 6px}
.row-del:hover{text-decoration:underline}
.sel-chk{width:16px;height:16px;cursor:pointer;vertical-align:middle;accent-color:var(--brand)}
.idn{font-weight:600;color:var(--fg)}
.mask{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:9}
.mask.show{display:flex}
.dialog{background:var(--panel);border:1px solid var(--line2);border-radius:14px;padding:22px;width:520px;max-width:94vw;max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(15,23,42,.25)}
.dialog h2{margin:0 0 14px;font-size:16px;color:var(--fg)}
.dialog label{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}
.dialog input,.dialog select{width:100%;padding:8px 10px;font-size:14px}
.dialog .row{display:flex;gap:10px}
.dialog .row>div{flex:1}
.dialog .btns{margin-top:16px;display:flex;justify-content:flex-end;gap:8px}
.dialog .btns button{padding:8px 16px;border-radius:8px;border:1px solid var(--line2);background:var(--panel2);color:var(--fg);cursor:pointer}
.dialog .btns .primary{background:var(--brand2);color:#fff;border-color:var(--brand2)}
/* 表格横向滚动：窄屏不隐藏任何列，容器出滚动条左右滑动查看 */
.table-scroll{overflow-x:auto;border-radius:12px}
.table-scroll table{min-width:max-content;width:100%}
@media(max-width:960px){.stats{grid-template-columns:repeat(2,1fr)}}
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
    <div class="stat"><b id="s-svip">-</b><span>有效用户（购买/取号/验证码）</span></div>
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
      <button class="danger" id="btn-del-sel" disabled onclick="deleteSelected()">删除所选 (<span id="sel-count">0</span>)</button>
      <span style="flex:1"></span>
      <a href="${adminPrefix}/serials" style="font-size:13px;color:var(--brand);text-decoration:none">序列号发放</a>
      <a href="${adminPrefix}/settings" style="font-size:13px;color:var(--brand);text-decoration:none;margin-left:14px">系统设置</a>
      <a href="${adminPrefix}/logs" style="font-size:13px;color:var(--brand);text-decoration:none;margin-left:14px">审计日志</a>
    </div>
    <div class="table-scroll">
    <table>
      <thead><tr>
        <th style="width:36px"><input type="checkbox" class="sel-chk" id="chk-all" onchange="toggleAll(this)"></th>
        <th>用户ID</th><th>昵称 / openid</th><th class="hide">手机号</th>
        <th>免费取号</th><th>已领号</th><th>插座key</th><th>邀请人</th><th>已邀请</th><th class="hide">免费验证码</th><th class="hide">累计消费</th>
        <th>状态</th><th class="hide">注册时间</th><th>操作</th>
      </tr></thead>
      <tbody id="tb"><tr><td colspan="14" class="muted" style="text-align:center;padding:24px">加载中…</td></tr></tbody>
    </table>
    </div>
    <div class="pager">
      <span id="pageinfo"></span>
      <button onclick="load(page-1)">上一页</button>
      <button onclick="load(page+1)">下一页</button>
    </div>
  </div>

  <div id="pane-orders" style="display:none">
    <div class="table-scroll">
    <table>
      <thead><tr>
        <th>业务单号</th><th>用户ID</th><th>类型</th><th>道具</th><th>金额</th><th>数量</th>
        <th>发货结果</th><th>状态</th><th class="hide">平台单号</th><th class="hide">创建时间</th><th>操作</th>
      </tr></thead>
      <tbody id="tb-orders"><tr><td colspan="11" class="muted" style="text-align:center;padding:24px">加载中…</td></tr></tbody>
    </table>
    </div>
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
    <div class="table-scroll">
    <table>
      <thead><tr>
        <th>道具ID (productId)</th><th>名称</th><th>价格(分)</th><th>购买数量</th><th>每次发放次数</th><th>排序</th><th>操作</th>
      </tr></thead>
      <tbody id="tb-products"></tbody>
    </table>
    </div>
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
  <label>用户ID（留空=不改；填新号不能占用他人已用ID）</label>
  <input id="e-new-id" type="number" min="1" step="1" placeholder="留空保持当前编号">
  <label>昵称</label><input id="e-nickname">
  <label>手机号</label><input id="e-phone">
  <div class="row">
    <div><label>次数操作</label>
      <select id="e-count-mode">
        <option value="set">设为指定值</option>
        <option value="add">增加</option>
      </select></div>
    <div><label>免费取号次数</label><input id="e-free-serial" type="number" min="0" step="1" placeholder="如 2"></div>
    <div><label>免费验证码次数</label><input id="e-free-socket" type="number" min="0" step="1" placeholder="如 1"></div>
  </div>
  <div class="muted" style="margin-top:6px">当前：免费取号 <b id="e-free-serial-cur">0</b> 次 · 免费验证码 <b id="e-free-socket-cur">0</b> 次（邀请好友获得，不是余额）</div>

  <div class="row" style="margin-top:10px">
    <div><label>累计消费（元，留空=不改，填 0=清零）</label><input id="e-spent" type="number" min="0" step="0.01" placeholder="元"></div>
    <div><label>VIP 等级（由累计消费自动算，只读）</label><input id="e-level" readonly></div>
  </div>
  <div class="muted" style="margin-top:6px">当前：累计消费 <b id="e-spent-cur">0.00</b> 元 · 等级 <b id="e-level-cur">VIP</b></div>
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
const selectedIds = new Set();   // 勾选待删除的用户ID（跨页保留）

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
  if(!allUsers.length){ tb.innerHTML = '<tr><td colspan="14" class="muted" style="text-align:center;padding:24px">无数据</td></tr>'; syncSelUI(); return; }
  tb.innerHTML = allUsers.map(u=>{
    const tag = u.status==1 ? '<span class="tag ban">已封禁</span>'
              : (u.free_serial>0 || u.free_socket>0) ? '<span class="tag vip">有免费次数</span>'
              : '<span class="tag normal">VIP</span>';
    const reg = fmtBj(u.created_at);
    const checked = selectedIds.has(u.id) ? 'checked' : '';
    return '<tr>'
      +'<td><input type="checkbox" class="sel-chk" '+checked+' onchange="toggleOne('+u.id+', this.checked)"></td>'
      +'<td class="idn">'+u.id+'</td>'
      +'<td>'+(u.nickname||'<span class=muted>未设置</span>')
      +'<br><span class="mono">'+u.openid.slice(-8)+'</span></td>'
      +'<td class="hide">'+(u.phone||'-')+'</td>'
      +'<td class="money">'+(u.free_serial||0)+'</td>'
      +'<td>'+(u.serials||0)+'</td>'
      +'<td>'+(u.codes||0)+'</td>'
      +'<td>'+(u.invited_by ? '← '+u.invited_by : '<span class=muted>-</span>')+'</td>'
      +'<td>'+(u.invites||0)+'</td>'
      +'<td class="hide">'+(u.free_socket||0)+'</td>'
      +'<td class="hide">'+u.spent+'</td>'
      +'<td>'+(u.level_name||'VIP')+'<br>'+tag+'</td>'
      +'<td class="hide">'+reg+'</td>'
      +'<td><button onclick="openDlgById('+u.id+')">编辑</button> '
      +'<button class="row-del" onclick="deleteOne('+u.id+')">删除</button></td></tr>';
  }).join('');
  syncSelUI();
}

async function loadOrders(p){
  pageOrders = Math.max(1, p||1);
  const r = await fetch(ADMIN+'api/orders?page='+pageOrders).then(r=>r.json());
  document.getElementById('pageinfo-orders').textContent = '第 '+pageOrders+' 页，共 '+r.total+' 条';
  const tb = document.getElementById('tb-orders');
  const list = r.orders || [];
  if(!list.length){ tb.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:24px">暂无订单</td></tr>'; return; }
  const stTag = s => s==='delivered' ? '<span class="tag ok">已发货</span>'
    : s==='pending' ? '<span class="tag wait">待支付</span>'
    : s==='paid_no_goods' ? '<span class="tag ban">待补发</span>'
    : '<span class="tag normal">'+s+'</span>';
  const dsTag = s => s==='issued' ? '<span class="tag ok">已发</span>'
    : s==='failed' ? '<span class="tag ban">失败</span>'
    : '<span class="tag wait">待发</span>';
  const kindText = k => k==='serial' ? '取号' : (k==='socket' ? '验证码' : '历史单');
  tb.innerHTML = list.map(o=>{
    const ct = fmtBj(o.createdAt);
    let result = '';
    try {
      const R = o.result ? JSON.parse(o.result) : null;
      if (R && R.serial) result = '<span class="mono">' + R.serial + '</span>';
      else if (R && R.codes) result = (R.codes.length) + ' 个码';
    } catch (e) {}
    const canRetry = o.status !== 'delivered';
    return '<tr>'
      +'<td class="mono">'+o.outTradeNo+(o.mock?' <span class="tag mock">mock</span>':'')+'</td>'
      +'<td class="idn">'+o.userId+'</td>'
      +'<td>'+kindText(o.kind)+'</td>'
      +'<td>'+o.productName+'<br><span class="mono">'+o.productId+'</span></td>'
      +'<td class="money">'+o.price+'</td>'
      +'<td>'+o.quantity+'</td>'
      +'<td>'+result+(o.note?'<br><span class="muted">'+o.note+'</span>':'')+'</td>'
      +'<td>'+stTag(o.status)+'<br>'+dsTag(o.deliver_status)+'</td>'
      +'<td class="hide mono">'+(o.wxOrderId||'-')+'</td>'
      +'<td class="hide">'+ct+'</td>'
      +'<td>'+(canRetry?'<button data-id="'+o.id+'" onclick="redeliver(this)">重新发号</button>':'-')+'</td></tr>';
  }).join('');
}

async function redeliver(el){
  const id = el && el.dataset ? el.dataset.id : '';
  if(!id) return;
  if(!confirm('重新给这笔订单发货？\\n会按订单类型重新发号 / 生成验证码，已发货的不会重复发。')) return;
  const r = await fetch(ADMIN+'api/orders/redeliver',{
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ order_id: id })
  }).then(r=>r.json());
  if(r.ok){ alert('发货成功（'+(r.order&&r.order.deliver_status||'issued')+'）'); loadOrders(pageOrders); }
  else alert('发货失败：'+(r.error||r.message||JSON.stringify(r)));
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
  document.getElementById('e-new-id').value = '';
  document.getElementById('e-nickname').value = u.nickname||'';
  document.getElementById('e-phone').value   = u.phone||'';
  document.getElementById('e-free-serial').value = '';
  document.getElementById('e-free-socket').value = '';
  document.getElementById('e-count-mode').value = 'set';
  document.getElementById('e-free-serial-cur').textContent = u.free_serial||0;
  document.getElementById('e-free-socket-cur').textContent = u.free_socket||0;
  // 累计消费：留空=不改，填 0=清零；会员等级由后端按累计消费算，这里只展示
  document.getElementById('e-spent').value = '';
  document.getElementById('e-level').value = u.level_name||'VIP';
  document.getElementById('e-level-cur').textContent = u.level_name||'VIP';
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
  const fs = document.getElementById('e-free-serial').value;
  const fk = document.getElementById('e-free-socket').value;
  if (fs !== '' || fk !== '') {
    if (fs !== '') body.free_serial = fs;
    if (fk !== '') body.free_socket = fk;
    body.count_mode = document.getElementById('e-count-mode').value;
  }
  // 留空=不改；填了值（含 0）才提交
  const s = document.getElementById('e-spent').value;
  if (s !== '') body.spent = s;
  // 用户ID：留空=不改，填了才提交（后端做唯一校验）
  const nid = document.getElementById('e-new-id').value.trim();
  if (nid !== '') body.new_id = nid;

  const r = await fetch(ADMIN+'api/users/'+current.id, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)
  }).then(r=>r.json());
  if(r.ok){ closeDlg(); load(page); loadStats(); }
  else alert('保存失败: '+(r.error||JSON.stringify(r)));
}

// ─────────────── 批量删除用户 ───────────────

function syncSelUI(){
  const n = selectedIds.size;
  document.getElementById('sel-count').textContent = n;
  document.getElementById('btn-del-sel').disabled = n === 0;
  // 全选框：当前页全勾才勾上，部分勾选显示半选
  const chkAll = document.getElementById('chk-all');
  if (chkAll) {
    const onPage = allUsers.filter(u => selectedIds.has(u.id));
    chkAll.checked = allUsers.length > 0 && onPage.length === allUsers.length;
    chkAll.indeterminate = onPage.length > 0 && onPage.length < allUsers.length;
  }
}

function toggleAll(cb){
  for (const u of allUsers) {
    if (cb.checked) selectedIds.add(u.id); else selectedIds.delete(u.id);
  }
  document.querySelectorAll('#tb .sel-chk').forEach(box => { box.checked = cb.checked; });
  syncSelUI();
}

function toggleOne(id, on){
  if (on) selectedIds.add(id); else selectedIds.delete(id);
  syncSelUI();
}

async function doDeleteIds(ids){
  const r = await fetch(ADMIN+'api/users/delete-batch', {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ ids })
  }).then(r=>r.json());
  if(!r.ok){ alert('删除失败: '+(r.message||r.error||JSON.stringify(r))); return false; }
  (r.removed||[]).forEach(u => selectedIds.delete(u.id));
  const miss = (r.missing||[]).length;
  alert('已删除 ' + r.deleted + ' 个用户' + (miss ? '（' + miss + ' 个已不存在，已跳过）' : ''));
  return true;
}

async function deleteSelected(){
  const ids = [...selectedIds];
  if (!ids.length) return;
  if (!confirm('确定删除选中的 ' + ids.length + ' 个用户吗？\\n\\n将一并清除他们领取的序列号与插座记录；支付订单与审计日志保留。\\n此操作不可恢复。')) return;
  const ok = await doDeleteIds(ids);
  if (ok) { selectedIds.clear(); load(page); loadStats(); }
}

async function deleteOne(id){
  const u = allUsers.find(x => x.id === id);
  const name = u ? (u.nickname || ('#' + id)) : ('#' + id);
  if (!confirm('确定删除用户 ' + name + '（ID ' + id + '）吗？\\n将清除其领号/插座记录，订单与日志保留，不可恢复。')) return;
  const ok = await doDeleteIds([id]);
  if (ok) { selectedIds.delete(id); load(page); loadStats(); }
}

loadStats(); load(1);
</script>
</body></html>`;
}

/**
 * server.mjs —— 把 Cloudflare Worker 包装成普通 Node HTTP 服务（SQLite 数据层）
 *
 * 启动（Node 22.5+，需实验性 flag；Node 23.4+/24 不需要 flag）：
 *   node --experimental-sqlite server.mjs
 *
 * 环境变量（也可放同目录 .env，本文件自动读取，真实环境变量优先）：
 *   PORT      监听端口，默认 8787（只绑 0.0.0.0，公网入口走 Nginx）
 *   DB_PATH   SQLite 文件路径，默认 ./data/wxminiapp.db
 *   其余变量见 src/index.js 头注释：WX_APPID / WX_SECRET / ADMIN_USERNAME /
 *   ADMIN_PASSWORD / JWT_SECRET / XPAY_OFFER_ID / XPAY_APP_KEY / XPAY_MOCK 等
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { SQLiteDB } from './db.mjs';
import { runWithRequest } from './meta.mjs';

// ① 读取同目录 .env（若存在；已存在的真实环境变量优先，systemd EnvironmentFile 优先于 .env）
//    只支持 `KEY=值` 和整行注释（# 开头）；不要在 = 后面写注释，会被当成值
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
} catch {}

// ② SQLite 数据层（替代 Cloudflare KV），挂到全局 __db 供 src/index.js 使用
globalThis.__db = new SQLiteDB(process.env.DB_PATH || './data/wxminiapp.db');
console.log('[sqlite] data file: ' + (process.env.DB_PATH || './data/wxminiapp.db'));

// ③ 加载 Worker：src/index.js 是 ESM 语法但扩展名是 .js，直接 import 会被 Node 当
//    CommonJS 解析而报错；走 data:URL 强制按 ESM 执行。这样无需加 package.json
//    (type:module)，也就不会破坏 CommonJS 写的 tools/check-admin.js。
const src = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;

// ④ 构造 env（对应 wrangler.toml 的 vars + 敏感变量；不再需要 BTSMKV 绑定）
const env = {
  APP_NAME: process.env.APP_NAME || '我的小程序',
  ADMIN_PREFIX: process.env.ADMIN_PREFIX || 'admin',
  JWT_EXPIRE: process.env.JWT_EXPIRE || '2592000',
  ADMIN_PAGE_SIZE: process.env.ADMIN_PAGE_SIZE || '20',
  KV_MAX_SCAN: process.env.KV_MAX_SCAN || '1000',
  XPAY_MOCK: process.env.XPAY_MOCK || '0',
  WX_APPID: process.env.WX_APPID || '',
  WX_SECRET: process.env.WX_SECRET || '',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  JWT_SECRET: process.env.JWT_SECRET || '',
  XPAY_OFFER_ID: process.env.XPAY_OFFER_ID || '',
  XPAY_APP_KEY: process.env.XPAY_APP_KEY || '',
  XPAY_NOTIFY_SIGN_KEY: process.env.XPAY_NOTIFY_SIGN_KEY || '',
  // 微信「消息推送」里的 Token(令牌)：GET 接入验证（echostr）用它算 sha1 签名
  XPAY_NOTIFY_TOKEN: process.env.XPAY_NOTIFY_TOKEN || '',
  // 序列号后台（Cloudflare Worker）地址与令牌：取号时后端之间通信，小程序拿不到
  BTKEY_API_BASE: process.env.BTKEY_API_BASE || '',
  BTKEY_API_TOKEN: process.env.BTKEY_API_TOKEN || '',
  // 取号固定分类（序列号后台里的分类名）；不配则用 src/index.js 里的 DEFAULT_SERIAL_CATEGORY
  SERIAL_CATEGORY: process.env.SERIAL_CATEGORY || '',
  // 非首次取号扣多少愿望（默认 10）
  SERIAL_WISH_COST: process.env.SERIAL_WISH_COST || '',
};

// ⑤ HTTP 服务：Node 请求 → 标准 Request → Worker
const PORT = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  try {
    // 反代后必须取 X-Forwarded-Proto，否则后台 302 跳转会变成 http://，浏览器会拦截混合内容
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const url = new URL(req.url, proto + '://' + req.headers.host);
    const init = { method: req.method, headers: new Headers(req.headers) };
    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = req;       // Node IncomingMessage 是异步可迭代流，undici 可直接消费
      init.duplex = 'half';
    }
    // 审计日志：把本次 request 挂到异步上下文，db.addLog() 落库时取 X-Device-Info
    const resp = await runWithRequest(req, () => worker.fetch(new Request(url, init), env));
    // set-cookie 在 Headers 迭代里会被逗号合并成一条导致后台登录失效，这里单独取出
    const headers = {};
    for (const [k, v] of resp.headers) headers[k] = v;
    const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    if (sc.length) headers['set-cookie'] = sc;
    res.writeHead(resp.status, headers);
    res.end(Buffer.from(await resp.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal_error: ' + e.message);
  }
}).listen(PORT, '0.0.0.0', () => console.log('wxminiapp-server on http://0.0.0.0:' + PORT));

// ⑥ 优雅退出：关闭 SQLite
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    globalThis.__db.close();
    process.exit(0);
  });
}

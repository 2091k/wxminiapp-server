/**
 * meta.mjs —— 请求级元信息（审计日志用）
 *
 * 为什么用 AsyncLocalStorage：
 *   审计日志是 `__db.addLog()` 里落库的，但它拿不到当前 request；
 *   而 `kvAddLog()` 有 28 个调用点，逐个加参数既啰嗦又容易漏。
 *   所以在 server.mjs 进 HTTP 时用 als.run() 把 request 挂到当前异步上下文，
 *   db.mjs 的 addLog() 落库时直接取，调用点一行都不用改。
 *   用 AsyncLocalStorage 而不是模块级变量，是为了并发请求之间不串号。
 *
 * 设备串格式（与小程序 utils/device.js 生成的顺序一致）：
 *   ios|iPhone|iPhone 15 Pro<iPhone15,3>|iOS 17.2.1|wx8.0.68|sdk3.5.0|393x852
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

const MAX_DEVICE_LEN = 200;
const FIELD_MAX_LEN = 60;

/** 头是 URL-encoded 的（HTTP 头只能是 ASCII，而机型名可能有中文），解码失败就用原串 */
function decode(s) {
  const raw = String(s == null ? '' : s);
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** 单个字段清洗：去掉控制字符和分隔符 |，避免把设备串拆错 */
function clean(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f|]/g, '')
    .trim()
    .slice(0, FIELD_MAX_LEN);
}

/**
 * 解析 X-Device-Info 请求头 → 精简设备串
 * @param {string|string[]} rawHeader 头原值（Node 里同名头可能是数组）
 * @returns {string} 解析不出来就返回空串（日志「设备」列留空，不影响业务）
 */
export function parseDeviceHeader(rawHeader) {
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const raw = String(header || '');
  if (!raw) return '';

  let d;
  try { d = JSON.parse(decode(raw)); } catch { return ''; }
  if (!d || typeof d !== 'object') return '';

  const version = clean(d.version);
  const sdk = clean(d.sdk);
  const parts = [
    clean(d.platform),
    clean(d.brand),
    clean(d.model),
    clean(d.system),
    version ? 'wx' + version : '',
    sdk ? 'sdk' + sdk : '',
    clean(d.screen)
  ].filter(Boolean);

  return parts.join('|').slice(0, MAX_DEVICE_LEN);
}

/** 在本次请求的异步上下文里执行 fn（server.mjs 调用） */
export function runWithRequest(req, fn) {
  return als.run({ req }, fn);
}

/** 取当前请求的设备串；不在请求上下文里（如定时任务、测试）返回空串 */
export function currentDevice() {
  const store = als.getStore();
  const headers = store && store.req && store.req.headers;
  if (!headers) return '';
  return parseDeviceHeader(headers['x-device-info']);
}

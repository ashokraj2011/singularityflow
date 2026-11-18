/** Local workspace transport contracts. No workflow rules or host command rendering. */
export const PROTOCOL = 1;
export const MAX_BODY = 256 * 1024;
export const MAX_CONTENT = 5 * 1024 * 1024;
export const MAX_NATIVE_BODY = 1024 * 1024;
export const MAX_REPLY = 8 * 1024 * 1024;
export const MAX_PENDING = 16;
export const MAX_RUNNING = 2;
export const TICKET_MS = 60_000;
export const SESSION_MS = 30 * 60_000;

export class UiError extends Error {
  constructor(code, message, details = null, status = 400) {
    super(message); this.name = 'UiError'; this.code = code; this.details = details; this.status = status;
  }
}
export function insist(condition, code, message, status = 400) {
  if (!condition) throw new UiError(code, message, null, status);
}
export function record(value, keys) {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'UI_REQUEST_INVALID', 'Expected an object.');
  insist(Object.keys(value).every(key => keys.includes(key)), 'UI_REQUEST_INVALID', 'Unexpected request field.');
  return value;
}
export function text(value, label, max = 512, optional = false) {
  if (optional && value == null) return null;
  insist(typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'),
    'UI_REQUEST_INVALID', `${label} must contain 1–${max} characters.`);
  return value;
}
export function identifier(value, label) {
  text(value, label, 256);
  insist(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value), 'UI_REQUEST_INVALID', `${label} is invalid.`);
  return value;
}
export function idleMinutes(value = 10) {
  const n = Number(value);
  insist(Number.isInteger(n) && n >= 1 && n <= 60, 'UI_IDLE_INVALID', 'Idle timeout must be 1–60 minutes.');
  return n;
}
/** Native-only process scope; never accepted from browser operations or returned to the browser. */
export function nativeEnvironment(value = process.env) {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'UI_NATIVE_SCOPE_INVALID', 'The native client environment is invalid.');
  // A shell can export names no child looks up by name (a bash function's `BASH_FUNC_name%%`): those are left
  // out rather than refusing the person's launch. Values keep their limits.
  const entries = Object.entries(value).filter(([key, item]) => item !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key));
  insist(entries.length <= 512 && entries.every(([, item]) => typeof item === 'string' && item.length <= 65536 && !item.includes('\0'))
    && JSON.stringify(entries).length <= 512 * 1024, 'UI_NATIVE_SCOPE_INVALID', 'The native client environment exceeds its scope limits.');
  return Object.freeze(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
}
export function environmentScope(environment) {
  const transient = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'SINGULARITY_FLOW_PERF_ACTION_ID', 'SINGULARITY_FLOW_PERF_PARENT_SPAN_ID']);
  return JSON.stringify(Object.entries(environment).filter(([key]) => !transient.has(key)));
}
export function errorData(error) {
  return { code: error.code ?? 'UI_INTERNAL_ERROR', message: error.message ?? 'Local workspace request failed.',
    ...(error.details == null ? {} : { details: error.details }),
    ...(error.cause ? { cause: errorData(error.cause) } : {}) };
}

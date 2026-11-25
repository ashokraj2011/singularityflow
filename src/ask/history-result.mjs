import { createHash } from 'node:crypto';

export const ASK_PAGE_SIZE = 20;

export const historyFinding = (code, message, category = 'coverage-gap') => ({ code, message, category });

export function coverage(unit, retrieved, diagnostics, next, available = true) {
  const status = !available ? 'unavailable' : next || diagnostics.length ? 'partial' : 'complete';
  return { status, count: { unit, retrieved, total: status === 'complete' ? retrieved : null } };
}

/** An exact snapshot can temporarily lose or regain local objects between pages. */
export function pageViewDigest(rows, diagnostics) {
  return createHash('sha256').update(JSON.stringify([rows, diagnostics.map(item => item.code)])).digest('hex');
}

/** Keep model pages under the tool limit, with room for the result envelope and continuation. */
export function pageRowCount(rows, audience, max = ASK_PAGE_SIZE) {
  const limit = Math.min(rows.length, max);
  if (audience === 'person') return limit;
  let bytes = 0;
  for (let index = 0; index < limit; index += 1) {
    bytes += Buffer.byteLength(JSON.stringify(rows[index])) + 1;
    if (bytes > 3_500) return Math.max(index, 1);
  }
  return limit;
}

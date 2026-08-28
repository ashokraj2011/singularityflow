import { GOVERNED_ROOTS } from './config.mjs';
import { posix } from './util.mjs';

/** SFlow-owned structured command results are transport state, not product source. */
export function isTransientTestResultPath(candidate) {
  const normalized = posix(candidate);
  return Boolean(normalized && /(?:^|\/)\.sflow\/results(?:\/|$)/.test(normalized));
}

/** Generic generated trees are excluded only when their Git provenance says they are untracked. */
export function isGeneratedOutputPath(candidate) {
  const normalized = posix(candidate);
  if (!normalized) return false;
  return isTransientTestResultPath(normalized)
    || normalized.split('/').some((segment) => ['node_modules', 'vendor', 'target', 'build', 'coverage'].includes(segment));
}

/** The single ownership boundary shared by lifecycle, review, specification, WM, and Auto. */
export function isApplicationPath(candidate) {
  const normalized = posix(candidate);
  if (!normalized || normalized.startsWith('.git/') || isTransientTestResultPath(normalized)) return false;
  return !GOVERNED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function isApplicationChangePath(candidate, { untracked = false } = {}) {
  if (isTransientTestResultPath(candidate)) return false;
  return isApplicationPath(candidate) && !(untracked && isGeneratedOutputPath(candidate));
}

export function isApplicationChangeEntry(entry) {
  return [entry?.oldPath, entry?.newPath].filter(Boolean).some((candidate) =>
    isApplicationChangePath(candidate, { untracked: entry?.untracked === true && candidate === entry?.newPath }));
}

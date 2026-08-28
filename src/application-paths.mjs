import { GOVERNED_ROOTS } from './config.mjs';
import { posix } from './util.mjs';

function safeGovernedRoot(value) {
  const normalized = posix(String(value ?? '')).replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * Build the complete governance boundary from immutable lifecycle resolution plus live policy.
 *
 * The starter locations are always governed. Repositories may move Story and Initiative state
 * outside `singularity/`; those configured roots must follow the same ownership rule everywhere
 * application paths are hashed, counted, adopted, or checked for scope expansion.
 */
export function applicationPathContext(...sources) {
  const configured = sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    return [
      source.workItemRoot, source.initiativeRoot,
      source.resolution?.workItemRoot, source.resolution?.initiativeRoot,
      ...(Array.isArray(source.governedRoots) ? source.governedRoots : [])
    ];
  });
  return Object.freeze({
    governedRoots: Object.freeze([...new Set([...GOVERNED_ROOTS, ...configured]
      .map(safeGovernedRoot).filter(Boolean))].sort())
  });
}

function governedRoots(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return GOVERNED_ROOTS;
  return applicationPathContext(options).governedRoots;
}

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
export function isApplicationPath(candidate, options = null) {
  const normalized = posix(candidate);
  if (!normalized || normalized.startsWith('.git/') || isTransientTestResultPath(normalized)) return false;
  return !governedRoots(options).some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function isApplicationChangePath(candidate, supplied = {}) {
  const settings = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const { untracked = false, ...options } = settings;
  if (isTransientTestResultPath(candidate)) return false;
  return isApplicationPath(candidate, options) && !(untracked && isGeneratedOutputPath(candidate));
}

export function isApplicationChangeEntry(entry, options = null) {
  return [entry?.oldPath, entry?.newPath].filter(Boolean).some((candidate) =>
    isApplicationChangePath(candidate, {
      ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
      untracked: entry?.untracked === true && candidate === entry?.newPath
    }));
}

import { normalizeSourceRoots } from './source-scope.mjs';
import { SingularityFlowError } from './util.mjs';

export const CLONE_MODES = Object.freeze(['full', 'blobless', 'blobless-sparse']);
export const CLONE_FALLBACKS = Object.freeze(['refuse', 'full']);
export const REQUIRED_SPARSE_ROOTS = Object.freeze(['.github/agents', 'singularity']);

/** Normalize the clone contract once so CLI, workspace journal, and repair use identical behavior. */
export function normalizeCloneStrategy(value = {}, label = 'Repository clone strategy') {
  const input = value == null ? {} : value;
  if (typeof input !== 'object' || Array.isArray(input)) throw new SingularityFlowError(`${label} must be an object.`);
  const mode = input.mode ?? 'full';
  if (!CLONE_MODES.includes(mode)) throw new SingularityFlowError(`${label}.mode must be one of: ${CLONE_MODES.join(', ')}.`);
  const filter = input.filter ?? (mode === 'full' ? null : 'blob:none');
  if (mode === 'full' && filter != null) throw new SingularityFlowError(`${label}.filter is valid only for a partial clone.`);
  if (mode !== 'full' && filter !== 'blob:none') throw new SingularityFlowError(`${label}.filter must be 'blob:none'.`);
  const requestedCone = normalizeSourceRoots(input.sparseCone, `${label}.sparseCone`);
  // A workspace which materializes only application directories must still contain the governed
  // configuration, work-item records, and checked-in agent contracts needed to operate it.
  const sparseCone = mode === 'blobless-sparse'
    ? [...new Set([...requestedCone, ...REQUIRED_SPARSE_ROOTS])].sort()
    : requestedCone;
  if (mode === 'blobless-sparse' && !requestedCone.length) {
    throw new SingularityFlowError(`${label}.sparseCone requires at least one directory for blobless-sparse mode.`);
  }
  if (mode !== 'blobless-sparse' && sparseCone.length) {
    throw new SingularityFlowError(`${label}.sparseCone is valid only for blobless-sparse mode.`);
  }
  const fallback = input.fallback ?? 'refuse';
  if (!CLONE_FALLBACKS.includes(fallback)) throw new SingularityFlowError(`${label}.fallback must be refuse or full.`);
  return Object.freeze({ mode, filter, sparseCone: Object.freeze(sparseCone), fallback });
}

/** Arguments before URL and target; exported so the transport contract is testable without a clone. */
export function cloneStrategyArguments(strategy) {
  const normalized = normalizeCloneStrategy(strategy);
  if (normalized.mode === 'full') return [];
  return [`--filter=${normalized.filter}`, ...(normalized.mode === 'blobless-sparse' ? ['--sparse'] : [])];
}

/** Git records a promisor remote only when the clone is actually partial. */
export function partialCloneConfigured(root, remote = 'origin', runGit) {
  const read = (key) => runGit(['config', '--local', '--get', key], { cwd: root, allowFailure: true });
  return read(`remote.${remote}.promisor`).stdout.trim() === 'true'
    && read(`remote.${remote}.partialclonefilter`).stdout.trim() === 'blob:none';
}

const FILTER_UNSUPPORTED = /(?:filter(?:ing)?[^\n]*(?:ignored|not recognized|not supported|unsupported|does not support)|does not support[^\n]*filter|server does not support filter)/i;

/**
 * Classify only the partial-clone capability result, never a general transport failure.
 *
 * A full retry is safe only when Git explicitly says that filtering is unsupported. Authentication,
 * proxy, TLS, timeout, and ordinary network failures must retain their original diagnosis and must
 * not consume a second office-network timeout behind an unfiltered clone.
 */
export function classifyPartialCloneResult(result, { configured = null } = {}) {
  const output = [result?.stderr, result?.stdout, result?.error?.message]
    .filter(Boolean).map(String).join('\n');
  const rejected = FILTER_UNSUPPORTED.test(output);
  if (Number(result?.status ?? 1) !== 0) {
    return Object.freeze({ kind: rejected ? 'filter-rejected' : 'transport-failed' });
  }
  if (configured === false || rejected) {
    return Object.freeze({ kind: 'filter-ignored' });
  }
  return Object.freeze({ kind: 'partial-established' });
}

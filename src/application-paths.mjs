import { GOVERNED_ROOTS } from './config.mjs';
import { SingularityFlowError } from './util.mjs';

function safeGovernedRoot(value) {
  const portable = String(value ?? '').trim().replaceAll('\\', '/');
  if (!portable || /[\u0000-\u001f\u007f]/.test(portable)
      || portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) return null;
  const normalized = pathNormalize(portable.replace(/^\.\/+/, '').replace(/\/+$/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return null;
  return normalized;
}

function pathNormalize(value) {
  const segments = [];
  for (const segment of String(value).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Git emits repository paths with forward slashes on every platform. Treat any other spelling as
 * invalid instead of normalizing it into a different file: a durable evidence record must have one
 * portable identity on Windows, macOS, and Linux.
 */
function portableRepositoryPath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
      || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)
      || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const normalized = pathNormalize(value);
  return normalized === value ? normalized : null;
}

function requiredRepositoryPath(value) {
  const normalized = portableRepositoryPath(value);
  if (!normalized) {
    throw new SingularityFlowError(
      `Repository path '${String(value ?? '')}' is not a canonical portable path.`,
      { code: 'REPOSITORY_PATH_INVALID' }
    );
  }
  return normalized;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function configuredRoots(source) {
  const direct = object(source);
  const resolution = object(direct.resolution);
  return [direct, resolution].flatMap((owner) => [
    owner.workItemRoot,
    owner.initiativeRoot,
    owner.templatesRoot,
    owner.agentPromptsRoot,
    owner.worldModelOutputDir,
    owner.outputDir,
    object(owner.worldModel).outputDir,
    ...(Array.isArray(owner.governedRoots) ? owner.governedRoots : [])
  ]);
}

function configuredPaths(source) {
  const direct = object(source);
  const resolution = object(direct.resolution);
  return [direct, resolution].flatMap((owner) => {
    const configurationSource = object(owner.configurationSource);
    return [
      ...(Array.isArray(owner.governedPaths) ? owner.governedPaths : []),
      ...Object.keys(object(configurationSource.files)),
      ...Object.keys(object(configurationSource.assets)),
      ...Object.keys(object(configurationSource.removed)),
      ...Object.values(object(owner.templates)).map((template) => object(template).path),
      object(owner.worldModel).promptSource === 'builtin' ? null : object(owner.worldModel).promptSource
    ];
  });
}

function caseInsensitiveSource(source) {
  const direct = object(source);
  return direct.caseInsensitivePaths === true
    || object(direct.target).caseInsensitivePaths === true
    || object(direct.resolution).caseInsensitivePaths === true;
}

function uniquePaths(values, { caseInsensitivePaths = false } = {}) {
  const selected = new Map();
  for (const value of values) {
    const normalized = safeGovernedRoot(value);
    if (!normalized) continue;
    const key = caseInsensitivePaths ? normalized.toLocaleLowerCase('en-US') : normalized;
    if (!selected.has(key)) selected.set(key, normalized);
  }
  return [...selected.values()].sort();
}

/**
 * Build the complete governance boundary from immutable lifecycle resolution plus live policy.
 *
 * The starter locations are always governed. Repositories may move Story and Initiative state
 * outside `singularity/`; those configured roots must follow the same ownership rule everywhere
 * application paths are hashed, counted, adopted, or checked for scope expansion.
 */
export function applicationPathContext(...sources) {
  const caseInsensitivePaths = sources.some(caseInsensitiveSource);
  return Object.freeze({
    caseInsensitivePaths,
    governedRoots: Object.freeze(uniquePaths([
      ...GOVERNED_ROOTS, ...sources.flatMap(configuredRoots)
    ], { caseInsensitivePaths })),
    governedPaths: Object.freeze(uniquePaths(
      sources.flatMap(configuredPaths), { caseInsensitivePaths }
    ))
  });
}

function pathContext(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return applicationPathContext();
  }
  if (typeof options.caseInsensitivePaths === 'boolean'
      && Array.isArray(options.governedRoots) && Array.isArray(options.governedPaths)) return options;
  return applicationPathContext(options);
}

function comparisonPath(value, caseInsensitivePaths) {
  return caseInsensitivePaths ? value.toLocaleLowerCase('en-US') : value;
}

/** SFlow-owned structured command results are transport state, not product source. */
export function isTransientTestResultPath(candidate, options = null) {
  const normalized = portableRepositoryPath(candidate);
  if (!normalized) return false;
  const context = pathContext(options);
  return /(?:^|\/)\.sflow\/results(?:\/|$)/.test(
    comparisonPath(normalized, context.caseInsensitivePaths)
  );
}

/** Generic generated trees are excluded only when their Git provenance says they are untracked. */
export function isGeneratedOutputPath(candidate, options = null) {
  const normalized = portableRepositoryPath(candidate);
  if (!normalized) return false;
  const context = pathContext(options);
  const compared = comparisonPath(normalized, context.caseInsensitivePaths);
  return isTransientTestResultPath(normalized, context)
    || compared.split('/').some((segment) => ['node_modules', 'vendor', 'target', 'build', 'coverage'].includes(segment));
}

/** The single ownership boundary shared by lifecycle, review, specification, WM, and Auto. */
export function isApplicationPath(candidate, options = null) {
  const normalized = requiredRepositoryPath(candidate);
  const context = pathContext(options);
  const compared = comparisonPath(normalized, context.caseInsensitivePaths);
  if (compared === '.git' || compared.startsWith('.git/')
      || isTransientTestResultPath(normalized, context)) return false;
  const roots = context.governedRoots.map((root) => comparisonPath(root, context.caseInsensitivePaths));
  const paths = context.governedPaths.map((file) => comparisonPath(file, context.caseInsensitivePaths));
  return !roots.some((root) => compared === root || compared.startsWith(`${root}/`))
    && !paths.includes(compared);
}

export function isApplicationChangePath(candidate, supplied = {}) {
  const settings = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const { untracked = false, ...options } = settings;
  if (isTransientTestResultPath(candidate, options)) return false;
  return isApplicationPath(candidate, options) && !(untracked && isGeneratedOutputPath(candidate, options));
}

export function isApplicationChangeEntry(entry, options = null) {
  return [entry?.oldPath, entry?.newPath].filter(Boolean).some((candidate) =>
    isApplicationChangePath(candidate, {
      ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
      untracked: entry?.untracked === true && candidate === entry?.newPath
    }));
}

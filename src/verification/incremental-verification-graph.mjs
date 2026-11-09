/**
 * Stage 3A: Incremental Verification Graph & Content-Addressed Witness Cache.
 *
 * 1. Content-Addressed AST & Witness Cache:
 *    Caches expensive AST / lexical verification facts (`javascript-declarations`,
 *    `corner-case-obligations`, `test-file-signals`, `module-specifiers`) by
 *    `(version, kind, optionsKey, contentSha256)` in a bounded in-memory LRU map and optionally in
 *    `.git/sflow-cache/verification-graph-v1.json` (inside `.git/`, so it never dirties the
 *    working tree or repository change set).
 *
 * 2. Incremental Dependency & Verification Graph:
 *    Extracts relative module imports from source and test files, constructs a forward and reverse
 *    dependency graph (`importsByFile`, `dependentsByFile`, `graphSha256`), and computes the
 *    transitive reverse-dependency closure (`resolveAffectedVerificationCohort`) from changed paths
 *    to affected source and test files.
 */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repositoryGitDirectory } from '../git-directory.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';
import { posix } from '../util.mjs';

export const VERIFICATION_GRAPH_CACHE_VERSION = 1;
export const MAX_VERIFICATION_CACHE_ENTRIES = 1024;

const memoryCache = new Map();
const diskHydratedKeys = new Set();
const hydratedRoots = new Set();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
let memoryBytes = 0;
let cacheHits = 0;
let cacheMisses = 0;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const SCANNER_SOURCE_FILES = [
  './incremental-verification-graph.mjs',
  './javascript-declarations.mjs',
  '../kernel/javascript-declarations.mjs',
  '../kernel/source-comments.mjs',
  '../kernel/code-documentation.mjs',
  '../kernel/polyglot-lexical.mjs',
  '../kernel/verification-policy.mjs',
  '../foundation/traceability-ids.mjs',
  '../engine-compatibility/node-source-analysis.mjs',
  './corner-case-obligations.mjs',
  './corner-case-harness.mjs',
  '../ast-packs/typescript-core.mjs'
];

export const VERIFICATION_SCANNER_FINGERPRINT = (() => {
  const hash = createHash('sha256');
  hash.update(`v${VERIFICATION_GRAPH_CACHE_VERSION}\u0000`);
  for (const rel of SCANNER_SOURCE_FILES) {
    try {
      const abs = path.resolve(PACKAGE_ROOT, 'src/verification', rel);
      hash.update(rel);
      hash.update('\u0000');
      hash.update(readFileSync(abs));
      hash.update('\u0000');
    } catch {
      hash.update(`${rel}:unavailable\u0000`);
    }
  }
  return hash.digest('hex');
})();

function resolveGitCacheFile(root) {
  if (!root || typeof root !== 'string') return null;
  try {
    const gitDir = repositoryGitDirectory(root);
    if (!gitDir || !lstatSync(gitDir).isDirectory()) return null;
    const directory = path.join(realpathSync.native(gitDir), 'sflow-cache');
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) return null;
    return path.join(directory, 'verification-graph-v1.json');
  } catch { return null; }
}

function readCacheFile(file) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CACHE_BYTES) return null;
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_CACHE_BYTES) return null;
    const buffer = Buffer.alloc(Math.min(MAX_CACHE_BYTES + 1, opened.size + 1));
    let offset = 0, count;
    while (offset < buffer.length && (count = readSync(fd, buffer, offset, buffer.length - offset, offset))) offset += count;
    const after = fstatSync(fd);
    const rebound = lstatSync(file);
    if (!rebound.isFile() || rebound.isSymbolicLink() || offset !== opened.size
        || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
        || after.ino !== rebound.ino || after.dev !== rebound.dev) return null;
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}

function remember(key, value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return; }
  const size = Buffer.byteLength(serialized ?? '');
  if (size > MAX_ENTRY_BYTES) return;
  forget(key);
  while (memoryCache.size >= MAX_VERIFICATION_CACHE_ENTRIES || memoryBytes + size > MAX_CACHE_BYTES) {
    forget(memoryCache.keys().next().value);
  }
  memoryCache.set(key, structuredClone(value));
  memoryBytes += size;
}

function forget(key) {
  if (memoryCache.has(key)) memoryBytes -= Buffer.byteLength(JSON.stringify(memoryCache.get(key)));
  memoryCache.delete(key);
  diskHydratedKeys.delete(key);
}

/**
 * Hydrate the in-memory verification cache from `.git/sflow-cache/verification-graph-v1.json` if present.
 */
export function loadPersistentVerificationCache(root) {
  const file = resolveGitCacheFile(root);
  if (!file || hydratedRoots.has(file)) return false;
  hydratedRoots.add(file);
  try {
    const raw = readCacheFile(file);
    if (
      raw?.cacheVersion !== VERIFICATION_GRAPH_CACHE_VERSION
      || raw?.scannerFingerprint !== VERIFICATION_SCANNER_FINGERPRINT
      || typeof raw.entries !== 'object'
      || !raw.entries
      || Array.isArray(raw.entries)
    ) {
      return false;
    }
    let loaded = 0;
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!/^[0-9a-f]{64}$/u.test(key) || !value || typeof value !== 'object') continue;
      if (!memoryCache.has(key) && memoryCache.size < MAX_VERIFICATION_CACHE_ENTRIES) {
        remember(key, value);
        if (memoryCache.has(key)) diskHydratedKeys.add(key);
        loaded += 1;
      }
    }
    return loaded > 0 || Object.keys(raw.entries).length === 0;
  } catch {
    return false;
  }
}

/**
 * Persist current content-addressed verification facts to `.git/sflow-cache/verification-graph-v1.json`.
 */
export function savePersistentVerificationCache(root) {
  const file = resolveGitCacheFile(root);
  if (!file) return false;
  let tmp = null;
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (resolveGitCacheFile(root) !== file || lstatSync(dir).isSymbolicLink()) return false;
    const target = lstatSync(file, { throwIfNoEntry: false });
    if (target && (!target.isFile() || target.isSymbolicLink())) return false;
    const entries = {};
    for (const [key, value] of memoryCache.entries()) {
      entries[key] = value;
    }
    const payload = JSON.stringify({
      cacheVersion: VERIFICATION_GRAPH_CACHE_VERSION,
      scannerFingerprint: VERIFICATION_SCANNER_FINGERPRINT,
      entries
    });
    if (Buffer.byteLength(payload) > MAX_CACHE_BYTES) return false;
    tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (resolveGitCacheFile(root) !== file) return false;
    renameSync(tmp, file);
    tmp = null;
    return true;
  } catch { return false; }
  finally { if (tmp) { try { rmSync(tmp, { force: true }); } catch {} } }
}

/**
 * Compute a deterministic content-addressed cache key for a verification fact, bound to the
 * current scanner implementation fingerprint so upgrades invalidate stale results.
 */
export function verificationFactCacheKey(kind, source, options = {}) {
  const contentSha256 = createHash('sha256').update(String(source ?? ''), 'utf16le').digest('hex');
  const optionsJson = canonicalJson(options ?? {});
  const scannerVersion = options?.scannerVersion ?? VERIFICATION_SCANNER_FINGERPRINT;
  return sha256(`${VERIFICATION_GRAPH_CACHE_VERSION}\u0000${scannerVersion}\u0000${kind}\u0000${optionsJson}\u0000${contentSha256}`);
}

/**
 * Retrieve or compute a deterministic AST/witness verification fact keyed by content SHA-256.
 * Disk-hydrated entries are verified against `compute()` on first access so a forged or corrupted
 * `.git/sflow-cache/verification-graph-v1.json` can never inject fake clause IDs or bypass gates.
 */
export function getCachedVerificationFact(kind, source, options, compute, {
  root = null,
  persist = false
} = {}) {
  const key = verificationFactCacheKey(kind, source, options);
  if (memoryCache.has(key)) {
    const cached = memoryCache.get(key);
    if (diskHydratedKeys.has(key)) {
      diskHydratedKeys.delete(key);
      const verified = compute();
      if (canonicalJson(cached) === canonicalJson(verified)) {
        cacheHits += 1;
        remember(key, verified);
        return verified;
      }
      // Forged or stale disk entry: evict and fall through to record miss
      forget(key);
      cacheMisses += 1;
      remember(key, verified);
      return verified;
    }
    cacheHits += 1;
    // Refresh LRU order
    memoryCache.delete(key);
    memoryCache.set(key, cached);
    return structuredClone(cached);
  }
  cacheMisses += 1;
  const computed = compute();
  remember(key, computed);
  if (persist && root) {
    savePersistentVerificationCache(root);
  }
  return computed;
}

/**
 * Return current verification cache telemetry (`hits`, `misses`, `entries`, `version`).
 */
export function verificationGraphCacheStats() {
  return Object.freeze({
    version: VERIFICATION_GRAPH_CACHE_VERSION,
    hits: cacheHits,
    misses: cacheMisses,
    entries: memoryCache.size
  });
}

/**
 * Clear in-memory (and optional persistent `.git/sflow-cache`) verification cache state.
 */
export function clearVerificationGraphCache(root = null) {
  memoryCache.clear();
  memoryBytes = 0;
  diskHydratedKeys.clear();
  hydratedRoots.clear();
  cacheHits = 0;
  cacheMisses = 0;
  const file = resolveGitCacheFile(root);
  if (file) {
    try { rmSync(file, { force: true }); } catch { /* ignore */ }
  }
}

const JS_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx'];
const PY_EXTENSIONS = ['.py'];

function stripCommentsAndStringsForImports(source) {
  // Replace block and line comments with spaces while preserving string literals so regexes don't match commented-out imports
  let out = '';
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < len && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < len) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < len) {
        const c = source[i];
        out += c;
        i += 1;
        if (c === '\\' && i < len) {
          out += source[i];
          i += 1;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Extract raw module import specifiers from a source or test file (cached by content SHA-256).
 */
export function extractModuleSpecifiers(source, { sourcePath = '' } = {}) {
  const normalizedPath = posix(sourcePath ?? '');
  return getCachedVerificationFact(
    'module-specifiers',
    source,
    { sourcePath: normalizedPath },
    () => {
      const text = stripCommentsAndStringsForImports(String(source ?? ''));
      const specifiers = new Set();
      const ext = path.posix.extname(normalizedPath).toLowerCase();
      if (PY_EXTENSIONS.includes(ext)) {
        for (const match of text.matchAll(/^\s*from\s+(\.[A-Za-z0-9_.]*)\s+import\b/gmu)) {
          specifiers.add(match[1]);
        }
      } else {
        // Static ESM import/export from '...'
        for (const match of text.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gu)) {
          specifiers.add(match[1]);
        }
        // Side-effect imports with no bindings
        for (const match of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu)) {
          specifiers.add(match[1]);
        }
        // Dynamic import('...') and CommonJS require('...')
        for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
          specifiers.add(match[1]);
        }
      }
      return [...specifiers].sort();
    }
  );
}

function resolveRelativeSpecifier(fromPath, specifier, knownFiles) {
  const dir = path.posix.dirname(posix(fromPath));
  if (specifier.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(dir, specifier));
    const candidates = [
      base,
      ...JS_EXTENSIONS.map((ext) => `${base}${ext}`),
      // TypeScript `.js` -> `.ts` / `.tsx` resolution
      ...(base.endsWith('.js') ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`, `${base.slice(0, -3)}.mjs`] : []),
      ...(base.endsWith('.mjs') ? [`${base.slice(0, -4)}.mts`, `${base.slice(0, -4)}.ts`] : []),
      ...JS_EXTENSIONS.map((ext) => path.posix.join(base, `index${ext}`))
    ];
    for (const candidate of candidates) {
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Build a deterministic forward and reverse module dependency graph across a set of repository files.
 */
export function buildIncrementalVerificationGraph({
  files = [],
  sourceByPath = new Map()
} = {}) {
  const getSource = (file) => (sourceByPath instanceof Map ? sourceByPath.get(file) : sourceByPath?.[file]) ?? '';
  const sortedFiles = [...new Set(files.map((entry) => posix(entry)))].sort();
  const knownFiles = new Set(sortedFiles);
  const importsByFile = {};
  const dependentsByFile = {};
  for (const file of sortedFiles) {
    importsByFile[file] = [];
    dependentsByFile[file] = [];
  }

  for (const file of sortedFiles) {
    const specifiers = extractModuleSpecifiers(getSource(file), { sourcePath: file });
    const resolved = new Set();
    for (const specifier of specifiers) {
      const target = resolveRelativeSpecifier(file, specifier, knownFiles);
      if (target && target !== file) {
        resolved.add(target);
      }
    }
    const sortedImports = [...resolved].sort();
    importsByFile[file] = sortedImports;
    for (const target of sortedImports) {
      dependentsByFile[target].push(file);
    }
  }

  for (const file of sortedFiles) {
    dependentsByFile[file].sort();
  }

  const core = {
    schemaVersion: VERIFICATION_GRAPH_CACHE_VERSION,
    files: sortedFiles,
    importsByFile,
    dependentsByFile
  };
  return {
    ...core,
    graphSha256: `sha256:${sha256(canonicalJson(core))}`
  };
}

function stemOf(filePath) {
  const base = path.posix.basename(posix(filePath));
  return base
    .replace(/\.(?:test|spec)\.[A-Za-z0-9]+$/iu, '')
    .replace(/\.[A-Za-z0-9]+$/u, '')
    .toLowerCase();
}

/**
 * Compute the transitive affected source and test cohort from `changedPaths` using the incremental
 * verification dependency graph.
 */
export function resolveAffectedVerificationCohort({
  changedPaths = [],
  allSourcePaths = [],
  allTestPaths = [],
  sourceByPath = new Map()
} = {}) {
  const normalizedChanged = [...new Set(changedPaths.map((entry) => posix(entry)))].sort();
  const normalizedSources = [...new Set(allSourcePaths.map((entry) => posix(entry)))].sort();
  const normalizedTests = [...new Set(allTestPaths.map((entry) => posix(entry)))].sort();
  const allFiles = [...new Set([...normalizedSources, ...normalizedTests, ...normalizedChanged])].sort();

  const graph = buildIncrementalVerificationGraph({
    files: allFiles,
    sourceByPath
  });

  const sourceSet = new Set(normalizedSources);
  const testSet = new Set(normalizedTests);
  const visited = new Set(normalizedChanged);
  const queue = [...normalizedChanged];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of graph.dependentsByFile[current] ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const affectedSourcePaths = normalizedSources.filter((file) => visited.has(file));
  const affectedStems = new Set(affectedSourcePaths.map(stemOf));

  // Include tests reached via reverse import edges OR matching stem convention when a test has no resolved imports
  const affectedTestSet = new Set(normalizedTests.filter((file) => visited.has(file)));
  for (const testFile of normalizedTests) {
    if (affectedTestSet.has(testFile)) continue;
    const hasResolvedImports = (graph.importsByFile[testFile]?.length ?? 0) > 0;
    if (!hasResolvedImports && affectedStems.has(stemOf(testFile))) {
      affectedTestSet.add(testFile);
    }
  }

  const affectedTestPaths = normalizedTests.filter((file) => affectedTestSet.has(file));
  const unchangedTestPaths = normalizedTests.filter((file) => !affectedTestSet.has(file));

  return {
    graph,
    changedPaths: normalizedChanged,
    affectedSourcePaths,
    affectedTestPaths,
    unchangedTestPaths
  };
}

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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../records.mjs';
import { posix } from '../util.mjs';

export const VERIFICATION_GRAPH_CACHE_VERSION = 1;
export const MAX_VERIFICATION_CACHE_ENTRIES = 1024;

const memoryCache = new Map();
const hydratedRoots = new Set();
let cacheHits = 0;
let cacheMisses = 0;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveGitCacheFile(root) {
  if (!root || typeof root !== 'string') return null;
  try {
    const gitDir = path.join(root, '.git');
    const stat = statSync(gitDir, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) return null;
    return path.join(gitDir, 'sflow-cache', 'verification-graph-v1.json');
  } catch {
    return null;
  }
}

/**
 * Hydrate the in-memory verification cache from `.git/sflow-cache/verification-graph-v1.json` if present.
 */
export function loadPersistentVerificationCache(root) {
  const file = resolveGitCacheFile(root);
  if (!file || hydratedRoots.has(file)) return false;
  hydratedRoots.add(file);
  try {
    if (!existsSync(file)) return false;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.schemaVersion !== VERIFICATION_GRAPH_CACHE_VERSION || typeof raw.entries !== 'object' || !raw.entries) {
      return false;
    }
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!memoryCache.has(key) && memoryCache.size < MAX_VERIFICATION_CACHE_ENTRIES) {
        memoryCache.set(key, value);
      }
    }
    return true;
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
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true });
    const entries = {};
    for (const [key, value] of memoryCache.entries()) {
      entries[key] = value;
    }
    const payload = JSON.stringify({
      schemaVersion: VERIFICATION_GRAPH_CACHE_VERSION,
      entries
    });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute a deterministic content-addressed cache key for a verification fact.
 */
export function verificationFactCacheKey(kind, source, options = {}) {
  const contentSha256 = sha256(String(source ?? ''));
  const optionsJson = canonicalJson(options ?? {});
  return sha256(`${VERIFICATION_GRAPH_CACHE_VERSION}\u0000${kind}\u0000${optionsJson}\u0000${contentSha256}`);
}

/**
 * Retrieve or compute a deterministic AST/witness verification fact keyed by content SHA-256.
 */
export function getCachedVerificationFact(kind, source, options, compute, {
  root = null,
  persist = false
} = {}) {
  if (root) loadPersistentVerificationCache(root);
  const key = verificationFactCacheKey(kind, source, options);
  if (memoryCache.has(key)) {
    cacheHits += 1;
    const cached = memoryCache.get(key);
    // Refresh LRU order
    memoryCache.delete(key);
    memoryCache.set(key, cached);
    return structuredClone(cached);
  }
  cacheMisses += 1;
  const computed = compute();
  if (memoryCache.size >= MAX_VERIFICATION_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) memoryCache.delete(oldestKey);
  }
  const stored = structuredClone(computed);
  memoryCache.set(key, stored);
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
        // Side-effect import '...'
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

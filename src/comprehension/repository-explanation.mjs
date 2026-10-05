/**
 * Whole-repository code explanation: what application code a repository holds, by folder, with the
 * declarations its AST index records, its tests, and the clauses its code and tests tag.
 *
 * A change explanation answers "what did this change do"; this answers "what is here". It is
 * model-free. It reads tracked files only (the repository as committed and staged), and it never
 * shows Singularity Flow's own files, which it counts instead (code-scope.mjs).
 *
 * The AST budget (`ast.budgets`, 500 files and 20 MiB by default) decides what is explained up
 * front. A repository within it is explained whole: its index is warmed in the background when a
 * workspace clones or adopts it, and filled here on request if that has not finished. A larger
 * repository is explained a folder or a file at a time, on request (`--path`), and nothing is
 * indexed until someone asks about a scope that fits. The local AST cache is the only thing this
 * may write; it is derived, disposable machine state, never governed state.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { astContext, buildAstCache, readCachedAstSymbols } from '../ast-intelligence.mjs';
import { compileAstLanguageCatalog, detectAstLanguage } from '../ast-language-catalog.mjs';
import { effectiveAstMode } from '../ast-mode.mjs';
import { normalizeAstPolicy } from '../ast-policy.mjs';
import { readRepositoryAstWarmStatus, writeRepositoryAstWarmStatus } from '../ast-story-start-status.mjs';
import { launchDetached } from '../ast-story-start-warm.mjs';
import { applicationPathContext } from '../application-paths.mjs';
import { changedFiles, head, trackedPathListing } from '../git.mjs';
import { clauseTagExplanation, EXPLANATION_LIMITS } from '../implementation-bindings.mjs';
import { normalizeSourceRoots } from '../source-scope.mjs';
import { scanSourceClauseTags } from '../traceability-ids.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import { comprehensionDefinition, isExplainedPath } from './code-scope.mjs';

// readCachedAstSymbols answers at most this many paths per call.
const CACHED_READ_PATHS = 500;

export const REPOSITORY_EXPLANATION_LIMITS = Object.freeze({
  // A listing this large is far beyond any AST budget; it is not read further.
  maximumListingBytes: 8 * 1024 * 1024,
  maximumEntries: 200,
  maximumSymbols: 1000,
  maximumSymbolsPerFile: 40,
  maximumTagFileBytes: 1024 * 1024,
  // Files that differ from HEAD are read from the working tree, in memory, up to this many.
  maximumWorkingTreeFiles: 200,
  maximumClauses: 200
});

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'testing']);

/** A path whose folder or name says it holds tests. A naming convention, not a test result. */
export function isTestPath(relative) {
  const parts = String(relative).toLowerCase().split('/');
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))
    || /\.(?:test|spec)\.[a-z0-9]+$/u.test(name) || /_test\.(?:go|py|rb)$/u.test(name) || /^test_.*\.py$/u.test(name);
}

let builtinCatalog = null;

function languageOf(relative) {
  builtinCatalog ??= compileAstLanguageCatalog();
  const detected = detectAstLanguage(relative, builtinCatalog).language;
  if (detected !== 'unknown') return detected;
  const extension = path.posix.extname(relative).slice(1).toLowerCase();
  return extension || 'other';
}

function normalizeScope(scope) {
  if (scope == null || scope === '') return null;
  try {
    return normalizeSourceRoots([String(scope)], '--path')[0];
  } catch (error) {
    throw new SingularityFlowError(error.message, { code: 'CMP_REPOSITORY_SCOPE_INVALID' });
  }
}

function budgetsOf(definition) {
  try { return normalizeAstPolicy(definition.ast ?? {}).budgets; } catch { return normalizeAstPolicy({}).budgets; }
}

/**
 * The application files tracked under `scope`, and whether they fit the AST budget. Cheap enough to
 * run at workspace creation: one bounded `git ls-files` and, only when the count fits, one `lstat`
 * per file. Over budget, nothing else is read. The budget counts every tracked application file;
 * `paths` keeps only those present in the working tree, so a sparse checkout never asks Git for a
 * blob it would have to fetch.
 */
export async function repositoryCodeInventory(root, { scope = null, limits = REPOSITORY_EXPLANATION_LIMITS } = {}) {
  const definition = await comprehensionDefinition(root);
  let pathContext;
  try { pathContext = applicationPathContext(definition); } catch { pathContext = applicationPathContext(); }
  const budgets = budgetsOf(definition);
  const listing = trackedPathListing(root, { prefix: scope, maximumBytes: limits.maximumListingBytes });
  const base = { scope, budgets, complete: listing.complete, paths: [], sizes: new Map(), hidden: null, files: null, bytes: null };
  if (!listing.complete) return { ...base, status: 'over-budget', reason: 'listing-too-large' };
  const paths = [];
  let hidden = 0;
  for (const file of listing.paths) {
    if (isExplainedPath(file, pathContext)) paths.push(file); else hidden += 1;
  }
  if (paths.length > budgets.maxFiles) {
    return { ...base, status: 'over-budget', reason: 'file-budget', paths, hidden, files: paths.length };
  }
  const sizes = new Map();
  const present = [];
  let bytes = 0;
  for (const file of paths) {
    const info = await lstat(path.join(root, ...file.split('/'))).catch(() => null);
    if (!info?.isFile()) continue;
    present.push(file);
    sizes.set(file, info.size);
    bytes += info.size;
  }
  return {
    ...base, paths: present, sizes, hidden, files: paths.length, absent: paths.length - present.length, bytes,
    status: bytes > budgets.maxBytes ? 'over-budget' : 'within-budget',
    reason: bytes > budgets.maxBytes ? 'byte-budget' : null
  };
}

/** The application entries directly below the scope, at least one level deep, with counts. */
function entriesBelow(inventory, scope, limits) {
  const prefix = scope ? `${scope}/` : '';
  const groups = new Map();
  for (const file of inventory.paths) {
    if (file === scope) continue;
    const rest = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    const [first, ...remainder] = rest.split('/');
    const key = `${prefix}${first}`;
    const entry = groups.get(key) ?? {
      path: key, kind: remainder.length ? 'folder' : 'file', files: 0, tests: 0, bytes: inventory.sizes.size ? 0 : null, languages: new Map()
    };
    entry.files += 1;
    if (isTestPath(file)) entry.tests += 1;
    if (entry.bytes != null) entry.bytes += inventory.sizes.get(file) ?? 0;
    const language = languageOf(file);
    entry.languages.set(language, (entry.languages.get(language) ?? 0) + 1);
    groups.set(key, entry);
  }
  const all = [...groups.values()]
    .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'folder' ? -1 : 1)
      || right.files - left.files || left.path.localeCompare(right.path, 'en'))
    .map((entry) => ({
      ...entry,
      languages: [...entry.languages].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en'))
        .slice(0, 4).map(([language, files]) => ({ language, files }))
    }));
  return { entries: all.slice(0, limits.maximumEntries), total: all.length };
}

/**
 * The exact application files to index: only code that is present, so neither Singularity Flow's
 * records nor a sparse checkout's absent files are read. A path an AST scope cannot name (glob
 * characters) stays listed without declarations.
 */
function indexPaths(inventory) {
  return inventory.paths.filter((file) => !/[*?[\]{}\\]/u.test(file));
}

function warmSummary(record) {
  return record ? {
    status: record.status, mode: record.mode ?? null, revision: record.repositoryRevision ?? null,
    updatedAt: record.updatedAt ?? null, reason: record.reason ?? null
  } : null;
}

/** The cache-only symbol read, in the slices its path limit allows, merged into one answer. */
async function readCachedSymbolsFor(root, paths, maximumSymbols) {
  const merged = { status: 'not-applicable', reason: null, truncated: false, symbols: [], counts: { cacheHits: 0, cacheMisses: 0, symbols: 0 } };
  for (let start = 0; start < paths.length; start += CACHED_READ_PATHS) {
    const slice = await readCachedAstSymbols(root, {
      paths: paths.slice(start, start + CACHED_READ_PATHS),
      maximumSymbols: Math.max(1, Math.min(maximumSymbols, maximumSymbols - merged.symbols.length))
    });
    if (slice.status === 'disabled') return slice;
    merged.status = merged.status === 'not-applicable' || merged.status === slice.status ? slice.status : 'partial';
    merged.reason ??= slice.reason ?? null;
    merged.counts.cacheHits += slice.counts.cacheHits;
    merged.counts.cacheMisses += slice.counts.cacheMisses;
    merged.counts.symbols += slice.counts.symbols;
    const room = maximumSymbols - merged.symbols.length;
    merged.symbols.push(...slice.symbols.slice(0, Math.max(0, room)));
    merged.truncated ||= slice.truncated === true || slice.symbols.length > room;
  }
  return merged;
}

/**
 * Read the AST index for the scope. When asked, and when it has gaps that no fill for this HEAD
 * has already covered, fill it first and record that fill, so a repeated explanation reads instead
 * of rebuilding. Files that differ from HEAD stay outside the content-addressed index by design;
 * the change explanation is what covers them.
 */
async function indexScope(root, scope, inventory, { build, limits }) {
  const prefixes = indexPaths(inventory);
  const read = () => readCachedSymbolsFor(root, prefixes, limits.maximumSymbols);
  let warm = await readRepositoryAstWarmStatus(root, scope);
  let cached;
  try { cached = await read(); } catch (error) {
    return {
      status: 'unavailable', reason: error?.code ?? 'ast-read-unavailable', built: false, counts: null,
      truncated: false, warm: warmSummary(warm), symbols: []
    };
  }
  const revision = safeHead(root);
  const settled = warm?.repositoryRevision === revision && ['complete', 'partial'].includes(warm?.status);
  let built = false;
  let buildReason = null;
  if (build && cached.status !== 'disabled' && cached.counts.cacheMisses > 0 && !settled) {
    const startedAt = nowIso();
    try {
      const result = await buildAstCache(root, { paths: prefixes });
      built = true;
      cached = await read();
      warm = await writeRepositoryAstWarmStatus(root, scope, {
        mode: 'on-request', scope: scope ?? 'application-code', options: { paths: prefixes }, repositoryRevision: revision,
        status: result.status === 'partial' ? 'partial' : 'complete', blocking: true,
        queuedAt: startedAt, startedAt, completedAt: nowIso(), updatedAt: nowIso(), reason: null, message: null,
        result: { status: result.status, selected: result.coverage?.selected ?? 0, processed: result.coverage?.processed ?? 0 }
      }).catch(() => warm);
    } catch (error) {
      buildReason = error?.code ?? 'ast-build-unavailable';
    }
  }
  // The content-addressed index holds committed bytes only. A file that differs from HEAD is read
  // from the working tree instead, in memory, so the explanation describes the code as it is now.
  const symbols = [...(cached.symbols ?? [])];
  let workingTreeFiles = 0;
  if (cached.status !== 'disabled' && cached.counts.cacheMisses > 0) {
    let differing = [];
    try { differing = changedFiles(root); } catch { differing = []; }
    const inScope = new Set(prefixes);
    const current = differing.filter((file) => inScope.has(file)).slice(0, limits.maximumWorkingTreeFiles);
    if (current.length) {
      try {
        const context = await astContext(root, { paths: current });
        workingTreeFiles = current.length;
        for (const fact of context.facts ?? []) {
          if (fact.kind !== 'symbol' || symbols.length >= limits.maximumSymbols) continue;
          symbols.push({
            name: String(fact.name), qualifiedName: fact.qualifiedName ? String(fact.qualifiedName) : null,
            declarationKind: String(fact.declarationKind ?? 'symbol'), path: fact.path,
            line: Number(fact.line ?? fact.span?.startLine), assurance: fact.assurance
          });
        }
      } catch {
        // The committed index still answers; these files are reported as not indexed.
      }
    }
  }
  const notIndexed = Math.max(0, cached.counts.cacheMisses - workingTreeFiles);
  return {
    status: cached.status === 'disabled' ? 'disabled' : notIndexed > 0 ? 'partial' : cached.status === 'unavailable' ? 'unavailable' : 'available',
    reason: cached.status === 'disabled' ? 'ast-off' : buildReason ?? (notIndexed > 0 ? cached.reason : null) ?? null,
    built,
    counts: {
      indexedFiles: cached.counts.cacheHits, workingTreeFiles, notIndexedFiles: notIndexed, symbols: symbols.length
    },
    truncated: cached.truncated === true || symbols.length >= limits.maximumSymbols,
    warm: warmSummary(warm),
    symbols
  };
}

/**
 * Queue the background warm of a repository's application code, as workspace creation, adoption
 * and repair do once a checkout is in place. It is queued only when AST is on and the code fits the
 * AST budget; otherwise the record says why, and an explanation indexes a folder or file at a time
 * on request. Never throws: a workspace is never refused or rolled back because AST is unavailable.
 */
export async function scheduleRepositoryAstWarm(root, { launcher = launchDetached } = {}) {
  const queuedAt = nowIso();
  const record = (fields) => writeRepositoryAstWarmStatus(root, null, {
    mode: 'background', scope: 'application-code', options: null, repositoryRevision: safeHead(root),
    blocking: false, queuedAt, updatedAt: nowIso(), startedAt: null, completedAt: null, reason: null, message: null,
    result: null, ...fields
  });
  try {
    const definition = await comprehensionDefinition(root);
    let policy;
    try { policy = normalizeAstPolicy(definition.ast ?? {}); } catch { policy = normalizeAstPolicy({}); }
    if ((await effectiveAstMode(policy)).mode === 'off') return await record({ status: 'skipped', reason: 'ast-off', completedAt: nowIso() });
    const inventory = await repositoryCodeInventory(root);
    if (inventory.status === 'over-budget') {
      return await record({
        status: 'skipped', reason: 'over-budget', completedAt: nowIso(),
        message: 'The application code is larger than the AST budget; it is indexed a folder or file at a time, on request.',
        result: { files: inventory.files, bytes: inventory.bytes, budget: inventory.reason, maxFiles: inventory.budgets.maxFiles, maxBytes: inventory.budgets.maxBytes }
      });
    }
    const prefixes = indexPaths(inventory);
    if (!prefixes.length) return await record({ status: 'skipped', reason: 'no-application-code', completedAt: nowIso() });
    const queued = await record({ status: 'queued', options: { paths: prefixes } });
    // Node's test runner launches many workspace fixtures at once; dedicated tests inject a launcher.
    if (process.env.NODE_TEST_CONTEXT && launcher === launchDetached) {
      return await record({ ...queued, status: 'skipped', reason: 'test-runner-suppressed', completedAt: nowIso() });
    }
    launcher(root, queued.workId);
    return { ...queued, status: 'scheduled' };
  } catch (error) {
    return { status: 'failed', reason: error?.code ?? 'AST_REPOSITORY_WARM_FAILED', message: String(error?.message ?? error).slice(0, 500) };
  }
}

/** `@clause` and `@ac` comments in the scope's files, each with its line and the author's note. */
async function tagsIn(root, inventory, limits) {
  const tags = [];
  for (const file of inventory.paths) {
    if ((inventory.sizes.get(file) ?? 0) > limits.maximumTagFileBytes) continue;
    const bytes = await readFile(path.join(root, ...file.split('/'))).catch(() => null);
    if (!bytes || bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    const found = scanSourceClauseTags(text);
    if (!found.length) continue;
    const lines = text.split(/\r?\n/u);
    for (const item of found) {
      const note = item.tag === 'clause' ? clauseTagExplanation(lines[item.line - 1], item.clauseId) : null;
      tags.push({ path: file, line: item.line, tag: item.tag, clauseId: item.clauseId, note: note ? note.slice(0, EXPLANATION_LIMITS.maximum) : null });
    }
  }
  return tags;
}

function safeHead(root) {
  try { return head(root); } catch { return null; }
}

/**
 * Explain the repository, or one folder or file of it. `index: false` reads the AST cache without
 * filling it. Returns a transient `repository-explanation` projection.
 */
export async function explainRepository(root, { scope: requested = null, index = true, limits = REPOSITORY_EXPLANATION_LIMITS } = {}) {
  const scope = normalizeScope(requested);
  const inventory = await repositoryCodeInventory(root, { scope, limits });
  if (scope && inventory.complete && !inventory.paths.length) {
    throw new SingularityFlowError(
      inventory.hidden ? `${scope} holds only Singularity Flow's own files, which are not code to explain.`
        : `No tracked file is at ${scope}. Name a folder or file this repository tracks.`,
      { code: 'CMP_REPOSITORY_SCOPE_EMPTY' }
    );
  }
  const single = Boolean(scope) && inventory.paths.length === 1 && inventory.paths[0] === scope;
  const { entries, total } = single ? { entries: [], total: 0 } : entriesBelow(inventory, scope, limits);
  const result = {
    schemaVersion: 1, // schema-transient: read projection for one request; never persisted
    kind: 'repository-explanation',
    mode: 'observe-only',
    authoritative: false,
    repository: { name: path.basename(root), head: safeHead(root) },
    scope: { path: scope, kind: !scope ? 'repository' : single ? 'file' : 'folder' },
    budget: {
      status: inventory.status, reason: inventory.reason,
      maxFiles: inventory.budgets.maxFiles, maxBytes: inventory.budgets.maxBytes,
      files: inventory.files, bytes: inventory.bytes
    },
    hiddenSingularityFiles: inventory.hidden,
    entries,
    entriesTotal: total,
    index: null,
    files: [],
    clauses: [],
    counts: null
  };
  if (inventory.status === 'over-budget') {
    return {
      ...result,
      index: { status: 'not-indexed', reason: 'over-budget', built: false, counts: null, truncated: false },
      counts: {
        files: inventory.files, folders: entries.filter((entry) => entry.kind === 'folder').length,
        tests: inventory.complete ? inventory.paths.filter(isTestPath).length : null, symbols: null, clauses: null
      }
    };
  }
  const indexed = await indexScope(root, scope, inventory, { build: index, limits });
  const { symbols, ...indexSummary } = indexed;
  const symbolsByPath = new Map();
  for (const symbol of symbols) {
    const bucket = symbolsByPath.get(symbol.path) ?? [];
    bucket.push({ name: symbol.qualifiedName ?? symbol.name, kind: symbol.declarationKind, line: symbol.line });
    symbolsByPath.set(symbol.path, bucket);
  }
  const tags = await tagsIn(root, inventory, limits);
  const tagsByPath = new Map();
  for (const tag of tags) tagsByPath.set(tag.path, [...(tagsByPath.get(tag.path) ?? []), tag]);
  const files = inventory.paths.map((file) => {
    const declared = symbolsByPath.get(file) ?? [];
    return {
      path: file, language: languageOf(file), bytes: inventory.sizes.get(file) ?? 0, test: isTestPath(file),
      symbols: declared.slice(0, limits.maximumSymbolsPerFile), symbolCount: declared.length,
      tags: (tagsByPath.get(file) ?? []).map(({ path: _path, ...tag }) => tag)
    };
  });
  const clauses = new Map();
  for (const tag of tags) {
    const entry = clauses.get(tag.clauseId) ?? { clauseId: tag.clauseId, code: [], tests: [] };
    if (tag.tag === 'clause') entry.code.push({ path: tag.path, line: tag.line, note: tag.note });
    else entry.tests.push({ path: tag.path, line: tag.line });
    clauses.set(tag.clauseId, entry);
  }
  const clauseList = [...clauses.values()].sort((left, right) => left.clauseId.localeCompare(right.clauseId, 'en'));
  return {
    ...result,
    index: indexSummary,
    files,
    clauses: clauseList.slice(0, limits.maximumClauses),
    counts: {
      files: files.length, folders: entries.filter((entry) => entry.kind === 'folder').length,
      tests: files.filter((file) => file.test).length, symbols: symbols.length, clauses: clauseList.length
    }
  };
}

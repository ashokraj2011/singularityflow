import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeAstPolicy, assuranceSatisfies } from './ast-policy.mjs';
import { astAdapterRequest, discoverAstAdapters, executeAstAdapter } from './ast-adapter-contract.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { gitCommonDir } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { extractImports, extractSymbols } from './repository-facts.mjs';
import { normalizeSourceRoots, withWorldModelSourceScope, worldModelSourceScope } from './source-scope.mjs';
import {
  optionBoolean, optionNumber, optionString, optionStrings, posix, run, SingularityFlowError,
  writeJson
} from './util.mjs';

export const AST_RESULT_SCHEMA_VERSION = currentSchemaVersion('ast-result');
const AST_PREFERENCE_SCHEMA_VERSION = currentSchemaVersion('ast-preference');
const AST_RESUME_JOB_SCHEMA_VERSION = currentSchemaVersion('ast-resume-job');
const STORE_DIR = 'singularity-flow/ast/v2';
const LEGACY_STORE_DIR = 'singularity-flow/ast/v1';
const BUILTIN_EXTRACTOR = Object.freeze({ id: 'builtin-text', version: 1, assurance: 'text' });
const AST_ENGINE = Object.freeze({ id: 'singularity-flow-ast-broker', version: 2 });
const AST_READ_CURSOR_VERSION = 1;
const DEFAULT_MAX_FACTS = 200;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MIN_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ASSURANCE = new Set(['text', 'syntax', 'semantic']);
const STATUSES = new Set(['complete', 'partial', 'disabled', 'unsupported', 'stale', 'failed']);
const OPERATIONS = new Set(['context', 'query', 'gate', 'build', 'transform']);
const GIT_LIST_MAX_BUFFER = 128 * 1024 * 1024;

const LANGUAGE_BY_EXTENSION = new Map([
  ['.js', 'javascript'], ['.jsx', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.java', 'java'], ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.swift', 'swift'], ['.m', 'objective-c'], ['.mm', 'objective-cpp'], ['.py', 'python'],
  ['.go', 'go'], ['.rs', 'rust'], ['.cs', 'csharp'], ['.rb', 'ruby'], ['.php', 'php'],
  ['.vue', 'vue'], ['.svelte', 'svelte'], ['.xml', 'xml'], ['.json', 'json'], ['.yaml', 'yaml'], ['.yml', 'yaml']
]);
const TEXT_SYMBOL_LANGUAGES = new Set(['javascript', 'typescript']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractorKey(value) {
  return `${value?.id ?? ''}\0${value?.version ?? ''}\0${value?.assurance ?? ''}`;
}

function uniqueExtractors(values) {
  return [...new Map(values.filter(Boolean).map((value) => [extractorKey(value), structuredClone(value)])).values()]
    .sort((left, right) => extractorKey(left).localeCompare(extractorKey(right)));
}

function outputLimits(options = {}) {
  const maxFacts = optionNumber(options, 'max-facts', DEFAULT_MAX_FACTS);
  const maxOutputBytes = optionNumber(options, 'max-output-bytes', DEFAULT_MAX_OUTPUT_BYTES);
  if (!Number.isInteger(maxFacts) || maxFacts < 1 || maxFacts > 10_000) {
    throw new SingularityFlowError('AST maxFacts must be an integer from 1 through 10000.');
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < MIN_OUTPUT_BYTES || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new SingularityFlowError(`AST maxOutputBytes must be an integer from ${MIN_OUTPUT_BYTES} through ${MAX_OUTPUT_BYTES}.`);
  }
  return { maxFacts, maxOutputBytes };
}

function splitNull(value) {
  return String(value).split('\0').filter(Boolean);
}

function preferencePath() {
  return process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE
    ? path.resolve(process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE)
    : path.join(os.homedir(), '.singularity-flow', 'ast-preference.json');
}

export async function readAstPreference() {
  try {
    const value = readRecord('ast-preference', await readFile(preferencePath())).record;
    if (!['auto', 'off'].includes(value.mode)) throw new Error('unsupported preference');
    return { schemaVersion: AST_PREFERENCE_SCHEMA_VERSION, mode: value.mode, path: preferencePath(), exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: AST_PREFERENCE_SCHEMA_VERSION, mode: 'auto', path: preferencePath(), exists: false };
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`AST preference is invalid at ${preferencePath()}. Remove it or run 'wm ast preference set auto'.`);
  }
}

export async function setAstPreference(mode) {
  if (!['auto', 'off'].includes(mode)) throw new SingularityFlowError('AST preference must be auto or off.');
  const value = { schemaVersion: AST_PREFERENCE_SCHEMA_VERSION, mode, updatedAt: new Date().toISOString() };
  await writeJson(preferencePath(), value);
  return { ...value, path: preferencePath() };
}

function environmentMode() {
  const value = String(process.env.SINGULARITY_FLOW_AST ?? 'auto').trim().toLowerCase();
  if (!['auto', 'off'].includes(value)) throw new SingularityFlowError('SINGULARITY_FLOW_AST must be auto or off.');
  return value;
}

export async function effectiveAstMode(policy, operationMode = 'auto') {
  if (!['auto', 'off'].includes(operationMode)) throw new SingularityFlowError('AST operation mode must be auto or off.');
  const local = await readAstPreference();
  const sources = { repository: policy.mode, local: local.mode, environment: environmentMode(), operation: operationMode };
  return { mode: Object.values(sources).includes('off') ? 'off' : 'auto', sources };
}

function storeRoot(root) {
  return path.join(gitCommonDir(root), STORE_DIR);
}

function legacyStoreRoot(root) {
  return path.join(gitCommonDir(root), LEGACY_STORE_DIR);
}

async function loadRuntime(root) {
  let definition = {};
  let state = null;
  if (existsSync(path.join(root, WORKFLOW_PATH))) {
    definition = await loadDefinition(root);
    const branch = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
    const statePath = path.join(root, definition.workItemRoot ?? 'singularity/work-items', branch, 'workflow.json');
    if (branch && existsSync(statePath)) state = JSON.parse(await readFile(statePath, 'utf8'));
    definition = withWorldModelSourceScope(
      definition,
      state?.resolution?.worldModelSourceScope ?? state?.resolution?.capability?.sourceScope ?? null
    );
  }
  return {
    definition,
    state,
    policy: normalizeAstPolicy(definition.ast ?? {}),
    sourceScope: worldModelSourceScope(definition),
    definitionSha256: recordSha256({ ast: definition.ast ?? {}, worldModel: { sourceRoots: definition.worldModel?.sourceRoots ?? [], sharedRoots: definition.worldModel?.sharedRoots ?? [] } })
  };
}

function repositoryRevision(root) {
  const result = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function languageFor(relative) {
  const basename = path.posix.basename(relative).toLowerCase();
  if (basename === 'dockerfile') return 'dockerfile';
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(relative).toLowerCase()) ?? 'unknown';
}

function trackedFiles(root) {
  const output = run('git', ['ls-files', '--stage', '-z'], { cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER }).stdout;
  const tracked = splitNull(output).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) return [];
    const [mode, object, stage] = entry.slice(0, tab).split(' ');
    if (stage !== '0') return [];
    return [{ path: posix(entry.slice(tab + 1)), mode, object }];
  });
  const known = new Set(tracked.map((file) => file.path));
  const untracked = splitNull(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER
  }).stdout)
    .map((relative) => ({ path: posix(relative), mode: 'untracked', object: null }))
    .filter((file) => !known.has(file.path));
  return [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
}

function changedPaths(root) {
  const tracked = splitNull(run('git', ['diff', '--name-only', '-z', 'HEAD'], {
    cwd: root, allowFailure: true, maxBuffer: GIT_LIST_MAX_BUFFER
  }).stdout);
  const untracked = splitNull(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER
  }).stdout);
  return new Set([...tracked, ...untracked].map(posix));
}

function gitObjectSizes(root, files) {
  const objects = [...new Set(files.map((file) => file.object).filter(Boolean))];
  if (!objects.length) return new Map();
  const result = run('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: root, input: `${objects.join('\n')}\n`, allowFailure: true,
    maxBuffer: Math.max(1024 * 1024, objects.length * 96)
  });
  const sizes = new Map();
  if (result.status !== 0) return sizes;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [object, type, rawSize] = line.split(' ');
    const size = Number(rawSize);
    if (type === 'blob' && Number.isSafeInteger(size) && size >= 0) sizes.set(object, size);
  }
  return sizes;
}

function gitBlobBatch(root, files) {
  const unique = [...new Map(files.filter((file) => file.object).map((file) => [file.object, file])).values()];
  if (!unique.length) return new Map();
  const result = run('git', ['cat-file', '--batch'], {
    cwd: root, encoding: 'buffer', input: `${unique.map((file) => file.object).join('\n')}\n`,
    maxBuffer: Math.max(1024 * 1024, unique.reduce((sum, file) => sum + file.size + 128, 1024))
  });
  const blobs = new Map();
  let cursor = 0;
  for (const file of unique) {
    const newline = result.stdout.indexOf(0x0a, cursor);
    if (newline < 0) throw new SingularityFlowError(`AST Git blob '${file.object}' returned no batch header.`, { code: 'AST_GIT_BLOB_INVALID' });
    const [object, type, rawSize] = result.stdout.toString('utf8', cursor, newline).trim().split(' ');
    const size = Number(rawSize); const start = newline + 1; const end = start + size;
    if (object !== file.object || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end > result.stdout.length) {
      throw new SingularityFlowError(`AST Git blob '${file.object}' returned invalid batch bytes.`, { code: 'AST_GIT_BLOB_INVALID' });
    }
    blobs.set(file.object, result.stdout.subarray(start, end));
    cursor = end + 1;
  }
  return blobs;
}

function explicitPaths(options) {
  const values = optionStrings(options, 'paths').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  return normalizeSourceRoots(values, 'AST --paths');
}

function inPrefix(relative, prefix) {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

function astBudgets(runtime, options = {}) {
  const budgets = {
    maxFiles: optionNumber(options, 'max-files', runtime.policy.budgets.maxFiles),
    maxBytes: optionNumber(options, 'max-bytes', runtime.policy.budgets.maxBytes),
    maxFileBytes: optionNumber(options, 'max-file-bytes', runtime.policy.budgets.maxFileBytes)
  };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 1) throw new SingularityFlowError(`AST ${name} must be a positive integer.`);
  }
  return budgets;
}

function generatedFile(runtime, relative) {
  return runtime.policy.generatedRoots.some((prefix) => inPrefix(relative, prefix));
}

async function candidateFor(root, runtime, file, changed, objectSizes) {
  const language = languageFor(file.path);
  const generated = generatedFile(runtime, file.path);
  const languagePolicy = runtime.policy.languages[language] ?? { mode: 'auto', minimumAssurance: 'text' };
  if (file.mode === '160000' || file.mode === '120000') {
    return {
      ...file, language, size: 0, contentKey: null, generated,
      requiredAssurance: languagePolicy.minimumAssurance,
      skipReason: file.mode === '160000' ? 'gitlink' : 'symlink'
    };
  }
  if (languagePolicy.mode === 'off') {
    const info = await lstat(path.join(root, file.path)).catch(() => null);
    return {
      ...file, language, size: info?.size ?? 0, contentKey: null, generated,
      requiredAssurance: languagePolicy.minimumAssurance, skipReason: 'language-disabled'
    };
  }
  if (file.object && !changed.has(file.path)) {
    const size = objectSizes.get(file.object);
    if (!Number.isSafeInteger(size)) {
      return {
        ...file, language, size: 0, contentKey: null, generated,
        requiredAssurance: languagePolicy.minimumAssurance, skipReason: 'git-object-unavailable'
      };
    }
    return {
      ...file, language, size, contentKey: `git:${file.object}`,
      generated, materialized: existsSync(path.join(root, file.path)),
      requiredAssurance: languagePolicy.minimumAssurance, skipReason: null
    };
  }
  const absolute = path.join(root, file.path);
  const info = await lstat(absolute).catch(() => null);
  if (!info || !info.isFile()) {
    return {
      ...file, language, size: 0, contentKey: null, generated,
      requiredAssurance: languagePolicy.minimumAssurance,
      skipReason: info?.isSymbolicLink() ? 'symlink' : 'not-readable-file'
    };
  }
  const contentKey = `sha256:${sha256(await readFile(absolute))}`;
  return {
    ...file, language, size: info.size, contentKey, generated, materialized: true,
    requiredAssurance: languagePolicy.minimumAssurance, skipReason: null
  };
}

async function enumerateScope(root, runtime, options = {}) {
  const allTracked = trackedFiles(root);
  const requested = explicitPaths(options);
  const all = optionBoolean(options, 'all');
  if (requested.length && all) throw new SingularityFlowError('Use either AST --paths or --all, not both.');
  const roots = runtime.sourceScope.paths;
  const changed = changedPaths(root);
  let scopeKind;
  let selected;
  if (requested.length) {
    scopeKind = 'paths';
    selected = allTracked.filter((file) => requested.some((prefix) => inPrefix(file.path, prefix)));
  } else if (all) {
    scopeKind = 'all';
    selected = allTracked;
  } else if (roots.length) {
    scopeKind = 'cone';
    selected = allTracked.filter((file) => roots.some((prefix) => inPrefix(file.path, prefix)));
  } else {
    // Empty roots are intentionally not interpreted as "scan the monorepo" for AST work.
    scopeKind = 'changed';
    selected = allTracked.filter((file) => changed.has(file.path));
  }
  const candidates = [];
  const objectSizes = gitObjectSizes(root, selected.filter((file) => file.object && !changed.has(file.path)));
  for (const file of selected) candidates.push(await candidateFor(root, runtime, file, changed, objectSizes));
  const coneSha256 = sha256(canonicalJson(candidates.map((file) => ({
    path: file.path, contentKey: file.contentKey, mode: file.mode, language: file.language,
    size: file.size, generated: file.generated, skipReason: file.skipReason
  }))));
  return {
    scope: {
      kind: scopeKind, paths: requested.length ? requested : roots,
      definitionSha256: runtime.definitionSha256, coneSha256
    },
    candidates,
    coneSha256,
    repositoryRevision: repositoryRevision(root)
  };
}

function resumeJobPath(root, id) {
  return path.join(storeRoot(root), 'jobs', `${id}.json`);
}

function blobKey(file, extractor = BUILTIN_EXTRACTOR) {
  return sha256(canonicalJson({
    contentKey: file.contentKey, language: file.language,
    extractor
  }));
}

function blobPath(root, key) {
  return path.join(storeRoot(root), 'blobs', `${key}.json`);
}

function skeletonIntegrity(record) {
  const { integritySha256: _integrity, ...content } = record;
  return recordSha256(content);
}

function sealSkeleton(record) {
  return { ...record, integritySha256: skeletonIntegrity(record) };
}

function validateSkeleton(value, file, key, extractor = BUILTIN_EXTRACTOR) {
  const record = readRecord('ast-cache-blob', value).record;
  if (record.key !== key || record.contentKey !== file.contentKey || record.language !== file.language
    || record.extractor?.id !== extractor.id || record.extractor?.version !== extractor.version
    || record.extractor?.assurance !== extractor.assurance || !Array.isArray(record.facts)
    || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')
    || record.integritySha256 !== skeletonIntegrity(record)) {
    throw new SingularityFlowError(`AST cache skeleton '${key}' does not match its content address.`, { code: 'AST_CACHE_INVALID' });
  }
  for (const fact of record.facts) {
    const validKind = fact?.kind === 'symbol'
      ? typeof fact.name === 'string' && fact.name.length > 0 && Number.isInteger(fact.line) && fact.line > 0
      : fact?.kind === 'import'
        ? typeof fact.target === 'string' && fact.target.length > 0
        : fact?.kind === 'relationship'
          ? typeof fact.type === 'string' && fact.type.length > 0 && typeof fact.target === 'string' && fact.target.length > 0
          : false;
    if (!validKind || fact.assurance !== extractor.assurance
      || ['sourceBody', 'text', 'body', 'content'].some((field) => Object.hasOwn(fact, field))) {
      throw new SingularityFlowError(`AST cache skeleton '${key}' contains an invalid structural fact.`, { code: 'AST_CACHE_INVALID' });
    }
  }
  return record;
}

async function deriveSkeleton(root, file, key, preparedBytes = null) {
  const bytes = preparedBytes ?? (file.contentKey?.startsWith('git:')
    ? gitBlobBatch(root, [file]).get(file.object)
    : await readFile(path.join(root, file.path)));
  const digest = sha256(bytes);
  if (file.contentKey?.startsWith('sha256:') && file.contentKey !== `sha256:${digest}`) {
    throw new SingularityFlowError(`AST input '${file.path}' changed while it was being indexed. Retry the operation.`, { code: 'AST_INPUT_CHANGED' });
  }
  const facts = [];
  if (TEXT_SYMBOL_LANGUAGES.has(file.language)) {
    const text = bytes.toString('utf8');
    for (const symbol of extractSymbols(text, file.path)) {
      facts.push({
        kind: 'symbol', name: symbol.name, declarationKind: symbol.kind,
        line: Number(symbol.at.slice(symbol.at.lastIndexOf(':') + 1)), assurance: 'text'
      });
    }
    for (const target of extractImports(text)) facts.push({ kind: 'import', target, assurance: 'text' });
  }
  return sealSkeleton({
    schemaVersion: currentSchemaVersion('ast-cache-blob'), key, contentKey: file.contentKey,
    sha256: digest, language: file.language, extractor: BUILTIN_EXTRACTOR, facts
  });
}

async function skeletonFor(root, file, {
  persist = false, memory = new Map(), metrics = null, preparedBytes = null
} = {}) {
  const key = blobKey(file);
  if (memory.has(key)) {
    if (metrics) metrics.hits += 1;
    return memory.get(key);
  }
  let skeleton;
  try {
    skeleton = validateSkeleton(await readFile(blobPath(root, key)), file, key);
    if (metrics) metrics.hits += 1;
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'AST_CACHE_INVALID') throw error;
    if (metrics) metrics.misses += 1;
    skeleton = await deriveSkeleton(root, file, key, preparedBytes);
    if (persist) await writeJson(blobPath(root, key), skeleton);
  }
  memory.set(key, skeleton);
  return skeleton;
}

async function cachedSkeleton(root, file, key) {
  try {
    return validateSkeleton(await readFile(blobPath(root, key)), file, key);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'AST_CACHE_INVALID') return null;
    throw error;
  }
}

function entryFor(file, skeleton) {
  return {
    path: file.path, contentKey: file.contentKey, cacheKey: skeleton.key, sha256: skeleton.sha256,
    language: file.language, size: file.size, generated: file.generated, materialized: file.materialized !== false,
    requiredAssurance: file.requiredAssurance ?? 'text', extractor: structuredClone(skeleton.extractor),
    assurance: skeleton.extractor.assurance, adapters: []
  };
}

function materializeFacts(entry, skeleton, { includeFile = true } = {}) {
  const generated = entry.generated === true;
  const extractor = structuredClone(skeleton.extractor);
  return [
    ...(includeFile ? [{
      kind: 'file', path: entry.path, language: entry.language, bytes: entry.size,
      sha256: skeleton.sha256, generated, assurance: skeleton.extractor.assurance, extractor
    }] : []),
    ...skeleton.facts.map((fact) => fact.kind === 'symbol'
      ? {
          kind: 'symbol', name: fact.name, declarationKind: fact.declarationKind,
          at: `${entry.path}:${fact.line}`, assurance: fact.assurance, generated, extractor
        }
      : fact.kind === 'import'
        ? { kind: 'import', from: entry.path, target: fact.target, assurance: fact.assurance, generated, extractor }
        : {
            kind: 'relationship', from: entry.path, type: fact.type, target: fact.target,
            ...(fact.sourceId ? { sourceId: fact.sourceId } : {}), assurance: fact.assurance, generated, extractor
          })
  ];
}

async function factsForEntries(root, entries, memory = new Map()) {
  const facts = [];
  for (const entry of entries) {
    let skeleton = memory.get(entry.cacheKey);
    if (!skeleton) skeleton = await skeletonFor(root, entry, { persist: false, memory });
    facts.push(...materializeFacts(entry, skeleton));
    for (const adapter of entry.adapters ?? []) {
      let adapterSkeleton = memory.get(adapter.cacheKey);
      if (!adapterSkeleton) {
        adapterSkeleton = validateSkeleton(
          await readFile(blobPath(root, adapter.cacheKey)), entry, adapter.cacheKey, adapter.extractor
        );
      }
      facts.push(...materializeFacts(entry, adapterSkeleton, { includeFile: false }));
    }
  }
  return facts;
}

function skippedKey(item) {
  return `${item.path}\0${item.reason}`;
}

async function processCandidates(root, runtime, candidates, {
  startIndex = 0, entries: previousEntries = [], skipped: previousSkipped = [], options = {}, persist = false
} = {}) {
  const budgets = astBudgets(runtime, options);
  const entries = structuredClone(previousEntries);
  const skipped = structuredClone(previousSkipped);
  const seenSkipped = new Set(skipped.map(skippedKey));
  const memory = new Map();
  const cache = { hits: 0, misses: 0 };
  let index = startIndex; let pageFiles = 0; let pageBytes = 0; let minimumRequiredBytes = null;
  const page = [];
  while (index < candidates.length) {
    const file = candidates[index];
    const permanentReason = file.skipReason ?? (file.size > budgets.maxFileBytes ? 'file-budget' : null);
    if (permanentReason) {
      const item = {
        path: file.path, reason: permanentReason, language: file.language,
        ...(file.size ? { bytes: file.size } : {}),
        ...(file.requiredAssurance ? { required: file.requiredAssurance } : {})
      };
      if (!seenSkipped.has(skippedKey(item))) { skipped.push(item); seenSkipped.add(skippedKey(item)); }
      index += 1;
      continue;
    }
    if (pageFiles >= budgets.maxFiles || pageBytes + file.size > budgets.maxBytes) {
      if (pageFiles === 0 && file.size > budgets.maxBytes) minimumRequiredBytes = file.size;
      break;
    }
    page.push(file);
    pageFiles += 1;
    pageBytes += file.size;
    index += 1;
  }
  // Read the CAS before asking Git for source bytes. A warm context/query should perform one
  // batched object-size census and zero blob reads; the first build batches only true misses.
  const misses = new Map();
  for (const file of page) {
    const key = blobKey(file);
    if (memory.has(key)) {
      cache.hits += 1;
      continue;
    }
    const cached = await cachedSkeleton(root, file, key);
    if (cached) {
      memory.set(key, cached);
      cache.hits += 1;
    } else if (!misses.has(key)) misses.set(key, file);
    else cache.hits += 1;
  }
  const gitBlobs = gitBlobBatch(root, [...misses.values()].filter((file) => file.contentKey?.startsWith('git:')));
  for (const [key, file] of misses) {
    const skeleton = await deriveSkeleton(
      root, file, key,
      file.contentKey?.startsWith('git:') ? gitBlobs.get(file.object) : null
    );
    if (persist) await writeJson(blobPath(root, key), skeleton);
    memory.set(key, skeleton);
    cache.misses += 1;
  }
  for (const file of page) {
    const skeleton = memory.get(blobKey(file));
    entries.push(entryFor(file, skeleton));
  }
  return { entries, skipped, nextIndex: index, memory, budgets, pageFiles, pageBytes, minimumRequiredBytes, cache };
}

function assuranceRank(value) {
  return ['text', 'syntax', 'semantic'].indexOf(value);
}

function adapterExtractor(adapter) {
  return { id: adapter.id, version: adapter.extractorVersion, assurance: adapter.assurance };
}

async function applyConfiguredAdapters(root, runtime, selection, processed, { persist = false } = {}) {
  const diagnostics = [];
  const degradation = [];
  const provenance = [];
  if (runtime.policy.fallback === 'text-only' || !processed.entries.length) {
    return { diagnostics, degradation, provenance };
  }
  const discovery = await discoverAstAdapters();
  diagnostics.push(...discovery.diagnostics);
  const groups = new Map();
  for (const entry of processed.entries) {
    // External adapters are trusted host commands that consume repository paths. A clean sparse
    // file can still produce built-in facts from its Git blob, but it is never implied to exist on
    // disk for an adapter.
    if (entry.materialized === false) continue;
    const compatible = discovery.adapters
      .filter((adapter) => adapter.languages.includes(entry.language) && (adapter.capabilities.length === 0 || adapter.capabilities.includes('skeleton')))
      .sort((left, right) => assuranceRank(right.assurance) - assuranceRank(left.assurance) || left.id.localeCompare(right.id));
    const adapter = compatible[0];
    if (!adapter) continue;
    const extractor = adapterExtractor(adapter);
    const key = blobKey(entry, extractor);
    const existingIndex = (entry.adapters ?? []).findIndex((existing) => existing.extractor?.id === extractor.id
      && existing.extractor?.version === extractor.version
      && existing.extractor?.assurance === extractor.assurance);
    try {
      const cached = validateSkeleton(await readFile(blobPath(root, key)), entry, key, extractor);
      processed.memory.set(key, cached);
      if (existingIndex < 0) entry.adapters.push({ cacheKey: key, extractor });
      entry.assurance = assuranceRank(extractor.assurance) > assuranceRank(entry.assurance) ? extractor.assurance : entry.assurance;
      processed.cache.hits += 1;
      provenance.push({ id: adapter.id, version: adapter.extractorVersion, assurance: adapter.assurance, status: 'cache-hit' });
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'AST_CACHE_INVALID') throw error;
      if (existingIndex >= 0) entry.adapters.splice(existingIndex, 1);
    }
    const group = groups.get(adapter.id) ?? { adapter, entries: [] };
    group.entries.push(entry);
    groups.set(adapter.id, group);
  }
  for (const { adapter, entries } of groups.values()) {
    const request = astAdapterRequest({
      operation: 'skeleton',
      scope: selection.scope,
      files: entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, language: entry.language })),
      budget: processed.budgets
    });
    try {
      const response = await executeAstAdapter(adapter, request, { root });
      const byPath = new Map(response.files.map((file) => [file.path, file]));
      const extractor = adapterExtractor(adapter);
      for (const entry of entries) {
        const file = byPath.get(entry.path);
        if (!file) {
          degradation.push({ path: entry.path, reason: 'adapter-omitted-file', adapter: adapter.id, required: entry.requiredAssurance });
          continue;
        }
        const key = blobKey(entry, extractor);
        const skeleton = sealSkeleton({
          schemaVersion: currentSchemaVersion('ast-cache-blob'), key, contentKey: entry.contentKey,
          sha256: entry.sha256, language: entry.language, extractor, facts: file.facts
        });
        processed.memory.set(key, skeleton);
        if (persist) await writeJson(blobPath(root, key), skeleton);
        entry.adapters.push({ cacheKey: key, extractor });
        entry.assurance = assuranceRank(extractor.assurance) > assuranceRank(entry.assurance) ? extractor.assurance : entry.assurance;
        processed.cache.misses += 1;
      }
      diagnostics.push(...response.diagnostics);
      provenance.push({ id: adapter.id, version: adapter.extractorVersion, assurance: adapter.assurance, status: 'executed' });
    } catch (error) {
      diagnostics.push({ code: error.code ?? 'AST_ADAPTER_FAILED', message: error.message, adapter: adapter.id });
      degradation.push(...entries.map((entry) => ({
        path: entry.path, reason: 'adapter-failed', adapter: adapter.id, required: entry.requiredAssurance
      })));
      provenance.push({ id: adapter.id, version: adapter.extractorVersion, assurance: adapter.assurance, status: 'failed' });
    }
  }
  return {
    diagnostics,
    degradation,
    provenance: [...new Map(provenance.map((item) => [`${item.id}\0${item.status}`, item])).values()]
  };
}

function coverageFor(selection, processed, facts, deferred = []) {
  const byLanguage = {};
  for (const entry of processed.entries) byLanguage[entry.language] = (byLanguage[entry.language] ?? 0) + 1;
  return {
    selected: selection.candidates.length,
    processed: processed.entries.length,
    skipped: processed.skipped.length + deferred.length,
    bytes: processed.entries.reduce((sum, entry) => sum + entry.size, 0),
    facts: facts.length, factsExamined: facts.length, factsMatched: facts.length, factsReturned: facts.length,
    byLanguage
  };
}

function assuranceDegradation(entries) {
  return entries
    .filter((entry) => !assuranceSatisfies(entry.assurance, entry.requiredAssurance))
    .map((entry) => ({
      path: entry.path, reason: 'assurance-unavailable', language: entry.language,
      actual: entry.assurance, required: entry.requiredAssurance
    }));
}

function resultAssurance(entries) {
  if (!entries.length) return 'text';
  return entries.reduce(
    (weakest, entry) => assuranceRank(entry.assurance) < assuranceRank(weakest) ? entry.assurance : weakest,
    'semantic'
  );
}

async function writeManifest(root, runtime, selection, processed, coverage, status) {
  const record = {
    schemaVersion: currentSchemaVersion('ast-cone-manifest'),
    id: '', definitionSha256: runtime.definitionSha256,
    repositoryRevision: selection.repositoryRevision, coneSha256: selection.coneSha256,
    scope: selection.scope, status, entries: processed.entries, skipped: processed.skipped,
    coverage, createdAt: new Date().toISOString()
  };
  record.id = sha256(canonicalJson({
    definitionSha256: record.definitionSha256, repositoryRevision: record.repositoryRevision,
    coneSha256: record.coneSha256, entries: record.entries, skipped: record.skipped, status
  }));
  record.integritySha256 = skeletonIntegrity(record);
  const target = path.join(storeRoot(root), 'manifests', `${record.id}.json`);
  await writeJson(target, record);
  return { record, target };
}

async function createResumeJob(root, runtime, selection, processed, options) {
  if (processed.nextIndex >= selection.candidates.length) return null;
  const id = randomUUID();
  const secret = randomBytes(24).toString('base64url');
  await writeJson(resumeJobPath(root, id), {
    schemaVersion: AST_RESUME_JOB_SCHEMA_VERSION,
    id,
    secretSha256: sha256(secret),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    binding: {
      definitionSha256: runtime.definitionSha256,
      repositoryRevision: selection.repositoryRevision,
      coneSha256: selection.coneSha256
    },
    selector: { all: optionBoolean(options, 'all'), paths: explicitPaths(options) },
    scope: selection.scope,
    candidates: selection.candidates,
    nextIndex: processed.nextIndex,
    entries: processed.entries,
    skipped: processed.skipped,
    minimumRequiredBytes: processed.minimumRequiredBytes
  });
  return `ast_${id}_${secret}`;
}

async function readResumeJob(root, handle) {
  const match = /^ast_([0-9a-f-]{36})_([A-Za-z0-9_-]+)$/.exec(String(handle ?? ''));
  if (!match) throw new SingularityFlowError('AST resume handle is malformed.', { code: 'AST_RESUME_INVALID' });
  const [, id, secret] = match;
  let job;
  try { job = readRecord('ast-resume-job', await readFile(resumeJobPath(root, id))).record; }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError('AST resume handle is unknown or already consumed.', { code: 'AST_RESUME_UNKNOWN' });
    throw error;
  }
  if (job.secretSha256 !== sha256(secret) || Date.parse(job.expiresAt) <= Date.now()) {
    throw new SingularityFlowError('AST resume handle is invalid or expired.', { code: 'AST_RESUME_INVALID' });
  }
  if (job.legacyV1 === true) {
    throw new SingularityFlowError(
      'This AST resume handle predates accumulated cone manifests. Start a new bounded build; no source or lifecycle state was changed.',
      { code: 'AST_RESUME_STALE' }
    );
  }
  const runtime = await loadRuntime(root);
  if (job.binding.definitionSha256 !== runtime.definitionSha256
    || job.binding.repositoryRevision !== repositoryRevision(root)) {
    throw new SingularityFlowError('AST resume handle is stale because configuration or repository revision changed.', { code: 'AST_RESUME_STALE' });
  }
  const selection = await enumerateScope(root, runtime, { all: job.selector.all, paths: job.selector.paths });
  if (selection.coneSha256 !== job.binding.coneSha256) {
    throw new SingularityFlowError('AST resume handle is stale because relevant scope or file bytes changed.', { code: 'AST_RESUME_STALE' });
  }
  return { job, file: resumeJobPath(root, id), runtime, selection };
}

function baseEnvelope(runtime, operation, scope, mode, { revision = null, fingerprint = null } = {}) {
  return {
    schemaVersion: AST_RESULT_SCHEMA_VERSION,
    operation,
    scope: { ...scope, repositoryRevision: revision, worktreeFingerprint: fingerprint },
    assurance: 'text',
    status: mode.mode === 'off' ? 'disabled' : 'complete',
    coverage: {
      selected: 0, processed: 0, skipped: 0, bytes: 0,
      facts: 0, factsExamined: 0, factsMatched: 0, factsReturned: 0, byLanguage: {}
    },
    facts: [], diagnostics: [], degradation: [], resumeHandle: null, nextCursor: null,
    page: {
      offset: 0, returned: 0, available: 0, hasMore: false,
      maxFacts: DEFAULT_MAX_FACTS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, outputBytes: 0
    },
    provenance: {
      engine: AST_ENGINE.id, engineVersion: AST_ENGINE.version,
      adapters: [], extractors: [], effectiveMode: mode.mode, modeSources: mode.sources
    }
  };
}

function refreshEnvelopeAccounting(envelope, {
  available = envelope.facts.length,
  examined = envelope.coverage.factsExamined,
  matched = envelope.coverage.factsMatched,
  limits = null
} = {}) {
  envelope.coverage.facts = envelope.facts.length;
  envelope.coverage.factsReturned = envelope.facts.length;
  envelope.coverage.factsExamined = examined;
  envelope.coverage.factsMatched = matched;
  envelope.provenance.extractors = uniqueExtractors(envelope.facts.flatMap((fact) => [
    fact.extractor, ...(fact.extractors ?? [])
  ]));
  const effectiveLimits = limits ?? {
    maxFacts: Math.max(1, envelope.facts.length),
    maxOutputBytes: Math.max(MIN_OUTPUT_BYTES, Buffer.byteLength(JSON.stringify(envelope), 'utf8'))
  };
  envelope.page = {
    offset: 0,
    returned: envelope.facts.length,
    available,
    hasMore: false,
    maxFacts: effectiveLimits.maxFacts,
    maxOutputBytes: effectiveLimits.maxOutputBytes,
    outputBytes: 0
  };
  envelope.nextCursor = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    envelope.page.outputBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  }
  return envelope;
}

export function validateAstResultEnvelope(value) {
  const record = readRecord('ast-result', value).record;
  if (!OPERATIONS.has(record.operation)) throw new SingularityFlowError('Invalid AST result envelope operation.');
  if (!ASSURANCE.has(record.assurance) || !STATUSES.has(record.status)) throw new SingularityFlowError('Invalid AST result envelope assurance or status.');
  if (!record.scope?.definitionSha256 || !Object.hasOwn(record.scope, 'worktreeFingerprint')) throw new SingularityFlowError('AST result envelope is missing its scope binding.');
  if (!Array.isArray(record.facts) || !Array.isArray(record.diagnostics) || !Array.isArray(record.degradation)) throw new SingularityFlowError('AST result envelope collections are invalid.');
  for (const key of ['selected', 'processed', 'skipped', 'bytes', 'facts', 'factsExamined', 'factsMatched', 'factsReturned']) {
    if (!Number.isInteger(record.coverage?.[key]) || record.coverage[key] < 0) throw new SingularityFlowError(`AST result coverage.${key} must be a non-negative integer.`);
  }
  if (record.coverage.processed > record.coverage.selected
    || record.coverage.facts !== record.facts.length
    || record.coverage.factsReturned !== record.facts.length) {
    throw new SingularityFlowError('AST result coverage contradicts the returned facts or selected file count.');
  }
  if (!record.coverage.byLanguage || typeof record.coverage.byLanguage !== 'object' || Array.isArray(record.coverage.byLanguage)) {
    throw new SingularityFlowError('AST result coverage.byLanguage must be an object.');
  }
  if (!record.page || !Number.isInteger(record.page.offset) || !Number.isInteger(record.page.returned)
    || !Number.isInteger(record.page.available) || record.page.returned !== record.facts.length
    || record.page.offset + record.page.returned > record.page.available
    || record.page.hasMore !== Boolean(record.nextCursor)) {
    throw new SingularityFlowError('AST result page metadata contradicts the returned facts or cursor.');
  }
  const forbidden = JSON.stringify(record.facts).match(/"(?:sourceBody|body|content|text)"\s*:/);
  if (forbidden) throw new SingularityFlowError('AST result facts must not contain source bodies.');
  for (const diagnostic of record.diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object' || typeof diagnostic.code !== 'string') throw new SingularityFlowError('AST result diagnostics require a code.');
  }
  for (const item of record.degradation) {
    if (!item || typeof item !== 'object' || typeof item.reason !== 'string') throw new SingularityFlowError('AST result degradation entries require a reason.');
  }
  if (!record.provenance || typeof record.provenance !== 'object' || Array.isArray(record.provenance)
    || record.provenance.engine !== AST_ENGINE.id || !Array.isArray(record.provenance.extractors)) {
    throw new SingularityFlowError('AST result provenance is invalid.');
  }
  return structuredClone(record);
}

async function buildOrContext(root, options, operation) {
  const runtime = await loadRuntime(root);
  const mode = await effectiveAstMode(runtime.policy, optionString(options, 'mode', 'auto'));
  if (mode.mode === 'off') {
    const requested = explicitPaths(options);
    const all = optionBoolean(options, 'all');
    if (requested.length && all) throw new SingularityFlowError('Use either AST --paths or --all, not both.');
    const scope = {
      kind: requested.length ? 'paths' : all ? 'all' : runtime.sourceScope.paths.length ? 'cone' : 'changed',
      paths: requested.length ? requested : runtime.sourceScope.paths,
      definitionSha256: runtime.definitionSha256
    };
    const disabled = baseEnvelope(runtime, operation, scope, mode);
    disabled.diagnostics.push({ code: 'AST_DISABLED', message: 'Structural intelligence is disabled by the most restrictive effective preference.' });
    return validateAstResultEnvelope(refreshEnvelopeAccounting(disabled));
  }
  const selection = await enumerateScope(root, runtime, options);
  const processed = await processCandidates(root, runtime, selection.candidates, {
    options, persist: operation === 'build'
  });
  const adapters = await applyConfiguredAdapters(root, runtime, selection, processed, {
    persist: operation === 'build'
  });
  const envelope = baseEnvelope(runtime, operation, selection.scope, mode, {
    revision: selection.repositoryRevision, fingerprint: selection.coneSha256
  });
  envelope.facts = await factsForEntries(root, processed.entries, processed.memory);
  envelope.assurance = resultAssurance(processed.entries);
  const deferred = selection.candidates.slice(processed.nextIndex).map((file) => ({
    path: file.path, reason: 'operation-budget', bytes: file.size
  }));
  const assurance = assuranceDegradation(processed.entries);
  const degradation = [...processed.skipped, ...deferred, ...adapters.degradation, ...assurance];
  envelope.diagnostics.push(...adapters.diagnostics);
  envelope.provenance.adapters = adapters.provenance;
  envelope.coverage = coverageFor(selection, processed, envelope.facts, deferred);
  envelope.degradation = degradation.slice(0, 100);
  if (degradation.length > envelope.degradation.length) {
    envelope.diagnostics.push({
      code: 'AST_DEGRADATION_TRUNCATED',
      message: `${degradation.length - envelope.degradation.length} additional degraded paths were omitted from this bounded result.`
    });
  }
  if (processed.minimumRequiredBytes) envelope.diagnostics.push({
    code: 'AST_BUDGET_NO_PROGRESS',
    message: `The next file requires an operation byte budget of at least ${processed.minimumRequiredBytes}.`
  });
  if (degradation.length) envelope.status = 'partial';
  envelope.provenance.cache = {
    hits: processed.cache.hits, misses: processed.cache.misses,
    entries: processed.entries.length, format: 'blob-cas-v2'
  };
  if (operation === 'build') {
    envelope.resumeHandle = await createResumeJob(root, runtime, selection, processed, options);
    const manifest = await writeManifest(root, runtime, selection, processed, envelope.coverage, envelope.status);
    envelope.provenance.manifest = path.relative(gitCommonDir(root), manifest.target).replaceAll(path.sep, '/');
  }
  return validateAstResultEnvelope(refreshEnvelopeAccounting(envelope));
}

async function resumeBuild(root, handle, options) {
  const { job, file, runtime, selection } = await readResumeJob(root, handle);
  const resumedOptions = { ...options };
  delete resumedOptions.resume;
  const mode = await effectiveAstMode(runtime.policy, optionString(resumedOptions, 'mode', 'auto'));
  if (mode.mode === 'off') throw new SingularityFlowError('AST was disabled after this build began; the resume handle was not consumed.', { code: 'AST_DISABLED' });
  const processed = await processCandidates(root, runtime, job.candidates, {
    startIndex: job.nextIndex, entries: job.entries, skipped: job.skipped,
    options: resumedOptions, persist: true
  });
  const adapters = await applyConfiguredAdapters(root, runtime, selection, processed, { persist: true });
  const facts = await factsForEntries(root, processed.entries, processed.memory);
  const deferred = job.candidates.slice(processed.nextIndex).map((candidate) => ({
    path: candidate.path, reason: 'operation-budget', bytes: candidate.size
  }));
  const degradation = [
    ...processed.skipped, ...deferred, ...adapters.degradation,
    ...assuranceDegradation(processed.entries)
  ];
  const result = baseEnvelope(runtime, 'build', selection.scope, mode, {
    revision: selection.repositoryRevision, fingerprint: selection.coneSha256
  });
  result.facts = facts;
  result.assurance = resultAssurance(processed.entries);
  result.diagnostics.push(...adapters.diagnostics);
  result.provenance.adapters = adapters.provenance;
  result.coverage = coverageFor(selection, processed, facts, deferred);
  result.degradation = degradation.slice(0, 100);
  if (degradation.length) result.status = 'partial';
  if (processed.minimumRequiredBytes) result.diagnostics.push({
    code: 'AST_BUDGET_NO_PROGRESS',
    message: `The next file requires an operation byte budget of at least ${processed.minimumRequiredBytes}.`
  });
  result.resumeHandle = await createResumeJob(root, runtime, selection, processed, {
    all: job.selector.all, paths: job.selector.paths
  });
  const manifest = await writeManifest(root, runtime, selection, processed, result.coverage, result.status);
  result.provenance.manifest = path.relative(gitCommonDir(root), manifest.target).replaceAll(path.sep, '/');
  result.provenance.cache = {
    hits: processed.cache.hits, misses: processed.cache.misses,
    entries: processed.entries.length, format: 'blob-cas-v2'
  };
  result.provenance.resumedFrom = job.id;
  await rm(file, { force: true });
  return validateAstResultEnvelope(refreshEnvelopeAccounting(result));
}

function matchQuery(fact, predicate, value) {
  if (predicate === 'symbol') return fact.kind === 'symbol' && String(fact.name).includes(value);
  if (predicate === 'import') return fact.kind === 'import' && String(fact.target).includes(value);
  if (predicate === 'language') return fact.kind === 'file' && fact.language === value;
  if (predicate === 'path') return fact.kind === 'file' && inPrefix(fact.path, value);
  return false;
}

function sealReadCursor(payload) {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  const integrity = sha256(`singularity-flow-ast-read-cursor-v${AST_READ_CURSOR_VERSION}\0${encoded}`);
  return `astp_${encoded}.${integrity}`;
}

function readCursorPayload(root, handle, expectedOperation) {
  const match = /^astp_([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(String(handle ?? ''));
  if (!match || match[1].length > 16_384) {
    throw new SingularityFlowError('AST read cursor is malformed.', { code: 'AST_READ_CURSOR_INVALID' });
  }
  const [, encoded, integrity] = match;
  if (sha256(`singularity-flow-ast-read-cursor-v${AST_READ_CURSOR_VERSION}\0${encoded}`) !== integrity) {
    throw new SingularityFlowError('AST read cursor integrity is invalid.', { code: 'AST_READ_CURSOR_INVALID' });
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new SingularityFlowError('AST read cursor payload is invalid.', { code: 'AST_READ_CURSOR_INVALID' }); }
  const valid = payload?.version === AST_READ_CURSOR_VERSION
    && payload.operation === expectedOperation
    && payload.repositoryKey === sha256(path.resolve(root))
    && typeof payload.expiresAt === 'string' && Date.parse(payload.expiresAt) > Date.now()
    && payload.binding && typeof payload.binding.definitionSha256 === 'string'
    && typeof payload.binding.coneSha256 === 'string'
    && payload.selector && typeof payload.selector.all === 'boolean' && Array.isArray(payload.selector.paths)
    && payload.inputBudgets && Object.values(payload.inputBudgets).every((value) => Number.isInteger(value) && value > 0)
    && payload.outputLimits && Number.isInteger(payload.outputLimits.maxFacts)
    && Number.isInteger(payload.outputLimits.maxOutputBytes)
    && Number.isInteger(payload.nextOffset) && payload.nextOffset >= 0;
  if (!valid) throw new SingularityFlowError('AST read cursor is invalid or expired.', { code: 'AST_READ_CURSOR_INVALID' });
  outputLimits({
    'max-facts': payload.outputLimits.maxFacts,
    'max-output-bytes': payload.outputLimits.maxOutputBytes
  });
  return payload;
}

function selectorForCursor(options) {
  return { all: optionBoolean(options, 'all'), paths: explicitPaths(options) };
}

function cursorOptions(payload) {
  return {
    ...(payload.selector.all ? { all: true } : {}),
    ...(payload.selector.paths.length ? { paths: payload.selector.paths } : {}),
    'max-files': payload.inputBudgets.maxFiles,
    'max-bytes': payload.inputBudgets.maxBytes,
    'max-file-bytes': payload.inputBudgets.maxFileBytes
  };
}

function filterQueryEnvelope(envelope, predicate, value) {
  if (envelope.status !== 'disabled') {
    const examined = envelope.facts.length;
    envelope.facts = envelope.facts.filter((fact) => matchQuery(fact, predicate, value));
    envelope.coverage.factsExamined = examined;
    envelope.coverage.factsMatched = envelope.facts.length;
    envelope.coverage.factsReturned = envelope.facts.length;
    envelope.coverage.facts = envelope.facts.length;
  }
  envelope.provenance.query = { predicate, value };
  return refreshEnvelopeAccounting(envelope, {
    available: envelope.facts.length,
    examined: envelope.coverage.factsExamined,
    matched: envelope.coverage.factsMatched
  });
}

async function boundedReadPage(root, envelope, {
  operation, options, query = null, offset = 0, limits: suppliedLimits = null,
  inputBudgets: suppliedInputBudgets = null, selector: suppliedSelector = null
} = {}) {
  const runtime = await loadRuntime(root);
  const limits = suppliedLimits ?? outputLimits(options);
  const inputBudgets = suppliedInputBudgets ?? astBudgets(runtime, options);
  const selector = suppliedSelector ?? selectorForCursor(options);
  const available = envelope.facts.length;
  if (offset > available) {
    throw new SingularityFlowError('AST read cursor points beyond the current result.', { code: 'AST_READ_CURSOR_STALE' });
  }
  const allFacts = envelope.facts;
  const baseDiagnostics = envelope.diagnostics.filter((item) => item.code !== 'AST_RESULT_PAGED');
  let pageFacts = allFacts.slice(offset, offset + limits.maxFacts);
  while (true) {
    const nextOffset = offset + pageFacts.length;
    const hasMore = nextOffset < available;
    const payload = hasMore ? {
      version: AST_READ_CURSOR_VERSION,
      repositoryKey: sha256(path.resolve(root)),
      operation,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      binding: {
        definitionSha256: envelope.scope.definitionSha256,
        repositoryRevision: envelope.scope.repositoryRevision,
        coneSha256: envelope.scope.coneSha256 ?? envelope.scope.worktreeFingerprint
      },
      selector,
      inputBudgets,
      outputLimits: limits,
      nextOffset,
      ...(query ? { query } : {})
    } : null;
    envelope.facts = pageFacts;
    envelope.nextCursor = payload ? sealReadCursor(payload) : null;
    envelope.diagnostics = hasMore ? [...baseDiagnostics, {
      code: 'AST_RESULT_PAGED',
      message: `${available - nextOffset} additional structural fact(s) are available through the cone-bound next cursor.`
    }] : baseDiagnostics;
    envelope.coverage.facts = pageFacts.length;
    envelope.coverage.factsReturned = pageFacts.length;
    envelope.page = {
      offset,
      returned: pageFacts.length,
      available,
      hasMore,
      maxFacts: limits.maxFacts,
      maxOutputBytes: limits.maxOutputBytes,
      outputBytes: 0
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      envelope.page.outputBytes = Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8');
    }
    if (envelope.page.outputBytes <= limits.maxOutputBytes) break;
    if (!pageFacts.length) {
      throw new SingularityFlowError(
        `AST result metadata exceeds the ${limits.maxOutputBytes}-byte output budget. Increase --max-output-bytes.`,
        { code: 'AST_OUTPUT_BUDGET_TOO_SMALL' }
      );
    }
    pageFacts = pageFacts.slice(0, -1);
  }
  return validateAstResultEnvelope(envelope);
}

function assertCursorBinding(envelope, payload) {
  const current = {
    definitionSha256: envelope.scope.definitionSha256,
    repositoryRevision: envelope.scope.repositoryRevision,
    coneSha256: envelope.scope.coneSha256 ?? envelope.scope.worktreeFingerprint
  };
  if (current.definitionSha256 !== payload.binding.definitionSha256
    || current.repositoryRevision !== payload.binding.repositoryRevision
    || current.coneSha256 !== payload.binding.coneSha256) {
    throw new SingularityFlowError(
      'AST read cursor is stale because policy, revision, scope, or relevant file bytes changed.',
      { code: 'AST_READ_CURSOR_STALE' }
    );
  }
}

export async function astContext(root, options = {}) {
  const handle = optionString(options, 'cursor');
  if (handle) {
    const payload = readCursorPayload(root, handle, 'context');
    const envelope = await buildOrContext(root, cursorOptions(payload), 'context');
    if (envelope.status === 'disabled') throw new SingularityFlowError('AST is disabled; the read cursor was not consumed.', { code: 'AST_DISABLED' });
    assertCursorBinding(envelope, payload);
    return boundedReadPage(root, envelope, {
      operation: 'context', options: cursorOptions(payload), offset: payload.nextOffset,
      limits: payload.outputLimits, inputBudgets: payload.inputBudgets, selector: payload.selector
    });
  }
  const envelope = await buildOrContext(root, options, 'context');
  return boundedReadPage(root, envelope, { operation: 'context', options });
}

export async function astQuery(root, options = {}) {
  const handle = optionString(options, 'cursor');
  if (handle) {
    const payload = readCursorPayload(root, handle, 'query');
    if (!payload.query || !['symbol', 'import', 'language', 'path'].includes(payload.query.predicate)
      || typeof payload.query.value !== 'string' || !payload.query.value) {
      throw new SingularityFlowError('AST query cursor does not contain a valid bound query.', { code: 'AST_READ_CURSOR_INVALID' });
    }
    const envelope = filterQueryEnvelope(
      await buildOrContext(root, cursorOptions(payload), 'query'),
      payload.query.predicate,
      payload.query.value
    );
    if (envelope.status === 'disabled') throw new SingularityFlowError('AST is disabled; the query cursor was not consumed.', { code: 'AST_DISABLED' });
    assertCursorBinding(envelope, payload);
    return boundedReadPage(root, envelope, {
      operation: 'query', options: cursorOptions(payload), query: payload.query,
      offset: payload.nextOffset, limits: payload.outputLimits,
      inputBudgets: payload.inputBudgets, selector: payload.selector
    });
  }
  const predicate = optionString(options, 'predicate');
  const value = optionString(options, 'value', '');
  if (!['symbol', 'import', 'language', 'path'].includes(predicate) || !value) throw new SingularityFlowError('wm ast query requires --predicate symbol|import|language|path and --value VALUE.');
  const envelope = filterQueryEnvelope(await buildOrContext(root, options, 'query'), predicate, value);
  return boundedReadPage(root, envelope, { operation: 'query', options, query: { predicate, value } });
}

export async function evaluateAstGate(root, options = {}) {
  const runtime = await loadRuntime(root);
  const envelope = await buildOrContext(root, options, 'gate');
  const results = [];
  for (const predicate of runtime.policy.predicates) {
    const configuredAssurance = predicate.minimumAssurance ?? 'text';
    // A lexical symbol match is discovery help, never proof that a declaration exists. The built-in
    // extractor intentionally does not parse comments or conditional syntax, so required symbol
    // predicates must be established by at least a syntax adapter even when an older policy says
    // `text`. Advisory predicates retain the useful, explicitly low-assurance lexical result.
    const requiredAssurance = predicate.mode === 'required' && predicate.type === 'symbol-exists'
      && !assuranceSatisfies(configuredAssurance, 'syntax') ? 'syntax' : configuredAssurance;
    let outcome = 'unknown';
    const matching = predicate.type === 'path-exists'
      ? envelope.facts.filter((fact) => fact.kind === 'file' && fact.path === predicate.path)
      : envelope.facts.filter((fact) => fact.kind === 'symbol' && fact.name === predicate.symbol);
    if (matching.some((fact) => assuranceSatisfies(fact.assurance ?? 'text', requiredAssurance))) outcome = 'pass';
    else if (!matching.length && assuranceSatisfies(envelope.assurance, requiredAssurance)) outcome = 'fail';
    const extractors = uniqueExtractors((matching.length ? matching : envelope.facts).flatMap((fact) => [
      fact.extractor, ...(fact.extractors ?? [])
    ]));
    results.push({ id: predicate.id, mode: predicate.mode, requiredAssurance, outcome, extractors });
    if (requiredAssurance !== configuredAssurance) envelope.diagnostics.push({
      code: 'AST_REQUIRED_SYMBOL_SYNTAX_ASSURANCE',
      message: `Required symbol predicate '${predicate.id}' was raised from text to syntax assurance; lexical matches remain advisory.`
    });
  }
  const examined = envelope.facts.length;
  const evaluatedPaths = envelope.facts.filter((fact) => fact.kind === 'file').map((fact) => fact.path);
  envelope.facts = results;
  envelope.coverage.factsExamined = examined;
  envelope.coverage.factsMatched = results.filter((item) => item.outcome === 'pass').length;
  envelope.coverage.factsReturned = results.length;
  envelope.coverage.facts = results.length;
  const blocking = results.filter((item) => item.mode === 'required' && item.outcome !== 'pass');
  if (blocking.length || envelope.status === 'partial') envelope.status = 'partial';
  envelope.provenance.gate = {
    allowed: envelope.status === 'complete' && blocking.length === 0,
    blocking: blocking.map((item) => item.id),
    evaluatedPaths
  };
  return validateAstResultEnvelope(refreshEnvelopeAccounting(envelope, {
    available: results.length,
    examined,
    matched: results.filter((item) => item.outcome === 'pass').length
  }));
}

export async function astCacheStatus(root) {
  let files = 0; let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) { files += 1; bytes += (await stat(target)).size; }
    }
  }
  for (const directory of [storeRoot(root), legacyStoreRoot(root)]) await walk(directory);
  return {
    schemaVersion: 2, root: storeRoot(root), legacyRoot: legacyStoreRoot(root),
    files, bytes, exists: files > 0
  }; // schema-transient: live cache inventory, never persisted
}

async function clearCache(root, options) {
  const before = await astCacheStatus(root);
  const dryRun = optionBoolean(options, 'dry-run');
  const confirmation = optionString(options, 'confirm');
  if (!dryRun && confirmation !== 'CLEAR AST CACHE') throw new SingularityFlowError("AST cache clear requires --confirm 'CLEAR AST CACHE'. Use --dry-run to preview.");
  if (!dryRun) {
    for (const target of [storeRoot(root), legacyStoreRoot(root)]) {
      const info = await lstat(target).catch(() => null);
      if (info?.isSymbolicLink()) throw new SingularityFlowError('AST cache root must not be a symbolic link.');
      await rm(target, { recursive: true, force: true });
    }
  }
  return { schemaVersion: 2, action: 'clear', dryRun, removed: dryRun ? 0 : before.files, bytes: before.bytes, root: before.root }; // schema-transient: command result, never persisted
}

async function pruneCache(root, options) {
  const dryRun = optionBoolean(options, 'dry-run');
  if (!dryRun && optionString(options, 'confirm') !== 'PRUNE AST CACHE') {
    throw new SingularityFlowError("AST cache prune requires --confirm 'PRUNE AST CACHE'. Use --dry-run to preview.");
  }
  const runtime = await loadRuntime(root);
  const revision = repositoryRevision(root);
  const targets = [];
  const reachable = new Set();
  async function records(directory, family, keep) {
    const parent = path.join(storeRoot(root), directory);
    for (const entry of await readdir(parent, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const target = path.join(parent, entry.name);
      if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const record = readRecord(family, await readFile(target)).record;
        if (!(await keep(record))) targets.push(target);
        else for (const item of record.entries ?? []) {
          if (item.cacheKey) reachable.add(item.cacheKey);
          for (const adapter of item.adapters ?? []) if (adapter.cacheKey) reachable.add(adapter.cacheKey);
        }
      } catch {
        targets.push(target);
      }
    }
  }
  await records('jobs', 'ast-resume-job', (record) => Date.parse(record.expiresAt) > Date.now()
    && record.binding?.definitionSha256 === runtime.definitionSha256
    && record.binding?.repositoryRevision === revision);
  await records('manifests', 'ast-cone-manifest', async (record) => {
    if (record.integritySha256 !== skeletonIntegrity(record)) return false;
    if (record.definitionSha256 !== runtime.definitionSha256 || record.repositoryRevision !== revision) return false;
    const selector = record.scope?.kind === 'all' ? { all: true }
      : record.scope?.kind === 'paths' ? { paths: record.scope.paths ?? [] } : {};
    const current = await enumerateScope(root, runtime, selector);
    return current.coneSha256 === record.coneSha256;
  });
  const blobs = path.join(storeRoot(root), 'blobs');
  for (const entry of await readdir(blobs, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const target = path.join(blobs, entry.name);
    if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
    if (entry.isFile() && entry.name.endsWith('.json') && !reachable.has(entry.name.slice(0, -5))) targets.push(target);
  }
  async function legacy(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
      if (entry.isDirectory()) await legacy(target);
      else if (entry.isFile()) targets.push(target);
    }
  }
  await legacy(legacyStoreRoot(root));
  if (!dryRun) for (const target of targets) await rm(target, { force: true });
  return {
    schemaVersion: 2, // schema-transient: command result, never persisted
    action: 'prune', dryRun, candidates: targets.length, removed: dryRun ? 0 : targets.length,
    targets: targets.map((target) => {
      const relative = path.relative(storeRoot(root), target);
      return relative.startsWith('..')
        ? `legacy/${path.relative(legacyStoreRoot(root), target).replaceAll(path.sep, '/')}`
        : relative.replaceAll(path.sep, '/');
    })
  };
}

export async function astDoctor(root) {
  const runtime = await loadRuntime(root);
  const effective = await effectiveAstMode(runtime.policy);
  const cache = await astCacheStatus(root);
  const adapterDiscovery = await discoverAstAdapters();
  const assuranceAvailable = new Set(['text']);
  for (const adapter of adapterDiscovery.adapters) {
    assuranceAvailable.add(adapter.assurance);
  }
  const activePhase = runtime.state?.currentPhase
    ? runtime.state.phases?.[runtime.state.currentPhase] ?? null
    : null;
  const latestGate = activePhase?.astGates?.findLast?.((entry) => entry.generation === activePhase.generation)
    ?? [...(activePhase?.astGates ?? [])].sort((left, right) => right.generation - left.generation)[0]
    ?? null;
  return {
    schemaVersion: 2, // schema-transient: live diagnostic result, never persisted
    healthy: adapterDiscovery.diagnostics.length === 0,
    configured: runtime.policy,
    effective,
    scope: runtime.sourceScope,
    cache,
    adapters: adapterDiscovery.adapters.map(({ argv: _argv, ...adapter }) => ({ ...adapter, status: 'available-on-demand' })),
    assuranceAvailable: [...assuranceAvailable].sort((left, right) => ['text', 'syntax', 'semantic'].indexOf(left) - ['text', 'syntax', 'semantic'].indexOf(right)),
    lifecycle: {
      enforced: runtime.policy.predicates.length > 0,
      predicateCount: runtime.policy.predicates.length,
      requiredPredicateCount: runtime.policy.predicates.filter((entry) => entry.mode === 'required').length,
      workId: runtime.state?.workItem?.id ?? null,
      phase: activePhase?.id ?? null,
      generation: activePhase?.generation ?? null,
      latestGate
    },
    diagnostics: [
      ...(effective.mode === 'off' ? [{ code: 'AST_DISABLED', severity: 'info' }] : []),
      ...adapterDiscovery.diagnostics
    ]
  };
}

function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.operation) {
    console.log(`AST ${result.operation}: ${result.status} · ${result.assurance} assurance · ${result.coverage.processed}/${result.coverage.selected} files`);
    for (const diagnostic of result.diagnostics) console.log(`- ${diagnostic.code}: ${diagnostic.message ?? ''}`);
    if (result.nextCursor) {
      console.log(`Next page: singularity-flow wm ast ${result.operation} --cursor ${result.nextCursor}`);
    }
  } else console.log(JSON.stringify(result, null, 2));
}

export async function astCommand(root, positionals, options) {
  const action = positionals[0] ?? 'status';
  let result;
  if (action === 'doctor') result = await astDoctor(root);
  else if (action === 'status') result = { ...(await astDoctor(root)), command: 'status' };
  else if (action === 'build') {
    const rawResume = Array.isArray(options.resume) ? options.resume.at(-1) : options.resume;
    const handle = rawResume === true ? positionals[1] : (rawResume ? String(rawResume) : null);
    result = handle ? await resumeBuild(root, handle, options) : await buildOrContext(root, options, 'build');
  }
  else if (action === 'context') result = await astContext(root, options);
  else if (action === 'query') result = await astQuery(root, options);
  else if (action === 'gate') result = await evaluateAstGate(root, options);
  else if (action === 'cache') {
    const cacheAction = positionals[1] ?? 'status';
    if (cacheAction === 'status') result = await astCacheStatus(root);
    else if (cacheAction === 'clear') result = await clearCache(root, options);
    else if (cacheAction === 'prune') result = await pruneCache(root, options);
    else throw new SingularityFlowError('Usage: singularity-flow wm ast cache status|prune|clear');
  } else if (action === 'preference') {
    const preferenceAction = positionals[1] ?? 'show';
    if (preferenceAction === 'show') result = await readAstPreference();
    else if (preferenceAction === 'set') result = await setAstPreference(positionals[2] ?? optionString(options, 'mode'));
    else throw new SingularityFlowError('Usage: singularity-flow wm ast preference show|set auto|off');
  } else throw new SingularityFlowError('Usage: singularity-flow wm ast doctor|status|build|context|query|gate|cache|preference');
  printResult(result, optionBoolean(options, 'json'));
  return result;
}

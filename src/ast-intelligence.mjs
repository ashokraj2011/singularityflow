import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { normalizeAstPolicy, assuranceSatisfies } from './ast-policy.mjs';
import {
  adapterDerivationKey, astAdapterManifestSha256, astAdapterRequest, discoverAstAdapters, executeAstAdapter,
  inspectAstAdapterArtifacts, validateAstAdapterManifest
} from './ast-adapter-contract.mjs';
import {
  applyAstPackInstall, applyAstPackRemove, inspectAstPackRegistry, planAstPackInstall, planAstPackRemove, readAstPackRegistry
} from './ast-pack-registry.mjs';
import { BUILTIN_AST_EXTRACTOR, extractBuiltinAstFacts } from './ast-builtin-extractor.mjs';
import {
  compileAstLanguageCatalog, detectAstLanguage, unsupportedAstProgrammingPaths
} from './ast-language-catalog.mjs';
import { effectiveAstMode, readAstPreference, setAstPreference } from './ast-mode.mjs';
import { astSemanticOverlayKey, astSyntaxCacheKey } from './ast-derivation-key.mjs';
import { bindingForFile, discoverProjectBindings } from './ast-project-binding.mjs';
import { astSemanticWarmCommand } from './ast-semantic-warm.mjs';
import { OPTIONAL_AST_SEMANTIC_PACKS, optionalSemanticPack } from './ast-semantic-pack-catalog.mjs';
import { replayAstEvidence } from './ast-replay.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { configurationReadRoot } from './configuration-read-scope.mjs';
import { applySelectionPriority, FACT_PRIORITIES } from './ast-fact-order.mjs';
import { gitCommonDir } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { normalizeSourceRoots, withWorldModelSourceScope, worldModelSourceScope } from './source-scope.mjs';
import {
  optionBoolean, optionNumber, optionString, optionStrings, posix, run, SingularityFlowError,
  writeJson
} from './util.mjs';

export const AST_RESULT_SCHEMA_VERSION = currentSchemaVersion('ast-result');
const AST_RESUME_JOB_SCHEMA_VERSION = currentSchemaVersion('ast-resume-job');
const STORE_DIR = 'singularity-flow/ast/v2';
const LEGACY_STORE_DIR = 'singularity-flow/ast/v1';
const BUILTIN_EXTRACTOR = BUILTIN_AST_EXTRACTOR;
const AST_ENGINE = Object.freeze({ id: 'singularity-flow-ast-broker', version: 4 });
const AST_READ_CURSOR_VERSION = 1;
const DEFAULT_MAX_FACTS = 200;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;
const MIN_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ASSURANCE = new Set(['text', 'syntax', 'semantic']);
const STATUSES = new Set(['complete', 'partial', 'disabled', 'unsupported', 'stale', 'failed']);
const OPERATIONS = new Set(['context', 'query', 'gate', 'build', 'transform']);
const GIT_LIST_MAX_BUFFER = 128 * 1024 * 1024;
const AST_CACHE_WRITE_CONCURRENCY = 8;
const FACT_INDEX_CACHE_MAX_ENTRIES = 8;
const FACT_INDEX_CACHE_MAX_FACTS = 250_000;

// Process-local acceleration for long-lived VS Code/gateway hosts. Entries are keyed by the
// repository plus content-addressed skeleton identities, bounded by both count and total facts,
// and are never authoritative: every new request still binds its selection to current Git/worktree
// bytes before this cache can be consulted.
const factIndexCache = new Map();
let factIndexCacheFacts = 0;

const EVIDENCE_CLASSES = new Set(['preview', 'recorded-context', 'gate']);
const LOCAL_AST_EVIDENCE_PREFIX = '.singularity-flow/ast-evidence-store/';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractorKey(value) {
  return value ? recordSha256(value) : '';
}

function uniqueExtractors(values) {
  return [...new Map(values.filter(Boolean).map((value) => [extractorKey(value), structuredClone(value)])).values()]
    .sort((left, right) => extractorKey(left).localeCompare(extractorKey(right)));
}

function memoryRepositoryKey(root) {
  return sha256(path.resolve(gitCommonDir(root)));
}

function factSetCacheKey(root, entries) {
  return recordSha256({
    repository: memoryRepositoryKey(root),
    entries: entries.map((entry) => ({
      path: entry.path,
      generated: entry.generated === true,
      cacheKey: entry.cacheKey,
      adapters: (entry.adapters ?? []).map((adapter) => adapter.cacheKey)
    }))
  });
}

function addIndexedFact(map, key, fact) {
  if (typeof key !== 'string' || !key) return;
  const bucket = map.get(key) ?? [];
  bucket.push(fact);
  map.set(key, bucket);
}

function buildFactIndex(facts) {
  const byKind = new Map();
  const symbolsByName = new Map();
  const symbolsById = new Map();
  const filesByPath = new Map();
  const filesByLanguage = new Map();
  const relationshipsBySourceId = new Map();
  const factsByTarget = new Map();
  const position = new Map();

  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index];
    position.set(fact, index);
    addIndexedFact(byKind, fact.kind, fact);
    if (fact.kind === 'symbol') {
      addIndexedFact(symbolsByName, fact.name, fact);
      addIndexedFact(symbolsById, fact.id, fact);
      if (fact.qualifiedName !== fact.id) addIndexedFact(symbolsById, fact.qualifiedName, fact);
    }
    if (fact.kind === 'file') {
      addIndexedFact(filesByPath, fact.path, fact);
      addIndexedFact(filesByLanguage, fact.language, fact);
    }
    if (fact.kind === 'relationship') addIndexedFact(relationshipsBySourceId, fact.sourceId, fact);
    addIndexedFact(factsByTarget, fact.target, fact);
  }

  return {
    byKind, symbolsByName, symbolsById, filesByPath, filesByLanguage,
    relationshipsBySourceId, factsByTarget, position,
    sortedFilePaths: [...filesByPath.keys()].sort()
  };
}

function rememberFactIndex(root, key, facts, index) {
  if (facts.length > FACT_INDEX_CACHE_MAX_FACTS) return;
  const existing = factIndexCache.get(key);
  if (existing) {
    factIndexCacheFacts -= existing.facts.length;
    factIndexCache.delete(key);
  }
  factIndexCache.set(key, { repository: memoryRepositoryKey(root), facts, index });
  factIndexCacheFacts += facts.length;
  while (factIndexCache.size > FACT_INDEX_CACHE_MAX_ENTRIES
    || factIndexCacheFacts > FACT_INDEX_CACHE_MAX_FACTS) {
    const oldestKey = factIndexCache.keys().next().value;
    const oldest = factIndexCache.get(oldestKey);
    factIndexCache.delete(oldestKey);
    factIndexCacheFacts -= oldest.facts.length;
  }
}

function clearFactIndexes(root = null) {
  const repository = root ? memoryRepositoryKey(root) : null;
  for (const [key, entry] of factIndexCache) {
    if (repository && entry.repository !== repository) continue;
    factIndexCache.delete(key);
    factIndexCacheFacts -= entry.facts.length;
  }
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

export { effectiveAstMode, readAstPreference, setAstPreference };

function storeRoot(root) {
  return path.join(gitCommonDir(root), STORE_DIR);
}

function legacyStoreRoot(root) {
  return path.join(gitCommonDir(root), LEGACY_STORE_DIR);
}

function normalizeWorkBinding(value) {
  if (value == null) return null;
  const binding = structuredClone(value);
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || typeof binding.workId !== 'string' || !binding.workId.trim()
    || /[\\/]/.test(binding.workId) || ['.', '..'].includes(binding.workId)
    || !(binding.phaseId === null || (typeof binding.phaseId === 'string' && binding.phaseId))
    || !Number.isInteger(binding.generation) || binding.generation < 0
    || !binding.sourceScope || typeof binding.sourceScope !== 'object' || Array.isArray(binding.sourceScope)
    || typeof binding.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.configurationSha256)
    || typeof binding.lifecycleRevision !== 'string' || !/^[a-f0-9]{64}$/.test(binding.lifecycleRevision)) {
    throw new SingularityFlowError('AST work binding is malformed.', { code: 'AST_WORK_BINDING_INVALID' });
  }
  binding.workId = binding.workId.trim();
  return binding;
}

function assertWorkBinding(expected, actual) {
  if (!expected) return;
  if (!actual || recordSha256(expected) !== recordSha256(actual)) {
    throw new SingularityFlowError(
      'AST runtime no longer matches the requested governed work item, phase, scope, configuration, or lifecycle revision.',
      { code: 'AST_WORK_BINDING_MISMATCH', details: { workId: expected.workId, phaseId: expected.phaseId } }
    );
  }
}

async function loadRuntime(root, requestedWorkBinding = null) {
  const expectedBinding = normalizeWorkBinding(requestedWorkBinding);
  let definition = {};
  let state = null;
  if (existsSync(path.join(configurationReadRoot(root), WORKFLOW_PATH))) {
    definition = await loadDefinition(root);
    const branch = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
    const workId = expectedBinding?.workId ?? branch;
    const statePath = workId
      ? path.join(root, definition.workItemRoot ?? 'singularity/work-items', workId, 'workflow.json')
      : null;
    if (statePath && existsSync(statePath)) {
      state = readRecord('story-workflow', await readFile(statePath)).record;
    }
    if (expectedBinding && !state) {
      throw new SingularityFlowError(
        `AST cannot load the governed workflow for '${expectedBinding.workId}'.`,
        { code: 'AST_WORK_BINDING_UNAVAILABLE' }
      );
    }
    definition = withWorldModelSourceScope(
      definition,
      state?.resolution?.worldModelSourceScope ?? state?.resolution?.capability?.sourceScope ?? null
    );
  }
  const sourceScope = worldModelSourceScope(definition);
  const definitionSha256 = recordSha256({
    ast: definition.ast ?? {},
    worldModel: {
      sourceRoots: definition.worldModel?.sourceRoots ?? [],
      sharedRoots: definition.worldModel?.sharedRoots ?? []
    }
  });
  const actualBinding = expectedBinding && state ? {
    workId: state.workItem?.id ?? expectedBinding.workId,
    phaseId: state.currentPhase ?? null,
    generation: state.phases?.[state.currentPhase]?.generation ?? 0,
    sourceScope,
    configurationSha256: definitionSha256,
    lifecycleRevision: recordSha256(state)
  } : null;
  assertWorkBinding(expectedBinding, actualBinding);
  return {
    definition,
    state,
    policy: normalizeAstPolicy(definition.ast ?? {}),
    sourceScope,
    definitionSha256,
    workBinding: actualBinding
  };
}

function repositoryRevision(root) {
  const result = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitObjectFormat(root) {
  const result = run('git', ['rev-parse', '--show-object-format'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : 'sha1';
}

function evidenceClass(options = {}) {
  const value = optionString(options, 'evidence-class', 'preview');
  if (!EVIDENCE_CLASSES.has(value)) {
    throw new SingularityFlowError('AST evidence class must be preview, recorded-context, or gate.');
  }
  return value;
}

function languageFor(relative, runtime) {
  return detectAstLanguage(relative, runtime.languageCatalog).language;
}

function trackedFiles(root, prefixes = []) {
  const pathspec = prefixes.length ? ['--', ...prefixes] : [];
  const output = run('git', ['ls-files', '--stage', '-z', ...pathspec], { cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER }).stdout;
  const tracked = splitNull(output).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) return [];
    const [mode, object, stage] = entry.slice(0, tab).split(' ');
    if (stage !== '0') return [];
    return [{ path: posix(entry.slice(tab + 1)), mode, object }];
  });
  const known = new Set(tracked.map((file) => file.path));
  const untracked = splitNull(run('git', ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec], {
    cwd: root, maxBuffer: GIT_LIST_MAX_BUFFER
  }).stdout)
    .map((relative) => ({ path: posix(relative), mode: 'untracked', object: null }))
    .filter((file) => !file.path.startsWith(LOCAL_AST_EVIDENCE_PREFIX))
    .filter((file) => !known.has(file.path));
  return [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
}

function changedPaths(root, prefixes = []) {
  const pathspec = prefixes.length ? ['--', ...prefixes] : [];
  const tracked = splitNull(run('git', ['diff', '--name-only', '-z', 'HEAD', ...pathspec], {
    cwd: root, allowFailure: true, maxBuffer: GIT_LIST_MAX_BUFFER
  }).stdout);
  const untracked = splitNull(run('git', ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec], {
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
  const language = languageFor(file.path, runtime);
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
  if (!runtime.adapterDiscovery) {
    const discovered = await discoverAstAdapters();
    const inspected = await Promise.all(discovered.adapters.map(async (adapter) => ({
      adapter, health: await inspectAstAdapterArtifacts(adapter)
    })));
    runtime.adapterDiscovery = {
      adapters: inspected.filter((entry) => entry.health.healthy).map((entry) => entry.adapter),
      diagnostics: [
        ...discovered.diagnostics,
        ...inspected.flatMap((entry) => entry.health.diagnostics)
      ]
    };
  }
  if (!runtime.languageCatalog) runtime.languageCatalog = compileAstLanguageCatalog(runtime.adapterDiscovery.adapters);
  const requested = explicitPaths(options);
  const all = optionBoolean(options, 'all');
  if (requested.length && all) throw new SingularityFlowError('Use either AST --paths or --all, not both.');
  const roots = runtime.sourceScope.paths;
  // Let Git apply the cone. Listing a million-path monorepo only to discard all but one package in
  // JavaScript makes a bounded AST request scale with the repository rather than its requested scope.
  const prefixes = requested.length ? requested : all ? [] : roots;
  const allTracked = trackedFiles(root, prefixes);
  const changed = changedPaths(root, prefixes);
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
  const unsupported = unsupportedAstProgrammingPaths(
    candidates.map((file) => file.path), runtime.languageCatalog, { classifyUnknown: true }
  );
  const unsupportedPaths = new Set(unsupported.map((entry) => entry.path));
  for (const candidate of candidates) {
    if (unsupportedPaths.has(candidate.path) && !candidate.skipReason) candidate.skipReason = 'language-unsupported';
  }
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
    unsupported,
    coneSha256,
    repositoryRevision: repositoryRevision(root)
  };
}

function resumeJobPath(root, id) {
  return path.join(storeRoot(root), 'jobs', `${id}.json`);
}

function blobKey(file, extractor = BUILTIN_EXTRACTOR) {
  if (extractor.stage === 'syntax') return astSyntaxCacheKey(file.sha256, extractor.derivation);
  if (extractor.stage === 'semantic') {
    const syntax = (file.adapters ?? []).find((entry) => entry.extractor?.stage === 'syntax');
    if (!syntax) throw new SingularityFlowError('A semantic AST overlay requires an accepted syntax skeleton.', {
      code: 'AST_SEMANTIC_SYNTAX_REQUIRED'
    });
    return astSemanticOverlayKey(syntax.cacheKey, extractor.derivation);
  }
  return sha256(canonicalJson({
    contentKey: file.contentKey, language: file.language,
    extractor
  }));
}

function cacheFamily(extractor = BUILTIN_EXTRACTOR) {
  if (extractor.stage === 'semantic') return { directory: 'semantic', record: 'ast-semantic-overlay' };
  if (extractor.stage === 'syntax') return { directory: 'syntax', record: 'ast-syntax-skeleton' };
  return { directory: 'blobs', record: 'ast-cache-blob' };
}

function blobPath(root, key, extractor = BUILTIN_EXTRACTOR) {
  return path.join(storeRoot(root), cacheFamily(extractor).directory, `${key}.json`);
}

function skeletonIntegrity(record) {
  const { integritySha256: _integrity, ...content } = record;
  return recordSha256(content);
}

function sealSkeleton(record) {
  return { ...record, integritySha256: skeletonIntegrity(record) };
}

function validateSkeleton(value, file, key, extractor = BUILTIN_EXTRACTOR) {
  const record = readRecord(cacheFamily(extractor).record, value).record;
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
          : fact?.kind === 'module'
            ? typeof fact.id === 'string' && typeof fact.name === 'string'
            : fact?.kind === 'diagnostic'
              ? typeof fact.code === 'string'
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
  const facts = extractBuiltinAstFacts(bytes, file.language, file.path);
  return sealSkeleton({
    schemaVersion: currentSchemaVersion('ast-cache-blob'), key, contentKey: file.contentKey,
    sha256: digest, language: file.language, extractor: BUILTIN_EXTRACTOR, facts
  });
}

async function skeletonFor(root, file, {
  persist = false, memory = new Map(), metrics = null, preparedBytes = null,
  cacheWriteRequired = persist, cacheWriteFailures = []
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
    if (persist && file.contentKey?.startsWith('git:')) {
      await persistCacheRecords([{
        target: blobPath(root, key), record: skeleton, path: file.path
      }], { required: cacheWriteRequired, failures: cacheWriteFailures });
    }
  }
  memory.set(key, skeleton);
  return skeleton;
}

async function persistCacheRecords(records, { required, failures }) {
  if (!records.length) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(AST_CACHE_WRITE_CONCURRENCY, records.length) }, async () => {
    while (next < records.length) {
      const current = records[next];
      next += 1;
      try {
        await writeJson(current.target, current.record);
      } catch (error) {
        if (required) throw error;
        failures.push({ path: current.path, code: error?.code ?? 'AST_CACHE_WRITE_FAILED' });
      }
    }
  });
  await Promise.all(workers);
}

async function cachedSkeleton(root, file, key, { required = true, failures = [] } = {}) {
  try {
    return validateSkeleton(await readFile(blobPath(root, key)), file, key);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'AST_CACHE_INVALID') return null;
    if (!required) {
      failures.push({ path: file.path, code: error?.code ?? 'AST_CACHE_READ_FAILED' });
      return null;
    }
    throw error;
  }
}

function entryFor(file, skeleton) {
  return {
    path: file.path, contentKey: file.contentKey, cacheKey: skeleton.key, sha256: skeleton.sha256,
    gitObjectId: file.object ?? null, gitMode: file.mode ?? null,
    language: file.language, size: file.size, generated: file.generated, materialized: file.materialized !== false,
    requiredAssurance: file.requiredAssurance ?? 'text', extractor: structuredClone(skeleton.extractor),
    assurance: skeleton.extractor.assurance, adapters: []
  };
}

function materializeFacts(entry, skeleton, { includeFile = true } = {}) {
  const generated = entry.generated === true;
  const extractor = structuredClone(skeleton.extractor);
  const decorate = (fact) => {
    if (fact.kind === 'symbol') {
      return {
        ...structuredClone(fact), at: `${entry.path}:${fact.span?.startLine ?? fact.line}`,
        path: entry.path, assurance: fact.assurance, generated, extractor
      };
    }
    if (fact.kind === 'import') {
      return { ...structuredClone(fact), from: entry.path, assurance: fact.assurance, generated, extractor };
    }
    if (fact.kind === 'module' || fact.kind === 'diagnostic') {
      return { ...structuredClone(fact), path: entry.path, assurance: fact.assurance, generated, extractor };
    }
    return {
      ...structuredClone(fact), from: entry.path,
      assurance: fact.assurance, generated, extractor
    };
  };
  return [
    ...(includeFile ? [{
      kind: 'file', path: entry.path, language: entry.language, bytes: entry.size,
      sha256: skeleton.sha256, generated, assurance: skeleton.extractor.assurance, extractor
    }] : []),
    ...skeleton.facts.map(decorate)
  ];
}

async function factsForEntries(root, entries, memory = new Map(), { allowMemoryReuse = true } = {}) {
  const cacheKey = factSetCacheKey(root, entries);
  const retained = factIndexCache.get(cacheKey);
  if (retained && allowMemoryReuse) {
    // Map insertion order is the LRU clock.
    factIndexCache.delete(cacheKey);
    factIndexCache.set(cacheKey, retained);
    return { facts: retained.facts, index: retained.index, memoryHit: true };
  }
  const facts = [];
  for (const entry of entries) {
    let skeleton = memory.get(entry.cacheKey);
    if (!skeleton) skeleton = await skeletonFor(root, entry, { persist: false, memory });
    facts.push(...materializeFacts(entry, skeleton));
    for (const adapter of entry.adapters ?? []) {
      let adapterSkeleton = memory.get(adapter.cacheKey);
      if (!adapterSkeleton) {
        adapterSkeleton = validateSkeleton(
          await readFile(blobPath(root, adapter.cacheKey, adapter.extractor)), entry, adapter.cacheKey, adapter.extractor
        );
      }
      facts.push(...materializeFacts(entry, adapterSkeleton, { includeFile: false }));
    }
  }
  const index = buildFactIndex(facts);
  rememberFactIndex(root, cacheKey, facts, index);
  return { facts, index, memoryHit: false };
}

function skippedKey(item) {
  return `${item.path}\0${item.reason}`;
}

async function processCandidates(root, runtime, candidates, {
  startIndex = 0, entries: previousEntries = [], skipped: previousSkipped = [], options = {},
  persist = false, cacheWriteRequired = persist
} = {}) {
  const budgets = astBudgets(runtime, options);
  const entries = structuredClone(previousEntries);
  const skipped = structuredClone(previousSkipped);
  const seenSkipped = new Set(skipped.map(skippedKey));
  const memory = new Map();
  const cache = { hits: 0, misses: 0, writeFailures: [] };
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
    const cached = await cachedSkeleton(root, file, key, {
      required: cacheWriteRequired, failures: cache.writeFailures
    });
    if (cached) {
      memory.set(key, cached);
      cache.hits += 1;
    } else if (!misses.has(key)) misses.set(key, file);
    else cache.hits += 1;
  }
  const gitBlobs = gitBlobBatch(root, [...misses.values()].filter((file) => file.contentKey?.startsWith('git:')));
  const cacheRecords = [];
  for (const [key, file] of misses) {
    const skeleton = await deriveSkeleton(
      root, file, key,
      file.contentKey?.startsWith('git:') ? gitBlobs.get(file.object) : null
    );
    if (persist && file.contentKey?.startsWith('git:')) {
      cacheRecords.push({ target: blobPath(root, key), record: skeleton, path: file.path });
    }
    memory.set(key, skeleton);
    cache.misses += 1;
  }
  await persistCacheRecords(cacheRecords, { required: cacheWriteRequired, failures: cache.writeFailures });
  for (const file of page) {
    const skeleton = memory.get(blobKey(file));
    entries.push(entryFor(file, skeleton));
  }
  return { entries, skipped, nextIndex: index, memory, budgets, pageFiles, pageBytes, minimumRequiredBytes, cache };
}

function assuranceRank(value) {
  return ['text', 'syntax', 'semantic'].indexOf(value);
}

function adapterExtractor(adapter, language, project = null) {
  const derivation = adapterDerivationKey(adapter, language, project);
  return {
    id: adapter.id,
    packVersion: adapter.packVersion,
    version: adapter.extractorVersion,
    stage: adapter.stage,
    assurance: adapter.assurance,
    protocolVersion: adapter.protocolVersion,
    ...(adapter.legacyProtocol ? { legacyProtocol: adapter.legacyProtocol } : {}),
    manifestSha256: adapter.implementation.manifestSha256,
    artifactSha256: adapter.implementation.artifactSha256,
    runtime: structuredClone(adapter.implementation.runtime),
    grammars: structuredClone(adapter.implementation.grammars),
    dependencies: structuredClone(adapter.implementation.dependencies),
    derivation
  };
}

function providerFor(entry, stage, adapters, policy, diagnostics) {
  const compatible = adapters
    .filter((adapter) => adapter.stage === stage && adapter.languages.includes(entry.language)
      && (adapter.capabilities.length === 0 || adapter.capabilities.includes('skeleton'))
      && ((adapter.languageDefinitions[entry.language]?.platforms ?? []).length === 0
        || adapter.languageDefinitions[entry.language].platforms.includes('any')
        || adapter.languageDefinitions[entry.language].platforms.includes(process.platform)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const configured = stage === 'syntax' ? policy.syntaxProvider : policy.semanticProvider;
  if (configured) {
    const selected = compatible.find((adapter) => adapter.id === configured);
    if (!selected) diagnostics.push({
      code: 'AST_PROVIDER_UNAVAILABLE', language: entry.language, stage, provider: configured,
      message: `Configured ${stage} provider '${configured}' is unavailable for ${entry.language}.`
    });
    return selected ?? null;
  }
  if (compatible.length > 1) diagnostics.push({
    code: 'AST_PROVIDER_CONFLICT', language: entry.language, stage,
    providers: compatible.map((adapter) => adapter.id),
    message: `Multiple ${stage} providers are installed for ${entry.language}; '${compatible.find((item) => item.id === 'sflow-polyglot-syntax')?.id ?? compatible[0].id}' was selected deterministically. Pin a provider in ast.languages.${entry.language}.`
  });
  return compatible.find((adapter) => adapter.id === 'sflow-polyglot-syntax') ?? compatible[0] ?? null;
}

async function applyConfiguredAdapters(root, runtime, selection, processed, { persist = false } = {}) {
  const diagnostics = [];
  const degradation = [];
  const provenance = [];
  if (runtime.policy.fallback === 'text-only' || !processed.entries.length) {
    return { diagnostics, degradation, provenance, projectBindings: [] };
  }
  const discovery = runtime.adapterDiscovery ?? await discoverAstAdapters();
  runtime.adapterDiscovery = discovery;
  diagnostics.push(...discovery.diagnostics);
  const projectDiscovery = discovery.adapters.some((adapter) => adapter.stage === 'semantic')
    ? await discoverProjectBindings(root, { paths: selection.scope.paths ?? [] })
    : { bindings: [], diagnostics: [] };
  diagnostics.push(...projectDiscovery.diagnostics.map((item) => ({ ...item, message: 'Project discovery reached its bounded metadata limit.' })));

  const cacheRecords = [];
  // Syntax always runs before semantic enrichment. A failed semantic provider never discards the
  // accepted syntax skeleton, and no semantic provider runs without a complete immutable binding.
  for (const stage of ['syntax', 'semantic']) {
    const groups = new Map();
    for (const entry of processed.entries) {
      if (entry.materialized === false) continue;
      const policy = runtime.policy.languages[entry.language] ?? {
        mode: 'auto', minimumAssurance: 'text', syntaxProvider: null, semanticProvider: null, semanticProfile: null
      };
      const adapter = providerFor(entry, stage, discovery.adapters, policy, diagnostics);
      if (!adapter) continue;
      const definition = adapter.languageDefinitions[entry.language];
      const project = stage === 'semantic'
        ? bindingForFile(projectDiscovery.bindings, entry.path, definition.projectKinds ?? [])
        : null;
      // A semantic parser may join its validated facts to the preview's stable declaration IDs.
      // That identity join does not promote the preview itself: only facts returned by the semantic
      // provider receive semantic assurance.
      if (stage === 'semantic' && !(entry.adapters ?? []).some((item) => item.extractor?.stage === 'syntax')) {
        degradation.push({
          path: entry.path, reason: 'semantic-syntax-skeleton-unavailable', adapter: adapter.id,
          required: entry.requiredAssurance
        });
        continue;
      }
      if (stage === 'semantic' && (!project || project.complete !== true)) {
        degradation.push({
          path: entry.path, reason: 'semantic-project-binding-incomplete', adapter: adapter.id,
          required: entry.requiredAssurance,
          unavailable: project?.unavailable ?? ['project-binding']
        });
        continue;
      }
      if (stage === 'semantic' && project.semanticProvider && project.semanticProvider !== adapter.id) {
        degradation.push({
          path: entry.path, reason: 'semantic-project-provider-mismatch', adapter: adapter.id,
          required: entry.requiredAssurance, boundProvider: project.semanticProvider
        });
        continue;
      }
      if (stage === 'semantic' && policy.semanticProfile && project.profile !== policy.semanticProfile) {
        degradation.push({
          path: entry.path, reason: 'semantic-project-profile-mismatch', adapter: adapter.id,
          required: entry.requiredAssurance, configuredProfile: policy.semanticProfile,
          boundProfile: project.profile
        });
        continue;
      }
      const extractor = adapterExtractor(adapter, entry.language, project);
      const key = blobKey(entry, extractor);
      const existingIndex = (entry.adapters ?? []).findIndex((existing) => existing.extractor?.derivation?.derivationSha256 === extractor.derivation.derivationSha256);
      try {
        const cached = validateSkeleton(await readFile(blobPath(root, key, extractor)), entry, key, extractor);
        processed.memory.set(key, cached);
        if (existingIndex < 0) entry.adapters.push({ cacheKey: key, extractor });
        entry.assurance = assuranceRank(extractor.assurance) > assuranceRank(entry.assurance) ? extractor.assurance : entry.assurance;
        processed.cache.hits += 1;
        provenance.push({
          id: adapter.id, packVersion: adapter.packVersion, version: adapter.extractorVersion,
          stage, assurance: adapter.assurance, derivationSha256: extractor.derivation.derivationSha256, status: 'cache-hit'
        });
        continue;
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'AST_CACHE_INVALID') {
          if (processed.cacheWriteRequired !== false) throw error;
          processed.cache.writeFailures.push({
            path: entry.path, code: error?.code ?? 'AST_CACHE_READ_FAILED'
          });
        }
        if (existingIndex >= 0) entry.adapters.splice(existingIndex, 1);
      }
      const groupId = `${adapter.id}\0${project?.projectModelSha256 ?? 'syntax'}`;
      const group = groups.get(groupId) ?? { adapter, project, entries: [] };
      group.entries.push(entry);
      groups.set(groupId, group);
    }
    for (const { adapter, project, entries } of groups.values()) {
      const request = astAdapterRequest({
        protocolVersion: adapter.protocolVersion, operation: 'skeleton', stage,
        scope: { ...selection.scope, repositoryRevision: selection.repositoryRevision },
        files: entries.map((entry) => ({ path: entry.path, sha256: entry.sha256, language: entry.language })),
        budget: { ...processed.budgets, maxOutputBytes: 2 * 1024 * 1024, timeoutMs: 30_000 },
        implementation: adapter.implementation, project
      });
      try {
        const response = await executeAstAdapter(adapter, request, { root });
        const byPath = new Map(response.files.map((file) => [file.path, file]));
        for (const entry of entries) {
          const file = byPath.get(entry.path);
          if (!file) {
            degradation.push({ path: entry.path, reason: 'adapter-omitted-file', adapter: adapter.id, required: entry.requiredAssurance });
            continue;
          }
          if (stage === 'semantic') {
            const syntaxEntry = entry.adapters.find((item) => item.extractor?.stage === 'syntax');
            const syntaxSkeleton = processed.memory.get(syntaxEntry.cacheKey)
              ?? validateSkeleton(await readFile(blobPath(root, syntaxEntry.cacheKey, syntaxEntry.extractor)), entry, syntaxEntry.cacheKey, syntaxEntry.extractor);
            const syntaxIds = new Set(syntaxSkeleton.facts.filter((fact) => fact.kind === 'symbol').map((fact) => fact.id));
            if (file.facts.some((fact) => fact.kind === 'symbol' && (!fact.syntaxId || !syntaxIds.has(fact.syntaxId)))) {
              degradation.push({ path: entry.path, reason: 'semantic-syntax-join-invalid', adapter: adapter.id, required: entry.requiredAssurance });
              diagnostics.push({ code: 'AST_SEMANTIC_SYNTAX_JOIN_INVALID', message: `Semantic adapter '${adapter.id}' returned a declaration without a valid syntax identity.` });
              continue;
            }
          }
          const extractor = adapterExtractor(adapter, entry.language, project);
          const key = blobKey(entry, extractor);
          const family = cacheFamily(extractor).record;
          const skeleton = sealSkeleton({
            schemaVersion: currentSchemaVersion(family), key, contentKey: entry.contentKey,
            sha256: entry.sha256, language: entry.language, extractor, facts: file.facts
          });
          processed.memory.set(key, skeleton);
          if (persist && entry.contentKey?.startsWith('git:')) {
            cacheRecords.push({
              target: blobPath(root, key, extractor), record: skeleton, path: entry.path
            });
          }
          entry.adapters.push({ cacheKey: key, extractor });
          entry.assurance = assuranceRank(extractor.assurance) > assuranceRank(entry.assurance) ? extractor.assurance : entry.assurance;
          processed.cache.misses += 1;
        }
        diagnostics.push(...response.diagnostics);
        diagnostics.push(...response.rejectedFiles.map((item) => ({ ...item, message: `Adapter '${adapter.id}' returned an invalid result for ${item.path}.` })));
        const derivations = entries.map((entry) => adapterExtractor(adapter, entry.language, project).derivation.derivationSha256);
        provenance.push({
          id: adapter.id, packVersion: adapter.packVersion, version: adapter.extractorVersion,
          stage, assurance: adapter.assurance, derivations: [...new Set(derivations)].sort(), status: 'executed'
        });
      } catch (error) {
        diagnostics.push({ code: error.code ?? 'AST_ADAPTER_FAILED', message: error.message, adapter: adapter.id });
        degradation.push(...entries.map((entry) => ({
          path: entry.path, reason: 'adapter-failed', adapter: adapter.id, required: entry.requiredAssurance
        })));
        provenance.push({
          id: adapter.id, packVersion: adapter.packVersion, version: adapter.extractorVersion,
          stage, assurance: adapter.assurance, status: 'failed'
        });
      }
    }
  }
  await persistCacheRecords(cacheRecords, {
    required: processed.cacheWriteRequired !== false,
    failures: processed.cache.writeFailures
  });
  return {
    diagnostics,
    degradation,
    projectBindings: projectDiscovery.bindings.filter((binding) => binding.complete === true),
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
    generated: processed.entries.filter((entry) => entry.generated === true).length,
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
    evidenceClass: 'preview',
    scope: {
      ...scope,
      repositoryRevision: revision,
      worktreeFingerprint: fingerprint,
      ...(runtime.workBinding ? { workBinding: structuredClone(runtime.workBinding) } : {})
    },
    assurance: 'text',
    status: mode.mode === 'off' ? 'disabled' : 'complete',
    coverage: {
      selected: 0, processed: 0, skipped: 0, bytes: 0,
      generated: 0,
      facts: 0, factsExamined: 0, factsMatched: 0, factsReturned: 0, byLanguage: {}
    },
    facts: [], diagnostics: [], degradation: [], resumeHandle: null, nextCursor: null,
    page: {
      offset: 0, returned: 0, available: 0, hasMore: false,
      maxFacts: DEFAULT_MAX_FACTS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, outputBytes: 0
    },
    provenance: {
      engine: AST_ENGINE.id, engineVersion: AST_ENGINE.version,
      adapters: [], extractors: [], effectiveMode: mode.mode, modeSources: mode.sources,
      languageCatalogSha256: runtime.languageCatalog?.sha256 ?? null
    }
  };
}

function durableInputProblems(selection) {
  return selection.candidates
    .filter((file) => file.skipReason || !file.object || file.contentKey !== `git:${file.object}`)
    .map((file) => ({
      path: file.path,
      reason: file.skipReason ?? (!file.object ? 'untracked' : 'worktree-differs-from-commit')
    }));
}

function normalizedOperationOptions(runtime, selection, options, operation) {
  return {
    operation,
    selector: {
      kind: selection.scope.kind,
      paths: [...(selection.scope.paths ?? [])].sort()
    },
    inputBudgets: astBudgets(runtime, options),
    outputLimits: outputLimits(options),
    mode: optionString(options, 'mode', 'auto'),
    // The selection priority is part of the recipe: the recorded page was cut from the selected
    // order, and a replay that re-cuts from canonical order can never reproduce its hash.
    priority: factPriority(options),
    predicates: structuredClone(runtime.policy.predicates)
  };
}

function extractorFactSets(facts) {
  const groups = new Map();
  for (const fact of facts) {
    const id = fact.extractor?.id ?? 'unknown';
    const current = groups.get(id) ?? [];
    current.push(fact); groups.set(id, current);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, values]) => ({
    id, count: values.length, factsSha256: recordSha256(values)
  }));
}

function attachEvidenceCapture(root, runtime, selection, processed, envelope, options, structuralFacts) {
  const requestedClass = evidenceClass(options);
  envelope.evidenceClass = requestedClass;
  const problems = durableInputProblems(selection);
  if (requestedClass === 'preview') {
    if (problems.length) envelope.diagnostics.push({
      code: 'AST_PREVIEW_NOT_DURABLE',
      message: `Structural preview is not durable evidence: ${problems.length} selected path(s) are not exact committed Git blobs.`
    });
    return envelope;
  }
  if (runtime.policy.evidence.mode === 'off') {
    envelope.status = envelope.status === 'disabled' ? 'disabled' : 'partial';
    envelope.diagnostics.push({
      code: 'AST_EVIDENCE_DISABLED', severity: 'warn',
      message: `AST ${requestedClass} evidence is disabled; the operation continued without durable AST evidence.`
    });
    return envelope;
  }
  if (problems.length) {
    envelope.status = 'partial';
    envelope.diagnostics.push({
      code: 'AST_EVIDENCE_INPUT_NOT_COMMITTED', severity: 'warn',
      message: `Durable AST evidence was omitted because ${problems.length} selected path(s) are not exact committed Git blobs.`,
      paths: problems.slice(0, 50)
    });
    return envelope;
  }
  const sourceCommit = selection.repositoryRevision;
  if (!sourceCommit) {
    envelope.status = 'partial';
    envelope.diagnostics.push({
      code: 'AST_EVIDENCE_SOURCE_COMMIT_MISSING', severity: 'warn',
      message: 'Durable AST evidence was omitted because the repository has no committed Git HEAD.'
    });
    return envelope;
  }
  const files = processed.entries.map((entry) => ({
    path: entry.path,
    gitObjectId: entry.gitObjectId,
    gitMode: entry.gitMode,
    contentSha256: entry.sha256,
    language: entry.language,
    bytes: entry.size,
    generated: entry.generated === true
  })).sort((left, right) => left.path.localeCompare(right.path));
  const operationOptions = normalizedOperationOptions(runtime, selection, options, envelope.operation);
  envelope.provenance.evidence = {
    evidenceClass: requestedClass,
    extractors: uniqueExtractors(structuralFacts.flatMap((fact) => [
      fact.extractor, ...(fact.extractors ?? [])
    ])),
    configuration: {
      astPolicySha256: recordSha256(runtime.policy),
      sourceScopeSha256: recordSha256(runtime.sourceScope),
      intelligenceProfileSha256: recordSha256(runtime.definition?.worldModel?.intelligence ?? null),
      predicateSetSha256: recordSha256(runtime.policy.predicates),
      operationOptionsSha256: recordSha256(operationOptions)
    },
    projectBindings: structuredClone(envelope.provenance.projectBindings ?? []),
    replayRecipe: operationOptions,
    inputs: {
      sourceCommit,
      gitObjectFormat: gitObjectFormat(root),
      files
    },
    outputs: {
      canonicalizationVersion: 1,
      factsSha256: recordSha256(structuralFacts),
      extractorFactSets: extractorFactSets(structuralFacts),
      predicateResultsSha256: null,
      page: null
    }
  };
  return envelope;
}

function captureReturnedPage(envelope) {
  const evidence = envelope.provenance?.evidence;
  if (!evidence) return envelope;
  evidence.outputs.page = {
    factsSha256: recordSha256(envelope.facts),
    returned: envelope.page.returned,
    available: envelope.page.available,
    offset: envelope.page.offset,
    continuationBinding: envelope.nextCursor ? sha256(envelope.nextCursor) : null,
    canonicalizationVersion: 1
  };
  return envelope;
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
  if (!EVIDENCE_CLASSES.has(record.evidenceClass)) throw new SingularityFlowError('Invalid AST result evidence class.');
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

async function buildOrContext(root, options, operation, workBinding = null) {
  const runtime = await loadRuntime(root, workBinding);
  const mode = await effectiveAstMode(runtime.policy, optionString(options, 'mode', 'auto'));
  if (mode.mode === 'off') {
    const requestedClass = evidenceClass(options);
    const requested = explicitPaths(options);
    const all = optionBoolean(options, 'all');
    if (requested.length && all) throw new SingularityFlowError('Use either AST --paths or --all, not both.');
    const scope = {
      kind: requested.length ? 'paths' : all ? 'all' : runtime.sourceScope.paths.length ? 'cone' : 'changed',
      paths: requested.length ? requested : runtime.sourceScope.paths,
      definitionSha256: runtime.definitionSha256
    };
    const disabled = baseEnvelope(runtime, operation, scope, mode);
    disabled.evidenceClass = requestedClass;
    disabled.diagnostics.push({
      code: 'AST_DISABLED', severity: 'info',
      message: 'Structural intelligence is disabled; ordinary repository file access remains available.'
    });
    return validateAstResultEnvelope(refreshEnvelopeAccounting(disabled));
  }
  const selection = await enumerateScope(root, runtime, options);
  const cacheWriteRequired = operation === 'build';
  const processed = await processCandidates(root, runtime, selection.candidates, {
    options, persist: true, cacheWriteRequired
  });
  processed.cacheWriteRequired = cacheWriteRequired;
  const adapters = await applyConfiguredAdapters(root, runtime, selection, processed, {
    persist: true
  });
  const envelope = baseEnvelope(runtime, operation, selection.scope, mode, {
    revision: selection.repositoryRevision, fingerprint: selection.coneSha256
  });
  if (selection.unsupported.length) envelope.diagnostics.push({
    code: 'AST_LANGUAGE_UNSUPPORTED', severity: 'warn',
    message: `${selection.unsupported.length} programming source path(s) have no installed AST support; they were skipped and ordinary file access remains available.`,
    paths: selection.unsupported.map((entry) => entry.path)
  });
  const factSet = await factsForEntries(root, processed.entries, processed.memory, {
    // A miss can represent first extraction or repair of an invalid/nondeterministic provider
    // record. Materialize those accepted bytes again instead of trusting an older process entry.
    allowMemoryReuse: processed.cache.misses === 0
  });
  envelope.facts = factSet.facts;
  const structuralFacts = structuredClone(envelope.facts);
  envelope.assurance = resultAssurance(processed.entries);
  const deferred = selection.candidates.slice(processed.nextIndex).map((file) => ({
    path: file.path, reason: 'operation-budget', bytes: file.size
  }));
  const assurance = assuranceDegradation(processed.entries);
  const degradation = [...processed.skipped, ...deferred, ...adapters.degradation, ...assurance];
  envelope.diagnostics.push(...adapters.diagnostics);
  envelope.provenance.adapters = adapters.provenance;
  envelope.provenance.projectBindings = structuredClone(adapters.projectBindings);
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
  if (processed.cache.writeFailures.length) envelope.diagnostics.push({
    code: 'AST_CACHE_WARM_FAILED', severity: 'warn',
    message: `${processed.cache.writeFailures.length} local AST cache operation${processed.cache.writeFailures.length === 1 ? '' : 's'} failed; this result remains available and ordinary repository access continues.`
  });
  if (operation === 'build') {
    envelope.resumeHandle = await createResumeJob(root, runtime, selection, processed, options);
    const manifest = await writeManifest(root, runtime, selection, processed, envelope.coverage, envelope.status);
    envelope.provenance.manifest = path.relative(gitCommonDir(root), manifest.target).replaceAll(path.sep, '/');
  }
  attachEvidenceCapture(root, runtime, selection, processed, envelope, options, structuralFacts);
  const validated = validateAstResultEnvelope(refreshEnvelopeAccounting(envelope));
  envelopeFactIndexes.set(validated, factSet.index);
  return validated;
}

async function resumeBuild(root, handle, options) {
  const { job, file, runtime, selection } = await readResumeJob(root, handle);
  const resumedOptions = { ...options };
  delete resumedOptions.resume;
  const mode = await effectiveAstMode(runtime.policy, optionString(resumedOptions, 'mode', 'auto'));
  if (mode.mode === 'off') {
    const disabled = baseEnvelope(runtime, 'build', selection.scope, mode, {
      revision: selection.repositoryRevision, fingerprint: selection.coneSha256
    });
    disabled.evidenceClass = evidenceClass(resumedOptions);
    disabled.diagnostics.push({
      code: 'AST_DISABLED', severity: 'info',
      message: 'AST was disabled after this build began; the resume handle was preserved and ordinary repository file access remains available.'
    });
    return validateAstResultEnvelope(refreshEnvelopeAccounting(disabled));
  }
  const processed = await processCandidates(root, runtime, job.candidates, {
    startIndex: job.nextIndex, entries: job.entries, skipped: job.skipped,
    options: resumedOptions, persist: true
  });
  const adapters = await applyConfiguredAdapters(root, runtime, selection, processed, { persist: true });
  const factSet = await factsForEntries(root, processed.entries, processed.memory, {
    allowMemoryReuse: processed.cache.misses === 0
  });
  const facts = factSet.facts;
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
  result.provenance.projectBindings = structuredClone(adapters.projectBindings);
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
  attachEvidenceCapture(root, runtime, selection, processed, result, resumedOptions, facts);
  return validateAstResultEnvelope(refreshEnvelopeAccounting(result));
}

function matchQuery(fact, predicate, value) {
  if (predicate === 'symbol') return fact.kind === 'symbol' && String(fact.name).includes(value);
  if (predicate === 'symbol-id') return fact.kind === 'symbol' && (fact.id === value || fact.qualifiedName === value);
  if (predicate === 'import') return fact.kind === 'import' && String(fact.target).includes(value);
  if (predicate === 'references') return fact.kind === 'relationship'
    && ['references', 'calls', 'reads', 'writes', 'test-covers'].includes(fact.type)
    && (fact.sourceId === value || fact.target === value);
  if (predicate === 'hierarchy') return fact.kind === 'relationship'
    && ['extends', 'implements', 'conforms-to', 'overrides', 'expect-actual'].includes(fact.type)
    && (fact.sourceId === value || fact.target === value);
  if (predicate === 'module') return fact.kind === 'module' && (fact.id === value || String(fact.name).includes(value));
  if (predicate === 'language') return fact.kind === 'file' && fact.language === value;
  if (predicate === 'path') return fact.kind === 'file' && inPrefix(fact.path, value);
  return false;
}

const envelopeFactIndexes = new WeakMap();

function orderedUniqueFacts(index, groups) {
  const seen = new Set();
  const facts = [];
  for (const group of groups) {
    for (const fact of group ?? []) {
      if (seen.has(fact)) continue;
      seen.add(fact);
      facts.push(fact);
    }
  }
  return facts.sort((left, right) => index.position.get(left) - index.position.get(right));
}

function lowerBound(values, target) {
  let low = 0; let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function pathCandidates(index, value) {
  const groups = [index.filesByPath.get(value) ?? []];
  const prefix = `${value}/`;
  for (let cursor = lowerBound(index.sortedFilePaths, prefix);
    cursor < index.sortedFilePaths.length && index.sortedFilePaths[cursor].startsWith(prefix);
    cursor += 1) {
    groups.push(index.filesByPath.get(index.sortedFilePaths[cursor]) ?? []);
  }
  return orderedUniqueFacts(index, groups);
}

function indexedQueryCandidates(index, predicate, value) {
  if (predicate === 'symbol') return index.byKind.get('symbol') ?? [];
  if (predicate === 'symbol-id') return index.symbolsById.get(value) ?? [];
  if (predicate === 'import') return index.byKind.get('import') ?? [];
  if (predicate === 'references' || predicate === 'hierarchy') {
    return orderedUniqueFacts(index, [
      index.relationshipsBySourceId.get(value), index.factsByTarget.get(value)
    ]);
  }
  if (predicate === 'module') return index.byKind.get('module') ?? [];
  if (predicate === 'language') return index.filesByLanguage.get(value) ?? [];
  if (predicate === 'path') return pathCandidates(index, value);
  return [];
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

/**
 * Deterministic structural-first selection, applied before pagination.
 *
 * The bounded context injects only the first page, and canonical fact order put the file
 * inventory ahead of everything else — measured on a real repository, all 50 injected facts were
 * `builtin-text` file entries while the 12 genuinely structural facts (symbols, imports,
 * relationships, module) never reached a prompt. The page models actually see carried the least
 * informative kind.
 *
 * Rank: semantic facts, then syntax-stage structural facts, then text structural facts, and file
 * inventory last — files only fill whatever space structure leaves. The sort is stable (rank,
 * original index), so ordering and page hashes stay deterministic, and the selection is bound into
 * the read cursor so continuation pages replay the identical order. Raising the fact cap instead
 * was rejected deliberately: more facts is more tokens with no guarantee the useful ones arrive.
 */
export { factSelectionRank, orderFactsStructuralFirst } from './ast-fact-order.mjs';

function factPriority(options) {
  const value = optionString(options, 'priority');
  if (value == null) return null;
  if (!FACT_PRIORITIES.includes(value)) {
    throw new SingularityFlowError(`AST fact priority must be one of: ${FACT_PRIORITIES.join(', ')}.`, {
      code: 'AST_REQUEST_INVALID'
    });
  }
  return value;
}

function applyFactPriority(envelope, priority) {
  if (priority && envelope.status !== 'disabled') {
    envelope.facts = applySelectionPriority(envelope.facts, priority);
  }
  return envelope;
}

function selectorForCursor(options) {
  return {
    all: optionBoolean(options, 'all'),
    paths: explicitPaths(options),
    ...(factPriority(options) ? { priority: factPriority(options) } : {})
  };
}

function cursorOptions(payload) {
  return {
    ...(payload.selector.all ? { all: true } : {}),
    // The bound selection replays on every page, or a continuation would reshuffle the order the
    // first page was cut from.
    ...(payload.selector.priority ? { priority: payload.selector.priority } : {}),
    ...(payload.selector.paths.length ? { paths: payload.selector.paths } : {}),
    'max-files': payload.inputBudgets.maxFiles,
    'max-bytes': payload.inputBudgets.maxBytes,
    'max-file-bytes': payload.inputBudgets.maxFileBytes
  };
}

function filterQueryEnvelope(envelope, predicate, value) {
  if (envelope.status !== 'disabled') {
    const index = envelopeFactIndexes.get(envelope) ?? buildFactIndex(envelope.facts);
    const candidates = indexedQueryCandidates(index, predicate, value);
    const examined = candidates.length;
    envelope.facts = candidates.filter((fact) => matchQuery(fact, predicate, value));
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
  inputBudgets: suppliedInputBudgets = null, selector: suppliedSelector = null,
  workBinding = null
} = {}) {
  const runtime = await loadRuntime(root, workBinding);
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
        coneSha256: envelope.scope.coneSha256 ?? envelope.scope.worktreeFingerprint,
        ...(envelope.scope.workBinding ? { workBinding: structuredClone(envelope.scope.workBinding) } : {})
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
    captureReturnedPage(envelope);
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
    || current.coneSha256 !== payload.binding.coneSha256
    || recordSha256(envelope.scope.workBinding ?? null) !== recordSha256(payload.binding.workBinding ?? null)) {
    throw new SingularityFlowError(
      'AST read cursor is stale because policy, revision, scope, or relevant file bytes changed.',
      { code: 'AST_READ_CURSOR_STALE' }
    );
  }
}

export async function astContext(root, options = {}, workBinding = null) {
  const handle = optionString(options, 'cursor');
  if (handle) {
    const payload = readCursorPayload(root, handle, 'context');
    const boundWork = payload.binding.workBinding ?? null;
    if (workBinding && recordSha256(workBinding) !== recordSha256(boundWork)) {
      throw new SingularityFlowError('AST read cursor belongs to different governed work.', { code: 'AST_READ_CURSOR_STALE' });
    }
    const envelope = applyFactPriority(
      await buildOrContext(root, cursorOptions(payload), 'context', boundWork),
      payload.selector.priority ?? null
    );
    if (envelope.status === 'disabled') {
      return boundedReadPage(root, envelope, {
        operation: 'context', options: cursorOptions(payload), offset: 0,
        limits: payload.outputLimits, inputBudgets: payload.inputBudgets,
        selector: payload.selector, workBinding: boundWork
      });
    }
    assertCursorBinding(envelope, payload);
    return boundedReadPage(root, envelope, {
      operation: 'context', options: cursorOptions(payload), offset: payload.nextOffset,
      limits: payload.outputLimits, inputBudgets: payload.inputBudgets, selector: payload.selector,
      workBinding: boundWork
    });
  }
  const envelope = applyFactPriority(await buildOrContext(root, options, 'context', workBinding), factPriority(options));
  return boundedReadPage(root, envelope, { operation: 'context', options, workBinding });
}

export async function astQuery(root, options = {}) {
  const handle = optionString(options, 'cursor');
  if (handle) {
    const payload = readCursorPayload(root, handle, 'query');
    if (!payload.query || !['symbol', 'symbol-id', 'import', 'references', 'hierarchy', 'module', 'language', 'path'].includes(payload.query.predicate)
      || typeof payload.query.value !== 'string' || !payload.query.value) {
      throw new SingularityFlowError('AST query cursor does not contain a valid bound query.', { code: 'AST_READ_CURSOR_INVALID' });
    }
    const envelope = filterQueryEnvelope(
      await buildOrContext(root, cursorOptions(payload), 'query'),
      payload.query.predicate,
      payload.query.value
    );
    if (envelope.status === 'disabled') {
      return boundedReadPage(root, envelope, {
        operation: 'query', options: cursorOptions(payload), query: payload.query, offset: 0,
        limits: payload.outputLimits, inputBudgets: payload.inputBudgets, selector: payload.selector
      });
    }
    assertCursorBinding(envelope, payload);
    return boundedReadPage(root, envelope, {
      operation: 'query', options: cursorOptions(payload), query: payload.query,
      offset: payload.nextOffset, limits: payload.outputLimits,
      inputBudgets: payload.inputBudgets, selector: payload.selector
    });
  }
  const predicate = optionString(options, 'predicate');
  const value = optionString(options, 'value', '');
  if (!['symbol', 'symbol-id', 'import', 'references', 'hierarchy', 'module', 'language', 'path'].includes(predicate) || !value) {
    throw new SingularityFlowError('wm ast query requires --predicate symbol|symbol-id|import|references|hierarchy|module|language|path and --value VALUE.');
  }
  const envelope = filterQueryEnvelope(await buildOrContext(root, options, 'query'), predicate, value);
  return boundedReadPage(root, envelope, { operation: 'query', options, query: { predicate, value } });
}

export async function evaluateAstGate(root, options = {}) {
  const runtime = await loadRuntime(root);
  const gateOptions = { ...options, 'evidence-class': optionString(options, 'evidence-class', 'gate') };
  const envelope = await buildOrContext(root, gateOptions, 'gate');
  const results = [];
  for (const predicate of runtime.policy.predicates) {
    const configuredAssurance = predicate.minimumAssurance ?? 'text';
    // A lexical symbol match is discovery help, never proof that a declaration exists. The built-in
    // extractor intentionally does not parse comments or conditional syntax, so required symbol
    // predicates must be established by at least a syntax adapter even when an older policy says
    // `text`. Advisory predicates retain the useful, explicitly low-assurance lexical result.
    const minimumByType = {
      'symbol-exists': 'syntax', 'import-boundary': 'syntax', 'annotation-present': 'syntax',
      'inherits-from': 'syntax', 'conforms-to': 'semantic', 'override-exists': 'semantic',
      'public-signature-changed': 'syntax', 'module-dependency': 'semantic'
    };
    const floor = minimumByType[predicate.type] ?? 'text';
    const requiredAssurance = assuranceSatisfies(configuredAssurance, floor) ? configuredAssurance : floor;
    const isRichPredicate = !['path-exists', 'symbol-exists'].includes(predicate.type);
    const languageFacts = envelope.facts.filter((fact) => fact.kind === 'file');
    const selectedLanguages = new Set(languageFacts.map((fact) => fact.language));
    const profiles = new Set(envelope.facts.flatMap((fact) => [fact.extractor, ...(fact.extractors ?? [])])
      .map((extractor) => extractor?.derivation?.profile).filter(Boolean));
    const languageApplicable = !isRichPredicate || predicate.languages.includes('*')
      || predicate.languages.some((language) => selectedLanguages.has(language));
    const profileApplicable = !isRichPredicate || predicate.profiles.includes('*')
      || predicate.profiles.some((profile) => profiles.has(profile));
    const symbolMatches = (fact, value) => fact.kind === 'symbol'
      && [fact.id, fact.name, fact.qualifiedName].includes(value);
    const v2Eligible = (fact) => !isRichPredicate || ![fact.extractor, ...(fact.extractors ?? [])]
      .some((extractor) => extractor?.legacyProtocol === 1);
    const targetMatches = (actual, expected) => actual === expected
      || String(actual).endsWith(`.${expected}`) || String(actual).startsWith(`${expected}.`);
    const symbols = envelope.facts.filter((fact) => symbolMatches(fact, predicate.symbol));
    const symbolIds = new Set(symbols.flatMap((fact) => [fact.id, fact.name, fact.qualifiedName]).filter(Boolean));
    let matching = [];
    let negativeConstraint = false;
    let observedSha256 = null;
    if (predicate.type === 'path-exists') matching = envelope.facts.filter((fact) => fact.kind === 'file' && fact.path === predicate.path);
    else if (predicate.type === 'symbol-exists') matching = symbols;
    else if (predicate.type === 'annotation-present') matching = symbols.filter((fact) => fact.annotations?.includes(predicate.annotation));
    else if (predicate.type === 'inherits-from') matching = envelope.facts.filter((fact) => fact.kind === 'relationship'
      && fact.type === 'extends' && symbolIds.has(fact.sourceId) && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'conforms-to') matching = envelope.facts.filter((fact) => fact.kind === 'relationship'
      && ['implements', 'conforms-to'].includes(fact.type) && symbolIds.has(fact.sourceId) && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'override-exists') matching = envelope.facts.filter((fact) => fact.kind === 'relationship'
      && fact.type === 'overrides' && symbolIds.has(fact.sourceId) && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'module-dependency') matching = envelope.facts.filter((fact) => fact.kind === 'relationship'
      && fact.type === 'imports' && fact.sourceId === predicate.module && targetMatches(fact.target, predicate.target));
    else if (predicate.type === 'import-boundary') {
      negativeConstraint = true;
      matching = envelope.facts.filter((fact) => fact.kind === 'import'
        && String(fact.from ?? fact.path ?? '').startsWith(predicate.path)
        && targetMatches(fact.target, predicate.target));
    } else if (predicate.type === 'public-signature-changed') {
      const publicSymbols = envelope.facts.filter((fact) => fact.kind === 'symbol'
        && String(fact.path ?? '').startsWith(predicate.path)
        && (['public', 'open'].includes(fact.visibility)
          || (fact.extractor?.derivation?.language === 'python' && !fact.name.startsWith('_'))));
      observedSha256 = recordSha256(publicSymbols.map((fact) => ({
        id: fact.id, qualifiedName: fact.qualifiedName, signature: fact.signature, path: fact.path
      })).sort((left, right) => `${left.path}\0${left.id}`.localeCompare(`${right.path}\0${right.id}`)));
      matching = observedSha256 !== predicate.expectedSha256 ? publicSymbols : [];
    }
    matching = matching.filter(v2Eligible);
    let outcome = 'unknown';
    const adequate = matching.some((fact) => assuranceSatisfies(fact.assurance ?? 'text', requiredAssurance));
    if (!languageApplicable || !profileApplicable) outcome = 'unknown';
    else if (negativeConstraint && assuranceSatisfies(envelope.assurance, requiredAssurance)) outcome = matching.length ? 'fail' : 'pass';
    else if (predicate.type === 'public-signature-changed' && assuranceSatisfies(envelope.assurance, requiredAssurance)) {
      outcome = observedSha256 !== predicate.expectedSha256 ? 'pass' : 'fail';
    } else if (adequate) outcome = 'pass';
    else if (!matching.length && assuranceSatisfies(envelope.assurance, requiredAssurance)) outcome = 'fail';
    const extractors = uniqueExtractors((matching.length ? matching : envelope.facts).flatMap((fact) => [
      fact.extractor, ...(fact.extractors ?? [])
    ]));
    const { id: _id, mode: _mode, minimumAssurance: _minimum, ...inputs } = predicate;
    results.push({
      id: predicate.id, mode: predicate.mode, requiredAssurance, outcome,
      applicable: languageApplicable && profileApplicable,
      inputs,
      ...(observedSha256 ? { observedSha256 } : {}),
      extractors
    });
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
  if (envelope.provenance.evidence) {
    envelope.provenance.evidence.outputs.predicateResultsSha256 = recordSha256(results);
  }
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
    clearFactIndexes(root);
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
  for (const directory of ['blobs', 'syntax', 'semantic']) {
    const cacheDirectory = path.join(storeRoot(root), directory);
    for (const entry of await readdir(cacheDirectory, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const target = path.join(cacheDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
      if (entry.isFile() && entry.name.endsWith('.json') && !reachable.has(entry.name.slice(0, -5))) targets.push(target);
    }
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
  const artifactHealth = new Map();
  for (const adapter of adapterDiscovery.adapters) artifactHealth.set(adapter.id, await inspectAstAdapterArtifacts(adapter));
  const healthyAdapters = adapterDiscovery.adapters.filter((adapter) => artifactHealth.get(adapter.id)?.healthy);
  runtime.adapterDiscovery = {
    adapters: healthyAdapters,
    diagnostics: [
      ...adapterDiscovery.diagnostics,
      ...[...artifactHealth.values()].flatMap((health) => health.diagnostics)
    ]
  };
  runtime.languageCatalog = compileAstLanguageCatalog(healthyAdapters);
  const assuranceAvailable = new Set(['text']);
  for (const adapter of healthyAdapters) {
    assuranceAvailable.add(adapter.assurance);
  }
  const activePhase = runtime.state?.currentPhase
    ? runtime.state.phases?.[runtime.state.currentPhase] ?? null
    : null;
  const latestGate = activePhase?.astGates?.findLast?.((entry) => entry.generation === activePhase.generation)
    ?? [...(activePhase?.astGates ?? [])].sort((left, right) => right.generation - left.generation)[0]
    ?? null;
  const requiredPredicateCount = runtime.policy.predicates.filter((entry) => entry.mode === 'required').length;
  const selection = effective.mode === 'off' ? { candidates: [] } : await enumerateScope(root, runtime, {});
  const repositoryUnsupported = effective.mode === 'off' ? [] : [...new Map([
    // Known programming extensions are diagnosed repository-wide for compatibility with the
    // existing doctor contract. Arbitrary unknown extensions fail closed only when the current
    // source cone selected them, avoiding false code claims about unrelated repository assets.
    ...unsupportedAstProgrammingPaths(
      trackedFiles(root).map((file) => file.path), runtime.languageCatalog
    ),
    ...unsupportedAstProgrammingPaths(
      selection.candidates.map((file) => file.path), runtime.languageCatalog, { classifyUnknown: true }
    )
  ].map((entry) => [entry.path, entry])).values()].sort((left, right) => left.path.localeCompare(right.path));
  const projects = effective.mode === 'off'
    ? { mode: 'existing-only', bindings: [], diagnostics: [], digest: null }
    : await discoverProjectBindings(root, { paths: runtime.sourceScope.paths });
  const byLanguage = new Map();
  for (const file of selection.candidates) byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + 1);
  const languages = [...new Set([...byLanguage.keys(), ...Object.keys(runtime.policy.languages)])].sort().map((language) => {
    const packs = healthyAdapters.filter((adapter) => adapter.languages.includes(language));
    const policy = runtime.policy.languages[language] ?? { mode: 'auto', minimumAssurance: 'text', syntaxProvider: null, semanticProvider: null };
    const selectedSyntax = providerFor({ language }, 'syntax', packs, policy, []);
    const selectedSemantic = providerFor({ language }, 'semantic', packs, policy, []);
    const project = projects.bindings.find((binding) => binding.root === '.' || selection.candidates.some((file) => file.language === language && file.path.startsWith(`${binding.root}/`))) ?? null;
    return {
      language, selectedFiles: byLanguage.get(language) ?? 0,
      availablePacks: packs.map((adapter) => ({ id: adapter.id, stage: adapter.stage, assurance: adapter.assurance, packVersion: adapter.packVersion })),
      maximumAssurance: selectedSemantic && project?.complete
        ? 'semantic'
        : selectedSyntax?.assurance ?? 'text',
      selectedProviders: { syntax: selectedSyntax?.id ?? null, semantic: selectedSemantic?.id ?? null },
      toolchainStatus: project?.toolchain ? 'bound' : selectedSemantic ? 'unavailable' : 'not-required',
      projectModelStatus: project ? (project.complete ? 'complete' : 'incomplete') : 'not-detected',
      degradationReason: policy.mode === 'off' ? 'language-disabled'
        : selectedSemantic && !project?.complete ? 'semantic-project-binding-incomplete'
          : selectedSyntax ? null : 'syntax-pack-unavailable'
    };
  });
  return {
    schemaVersion: 3, // schema-transient: live diagnostic result, never persisted
    healthy: true,
    available: effective.mode !== 'off',
    degraded: repositoryUnsupported.length > 0
      || adapterDiscovery.diagnostics.length > 0
      || [...artifactHealth.values()].some((health) => !health.healthy),
    configured: runtime.policy,
    effective,
    scope: runtime.sourceScope,
    cache,
    catalog: runtime.languageCatalog,
    languages,
    projects: {
      mode: projects.mode,
      bindingCount: projects.bindings.length,
      bindings: projects.bindings.map((binding) => ({
        projectKind: binding.projectKind, root: binding.root, modules: binding.modules,
        sourceSets: binding.sourceSets, profile: binding.profile, complete: binding.complete,
        unavailable: binding.unavailable, projectModelSha256: binding.projectModelSha256
      })),
      diagnostics: projects.diagnostics
    },
    adapters: adapterDiscovery.adapters.map(({ argv: _argv, implementation, ...adapter }) => ({
      ...adapter,
      implementation: { ...implementation, files: undefined },
      status: artifactHealth.get(adapter.id)?.healthy ? 'available-on-demand' : 'artifact-invalid'
    })),
    optionalPacks: OPTIONAL_AST_SEMANTIC_PACKS.map((pack) => ({
      ...pack,
      platformCompatible: pack.platforms.includes(process.platform),
      status: adapterDiscovery.adapters.some((adapter) => adapter.id === pack.id)
        ? 'installed'
        : pack.platforms.includes(process.platform) ? 'not-installed' : 'platform-incompatible'
    })),
    assuranceAvailable: [...assuranceAvailable].sort((left, right) => ['text', 'syntax', 'semantic'].indexOf(left) - ['text', 'syntax', 'semantic'].indexOf(right)),
    lifecycle: {
      enforced: false,
      optional: true,
      predicateCount: runtime.policy.predicates.length,
      requiredPredicateCount,
      workId: runtime.state?.workItem?.id ?? null,
      phase: activePhase?.id ?? null,
      generation: activePhase?.generation ?? null,
      latestGate
    },
    diagnostics: [
      ...(effective.mode === 'off' ? [{ code: 'AST_DISABLED', severity: 'info' }] : []),
      ...(repositoryUnsupported.length ? [{
        code: 'AST_LANGUAGE_UNSUPPORTED', severity: 'warn',
        message: `AST extraction will skip unsupported programming source; ordinary file-based work remains available: ${repositoryUnsupported.slice(0, 20).map((entry) => entry.path).join(', ')}`,
        paths: repositoryUnsupported.map((entry) => entry.path)
      }] : []),
      ...adapterDiscovery.diagnostics.map((item) => ({ ...item, severity: item.severity === 'info' ? 'info' : 'warn' })),
      ...[...artifactHealth.values()].flatMap((health) => health.diagnostics)
        .map((item) => ({ ...item, severity: item.severity === 'info' ? 'info' : 'warn' }))
    ]
  };
}

function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.operation && result.coverage) {
    console.log(`AST ${result.operation}: ${result.status} · ${result.assurance} assurance · ${result.coverage.processed}/${result.coverage.selected} files`);
    for (const diagnostic of result.diagnostics) console.log(`- ${diagnostic.code}: ${diagnostic.message ?? ''}`);
    if (result.nextCursor) {
      console.log(`Next page: singularity-flow wm ast ${result.operation} --cursor ${result.nextCursor}`);
    }
  } else console.log(JSON.stringify(result, null, 2));
}

const AST_PACK_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  extractedBytes: 128 * 1024 * 1024,
  expansionRatio: 100,
  members: 2_000
});

function tarString(bytes, start, length) {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8').trim();
}

function tarNumber(bytes, start, length, label) {
  const field = bytes.subarray(start, start + length);
  if (field[0] & 0x80) {
    throw new SingularityFlowError(`Offline AST pack archive uses an unsupported binary ${label}.`, { code: 'AST_PACK_ARCHIVE_INVALID' });
  }
  const value = tarString(bytes, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new SingularityFlowError(`Offline AST pack archive has an invalid ${label}.`, { code: 'AST_PACK_ARCHIVE_INVALID' });
  }
  return Number.parseInt(value, 8);
}

function verifiedTarHeader(bytes, offset) {
  const header = bytes.subarray(offset, offset + 512);
  const expected = tarNumber(header, 148, 8, 'header checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (actual !== expected) {
    throw new SingularityFlowError('Offline AST pack archive has an invalid header checksum.', { code: 'AST_PACK_ARCHIVE_INVALID' });
  }
  return header;
}

function paxFields(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new SingularityFlowError('Offline AST pack archive has invalid PAX metadata.', { code: 'AST_PACK_ARCHIVE_INVALID' });
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new SingularityFlowError('Offline AST pack archive has invalid PAX metadata.', { code: 'AST_PACK_ARCHIVE_INVALID' });
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 10) {
      throw new SingularityFlowError('Offline AST pack archive has invalid PAX metadata.', { code: 'AST_PACK_ARCHIVE_INVALID' });
    }
    const record = bytes.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1) throw new SingularityFlowError('Offline AST pack archive has invalid PAX metadata.', { code: 'AST_PACK_ARCHIVE_INVALID' });
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

function safeArchiveMember(value, { directory = false } = {}) {
  let member = String(value ?? '').replace(/\0.*$/s, '');
  if (member.includes('\\')) throw new SingularityFlowError('Offline AST pack archive member paths must use forward slashes.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
  while (member.startsWith('./')) member = member.slice(2);
  if (directory) member = member.replace(/\/+$/, '');
  if (directory && (!member || member === '.')) return null;
  if (!member || path.posix.isAbsolute(member) || /^[A-Za-z]:/.test(member)) {
    throw new SingularityFlowError('Offline AST pack archive contains an absolute or empty member path.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
  }
  const segments = member.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new SingularityFlowError('Offline AST pack archive contains a path traversal member.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
  }
  return segments.join('/');
}

function parseAstPackTar(bytes) {
  const members = [];
  const paths = new Set();
  let offset = 0; let headerCount = 0; let extractedBytes = 0;
  let pendingPax = {}; let globalPax = {}; let longName = null;
  while (offset + 512 <= bytes.length) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((value) => value === 0)) {
      if (!bytes.subarray(offset).every((value) => value === 0)) {
        throw new SingularityFlowError('Offline AST pack archive has data after its end marker.', { code: 'AST_PACK_ARCHIVE_INVALID' });
      }
      break;
    }
    const header = verifiedTarHeader(bytes, offset);
    headerCount += 1;
    if (headerCount > AST_PACK_ARCHIVE_LIMITS.members) {
      throw new SingularityFlowError('Offline AST pack archive contains excessive members or metadata records.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
    }
    const headerSize = tarNumber(header, 124, 12, 'member size');
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + headerSize;
    if (!Number.isSafeInteger(headerSize) || dataEnd > bytes.length) {
      throw new SingularityFlowError('Offline AST pack archive member exceeds the archive boundary.', { code: 'AST_PACK_ARCHIVE_INVALID' });
    }
    const payload = bytes.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(headerSize / 512) * 512;
    if (type === 'x' || type === 'g') {
      const parsed = paxFields(payload);
      if (parsed.linkpath != null) throw new SingularityFlowError('Offline AST pack archives must not contain link metadata.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
      if (type === 'g') globalPax = { ...globalPax, ...parsed };
      else pendingPax = parsed;
      continue;
    }
    if (type === 'L') {
      longName = payload.toString('utf8').replace(/\0.*$/s, '').replace(/\n$/, '');
      continue;
    }
    if (type === 'K' || ['1', '2', '3', '4', '6', '7'].includes(type)) {
      throw new SingularityFlowError('Offline AST pack archives may contain only directories and regular files; links and special files are prohibited.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
    }
    if (!['0', '5'].includes(type)) {
      throw new SingularityFlowError(`Offline AST pack archive contains unsupported member type '${type}'.`, { code: 'AST_PACK_ARCHIVE_UNSAFE' });
    }
    const metadata = { ...globalPax, ...pendingPax };
    pendingPax = {};
    const prefix = tarString(header, 345, 155);
    const headerName = [prefix, tarString(header, 0, 100)].filter(Boolean).join('/');
    const directory = type === '5';
    const memberPath = safeArchiveMember(metadata.path ?? longName ?? headerName, { directory });
    longName = null;
    const size = metadata.size == null ? headerSize : Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0 || size !== headerSize || (directory && size !== 0)) {
      throw new SingularityFlowError('Offline AST pack archive has inconsistent member size metadata.', { code: 'AST_PACK_ARCHIVE_INVALID' });
    }
    if (memberPath == null) continue;
    if (paths.has(memberPath)) {
      throw new SingularityFlowError('Offline AST pack archive contains duplicate members.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
    }
    paths.add(memberPath);
    extractedBytes += size;
    if (extractedBytes > AST_PACK_ARCHIVE_LIMITS.extractedBytes) {
      throw new SingularityFlowError('Offline AST pack archive exceeds the extracted-byte budget.', { code: 'AST_PACK_ARCHIVE_BUDGET' });
    }
    const mode = tarNumber(header, 100, 8, 'member mode');
    members.push({ path: memberPath, directory, bytes: directory ? null : Buffer.from(payload), mode: mode & 0o111 ? 0o700 : 0o600 });
  }
  if (!members.length) throw new SingularityFlowError('Offline AST pack archive is empty.', { code: 'AST_PACK_ARCHIVE_INVALID' });
  return { members, extractedBytes };
}

async function resolveAstPackInstallSource(source) {
  const absolute = path.resolve(source);
  if (!/\.(?:tar|tar\.gz|tgz)$/i.test(absolute)) return { manifest: absolute, label: absolute, cleanup: null };
  const compressed = /\.(?:tar\.gz|tgz)$/i.test(absolute);
  const sourceInfo = await lstat(absolute).catch(() => null);
  if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) {
    throw new SingularityFlowError('Offline AST pack archive must be a regular local file.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
  }
  if (sourceInfo.size < 1 || sourceInfo.size > AST_PACK_ARCHIVE_LIMITS.compressedBytes) {
    throw new SingularityFlowError('Offline AST pack archive exceeds the compressed-byte budget.', { code: 'AST_PACK_ARCHIVE_BUDGET' });
  }
  const archive = await readFile(absolute);
  let tarBytes;
  try {
    const decompressionCeiling = Math.min(
      AST_PACK_ARCHIVE_LIMITS.extractedBytes,
      archive.length * AST_PACK_ARCHIVE_LIMITS.expansionRatio
    );
    tarBytes = compressed
      ? gunzipSync(archive, { maxOutputLength: decompressionCeiling })
      : archive;
  } catch {
    throw new SingularityFlowError('Offline AST pack archive could not be decompressed within its byte budget.', { code: 'AST_PACK_ARCHIVE_BUDGET' });
  }
  if (tarBytes.length > AST_PACK_ARCHIVE_LIMITS.extractedBytes
    || (compressed && tarBytes.length / archive.length > AST_PACK_ARCHIVE_LIMITS.expansionRatio)) {
    throw new SingularityFlowError('Offline AST pack archive exceeds its extracted-byte or expansion-ratio budget.', { code: 'AST_PACK_ARCHIVE_BUDGET' });
  }
  const parsed = parseAstPackTar(tarBytes);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-pack-'));
  try {
    for (const member of parsed.members) {
      const target = path.join(temporary, member.path);
      if (member.directory) await mkdir(target, { recursive: true, mode: 0o700 });
      else {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, member.bytes, { flag: 'wx', mode: member.mode });
      }
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw new SingularityFlowError(`Offline AST pack archive extraction failed: ${error.message}`, { code: 'AST_PACK_ARCHIVE_INVALID' });
  }
  const manifests = parsed.members.filter((member) => !member.directory && path.posix.basename(member.path) === 'manifest.json')
    .map((member) => path.join(temporary, member.path));
  if (manifests.length !== 1) {
    await rm(temporary, { recursive: true, force: true });
    throw new SingularityFlowError('Offline AST pack archive must contain exactly one manifest.json.', { code: 'AST_PACK_ARCHIVE_INVALID' });
  }
  return {
    manifest: manifests[0], label: absolute,
    members: parsed.members.map((entry) => entry.path).sort(),
    archive: {
      compressedBytes: archive.length,
      extractedBytes: parsed.extractedBytes,
      expansionRatio: compressed ? Number((tarBytes.length / archive.length).toFixed(2)) : 1
    },
    cleanup: () => rm(temporary, { recursive: true, force: true })
  };
}

async function astPackCommand(positionals, options) {
  const action = positionals[1] ?? 'list';
  const discovery = await discoverAstAdapters();
  const registry = await readAstPackRegistry();
  if (action === 'list') {
    const installedIds = new Set(discovery.adapters.map((adapter) => adapter.id));
    return {
      schemaVersion: 1, action: 'list', root: registry.root,
      packs: [...discovery.adapters.map((adapter) => ({
        id: adapter.id, packVersion: adapter.packVersion, stage: adapter.stage,
        languages: adapter.languages, assurance: adapter.assurance,
        source: adapter.id === 'sflow-polyglot-syntax' ? 'bundled'
          : registry.entries.some((entry) => entry.id === adapter.id) ? 'installed' : 'development-override'
      })), ...OPTIONAL_AST_SEMANTIC_PACKS.filter((pack) => !installedIds.has(pack.id)).map((pack) => ({
        ...pack, assurance: 'semantic', packVersion: null, source: 'optional-catalog', status: 'not-installed'
      }))],
      diagnostics: discovery.diagnostics
    };
  }
  if (action === 'status' || action === 'doctor') {
    const id = positionals[2] ?? null;
    if (action === 'doctor' && !id) return inspectAstPackRegistry(process.env, { repair: optionBoolean(options, 'repair') });
    const packs = [];
    for (const candidate of discovery.adapters.filter((adapter) => !id || adapter.id === id)) {
      const { argv: _argv, implementation, ...adapter } = candidate;
      const health = await inspectAstAdapterArtifacts(candidate);
      packs.push({
        ...adapter,
        implementation: {
          artifactSha256: implementation.artifactSha256,
          manifestSha256: implementation.manifestSha256,
          runtime: implementation.runtime,
          grammars: implementation.grammars,
          dependencies: implementation.dependencies
        },
        healthy: health.healthy,
        diagnostics: health.diagnostics
      });
    }
    if (id && !packs.length) {
      const optional = optionalSemanticPack(id);
      if (optional) return {
        schemaVersion: 1, action, healthy: false,
        packs: [{
          ...optional, assurance: 'semantic', status: 'not-installed', healthy: false,
          diagnostics: [{ code: 'AST_PACK_NOT_INSTALLED', message: `Optional semantic pack '${id}' is not installed.` }]
        }],
        diagnostics: [{ code: 'AST_PACK_NOT_INSTALLED', message: `Install a reviewed offline '${id}' pack, then run pack doctor again.` }]
      };
      throw new SingularityFlowError(`AST pack '${id}' is unavailable.`, { code: 'AST_PACK_NOT_AVAILABLE' });
    }
    return {
      schemaVersion: 1, action,
      healthy: discovery.diagnostics.length === 0 && packs.every((pack) => pack.healthy),
      packs,
      diagnostics: [...discovery.diagnostics, ...packs.flatMap((pack) => pack.diagnostics)]
    };
  }
  if (action === 'install') {
    const source = positionals[2] ?? optionString(options, 'archive');
    if (!source) throw new SingularityFlowError('Usage: singularity-flow wm ast pack install <LOCAL-MANIFEST> --dry-run');
    const resolved = await resolveAstPackInstallSource(source);
    try {
      const raw = JSON.parse(await readFile(resolved.manifest, 'utf8'));
      const archiveDigest = resolved.members ? raw?.implementation?.manifestSha256 : null;
      if (resolved.members) {
        if (archiveDigest !== astAdapterManifestSha256(raw)) {
          throw new SingularityFlowError('Offline AST pack manifest digest is invalid.', { code: 'AST_PACK_ARCHIVE_INVALID' });
        }
        const sourceRoot = path.dirname(resolved.manifest);
        const mapped = new Map();
        raw.implementation.files = (raw.implementation.files ?? []).map((file) => {
          if (path.isAbsolute(file.path) || file.path.replaceAll('\\', '/').split('/').includes('..')) {
            throw new SingularityFlowError('Offline AST pack manifest artifact paths must be relative and contained.', { code: 'AST_PACK_ARCHIVE_UNSAFE' });
          }
          const absoluteArtifact = path.resolve(sourceRoot, file.path);
          mapped.set(file.path, absoluteArtifact);
          return { ...file, path: absoluteArtifact };
        });
        raw.argv = (raw.argv ?? []).map((item) => mapped.get(item) ?? item);
        raw.implementation.manifestSha256 = '';
        raw.implementation.manifestSha256 = astAdapterManifestSha256(raw);
      }
      const manifest = validateAstAdapterManifest(raw, `AST pack ${resolved.label}`);
      const plan = await planAstPackInstall(resolved.manifest, manifest);
      if (archiveDigest) {
        plan.targetRelative = path.posix.join('installed', `${manifest.id}-${manifest.packVersion}-${archiveDigest.slice(0, 12)}`);
        plan.target = path.join((await readAstPackRegistry()).root, plan.targetRelative);
        const rebound = await planAstPackInstall(resolved.manifest, { ...manifest, implementation: { ...manifest.implementation, manifestSha256: archiveDigest } });
        plan.confirmationToken = rebound.confirmationToken;
        plan.confirmation = rebound.confirmation;
      }
      const publicPlan = {
        ...plan, source: resolved.label, files: resolved.members ?? plan.files,
        ...(resolved.archive ? { archive: resolved.archive } : {})
      };
      if (optionBoolean(options, 'dry-run')) return { ...publicPlan, dryRun: true };
      return await applyAstPackInstall(plan, { confirm: optionString(options, 'confirm') });
    } finally { await resolved.cleanup?.(); }
  }
  if (action === 'remove') {
    const id = positionals[2];
    if (!id) throw new SingularityFlowError('Usage: singularity-flow wm ast pack remove <PACK> --dry-run');
    const plan = await planAstPackRemove(id);
    if (optionBoolean(options, 'dry-run')) return { ...plan, dryRun: true };
    return applyAstPackRemove(plan, { confirm: optionString(options, 'confirm') });
  }
  throw new SingularityFlowError('Usage: singularity-flow wm ast pack list|status|doctor|install|remove');
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
  else if (action === 'warm') {
    if (!optionBoolean(options, 'semantic')) throw new SingularityFlowError('Usage: singularity-flow wm ast warm --semantic --provider PACK --profile PROFILE --dry-run|--confirm PHRASE');
    result = await astSemanticWarmCommand(root, options);
  }
  else if (action === 'pack') result = await astPackCommand(positionals, options);
  else if (action === 'evidence') {
    const evidenceAction = positionals[1] ?? 'replay';
    if (!['replay', 'reproduce'].includes(evidenceAction)) throw new SingularityFlowError('Usage: singularity-flow wm ast evidence reproduce --receipt <PATH>');
    result = await replayAstEvidence(root, options);
  }
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
  } else throw new SingularityFlowError('Usage: singularity-flow wm ast doctor|status|build|context|query|gate|warm|pack|evidence reproduce|cache|preference');
  printResult(result, optionBoolean(options, 'json'));
  return result;
}

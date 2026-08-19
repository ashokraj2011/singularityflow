import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeAstPolicy, assuranceSatisfies } from './ast-policy.mjs';
import { discoverAstAdapters } from './ast-adapter-contract.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { gitCommonDir } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { extractImports, extractSymbols } from './repository-facts.mjs';
import { normalizeSourceRoots, withWorldModelSourceScope, worldModelSourceScope } from './source-scope.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';
import {
  optionBoolean, optionNumber, optionString, optionStrings, posix, run, SingularityFlowError,
  writeJson
} from './util.mjs';

export const AST_RESULT_SCHEMA_VERSION = currentSchemaVersion('ast-result');
const AST_PREFERENCE_SCHEMA_VERSION = currentSchemaVersion('ast-preference');
const AST_RESUME_JOB_SCHEMA_VERSION = currentSchemaVersion('ast-resume-job');
const STORE_DIR = 'singularity-flow/ast/v1';
const ASSURANCE = new Set(['text', 'syntax', 'semantic']);
const STATUSES = new Set(['complete', 'partial', 'disabled', 'unsupported', 'stale', 'failed']);
const OPERATIONS = new Set(['context', 'query', 'gate', 'build', 'transform']);

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
  const output = run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout;
  const tracked = splitNull(output).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) return [];
    const [mode, object, stage] = entry.slice(0, tab).split(' ');
    if (stage !== '0') return [];
    return [{ path: posix(entry.slice(tab + 1)), mode, object }];
  });
  const known = new Set(tracked.map((file) => file.path));
  const untracked = splitNull(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout)
    .map((relative) => ({ path: posix(relative), mode: 'untracked', object: null }))
    .filter((file) => !known.has(file.path));
  return [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path));
}

function changedPaths(root) {
  const tracked = splitNull(run('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root, allowFailure: true }).stdout);
  const untracked = splitNull(run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout);
  return new Set([...tracked, ...untracked].map(posix));
}

function explicitPaths(options) {
  const values = optionStrings(options, 'paths').flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  return normalizeSourceRoots(values, 'AST --paths');
}

function inPrefix(relative, prefix) {
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

async function census(root, runtime, options = {}) {
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
  if (options.__afterPath) selected = selected.filter((file) => file.path > options.__afterPath);

  const budgets = {
    maxFiles: optionNumber(options, 'max-files', runtime.policy.budgets.maxFiles),
    maxBytes: optionNumber(options, 'max-bytes', runtime.policy.budgets.maxBytes),
    maxFileBytes: optionNumber(options, 'max-file-bytes', runtime.policy.budgets.maxFileBytes)
  };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 1) throw new SingularityFlowError(`AST ${name} must be a positive integer.`);
  }
  const files = []; const skipped = []; let bytes = 0;
  for (const file of selected) {
    const absolute = path.join(root, file.path);
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isFile()) { skipped.push({ path: file.path, reason: info?.isSymbolicLink() ? 'symlink' : 'not-readable-file' }); continue; }
    const language = languageFor(file.path);
    const languagePolicy = runtime.policy.languages[language] ?? { mode: 'auto', minimumAssurance: 'text' };
    if (languagePolicy.mode === 'off') { skipped.push({ path: file.path, reason: 'language-disabled', language }); continue; }
    if (!assuranceSatisfies('text', languagePolicy.minimumAssurance)) {
      skipped.push({ path: file.path, reason: 'assurance-unavailable', language, required: languagePolicy.minimumAssurance });
      continue;
    }
    if (info.size > budgets.maxFileBytes) { skipped.push({ path: file.path, reason: 'file-budget', bytes: info.size }); continue; }
    if (files.length >= budgets.maxFiles || bytes + info.size > budgets.maxBytes) { skipped.push({ path: file.path, reason: 'operation-budget', bytes: info.size }); continue; }
    files.push({ ...file, size: info.size, language });
    bytes += info.size;
  }
  return {
    scope: { kind: scopeKind, paths: requested.length ? requested : roots, definitionSha256: runtime.definitionSha256 },
    files, skipped, selectedCount: selected.length, bytes,
    complete: skipped.every((item) => item.reason !== 'operation-budget'), budgets
  };
}

function resumeJobPath(root, id) {
  return path.join(storeRoot(root), 'jobs', `${id}.json`);
}

async function createResumeJob(root, envelope, options, selected) {
  const cursor = selected.files.at(-1)?.path;
  if (!cursor || !selected.skipped.some((item) => item.reason === 'operation-budget')) return null;
  const id = randomUUID();
  const secret = randomBytes(24).toString('base64url');
  await writeJson(resumeJobPath(root, id), {
    schemaVersion: AST_RESUME_JOB_SCHEMA_VERSION,
    id,
    secretSha256: sha256(secret),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    binding: {
      definitionSha256: envelope.scope.definitionSha256,
      repositoryRevision: envelope.scope.repositoryRevision,
      worktreeFingerprint: envelope.scope.worktreeFingerprint
    },
    selector: { all: optionBoolean(options, 'all'), paths: explicitPaths(options) },
    cursor
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
  const runtime = await loadRuntime(root);
  const fingerprint = worktreeFingerprint(root).sha256;
  if (job.binding.definitionSha256 !== runtime.definitionSha256
    || job.binding.repositoryRevision !== repositoryRevision(root)
    || job.binding.worktreeFingerprint !== fingerprint) {
    throw new SingularityFlowError('AST resume handle is stale because configuration, revision, or worktree bytes changed.', { code: 'AST_RESUME_STALE' });
  }
  return { job, file: resumeJobPath(root, id) };
}

function baseEnvelope(root, runtime, operation, scope, mode) {
  const fingerprint = worktreeFingerprint(root);
  return {
    schemaVersion: AST_RESULT_SCHEMA_VERSION,
    operation,
    scope: { ...scope, repositoryRevision: repositoryRevision(root), worktreeFingerprint: fingerprint.sha256 },
    assurance: 'text',
    status: mode.mode === 'off' ? 'disabled' : 'complete',
    coverage: { selected: 0, processed: 0, skipped: 0, bytes: 0, byLanguage: {} },
    facts: [], diagnostics: [], degradation: [], resumeHandle: null,
    provenance: {
      engine: 'singularity-flow-ast-broker', engineVersion: 1,
      adapters: [], effectiveMode: mode.mode, modeSources: mode.sources
    }
  };
}

export function validateAstResultEnvelope(value) {
  const record = readRecord('ast-result', value).record;
  if (!OPERATIONS.has(record.operation)) throw new SingularityFlowError('Invalid AST result envelope operation.');
  if (!ASSURANCE.has(record.assurance) || !STATUSES.has(record.status)) throw new SingularityFlowError('Invalid AST result envelope assurance or status.');
  if (!record.scope?.definitionSha256 || !Object.hasOwn(record.scope, 'worktreeFingerprint')) throw new SingularityFlowError('AST result envelope is missing its scope binding.');
  if (!Array.isArray(record.facts) || !Array.isArray(record.diagnostics) || !Array.isArray(record.degradation)) throw new SingularityFlowError('AST result envelope collections are invalid.');
  return structuredClone(record);
}

async function deriveTextFacts(root, files) {
  const facts = [];
  for (const file of files) {
    const bytes = await readFile(path.join(root, file.path));
    const digest = sha256(bytes);
    const item = { kind: 'file', path: file.path, language: file.language, bytes: file.size, sha256: digest };
    facts.push(item);
    if (!TEXT_SYMBOL_LANGUAGES.has(file.language)) continue;
    const text = bytes.toString('utf8');
    for (const symbol of extractSymbols(text, file.path)) {
      facts.push({ kind: 'symbol', name: symbol.name, declarationKind: symbol.kind, at: symbol.at, assurance: 'text' });
    }
    for (const target of extractImports(text)) facts.push({ kind: 'import', from: file.path, target, assurance: 'text' });
  }
  return facts;
}

function coverage(censusResult, facts) {
  const byLanguage = {};
  for (const file of censusResult.files) byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;
  return {
    selected: censusResult.selectedCount,
    processed: censusResult.files.length,
    skipped: censusResult.skipped.length,
    bytes: censusResult.bytes,
    facts: facts.length,
    byLanguage
  };
}

async function writeSnapshot(root, runtime, envelope) {
  const target = path.join(storeRoot(root), 'snapshots', `${sha256(canonicalJson({ scope: envelope.scope, facts: envelope.facts }))}.json`);
  await writeJson(target, envelope);
  return target;
}

async function buildOrContext(root, options, operation) {
  const runtime = await loadRuntime(root);
  const mode = await effectiveAstMode(runtime.policy, optionString(options, 'mode', 'auto'));
  const selected = await census(root, runtime, options);
  const envelope = baseEnvelope(root, runtime, operation, selected.scope, mode);
  envelope.coverage.selected = selected.selectedCount;
  if (mode.mode === 'off') {
    envelope.diagnostics.push({ code: 'AST_DISABLED', message: 'Structural intelligence is disabled by the most restrictive effective preference.' });
    return validateAstResultEnvelope(envelope);
  }
  envelope.facts = await deriveTextFacts(root, selected.files);
  envelope.coverage = coverage(selected, envelope.facts);
  envelope.degradation = selected.skipped.slice(0, 100);
  if (selected.skipped.length > envelope.degradation.length) {
    envelope.diagnostics.push({
      code: 'AST_DEGRADATION_TRUNCATED',
      message: `${selected.skipped.length - envelope.degradation.length} additional skipped paths were omitted from this bounded result.`
    });
  }
  if (!selected.complete || selected.skipped.length) envelope.status = 'partial';
  if (operation === 'build') {
    envelope.resumeHandle = await createResumeJob(root, envelope, options, selected);
    const target = await writeSnapshot(root, runtime, envelope);
    envelope.provenance.snapshot = path.relative(gitCommonDir(root), target).replaceAll(path.sep, '/');
  }
  return validateAstResultEnvelope(envelope);
}

async function resumeBuild(root, handle, options) {
  const { job, file } = await readResumeJob(root, handle);
  const resumedOptions = {
    ...options,
    all: job.selector.all,
    paths: job.selector.paths,
    __afterPath: job.cursor
  };
  delete resumedOptions.resume;
  const result = await buildOrContext(root, resumedOptions, 'build');
  await rm(file, { force: true });
  result.provenance.resumedFrom = job.id;
  return result;
}

function matchQuery(fact, predicate, value) {
  if (predicate === 'symbol') return fact.kind === 'symbol' && String(fact.name).includes(value);
  if (predicate === 'import') return fact.kind === 'import' && String(fact.target).includes(value);
  if (predicate === 'language') return fact.kind === 'file' && fact.language === value;
  if (predicate === 'path') return fact.kind === 'file' && inPrefix(fact.path, value);
  return false;
}

async function query(root, options) {
  const predicate = optionString(options, 'predicate');
  const value = optionString(options, 'value', '');
  if (!['symbol', 'import', 'language', 'path'].includes(predicate) || !value) throw new SingularityFlowError('wm ast query requires --predicate symbol|import|language|path and --value VALUE.');
  const envelope = await buildOrContext(root, options, 'query');
  if (envelope.status !== 'disabled') envelope.facts = envelope.facts.filter((fact) => matchQuery(fact, predicate, value));
  envelope.provenance.query = { predicate, value };
  return envelope;
}

async function gate(root, options) {
  const runtime = await loadRuntime(root);
  const envelope = await buildOrContext(root, options, 'gate');
  const results = [];
  for (const predicate of runtime.policy.predicates) {
    const requiredAssurance = predicate.minimumAssurance ?? 'text';
    let outcome = 'unknown';
    if (assuranceSatisfies(envelope.assurance, requiredAssurance)) {
      if (predicate.type === 'path-exists') outcome = envelope.facts.some((fact) => fact.kind === 'file' && fact.path === predicate.path) ? 'pass' : 'fail';
      else if (predicate.type === 'symbol-exists') outcome = envelope.facts.some((fact) => fact.kind === 'symbol' && fact.name === predicate.symbol) ? 'pass' : 'fail';
    }
    results.push({ id: predicate.id, mode: predicate.mode, requiredAssurance, outcome });
  }
  envelope.facts = results;
  const blocking = results.filter((item) => item.mode === 'required' && item.outcome !== 'pass');
  if (blocking.length || envelope.status === 'partial') envelope.status = 'partial';
  envelope.provenance.gate = { allowed: blocking.length === 0 && envelope.status !== 'disabled', blocking: blocking.map((item) => item.id) };
  return envelope;
}

export async function astCacheStatus(root) {
  const directory = storeRoot(root);
  let files = 0; let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) { files += 1; bytes += (await stat(target)).size; }
    }
  }
  await walk(directory);
  return { schemaVersion: 1, root: directory, files, bytes, exists: files > 0 }; // schema-transient: live cache inventory, never persisted
}

async function clearCache(root, options) {
  const before = await astCacheStatus(root);
  const dryRun = optionBoolean(options, 'dry-run');
  const confirmation = optionString(options, 'confirm');
  if (!dryRun && confirmation !== 'CLEAR AST CACHE') throw new SingularityFlowError("AST cache clear requires --confirm 'CLEAR AST CACHE'. Use --dry-run to preview.");
  if (!dryRun) {
    const target = storeRoot(root);
    const info = await lstat(target).catch(() => null);
    if (info?.isSymbolicLink()) throw new SingularityFlowError('AST cache root must not be a symbolic link.');
    await rm(target, { recursive: true, force: true });
  }
  return { schemaVersion: 1, action: 'clear', dryRun, removed: dryRun ? 0 : before.files, bytes: before.bytes, root: before.root }; // schema-transient: command result, never persisted
}

async function pruneCache(root, options) {
  const dryRun = optionBoolean(options, 'dry-run');
  if (!dryRun && optionString(options, 'confirm') !== 'PRUNE AST CACHE') {
    throw new SingularityFlowError("AST cache prune requires --confirm 'PRUNE AST CACHE'. Use --dry-run to preview.");
  }
  const revision = repositoryRevision(root);
  const fingerprint = worktreeFingerprint(root).sha256;
  const targets = [];
  for (const [directory, family] of [['snapshots', 'ast-result'], ['jobs', 'ast-resume-job']]) {
    const parent = path.join(storeRoot(root), directory);
    for (const entry of await readdir(parent, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const target = path.join(parent, entry.name);
      if (entry.isSymbolicLink()) throw new SingularityFlowError(`AST cache contains a symbolic link and will not be traversed: ${target}`);
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const record = readRecord(family, await readFile(target)).record;
        const binding = family === 'ast-result' ? record.scope : record.binding;
        const expired = family === 'ast-resume-job' && Date.parse(record.expiresAt) <= Date.now();
        if (expired || binding?.repositoryRevision !== revision || binding?.worktreeFingerprint !== fingerprint) targets.push(target);
      } catch {
        targets.push(target);
      }
    }
  }
  if (!dryRun) for (const target of targets) await rm(target, { force: true });
  return {
    schemaVersion: 1, // schema-transient: command result, never persisted
    action: 'prune', dryRun, candidates: targets.length, removed: dryRun ? 0 : targets.length,
    targets: targets.map((target) => path.relative(storeRoot(root), target).replaceAll(path.sep, '/'))
  };
}

export async function astDoctor(root) {
  const runtime = await loadRuntime(root);
  const effective = await effectiveAstMode(runtime.policy);
  const cache = await astCacheStatus(root);
  const adapterDiscovery = await discoverAstAdapters();
  return {
    schemaVersion: 1, // schema-transient: live diagnostic result, never persisted
    healthy: adapterDiscovery.diagnostics.length === 0,
    configured: runtime.policy,
    effective,
    scope: runtime.sourceScope,
    cache,
    adapters: adapterDiscovery.adapters.map(({ argv: _argv, ...adapter }) => ({ ...adapter, status: 'discovered-not-active' })),
    assuranceAvailable: ['text'],
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
  else if (action === 'context') result = await buildOrContext(root, options, 'context');
  else if (action === 'query') result = await query(root, options);
  else if (action === 'gate') result = await gate(root, options);
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

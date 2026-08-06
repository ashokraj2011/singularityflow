import { createHash } from 'node:crypto';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  SingularityFlowError, exists, nowIso, posix, run, secureRepositoryPath, snapshot, writeJson
} from './util.mjs';

const CLAUSE_TYPES = new Set(['REQ', 'BEH', 'IFC', 'AC', 'CON']);
const VERDICTS = new Set(['matched', 'partial', 'missing', 'deviated', 'unplanned']);
const NAMESPACE = '[A-Z0-9][A-Z0-9._-]{0,63}';
const ANCHOR = new RegExp(`\\[(${NAMESPACE}):(REQ|BEH|IFC|AC|CON)-(\\d{3})\\]`, 'g');
const DEFAULT_LIMITS = Object.freeze({
  maxClausesPerArtifact: 2000,
  maxDependenciesPerClause: 100,
  maxPathsPerClaim: 1000,
  maxClaimBytes: 2 * 1024 * 1024
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function normalizeSpecPolicy(value = {}) {
  if (value == null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('spec must be an object.');
  }
  const allowed = new Set(['mode', 'namespace', 'coverage', 'acceptance', 'testCommands', 'excludes', 'limits', 'compositionCache']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`spec contains unknown field '${key}'.`);
  const mode = value.mode ?? 'off';
  if (!['off', 'record', 'enforce'].includes(mode)) throw new SingularityFlowError('spec.mode must be off, record, or enforce.');
  const namespace = value.namespace ?? null;
  if (namespace != null && !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(namespace)) {
    throw new SingularityFlowError('spec.namespace must use upper-case letters, digits, dots, underscores, or hyphens.');
  }
  const coverage = value.coverage ?? mode;
  if (!['off', 'record', 'enforce'].includes(coverage)) throw new SingularityFlowError('spec.coverage must be off, record, or enforce.');
  const acceptance = value.acceptance ?? 'off';
  if (!['off', 'presence', 'test-first', 'verify'].includes(acceptance)) {
    throw new SingularityFlowError('spec.acceptance must be off, presence, test-first, or verify.');
  }
  const testCommands = value.testCommands ?? {};
  if (!testCommands || typeof testCommands !== 'object' || Array.isArray(testCommands)) {
    throw new SingularityFlowError('spec.testCommands must be an object keyed by command ID.');
  }
  for (const [id, command] of Object.entries(testCommands)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new SingularityFlowError(`spec.testCommands key '${id}' must be lower-case kebab-case.`);
    if (!Array.isArray(command) || command.length < 1 || command.some((part) => typeof part !== 'string' || !part)) {
      throw new SingularityFlowError(`spec.testCommands.${id} must be a non-empty argv array.`);
    }
  }
  const configuredExcludes = value.excludes ?? [];
  if (!Array.isArray(configuredExcludes) || configuredExcludes.some((item) => typeof item !== 'string' || !item)) {
    throw new SingularityFlowError('spec.excludes must be an array of repository-relative path prefixes.');
  }
  const excludes = [...new Set(['singularity', '.git', 'node_modules', ...configuredExcludes])];
  const limits = { ...DEFAULT_LIMITS, ...(value.limits ?? {}) };
  for (const [key, maximum] of Object.entries({
    maxClausesPerArtifact: 10000,
    maxDependenciesPerClause: 1000,
    maxPathsPerClaim: 10000,
    maxClaimBytes: 10 * 1024 * 1024
  })) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) {
      throw new SingularityFlowError(`spec.limits.${key} must be an integer from 1 to ${maximum}.`);
    }
  }
  const compositionCache = value.compositionCache ?? 'local';
  if (!['off', 'local'].includes(compositionCache)) throw new SingularityFlowError('spec.compositionCache must be off or local.');
  return { mode, namespace, coverage, acceptance, testCommands, excludes, limits, compositionCache };
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

function ignoredRanges(markdown) {
  const ranges = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /~~~[\s\S]*?~~~/g,
    /`[^`\n]*`/g,
    /<!--\s*singularity-flow:inputs:start\s*-->[\s\S]*?<!--\s*singularity-flow:inputs:end\s*-->/g,
    /<!--\s*singularity-flow:metadata:start\s*-->[\s\S]*?<!--\s*singularity-flow:metadata:end\s*-->/g,
    /<!--\s*singularity-flow:[\s\S]*?-->/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(markdown))) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function isIgnored(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function dependencies(body) {
  const ids = new Set();
  const reference = new RegExp(`\\b(${NAMESPACE}:(?:REQ|BEH|IFC|AC|CON)-\\d{3})\\b`, 'g');
  let match;
  while ((match = reference.exec(body))) ids.add(match[1]);
  return [...ids].sort();
}

export function extractClauses(markdown, {
  sourcePath = null, namespace = null, limits = DEFAULT_LIMITS, externalClauseIds = []
} = {}) {
  if (typeof markdown !== 'string') throw new SingularityFlowError('Specification artifact must be UTF-8 Markdown.');
  const ignored = ignoredRanges(markdown);
  const matches = [];
  let match;
  ANCHOR.lastIndex = 0;
  while ((match = ANCHOR.exec(markdown))) {
    if (!isIgnored(match.index, ignored)) matches.push({ match, index: match.index, end: ANCHOR.lastIndex });
  }
  if (matches.length > limits.maxClausesPerArtifact) {
    throw new SingularityFlowError(`Specification contains ${matches.length} clauses; configured maximum is ${limits.maxClausesPerArtifact}.`);
  }
  const seen = new Map();
  const clauses = matches.map((entry, index) => {
    const [anchor, actualNamespace, type, number] = entry.match;
    const id = `${actualNamespace}:${type}-${number}`;
    if (namespace && namespace !== actualNamespace) {
      throw new SingularityFlowError(`Clause ${id} does not use configured namespace ${namespace}.`);
    }
    if (!CLAUSE_TYPES.has(type)) throw new SingularityFlowError(`Clause ${id} has unsupported type ${type}.`);
    if (seen.has(id)) throw new SingularityFlowError(`Clause ${id} is duplicated at lines ${seen.get(id)} and ${lineNumber(markdown, entry.index)}.`);
    const line = lineNumber(markdown, entry.index);
    seen.set(id, line);
    const end = matches[index + 1]?.index ?? markdown.length;
    const body = markdown.slice(entry.end, end).trim();
    const dependsOn = dependencies(body).filter((candidate) => candidate !== id);
    if (dependsOn.length > limits.maxDependenciesPerClause) {
      throw new SingularityFlowError(`Clause ${id} references more than ${limits.maxDependenciesPerClause} dependencies.`);
    }
    return {
      id,
      namespace: actualNamespace,
      type,
      number: Number(number),
      anchor,
      source: { path: sourcePath, line },
      body,
      bodySha256: sha256(body),
      dependsOn
    };
  });
  const ids = new Set([
    ...clauses.map((clause) => clause.id),
    ...externalClauseIds
  ]);
  for (const clause of clauses) {
    for (const dependency of clause.dependsOn) {
      if (!ids.has(dependency)) throw new SingularityFlowError(`Clause ${clause.id} references missing dependency ${dependency}.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) throw new SingularityFlowError(`Specification clause dependency cycle: ${[...trail, id].join(' -> ')}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    const clause = clauses.find((candidate) => candidate.id === id);
    for (const dependency of clause?.dependsOn ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  clauses.forEach((clause) => visit(clause.id));
  return clauses;
}

export async function buildSpecIndex(root, artifact, {
  workId, phase, generation = 0, outputPath = null, policy = {}, write = true,
  externalClauseIds = []
} = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const source = await secureRepositoryPath(root, artifact, {
    label: 'Specification artifact', mustExist: true, type: 'file'
  });
  const markdown = await readFile(source.absolute, 'utf8');
  const sourceSnapshot = await snapshot(source.absolute);
  const clauses = extractClauses(markdown, {
    sourcePath: source.relative,
    namespace: normalized.namespace,
    limits: normalized.limits,
    externalClauseIds
  });
  const indexWithoutHash = {
    schemaVersion: 1,
    workId: workId ?? null,
    phase: phase ?? null,
    generation: Number(generation ?? 0),
    source: { path: source.relative, sha256: sourceSnapshot.sha256, bytes: sourceSnapshot.size },
    clauses
  };
  const index = { ...indexWithoutHash, indexSha256: sha256(canonicalJson(indexWithoutHash)) };
  if (write && outputPath) await writeJson(path.join(root, outputPath), canonicalize(index));
  return index;
}

function normalizePaths(value, label, limits) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) throw new SingularityFlowError(`${label} must be an array of paths.`);
  if (value.length > limits.maxPathsPerClaim) throw new SingularityFlowError(`${label} exceeds ${limits.maxPathsPerClaim} paths.`);
  return [...new Set(value.map((item) => posix(item)))].sort();
}

export function normalizeClaimMap(value, { kind, clauseIds = [], policy = {} } = {}) {
  const normalized = normalizeSpecPolicy(policy);
  if (!['planned', 'observed'].includes(kind)) throw new SingularityFlowError('Claim map kind must be planned or observed.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${kind} claim map must be an object.`);
  const raw = value.claims ?? value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SingularityFlowError(`${kind} claim map claims must be an object keyed by clause ID.`);
  const known = new Set(clauseIds);
  const claims = {};
  for (const [id, claim] of Object.entries(raw)) {
    if (known.size && !known.has(id)) throw new SingularityFlowError(`${kind} claim map references unknown clause ${id}.`);
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new SingularityFlowError(`${kind} claim ${id} must be an object.`);
    if (kind === 'planned') {
      claims[id] = {
        expectedPaths: normalizePaths(claim.expectedPaths, `${id}.expectedPaths`, normalized.limits),
        tests: normalizePaths(claim.tests, `${id}.tests`, normalized.limits),
        deviation: claim.deviation == null ? null : String(claim.deviation)
      };
    } else {
      const verdict = claim.verdict ?? 'missing';
      if (!VERDICTS.has(verdict)) throw new SingularityFlowError(`${id}.verdict must be ${[...VERDICTS].join(', ')}.`);
      claims[id] = {
        observedPaths: normalizePaths(claim.observedPaths, `${id}.observedPaths`, normalized.limits),
        testResults: normalizePaths(claim.testResults, `${id}.testResults`, normalized.limits),
        commits: [...new Set(claim.commits ?? [])].sort(),
        verdict,
        deviation: claim.deviation == null ? null : String(claim.deviation)
      };
    }
  }
  const result = { schemaVersion: 1, kind, recordedAt: nowIso(), claims };
  const bytes = Buffer.byteLength(canonicalJson(result));
  if (bytes > normalized.limits.maxClaimBytes) throw new SingularityFlowError(`${kind} claim map exceeds ${normalized.limits.maxClaimBytes} bytes.`);
  return result;
}

export async function readStructuredFile(root, relative) {
  const file = await secureRepositoryPath(root, relative, { label: 'Structured specification file', mustExist: true, type: 'file' });
  const text = await readFile(file.absolute, 'utf8');
  return file.relative.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
}

async function jsonFiles(directory) {
  if (!(await exists(directory))) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await jsonFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.json')) output.push(absolute);
  }
  return output.sort();
}

export async function loadSpecRecords(itemDirectory) {
  const indexes = [];
  const planned = [];
  const observed = [];
  const acceptance = [];
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'spec-indexes'))) indexes.push(JSON.parse(await readFile(file, 'utf8')));
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'claims'))) {
    const value = JSON.parse(await readFile(file, 'utf8'));
    (value.kind === 'observed' ? observed : planned).push(value);
  }
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'acceptance'))) acceptance.push(JSON.parse(await readFile(file, 'utf8')));
  return { indexes, planned, observed, acceptance };
}

function pathExcluded(candidate, excludes) {
  return excludes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix.replace(/\/$/, '')}/`));
}

export function evaluateSpecCoverage({ indexes = [], planned = [], observed = [] }, changedPaths = [], policy = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = Object.assign({}, ...planned.map((map) => map.claims ?? {}));
  const observedClaims = Object.assign({}, ...observed.map((map) => map.claims ?? {}));
  const activePaths = [...new Set(changedPaths.map(posix))].filter((candidate) => !pathExcluded(candidate, normalized.excludes)).sort();
  const claimedPaths = new Set(Object.values(observedClaims).flatMap((claim) => claim.observedPaths ?? []));
  const unimplemented = [...clauses.keys()].filter((id) => !observedClaims[id] || ['missing', 'partial'].includes(observedClaims[id].verdict)).sort();
  const unclaimedChangedPaths = activePaths.filter((candidate) => !claimedPaths.has(candidate));
  const withdrawnButClaimed = Object.keys(observedClaims).filter((id) => !clauses.has(id)).sort();
  const result = {
    schemaVersion: 1,
    mode: normalized.coverage,
    totals: {
      clauses: clauses.size,
      planned: Object.keys(plannedClaims).length,
      observed: Object.keys(observedClaims).length,
      changedPaths: activePaths.length
    },
    unimplemented,
    unclaimedChangedPaths,
    withdrawnButClaimed,
    complete: !unimplemented.length && !unclaimedChangedPaths.length && !withdrawnButClaimed.length
  };
  result.severity = result.complete || normalized.coverage === 'off' ? 'pass' : normalized.coverage === 'enforce' ? 'error' : 'warning';
  return result;
}

export function evaluateSpecAcceptance({ indexes = [], planned = [], observed = [], acceptance = [] }, policy = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = Object.assign({}, ...planned.map((map) => map.claims ?? {}));
  const observedClaims = Object.assign({}, ...observed.map((map) => map.claims ?? {}));
  const latestRun = acceptance.at(-1) ?? null;
  const missingPlannedTests = normalized.acceptance === 'off'
    ? []
    : [...clauses.keys()].filter((id) => !(plannedClaims[id]?.tests ?? []).length).sort();
  const missingObservedTests = normalized.acceptance !== 'verify'
    ? []
    : [...clauses.keys()].filter((id) => !(observedClaims[id]?.testResults ?? []).length).sort();
  const failedCommands = normalized.acceptance !== 'verify' || !latestRun
    ? []
    : (latestRun.commands ?? []).filter((entry) => entry.status !== 'passed').map((entry) => entry.id);
  const missingRun = normalized.acceptance === 'verify' && !latestRun;
  const complete = normalized.acceptance === 'off'
    || (!missingPlannedTests.length && !missingObservedTests.length && !failedCommands.length && !missingRun);
  return {
    schemaVersion: 1,
    mode: normalized.acceptance,
    complete,
    missingPlannedTests,
    missingObservedTests,
    failedCommands,
    missingRun,
    latestRunAt: latestRun?.completedAt ?? null
  };
}

export async function runSpecAcceptance(root, policy = {}, {
  commandIds = [], workId = null, phase = null, generation = null, outputPath = null, write = true
} = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const configured = normalized.testCommands;
  const selected = commandIds.length ? [...new Set(commandIds)] : Object.keys(configured);
  for (const id of selected) if (!configured[id]) throw new SingularityFlowError(`Unknown allowlisted specification test command '${id}'.`);
  if (!selected.length) throw new SingularityFlowError('No spec.testCommands are configured. Add an allowlisted argv command before running acceptance.');
  const startedAt = nowIso();
  const commands = selected.map((id) => {
    const argv = configured[id];
    const result = run(argv[0], argv.slice(1), { cwd: root, allowFailure: true });
    return {
      id,
      argv,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      stdout: result.stdout.slice(-65536),
      stderr: result.stderr.slice(-65536)
    };
  });
  const record = {
    schemaVersion: 1,
    workId,
    phase,
    generation,
    sourceCommit: gitCommit(root),
    startedAt,
    completedAt: nowIso(),
    status: commands.every((entry) => entry.status === 'passed') ? 'passed' : 'failed',
    commands
  };
  record.recordSha256 = sha256(canonicalJson(record));
  if (write && outputPath) await writeJson(path.join(root, outputPath), canonicalize(record));
  return record;
}

function gitCommit(root) {
  const result = run('git', ['rev-parse', 'HEAD'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function changedRepositoryPaths(root, { base = null, target = 'HEAD' } = {}) {
  const args = base
    ? ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${base}...${target}`]
    : ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${target}^`, target];
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map(posix);
}

export function traceClause(records, clauseId = null) {
  const rows = [];
  for (const index of records.indexes ?? []) {
    for (const clause of index.clauses ?? []) {
      if (clauseId && clause.id !== clauseId) continue;
      const planned = [...(records.planned ?? [])].reverse().find((map) => map.claims?.[clause.id])?.claims?.[clause.id] ?? null;
      const observed = [...(records.observed ?? [])].reverse().find((map) => map.claims?.[clause.id])?.claims?.[clause.id] ?? null;
      rows.push({
        id: clause.id,
        type: clause.type,
        source: `${clause.source?.path ?? index.source?.path ?? 'unknown'}:${clause.source?.line ?? 0}`,
        bodySha256: clause.bodySha256,
        dependsOn: clause.dependsOn ?? [],
        planned,
        observed,
        verdict: observed?.verdict ?? 'missing'
      });
    }
  }
  if (clauseId && !rows.length) throw new SingularityFlowError(`Clause ${clauseId} was not found in the current specification indexes.`);
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function traceCsv(rows) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    ['clause', 'type', 'source', 'verdict', 'planned_paths', 'observed_paths'].map(quote).join(','),
    ...rows.map((row) => [row.id, row.type, row.source, row.verdict, (row.planned?.expectedPaths ?? []).join(';'), (row.observed?.observedPaths ?? []).join(';')].map(quote).join(','))
  ].join('\n');
}

export function selectClauseContext(indexes, clauseIds, { includeDependencies = true, fallback = 'whole' } = {}) {
  const all = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const requested = [...new Set(clauseIds ?? [])];
  if (!requested.length) return fallback === 'whole' ? [...all.values()] : [];
  const selected = new Map();
  const visit = (id) => {
    const clause = all.get(id);
    if (!clause) throw new SingularityFlowError(`Clause selector references unknown clause ${id}.`);
    if (selected.has(id)) return;
    selected.set(id, clause);
    if (includeDependencies) for (const dependency of clause.dependsOn ?? []) visit(dependency);
  };
  requested.forEach(visit);
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function renderClauseContext(clauses) {
  if (!clauses.length) return '';
  return ['# Selected specification clauses', '', ...clauses.flatMap((clause) => [
    `## ${clause.anchor}`,
    '',
    clause.body,
    '',
    `Source: \`${clause.source?.path ?? 'unknown'}:${clause.source?.line ?? 0}\`; SHA-256: \`${clause.bodySha256}\``
  ])].join('\n');
}

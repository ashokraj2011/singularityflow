import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import {
  SingularityFlowError, exists, nowIso, posix, run, secureRepositoryPath, snapshot, writeJson
} from './util.mjs';
import { authoredArtifactText } from './publication-preflight.mjs';

const CLAUSE_TYPES = new Set(['REQ', 'BEH', 'IFC', 'AC', 'CON']);
const VERDICTS = new Set(['matched', 'partial', 'missing', 'deviated', 'unplanned']);
// Work IDs may be mixed case. Clause identity is nevertheless canonical and
// case-insensitive: every parsed namespace is normalized to upper case. This
// keeps starter templates valid for IDs such as `work-1` without creating two
// different clauses for `Work-1:AC-001` and `WORK-1:AC-001`.
const NAMESPACE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const ANCHOR = new RegExp(`\\[(${NAMESPACE}):(REQ|BEH|IFC|AC|CON)-(\\d{3})\\]`, 'gi');
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

/**
 * Regions where an anchor-looking string is not an anchor: fenced and inline code, and the
 * kernel-managed blocks.
 *
 * Exported because `[SPK:REQ-063]` requires clarification-marker extraction to ignore exactly the
 * same regions as clause extraction. "Consistently with" is only true if it is the same function —
 * a second copy of this list would agree today and drift on the first change to either.
 */
export function ignoredRanges(markdown) {
  const ranges = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /~~~[\s\S]*?~~~/g,
    /`[^`\n]*`/g,
    // The kernel's paired blocks, whose *contents* sit between two comments rather than inside one,
    // so the generic rule below cannot reach them.
    /<!--\s*singularity-flow:inputs:start\s*-->[\s\S]*?<!--\s*singularity-flow:inputs:end\s*-->/g,
    /<!--\s*singularity-flow:metadata:start\s*-->[\s\S]*?<!--\s*singularity-flow:metadata:end\s*-->/g,
    /* Any HTML comment `[SPK:REQ-063]`.
     *
     * This used to name only `singularity-flow:` comments, which meant an author's own commentary
     * was live text: a clause anchor or a `[NEEDS CLARIFICATION: ...]` written inside `<!-- -->`
     * counted. The starter specification template found it — its explanatory comment shows the
     * marker grammar, so every first generation from the template would have been blocked under
     * `markers: block` by the template's own example.
     *
     * The general rule is the right one anyway. A comment is invisible in the rendered document,
     * and a requirement nobody can read is not a requirement.
     */
    /<!--[\s\S]*?-->/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(markdown))) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export function isIgnored(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function dependencies(body) {
  const ids = new Set();
  const reference = new RegExp(`\\b(${NAMESPACE}:(?:REQ|BEH|IFC|AC|CON)-\\d{3})\\b`, 'g');
  let match;
  while ((match = reference.exec(body))) ids.add(match[1].toUpperCase());
  return [...ids].sort();
}

export function extractClauses(markdown, {
  sourcePath = null, namespace = null, limits = DEFAULT_LIMITS, externalClauseIds = [], externalClauses = []
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
    const [anchor, rawNamespace, rawType, number] = entry.match;
    const actualNamespace = rawNamespace.toUpperCase();
    const type = rawType.toUpperCase();
    const id = `${actualNamespace}:${type}-${number}`;
    if (namespace && namespace !== actualNamespace) {
      throw new SingularityFlowError(`Clause ${id} does not use configured namespace ${namespace}.`);
    }
    if (!CLAUSE_TYPES.has(type)) throw new SingularityFlowError(`Clause ${id} has unsupported type ${type}.`);
    if (seen.has(id)) throw new SingularityFlowError(`Clause ${id} is duplicated at lines ${seen.get(id)} and ${lineNumber(markdown, entry.index)}.`);
    const line = lineNumber(markdown, entry.index);
    seen.set(id, line);
    const end = matches[index + 1]?.index ?? markdown.length;
    // Clause boundaries are found in the complete published artifact so line numbers and source
    // hashes remain exact. The clause body itself must contain only producer-authored bytes: a
    // trailing managed input envelope otherwise makes the last clause recursively contain every
    // preceding phase even though anchors inside that envelope were correctly ignored above.
    const body = authoredArtifactText(markdown.slice(entry.end, end)).trim();
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
  const external = externalClauses.map((clause) => ({
    ...clause,
    id: String(clause.id).toUpperCase(),
    dependsOn: (clause.dependsOn ?? []).map((id) => String(id).toUpperCase())
  }));
  const graphClauses = new Map([...external, ...clauses].map((clause) => [clause.id, clause]));
  const ids = new Set([...graphClauses.keys(), ...externalClauseIds.map((id) => String(id).toUpperCase())]);
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
    const clause = graphClauses.get(id);
    for (const dependency of clause?.dependsOn ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  graphClauses.forEach((clause) => visit(clause.id));
  return clauses;
}

export async function buildSpecIndex(root, artifact, {
  workId, phase, generation = 0, outputPath = null, policy = {}, write = true,
  externalClauseIds = [], externalClauses = []
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
    externalClauseIds,
    externalClauses
  });
  const indexWithoutHash = {
    schemaVersion: currentSchemaVersion('specification-index'),
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
  const paths = value.map((item) => posix(item));
  for (const candidate of paths) {
    if (path.posix.isAbsolute(candidate) || candidate === '..' || candidate.startsWith('../') || candidate.includes('/../')) {
      throw new SingularityFlowError(`${label} must contain repository-relative paths.`);
    }
  }
  return [...new Set(paths)].sort();
}

export function normalizeClaimMap(value, { kind, clauseIds = [], policy = {} } = {}) {
  const normalized = normalizeSpecPolicy(policy);
  if (!['planned', 'observed'].includes(kind)) throw new SingularityFlowError('Claim map kind must be planned or observed.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${kind} claim map must be an object.`);
  const raw = value.claims ?? value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SingularityFlowError(`${kind} claim map claims must be an object keyed by clause ID.`);
  const known = new Set(clauseIds.map((id) => String(id).toUpperCase()));
  const claims = {};
  for (const [rawId, claim] of Object.entries(raw)) {
    const id = rawId.toUpperCase();
    if (claims[id]) throw new SingularityFlowError(`${kind} claim map defines clause ${id} more than once using different letter casing.`);
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
      const observedPaths = normalizePaths(claim.observedPaths, `${id}.observedPaths`, normalized.limits);
      const testResults = normalizePaths(claim.testResults, `${id}.testResults`, normalized.limits);
      if (['matched', 'partial', 'deviated'].includes(verdict) && !observedPaths.length) {
        throw new SingularityFlowError(`${id}.observedPaths must identify source evidence when verdict is ${verdict}.`);
      }
      const rawCommits = claim.commits ?? [];
      if (!Array.isArray(rawCommits) || rawCommits.some((commit) => typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit))) {
        throw new SingularityFlowError(`${id}.commits must be an array of full Git commit SHAs.`);
      }
      claims[id] = {
        observedPaths,
        testResults,
        commits: [...new Set(rawCommits.map((commit) => commit.toLowerCase()))].sort(),
        verdict,
        deviation: claim.deviation == null ? null : String(claim.deviation)
      };
    }
  }
  const result = { schemaVersion: currentSchemaVersion('specification-claim-map'), kind, recordedAt: nowIso(), claims };
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
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'spec-indexes'))) indexes.push(readRecord('specification-index', await readFile(file)).record);
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'claims'))) {
    const value = readRecord('specification-claim-map', await readFile(file)).record;
    (value.kind === 'observed' ? observed : planned).push(value);
  }
  for (const file of await jsonFiles(path.join(itemDirectory, 'context', 'acceptance'))) acceptance.push(readRecord('specification-acceptance', await readFile(file)).record);
  return { indexes, planned, observed, acceptance };
}

function recordOrder(left, right) {
  const generation = Number(left?.generation ?? -1) - Number(right?.generation ?? -1);
  if (generation) return generation;
  const timestamp = String(left?.completedAt ?? left?.recordedAt ?? '').localeCompare(String(right?.completedAt ?? right?.recordedAt ?? ''));
  if (timestamp) return timestamp;
  return String(left?.phase ?? '').localeCompare(String(right?.phase ?? ''));
}

/**
 * Select only records that belong to the current generation of the current
 * Story. Historical files remain in Git for audit, but must never participate
 * in a live governance decision.
 */
export function selectActiveSpecRecords(records, workflow) {
  const workId = workflow?.workItem?.id ?? null;
  const active = (record) => {
    const phase = workflow?.phases?.[record?.phase];
    return Boolean(
      record
      && record.workId === workId
      && phase
      && Number(record.generation) === Number(phase.generation)
    );
  };
  return {
    indexes: (records.indexes ?? []).filter(active).sort(recordOrder),
    planned: (records.planned ?? []).filter(active).sort(recordOrder),
    observed: (records.observed ?? []).filter(active).sort(recordOrder),
    acceptance: (records.acceptance ?? []).filter(active).sort(recordOrder)
  };
}

export async function loadActiveSpecRecords(itemDirectory, workflow) {
  return selectActiveSpecRecords(await loadSpecRecords(itemDirectory), workflow);
}

export function predecessorSpecClauses(records, workflow, phaseId) {
  // Current records carry phaseOrder. Legacy/ad-hoc fixtures may only carry the pinned resolution
  // or phase map; they still need a deterministic, non-throwing continuity projection. When no
  // predecessor order can be proven, treating no phase as a predecessor is safer than importing a
  // current/later clause.
  const phaseOrder = Array.isArray(workflow?.phaseOrder)
    ? workflow.phaseOrder
    : Array.isArray(workflow?.resolution?.phases)
      ? workflow.resolution.phases.map((phase) => phase.id).filter(Boolean)
      : Object.keys(workflow?.phases ?? {});
  const position = phaseOrder.indexOf(phaseId);
  const allowed = new Set(position < 0 ? [] : phaseOrder.slice(0, position));
  return (records.indexes ?? [])
    .filter((index) => allowed.has(index.phase))
    .flatMap((index) => index.clauses ?? []);
}

function pathExcluded(candidate, excludes) {
  return excludes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix.replace(/\/$/, '')}/`));
}

export function evaluateSpecCoverage({ indexes = [], planned = [], observed = [] }, changedPaths = [], policy = {}, { root = null } = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = Object.assign({}, ...planned.map((map) => map.claims ?? {}));
  const observedClaims = Object.assign({}, ...observed.map((map) => map.claims ?? {}));
  const activePaths = [...new Set(changedPaths.map(posix))].filter((candidate) => !pathExcluded(candidate, normalized.excludes)).sort();
  const claimedPaths = new Set(Object.values(observedClaims).flatMap((claim) => claim.observedPaths ?? []));
  const unimplemented = [...clauses.keys()].filter((id) => !observedClaims[id] || ['missing', 'partial'].includes(observedClaims[id].verdict)).sort();
  const unclaimedChangedPaths = activePaths.filter((candidate) => !claimedPaths.has(candidate));
  const withdrawnButClaimed = Object.keys(observedClaims).filter((id) => !clauses.has(id)).sort();
  const invalidEvidence = [];
  for (const [id, claim] of Object.entries(observedClaims)) {
    if (['matched', 'partial', 'deviated'].includes(claim.verdict) && !(claim.observedPaths ?? []).length) {
      invalidEvidence.push(`${id} has verdict ${claim.verdict} without source-path evidence`);
    }
    if (root) {
      for (const candidate of claim.observedPaths ?? []) {
        if (!existsSync(path.join(root, candidate))) invalidEvidence.push(`${id} references missing source evidence ${candidate}`);
      }
      for (const commit of claim.commits ?? []) {
        const resolved = run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true });
        if (resolved.status !== 0) invalidEvidence.push(`${id} references unreachable commit ${commit}`);
      }
    }
  }
  const result = {
    schemaVersion: 1, // schema-transient: computed coverage result, never persisted
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
    invalidEvidence: [...new Set(invalidEvidence)].sort(),
    complete: !unimplemented.length && !unclaimedChangedPaths.length && !withdrawnButClaimed.length && !invalidEvidence.length
  };
  result.severity = result.complete || normalized.coverage === 'off' ? 'pass' : normalized.coverage === 'enforce' ? 'error' : 'warning';
  return result;
}

export function evaluateSpecAcceptance({ indexes = [], planned = [], observed = [], acceptance = [] }, policy = {}, expected = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = Object.assign({}, ...planned.map((map) => map.claims ?? {}));
  const observedClaims = Object.assign({}, ...observed.map((map) => map.claims ?? {}));
  const candidates = [...acceptance].sort(recordOrder);
  const latestRun = candidates.at(-1) ?? null;
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
  const staleRunReasons = [];
  if (latestRun) {
    const storedHash = latestRun.recordSha256;
    const withoutHash = { ...latestRun };
    delete withoutHash.recordSha256;
    if (!storedHash || storedHash !== sha256(canonicalJson(withoutHash))) staleRunReasons.push('acceptance record hash is missing or invalid');
    if (latestRun.status !== 'passed') staleRunReasons.push('latest acceptance run did not pass');
    if (latestRun.sourceChangedDuringRun) staleRunReasons.push('repository source changed while acceptance commands were running');
    if (expected.workId && latestRun.workId !== expected.workId) staleRunReasons.push(`acceptance run belongs to ${latestRun.workId ?? 'no work item'}`);
    if (expected.phase && latestRun.phase !== expected.phase) staleRunReasons.push(`acceptance run belongs to phase ${latestRun.phase ?? 'unknown'}`);
    if (expected.generation != null && Number(latestRun.generation) !== Number(expected.generation)) staleRunReasons.push(`acceptance run belongs to generation ${latestRun.generation ?? 'unknown'}`);
    if (expected.sourceTreeSha256 && latestRun.sourceTreeSha256 !== expected.sourceTreeSha256) staleRunReasons.push('source tree changed after the acceptance run');
    if (expected.commandSetSha256 && latestRun.commandSetSha256 !== expected.commandSetSha256) staleRunReasons.push('configured acceptance commands changed after the run');
  }
  const complete = normalized.acceptance === 'off'
    || (!missingPlannedTests.length && !missingObservedTests.length && !failedCommands.length && !missingRun && !staleRunReasons.length);
  return {
    schemaVersion: 1, // schema-transient: computed acceptance result, never persisted
    mode: normalized.acceptance,
    complete,
    missingPlannedTests,
    missingObservedTests,
    failedCommands,
    missingRun,
    staleRunReasons,
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
  const sourceTreeBefore = await specificationSourceTreeHash(root);
  const commandSetSha256 = sha256(canonicalJson(selected.map((id) => ({ id, argv: configured[id] }))));
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
  const sourceTreeAfter = await specificationSourceTreeHash(root);
  const sourceChangedDuringRun = sourceTreeBefore !== sourceTreeAfter;
  const record = {
    schemaVersion: currentSchemaVersion('specification-acceptance'),
    workId,
    phase,
    generation,
    sourceCommit: gitCommit(root),
    sourceTreeSha256: sourceTreeAfter,
    commandSetSha256,
    sourceChangedDuringRun,
    startedAt,
    completedAt: nowIso(),
    status: commands.every((entry) => entry.status === 'passed') && !sourceChangedDuringRun ? 'passed' : 'failed',
    commands
  };
  record.recordSha256 = sha256(canonicalJson(record));
  if (write && outputPath) await writeJson(path.join(root, outputPath), canonicalize(record));
  return record;
}

export function configuredAcceptanceCommandSetSha256(policy = {}, commandIds = []) {
  const normalized = normalizeSpecPolicy(policy);
  const selected = commandIds.length ? [...new Set(commandIds)] : Object.keys(normalized.testCommands);
  for (const id of selected) if (!normalized.testCommands[id]) throw new SingularityFlowError(`Unknown allowlisted specification test command '${id}'.`);
  return sha256(canonicalJson(selected.map((id) => ({ id, argv: normalized.testCommands[id] }))));
}

export async function specificationSourceTreeHash(root) {
  const listed = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, allowFailure: true });
  if (listed.status !== 0) throw new SingularityFlowError(`Unable to enumerate repository source for specification acceptance: ${(listed.stderr || listed.stdout).trim() || 'git ls-files failed'}`);
  const files = listed.stdout.split('\0').filter(Boolean)
    .map(posix)
    .filter((file) => !file.startsWith('singularity/') && !file.startsWith('.git/') && !file.startsWith('node_modules/'))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) continue;
    const stat = await lstat(absolute);
    const mode = stat.isSymbolicLink() ? 'symlink' : stat.mode & 0o111 ? 'executable' : 'file';
    const content = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    hash.update(file).update('\0').update(mode).update('\0').update(content).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
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
  if (result.status !== 0) {
    throw new SingularityFlowError(`Unable to calculate changed repository paths: ${(result.stderr || result.stdout).trim() || `git diff exited ${result.status}`}`);
  }
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

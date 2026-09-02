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
import {
  applicationPathContext, isApplicationChangePath, isApplicationPath
} from './application-paths.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';

const CLAUSE_TYPES = new Set(['REQ', 'BEH', 'IFC', 'AC', 'CON']);
const VERDICTS = new Set(['matched', 'partial', 'missing', 'deviated', 'unplanned']);
export const SPECIFICATION_DEFINITION_KINDS = Object.freeze(['requirements', 'implementation-spec']);
const SPECIFICATION_DEFINITION_KIND_SET = new Set(SPECIFICATION_DEFINITION_KINDS);
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

function sameDigest(left, right) {
  return String(left ?? '').replace(/^sha256:/, '') === String(right ?? '').replace(/^sha256:/, '');
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

/**
 * Only producer artifacts that define requirements may contribute clauses to
 * the authoritative specification universe. Reports and convergence/release
 * documents can cite clauses, but their citations must never become new
 * requirements merely because they contain an anchor.
 */
export function isSpecificationDefinitionPhase(phase) {
  const kind = typeof phase === 'string'
    ? phase
    : phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
  // Historical workflow snapshots did not persist the artifact kind on every phase. They remain
  // readable as definition producers; current snapshots always carry the kind and therefore
  // exclude reports/convergence artifacts explicitly. Treating an absent legacy field as a
  // reference-only report would silently erase already-approved clauses from grounding.
  return kind == null || SPECIFICATION_DEFINITION_KIND_SET.has(kind);
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
  const excludes = [...new Set(['singularity', '.github/agents', '.git', 'node_modules', ...configuredExcludes])];
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
export function ignoredRanges(markdown, { includeInlineCode = true } = {}) {
  const ranges = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /~~~[\s\S]*?~~~/g,
    ...(includeInlineCode ? [/`[^`\n]*`/g] : []),
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

function exactStructuredPath(value, label) {
  const candidate = String(value);
  const normalized = posix(candidate);
  if (
    candidate !== candidate.trim()
    || candidate.includes('\\')
    || normalized !== candidate
    || !candidate
    || candidate === '.'
    || candidate.startsWith('./')
    || candidate.endsWith('/')
    || candidate.includes('//')
    || path.posix.isAbsolute(candidate)
    || candidate === '..'
    || candidate.startsWith('../')
    || candidate.includes('/../')
    || candidate.includes('/./')
    || /^[A-Za-z]:/.test(candidate)
    || /^[a-z][a-z0-9+.-]*:/i.test(candidate)
    || /[\0-\x1f\x7f]/.test(candidate)
    || /[*?\[\]{}<>$]/.test(candidate)
    || candidate.includes('...')
    || /(?:^|\/)(?:TODO|TBD|PLACEHOLDER)(?:\.|\/|$)/i.test(candidate)
  ) {
    throw new SingularityFlowError(`${label} must be an exact repository-relative path without traversal, globs, placeholders, or platform-specific syntax.`);
  }
  return candidate;
}

function markdownCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
}

function tableDivider(cells, width) {
  return Array.isArray(cells)
    && cells.length === width
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableHeader(cells) {
  return cells?.map((cell) => cell.toLowerCase().replace(/\s+/g, ' '));
}

function parseClauseCell(cell, known, label) {
  let value = String(cell ?? '').trim();
  if (value.startsWith('`') && value.endsWith('`') && value.indexOf('`', 1) === value.length - 1) {
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1).trim();
  const match = value.match(new RegExp(`^(${NAMESPACE}:(?:REQ|BEH|IFC|AC|CON)-\\d{3})$`, 'i'));
  if (!match) throw new SingularityFlowError(`${label} must contain exactly one namespace-qualified clause ID.`);
  const id = match[1].toUpperCase();
  if (!known.has(id)) throw new SingularityFlowError(`${label} references unknown clause ${id}.`);
  return id;
}

function parseBacktickedPathCell(cell, label) {
  const source = String(cell ?? '').trim();
  if (!source || /^(?:-|—)$/.test(source)) return [];
  const paths = [];
  const remainder = source.replace(/`([^`\n]+)`/g, (_whole, value) => {
    paths.push(exactStructuredPath(value, label));
    return '';
  });
  const separators = remainder
    .replace(/<br\s*\/?\s*>/gi, '')
    .replace(/[\s,;]+/g, '');
  if (!paths.length || separators) {
    throw new SingularityFlowError(`${label} must list each exact repository-relative path in backticks.`);
  }
  return [...new Set(paths)].sort();
}

function parseNotApplicable(cell, label) {
  const match = String(cell ?? '').trim().match(/^not-applicable\s*:\s*(.+)$/i);
  if (!match) return null;
  const reason = match[1].trim();
  if (!reason || /^(?:todo|tbd|placeholder)$/i.test(reason)) {
    throw new SingularityFlowError(`${label} not-applicable requires a concrete reason.`);
  }
  return reason;
}

function plannedClaimSource(markdown) {
  const authored = authoredArtifactText(markdown);
  const ranges = ignoredRanges(authored, { includeInlineCode: false });
  if (!ranges.length) return authored;
  let cursor = 0;
  let visible = '';
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
    if (start < cursor) continue;
    visible += authored.slice(cursor, start);
    visible += authored.slice(start, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  return visible + authored.slice(cursor);
}

/**
 * Derive a planned claim map only from the reviewed structured Markdown
 * contract. Prose, guessed filenames, globs, and unqualified clause IDs are
 * deliberately ignored/refused rather than interpreted.
 */
export function derivePlannedClaimMap(markdown, { clauseIds = [], policy = {} } = {}) {
  if (typeof markdown !== 'string') throw new SingularityFlowError('Planned claim source must be UTF-8 Markdown.');
  const known = new Set(clauseIds.map((id) => String(id).toUpperCase()));
  const claims = {};
  const lines = plannedClaimSource(markdown).split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const cells = markdownCells(lines[index]);
    const headers = tableHeader(cells);
    if (!headers || headers.join('|') !== 'clause|expected paths|planned tests') continue;
    if (!tableDivider(markdownCells(lines[index + 1]), 3)) {
      throw new SingularityFlowError(`Planned claim table at line ${index + 1} must be followed by a Markdown divider row.`);
    }
    index += 2;
    for (; index < lines.length; index += 1) {
      const row = markdownCells(lines[index]);
      if (!row) {
        index -= 1;
        break;
      }
      if (row.length !== 3) throw new SingularityFlowError(`Planned claim table row at line ${index + 1} must contain exactly three columns.`);
      const id = parseClauseCell(row[0], known, `Planned claim table row ${index + 1}`);
      if (claims[id]) throw new SingularityFlowError(`Planned claim table defines clause ${id} more than once.`);
      const expectedPaths = parseBacktickedPathCell(row[1], `${id}.expectedPaths`);
      const notApplicableReason = parseNotApplicable(row[2], `${id}.plannedTests`);
      const tests = notApplicableReason == null
        ? parseBacktickedPathCell(row[2], `${id}.tests`)
        : [];
      claims[id] = {
        expectedPaths,
        tests,
        testDisposition: notApplicableReason == null
          ? (tests.length ? 'applicable' : 'unspecified')
          : 'not-applicable',
        testReason: notApplicableReason,
        deviation: null
      };
    }
  }
  const claimMap = normalizeClaimMap({ claims }, { kind: 'planned', clauseIds: [...known], policy });
  return {
    claimMap,
    missingClauseIds: [...known].filter((id) => !claims[id]).sort(),
    missingTestClauseIds: [...known].filter((id) => {
      const claim = claims[id];
      return !claim || (!claim.tests.length && claim.testDisposition !== 'not-applicable');
    }).sort()
  };
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
      const tests = normalizePaths(claim.tests, `${id}.tests`, normalized.limits);
      const testDisposition = claim.testDisposition ?? (tests.length ? 'applicable' : 'unspecified');
      if (!['applicable', 'not-applicable', 'unspecified'].includes(testDisposition)) {
        throw new SingularityFlowError(`${id}.testDisposition must be applicable, not-applicable, or unspecified.`);
      }
      const testReason = claim.testReason == null ? null : String(claim.testReason).trim();
      if (testDisposition === 'not-applicable' && (tests.length || !testReason)) {
        throw new SingularityFlowError(`${id} not-applicable test disposition requires no tests and a concrete testReason.`);
      }
      if (testDisposition !== 'not-applicable' && testReason) {
        throw new SingularityFlowError(`${id}.testReason is only allowed when testDisposition is not-applicable.`);
      }
      claims[id] = {
        expectedPaths: normalizePaths(claim.expectedPaths, `${id}.expectedPaths`, normalized.limits),
        tests,
        testDisposition,
        testReason,
        deviation: claim.deviation == null ? null : String(claim.deviation)
      };
    } else {
      const verdict = claim.verdict ?? 'missing';
      if (!VERDICTS.has(verdict)) throw new SingularityFlowError(`${id}.verdict must be ${[...VERDICTS].join(', ')}.`);
      const observedPaths = normalizePaths(claim.observedPaths, `${id}.observedPaths`, normalized.limits);
      const testResults = normalizePaths(claim.testResults, `${id}.testResults`, normalized.limits);
      const acceptanceTestEvidence = /:AC-\d{3}$/.test(id) && testResults.length > 0;
      if (['matched', 'partial', 'deviated'].includes(verdict) && !observedPaths.length && !acceptanceTestEvidence) {
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

function evidencePaths(delivery, names, label, limits) {
  const candidates = [];
  const sources = [delivery, delivery?.changeSet].filter(Boolean);
  for (const source of sources) {
    for (const name of names) {
      if (source[name] != null) candidates.push(...normalizePaths(source[name], `${label}.${name}`, limits));
    }
  }
  return [...new Set(candidates.map((candidate) => exactStructuredPath(candidate, label)))].sort();
}

/**
 * Project exact code-delivery evidence onto an already reviewed planned claim
 * map. The projection never attributes a changed path by directory proximity
 * or a test by name similarity. Completely unevidenced clauses remain absent.
 */
export function deriveObservedClaimMap(plannedMap, delivery = {}, {
  clauseIds = [], policy = {}, generationCommit = null
} = {}) {
  const normalizedPolicy = normalizeSpecPolicy(policy);
  const rawPlanned = plannedMap?.claims ?? plannedMap ?? {};
  const knownIds = clauseIds.length
    ? clauseIds.map((id) => String(id).toUpperCase())
    : Object.keys(rawPlanned).map((id) => id.toUpperCase());
  const planned = normalizeClaimMap({ claims: rawPlanned }, {
    kind: 'planned', clauseIds: knownIds, policy: normalizedPolicy
  });
  const changedPaths = new Set(evidencePaths(delivery,
    ['sourcePaths', 'deletedSourcePaths'], 'delivery source evidence', normalizedPolicy.limits));
  const testPaths = new Set(evidencePaths(delivery,
    ['testPaths', 'executableTestPaths', 'supportingTestPaths'], 'delivery test evidence', normalizedPolicy.limits));
  const bindings = new Map();
  for (const binding of delivery?.traceability?.bindings ?? []) {
    const id = String(binding?.clauseId ?? '').toUpperCase();
    if (!knownIds.includes(id) || typeof binding?.testSource !== 'string') continue;
    const testSource = exactStructuredPath(binding.testSource, `${id}.traceability.testSource`);
    if (!testPaths.has(testSource)) continue;
    const ids = bindings.get(testSource) ?? new Set();
    ids.add(id);
    bindings.set(testSource, ids);
  }
  const commits = generationCommit == null ? [] : [generationCommit];
  const claims = {};
  for (const id of knownIds) {
    const plan = planned.claims[id];
    if (!plan || plan.testDisposition === 'not-applicable') continue;
    const observedPaths = plan.expectedPaths.filter((candidate) => changedPaths.has(candidate));
    const testResults = plan.tests.filter((candidate) => {
      if (!testPaths.has(candidate)) return false;
      const boundIds = bindings.get(candidate);
      return !boundIds?.size || boundIds.has(id);
    });
    if (!observedPaths.length && !testResults.length) continue;
    const sourceComplete = plan.expectedPaths.length > 0
      && observedPaths.length === plan.expectedPaths.length;
    const testsComplete = plan.tests.length === 0 || testResults.length === plan.tests.length;
    const acceptanceTestOnly = /:AC-\d{3}$/.test(id) && !observedPaths.length && testResults.length;
    claims[id] = {
      observedPaths,
      testResults,
      commits,
      verdict: observedPaths.length
        ? (sourceComplete && testsComplete ? 'matched' : 'partial')
        : acceptanceTestOnly
          ? (plan.expectedPaths.length === 0 && testsComplete ? 'matched' : 'partial')
          : 'missing',
      deviation: null
    };
  }
  return normalizeClaimMap({ claims }, { kind: 'observed', clauseIds: knownIds, policy: normalizedPolicy });
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

function expectedClaimMapPath(root, itemDirectory, phase, kind) {
  return posix(path.relative(root, path.join(
    itemDirectory, 'context', 'claims', `${phase.id}-gen${phase.generation}-${kind}.json`
  )));
}

function assertCommittedInputBytes(root, relative, label) {
  const current = run('git', ['hash-object', '--', relative], { cwd: root, allowFailure: true });
  const committed = run('git', ['rev-parse', '--verify', `HEAD:${relative}`], {
    cwd: root, allowFailure: true
  });
  if (current.status !== 0 || committed.status !== 0
      || current.stdout.trim() !== committed.stdout.trim()) {
    throw new SingularityFlowError(
      `${label} is not the exact version committed with the approved Story state.`,
      { code: 'SPECIFICATION_INPUT_NOT_COMMITTED', details: { path: relative } }
    );
  }
}

function expectedSpecIndexPath(root, itemDirectory, phase) {
  return posix(path.relative(root, path.join(
    itemDirectory, 'context', 'spec-indexes', `${phase.id}-gen${phase.generation}.json`
  )));
}

async function readBoundSpecificationIndex(root, itemDirectory, workflow, phase, {
  requireCommitted = false
} = {}) {
  const pointer = phase?.specIndex;
  if (!pointer) {
    throw new SingularityFlowError(
      `Phase '${phase?.id ?? 'unknown'}' has no authoritative specification-index binding.`,
      { code: 'SPECIFICATION_INDEX_BINDING_REQUIRED' }
    );
  }
  const expectedPath = expectedSpecIndexPath(root, itemDirectory, phase);
  if (pointer.path !== expectedPath || Number(pointer.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' specification-index binding is stale.`,
      { code: 'SPECIFICATION_INDEX_BINDING_STALE' }
    );
  }
  const boundary = await secureRepositoryPath(root, pointer.path, {
    label: `Specification index for phase '${phase.id}'`, mustExist: true, type: 'file'
  });
  if (requireCommitted) {
    assertCommittedInputBytes(root, boundary.relative, `Specification index for phase '${phase.id}'`);
  }
  const index = readRecord('specification-index', await readFile(boundary.absolute)).record;
  const withoutHash = { ...index };
  delete withoutHash.indexSha256;
  const computedIndexSha256 = sha256(canonicalJson(withoutHash));
  const expectedSourcePath = posix(path.relative(root, path.join(
    itemDirectory, phase.requiredArtifact?.path ?? ''
  )));
  if (index.workId !== workflow.workItem.id
      || index.phase !== phase.id
      || Number(index.generation) !== Number(phase.generation)
      || !sameDigest(index.indexSha256, computedIndexSha256)
      || !sameDigest(pointer.indexSha256, computedIndexSha256)
      || Number(pointer.clauses) !== Number(index.clauses?.length ?? 0)
      || index.source?.path !== expectedSourcePath
      || !sameDigest(pointer.sourceSha256, index.source?.sha256)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' specification index does not match its exact workflow binding.`,
      { code: 'SPECIFICATION_INDEX_UNTRUSTED', details: { phase: phase.id, path: boundary.relative } }
    );
  }
  const source = await secureRepositoryPath(root, index.source.path, {
    label: `Specification source for phase '${phase.id}'`, mustExist: true, type: 'file'
  });
  if (requireCommitted) {
    assertCommittedInputBytes(root, source.relative, `Specification source for phase '${phase.id}'`);
  }
  const current = await snapshot(source.absolute);
  const approved = (phase.artifacts ?? []).find((artifact) => artifact.path === source.relative);
  if (!sameDigest(current.sha256, index.source.sha256)
      || Number(current.size) !== Number(index.source.bytes)
      || !approved
      || approved.status !== 'approved'
      || !sameDigest(approved.sha256, current.sha256)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' specification source changed after its approved index was recorded.`,
      { code: 'SPECIFICATION_INDEX_UNTRUSTED', details: { phase: phase.id, path: source.relative } }
    );
  }
  return index;
}

/**
 * Read one claim map through the workflow aggregate's authoritative pointer.
 *
 * The directory is audit storage, not an authority index. Current planned-claim Stories therefore
 * bind every live claim through `phase.claimMaps`; otherwise an extra JSON file can participate in
 * terminal arithmetic merely by naming the current work item, phase, and generation.
 */
export async function readBoundSpecificationClaimMap(root, itemDirectory, workflow, phase, kind, {
  clauseIds = [], policy = {}, requireCommitted = false
} = {}) {
  if (!['planned', 'observed'].includes(kind)) {
    throw new SingularityFlowError(`Claim-map binding kind must be planned or observed.`);
  }
  const pointer = phase?.claimMaps?.[kind];
  if (!phase || !pointer) {
    throw new SingularityFlowError(
      `Phase '${phase?.id ?? 'unknown'}' has no authoritative ${kind} claim-map binding.`,
      { code: 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED' }
    );
  }
  const expectedPath = expectedClaimMapPath(root, itemDirectory, phase, kind);
  if (pointer.path !== expectedPath || Number(pointer.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' ${kind} claim-map binding is stale.`,
      { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' }
    );
  }
  const boundary = await secureRepositoryPath(root, pointer.path, {
    label: `Phase '${phase.id}' ${kind} claim map`, mustExist: true, type: 'file'
  });
  if (requireCommitted) {
    assertCommittedInputBytes(root, boundary.relative, `Phase '${phase.id}' ${kind} claim map`);
  }
  const raw = JSON.parse(await readFile(boundary.absolute, 'utf8'));
  if (sha256(canonicalJson(raw)) !== pointer.sha256) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' ${kind} claim map changed after publication.`,
      { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' }
    );
  }
  const record = readRecord('specification-claim-map', raw).record;
  if (record.kind !== kind
      || record.workId !== workflow?.workItem?.id
      || record.phase !== phase.id
      || Number(record.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `${kind} specification claim map does not bind ${workflow?.workItem?.id ?? 'unknown'}/${phase.id} generation ${phase.generation}.`,
      { code: 'SPECIFICATION_CLAIM_MAP_IDENTITY_INVALID' }
    );
  }
  // Schema migration proves readability; normalization enforces the pinned clause and path bounds.
  normalizeClaimMap(record, { kind, clauseIds, policy });
  return record;
}

function recordOrder(left, right) {
  const generation = Number(left?.generation ?? -1) - Number(right?.generation ?? -1);
  if (generation) return generation;
  const timestamp = String(left?.completedAt ?? left?.recordedAt ?? '').localeCompare(String(right?.completedAt ?? right?.recordedAt ?? ''));
  if (timestamp) return timestamp;
  return String(left?.phase ?? '').localeCompare(String(right?.phase ?? ''));
}

function sortedUnique(values) {
  return [...new Set(values.filter((value) => value != null).map(String))].sort();
}

/** Merge planned evidence cumulatively across multiple code intervals. */
export function mergePlannedClaimRecords(maps = []) {
  const grouped = new Map();
  for (const map of [...maps].sort(recordOrder)) {
    for (const [id, claim] of Object.entries(map?.claims ?? {})) {
      const current = grouped.get(id) ?? {
        expectedPaths: [], tests: [], dispositions: [], reasons: [], deviation: null
      };
      current.expectedPaths.push(...(claim.expectedPaths ?? []));
      current.tests.push(...(claim.tests ?? []));
      current.dispositions.push(claim.testDisposition ?? 'unspecified');
      if (claim.testReason) current.reasons.push(claim.testReason);
      if (claim.deviation != null) current.deviation = claim.deviation;
      grouped.set(id, current);
    }
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
    const tests = sortedUnique(value.tests);
    const allNotApplicable = value.dispositions.length > 0
      && value.dispositions.every((entry) => entry === 'not-applicable');
    return [id, {
      expectedPaths: sortedUnique(value.expectedPaths),
      tests,
      testDisposition: tests.length ? 'applicable' : allNotApplicable ? 'not-applicable' : 'unspecified',
      testReason: tests.length || !allNotApplicable ? null : value.reasons.at(-1) ?? null,
      deviation: value.deviation
    }];
  }));
}

/**
 * Merge observed evidence cumulatively instead of letting a later interval's empty/missing result
 * erase an earlier exact match. Completeness is recomputed against the cumulative planned paths and
 * tests, so two partial implementation intervals can together form one matched claim.
 */
export function mergeObservedClaimRecords(maps = [], plannedClaims = {}) {
  const grouped = new Map();
  for (const map of [...maps].sort(recordOrder)) {
    for (const [id, claim] of Object.entries(map?.claims ?? {})) {
      const current = grouped.get(id) ?? {
        observedPaths: [], testResults: [], commits: [], verdicts: [], deviation: null
      };
      current.observedPaths.push(...(claim.observedPaths ?? []));
      current.testResults.push(...(claim.testResults ?? []));
      current.commits.push(...(claim.commits ?? []));
      current.verdicts.push(claim.verdict ?? 'missing');
      if (claim.deviation != null) current.deviation = claim.deviation;
      grouped.set(id, current);
    }
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
    const observedPaths = sortedUnique(value.observedPaths);
    const testResults = sortedUnique(value.testResults);
    const plan = plannedClaims[id] ?? null;
    let verdict;
    if (value.verdicts.includes('deviated')) verdict = 'deviated';
    else if (value.verdicts.includes('unplanned')) verdict = 'unplanned';
    else if (plan) {
      const expectedPaths = plan.expectedPaths ?? [];
      const sourceComplete = expectedPaths.length > 0
        && expectedPaths.every((candidate) => observedPaths.includes(candidate));
      const testsComplete = !(plan.tests ?? []).length
        || plan.tests.every((candidate) => testResults.includes(candidate));
      const acceptanceTestOnly = /:AC-\d{3}$/.test(id) && !observedPaths.length && testResults.length;
      verdict = observedPaths.length
        ? (sourceComplete && testsComplete ? 'matched' : 'partial')
        : acceptanceTestOnly
          ? (!expectedPaths.length && testsComplete ? 'matched' : 'partial')
          // Preserve an invalid producer verdict when it has no source path. Convergence and
          // terminal coverage must expose that stale binding; normalizing it to `missing` here
          // would erase the stronger integrity defect from the fact set.
          : value.verdicts.includes('matched')
            ? 'matched'
            : value.verdicts.includes('partial')
              ? 'partial'
              : 'missing';
    } else if (value.verdicts.includes('matched')) verdict = 'matched';
    else if (value.verdicts.includes('partial')) verdict = 'partial';
    else verdict = 'missing';
    return [id, {
      observedPaths,
      testResults,
      commits: sortedUnique(value.commits),
      verdict,
      deviation: value.deviation
    }];
  }));
}

/**
 * Select only records that belong to the current generation of the current
 * Story. Historical files remain in Git for audit, but must never participate
 * in a live governance decision.
 */
export function selectActiveSpecRecords(records, workflow) {
  const workId = workflow?.workItem?.id ?? null;
  const configuredClausePhases = workflow?.resolution?.plannedClaims?.mode === 'required'
    && Array.isArray(workflow.resolution.plannedClaims.clausePhases)
    ? new Set(workflow.resolution.plannedClaims.clausePhases)
    : null;
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
    indexes: (records.indexes ?? []).filter((record) =>
      active(record)
      && (configuredClausePhases
        ? configuredClausePhases.has(record.phase)
          && isSpecificationDefinitionPhase(workflow?.phases?.[record.phase])
        : isSpecificationDefinitionPhase(workflow?.phases?.[record.phase]))).sort(recordOrder),
    planned: (records.planned ?? []).filter(active).sort(recordOrder),
    observed: (records.observed ?? []).filter(active).sort(recordOrder),
    acceptance: (records.acceptance ?? []).filter(active).sort(recordOrder)
  };
}

export async function loadActiveSpecRecords(itemDirectory, workflow) {
  return selectActiveSpecRecords(await loadSpecRecords(itemDirectory), workflow);
}

/**
 * Load terminal specification evidence for a Story that explicitly pins required planned claims.
 * Indexes and acceptance runs remain directory records; planned and observed maps are admitted only
 * through the exact current-generation bindings in the workflow aggregate.
 */
export async function loadBoundActiveSpecRecords(root, itemDirectory, workflow, policy = {}, {
  requireCommitted = false
} = {}) {
  const plannedPolicy = workflow?.resolution?.plannedClaims;
  if (!requireCommitted && plannedPolicy?.mode !== 'required') {
    return loadActiveSpecRecords(itemDirectory, workflow);
  }
  const phaseOrder = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const indexes = [];
  const acceptance = [];
  for (const phaseId of phaseOrder) {
    const phase = workflow.phases?.[phaseId];
    if (!phase || !isSpecificationDefinitionPhase(phase) || !phase.specIndex) continue;
    indexes.push(await readBoundSpecificationIndex(root, itemDirectory, workflow, phase, {
      requireCommitted
    }));
  }
  for (const phaseId of phaseOrder) {
    const phase = workflow.phases?.[phaseId];
    if (!phase || !(phase.generation > 0)) continue;
    const relative = posix(path.relative(root, path.join(
      itemDirectory, 'context', 'acceptance', `${phase.id}-gen${phase.generation}.json`
    )));
    if (!(await exists(path.join(root, relative)))) continue;
    const boundary = await secureRepositoryPath(root, relative, {
      label: `Specification acceptance for phase '${phase.id}'`, mustExist: true, type: 'file'
    });
    if (requireCommitted) {
      assertCommittedInputBytes(root, boundary.relative, `Specification acceptance for phase '${phase.id}'`);
    }
    const record = readRecord('specification-acceptance', await readFile(boundary.absolute)).record;
    const withoutHash = { ...record };
    delete withoutHash.recordSha256;
    if (record.workId !== workflow.workItem.id
        || record.phase !== phase.id
        || Number(record.generation) !== Number(phase.generation)
        || !sameDigest(record.recordSha256, sha256(canonicalJson(withoutHash)))) {
      throw new SingularityFlowError(
        `Phase '${phase.id}' specification acceptance record is not sealed to this Story generation.`,
        { code: 'SPECIFICATION_ACCEPTANCE_UNTRUSTED', details: { path: boundary.relative } }
      );
    }
    acceptance.push(record);
  }
  const base = selectActiveSpecRecords({ indexes, planned: [], observed: [], acceptance }, workflow);
  const clauseIds = [...new Set(base.indexes.flatMap((index) =>
    (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())))].sort();
  const planned = [];
  const observed = [];
  const ownerIds = plannedPolicy?.mode === 'required'
    ? [...new Set(Object.values(plannedPolicy.owners ?? {}))]
    : phaseOrder.filter((phaseId) => workflow.phases?.[phaseId]?.claimMaps?.planned);
  for (const ownerId of ownerIds) {
    const owner = workflow.phases?.[ownerId];
    planned.push(await readBoundSpecificationClaimMap(
      root, itemDirectory, workflow, owner, 'planned', { clauseIds, policy, requireCommitted }
    ));
  }
  const codePhaseIds = plannedPolicy?.mode === 'required'
    ? Object.keys(plannedPolicy.owners ?? {})
    : phaseOrder.filter((phaseId) => workflow.phases?.[phaseId]?.claimMaps?.observed);
  for (const codePhaseId of codePhaseIds) {
    const codePhase = workflow.phases?.[codePhaseId];
    observed.push(await readBoundSpecificationClaimMap(
      root, itemDirectory, workflow, codePhase, 'observed', { clauseIds, policy, requireCommitted }
    ));
  }
  return {
    ...base,
    planned: planned.sort(recordOrder),
    observed: observed.sort(recordOrder)
  };
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

function exactPlannedTestEvidence(id, plannedClaims, observedClaims) {
  const plannedTests = plannedClaims[id]?.tests ?? [];
  const observedTests = new Set(observedClaims[id]?.testResults ?? []);
  return plannedTests.length > 0 && plannedTests.every((candidate) => observedTests.has(candidate));
}

function acceptanceTestOnlyEvidence(id, plannedClaims, observedClaims) {
  return /:AC-\d{3}$/.test(id)
    && exactPlannedTestEvidence(id, plannedClaims, observedClaims);
}

export function evaluateSpecCoverage({ indexes = [], planned = [], observed = [] }, changedPaths = [], policy = {}, { root = null } = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const clauses = new Map(indexes.flatMap((index) => index.clauses ?? []).map((clause) => [clause.id, clause]));
  const plannedClaims = mergePlannedClaimRecords(planned);
  const observedClaims = mergeObservedClaimRecords(observed, plannedClaims);
  const activePaths = [...new Set(changedPaths.map(posix))].filter((candidate) => !pathExcluded(candidate, normalized.excludes)).sort();
  const claimedPaths = new Set(Object.entries(observedClaims).flatMap(([id, claim]) => [
    ...(claim.observedPaths ?? []),
    ...(claim.testResults ?? []).filter((candidate) => (plannedClaims[id]?.tests ?? []).includes(candidate))
  ]));
  const unimplemented = [...clauses.keys()].filter((id) => {
    const claim = observedClaims[id];
    if (!claim) return true;
    if (acceptanceTestOnlyEvidence(id, plannedClaims, observedClaims)) return false;
    return ['missing', 'partial'].includes(claim.verdict);
  }).sort();
  const unclaimedChangedPaths = activePaths.filter((candidate) => !claimedPaths.has(candidate));
  const withdrawnButClaimed = Object.keys(observedClaims).filter((id) => !clauses.has(id)).sort();
  const invalidEvidence = [];
  for (const [id, claim] of Object.entries(observedClaims)) {
    if (['matched', 'partial', 'deviated'].includes(claim.verdict)
        && !(claim.observedPaths ?? []).length
        && !acceptanceTestOnlyEvidence(id, plannedClaims, observedClaims)) {
      invalidEvidence.push(`${id} has verdict ${claim.verdict} without source-path evidence`);
    }
    if (root) {
      for (const candidate of claim.observedPaths ?? []) {
        if (!existsSync(path.join(root, candidate))) invalidEvidence.push(`${id} references missing source evidence ${candidate}`);
      }
      for (const candidate of claim.testResults ?? []) {
        if (!existsSync(path.join(root, candidate))) invalidEvidence.push(`${id} references missing test evidence ${candidate}`);
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
  const plannedClaims = mergePlannedClaimRecords(planned);
  const observedClaims = mergeObservedClaimRecords(observed, plannedClaims);
  const candidates = [...acceptance].sort(recordOrder);
  const latestRun = candidates.at(-1) ?? null;
  const missingPlannedTests = normalized.acceptance === 'off'
    ? []
    : [...clauses.keys()].filter((id) => {
      const claim = plannedClaims[id];
      return !(claim?.tests ?? []).length
        && !(claim?.testDisposition === 'not-applicable' && claim?.testReason);
    }).sort();
  const missingObservedTests = normalized.acceptance !== 'verify'
    ? []
    : [...clauses.keys()].filter((id) => {
      const plan = plannedClaims[id];
      return !exactPlannedTestEvidence(id, plannedClaims, observedClaims)
        && !(plan?.testDisposition === 'not-applicable' && plan?.testReason);
    }).sort();
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
  commandIds = [], workId = null, phase = null, generation = null, outputPath = null, write = true,
  pathContext = null
} = {}) {
  const normalized = normalizeSpecPolicy(policy);
  const configured = normalized.testCommands;
  const selected = commandIds.length ? [...new Set(commandIds)] : Object.keys(configured);
  for (const id of selected) if (!configured[id]) throw new SingularityFlowError(`Unknown allowlisted specification test command '${id}'.`);
  if (!selected.length) throw new SingularityFlowError('No spec.testCommands are configured. Add an allowlisted argv command before running acceptance.');
  const sourceTreeBefore = await specificationSourceTreeHash(root, pathContext);
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
  const sourceTreeAfter = await specificationSourceTreeHash(root, pathContext);
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

export async function specificationSourceTreeHash(root, pathContext = null) {
  assertNoHiddenWorktreeChanges(root, 'Specification source hashing');
  const tracked = run('git', ['ls-files', '-z', '--cached'], { cwd: root, allowFailure: true });
  const untracked = run('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, allowFailure: true });
  if (tracked.status !== 0 || untracked.status !== 0) {
    const failure = tracked.status !== 0 ? tracked : untracked;
    throw new SingularityFlowError(`Unable to enumerate repository source for specification acceptance: ${(failure.stderr || failure.stdout).trim() || 'git ls-files failed'}`);
  }
  const files = [...new Set([
    ...tracked.stdout.split('\0').filter(Boolean).map(posix)
      .filter((file) => isApplicationPath(file, pathContext)),
    ...untracked.stdout.split('\0').filter(Boolean).map(posix)
      .filter((file) => isApplicationChangePath(file, { ...pathContext, untracked: true }))
  ])].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const secured = await secureRepositoryPath(root, file, {
      label: 'Specification source path',
      allowFinalSymlink: true
    });
    if (!secured.exists) continue;
    const absolute = secured.absolute;
    const stat = secured.entry;
    if (stat.isDirectory()) {
      throw new SingularityFlowError(
        `Specification source contains a checked-out or dirty Git submodule at ${file}. `
          + 'Commit a clean submodule pointer before evaluating acceptance.',
        { code: 'SPECIFICATION_GITLINK_DIRTY', details: { path: file } }
      );
    }
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

export function changedRepositoryPaths(root, { base = null, target = 'HEAD', pathContext = null } = {}) {
  const args = base
    ? ['diff', '--name-only', '--diff-filter=ACDMRTUXB', base, target, '--']
    : ['diff', '--name-only', '--diff-filter=ACDMRTUXB', `${target}^`, target, '--'];
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(`Unable to calculate changed repository paths: ${(result.stderr || result.stdout).trim() || `git diff exited ${result.status}`}`);
  }
  return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).map(posix)
    .filter((file) => isApplicationPath(file, pathContext));
}

export { applicationPathContext };

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

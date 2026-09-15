import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import { createHash } from 'node:crypto';
import {
  COMMIT_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertNormalizedRepositoryPath, assertPlainRecord, assertSchemaKind, assertSelfHash,
  assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import { compareText, deepFreeze, sealRecord } from '../canonicalize.mjs';

export const WMP_CANDIDATE_ROSTER_FAMILY = 'world-model-discovered-candidate-roster';
export const WMP_CANDIDATE_ROSTER_ROLE = 'candidate-roster';
export const WMP_CANDIDATE_EXCLUSION_REASONS = Object.freeze({
  excluded: 'EXCLUDED_BY_SCOPE',
  outside: 'OUTSIDE_SCOPE',
  'too-deep': 'TRAVERSAL_DEPTH_EXCEEDED'
});

const MAXIMUM_CANDIDATES = 50_000;
const CANDIDATE_STATUSES = new Set(['selected', 'excluded']);
const EXCLUSION_REASONS = new Set(Object.values(WMP_CANDIDATE_EXCLUSION_REASONS));

function fail(message, code = 'WMP_CANDIDATE_ROSTER_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function record(value) {
  let migrated;
  try { migrated = readRecord(WMP_CANDIDATE_ROSTER_FAMILY, value).record; }
  catch (error) {
    fail(`Discovered Candidate Roster schema is unsupported: ${error.message}`,
      'WMP_READER_UNSUPPORTED', {
        family: WMP_CANDIDATE_ROSTER_FAMILY, cause: error.code ?? null
      });
  }
  assertSchemaKind(
    migrated, WMP_CANDIDATE_ROSTER_FAMILY, 'World-model Discovered Candidate Roster'
  );
  return migrated;
}

function validateSource(value) {
  assertPlainRecord(value, 'Discovered Candidate Roster source');
  assertExactKeys(value, {
    required: [
      'kind', 'commit', 'tree', 'gitObjectFormat', 'pathNormalization',
      'discoveryBoundary'
    ],
    label: 'Discovered Candidate Roster source'
  });
  if (value.kind !== 'committed-git-tree'
      || value.pathNormalization !== 'posix-relative'
      || value.discoveryBoundary !== 'recursive-tracked-blobs-before-scope') {
    fail('Discovered Candidate Roster source contract is unsupported.',
      'WMP_CANDIDATE_ROSTER_SOURCE_INVALID');
  }
  assertString(value.commit, 'Discovered Candidate Roster source commit', {
    pattern: COMMIT_PATTERN
  });
  assertString(value.tree, 'Discovered Candidate Roster source tree', {
    pattern: COMMIT_PATTERN
  });
  if (!['sha1', 'sha256'].includes(value.gitObjectFormat)) {
    fail('Discovered Candidate Roster Git object format is invalid.',
      'WMP_CANDIDATE_ROSTER_SOURCE_INVALID');
  }
  const expectedLength = value.gitObjectFormat === 'sha1' ? 40 : 64;
  if (value.commit.length !== expectedLength || value.tree.length !== expectedLength) {
    fail('Discovered Candidate Roster source identities disagree with the Git object format.',
      'WMP_CANDIDATE_ROSTER_SOURCE_INVALID', {
        gitObjectFormat: value.gitObjectFormat,
        commitLength: value.commit.length,
        treeLength: value.tree.length
      });
  }
  return value;
}

function validateCandidate(value, index, gitObjectFormat) {
  const label = `Discovered Candidate Roster candidates[${index}]`;
  assertPlainRecord(value, label);
  assertExactKeys(value, {
    required: [
      'path', 'type', 'mode', 'objectId', 'contentSha256', 'bytes', 'status',
      'reasonCode'
    ],
    label
  });
  assertNormalizedRepositoryPath(value.path, `${label} path`);
  if (!['regular', 'symlink'].includes(value.type)
      || !['100644', '100755', '120000'].includes(value.mode)
      || (value.mode === '120000') !== (value.type === 'symlink')) {
    fail(`${label} has an unsupported or inconsistent Git entry type.`,
      'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', { path: value.path });
  }
  assertString(value.objectId, `${label} objectId`, { pattern: COMMIT_PATTERN });
  const expectedObjectLength = gitObjectFormat === 'sha1' ? 40 : 64;
  if (value.objectId.length !== expectedObjectLength) {
    fail(`${label} object identity disagrees with the Git object format.`,
      'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', { path: value.path });
  }
  if (!CANDIDATE_STATUSES.has(value.status)) {
    fail(`${label} status is invalid.`, 'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', {
      path: value.path, status: value.status
    });
  }
  if (value.status === 'selected') {
    if (value.reasonCode !== null) {
      fail(`${label} cannot carry an exclusion reason when selected.`,
        'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', { path: value.path });
    }
    assertSha256(value.contentSha256, `${label} contentSha256`);
    assertInteger(value.bytes, `${label} bytes`, { minimum: 0 });
  } else if (!EXCLUSION_REASONS.has(value.reasonCode)) {
    fail(`${label} requires an owned scope-exclusion reason.`,
      'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', {
        path: value.path, reasonCode: value.reasonCode ?? null
      });
  } else if (value.contentSha256 !== null || value.bytes !== null) {
    fail(`${label} cannot claim selected source content when excluded.`,
      'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', { path: value.path });
  }
  return value;
}

function hashGitObject(type, bytes, gitObjectFormat) {
  const algorithm = gitObjectFormat === 'sha1' ? 'sha1' : 'sha256';
  const hash = createHash(algorithm);
  hash.update(Buffer.from(`${type} ${bytes.length}\0`, 'utf8'));
  hash.update(bytes);
  return hash.digest('hex');
}

function candidateTreeIdentity(candidates, gitObjectFormat) {
  const root = { directories: new Map(), files: new Map() };
  for (const candidate of candidates) {
    const segments = candidate.path.split('/');
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      if (directory.files.has(segment)) {
        fail(`Discovered Candidate Roster path '${candidate.path}' collides with a file.`,
          'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', { path: candidate.path });
      }
      if (!directory.directories.has(segment)) {
        directory.directories.set(segment, { directories: new Map(), files: new Map() });
      }
      directory = directory.directories.get(segment);
    }
    const name = segments.at(-1);
    if (directory.directories.has(name) || directory.files.has(name)) {
      fail(`Discovered Candidate Roster path '${candidate.path}' collides in its Git tree.`,
        'WMP_CANDIDATE_ROSTER_ENTRY_INVALID', { path: candidate.path });
    }
    directory.files.set(name, candidate);
  }

  // Hash deepest directories first without recursing. A Git tree can legally encode a path much
  // deeper than the JavaScript call stack, and the roster is an authority object whose bytes may
  // be supplied by an untrusted historical reader. Recursive hashing would turn such a valid tree
  // into an untyped RangeError instead of a bounded WMP validation result.
  const hashes = new Map();
  const pending = [{ directory: root, visited: false }];
  while (pending.length) {
    const frame = pending.pop();
    if (!frame.visited) {
      pending.push({ directory: frame.directory, visited: true });
      for (const child of frame.directory.directories.values()) {
        pending.push({ directory: child, visited: false });
      }
      continue;
    }
    const entries = [
      ...[...frame.directory.files].map(([name, candidate]) => ({
        name, mode: candidate.mode, objectId: candidate.objectId
      })),
      ...[...frame.directory.directories].map(([name, child]) => ({
        name, mode: '40000', objectId: hashes.get(child)
      }))
    ].sort((left, right) => Buffer.compare(
      Buffer.from(`${left.name}${left.mode === '40000' ? '/' : '\0'}`, 'utf8'),
      Buffer.from(`${right.name}${right.mode === '40000' ? '/' : '\0'}`, 'utf8')
    ));
    const body = Buffer.concat(entries.flatMap((entry) => [
      Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'),
      Buffer.from(entry.objectId, 'hex')
    ]));
    hashes.set(frame.directory, hashGitObject('tree', body, gitObjectFormat));
  }
  return hashes.get(root);
}

function expectedCounts(candidates) {
  const selectedPaths = candidates.filter((entry) => entry.status === 'selected').length;
  return {
    discoveredPaths: candidates.length,
    selectedPaths,
    excludedPaths: candidates.length - selectedPaths
  };
}

/**
 * Validate the frozen v1 roster discovered from one complete committed Git tree before scope.
 */
export function validateWorldModelDiscoveredCandidateRoster(value) {
  const result = record(value);
  assertExactKeys(result, {
    required: [
      'schemaVersion', 'kind', 'source', 'sourceManifestSha256',
      'scopeManifestSha256', 'candidates', 'counts', 'candidateRosterSha256'
    ],
    label: 'World-model Discovered Candidate Roster'
  });
  validateSource(result.source);
  assertSha256(result.sourceManifestSha256,
    'Discovered Candidate Roster sourceManifestSha256');
  assertSha256(result.scopeManifestSha256,
    'Discovered Candidate Roster scopeManifestSha256');
  if (!Array.isArray(result.candidates) || result.candidates.length > MAXIMUM_CANDIDATES) {
    fail(`Discovered Candidate Roster must contain at most ${MAXIMUM_CANDIDATES} paths.`,
      'WMP_OWNER_CONTRACT_LIMIT', { maximum: MAXIMUM_CANDIDATES });
  }
  result.candidates.forEach((candidate, index) => validateCandidate(
    candidate, index, result.source.gitObjectFormat
  ));
  assertCanonicalOrder(result.candidates, (entry) => entry.path,
    'Discovered Candidate Roster candidates');
  const paths = result.candidates.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    fail('Discovered Candidate Roster repeats a path.',
      'WMP_CANDIDATE_ROSTER_ENTRY_INVALID');
  }
  const observedTree = candidateTreeIdentity(
    result.candidates, result.source.gitObjectFormat
  );
  if (observedTree !== result.source.tree) {
    fail('Discovered Candidate Roster paths do not reconstruct its exact Git tree.',
      'WMP_CANDIDATE_ROSTER_TREE_MISMATCH', {
        expected: result.source.tree, received: observedTree
      });
  }
  assertPlainRecord(result.counts, 'Discovered Candidate Roster counts');
  assertExactKeys(result.counts, {
    required: ['discoveredPaths', 'selectedPaths', 'excludedPaths'],
    label: 'Discovered Candidate Roster counts'
  });
  for (const field of Object.keys(result.counts)) {
    assertInteger(result.counts[field], `Discovered Candidate Roster counts ${field}`, {
      minimum: 0, maximum: MAXIMUM_CANDIDATES
    });
  }
  const expected = expectedCounts(result.candidates);
  for (const [field, count] of Object.entries(expected)) {
    if (result.counts[field] !== count) {
      fail(`Discovered Candidate Roster count '${field}' is inconsistent.`,
        'WMP_CANDIDATE_ROSTER_COUNT_MISMATCH', {
          field, expected: count, received: result.counts[field]
        });
    }
  }
  assertSha256(result.candidateRosterSha256,
    'Discovered Candidate Roster candidateRosterSha256');
  assertSelfHash(result, 'candidateRosterSha256',
    'World-model Discovered Candidate Roster');
  return result;
}

export function createWorldModelDiscoveredCandidateRoster({
  source, sourceManifestSha256, scopeManifestSha256, candidates
} = {}) {
  const normalizedCandidates = [...(candidates ?? [])]
    .map((entry) => structuredClone(entry))
    .sort((left, right) => compareText(left.path, right.path));
  const base = {
    schemaVersion: currentSchemaVersion(WMP_CANDIDATE_ROSTER_FAMILY),
    kind: WMP_CANDIDATE_ROSTER_FAMILY,
    source: structuredClone(source),
    sourceManifestSha256,
    scopeManifestSha256,
    candidates: normalizedCandidates,
    counts: expectedCounts(normalizedCandidates)
  };
  return deepFreeze(validateWorldModelDiscoveredCandidateRoster(
    sealRecord(base, 'candidateRosterSha256')
  ));
}

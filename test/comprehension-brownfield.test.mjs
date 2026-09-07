import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrownfieldTouchedAreaAssessment,
  CMP_BROWNFIELD_TOUCH_CLASSES,
  CMP_HISTORICAL_ASSURANCE,
  sealHistoricalBackfillEntry,
  sealHistoricalBackfillProposal,
  validateHistoricalBackfillProposal
} from '../src/comprehension/brownfield.mjs';
import { buildChangeRegionManifest } from '../src/comprehension/contracts.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  repositoryChangeSetDigest
} from '../src/repository-change-set.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const SHA = (character) => `sha256:${character.repeat(64)}`;
const COMMIT = 'a'.repeat(40);

function hash(value) {
  return `sha256:${recordSha256(value)}`;
}

function entry({ status, oldPath = null, newPath = null, oldObject = null, newObject = null,
  oldMode = null, newMode = null }) {
  const core = {
    status,
    similarity: status === 'renamed' ? 100 : null,
    oldPath,
    newPath,
    oldMode: oldMode ?? (oldPath ? '100644' : '000000'),
    newMode: newMode ?? (newPath ? '100644' : '000000'),
    oldObject: oldObject ?? (oldPath ? '1'.repeat(40) : null),
    newObject: newObject ?? (newPath ? '2'.repeat(40) : null),
    newContent: newPath ? { kind: 'regular-file', sha256: SHA('c'), bytes: 12 } : null
  };
  return { ...core, changeId: hash(core) };
}

function manifest(entries) {
  const core = {
    schemaVersion: currentSchemaVersion('repository-change-set'),
    kind: 'repository-change-set',
    subject: 'CMP-BROWNFIELD',
    base: { commit: COMMIT, tree: 'b'.repeat(40) },
    target: {
      head: 'c'.repeat(40), includesIndex: true, includesWorktree: true,
      includesUntracked: true, caseInsensitivePaths: false
    },
    entries
  };
  return buildChangeRegionManifest({ ...core, digest: repositoryChangeSetDigest(core) });
}

function evidence(kind, id, digest = SHA('8')) {
  return { kind, id, recordSha256: digest };
}

function cause(id = 'REQ-123') {
  return { causeKind: 'requirement', causeId: id, recordSha256: SHA('7') };
}

function proposal(entries, scope = { kind: 'module', path: 'src/payments' }) {
  return sealHistoricalBackfillProposal({
    schemaVersion: 1,
    kind: 'comprehension-historical-backfill-proposal',
    sourceRevision: COMMIT,
    scope,
    entries
  });
}

test('brownfield adoption classifies only touched regions and never requires a full backfill', () => {
  const sameObject = '3'.repeat(40);
  const assessment = buildBrownfieldTouchedAreaAssessment(manifest([
    entry({ status: 'added', newPath: 'src/new.js' }),
    entry({ status: 'modified', oldPath: 'src/old.js', newPath: 'src/old.js' }),
    entry({
      status: 'renamed', oldPath: 'src/from.js', newPath: 'src/to.js',
      oldObject: sameObject, newObject: sameObject
    }),
    entry({
      status: 'renamed', oldPath: 'src/semantic-old.js', newPath: 'src/semantic-new.js',
      oldObject: '4'.repeat(40), newObject: '5'.repeat(40)
    }),
    entry({ status: 'deleted', oldPath: 'src/deleted.js' })
  ]));

  assert.equal(assessment.authoritative, false);
  assert.equal(assessment.lifecycleGate, false);
  assert.equal(assessment.policy.fullRepositoryBackfillRequired, false);
  assert.equal(assessment.policy.untouchedLegacyLabel, 'legacy-unexplained');
  assert.deepEqual(assessment.counts, {
    regions: 5,
    'new-region': 1,
    'legacy-touched': 3,
    'mechanical-move-candidate': 1
  });
  const move = assessment.regions.find((region) => region.pathAfter === 'src/to.js');
  assert.equal(move.requirement, 'transformation-receipt-required');
  assert.equal(move.legacyStatusRetained, false);
  const semanticMove = assessment.regions.find((region) => region.pathAfter === 'src/semantic-new.js');
  assert.equal(semanticMove.touchClass, 'legacy-touched');
  assert.equal(semanticMove.requirement, 'current-governed-cause-required');
  assert.ok(Object.isFrozen(assessment));
  assert.deepEqual(CMP_BROWNFIELD_TOUCH_CLASSES, [
    'new-region', 'legacy-touched', 'mechanical-move-candidate'
  ]);
  assert.throws(() => buildBrownfieldTouchedAreaAssessment({ ...manifest([]), manifestSha256: SHA('f') }),
    (error) => error.code === 'CMP_BROWNFIELD_MANIFEST_INVALID');
});

test('a partial module backfill preserves confirmed, inferred, and unknown as untrusted labels', () => {
  const decision = SHA('9');
  const confirmed = sealHistoricalBackfillEntry({
    path: 'src/payments/approved.js',
    assurance: 'historically-confirmed',
    causeRefs: [cause('REQ-APPROVED')],
    evidenceRefs: [
      evidence('git-commit', 'commit:abc1234'),
      evidence('approval-decision', 'phase:architecture', decision)
    ],
    decisionSha256: decision
  });
  const inferred = sealHistoricalBackfillEntry({
    path: 'src/payments/inferred.js',
    assurance: 'historically-inferred',
    causeRefs: [cause('REQ-INFERRED')],
    evidenceRefs: [evidence('git-commit', 'commit:def5678')],
    decisionSha256: null
  });
  const unknown = sealHistoricalBackfillEntry({
    path: 'src/payments/unknown.js',
    assurance: 'unknown',
    causeRefs: [],
    evidenceRefs: [evidence('document', 'legacy-notes')],
    decisionSha256: null
  });
  const validation = validateHistoricalBackfillProposal(
    proposal([confirmed, inferred, unknown]),
    { sourceRevision: COMMIT }
  );

  assert.equal(validation.valid, true);
  assert.equal(validation.authoritative, false);
  assert.equal(validation.lifecycleGate, false);
  assert.equal(validation.scope.path, 'src/payments');
  assert.deepEqual(validation.counts, {
    entries: 3,
    'historically-confirmed': 1,
    'historically-inferred': 1,
    unknown: 1
  });
  assert.match(validation.notices.join(' '), /No full-repository backfill is required/);
  assert.match(validation.notices.join(' '), /untrusted proposals/);
  assert.deepEqual(CMP_HISTORICAL_ASSURANCE, [
    'historically-confirmed', 'historically-inferred', 'unknown'
  ]);
});

test('historical backfill refuses fabricated certainty, stale subjects, escapes, and tampering', () => {
  const invalidConfirmed = sealHistoricalBackfillEntry({
    path: 'src/payments/a.js',
    assurance: 'historically-confirmed',
    causeRefs: [cause()],
    evidenceRefs: [evidence('git-commit', 'commit:abc1234')],
    decisionSha256: SHA('9')
  });
  const outside = sealHistoricalBackfillEntry({
    path: 'src/other.js',
    assurance: 'unknown', causeRefs: [], evidenceRefs: [], decisionSha256: null
  });
  const result = validateHistoricalBackfillProposal(
    proposal([invalidConfirmed, outside]),
    { sourceRevision: 'b'.repeat(40) }
  );
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((failure) => failure.code === 'CMP_BACKFILL_ASSURANCE_INVALID'));
  assert.ok(result.failures.some((failure) => failure.code === 'CMP_BACKFILL_SCOPE_INVALID'));
  assert.ok(result.failures.some((failure) => failure.code === 'CMP_BACKFILL_SOURCE_STALE'));

  const validUnknown = sealHistoricalBackfillEntry({
    path: 'src/payments/a.js', assurance: 'unknown',
    causeRefs: [], evidenceRefs: [], decisionSha256: null
  });
  const tampered = structuredClone(proposal([validUnknown]));
  tampered.entries[0].path = 'src/payments/changed.js';
  const tamperedResult = validateHistoricalBackfillProposal(tampered, { sourceRevision: COMMIT });
  assert.equal(tamperedResult.valid, false);
  assert.ok(tamperedResult.failures.some((failure) => failure.code === 'CMP_BACKFILL_INTEGRITY_INVALID'));
});

/**
 * Kernel-owned convergence. `[SPK:AC-003]` `[SPK:AC-004]`
 *
 * Two clauses name this file specifically, and both are about who is allowed to decide. `[SPK:AC-003]`
 * asks that a selected finding create rework only through the existing governed change-request
 * transition — never a shortcut invented for convergence. `[SPK:AC-004]` asks that every iteration
 * and every advancement require an explicit human action.
 *
 * The engine itself is pure, so most of this runs on constructed records rather than a live
 * repository: the interesting properties are about *what the projection permits*, and a fixture
 * repository would hide them behind five minutes of setup.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DISPOSITIONS, FACT_KINDS, FINDING_CLASSIFICATIONS, adjudicatedConvergenceProjection, advancementBlocked,
  assertConvergenceCandidateSource, assertConvergenceIntegrity, assertNoAutonomousConvergence,
  convergenceBindings, convergenceFacts, convergenceProjection, decodeConvergenceRecord,
  assertConvergencePublishable, itemId, renderConvergenceArtifact, serializeConvergence, validateAdjudication
} from '../src/convergence.mjs';
import {
  assertConvergenceSources, assertLegacyConvergenceSourceIdentity, exactConvergencePhaseArtifactRef
} from '../src/convergence-context.mjs';
import { recordSha256 } from '../src/records.mjs';
import { readRecord } from '../src/schema-migrations.mjs';

const RECONCILIATION = {
  reconciliationSha256: 'a'.repeat(64),
  path: 'work/context/reconciliations/a.json',
  intervalId: 'INT-1',
  sourceBaseCommit: 'b'.repeat(40),
  target: { head: 'c'.repeat(40) },
  findings: [
    { path: 'src/retry.ts', verdict: 'planned', clauseIds: ['D:REQ-001'] },
    { path: 'src/stray.ts', verdict: 'unplanned', clauseIds: [] }
  ]
};

const INDEXES = [{
  indexSha256: 'd'.repeat(64),
  clauses: [{ id: 'D:REQ-001', body: 'Creates a new attempt.' }, { id: 'D:REQ-002', body: 'Preserves the original.' }]
}];

const OBSERVED = [{
  recordSha256: 'e'.repeat(64),
  claims: { 'D:REQ-001': { verdict: 'matched', observedPaths: ['src/retry.ts'], testResults: ['t1'] } }
}];

const BINDINGS = convergenceBindings({
  iteration: 1, indexes: INDEXES, reconciliation: RECONCILIATION, observed: OBSERVED,
  configurationSha256: 'f'.repeat(64), specification: { generation: 1, sha256: '1'.repeat(64) }
});

const HUMAN = { actor: 'reviewer@example.invalid', at: '2026-01-01T00:00:00.000Z' };

test('phase bindings use the verified canonical upstream artifact, never a suffix decoy', () => {
  const phase = {
    id: 'specification', generation: 2, requiredArtifact: { path: 'spec.md' },
    artifacts: [
      { path: 'decoy/prefix/spec.md', sha256: 'decoy' },
      { path: 'singularity/work-items/D-1/artifacts/specification/spec.md', sha256: 'canonical' }
    ]
  };
  const upstream = [{
    phase: 'specification', generation: 2,
    path: 'singularity/work-items/D-1/artifacts/specification/spec.md', sha256: 'canonical'
  }];
  assert.deepEqual(exactConvergencePhaseArtifactRef(phase, upstream), {
    generation: 2, sha256: 'canonical'
  });
});

/**
 * Source with comments removed, for the assertions below that ask what the CLI *offers*.
 *
 * Three separate assertions in this pack have now tripped on a comment explaining why something is
 * forbidden — including, twice, on the comment recording the very fix the assertion was added for.
 * A guard whose easiest repair is deleting the explanation is worse than no guard.
 */
function withoutComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('facts describe the record, never the implementation', () => {
  /**
   * `[SPK:CON-033]`, and the single most important sentence in the feature. The kernel cannot see
   * whether code implements a requirement; it can only see whether anyone said so. A fact that
   * overstates that is how a governance tool starts being ignored.
   */
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const byKind = Object.fromEntries(facts.map((fact) => [fact.kind, fact]));

  assert.ok(byKind['absent-observed-claim'], 'REQ-002 has no observed claim and produced no fact');
  assert.match(byKind['absent-observed-claim'].detail, /missing trace evidence, not proof that the requirement is unimplemented/);
  assert.ok(byKind['unclaimed-changed-path'], 'a changed path no claim cites produced no fact');
  assert.match(byKind['unclaimed-changed-path'].detail, /missing trace evidence, not a finding that the change was unplanned/);

  /**
   * The property is not "these words never appear" — the disclaimers *contain* them, and an earlier
   * version of this assertion failed on the very sentence that gets the wording right. What must
   * hold is that any claim about implementation appears only inside a negation.
   */
  for (const fact of facts) {
    assert.ok(FACT_KINDS.includes(fact.kind), `unknown fact kind ${fact.kind}`);
    for (const match of fact.detail.matchAll(/\b(unimplemented|unplanned)\b/g)) {
      const preceding = fact.detail.slice(0, match.index);
      assert.match(preceding, /\bnot\b[^.]*$/, `a fact asserts '${match[1]}' rather than disclaiming it: ${fact.detail}`);
    }
  }
  // And every trace-absence fact says what it is, in the words the clause uses.
  for (const fact of facts.filter((entry) => ['absent-observed-claim', 'unclaimed-changed-path'].includes(entry.kind))) {
    assert.match(fact.detail, /trace evidence/, `an absence fact does not describe itself as missing trace evidence: ${fact.detail}`);
  }

  // A claimed path is not reported: REQ-001 cites src/retry.ts, so only the stray path is unclaimed.
  assert.deepEqual(facts.filter((fact) => fact.kind === 'unclaimed-changed-path').flatMap((fact) => fact.paths), ['src/stray.ts']);
});

test('the same bound inputs always produce the same bytes', () => {
  // `[SPK:REQ-075]`: an iteration can be proved unchanged, which is what makes a second iteration
  // meaningful rather than just newer.
  const first = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const second = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  assert.deepEqual(first, second);

  const projection = convergenceProjection({ workId: 'D-1', bindings: BINDINGS, facts: first });
  assert.equal(serializeConvergence(projection), serializeConvergence(convergenceProjection({ workId: 'D-1', bindings: BINDINGS, facts: second })));

  // Identity is content-derived, so the same problem keeps its ID across iterations. A counter would
  // have renamed it and hidden that a dismissed finding came back.
  assert.equal(itemId('CF', { kind: 'x' }), itemId('CF', { kind: 'x' }));
  assert.notEqual(itemId('CF', { kind: 'x' }), itemId('CF', { kind: 'y' }));
  assert.match(first[0].id, /^CF-[0-9a-f]{12}$/);
});

test('every iteration binds what it was computed from', () => {
  // `[SPK:REQ-072]`. Without this a convergence record is an opinion about "the code", and nobody
  // can tell later which code that was.
  for (const field of [
    'iteration', 'configurationSha256', 'clauseIndexSha256', 'reconciliation',
    'sourceBaseCommit', 'sourceTargetCommit', 'observedClaimsSha256'
  ]) assert.ok(field in BINDINGS, `the binding omits ${field}`);
  assert.equal(BINDINGS.reconciliation.sha256, RECONCILIATION.reconciliationSha256);
  assert.equal(BINDINGS.sourceTargetCommit, 'c'.repeat(40));
  assert.throws(() => convergenceBindings({ iteration: 0, reconciliation: RECONCILIATION }), /positive integer/);
  assert.throws(() => convergenceBindings({ iteration: 1, reconciliation: {} }), /requires a reconciliation record hash/);
});

test('nothing becomes a governed finding without a human', () => {
  // `[SPK:AC-004]`. A fact is a fact; a finding is a fact plus a person's decision about it.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const untouched = convergenceProjection({ workId: 'D-1', bindings: BINDINGS, facts });
  assert.deepEqual(untouched.findings, []);
  assert.deepEqual(untouched.unresolvedBlockers, []);
  assert.deepEqual(untouched.allowedNext, ['adjudicate'], 'undisposed facts allowed something other than adjudication');

  // Advancement is refused while anything is undisposed, and says how many.
  const blocked = advancementBlocked(untouched);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /no recorded human disposition/);
  assert.deepEqual(advancementBlocked(null), ['convergence has not been run for the current implementation generation']);
});

test('a disposition needs a reason unless it is rework on a deterministic fact', () => {
  // `[SPK:REQ-079]`. The exception is narrow on purpose: "this fact is real, fix it" adds nothing a
  // reader cannot already see. Every other disposition is a decision *not* to act, which is exactly
  // the one whose reasoning has to be on the record.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const factId = facts[0].id;
  /**
   * The vocabulary is a governed contract, so this list is pinned deliberately — growing it should
   * be an act somebody reviews, not a silent widening. `update-intent` was added for [AMD:REQ-010]:
   * the reality-altitude door, where the code is right and the plan was wrong.
   */
  assert.deepEqual([...DISPOSITIONS], ['rework', 'accepted-deviation', 'dismissed', 'deferred', 'update-intent']);

  assert.doesNotThrow(() => validateAdjudication({ itemId: factId, disposition: 'rework' }, { facts }));
  for (const disposition of ['accepted-deviation', 'dismissed', 'deferred']) {
    assert.throws(() => validateAdjudication({ itemId: factId, disposition }, { facts }), /needs a human-authored reason/);
    assert.doesNotThrow(() => validateAdjudication({ itemId: factId, disposition, reason: 'Considered.' }, { facts }));
  }
  assert.throws(() => validateAdjudication({ itemId: factId, disposition: 'ignore' }, { facts }), /must be one of/);
  assert.throws(() => validateAdjudication({ itemId: 'CF-nope', disposition: 'rework' }, { facts }), /unknown convergence item/);
  assert.throws(() => validateAdjudication({ disposition: 'rework' }, { facts }), /must name the fact or candidate/);
  assert.throws(
    () => validateAdjudication({ itemId: factId, disposition: 'dismissed', reason: 'x', classification: 'nope' }, { facts }),
    /classification must be one of/
  );
  assert.deepEqual([...FINDING_CLASSIFICATIONS], ['missing', 'partial', 'contradicts', 'unplanned']);
});

test('rework blocks advancement and offers only the governed change request', async () => {
  /**
   * `[SPK:AC-003]`. Selecting `rework` must not advance anything by itself — it names a blocker, and
   * the only transition offered is the existing `reject` path, which carries the approval authority,
   * the change-request record and the lifecycle transition the rest of the product already uses.
   */
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const adjudications = facts.map((fact) => ({
    itemId: fact.id, disposition: fact.kind === 'absent-observed-claim' ? 'rework' : 'dismissed',
    reason: fact.kind === 'absent-observed-claim' ? undefined : 'Refactor noise; no requirement claims it.',
    clauseIds: fact.clauseIds, ...HUMAN
  }));
  const projection = convergenceProjection({ workId: 'D-1', bindings: BINDINGS, facts, adjudications });

  assert.equal(projection.findings.length, facts.length);
  assert.ok(projection.unresolvedBlockers.length, 'rework produced no blocker');
  assert.deepEqual(projection.allowedNext, ['create-rework'], 'a blocking finding allowed something other than rework');
  assert.match(advancementBlocked(projection)[0], /is dispositioned 'rework'/);

  // Every finding carries the identity and reasoning of the person who made it.
  for (const finding of projection.findings) {
    assert.equal(finding.decision.actor, HUMAN.actor);
    assert.equal(finding.decision.at, HUMAN.at);
    assert.match(finding.id, /^GF-[0-9a-f]{12}$/);
  }

  /**
   * The CLI offers a transition the reader can actually take.
   *
   * This assertion used to pin `reject convergence --to implementation`, which reads like the
   * governed path and is unreachable: `reject` requires a submitted phase, convergence is
   * `in_progress` while its findings are being adjudicated, and the only route to submission —
   * `story advance` — is what a blocking finding prevents. The end-to-end fixture walked into that
   * deadlock; this test had been holding it in place.
   */
  const { commandFunction } = await import('./helpers/command-source.mjs');
  const converge = await commandFunction('storyConvergeCommand');
  assert.match(converge, /singularity-flow story rework --confirm/, 'convergence offers no reachable rework command');
  assert.doesNotMatch(converge, /reject convergence/, 'convergence still offers a command that cannot run from in_progress');

  // And `story rework` routes through `rejectPhase`, so rework is the existing change-request
  // transition rather than a second one invented for convergence `[SPK:AC-003]`.
  const rework = await commandFunction('storyReworkCommand');
  assert.match(rework, /rejectPhase\(root, config, workflow/, 'rework does not use the governed rejection path');
  assert.match(rework, /convergenceRework: \{/, 'rework does not present the projection that authorises it');
});

test('a resolved iteration allows advancement, and only then', () => {
  // `[SPK:REQ-183]`. Passing through convergence is a claim that a person looked at every absence of
  // evidence and said what it meant.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const resolved = convergenceProjection({
    workId: 'D-1', bindings: BINDINGS, facts,
    adjudications: facts.map((fact) => ({ itemId: fact.id, disposition: 'accepted-deviation', reason: 'Reviewed and accepted.', ...HUMAN }))
  });
  assert.deepEqual(resolved.unresolvedBlockers, []);
  assert.deepEqual(resolved.allowedNext, ['advance-to-verification']);
  assert.deepEqual(advancementBlocked(resolved), []);
});

test('the projection exposes exactly what the clause asks for', () => {
  // `[SPK:REQ-081]`, and `[SPK:REQ-080]`: raw model prose stays in the referenced candidate record,
  // because narrative text inside this document would join the evidence hash and improving a
  // sentence would invalidate the iteration it described.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const candidates = [{ id: 'CC-aaaaaaaaaaaa', classification: 'partial', clauseIds: ['D:REQ-002'], text: 'Long model prose that must not land here.' }];
  const projection = convergenceProjection({
    workId: 'D-1', bindings: BINDINGS, facts, candidates,
    candidateRecords: ['work/context/convergence/candidates-iter1.json']
  });
  for (const field of ['iteration', 'bindings', 'facts', 'candidates', 'candidateRecords', 'findings', 'unresolvedBlockers', 'allowedNext']) {
    assert.ok(field in projection, `the projection omits ${field}`);
  }
  assert.deepEqual(projection.candidates, [{ id: 'CC-aaaaaaaaaaaa', classification: 'partial', clauseIds: ['D:REQ-002'] }]);
  assert.doesNotMatch(JSON.stringify(projection.candidates), /Long model prose/, 'candidate prose leaked into the authoritative projection');
  assert.deepEqual(projection.candidateRecords, ['work/context/convergence/candidates-iter1.json']);
  assert.match(projection.convergenceSha256, /^[0-9a-f]{64}$/);
});

test('stored convergence integrity binds its projection, complete candidate snapshot and current inputs', () => {
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const payload = {
    classification: 'partial',
    clauseIds: ['D:REQ-002'],
    evidence: ['src/retry.ts'],
    factIds: [facts[0].id],
    text: 'The preserved evidence is incomplete.'
  };
  const candidate = { id: itemId('CC', payload), ...payload };
  const stored = {
    ...convergenceProjection({
      workId: 'D-1', bindings: BINDINGS, facts, candidates: [candidate],
      candidateRecords: ['work/context/convergence/candidates-iter1.json'],
      candidateRecordBindings: [{
        path: 'work/context/convergence/candidates-iter1.json', sha256: '9'.repeat(64)
      }]
    }),
    candidateSnapshot: [candidate]
  };

  assert.equal(assertConvergenceIntegrity(stored, {
    workId: 'D-1', iteration: 1, currentBindings: BINDINGS
  }), stored);
  assert.equal(decodeConvergenceRecord(serializeConvergence(stored), {
    workId: 'D-1', iteration: 1, currentBindings: BINDINGS
  }).convergenceSha256, stored.convergenceSha256);

  const changedFact = structuredClone(stored);
  changedFact.facts[0].detail = 'changed after projection';
  assert.throws(
    () => assertConvergenceIntegrity(changedFact),
    (error) => error.code === 'CONVERGENCE_RECORD_HASH_MISMATCH'
  );

  const changedCandidate = structuredClone(stored);
  changedCandidate.candidateSnapshot[0].text = 'Different complete model claim.';
  assert.throws(
    () => assertConvergenceIntegrity(changedCandidate),
    (error) => error.code === 'CONVERGENCE_RECORD_CORRUPT'
  );

  const changedBindings = structuredClone(BINDINGS);
  changedBindings.sourceTargetCommit = '9'.repeat(40);
  assert.throws(
    () => assertConvergenceIntegrity(stored, { currentBindings: changedBindings }),
    (error) => error.code === 'CONVERGENCE_BINDINGS_STALE'
  );
  assert.throws(
    () => assertConvergenceIntegrity(stored, { currentFacts: [] }),
    (error) => error.code === 'CONVERGENCE_FACTS_STALE'
  );
  assert.throws(
    () => decodeConvergenceRecord('{not-json'),
    (error) => error.code === 'CONVERGENCE_RECORD_CORRUPT' && /not valid JSON/i.test(error.message)
  );

  const reviewed = {
    ...convergenceProjection({
      workId: 'D-1', bindings: BINDINGS, facts, adjudications: [{
        itemId: facts[0].id, disposition: 'dismissed', reason: 'Reviewed against the implementation.',
        ...HUMAN
      }]
    }),
    candidateSnapshot: []
  };
  const forged = structuredClone(reviewed);
  forged.allowedNext = ['advance-to-verification'];
  forged.unresolvedBlockers = [];
  const forgedCore = structuredClone(forged);
  delete forgedCore.convergenceSha256;
  delete forgedCore.candidateSnapshot;
  forged.convergenceSha256 = recordSha256(forgedCore);
  assert.throws(
    () => assertConvergenceIntegrity(forged),
    (error) => error.code === 'CONVERGENCE_DERIVED_STATE_MISMATCH'
  );
});

test('candidate source and deterministic phase artifact are exact projections', async () => {
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const payload = {
    classification: 'partial', clauseIds: ['D:REQ-002'], evidence: ['src/retry.ts'],
    factIds: [facts[0].id], text: 'The preserved evidence is incomplete.'
  };
  const candidate = { id: itemId('CC', payload), ...payload };
  const sourceCore = {
    schemaVersion: 2, resultType: 'convergence-candidates', workId: 'D-1', iteration: 1,
    deterministic: {
      reconciliationSha256: BINDINGS.reconciliation.sha256,
      sourceTargetCommit: BINDINGS.sourceTargetCommit,
      clauseIndexSha256: BINDINGS.clauseIndexSha256,
      factIds: facts.map((item) => item.id)
    },
    candidates: [candidate], model: { provider: 'fixture', model: null, invocationId: 'fixture' },
    promptSha256: '7'.repeat(64), usage: { status: 'unavailable' },
    generatedAt: '2026-01-01T00:00:00.000Z', unknownReferences: { factIds: [], clauseIds: [] },
    disclaimer: 'fixture'
  };
  const source = { ...sourceCore, recordSha256: recordSha256(sourceCore) };
  const sourcePath = 'work/context/convergence/candidates-iter1.json';
  const projection = {
    ...convergenceProjection({
      workId: 'D-1', bindings: BINDINGS, facts, candidates: [candidate],
      candidateRecords: [sourcePath],
      candidateRecordBindings: [{ path: sourcePath, sha256: source.recordSha256 }]
    }),
    candidateSnapshot: [candidate]
  };
  assert.equal(assertConvergenceCandidateSource(source, projection), source);
  const wrongSource = structuredClone(source);
  wrongSource.deterministic.sourceTargetCommit = '0'.repeat(40);
  wrongSource.recordSha256 = recordSha256(Object.fromEntries(
    Object.entries(wrongSource).filter(([key]) => key !== 'recordSha256')
  ));
  assert.throws(
    () => assertConvergenceCandidateSource(wrongSource, projection),
    (error) => error.code === 'CONVERGENCE_CANDIDATE_BINDINGS_STALE'
  );
  const sourceLess = { ...projection, candidateRecords: [] };
  sourceLess.convergenceSha256 = convergenceProjection({
    workId: sourceLess.workId,
    bindings: sourceLess.bindings,
    facts: sourceLess.facts,
    candidates: sourceLess.candidateSnapshot,
    candidateRecords: [],
    candidateRecordBindings: [],
    adjudications: []
  }).convergenceSha256;
  await assert.rejects(
    () => assertConvergenceSources('/repository-is-not-needed-for-this-check', sourceLess),
    (error) => error.code === 'CONVERGENCE_CANDIDATE_RECORD_MISSING'
  );

  const markdown = renderConvergenceArtifact(projection);
  assert.match(markdown, /Deterministically rendered from the kernel-owned convergence projection/);
  assert.match(markdown, new RegExp(projection.convergenceSha256));
  assert.match(markdown, new RegExp(candidate.id));
  assert.doesNotMatch(markdown, /TODO|TBD/);
  assert.throws(
    () => assertConvergencePublishable(projection, markdown),
    (error) => error.code === 'CONVERGENCE_REVIEW_REQUIRED'
      && error.details.allowedNext.includes('adjudicate')
  );

  const clear = {
    ...convergenceProjection({ workId: 'D-1', bindings: BINDINGS }),
    candidateSnapshot: []
  };
  const canonical = renderConvergenceArtifact(clear);
  assert.equal(assertConvergencePublishable(clear, canonical), clear);
  assert.equal(assertConvergencePublishable(clear, `${canonical}\n\n`), clear,
    'trailing formatting whitespace changed deterministic publication identity');
  assert.throws(
    () => assertConvergencePublishable(clear, `${canonical}\nThis sentence was hand-authored.`),
    (error) => error.code === 'CONVERGENCE_ARTIFACT_MISMATCH'
  );

  const quotedPayload = {
    classification: 'partial', clauseIds: ['D:REQ-002'], evidence: [], factIds: [],
    text: 'The source says TODO and {{placeholder}}; this is quoted evidence.'
  };
  const quotedCandidate = { id: itemId('CC', quotedPayload), ...quotedPayload };
  const quotedTemplateMarker = {
    ...convergenceProjection({
      workId: 'D-1', bindings: BINDINGS,
      candidates: [quotedCandidate],
      adjudications: [{
        itemId: quotedCandidate.id,
        disposition: 'dismissed',
        reason: 'The quoted marker is evidence, not an unfinished artifact.',
        ...HUMAN
      }]
    }),
    candidateSnapshot: [quotedCandidate]
  };
  const quotedArtifact = renderConvergenceArtifact(quotedTemplateMarker);
  assert.match(quotedArtifact, /TODO.*\{\{placeholder\}\}/,
    'canonical rendering silently rewrote quoted convergence evidence');
  assert.equal(assertConvergencePublishable(quotedTemplateMarker, quotedArtifact), quotedTemplateMarker,
    'quoted placeholder text made a reviewed canonical projection unpublishable');
});

test('a migrated legacy projection stays bound to its lossless archive', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-convergence-legacy-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const itemRelative = '.sdlc/work-items/LEGACY-1';
  const legacy = {
    schemaVersion: 1,
    resultType: 'convergence',
    workId: 'LEGACY-1',
    iteration: 1,
    bindings: { iteration: 1 },
    facts: [], candidates: [],
    candidateRecords: [`${itemRelative}/context/convergence/candidates-iter1.json`], findings: [],
    unresolvedBlockers: [], allowedNext: ['advance-to-verification']
  };
  legacy.convergenceSha256 = recordSha256(legacy);
  const sourceBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`);
  const sourceSha256 = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`;
  const candidateBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    resultType: 'convergence-candidates',
    workId: 'LEGACY-1',
    iteration: 1,
    deterministic: {
      reconciliationSha256: null,
      sourceTargetCommit: null,
      clauseIndexSha256: [],
      factIds: []
    },
    candidates: []
  }, null, 2)}\n`);
  const candidateBinding = {
    path: legacy.candidateRecords[0],
    sha256: `sha256:${createHash('sha256').update(candidateBytes).digest('hex')}`,
    bytes: candidateBytes.length
  };
  const plan = {
    schemaVersion: 1,
    kind: 'convergence-legacy-migration-plan',
    workId: 'LEGACY-1',
    iteration: 1,
    source: {
      path: `${itemRelative}/context/convergence/iteration-1.json`,
      sha256: sourceSha256,
      bytes: sourceBytes.length
    },
    candidateBindings: [candidateBinding]
  };
  const planSha256 = `sha256:${recordSha256(plan)}`;
  const archiveRelative = `${itemRelative}/context/convergence/legacy/iteration-1-${planSha256.slice(7)}.json`;
  const archive = {
    schemaVersion: 1,
    kind: 'convergence-legacy-archive',
    workId: 'LEGACY-1',
    iteration: 1,
    planSha256,
    source: plan.source,
    candidateBindings: [{
      ...candidateBinding,
      bytesBase64: candidateBytes.toString('base64')
    }],
    sourceBytesBase64: sourceBytes.toString('base64'),
    recordSha256: null
  };
  const archiveCore = structuredClone(archive);
  delete archiveCore.recordSha256;
  archive.recordSha256 = recordSha256(archiveCore);
  await mkdir(path.join(root, path.dirname(archiveRelative)), { recursive: true });
  await writeFile(path.join(root, archiveRelative), `${JSON.stringify(archive, null, 2)}\n`);
  const projection = {
    ...convergenceProjection({
      workId: 'LEGACY-1', bindings: { iteration: 1 }, facts: [],
      legacyMigration: { path: archiveRelative, recordSha256: archive.recordSha256 }
    }),
    candidateSnapshot: []
  };

  assert.equal(assertConvergenceIntegrity(projection), projection,
    'a custom workItemRoot must not invalidate its own exact legacy archive path');
  const verified = await assertConvergenceSources(root, projection, { itemRelative });
  assert.equal(verified.at(-1).recordSha256, archive.recordSha256);

  // Adjudication rebuilds the sealed projection. The immutable legacy archive must remain part of
  // that new seal so every later publication/approval guard still verifies the bytes it replaced.
  const adjudicated = adjudicatedConvergenceProjection(projection, []);
  assert.deepEqual(adjudicated.legacyMigration, projection.legacyMigration);
  await assertConvergenceSources(root, adjudicated, { itemRelative });

  const { commandFunction } = await import('./helpers/command-source.mjs');
  assert.match(
    await commandFunction('storyAdjudicateCommand'),
    /adjudicatedConvergenceProjection\(existing,\s*\[\.\.\.kept,\s*\.\.\.decisions\]\)/,
    'the adjudication command can sever the migrated evidence chain'
  );

  // Re-signing a self-consistent archive/projection cannot erase a v1 candidate source: the
  // verifier reconstructs the confirmation plan and compares its bindings with the preserved v1
  // projection rather than trusting the archive's claimed plan digest.
  const omitted = structuredClone(archive);
  omitted.candidateBindings = [];
  const omittedPlan = { ...plan, candidateBindings: [] };
  omitted.planSha256 = `sha256:${recordSha256(omittedPlan)}`;
  delete omitted.recordSha256;
  omitted.recordSha256 = recordSha256(omitted);
  const omittedRelative = `${itemRelative}/context/convergence/legacy/iteration-1-${omitted.planSha256.slice(7)}.json`;
  await writeFile(path.join(root, omittedRelative), `${JSON.stringify(omitted, null, 2)}\n`);
  const omittedProjection = {
    ...convergenceProjection({
      workId: 'LEGACY-1', bindings: { iteration: 1 }, facts: [],
      legacyMigration: { path: omittedRelative, recordSha256: omitted.recordSha256 }
    }),
    candidateSnapshot: []
  };
  await assert.rejects(
    () => assertConvergenceSources(root, omittedProjection, { itemRelative }),
    (error) => error.code === 'CONVERGENCE_LEGACY_ARCHIVE_BINDING_MISMATCH'
  );

  assert.throws(
    () => assertLegacyConvergenceSourceIdentity({ ...legacy, workId: 'OTHER-STORY' }, {
      workId: 'LEGACY-1', iteration: 1
    }),
    (error) => error.code === 'CONVERGENCE_LEGACY_SUBJECT_MISMATCH'
  );
  const migratedCandidate = readRecord('assisted-convergence', candidateBytes).record;
  assert.throws(
    () => assertLegacyConvergenceSourceIdentity(legacy, {
      workId: 'LEGACY-1', iteration: 1, candidate: { ...migratedCandidate, iteration: 2 }
    }),
    (error) => error.code === 'CONVERGENCE_LEGACY_CANDIDATE_SUBJECT_MISMATCH'
  );

  assert.match(
    await readFile(new URL('../src/commands/story.mjs', import.meta.url), 'utf8'),
    /assertLegacyConvergenceSourceIdentity/,
    'the live migration command does not bind v1 source identity before archival'
  );

  const altered = structuredClone(archive);
  altered.sourceBytesBase64 = Buffer.from('different bytes').toString('base64');
  await writeFile(path.join(root, archiveRelative), `${JSON.stringify(altered, null, 2)}\n`);
  await assert.rejects(
    () => assertConvergenceSources(root, adjudicated, { itemRelative }),
    (error) => error.code === 'CONVERGENCE_LEGACY_ARCHIVE_BINDING_MISMATCH'
  );
  await rm(path.join(root, archiveRelative));
  await assert.rejects(
    () => assertConvergenceSources(root, adjudicated, { itemRelative }),
    /does not exist/
  );
});

test('same-iteration convergence writes are serialized by the Story mutation lease', async () => {
  const { commandFunction, commandLayerSource } = await import('./helpers/command-source.mjs');
  const converge = await commandFunction('storyConvergeCommand');
  const source = await commandLayerSource();
  const service = source.slice(
    source.indexOf('export async function prepareDeterministicConvergence'),
    source.indexOf('export async function storyConvergeCommand')
  );
  const adjudicate = await commandFunction('storyAdjudicateCommand');
  const advance = await commandFunction('storyAdvanceCommand');
  assert.match(converge, /prepareDeterministicConvergence\(/);
  assert.match(service, /withConvergenceDraft\(/);
  assert.match(service, /await preparePhase\(/,
    'the shared service can emit a projection without refreshing managed phase inputs');
  assert.match(adjudicate, /withConvergenceDraft\(/);
  assert.match(advance, /withSubjectLock\(root, \{ kind: 'story'/);
  for (const source of [adjudicate, advance]) {
    assert.match(source, /currentBindings: bindings/, 'a human transition does not re-check current bindings');
    assert.match(source, /currentFacts: facts/, 'a human transition does not re-check deterministic facts');
    assert.match(source, /assertConvergenceSources/, 'a human transition does not re-check the complete candidate source');
  }
});

test('publication rechecks current bindings, facts, candidate sources, and canonical bytes before mutation', async () => {
  const source = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  const guard = await readFile(new URL('../src/convergence-context.mjs', import.meta.url), 'utf8');
  const publication = source.slice(
    source.indexOf('export async function publishGeneration'),
    source.indexOf('export async function submitPhase')
  );
  assert.match(guard, /currentConvergenceContext\(root, config, workflow\)/);
  assert.match(guard, /currentBindings: current\.bindings/);
  assert.match(guard, /currentFacts: current\.facts/);
  assert.match(guard, /await assertConvergenceSources\(root, projection/);
  assert.match(guard, /assertConvergencePublishable\(projection, authored\)/);
  assert.ok(
    publication.indexOf('await assertConvergencePublicationReady')
      < publication.indexOf('const contentFindings'),
    'generic content handling ran before exact deterministic convergence verification'
  );
  assert.match(publication, /const contentFindings = deterministicConvergence\s*\? \[\]/,
    'quoted evidence can still be mistaken for an unfinished human template');
});

test('an assisted rerun selects only its latest complete candidate source', async () => {
  const { commandLayerSource } = await import('./helpers/command-source.mjs');
  const source = await commandLayerSource();
  const service = source.slice(
    source.indexOf('export async function prepareDeterministicConvergence'),
    source.indexOf('export async function storyConvergeCommand')
  );
  assert.match(service, /candidateRecords: assistedResult \? \[assistedResult\.path\] : \(previous\?\.candidateRecords \?\? \[\]\)/);
  assert.doesNotMatch(service, /\.\.\.\(previous\?\.candidateRecords/,
    'a new assisted snapshot retained stale candidate sources that can no longer equal it');
});

test('the kernel refuses configuration that would loop implementation and convergence', () => {
  /**
   * `[SPK:CON-037]`. The temptation is obvious — "keep implementing and converging until no findings
   * remain" — and it removes exactly the step convergence exists for while appearing to honour it.
   * Refused at load, because by the time it is running there is no honest place to stop it.
   */
  for (const key of ['repeatUntil', 'autoRepeat', 'autoAdvance', 'loopUntil', 'maxIterationsAuto']) {
    assert.throws(() => assertNoAutonomousConvergence({ [key]: true }, 'convergence'), /which the kernel refuses/, `${key} was accepted`);
  }
  assert.doesNotThrow(() => assertNoAutonomousConvergence({ label: 'Convergence' }, 'convergence'));
  assert.doesNotThrow(() => assertNoAutonomousConvergence(null));
});

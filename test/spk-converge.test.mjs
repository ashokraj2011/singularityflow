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
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DISPOSITIONS, FACT_KINDS, FINDING_CLASSIFICATIONS, advancementBlocked,
  assertNoAutonomousConvergence, convergenceBindings, convergenceFacts, convergenceProjection,
  itemId, serializeConvergence, validateAdjudication
} from '../src/convergence.mjs';

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
  const cli = withoutComments(await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8'));
  const converge = cli.slice(cli.indexOf('async function storyConvergeCommand'), cli.indexOf('function convergenceSourceRef'));
  assert.match(converge, /singularity-flow story rework --confirm/, 'convergence offers no reachable rework command');
  assert.doesNotMatch(converge, /reject convergence/, 'convergence still offers a command that cannot run from in_progress');

  // And `story rework` routes through `rejectPhase`, so rework is the existing change-request
  // transition rather than a second one invented for convergence `[SPK:AC-003]`.
  const rework = cli.slice(cli.indexOf('async function storyReworkCommand'), cli.indexOf('async function storyAdvanceCommand'));
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

/**
 * Kernel-owned convergence. `[SPK:AC-007]`
 *
 * Convergence is the one place in this product where the kernel is most tempted to overstate what it
 * knows. It can see that nobody claimed a requirement; it cannot see whether the requirement was
 * implemented. `[SPK:CON-033]` draws that line, and most of what is asserted here is that the line
 * holds — in the wording of every fact, in the refusal to re-enumerate paths, and in the rule that
 * nothing becomes a governed finding without a human saying so.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DISPOSITIONS, FACT_KINDS, FINDING_CLASSIFICATIONS, advancementBlocked,
  assertNoAutonomousConvergence, convergenceBindings, convergenceFacts, convergenceProjection,
  itemId, serializeConvergence, validateAdjudication
} from '../src/convergence.mjs';
import {
  CANDIDATE_KINDS, assistedConvergencePrompt, buildAssistedConvergenceRecord,
  parseConvergenceCandidates, unknownReferences
} from '../src/assisted-convergence.mjs';
import { unwrapProviderLineBreaks } from '../src/assisted-quality.mjs';

const RECONCILIATION = Object.freeze({
  reconciliationSha256: 'a'.repeat(64),
  path: 'work/context/work-intervals/reconciliations/a.json',
  intervalId: 'INT-1',
  sourceBaseCommit: 'b'.repeat(40),
  target: { head: 'c'.repeat(40) },
  findings: [
    { path: 'src/retry.ts', verdict: 'planned', clauseIds: ['D:REQ-001'] },
    { path: 'src/stray.ts', verdict: 'unplanned', clauseIds: [] }
  ]
});

const INDEXES = [{ indexSha256: 'd'.repeat(64), clauses: [
  { id: 'D:REQ-001', body: 'The system creates a new attempt.' },
  { id: 'D:REQ-002', body: 'The system preserves the original.' }
] }];

const OBSERVED = [{ recordSha256: 'e'.repeat(64), claims: {
  'D:REQ-001': { verdict: 'matched', observedPaths: ['src/retry.ts'] }
} }];

const bind = (overrides = {}) => convergenceBindings({
  iteration: 1, indexes: INDEXES, reconciliation: RECONCILIATION, observed: OBSERVED, ...overrides
});

test('an absence of record is reported as an absence of record', () => {
  /**
   * `[SPK:CON-033]`, and the single most important behaviour in this module. The kernel cannot see
   * whether code satisfies a requirement. Saying "REQ-002 is unimplemented" would be a claim it has
   * no way to support, and the moment a governance tool overstates once, its findings get argued
   * with rather than acted on.
   */
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const absent = facts.find((item) => item.kind === 'absent-observed-claim');
  assert.deepEqual(absent.clauseIds, ['D:REQ-002']);
  assert.match(absent.detail, /missing trace evidence, not proof that the requirement is unimplemented/);

  const unclaimed = facts.find((item) => item.kind === 'unclaimed-changed-path');
  assert.deepEqual(unclaimed.paths, ['src/stray.ts']);
  assert.match(unclaimed.detail, /missing trace evidence, not a finding that the change was unplanned/);

  /**
   * No fact may assert implementation state. The phrases below are allowed only inside the sentence
   * that *denies* them, which is the whole point of the wording — so the check is that every
   * occurrence is preceded by the denial, not that the words never appear.
   */
  for (const item of facts) {
    for (const claim of ['unimplemented', 'unplanned']) {
      const at = item.detail.indexOf(claim);
      if (at === -1) continue;
      assert.match(
        item.detail.slice(0, at), /\bnot (?:proof that|a finding that)\b/,
        `${item.id} asserts '${claim}' rather than denying it: ${item.detail}`
      );
    }
  }
});

test('the changed paths come from reconciliation and are never re-derived', async () => {
  // `[SPK:CON-031]` `[SPK:CON-032]`. A second path enumeration is a second answer to a question that
  // already has one, and the two would eventually disagree about the same Story.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const paths = facts.flatMap((item) => item.paths);
  assert.deepEqual([...new Set(paths)], ['src/stray.ts'], 'a path outside the reconciliation record appeared');

  // A claimed path is accounted for and drops out; an empty reconciliation yields no path facts.
  const empty = convergenceFacts({ reconciliation: { ...RECONCILIATION, findings: [] }, indexes: INDEXES, observed: OBSERVED });
  assert.deepEqual(empty.filter((item) => item.kind === 'unclaimed-changed-path'), []);

  const source = await readFile(new URL('../src/convergence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /changedRepositoryPaths|\['diff/, 'convergence enumerates paths of its own');
});

test('every fact kind the clause names is reachable', () => {
  // `[SPK:REQ-074]`. A declared kind nothing can produce is the defect this codebase keeps finding,
  // so each one is provoked here rather than trusted.
  const facts = convergenceFacts({
    reconciliation: RECONCILIATION,
    indexes: INDEXES,
    planned: [{ claims: { 'D:REQ-002': { tests: ['test/a.test.mjs'], deviation: 'the store lands later' } } }],
    observed: [{ claims: {
      'D:REQ-001': { verdict: 'matched', observedPaths: ['src/retry.ts'] },
      'D:REQ-002': { verdict: 'partial', observedPaths: [] },
      'D:REQ-404': { verdict: 'matched', observedPaths: ['src/gone.ts'] }
    } }],
    acceptance: { missingPlannedTests: ['D:REQ-001'], missingObservedTests: ['D:REQ-002'], failedCommands: ['unit'], staleRunReasons: [] },
    requiredEvidence: [{ kind: 'coverage report', path: 'evidence/coverage.json', present: false }],
    // `D:REQ-001` carries a `matched` verdict, so naming it as revised provokes
    // `verdict-against-superseded-clause` [AMD:REQ-050] — a verdict recorded against wording the
    // specification no longer has.
    amendedClauses: ['D:REQ-001']
  });
  const kinds = new Set(facts.map((item) => item.kind));
  for (const kind of FACT_KINDS) assert.ok(kinds.has(kind), `no input produces a '${kind}' fact`);
});

test('exact AC test-only evidence is not mislabeled as a stale source binding', () => {
  const facts = convergenceFacts({
    reconciliation: { ...RECONCILIATION, findings: [] },
    indexes: [{ clauses: [{ id: 'D:AC-001', body: 'The computed result is observable.' }] }],
    planned: [{ claims: {
      'D:AC-001': { expectedPaths: [], tests: ['test/result.test.mjs'], testDisposition: 'applicable' }
    } }],
    observed: [{ claims: {
      'D:AC-001': {
        verdict: 'matched', observedPaths: [], testResults: ['test/result.test.mjs']
      }
    } }]
  });
  assert.equal(facts.some((item) => item.kind === 'stale-claim-binding'), false);
  assert.equal(facts.some((item) => item.kind === 'absent-observed-claim'), false);
});

test('convergence accumulates evidence from multiple code-delivery intervals', () => {
  const facts = convergenceFacts({
    reconciliation: { ...RECONCILIATION, findings: [] },
    indexes: [{ clauses: [{ id: 'D:REQ-001', body: 'Both delivery slices are required.' }] }],
    planned: [
      { phase: 'backend', generation: 1, claims: {
        'D:REQ-001': { expectedPaths: ['src/backend.ts'], tests: ['test/backend.test.ts'] }
      } },
      { phase: 'frontend', generation: 1, claims: {
        'D:REQ-001': { expectedPaths: ['src/frontend.ts'], tests: ['test/frontend.test.ts'] }
      } }
    ],
    observed: [
      { phase: 'backend', generation: 1, claims: {
        'D:REQ-001': {
          verdict: 'partial', observedPaths: ['src/backend.ts'], testResults: ['test/backend.test.ts']
        }
      } },
      { phase: 'frontend', generation: 1, claims: {
        'D:REQ-001': {
          verdict: 'partial', observedPaths: ['src/frontend.ts'], testResults: ['test/frontend.test.ts']
        }
      } }
    ]
  });
  assert.equal(facts.some((item) => item.kind === 'absent-observed-claim'), false);
  assert.equal(facts.some((item) => item.kind === 'stale-claim-binding'), false);
});

test('the same bound inputs always produce the same facts, and the same IDs', () => {
  // `[SPK:REQ-075]` and `[SPK:REQ-078]`. Content-derived IDs are what let a reviewer recognise an
  // item they already dismissed; a counter would rename it every iteration and hide the repetition.
  const first = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const second = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  assert.deepEqual(first, second);
  for (const item of first) assert.match(item.id, /^CF-[0-9a-f]{12}$/);

  // The identity survives a re-run against a later iteration of the same unresolved problem.
  const later = convergenceFacts({
    reconciliation: { ...RECONCILIATION, reconciliationSha256: 'f'.repeat(64) }, indexes: INDEXES, observed: OBSERVED
  });
  assert.equal(
    later.find((item) => item.kind === 'absent-observed-claim').id,
    first.find((item) => item.kind === 'absent-observed-claim').id
  );
  assert.notEqual(itemId('CF', { kind: 'a' }), itemId('CF', { kind: 'b' }));
});

test('an iteration binds everything it was computed from', () => {
  // `[SPK:REQ-072]`. Without the binding a convergence record is an opinion about "the code", and
  // nobody can later tell which code that was.
  const bindings = bind({
    configurationSha256: '1'.repeat(64),
    specification: { generation: 2, sha256: '2'.repeat(64) },
    planning: { generation: 1, sha256: '3'.repeat(64) },
    planned: [{ recordSha256: '4'.repeat(64) }],
    evidence: [{ sha256: '5'.repeat(64) }]
  });
  for (const field of [
    'iteration', 'configurationSha256', 'constitutionSha256', 'specification', 'planning',
    'clauseIndexSha256', 'reconciliation', 'sourceBaseCommit', 'sourceTargetCommit',
    'plannedClaimsSha256', 'observedClaimsSha256', 'evidenceSha256'
  ]) assert.ok(field in bindings, `the binding omits ${field}`);
  assert.equal(bindings.reconciliation.sha256, RECONCILIATION.reconciliationSha256);
  assert.equal(bindings.sourceTargetCommit, RECONCILIATION.target.head);
  assert.throws(() => convergenceBindings({ iteration: 0, reconciliation: RECONCILIATION }), /positive integer/);
  assert.throws(() => convergenceBindings({ iteration: 1, reconciliation: {} }), /reconciliation record hash/);
});

test('a disposition needs a reason, and only one case is exempt', () => {
  /**
   * `[SPK:REQ-079]`. The exemption is narrow and deliberate: "this fact is real, fix it" adds
   * nothing a reader cannot see in the fact itself. Every other disposition is a decision *not* to
   * act, and that is precisely the one whose reasoning has to be on the record.
   */
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const factId = facts[0].id;
  const candidates = [{ id: 'CC-abc123abc123', classification: 'partial', clauseIds: ['D:REQ-002'] }];

  /**
   * The vocabulary is a governed contract, so this list is pinned deliberately — growing it should
   * be an act somebody reviews, not a silent widening. `update-intent` was added for [AMD:REQ-010]:
   * the reality-altitude door, where the code is right and the plan was wrong.
   */
  assert.deepEqual([...DISPOSITIONS], ['rework', 'accepted-deviation', 'dismissed', 'deferred', 'update-intent']);
  assert.equal(validateAdjudication({ itemId: factId, disposition: 'rework' }, { facts }).disposition, 'rework');
  for (const disposition of ['accepted-deviation', 'dismissed', 'deferred']) {
    assert.throws(
      () => validateAdjudication({ itemId: factId, disposition }, { facts }),
      /needs a human-authored reason/,
      `${disposition} was accepted with no reason`
    );
  }
  // Even rework needs one when it is an assisted candidate being confirmed, because there the
  // decision is that the model was right — which is a judgement, not a restatement.
  assert.throws(
    () => validateAdjudication({ itemId: 'CC-abc123abc123', disposition: 'rework' }, { facts, candidates }),
    /Only rework on a deterministic fact may go unexplained/
  );
  assert.throws(() => validateAdjudication({ itemId: 'CF-000000000000', disposition: 'rework' }, { facts }), /unknown convergence item/);
  assert.throws(() => validateAdjudication({ itemId: factId, disposition: 'approve' }, { facts }), /must be one of/);
  assert.throws(
    () => validateAdjudication({ itemId: factId, disposition: 'rework', classification: 'bad' }, { facts }),
    /classification must be one of/
  );
  assert.deepEqual([...FINDING_CLASSIFICATIONS], ['missing', 'partial', 'contradicts', 'unplanned']);
});

test('the projection exposes what the clause asks for, and nothing becomes a finding on its own', () => {
  // `[SPK:REQ-080]` `[SPK:REQ-081]` `[SPK:CON-035]`.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const candidates = [{ id: 'CC-abc123abc123', classification: 'partial', clauseIds: ['D:REQ-002'], text: 'Looks partial.' }];
  const bare = convergenceProjection({ workId: 'D-1', bindings: bind(), facts, candidates, candidateRecords: ['work/context/convergence/candidates-iter1.json'] });

  for (const field of ['iteration', 'bindings', 'facts', 'candidates', 'candidateRecords', 'findings', 'unresolvedBlockers', 'allowedNext']) {
    assert.ok(field in bare, `the projection omits ${field}`);
  }
  assert.deepEqual(bare.findings, [], 'an item became a governed finding without a human');
  assert.deepEqual(bare.allowedNext, ['adjudicate']);
  // Candidate prose stays in the referenced record `[SPK:REQ-080]`: narrative inside the projection
  // would join the evidence hash, and rewording it would invalidate the iteration it described.
  assert.equal('text' in bare.candidates[0], false, 'model prose was copied into convergence.json');
  assert.match(bare.candidateRecords[0], /candidates-iter1\.json$/);

  const at = '2026-01-01T00:00:00.000Z';
  const disposed = convergenceProjection({
    workId: 'D-1', bindings: bind(), facts, candidates,
    adjudications: [
      ...facts.map((item) => ({ itemId: item.id, disposition: 'rework', actor: 'reviewer', at })),
      { itemId: 'CC-abc123abc123', disposition: 'dismissed', reason: 'Already covered by REQ-001.', actor: 'reviewer', at }
    ]
  });
  assert.equal(disposed.findings.length, facts.length + 1);
  assert.equal(disposed.unresolvedBlockers.length, facts.length);
  assert.deepEqual(disposed.allowedNext, ['create-rework']);
  for (const finding of disposed.findings) assert.match(finding.id, /^GF-[0-9a-f]{12}$/);
  // Byte-stable, so re-running an unchanged iteration rewrites identically `[SPK:REQ-075]`.
  assert.equal(serializeConvergence(disposed), serializeConvergence(convergenceProjection({
    workId: 'D-1', bindings: bind(), facts, candidates,
    adjudications: [
      ...facts.map((item) => ({ itemId: item.id, disposition: 'rework', actor: 'reviewer', at })),
      { itemId: 'CC-abc123abc123', disposition: 'dismissed', reason: 'Already covered by REQ-001.', actor: 'reviewer', at }
    ]
  })));
});

test('advancement is refused while anything is open', () => {
  // `[SPK:REQ-183]`. Passing through convergence is a claim that a person looked at every absence of
  // evidence and said what it meant; an undisposed item means nobody has.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const at = '2026-01-01T00:00:00.000Z';

  assert.match(advancementBlocked(null)[0], /has not been run/);
  const open = convergenceProjection({ workId: 'D-1', bindings: bind(), facts });
  assert.match(advancementBlocked(open)[0], /no recorded human disposition/);

  const blocked = convergenceProjection({
    workId: 'D-1', bindings: bind(), facts,
    adjudications: facts.map((item) => ({ itemId: item.id, disposition: 'rework', actor: 'r', at }))
  });
  assert.equal(advancementBlocked(blocked).length, facts.length);
  assert.match(advancementBlocked(blocked)[0], /is dispositioned 'rework'/);

  const clear = convergenceProjection({
    workId: 'D-1', bindings: bind(), facts,
    adjudications: facts.map((item) => ({ itemId: item.id, disposition: 'accepted-deviation', reason: 'Tracked separately.', actor: 'r', at }))
  });
  assert.deepEqual(advancementBlocked(clear), []);
  assert.deepEqual(clear.allowedNext, ['advance-to-verification']);
});

test('a configuration that would loop the cycle by itself is refused at load', () => {
  /**
   * `[SPK:CON-037]`. The temptation is obvious — "keep implementing and converging until no findings
   * remain" — and it removes the only step that makes convergence worth having, while looking like
   * it honours it. Refused at load, because a running loop has no honest place to stop.
   */
  for (const key of ['repeatUntil', 'autoRepeat', 'autoAdvance', 'loopUntil', 'maxIterationsAuto']) {
    assert.throws(
      () => assertNoAutonomousConvergence({ [key]: true }, 'convergence'),
      /would repeat implementation and convergence until a condition became true/,
      `${key} was accepted`
    );
  }
  assert.doesNotThrow(() => assertNoAutonomousConvergence({ label: 'Convergence', approval: {} }, 'convergence'));
  assert.doesNotThrow(() => assertNoAutonomousConvergence(null));
});

test('assisted candidates reference the deterministic facts and cannot become them', () => {
  // `[SPK:REQ-076]` `[SPK:REQ-077]` `[SPK:CON-034]`.
  const facts = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, observed: OBSERVED });
  const prompt = assistedConvergencePrompt({
    clauses: INDEXES[0].clauses,
    observedClaims: OBSERVED[0].claims,
    changedPaths: RECONCILIATION.findings,
    facts,
    namespace: 'D'
  });
  assert.match(prompt, /Do NOT repeat, dispute, re-rank or re-word the deterministic facts/);
  assert.match(prompt, /You are proposing, not deciding/);
  for (const kind of CANDIDATE_KINDS) assert.ok(prompt.includes(kind), `the prompt never names '${kind}'`);
  // Bounded evidence, not the repository: the model sees what reconciliation already reported.
  assert.match(prompt, /src\/stray\.ts \(unplanned\)/);
  assert.ok(facts.every((item) => prompt.includes(item.id)), 'the facts were not handed to the model');

  const candidates = parseConvergenceCandidates(
    '{"candidates":[{"kind":"partial","clauseIds":["D:REQ-002"],"evidence":["src/retry.ts"],"factIds":["' + facts[0].id + '"],"text":"Only half of it is there."}]}',
    { unwrap: unwrapProviderLineBreaks }
  );
  assert.match(candidates[0].id, /^CC-[0-9a-f]{12}$/, 'a candidate ID must not be mistakable for a fact ID');

  const record = buildAssistedConvergenceRecord({
    workId: 'D-1', bindings: bind(), facts, candidates,
    invocation: { provider: 'copilot-cli', model: 'gpt-5', invocationId: 'inv-1', usage: { status: 'exact' } },
    prompt, generatedAt: '2026-01-01T00:00:00.000Z'
  });
  // The facts are referenced by ID and hash, never copied, so there is nothing here to have changed.
  assert.deepEqual(record.deterministic.factIds, facts.map((item) => item.id));
  assert.equal('facts' in record, false, 'the candidate record carries a copy of the deterministic facts');
  assert.equal(record.deterministic.reconciliationSha256, RECONCILIATION.reconciliationSha256);
  assert.match(record.promptSha256, /^[0-9a-f]{64}$/);
  assert.match(record.disclaimer, /not deterministic facts/);

  // Invented references are surfaced, not deleted.
  const invented = parseConvergenceCandidates('{"candidates":[{"kind":"missing","clauseIds":["D:REQ-909"],"factIds":["CF-000000000000"],"text":"x"}]}', { unwrap: unwrapProviderLineBreaks });
  assert.deepEqual(unknownReferences(invented, { factIds: facts.map((item) => item.id), clauseIds: ['D:REQ-001'] }), {
    factIds: ['CF-000000000000'], clauseIds: ['D:REQ-909']
  });
  assert.throws(() => parseConvergenceCandidates('{"candidates":[{"kind":"probably","text":"x"}]}', { unwrap: unwrapProviderLineBreaks }), /expected one of/);
  assert.throws(() => parseConvergenceCandidates('not json', { unwrap: unwrapProviderLineBreaks }), /did not return the requested JSON/);
});

test('the agent that runs convergence cannot approve, reopen or advance', async () => {
  /**
   * `[SPK:CON-036]`, checked structurally. `story converge` computes and writes a projection; the
   * three acts it must not perform live in commands a human runs, and the surest way to keep that
   * true is for the converge path to contain none of their calls.
   */
  const cli = await (await import('./helpers/command-source.mjs')).commandLayerSource();
  const converge = cli.slice(
    cli.indexOf('async function storyConvergeCommand'),
    cli.indexOf('async function storyAdjudicateCommand')
  );
  for (const forbidden of ['approvePhase(', 'rejectPhase(', 'submitCommand(', 'publishGeneration(']) {
    assert.equal(converge.includes(forbidden), false, `story converge calls ${forbidden}`);
  }
  // And the human commands do exist, so the refusal above is a boundary rather than an omission.
  for (const command of ['storyAdjudicateCommand', 'storyReworkCommand', 'storyAdvanceCommand']) {
    assert.ok(cli.includes(`async function ${command}`), `${command} is missing`);
  }
  // Rework goes through the ordinary rejection path `[SPK:REQ-182]`, not a parallel transition.
  const rework = cli.slice(cli.indexOf('async function storyReworkCommand'), cli.indexOf('async function storyAdvanceCommand'));
  assert.match(rework, /rejectPhase\(root, config, workflow/, 'rework does not use the existing rejection path');
  assert.match(rework, /target: 'implementation'/);
});

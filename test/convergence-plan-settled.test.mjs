/**
 * Convergence stops asking what the approved plan answered. 10 of the 11 adjudications recorded on
 * real Stories repeated the plan: 8 planned supporting files and 2 plan amendments. A path the plan
 * accounts for is no longer a question and stays on the record; only what really counts may settle
 * one; and every record written before this reads and verifies as it did.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  adjudicatedConvergenceProjection, advancementBlocked, assertConvergenceIntegrity, assertConvergencePublishable,
  convergenceBindings, convergenceFacts, convergenceProjection, decodeConvergenceRecord, renderConvergenceArtifact,
  serializeConvergence, validateAdjudication
} from '../src/convergence.mjs';
import { convergencePreparationState } from '../src/commands/shared/convergence-preparation-state.mjs';
import { countedConvergence } from '../src/presence/counted-convergence.mjs';
import { forgetPersonCounts, presencePinKey, registerPersonCounts } from '../src/presence/counted.mjs';
import { pathsKeptByPerson, planAccounts, settleChangedPaths } from '../src/plan-accounts.mjs';
import { recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';

const WORK = 'BIN-1';
const REQ = 'BIN:REQ-001';
const GROUP = 'architecture-reviewers';
const present = (file, fields = {}) => ({ path: file, status: 'present', sha256: 'a'.repeat(64), bytes: 10, verdict: 'unplanned', clauseIds: [], protected: false, ...fields });
const SUPPORTING = [
  ['package.json', 'build-configuration', 'add the browser test dependency and its script.'],
  ['package-lock.json', 'dependency-lock', 'lock the browser test dependency.'],
  ['playwright.config.js', 'build-configuration', 'configure the browser test directory and local server.'],
  ['vitest.config.js', 'build-configuration', 'exclude the browser tests from the unit run.'],
  ['tsconfig.json', 'build-configuration', 'include the browser test folder.'],
  ['.github/workflows/ci.yml', 'ci-configuration', 'run the browser tests on every push.'],
  ['README.md', 'documentation', 'say how to run the browser tests.'],
  ['.gitignore', 'repository-metadata', 'ignore the browser test output.']
];
const STRAY = 'test-results/.last-run.json';
const CHANGED = [...SUPPORTING.map(([file]) => present(file)), present('src/test/setup.js'), present('eslint.config.js'), present(STRAY),
  present('src/app.js', { verdict: 'planned', clauseIds: [REQ] })];
const RECONCILIATION = {
  reconciliationSha256: 'b'.repeat(64), path: `singularity/work-items/${WORK}/context/work-intervals/reconciliations/${'b'.repeat(64)}.json`,
  intervalId: 'INT-1', sourceBaseCommit: 'c'.repeat(40), target: { head: 'd'.repeat(40) }, findings: CHANGED
};
const INDEXES = [{ indexSha256: 'e'.repeat(64), clauses: [{ id: REQ, body: 'A person can run the app.' }] }];
const OBSERVED = [{ recordSha256: 'f'.repeat(64), kind: 'observed', phase: 'implementation', generation: 1,
  claims: { [REQ]: { verdict: 'matched', observedPaths: ['src/app.js'], testResults: [] } } }];
const PLAN = { kind: 'planned', workId: WORK, phase: 'planning', generation: 1, recordSha256: '1'.repeat(64),
  claims: { [REQ]: { expectedPaths: ['src/app.js'], tests: [], testDisposition: 'unspecified', testReason: null, deviation: null } },
  supportingFiles: SUPPORTING.map(([file]) => file),
  supportingFileDetails: SUPPORTING.map(([file, kind, reason]) => ({ path: file, class: kind, reason })) };
const PLANNED = [PLAN];
const BINDINGS = convergenceBindings({ iteration: 1, indexes: INDEXES, reconciliation: RECONCILIATION, planned: PLANNED, observed: OBSERVED, configurationSha256: '2'.repeat(64) });
const EVERY_FACT = convergenceFacts({ reconciliation: RECONCILIATION, indexes: INDEXES, planned: PLANNED, observed: OBSERVED });
const REVIEWER = { login: 'reviewer-one', email: 'reviewer-one@example.invalid', name: 'Reviewer One' };
const APPROVAL = { decision: 'approved', phase: 'planning', generation: 1, at: '2026-11-06T05:00:00.000Z', actor: REVIEWER, authorityGroup: GROUP, identityAssurance: 'git-identity' };
const LOCATED = { id: 'PAM-001', changes: [{ kind: 'add-location', clauseId: REQ, path: 'src/test/setup.js' }],
  reason: 'Test-only: gives the suite a local storage stand-in; no product behaviour changes.', actor: 'reviewer-one', authorityGroup: GROUP, at: '2026-11-06T06:13:23.000Z' };
const LISTED = { id: 'PAM-002', changes: [{ kind: 'add-supporting', path: 'eslint.config.js', class: 'build-configuration', reason: 'lint the browser tests the same way.' }],
  reason: 'The lint settings had to name the browser test folder too.', actor: 'reviewer-one', authorityGroup: GROUP, at: '2026-11-06T06:14:00.000Z' };

function story({ planning = {}, amendments = [LOCATED, LISTED], resolution = {} } = {}) {
  return {
    workItem: { id: WORK }, phaseOrder: ['planning', 'implementation', 'convergence'],
    resolution: { plannedClaims: { mode: 'required', owners: { implementation: 'planning' } }, ...resolution },
    phases: {
      planning: { id: 'planning', status: 'approved', generation: 1, approvals: [APPROVAL],
        approvalPolicy: { mode: 'required', authorities: [GROUP], requiredAuthorities: [], minimum: 1 }, ...planning },
      implementation: { id: 'implementation', status: 'approved', generation: 1 }, convergence: { id: 'convergence', status: 'in_progress', generation: 0 }
    },
    planAmendments: amendments
  };
}

/** Settle exactly as a convergence step does, from what reconciliation reported. */
function settle(workflow = story(), { reconciliation = RECONCILIATION, planned = PLANNED } = {}) {
  const everyFact = convergenceFacts({ reconciliation, indexes: INDEXES, planned, observed: OBSERVED });
  const { facts, settled } = settleChangedPaths(everyFact, { reconciliation, planAccount: planAccounts(workflow, planned) });
  return { facts, settled, everyFact, settlement: { settled, everyFact } };
}
const settledPaths = (result) => result.settled.flatMap((item) => item.paths).sort();
const askedPaths = (result) => result.facts.flatMap((item) => item.paths).sort();
/** One changed path, and whether the plan settled it: what each guard below must say no to. */
function verdict(file, { workflow = story(), planned = PLANNED, finding = {} } = {}) {
  const reconciliation = { ...RECONCILIATION, findings: [present(file, finding)] };
  const result = settle(workflow, { reconciliation, planned });
  return { settled: settledPaths(result).includes(file), asked: askedPaths(result).includes(file),
    says: planAccounts(workflow, planned)(reconciliation.findings[0]) };
}
function assertAsked(file, options, why, words) {
  const { settled, asked, says } = verdict(file, options);
  assert.equal(settled, false, `${why}: it settled ${file}`);
  assert.equal(asked, true, `${why}: ${file} is no longer asked`);
  if (words) assert.match(says?.askedBecause ?? '', words, why);
}
const stored = (projection) => ({ ...projection, candidateSnapshot: [] });
const projected = (result = settle(), adjudications = []) => stored(convergenceProjection({ workId: WORK, bindings: BINDINGS, facts: result.facts, settledByPlan: result.settled, adjudications }));
const decide = (id, disposition = 'accepted-deviation') => ({ itemId: id, disposition, reason: 'It is part of the test setup.', actor: 'reviewer@example.invalid', at: '2026-11-06T06:25:01.660Z' });

test('the shape of the real Stories: 11 questions become 1, and the 1 is the file nothing accounts for', () => {
  const result = settle();
  assert.equal(EVERY_FACT.length, 11, 'the replay starts from every changed path asked');
  assert.deepEqual(result.facts.map((item) => item.paths[0]), [STRAY]);
  assert.equal(result.settled.length, 10);
  // The same identity it always had, so a reviewer finds the same item from one Story to the next.
  assert.equal(result.settled.find((item) => item.paths[0] === 'package.json').id, 'CF-21034d278357');
  assert.equal(result.settled.find((item) => item.paths[0] === 'src/test/setup.js').id, 'CF-d481d2555b77');
  assert.equal(result.facts[0].id, 'CF-b707f55e9cd0');

  const projection = projected(result);
  assert.deepEqual(projection.allowedNext, ['adjudicate']);
  assert.deepEqual(advancementBlocked(projection), [`1 convergence item has no recorded human disposition: ${result.facts[0].id}`]);
  assert.equal(convergencePreparationState(projection).settledCount, 10);
  assert.deepEqual(convergencePreparationState(projection).undisposedItemIds, [result.facts[0].id]);

  const decided = adjudicatedConvergenceProjection(projection, [decide(result.facts[0].id)]);
  assert.deepEqual(decided.allowedNext, ['advance-to-verification']);
  assert.deepEqual(advancementBlocked(decided), []);
  assert.equal(decided.settledByPlan.length, 10, 'a decision dropped what the plan settled');
  assertConvergenceIntegrity(decided, { currentBindings: BINDINGS, currentFacts: result.facts, currentSettlement: result.settlement });
  assertConvergencePublishable(decided, renderConvergenceArtifact(decided));
  const again = decodeConvergenceRecord(serializeConvergence(decided), { workId: WORK, iteration: 1, currentBindings: BINDINGS, currentFacts: result.facts, currentSettlement: result.settlement });
  assert.equal(again.convergenceSha256, decided.convergenceSha256);
});

test('when the plan answered everything, nobody is asked and the step can move on', () => {
  const findings = CHANGED.filter((entry) => entry.path !== STRAY);
  const result = settle(story(), { reconciliation: { ...RECONCILIATION, findings } });
  assert.deepEqual(result.facts, []);
  const projection = projected(result);
  assert.deepEqual(projection.allowedNext, ['advance-to-verification']);
  assert.deepEqual(advancementBlocked(projection), []);
});

test('the record and the report say which entry settled each path', () => {
  const projection = projected();
  const supporting = projection.settledByPlan.find((item) => item.paths[0] === 'package.json');
  assert.deepEqual(supporting.settledBy, { kind: 'supporting', phase: 'planning', generation: 1, class: 'build-configuration', text: 'add the browser test dependency and its script.' });
  const located = projection.settledByPlan.find((item) => item.paths[0] === 'src/test/setup.js');
  assert.deepEqual(located.settledBy, { kind: 'amendment', id: 'PAM-001', clause: REQ, class: null, text: LOCATED.reason });
  const listed = projection.settledByPlan.find((item) => item.paths[0] === 'eslint.config.js');
  assert.deepEqual(listed.settledBy, { kind: 'amendment', id: 'PAM-002', class: 'build-configuration', text: LISTED.changes[0].reason });
  assert.equal(supporting.kind, 'unclaimed-changed-path');

  const report = renderConvergenceArtifact(projection);
  assert.match(report, /## Settled by the approved plan/u);
  assert.match(report, /\*\*CF-21034d278357\*\* · package\.json · Supporting file of planning generation 1 · build-configuration: add the browser test dependency/u);
  assert.match(report, new RegExp(`\\*\\*CF-d481d2555b77\\*\\* · src/test/setup\\.js · PAM-001 under ${REQ}: Test-only`, 'u'));
  assert.match(report, /\*\*CF-6fc4d036923d\*\* · eslint\.config\.js · PAM-002 · build-configuration: lint/u);
  // Nothing settled, nothing added: the report reads as every report before it did.
  assert.doesNotMatch(renderConvergenceArtifact(projected({ facts: EVERY_FACT, settled: [] })), /Settled by the approved plan/u);
});

test('a person can still overrule the plan on a settled path, and it blocks like any other rework', () => {
  const result = settle();
  const item = result.settled.find((entry) => entry.paths[0] === 'package.json');
  const projection = adjudicatedConvergenceProjection(projected(result), [decide(item.id, 'rework'), decide(result.facts[0].id)]);
  assert.equal(projection.findings.find((finding) => finding.itemId === item.id).source, 'deterministic');
  assert.equal(projection.findings.find((finding) => finding.itemId === item.id).kind, 'unclaimed-changed-path');
  assert.equal(projection.unresolvedBlockers.length, 1);
  assert.deepEqual(projection.allowedNext, ['create-rework']);
  assert.ok(advancementBlocked(projection).some((reason) => /rework/u.test(reason)));
  assertConvergenceIntegrity(projection, { currentBindings: BINDINGS, currentFacts: result.facts, currentSettlement: result.settlement });
  assert.throws(() => convergenceProjection({ workId: WORK, bindings: BINDINGS, facts: result.facts, settledByPlan: result.settled, adjudications: [decide('CF-000000000000')] }), /unknown convergence item/u);
  assert.throws(() => validateAdjudication({ itemId: item.id, disposition: 'dismissed' }, { facts: result.settled }), /needs a human-authored reason/u, 'a settled path takes a reason like any other');
});

test('an amendment that was rejected, is pending or withdrawn settles nothing', () => {
  const with_ = (fields) => story({ amendments: [{ ...LOCATED, ...fields }] });
  for (const [workflow, why] of [
    [with_({ status: 'rejected' }), 'a rejected amendment'],
    [with_({ status: 'pending' }), 'a pending amendment'],
    [with_({ decision: 'rejected' }), 'an amendment decided against'],
    [with_({ withdrawnAt: '2026-11-06T07:00:00.000Z' }), 'a withdrawn amendment'],
    [with_({ actor: null }), 'an amendment nobody decided'],
    [with_({ authorityGroup: 'someone-else' }), 'an amendment from outside the group that approves the plan'],
    [story({ amendments: [] }), 'no amendment at all']
  ]) assertAsked('src/test/setup.js', { workflow }, why);
  assert.equal(verdict('src/test/setup.js').settled, true, 'the amendment these differ from settles it');
});

test('an amendment a row no longer holds settles nothing', () => {
  const planned = [{ ...PLAN, claims: {} }];
  assertAsked('src/test/setup.js', { planned }, 'a location on a row the plan dropped', /no longer has the row/u);
});

test('SF Guard: an amendment or a plan approval that does not count settles nothing', (t) => {
  t.after(() => forgetPersonCounts());
  const pinned = (fields = {}) => story({ resolution: { presence: { status: 'required' } }, ...fields });

  // The policy chain was not read: on a Story it requires, no person record counts.
  forgetPersonCounts();
  assertAsked('src/test/setup.js', { workflow: pinned() }, 'an amendment whose signature nobody checked');
  assertAsked('package.json', { workflow: pinned() }, 'a plan approval whose signature nobody checked', /no person approved/u);

  // The chain was read, and the signature does not verify.
  registerPersonCounts(presencePinKey(pinned()), () => false);
  assertAsked('src/test/setup.js', { workflow: pinned() }, 'an amendment whose signature failed');
  assertAsked('package.json', { workflow: pinned() }, 'a plan approval whose signature failed', /no person approved/u);

  // The amendment's fails and the approval's holds: only the plan's entry settles.
  registerPersonCounts(presencePinKey(pinned()), (entry) => entry === APPROVAL);
  assertAsked('src/test/setup.js', { workflow: pinned() }, 'an amendment whose signature failed, under a good approval');
  assert.equal(verdict('package.json', { workflow: pinned() }).settled, true, 'a verified approval stopped settling');

  // Both verify.
  registerPersonCounts(presencePinKey(pinned()), () => true);
  assert.equal(verdict('src/test/setup.js', { workflow: pinned() }).settled, true);
  assert.equal(verdict('package.json', { workflow: pinned() }).settled, true);
});

test('SF Guard: a settled path keeps its place when a finding on it stops counting', (t) => {
  t.after(() => forgetPersonCounts());
  const workflow = story({ resolution: { presence: { status: 'required' } } });
  const result = settle(story());
  const item = result.settled[0];
  registerPersonCounts(presencePinKey(workflow), () => false);
  const view = countedConvergence(workflow, adjudicatedConvergenceProjection(projected(result), [decide(item.id, 'rework')]));
  assert.deepEqual(view.unresolvedBlockers, [], 'an unsigned overrule still blocked');
  assert.equal(view.settledByPlan.length, 10);
  assert.deepEqual(view.allowedNext, ['adjudicate']);
});

test('a plan row the person never approved settles nothing', () => {
  const never = /no person approved/u;
  for (const [planning, why] of [
    [{ status: 'awaiting_approval', approvals: [] }, 'a plan still waiting'],
    [{ status: 'in_progress', approvals: [] }, 'a plan reopened'],
    [{ approvalPolicy: { mode: 'none', authorities: [], minimum: 0 }, approvals: [], approvalDisposition: 'not_required' }, 'a plan step that needs no approval'],
    [{ approvalPolicy: { mode: 'policy', authorities: [GROUP], requiredAuthorities: [], minimum: 1 }, approvals: [], approvalDisposition: 'policy_waived' }, 'a plan a policy waived'],
    [{ approvals: [{ ...APPROVAL, invalidatedAt: '2026-11-06T05:30:00.000Z' }] }, 'an approval that was invalidated'],
    [{ approvals: [{ ...APPROVAL, decision: 'rejected' }] }, 'a plan the person rejected'],
    [{ approvals: [{ ...APPROVAL, generation: 2 }], generation: 2 }, 'an approval of a later plan than the row read'],
    [{ approvals: [APPROVAL], approvalPolicy: { mode: 'required', authorities: [GROUP], requiredAuthorities: [], minimum: 2 } }, 'one approval where two are required']
  ]) assertAsked('package.json', { workflow: story({ planning }) }, why, never);
  assert.equal(verdict('package.json').settled, true, 'the plan these differ from settles it');
  // An amendment is a person's own decision: it does not wait on a separate plan approval.
  assert.equal(verdict('src/test/setup.js', { workflow: story({ planning: { status: 'awaiting_approval', approvals: [] } }) }).settled, true);
});

test('a path changed beyond what the entry says, where the record can show it, is still asked', () => {
  assertAsked('package.json', { finding: { status: 'deleted', sha256: null, bytes: 0 } }, 'a listed file deleted', /deleted/u);
  assertAsked('package.json', { finding: { status: 'symlink', sha256: null, bytes: null } }, 'a listed file that became a link', /ordinary file/u);
  assertAsked('package.json', { finding: { status: undefined } }, 'a reconciliation with no file status', /ordinary file/u);
  assertAsked('package.json', { finding: { protected: true } }, 'a protected path', /protected/u);
  assertAsked('package.json', { finding: { verdict: 'planned', clauseIds: [REQ] } }, 'a row expected it and no claim cites it', new RegExp(`${REQ} expected it`, 'u'));
  // The class recorded is not what the path is, in a plan written or edited by hand.
  const wrongClass = [{ ...PLAN, supportingFileDetails: [{ path: 'package.json', class: 'documentation', reason: 'say how to run the tests.' }] }];
  assertAsked('package.json', { planned: wrongClass }, 'a file listed for another purpose', /lists it as documentation, and the path is build-configuration/u);
  // A hand-written map cannot exempt behaviour from requirement accounting (`plannedSupportingFiles`).
  for (const [file, words] of [['src/feature.js', /application behaviour/u], ['tests/feature.test.js', /Planned tests column/u], ['db/migrate/001.sql', /migration/u], ['config/app.yml', /runtime configuration/u]]) {
    const planned = [{ ...PLAN, supportingFiles: [file], supportingFileDetails: [{ path: file, class: 'build-configuration', reason: 'just a little setup.' }] }];
    assertAsked(file, { planned }, `a plan listing ${file} as supporting`, words);
  }
  // A plan from before classes lists the file and says neither what it is nor why.
  const bare = [{ ...PLAN, supportingFiles: ['package.json'], supportingFileDetails: undefined }];
  assertAsked('package.json', { planned: bare }, 'a listing with no class or reason', /no class or reason/u);
});

test('a path a person sent back in an earlier iteration is asked again: the plan does not overrule them', async () => {
  const account = (keptByPerson) => planAccounts(story(), PLANNED, { keptByPerson })(present('package.json'));
  assert.match(account(new Set(['package.json'])).askedBecause, /sent it back in an earlier iteration/u);
  assert.equal(account(new Set(['README.md'])).askedBecause, undefined);
  assert.match(account(null).askedBecause, /cannot be read/u);
  const asked = settleChangedPaths(EVERY_FACT, { reconciliation: RECONCILIATION, planAccount: planAccounts(story(), PLANNED, { keptByPerson: new Set(['package.json']) }) });
  assert.ok(asked.facts.some((item) => item.paths[0] === 'package.json'));

  // From the records themselves, as a convergence step reads them.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-kept-'));
  try {
    const item = `singularity/work-items/${WORK}`;
    const write = async (iteration, bytes) => {
      await mkdir(path.join(root, item, 'context', 'convergence'), { recursive: true });
      await writeFile(path.join(root, item, 'context', 'convergence', `iteration-${iteration}.json`), bytes);
    };
    const result = settle();
    const on = (file) => [...result.settled, ...result.facts].find((entry) => entry.paths[0] === file).id;
    assert.deepEqual([...await pathsKeptByPerson(root, item, 1)], [], 'a first iteration has nothing before it');
    assert.deepEqual([...await pathsKeptByPerson(root, item, 2)], [], 'an iteration with no record kept nothing');
    await write(1, serializeConvergence(projected(result, [decide(on('package.json'), 'rework'), decide(on('README.md'), 'deferred'),
      { ...decide(on('.gitignore'), 'update-intent'), clauseIds: [REQ] }, decide(on('tsconfig.json'), 'accepted-deviation'), decide(on(STRAY), 'dismissed')])));
    assert.deepEqual([...await pathsKeptByPerson(root, item, 2)].sort(), ['.gitignore', 'README.md', 'package.json']);
    // A record from before family v5, answered on its facts, reads the same way.
    await write(1, await frozen('v4-decided.json'));
    assert.deepEqual([...await pathsKeptByPerson(root, item, 2)], [], 'an acceptance kept a path');
    // Nobody can tell what an unreadable record said, so nothing settles.
    await write(1, '{not json');
    assert.equal(await pathsKeptByPerson(root, item, 2), null);
    assert.equal(await pathsKeptByPerson(root, item, 1) instanceof Set, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a path the plan says nothing about is asked exactly as today, and other facts are untouched', () => {
  const absent = convergenceFacts({ reconciliation: RECONCILIATION, indexes: [{ indexSha256: 'e'.repeat(64), clauses: [{ id: 'BIN:REQ-009', body: 'Another.' }] }], planned: PLANNED, observed: [] });
  const { facts, settled } = settleChangedPaths(absent, { reconciliation: RECONCILIATION, planAccount: planAccounts(story(), PLANNED) });
  assert.ok(facts.some((item) => item.kind === 'absent-observed-claim'), 'an absence of a claim was settled');
  assert.deepEqual(settled.map((item) => item.kind).filter((kind) => kind !== 'unclaimed-changed-path'), []);
  const stray = EVERY_FACT.find((item) => item.paths[0] === STRAY);
  assert.deepEqual(settle().facts, [stray], 'the fact a person is asked changed');
  assert.equal(planAccounts(story(), PLANNED)(present(STRAY)), null);
  // Only a fact naming exactly one changed path can be settled, and only a real finding of it.
  const wide = { ...stray, paths: ['package.json', 'README.md'] };
  assert.deepEqual(settleChangedPaths([wide], { reconciliation: RECONCILIATION, planAccount: planAccounts(story(), PLANNED) }).settled, []);
  assert.deepEqual(settleChangedPaths([stray], { reconciliation: { ...RECONCILIATION, findings: [] }, planAccount: () => ({ kind: 'supporting' }) }).settled, []);
});

test('a forged record cannot settle what the plan did not', () => {
  const result = settle();
  const inputs = { currentBindings: BINDINGS, currentFacts: result.facts, currentSettlement: result.settlement };
  const reseal = (record) => {
    const { convergenceSha256, candidateSnapshot, ...core } = record;
    return { ...record, convergenceSha256: recordSha256({ ...core, schemaVersion: record.settledByPlan === undefined ? 4 : 5 }) };
  };
  const honest = projected(result);
  assertConvergenceIntegrity(honest, inputs);

  // The stray file moved into the settled list, with a valid seal: its identity holds, the current inputs do not.
  const stray = result.facts[0];
  const moved = reseal({ ...honest, facts: [], allowedNext: ['advance-to-verification'],
    settledByPlan: [...honest.settledByPlan, { ...stray, settledBy: { kind: 'supporting', phase: 'planning', generation: 1, class: 'build-configuration', text: 'trust me.' } }] });
  assertConvergenceIntegrity(moved);
  assert.throws(() => assertConvergenceIntegrity(moved, inputs), (error) => error.code === 'CONVERGENCE_FACTS_STALE');

  // An entry reworded after the fact is the same forgery.
  const reworded = reseal({ ...honest, settledByPlan: honest.settledByPlan.map((item, index) => index ? item : { ...item, settledBy: { ...item.settledBy, text: 'something else.' } }) });
  assert.throws(() => assertConvergenceIntegrity(reworded, inputs), (error) => error.code === 'CONVERGENCE_FACTS_STALE');

  // Dropping the list makes it read as a record from before v5: every changed path, which this one no longer has.
  const { settledByPlan, ...stripped } = honest;
  assert.throws(() => assertConvergenceIntegrity(reseal(stripped), inputs), (error) => error.code === 'CONVERGENCE_FACTS_STALE');

  // A settled list passed off as a v4 record, whose seal is the one thing a v4 keeps on the way in.
  const { convergenceSha256: _v5Seal, candidateSnapshot: _snapshot, ...v5Core } = honest;
  const passedOff = { ...v5Core, schemaVersion: 4 };
  assert.throws(() => decodeConvergenceRecord(JSON.stringify({ ...passedOff, candidateSnapshot: [], convergenceSha256: recordSha256(passedOff) })),
    (error) => /^CONVERGENCE_RECORD_/u.test(error.code));

  // Bytes edited with no new seal.
  const unsealed = structuredClone(honest);
  unsealed.settledByPlan[0].settledBy.text = 'edited.';
  assert.throws(() => assertConvergenceIntegrity(unsealed), (error) => error.code === 'CONVERGENCE_RECORD_HASH_MISMATCH');

  // What a settled path must hold on its own, whatever inputs a reader has.
  const first = honest.settledByPlan[0];
  for (const [change, why] of [
    [{ id: 'CF-000000000000' }, 'an identity that is not its content'],
    [{ kind: 'missing-bound-test' }, 'a fact that is not a changed path'],
    [{ paths: ['package.json', 'README.md'] }, 'more than one path'],
    [{ settledBy: null }, 'no entry'],
    [{ settledBy: { kind: 'hearsay' } }, 'an entry of no known kind'],
    [{ settledBy: { kind: 'amendment' } }, 'an amendment with no ID'],
    [{ settledBy: { ...first.settledBy, askedBecause: 'a reason it is still asked' } }, 'an entry that says it is still asked']
  ]) {
    assert.throws(() => assertConvergenceIntegrity(reseal({ ...honest, settledByPlan: [{ ...first, ...change }] })),
      (error) => error.code === 'CONVERGENCE_SETTLED_INVALID', why);
  }
  assert.throws(() => assertConvergenceIntegrity(reseal({ ...honest, settledByPlan: [first, first] })), (error) => error.code === 'CONVERGENCE_SETTLED_INVALID', 'a path twice');
  assert.throws(() => assertConvergenceIntegrity(reseal({ ...honest, facts: [...honest.facts, { ...first, settledBy: undefined }], settledByPlan: [first] })),
    (error) => error.code === 'CONVERGENCE_SETTLED_INVALID', 'a path both asked and settled');
  assert.throws(() => assertConvergenceIntegrity(reseal({ ...honest, settledByPlan: 'all of them' })), (error) => error.code === 'CONVERGENCE_SETTLED_INVALID');
});

// Written by the build before family v5 (main at de4e1ee48), not by anything in this repository's current code.
const frozen = (name, encoding) => readFile(new URL(`./fixtures/convergence/${name}`, import.meta.url), encoding);
const backTo = (record, version) => {
  const { convergenceSha256, candidateSnapshot, ...core } = record;
  const older = { ...core, schemaVersion: version };
  if (version < 3) delete older.legacyMigration;
  if (version < 2) delete older.candidateRecordBindings;
  return { ...older, candidateSnapshot: candidateSnapshot ?? [], convergenceSha256: recordSha256(older) };
};

test('a stored v4 record verifies, reads the same and keeps its seal', async () => {
  const bytes = await frozen('v4-open.json');
  const v4 = JSON.parse(bytes);
  assert.equal(v4.schemaVersion, 4);
  const current = settle();
  const inputs = { workId: WORK, iteration: 1, currentBindings: BINDINGS, currentFacts: current.facts, currentSettlement: current.settlement };
  const read = decodeConvergenceRecord(bytes, inputs);
  assert.equal(read.schemaVersion, currentSchemaVersion('convergence-record'));
  assert.equal(read.convergenceSha256, v4.convergenceSha256, 'reading an old record changed its seal');
  assert.equal(read.settledByPlan, undefined);
  assert.deepEqual(read.facts, v4.facts, 'the questions of an old record changed');
  assert.deepEqual(read.facts, EVERY_FACT, 'facts are computed differently now');
  assert.deepEqual(read.allowedNext, ['adjudicate']);
  assert.deepEqual(advancementBlocked(read), advancementBlocked(v4));
  assert.equal(convergencePreparationState(read).undisposedItemIds.length, 11);

  // Its questions are held to the facts as computed, as they always were.
  assert.throws(() => decodeConvergenceRecord(bytes, { ...inputs, currentSettlement: { ...current.settlement, everyFact: current.facts } }), (error) => error.code === 'CONVERGENCE_FACTS_STALE');
  // A record edited in place fails its own seal on the way in.
  assert.throws(() => decodeConvergenceRecord(JSON.stringify({ ...v4, allowedNext: ['advance-to-verification'] })), (error) => error.code === 'CONVERGENCE_RECORD_CORRUPT' && /integrity/u.test(error.message));
});

test('a Story waiting on approval of a stored v4 report still passes: the report is the same bytes', async () => {
  const read = decodeConvergenceRecord(await frozen('v4-decided.json'), { workId: WORK, iteration: 1 });
  const report = await frozen('v4-decided.md', 'utf8');
  assert.equal(renderConvergenceArtifact(read), report, 'the report of a stored record reads differently');
  assert.doesNotThrow(() => assertConvergencePublishable(read, report));
  assert.deepEqual(read.allowedNext, ['advance-to-verification']);
  assert.deepEqual(advancementBlocked(read), []);
});

test('answering on a stored v4 record keeps its questions, and every answer stays', async () => {
  const bytes = await frozen('v4-open.json');
  const current = settle();
  const inputs = { workId: WORK, iteration: 1, currentBindings: BINDINGS, currentFacts: current.facts, currentSettlement: current.settlement };
  const read = decodeConvergenceRecord(bytes, inputs);
  const onSupporting = read.facts.find((item) => item.paths[0] === 'package.json');
  const answered = adjudicatedConvergenceProjection(read, [decide(onSupporting.id)]);
  assert.equal(answered.settledByPlan, undefined);
  assert.deepEqual(answered.facts, read.facts);
  assert.deepEqual(answered.allowedNext, ['adjudicate']);
  assert.equal(advancementBlocked(answered)[0].startsWith('10 convergence items'), true);
  const again = decodeConvergenceRecord(serializeConvergence(answered), inputs);
  assert.equal(again.convergenceSha256, answered.convergenceSha256);
  assert.equal(again.findings.length, 1);
});

test('records of every older version verify, and read as this build read them before', async () => {
  const v4 = JSON.parse(await frozen('v4-open.json'));
  const current = settle();
  const inputs = { workId: WORK, iteration: 1, currentBindings: BINDINGS, currentFacts: current.facts, currentSettlement: current.settlement };
  for (const version of [1, 2, 3]) {
    const older = backTo(v4, version);
    const migrated = readRecord('convergence-record', JSON.stringify(older));
    assert.equal(migrated.storedVersion, version);
    const read = decodeConvergenceRecord(JSON.stringify(older), inputs);
    assert.deepEqual(read.facts, older.facts, `v${version} facts`);
    assert.deepEqual(read.findings, older.findings, `v${version} findings`);
    assert.deepEqual(read.allowedNext, older.allowedNext, `v${version} next`);
    assert.equal(read.settledByPlan, undefined, `v${version} gained a settled list`);
    // The seal the v3 to v4 step always gave it: this change adds nothing to it.
    assert.equal(read.convergenceSha256, backTo(v4, 4).convergenceSha256, `v${version} seal`);
    assert.doesNotMatch(renderConvergenceArtifact(read), /Settled by the approved plan/u);
  }
  // A corrupt record of any older version is still refused rather than read.
  for (const version of [1, 2, 3, 4]) {
    const older = backTo(v4, version);
    assert.throws(() => decodeConvergenceRecord(JSON.stringify({ ...older, workId: 'SOMEONE-ELSE' })), (error) => error.code === 'CONVERGENCE_RECORD_CORRUPT', `v${version}`);
  }
});

test('a new record is the current version, and a build from before it says so instead of calling it stale', () => {
  assert.equal(currentSchemaVersion('convergence-record'), 6);
  const projection = projected();
  assert.equal(projection.schemaVersion, 6);
  assert.ok(Array.isArray(projection.settledByPlan));
  assert.deepEqual(projected({ facts: EVERY_FACT, settled: [] }).settledByPlan, [], 'a new record with nothing settled must not read as one from before v5');
  assert.throws(() => readRecord('convergence-record', JSON.stringify({ ...projection, schemaVersion: 7 })), (error) => error.code === 'SCHEMA_VERSION_FUTURE');
});

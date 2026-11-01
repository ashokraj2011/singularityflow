import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { countedRecords } from '../src/presence/counted.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, loadPresenceContext, personRecordVerdict } from '../src/presence/person-records.mjs';
import {
  isPersonStepRecord, newPersonRecords, PERSON_STEP_FAMILIES, setPersonStepPresenceDependencies
} from '../src/presence/person-steps.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { applicabilityDecision } from '../src/evidence/applicability.mjs';
import { renewedWitnessExpiry } from '../src/governance.mjs';
import { riskDecisionState } from '../src/evidence/risk-decisions.mjs';
import { evidenceReuseDecision } from '../src/evidence-reuse.mjs';
import { forwardAmendmentDecision } from '../src/forward-amendments.mjs';
import { planRowCorrections } from '../src/plan-row-corrections.mjs';
import { currentCompletenessReview } from '../src/scope/decisions.mjs';
import { saveWorkflow } from '../src/story-state-write.mjs';
import { loadWorkflow } from '../src/story-workflow-read.mjs';
import { storyTestCommandState } from '../src/story-test-commands.mjs';
import { testNarrowingState } from '../src/test-narrowing.mjs';
import { testRunRiskState } from '../src/test-run-risk.mjs';
import { upstreamIssueStates } from '../src/upstream-routes.mjs';
import { visualProfileDecision } from '../src/visual-profile-decisions.mjs';
import { witnessDecisionsFrom } from '../src/verification/witness-decisions.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { CLI, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard M3 (SPEC-PSS-v1 AC-010): a Story's other person-only steps. Every decision a person
// records on a Story SF Guard requires is signed where the Story is written (one card, one touch per
// command), and its readers count only a record whose signature verifies against the approver's
// pinned key, or one an exception covers. Software stand-ins for the Secure Enclave are passed
// in-process; no environment switch reaches signing or verification.

const WORK = 'PSS-3';
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const REASON = 'This statement restates the outcome and needs no clause of its own here.';

function members(configuration) {
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE, TWO];
}

/** A person at a Mac for `guard`, as the M1 and M2 tests pass one. */
function guardPerson(email, keys) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [],
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false })
  };
}

/** The signer's readers for one person holding `key`, in this process; `overrides` change one. */
function signer(key, overrides = {}) {
  const shown = [];
  return {
    shown,
    personTerminal: () => ({ person: true, reason: null }),
    signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => { shown.push(fields); return JSON.stringify(fields); },
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false }),
    ...overrides
  };
}

async function inRoot(root, action) {
  const previous = process.cwd();
  const log = console.log;
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  try { return { value: await action(), lines }; }
  catch (error) { return { error, lines }; }
  finally { console.log = log; process.chdir(previous); }
}

async function sfGuard(root, words, options, deps) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

/** Run a command in this process, as the person at their terminal with `presence` readers. */
async function asPerson(root, presence, argv) {
  forgetPresenceContexts();
  setPersonStepPresenceDependencies({ ...presence, argv: ['node', 'singularity-flow', ...argv] });
  try { return await inRoot(root, () => main([...argv, '--json'])); }
  finally { setPersonStepPresenceDependencies({}); }
}

function cliAs(root, name, ...args) {
  return spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: name } });
}

const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
function scopeItems(root) {
  const result = cliAs(root, ONE.name, 'evidence', 'scope', WORK, '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data.scope.items;
}

test('every person-step family is in the workflow schema with an optional presence block', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/workflow.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$defs.personPresence.properties.schema.const, 'sflow-presence-record@1');
  for (const family of PERSON_STEP_FAMILIES) {
    const items = schema.properties[family.list]?.items;
    // A list the schema leaves open (witnessExceptionRenewals) takes the block as it is.
    if (!schema.properties[family.list]) continue;
    assert.ok(items, `${family.list} is a Story list`);
    const branches = items.oneOf ?? [items];
    for (const branch of branches) {
      if (branch.$ref) continue;
      assert.deepEqual(branch.properties.presence, { $ref: '#/$defs/personPresence' }, `${family.list} may carry a presence block`);
    }
  }
  // A request anyone may make is never a person's decision; an acceptance is.
  assert.equal(isPersonStepRecord('testCommandDecisions', { id: 'TCD-001', requestedBy: 'agent' }), false);
  assert.equal(isPersonStepRecord('testCommandDecisions', { accepts: 'TCD-001' }), true);
  assert.equal(isPersonStepRecord('riskDecisions', { id: 'RISK-001' }), true);
  assert.equal(isPersonStepRecord('history', { id: 'x' }), false);
});

test('a record the command only extended is the one on disk, never a new one to sign', () => {
  const old = { item: 'SRI-1', disposition: 'excluded', reason: REASON, actor: 'a@example.com', authorityGroup: 'product', at: '2026-11-01T00:00:00.000Z' };
  const fresh = { ...old, item: 'SRI-2' };
  const workflow = { scopeDispositions: [{ ...old, withdrawnAt: '2026-11-02T00:00:00.000Z' }, fresh] };
  const added = newPersonRecords(workflow, { scopeDispositions: [old] });
  assert.deepEqual(added.map(({ record }) => record.item), ['SRI-2']);
  // A changed field is a different record.
  assert.equal(newPersonRecords({ scopeDispositions: [{ ...old, disposition: 'deferred' }] }, { scopeDispositions: [old] }).length, 1);
});

test('without SF Guard a Story\'s person records all count, as before', () => {
  const records = [{ id: 'RISK-001' }, { revokes: 'RISK-001' }];
  assert.equal(countedRecords({ resolution: {} }, records), records);
  assert.deepEqual(countedRecords({ workItem: { id: 'X' }, resolution: { presence: { schema: 'sflow-presence-pin@1', status: 'off' } } }, records), records);
  // Required, but the chain was never read in this process: no person record counts.
  forgetPresenceContexts();
  assert.deepEqual(countedRecords({ workItem: { id: 'X' }, resolution: { presence: { schema: 'sflow-presence-pin@1', status: 'required' } } }, records), []);
});

test('SF Guard required: a scope decision takes the card and one touch, and only a verified one counts', async (t) => {
  const key = softwarePresenceKey();
  const story = await startedSpecificationStory(t, WORK, {
    configure: members,
    // Two acceptance criteria: two statements a person disposes of in the scope inventory.
    startArguments: ['--acceptance-criteria', 'The value is returned unchanged.\nAn empty value is refused with a message.'],
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [key]));
      await sfGuard(root, ['enable'], { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' }, guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { root, git, item } = story;
  assert.equal((await workflowOf(item)).resolution.presence.status, 'required');
  const items = scopeItems(root);
  const unresolved = items.filter((entry) => entry.disposition === 'unresolved' && entry.kind === 'statement');
  assert.ok(unresolved.length >= 1, `the Story has a statement to decide: ${JSON.stringify(items.map(({ id, kind, disposition }) => ({ id, kind, disposition })))}`);
  const [first] = unresolved;
  const decide = (id) => ['decision', 'scope', WORK, '--item', id, '--as', 'excluded', '--reason', REASON];
  const dispositions = async () => (await workflowOf(item)).scopeDispositions ?? [];
  const head = () => git('rev-parse', 'HEAD');

  // From a script, with no terminal and no person: refused before anything is written, with the
  // person's command (or, on a computer with no signer, the routes).
  const before = head();
  const scripted = cliAs(root, ONE.name, ...decide(first.id));
  assert.notEqual(scripted.status, 0, scripted.stdout);
  assert.match(scripted.stdout + scripted.stderr, /needs your presence signature, taken in your own terminal|SF Guard cannot sign on this computer/u);
  assert.match(scripted.stdout + scripted.stderr, /Nothing was written/u);
  assert.deepEqual(await dispositions(), []);
  assert.equal(head(), before);

  // An agent's run is handed the exact command; a declined touch writes nothing.
  const agentRun = await asPerson(root, signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }), decide(first.id));
  assert.equal(agentRun.error?.code, 'PSS_CARD_NOT_SHOWN', agentRun.error?.message);
  assert.match(agentRun.error.details.nextAction.command, new RegExp(`^singularity-flow decision scope ${WORK} --item ${first.id} --as excluded --reason `, 'u'));
  const declined = await asPerson(root, signer(key, { sign: async () => {
    const error = new Error('Nothing was signed.'); error.code = 'PSS_PRESENCE_DECLINED'; throw error;
  } }), decide(first.id));
  assert.equal(declined.error?.code, 'PSS_PRESENCE_DECLINED', declined.error?.message);
  assert.deepEqual(await dispositions(), []);
  assert.equal(head(), before);
  const noSigner = await asPerson(root, signer(key, { signerAvailability: () => ({ available: false, reason: 'presence signing needs macOS' }) }), decide(first.id));
  assert.equal(noSigner.error?.code, 'PSS_SIGNER_UNAVAILABLE');
  assert.match(noSigner.error.message, /Nothing was written[\s\S]*another approver can record it[\s\S]*guard exception add approver-/u);

  // The card, then one touch: a signed decision that counts.
  const person = signer(key);
  const decided = await asPerson(root, person, decide(first.id));
  assert.equal(decided.error, undefined, `${decided.error?.message}\n${decided.lines.join('\n')}`);
  assert.equal(person.shown.length, 1, 'one card, shown before the touch');
  assert.match(person.shown[0].title, /record a decision on PSS-3/u);
  assert.match(person.shown[0].lines.join('\n'), new RegExp(`Scope disposition ${first.id}`, 'u'));
  const [signed] = await dispositions();
  assert.equal(signed.presence.approver, approverId(ONE));
  assert.equal(signed.presence.keyId, key.keyId);
  assert.equal(signed.presence.action, 'decision.scope');
  assert.equal(signed.presence.batch.length, 1);
  assert.notEqual(head(), before, 'the decision was committed');
  const afterSigned = scopeItems(root).find((entry) => entry.id === first.id);
  assert.equal(afterSigned.disposition, 'excluded', 'the verified decision counts');

  // A record changed after signing, or one written by hand with no signature, counts for nothing.
  const workflow = await workflowOf(item);
  forgetPresenceContexts();
  const context = await loadPresenceContext(root, workflow);
  assert.equal(personRecordVerdict(context, signed, { workflow }).state, 'signed');
  assert.equal(personRecordVerdict(context, { ...signed, disposition: 'deferred' }, { workflow }).code, 'PSS_SIGNATURE_INVALID');
  const { presence: _presence, ...unsigned } = signed;
  assert.equal(personRecordVerdict(context, unsigned, { workflow }).code, 'PSS_RECORD_UNSIGNED');
  const forgedOn = unresolved[1] ?? null;
  const tampered = structuredClone(workflow);
  tampered.scopeDispositions[0].reason = `${REASON} Changed by hand.`;
  if (forgedOn) tampered.scopeDispositions.push({ ...unsigned, item: forgedOn.id, statementSha256: forgedOn.statementSha256 ?? null });
  await writeFile(path.join(item, 'workflow.json'), `${JSON.stringify(tampered, null, 2)}\n`);
  const view = scopeItems(root);
  assert.equal(view.find((entry) => entry.id === first.id).disposition, 'unresolved', 'a changed signed record does not count');
  if (forgedOn) assert.equal(view.find((entry) => entry.id === forgedOn.id).disposition, 'unresolved', 'a hand-written record does not count');
  git('checkout', '--', path.relative(root, path.join(item, 'workflow.json')));
  assert.equal(scopeItems(root).find((entry) => entry.id === first.id).disposition, 'excluded');

  // A per-person exception: the step goes ahead unsigned, labelled as a bypass.
  if (forgedOn) {
    git('config', 'user.email', TWO.email);
    const excepted = await asPerson(root, signer(key, { personTerminal: () => { throw new Error('an exception needs no terminal'); } }), decide(forgedOn.id));
    assert.equal(excepted.error, undefined, `${excepted.error?.message}\n${excepted.lines.join('\n')}`);
    const bypassed = (await dispositions()).find((entry) => entry.item === forgedOn.id);
    assert.match(bypassed.presence.bypass, /^EXC-/u);
    assert.equal(bypassed.presence.signature, undefined);
    forgetPresenceContexts();
    const latest = await workflowOf(item);
    const verdict = personRecordVerdict(await loadPresenceContext(root, latest), bypassed, { workflow: latest });
    assert.equal(verdict.state, 'bypass');
    assert.match(verdict.label, /^bypass: per-person exception EXC-/u);
    assert.equal(scopeItems(root).find((entry) => entry.id === forgedOn.id).disposition, 'excluded');
    git('config', 'user.email', ONE.email);
  }
});

/** One person record of each family, as its writer would make it, under `suffix`. */
function familyRecords(suffix, actor) {
  const by = { actor, authorityGroup: 'product-approvers', identityAssurance: 'configured-local', at: '2026-11-02T10:00:00.000Z' };
  const why = 'Recorded by the person who approves this step, for the SF Guard M3 test.';
  return {
    riskDecisions: { id: `RISK-0${suffix}`, obligationId: `OBL:${WORK}:implement:AC-00${suffix}`, category: 'deferred-scope', transitions: ['terminal'],
      expiresAt: '2099-01-01T23:59:59.999Z', observation: { status: 'missing', sha256: `sha256:${'0'.repeat(64)}` }, reason: why, ...by },
    testCommandDecisions: { accepts: `TCD-00${suffix}`, phase: 'specification', reason: '', ...by },
    testNarrowings: { id: `TNR-00${suffix}`, phase: 'specification', commandId: `cmd-${suffix}`, pinSha256: `sha256:${'1'.repeat(64)}`,
      narrowing: { kinds: ['filter'] }, observation: { attemptId: `ATT-${suffix}` }, reason: why, expiresAt: null, ...by },
    testRunRisks: { id: `TRR-00${suffix}`, phase: 'specification', commandId: `cmd-${suffix}`, argvSha256: `sha256:${'2'.repeat(64)}`, causeClass: null, reason: why, ...by },
    evidenceReuses: { id: `ERU-00${suffix}`, phase: 'specification', attempt: { id: `ATT-${suffix}`, phase: 'specification' }, reason: why, expiresAt: null, ...by },
    visualProfileDecisions: { id: `VPD-00${suffix}`, phase: 'specification', profileId: `desktop-${suffix}`, disposition: 'not-applicable', reason: why, ...by },
    witnessRecords: { id: `WIT-00${suffix}`, clauseId: `${WORK}:AC-00${suffix}`, slot: 'visual', method: 'visual', file: `evidence-${suffix}.png`, sha256: `sha256:${'3'.repeat(64)}`, reason: why, ...by },
    applicability: { responsibility: `responsibility-${suffix}`, reason: why, ...by },
    witnessExceptionRenewals: { id: `WXR-00${suffix}`, phase: 'specification', generation: 1, mappingSha256: `sha256:${String(suffix).repeat(64)}`, clauseId: null,
      previousExpiresAt: null, expiresAt: '2099-01-01T23:59:59.999Z', reason: why, ...by },
    scopeDispositions: { item: `SRI-00000000000${suffix}`, disposition: 'excluded', clauseIds: [], reason: why, statementSha256: null, ...by },
    completenessReviews: { inventorySha256: `sha256:${String(suffix).repeat(64)}`, checklist: { id: 'starter', version: 1, decisions: [] }, reason: why, ...by },
    upstreamIssueDecisions: { issue: `UPI-00${suffix}`, outcome: 'dismiss', reason: why, link: null, expiresAt: null, ...by },
    forwardAmendmentDecisions: { amendment: `FAM-00${suffix}`, phase: 'specification', decision: 'rejected', reason: why, ...by },
    planAmendments: { id: `PRC-00${suffix}`, kind: 'plan-row-correction', ownerPhase: 'planning', ownerGeneration: 1, ownerMapSha256: `sha256:${'4'.repeat(64)}`,
      operations: [], reason: why, authorizationId: '00000000-0000-4000-8000-000000000000', reviewAssurance: 'live-terminal-exact-plan-review', upstreamIssue: null, ...by }
  };
}

/** What each family's own reader finds for the record `familyRecords(suffix)` made: truthy when it counts. */
function readers(workflow, suffix) {
  const at = '2026-11-03T00:00:00.000Z';
  return {
    riskDecisions: riskDecisionState(workflow, { id: `OBL:${WORK}:implement:AC-00${suffix}`, status: 'missing' }, { at }),
    testCommandDecisions: storyTestCommandState(workflow, `TCD-00${suffix}`)?.state === 'accepted',
    testNarrowings: testNarrowingState(workflow, { id: `TNR-00${suffix}` }, { at }) === 'active'
      && workflow.testNarrowings.some((entry) => entry.id === `TNR-00${suffix}`) && countedRecords(workflow, workflow.testNarrowings).some((entry) => entry.id === `TNR-00${suffix}`),
    testRunRisks: testRunRiskState(workflow, { phaseId: 'specification', commandId: `cmd-${suffix}`, argvSha256: `sha256:${'2'.repeat(64)}` }, { at }),
    evidenceReuses: evidenceReuseDecision(workflow, `ERU-00${suffix}`),
    visualProfileDecisions: visualProfileDecision(workflow, `VPD-00${suffix}`),
    witnessRecords: witnessDecisionsFrom(workflow).some((entry) => entry.id === `WIT-00${suffix}` || entry.record?.id === `WIT-00${suffix}`),
    applicability: applicabilityDecision(workflow, `responsibility-${suffix}`),
    witnessExceptionRenewals: renewedWitnessExpiry(workflow, 'specification', 1, `sha256:${String(suffix).repeat(64)}`),
    // The scope inventory's own reader is covered end to end above; here, the counting it uses.
    scopeDispositions: countedRecords(workflow, workflow.scopeDispositions).some((entry) => entry.item === `SRI-00000000000${suffix}`),
    completenessReviews: currentCompletenessReview(workflow, { inventorySha256: `sha256:${String(suffix).repeat(64)}` }),
    upstreamIssueDecisions: upstreamIssueStates(workflow).some((entry) => entry.issue.id === `UPI-00${suffix}` && entry.status === 'decided'),
    forwardAmendmentDecisions: forwardAmendmentDecision(workflow, `FAM-00${suffix}`),
    planAmendments: planRowCorrections(workflow).some((entry) => entry.id === `PRC-00${suffix}`)
  };
}

test('SF Guard required: every other family is signed where the Story is written and counted only when it verifies', async (t) => {
  const key = softwarePresenceKey();
  const story = await startedSpecificationStory(t, 'PSS-4', {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [key]));
      await sfGuard(root, ['enable'], { 'remote-check': 'sf-guard-verify' }, guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { root, item } = story;
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => { process.chdir(previous); setPersonStepPresenceDependencies({}); });
  forgetPresenceContexts();
  const { definition } = await loadAcceptedStoryExecution(root, 'PSS-4');
  const load = async () => { forgetPresenceContexts(); return loadWorkflow(root, definition, 'PSS-4'); };
  const workflow = await load();
  assert.equal(workflow.resolution.presence.status, 'required');
  // Two upstream issues and two test command requests the decisions name; the first of each is decided.
  workflow.upstreamIssues = [1, 2].map((n) => ({ id: `UPI-00${n}`, phase: 'specification', status: 'open', raisedAt: '2026-11-02T09:00:00.000Z' }));
  workflow.testCommandDecisions = [1, 2].map((n) => ({ id: `TCD-00${n}`, phase: 'specification', command: { id: `cmd-${n}`, kind: 'test', argv: ['node', '--test'] },
    reason: 'A request anyone may make.', requestedBy: 'agent', at: '2026-11-02T09:00:00.000Z' }));
  const signedSet = familyRecords(1, ONE.email);
  for (const family of PERSON_STEP_FAMILIES) workflow[family.list] = [...(workflow[family.list] ?? []), signedSet[family.list]];

  const person = signer(key);
  setPersonStepPresenceDependencies({ ...person, argv: ['node', 'singularity-flow', 'decision', 'many'] });
  await saveWorkflow(root, definition, workflow);
  assert.equal(person.shown.length, 1, 'one card for everything the command recorded');
  assert.equal(person.shown[0].lines.length, PERSON_STEP_FAMILIES.length + 1, person.shown[0].lines.join('\n'));
  const saved = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  for (const family of PERSON_STEP_FAMILIES) {
    assert.equal(saved[family.list].at(-1).presence?.batch?.length, PERSON_STEP_FAMILIES.length, `${family.list} carries the one signature`);
  }
  assert.equal(saved.testCommandDecisions[0].presence, undefined, 'a request is never signed');
  // Saving again signs nothing: what is on disk is never offered for a touch.
  const again = signer(key);
  setPersonStepPresenceDependencies(again);
  await saveWorkflow(root, definition, await load());
  assert.equal(again.shown.length, 0);

  // Each family's own reader counts the signed record.
  for (const [list, found] of Object.entries(readers(await load(), 1))) assert.ok(found, `${list} counts its signed record`);

  // Unsigned copies written into the state file by hand count for nothing, in every family.
  const forged = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const forgedSet = familyRecords(2, ONE.email);
  for (const family of PERSON_STEP_FAMILIES) forged[family.list].push(forgedSet[family.list]);
  await writeFile(path.join(item, 'workflow.json'), `${JSON.stringify(forged, null, 2)}\n`);
  const view = await load();
  for (const [list, found] of Object.entries(readers(view, 2))) assert.ok(!found, `${list} does not count a hand-written record`);
  for (const [list, found] of Object.entries(readers(view, 1))) assert.ok(found, `${list} still counts its signed record`);
  // ...and the next command that saves the Story never offers them for signing.
  const next = signer(key);
  setPersonStepPresenceDependencies(next);
  await saveWorkflow(root, definition, view);
  assert.equal(next.shown.length, 0, 'records already on disk are never signed');
});

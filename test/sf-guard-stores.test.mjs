import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { discoverAgents, lockAgent } from '../src/agents.mjs';
import { activeCapabilityLeases } from '../src/capabilities.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { appendInitiativeRecord, readInitiativeRecords, signInitiativeApproval } from '../src/initiative-evidence.mjs';
import { createLedgerIntent } from '../src/ledger.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { remotePresenceCheck } from '../src/presence/remote-check.mjs';
import { forgetRepositorySealPolicies } from '../src/presence/repository-seals.mjs';
import { repositoryPersonStep } from '../src/presence/repository-step-routes.mjs';
import { gateRepositoryPersonStep } from '../src/presence/repository-steps.mjs';
import { remoteStateCheck } from '../src/presence/state-check.mjs';
import { storeRecordProblems } from '../src/presence/store-check.mjs';
import {
  countedLeaseEntries, fileVerdict, inlineVerdict, sealPathFor, signBeside, signInline, storePolicy
} from '../src/presence/store-seals.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.10): the repository stores keep their person step's presence signature
// with the record. A capability lease, a repair authorization, an agents-lock entry and a host-policy
// assertion carry it inline; an Epic approval or completion, a goal plan approval, a program approval
// and a ratified or confirmed intent keep a seal file beside the record. Each reader counts a record
// only while its signature verifies (or SF Guard was off when it was recorded), and the remote checks
// fail an unsigned addition and a removal. Software stand-ins for the Secure Enclave are passed
// in-process; no environment switch reaches signing.

const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const OLD = '2020-01-01T00:00:00.000Z';

function members(configuration) {
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE, TWO];
}

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
  process.chdir(root);
  console.log = () => {};
  try { return { value: await action() }; }
  catch (error) { return { error }; }
  finally { console.log = log; process.chdir(previous); }
}

async function sfGuard(root, words, options, deps) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

/** A repository with SF Guard on: ONE's key pinned, TWO under a per-person exception. */
async function guardedRepository(t, work, key) {
  return startedSpecificationStory(t, work, {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [key]));
      await sfGuard(root, ['enable'], { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' }, guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
}

function lease(overrides = {}) {
  const intent = createLedgerIntent({ eventType: 'capability-lease-granted', capabilityId: 'payments',
    subject: { workId: 'capability:payments', phase: null, generation: null, branch: 'main' }, actor: { name: ONE.name, email: ONE.email },
    authorityGroup: 'product', payload: { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: 'Incident 7', relaxation: {} } });
  intent.payload.leaseId = intent.eventId;
  return Object.assign(intent, overrides);
}

test('every repository-level person step signs where it records, so the dispatch gate asks no touch', async () => {
  const step = (line, options = {}) => repositoryPersonStep(line.split(' '), options);
  for (const [line, options, action] of [
    ['initiative approve phase', {}, 'epic.approve'], ['epic requirements approve', {}, 'epic.approve'], ['epic planning approve', {}, 'epic.approve'],
    ['epic review approve S-1', {}, 'epic.review-approve'], ['epic complete', {}, 'epic.complete'], ['goal plan approve', {}, 'goal.plan-approve'],
    ['intent ratify', {}, 'intent.ratify'], ['intent confirm', {}, 'intent.confirm'], ['program approve', { confirm: 'X' }, 'program.approve'],
    ['capabilities lease', {}, 'capability.lease'], ['ledger deployment-check', { 'confirm-protected': true }, 'ledger.host-policy'],
    ['agents lock', {}, 'agents.lock'], ['repair authorize R-1', {}, 'repair.authorize'], ['configuration approve x', {}, 'configuration.approve']
  ]) {
    assert.equal(step(line, options)?.action, action, line);
    assert.equal(step(line, options).inRecord, true, `${line} keeps its seal with its record`);
  }
  assert.equal(await gateRepositoryPersonStep('/nonexistent', ['agents', 'lock', 'reviewer'], {}), null, 'the gate itself never asks');
  assert.equal(sealPathFor('singularity/goals/GEX-1/approvals/plan-generation-1-x.json'), 'singularity/goals/GEX-1/approvals/plan-generation-1-x.presence.json');
  assert.equal(sealPathFor('singularity/agents.lock.yml'), 'singularity/agents.lock.presence.json');
});

test('SF Guard never opted in: a repository store signs nothing and counts every record', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-stores-off-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  setPersonStepPresenceDependencies({ personTerminal: () => { throw new Error('no signature is asked for'); } });
  t.after(() => setPersonStepPresenceDependencies({}));
  assert.equal(await signInline(directory, 'capability-lease', lease(), { action: 'capability.lease', title: 'grant' }), null);
  assert.equal(await signBeside(directory, 'epic-completion', { key: 'x', bytes: '{}', action: 'epic.complete', title: 'complete' }), null);
  assert.equal(await storePolicy(directory), null);
  const entries = [lease()];
  assert.equal(await countedLeaseEntries(directory, entries), entries, 'the ledger is read exactly as before');
});

test('SF Guard on: the repository stores keep one touch with their record, readers count only verified ones, and the remote checks fail unsigned additions and removals', async (t) => {
  const key = softwarePresenceKey();
  const { root, git } = await guardedRepository(t, 'PSS-ST-1', key);
  const person = signer(key);
  setPersonStepPresenceDependencies(person);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); forgetRepositorySealPolicies(); });
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previous));
  const policy = await storePolicy(root);
  assert.equal(policy?.folded?.enabled, true);

  // A capability lease: signed in its payload; an edited, unsigned or carried signature counts for nothing.
  const granted = lease();
  const presence = await signInline(root, 'capability-lease', granted, { action: 'capability.lease', title: 'grant a break-glass lease on payments' });
  assert.equal(person.shown.length, 1, 'one card, one touch');
  granted.payload = { ...granted.payload, presence };
  assert.equal(inlineVerdict(policy, 'capability-lease', granted).state, 'signed');
  const widened = structuredClone(granted);
  widened.payload.relaxation = { maxDocumentBytes: 1 };
  assert.equal(inlineVerdict(policy, 'capability-lease', widened).code, 'PSS_SIGNATURE_INVALID');
  const unsigned = lease();
  const verdict = inlineVerdict(policy, 'capability-lease', unsigned);
  assert.equal(verdict.code, 'PSS_RECORD_UNSIGNED');
  assert.match(verdict.route, /capabilities lease grant payments/u);
  const carried = lease({ payload: { ...lease().payload, presence } });
  assert.equal(inlineVerdict(policy, 'capability-lease', carried).counts, false, 'a signature carried to another lease counts for nothing');
  const before = lease({ createdAt: OLD });
  assert.equal(inlineVerdict(policy, 'capability-lease', before).state, 'pre-signing', 'recorded before the opt-in');
  const counted = await countedLeaseEntries(root, [granted, widened, unsigned, before]);
  assert.deepEqual(counted.map((entry) => entry.eventId), [granted.eventId, before.eventId]);
  const definition = { version: 1, capabilities: { payments: { kind: 'collection', policy: {} } } };
  assert.equal(activeCapabilityLeases(definition, 'payments', counted).length, 2);
  // An unsigned revocation revokes nothing.
  const revocation = lease({ eventType: 'capability-lease-revoked', payload: { leaseId: granted.eventId, reason: 'done' } });
  assert.equal(activeCapabilityLeases(definition, 'payments', await countedLeaseEntries(root, [granted, revocation])).length, 1);

  // A repair authorization event: the signature travels in its data.
  const event = { repairId: 'RPR-1', at: new Date().toISOString(), data: { planSha256: 'a'.repeat(64), actor: ONE.email, leaseId: 'RLS-1', branch: 'sflow/repair/RPR-1' } };
  event.data.presence = await signInline(root, 'repair-authorization', event, { action: 'repair.authorize', title: 'authorize repair RPR-1' });
  assert.equal(inlineVerdict(policy, 'repair-authorization', event).state, 'signed');
  assert.equal(inlineVerdict(policy, 'repair-authorization', { ...event, data: { ...event.data, planSha256: 'b'.repeat(64) } }).counts, false);
  assert.match(inlineVerdict(policy, 'repair-authorization', { ...event, data: { ...event.data, presence: undefined } }).route, /repair authorize RPR-1/u);

  // TWO's per-person exception: recorded unsigned, labelled as a bypass, and counted.
  git('config', 'user.email', TWO.email);
  const excepted = lease({ actor: { name: TWO.name, email: TWO.email } });
  excepted.payload = { ...excepted.payload, presence: await signInline(root, 'capability-lease', excepted, { action: 'capability.lease', title: 'grant' }) };
  git('config', 'user.email', ONE.email);
  assert.equal(inlineVerdict(policy, 'capability-lease', excepted).state, 'bypass');

  // An agent's shell: refused before anything is written, with the route.
  setPersonStepPresenceDependencies(signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }));
  await assert.rejects(signBeside(root, 'epic-completion', { key: 'k', bytes: '{}', action: 'epic.complete', title: 'complete' }),
    (error) => error.code === 'PSS_CARD_NOT_SHOWN' && /Nothing was written/u.test(error.message));
  setPersonStepPresenceDependencies(person);

  // An Epic approval keeps its seal beside its content-addressed record; the readers drop an unsigned one.
  const portfolio = { initiativeRoot: 'singularity/initiatives' };
  const approval = (actor, at) => ({ type: 'approval', decision: 'approved', initiativeId: 'EPIC-1', phase: 'epic-requirements',
    subject: { type: 'phase', id: 'epic-requirements', sha256: 'c'.repeat(64) }, actor, identityAssurance: 'configured-local', agent: null, channel: 'cli', at, selfApproval: false });
  const target = { type: 'phase', id: 'epic-requirements', sha256: 'c'.repeat(64) };
  const signedApproval = await appendInitiativeRecord(root, portfolio, 'EPIC-1', 'approvals', approval(ONE, new Date().toISOString()),
    { sign: signInitiativeApproval(root, 'EPIC-1', 'epic-requirements', target) });
  const unsignedApproval = await appendInitiativeRecord(root, portfolio, 'EPIC-1', 'approvals', approval(TWO, new Date(Date.now() + 1000).toISOString()));
  await appendInitiativeRecord(root, portfolio, 'EPIC-1', 'approvals', approval({ ...ONE, email: 'old@example.com' }, OLD));
  const read = await readInitiativeRecords(root, portfolio, 'EPIC-1', 'approvals');
  assert.deepEqual(read.map((entry) => entry.standing.state).sort(), ['pre-signing', 'signed']);
  assert.ok(!read.some((entry) => entry.sha256 === unsignedApproval.sha256), 'an approval written while SF Guard is on with no seal counts for nothing');

  // A file record's seal binds its exact bytes.
  const receipt = `${JSON.stringify({ goalId: 'GEX-1', generation: 1, planSha256: 'sha256:p', at: new Date().toISOString() }, null, 2)}\n`;
  const receiptSeal = await signBeside(root, 'goal-plan-approval', { key: 'GEX-1/1/sha256:p', bytes: receipt, action: 'goal.plan-approve', title: 'approve' });
  assert.equal(fileVerdict(policy, 'goal-plan-approval', { key: 'GEX-1/1/sha256:p', bytes: receipt, seal: receiptSeal }).state, 'signed');
  assert.equal(fileVerdict(policy, 'goal-plan-approval', { key: 'GEX-1/1/sha256:p', bytes: receipt.replace('"generation": 1', '"generation": 2'), seal: receiptSeal }).code, 'PSS_SIGNATURE_INVALID');
  assert.equal(fileVerdict(policy, 'goal-plan-approval', { key: 'GEX-2/1/sha256:p', bytes: receipt, seal: receiptSeal }).counts, false, 'a seal carried to another record');

  // The branch check, on in-memory refs: an unsigned addition fails, an old unsigned one is a note, a removed seal fails.
  const goal = 'singularity/goals/GEX-1/approvals/plan-generation-1-p.json';
  const epicFile = `singularity/initiatives/EPIC-1/approvals/records/${unsignedApproval.sha256}.json`;
  const refs = {
    base: new Map([[goal, Buffer.from(receipt)], [sealPathFor(goal), receiptSeal], [epicFile, Buffer.from(unsignedApproval.path ? await readFile(path.join(root, unsignedApproval.path)) : '')]]),
    head: new Map([[epicFile, Buffer.from(await readFile(path.join(root, unsignedApproval.path)))], [goal, Buffer.from(receipt)],
      ['singularity/initiatives/EPIC-1/delivery/records/' + 'd'.repeat(64) + '.json', Buffer.from(JSON.stringify({ completedAt: new Date().toISOString() }))]])
  };
  const deps = { paths: async (ref) => [...refs[ref].keys()], file: async (ref, file) => refs[ref].get(file) ?? null };
  const branch = await storeRecordProblems(policy, { head: 'head', base: 'base' }, deps);
  // The goal receipt whose seal was removed: the removal, and the receipt reads unsigned; the new completion is unsigned.
  assert.deepEqual(branch.failures.map((entry) => entry.code).sort(), ['PSS_RECORD_REMOVED', 'PSS_RECORD_UNSIGNED', 'PSS_RECORD_UNSIGNED']);
  assert.ok(branch.failures.some((entry) => /epic complete EPIC-1/u.test(entry.route)));
  assert.ok(branch.failures.some((entry) => /goal plan approve GEX-1/u.test(entry.route)));
  assert.equal(branch.warnings.length, 1, 'the unsigned Epic approval already on the base is a note');

  // The agents lock: `agents lock` keeps the signature in the entry; the remote check fails an edit.
  const [agent] = await discoverAgents(root);
  assert.ok(agent, 'the fixture has an agent');
  person.shown.length = 0;
  await lockAgent(root, agent.id, { accepted: true, resolution: { source: agent.source, sourceSha256: agent.sha256, lockedAt: new Date().toISOString(), dependencies: [] } });
  assert.equal(person.shown.length, 1);
  const lockFile = path.join(root, 'singularity/agents.lock.yml');
  const locked = YAML.parse(await readFile(lockFile, 'utf8'));
  assert.equal(inlineVerdict(policy, 'agents-lock', locked.agents[agent.id], agent.id).state, 'signed');
  git('add', 'singularity/agents.lock.yml');
  git('commit', '-qm', 'Lock the agent, signed');
  const base = git('rev-parse', 'HEAD');
  locked.agents[agent.id].sourceSha256 = 'f'.repeat(64);
  await writeFile(lockFile, YAML.stringify(locked));
  git('commit', '-qam', 'Edit the lock by hand');
  const remote = await remotePresenceCheck(root, { base }, { signingKeys: async () => ({ status: 'listed', keys: [{ keyId: key.keyId, line: key.line }] }) });
  const lockFailure = remote.failures.find((entry) => /agents lock entry/u.test(entry.message));
  assert.equal(lockFailure?.code, 'PSS_SIGNATURE_INVALID', JSON.stringify(remote.failures));
  assert.match(lockFailure.route, /agents lock .* --update/u);

  // The state branch check: a lease entry the push adds must verify; a signed one never disappears.
  const signedEntry = Buffer.from(JSON.stringify(granted));
  const unsignedEntry = Buffer.from(JSON.stringify(unsigned));
  const ledger = {
    base: new Map([['ledger/entries/payments/1.json', signedEntry]]),
    head: new Map([['ledger/entries/payments/2.json', unsignedEntry]])
  };
  const state = await remoteStateCheck(root, { base: 'base' }, {
    head: async () => 'head', paths: async () => [], ledgerPaths: async (ref) => [...ledger[ref].keys()], file: async (ref, file) => ledger[ref]?.get(file) ?? null
  });
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.failures.map((entry) => entry.code).sort(), ['PSS_RECORD_REMOVED', 'PSS_RECORD_UNSIGNED']);
});

test('SF Guard at intake: the test-recovery agreement and accepted baseline decisions are signed in the new Story with one touch, and only signed ones admit', async (t) => {
  const key = softwarePresenceKey();
  const { root, item } = await guardedRepository(t, 'PSS-ST-2', key);
  const person = signer(key);
  setPersonStepPresenceDependencies(person);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); });
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previous));
  const { reviewedTrpRecord, signTrpIntakeReviews } = await import('../src/presence/intake-reviews.mjs');
  const stored = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(stored.resolution.presence?.status, 'required', 'the start-time pin is on the Story before its intake review');
  const fresh = () => ({ ...structuredClone(stored), testRecovery: { schemaVersion: 1 } });
  const agreement = { kind: 'story-test-recovery-agreement', id: 'agreement-1', recordSha256: `sha256:${'1'.repeat(64)}` };
  const decision = { kind: 'phase-risk-decision', id: 'baseline-risk-1', recordSha256: `sha256:${'2'.repeat(64)}` };

  // An agent's shell: refused with the route, and nothing is added to the Story.
  const refused = fresh();
  setPersonStepPresenceDependencies(signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }));
  await assert.rejects(signTrpIntakeReviews(root, refused, [agreement, decision], [null, null], 'sha256:plan'), (error) => error.code === 'PSS_CARD_NOT_SHOWN');
  assert.equal(refused.testRecovery.riskReviews, undefined);

  setPersonStepPresenceDependencies(person);
  const workflow = fresh();
  await signTrpIntakeReviews(root, workflow, [agreement, decision], [null, null], 'sha256:plan');
  assert.equal(person.shown.length, 1, 'one card and one touch for the whole intake review');
  assert.deepEqual(workflow.testRecovery.riskReviews.map((entry) => [entry.action, entry.record.id, Boolean(entry.presence?.signature)]),
    [['intake-accepted', 'agreement-1', true], ['intake-accepted', 'baseline-risk-1', true]]);
  assert.equal(reviewedTrpRecord(workflow, decision), true);
  assert.equal(reviewedTrpRecord(workflow, agreement), true);
  // An entry edited, or written by hand, counts for nothing; neither does a decision no review names.
  const edited = structuredClone(workflow);
  edited.testRecovery.riskReviews[1].planDigest = 'sha256:other';
  assert.equal(reviewedTrpRecord(edited, decision), false);
  const handWritten = fresh();
  handWritten.testRecovery.riskReviews = [{ action: 'intake-accepted', planDigest: 'sha256:plan', record: decision, authorityReceipt: null, reviewedAt: new Date().toISOString() }];
  assert.equal(reviewedTrpRecord(handWritten, decision), false);
  assert.equal(reviewedTrpRecord(fresh(), decision), false);
  // A Story SF Guard does not require reads every intake decision as before.
  const unpinned = fresh();
  delete unpinned.resolution.presence;
  assert.equal(reviewedTrpRecord(unpinned, decision), true);
});

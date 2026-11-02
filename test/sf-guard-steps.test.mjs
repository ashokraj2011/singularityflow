import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { run as guard } from '../src/commands/guard.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, preparePersonPresence } from '../src/presence/person-records.mjs';
import { isPersonStepRecord, setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { repositoryPersonStep } from '../src/presence/repository-step-routes.mjs';
import { repositoryStepStatement, signRepositoryStep, signTerminalReview } from '../src/presence/repository-steps.mjs';
import { verifyPresenceSignature } from '../src/presence/sshsig.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { CLI, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.6): a person's remaining steps. A Story's constitution exceptions and its
// person's workflow decisions are signed where the Story is written; reopen is signed as reject is;
// adjudications and source review decisions take the touch before they are written; every live
// terminal review and plan action authorization takes it over the exact card; and the repository-level
// steps (Spec Studio, a split's publication, configuration approval, the Epic, goal, SGOS, lease, host
// policy, agents lock and repair steps) follow the repository's current signed policy. Software
// stand-ins for the Secure Enclave are passed in-process; no environment switch reaches signing.

const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };

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

/** A repository with SF Guard on: ONE's key pinned, TWO under a per-person exception. */
async function guardedStory(t, work, key) {
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

test('the remaining person steps are named: Story families, and the repository-level routes', () => {
  assert.equal(isPersonStepRecord('constitutionExceptions', { articleId: 'ART-1', reason: 'x' }), true);
  assert.equal(isPersonStepRecord('decisionLog', { decision: 'route', by: 'person' }), true);
  assert.equal(isPersonStepRecord('decisionLog', { decision: 'route', by: 'rule' }), false, 'a rule\'s routing is never a person\'s');
  const step = (line, options = {}) => repositoryPersonStep(line.split(' '), options)?.action ?? null;
  assert.equal(step('configuration approve sflow/config-1'), 'configuration.approve');
  assert.equal(step('epic approve phase'), 'epic.approve');
  assert.equal(step('initiative review approve S-1'), 'epic.review-approve');
  assert.equal(step('initiative complete'), 'epic.complete');
  assert.equal(step('goal plan approve'), 'goal.plan-approve');
  assert.equal(step('intent ratify'), 'intent.ratify');
  assert.equal(step('program approve', { confirm: 'X' }), 'program.approve');
  assert.equal(step('program approve'), null, 'a preview signs nothing');
  assert.equal(step('capabilities lease'), 'capability.lease');
  assert.equal(step('ledger deployment-check', { 'confirm-protected': true }), 'ledger.host-policy');
  assert.equal(step('ledger deployment-check'), null);
  assert.equal(step('agents lock'), 'agents.lock');
  assert.equal(step('repair authorize R-1'), 'repair.authorize');
  assert.equal(step('agents lock', { 'dry-run': true }), null);
  assert.equal(step('telemetry enable'), null, 'telemetry consent is this machine\'s preference');
  assert.equal(step('approve specification'), null, 'a Story\'s approval is M2\'s, signed on its pin');
});

test('SF Guard on: a repository-level step takes the card and one touch, with routes for every refusal', async (t) => {
  const key = softwarePresenceKey();
  const { root, git } = await guardedStory(t, 'PSS-7', key);
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => { process.chdir(previous); setPersonStepPresenceDependencies({}); });
  const sign = async (deps, record = null) => {
    setPersonStepPresenceDependencies({ ...deps, argv: ['node', 'singularity-flow', 'agents', 'lock'] });
    try { return { value: await signRepositoryStep(root, { action: 'agents.lock', title: 'lock the trusted agents', lines: ['Step: lock'], record }) }; }
    catch (error) { return { error }; }
  };
  const person = signer(key);
  const record = { agents: ['reviewer'], reason: 'Trusted set reviewed.' };
  const signed = await sign(person, record);
  assert.equal(signed.error, undefined, signed.error?.message);
  assert.equal(person.shown.length, 1);
  assert.equal(signed.value.approver, approverId(ONE));
  assert.equal(record.presence, signed.value, 'the presence block travels with the record');
  const chain = JSON.parse(await readFile(path.join(root, PRESENCE_CHAIN_PATH), 'utf8'));
  const publicKey = chain.events.find((event) => event.kind === 'register').key;
  assert.equal(verifyPresenceSignature({ message: statementText(repositoryStepStatement(signed.value)), armored: signed.value.signature, publicKey }).valid, true);

  const agentRun = await sign(signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }));
  assert.equal(agentRun.error?.code, 'PSS_CARD_NOT_SHOWN');
  assert.equal(agentRun.error.details.nextAction.command, 'singularity-flow agents lock');
  const noSigner = await sign(signer(key, { signerAvailability: () => ({ available: false, reason: 'presence signing needs macOS' }) }));
  assert.equal(noSigner.error?.code, 'PSS_SIGNER_UNAVAILABLE');
  assert.match(noSigner.error.message, /Nothing was written[\s\S]*another approver[\s\S]*guard exception add approver-/u);

  // TWO's per-person exception: the step goes ahead unsigned, labelled as a bypass.
  git('config', 'user.email', TWO.email);
  const excepted = await sign(signer(key, { personTerminal: () => { throw new Error('an exception needs no terminal'); } }));
  git('config', 'user.email', ONE.email);
  assert.equal(excepted.error, undefined, excepted.error?.message);
  assert.match(excepted.value.bypass, /^EXC-/u);
  assert.equal(excepted.value.signature, undefined);

  // A live terminal review of this Story takes the touch over the exact card, on the Story's pin.
  forgetPresenceContexts();
  setPersonStepPresenceDependencies(signer(key));
  const review = await signTerminalReview(root, { planId: 'PQR-1', planHash: `sha256:${'b'.repeat(64)}`, subject: { workId: 'PSS-7', phaseId: 'specification' } },
    { actionId: 'PQR-1', label: 'Accept risk PQR-1' });
  assert.equal(review?.approver, approverId(ONE));
  assert.ok(review.signature, 'the review is signed');
  setPersonStepPresenceDependencies(signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }));
  forgetPresenceContexts();
  await assert.rejects(signTerminalReview(root, { planId: 'PQR-2', planHash: `sha256:${'c'.repeat(64)}`, subject: { workId: 'PSS-7', phaseId: 'specification' } },
    { actionId: 'PQR-2', label: 'Accept risk PQR-2' }), (error) => error.code === 'PSS_CARD_NOT_SHOWN');

  // Reopening completed work is signed as reject is, and its refusal names the reopen command.
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/PSS-7/workflow.json'), 'utf8'));
  forgetPresenceContexts();
  await assert.rejects(preparePersonPresence(root, { workflow, phase: workflow.phases.specification, actor: ONE, action: 'phase.reopen',
    command: 'singularity-flow reopen PSS-7 --to specification --reason "<why>"' }, signer(key, { personTerminal: () => ({ person: false, reason: 'a script' }) })),
  (error) => error.code === 'PSS_CARD_NOT_SHOWN' && /reopening this step/u.test(error.message) && error.details.nextAction.command.startsWith('singularity-flow reopen PSS-7'));

  // From a script, the CLI gates a repository step and a Spec Studio step before anything runs.
  for (const args of [['agents', 'lock'], ['spec', 'author', 'publish', 'SPEC-NONE']]) {
    const scripted = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: ONE.name } });
    assert.notEqual(scripted.status, 0, scripted.stdout);
    assert.match(scripted.stdout + scripted.stderr, /needs your presence signature, taken in your own terminal|SF Guard cannot sign on this computer/u, args.join(' '));
    assert.match(scripted.stdout + scripted.stderr, /Nothing was written/u);
  }
});

test('SF Guard off or absent: a repository-level step is exactly as before', async (t) => {
  const key = softwarePresenceKey();
  const { root } = await startedSpecificationStory(t, 'PSS-8', {
    configure: members,
    beforeStart: async ({ root: repository, git }) => {
      git('config', 'user.email', ONE.email);
      // Registered, never turned on.
      await sfGuard(repository, ['register'], {}, guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH);
      git('commit', '-qm', 'Register a presence key');
    }
  });
  setPersonStepPresenceDependencies(signer(key, { personTerminal: () => { throw new Error('no signature is asked for'); } }));
  t.after(() => setPersonStepPresenceDependencies({}));
  assert.equal(await signRepositoryStep(root, { action: 'agents.lock', title: 'lock' }), null);
  assert.equal(await signTerminalReview(root, { planId: 'X', planHash: 'x', subject: { workId: 'PSS-8' } }, { actionId: 'X' }), null);
});

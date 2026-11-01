import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvalRequirementsMet } from '../src/approval-authority.mjs';
import { approveCommand } from '../src/commands/approve.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { foreignKeyWarning, foreignPresenceKey } from '../src/presence/alarm.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import {
  attachPersonPresence, forgetPresenceContexts, loadPresenceContext, personRecordVerdict, pinRequirement,
  preparePersonPresence, presenceCounts, PRESENCE_PIN_SCHEMA, recordStatement
} from '../src/presence/person-records.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { CLI, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard M2 (SPEC-PSS-v1 AC-006 to AC-009): approve and reject on a Story SF Guard requires take the
// approver's presence signature, and only a verified or excepted approval counts. Software stand-ins
// for the Secure Enclave are passed in-process; no environment switch reaches signing or verification.

const WORK = 'PSS-1';
// The CLI's test identity is `<name>@example.com`; the in-process runs use the same email from Git.
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };

function members(configuration) {
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE, TWO];
}

/** A person at a Mac for `guard`, as the M1 tests pass one: their keys, GitHub's listing, the readers. */
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

/** The approve route's SF Guard readers for one person holding `key`; `overrides` change one. */
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
  const warn = console.warn;
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try { return { value: await action(), lines }; }
  catch (error) { return { error, lines }; }
  finally { console.log = log; console.warn = warn; process.chdir(previous); }
}

async function sfGuard(root, words, deps) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

async function approveInProcess(root, presence, options = {}) {
  forgetPresenceContexts();
  return inRoot(root, () => approveCommand(['approve', 'specification'], { yes: true, ...options }, { presence }));
}

const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

function cliAs(root, name, ...args) {
  return spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: name } });
}

test('a pin that says off but does not match the chain never turns SF Guard off', () => {
  const chain = { schema: 'sflow-presence-chain@1', chainId: 'a'.repeat(32), events: [] };
  assert.deepEqual(pinRequirement(null, chain), { required: false, reason: 'no-pin' });
  assert.equal(pinRequirement({ schema: PRESENCE_PIN_SCHEMA, status: 'required', chainId: chain.chainId, events: 0, tip: null }, chain).required, true);
  assert.equal(pinRequirement({ schema: PRESENCE_PIN_SCHEMA, status: 'off', chainId: chain.chainId, events: 0, tip: null }, chain).required, false);
  // A hand-edited pin that names events the chain does not have, or another tip, reads as required.
  assert.equal(pinRequirement({ schema: PRESENCE_PIN_SCHEMA, status: 'off', chainId: chain.chainId, events: 3, tip: null }, chain).required, true);
  assert.equal(pinRequirement({ schema: PRESENCE_PIN_SCHEMA, status: 'off', chainId: chain.chainId, events: 0, tip: 'sha256:0' }, chain).required, true);
  assert.equal(pinRequirement({ schema: 'something-else', status: 'off' }, chain).required, true);
});

test('SF Guard required: approve takes the card and the touch before anything is written, and only a verified approval counts', async (t) => {
  const key = softwarePresenceKey();
  const story = await startedSpecificationStory(t, WORK, {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      // ONE registers a Secure Enclave key; the opt-in names TWO, who has no Mac, as an exception.
      await sfGuard(root, ['register'], guardPerson(ONE.email, [key]));
      const enable = ['enable'];
      const outcome = await inRoot(root, () => guard(['guard', ...enable], { positionals: ['guard', ...enable],
        options: { json: true, exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' } }, guardPerson(ONE.email, [key])));
      assert.equal(outcome.error, undefined, outcome.error?.message);
      git('add', PRESENCE_CHAIN_PATH);
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { root, git, cli, item } = story;
  const started = await workflowOf(item);
  assert.equal(started.resolution.presence.schema, PRESENCE_PIN_SCHEMA);
  assert.equal(started.resolution.presence.status, 'required', 'the Story pins the policy it started under');
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  const decisions = () => (existsSync(path.join(item, 'approvals/specification')) ? readdirSync(path.join(item, 'approvals/specification')) : []);

  // AC-006: from a script, with no terminal and no person, nothing is written and the refusal names
  // the person's command (or, on a computer with no signer, the routes).
  const scripted = cliAs(root, ONE.name, 'approve', 'specification', '--yes');
  assert.notEqual(scripted.status, 0, scripted.stdout);
  assert.match(scripted.stdout + scripted.stderr, /needs your presence signature, taken in your own terminal|SF Guard cannot sign on this computer/u);
  assert.match(scripted.stdout + scripted.stderr, /Nothing was written/u);
  assert.match(scripted.stdout + scripted.stderr, /singularity-flow approve specification --work-id PSS-1|another approver can approve it/u);
  assert.deepEqual(decisions(), []);
  assert.equal((await workflowOf(item)).phases.specification.status, 'awaiting_approval');

  // AC-009: no signer here, or not the Mac holding the key: refused before any write, with routes.
  const noSigner = await approveInProcess(root, signer(key, { signerAvailability: () => ({ available: false, reason: 'presence signing needs macOS' }) }));
  assert.equal(noSigner.error?.code, 'PSS_SIGNER_UNAVAILABLE', noSigner.error?.message);
  assert.match(noSigner.error.message, /Nothing was written[\s\S]*another approver can approve it[\s\S]*guard exception add approver-/u);
  const otherMac = await approveInProcess(root, signer(key, { holdsKey: async () => false }));
  assert.equal(otherMac.error?.code, 'PSS_SIGNER_UNAVAILABLE', otherMac.error?.message);
  assert.match(otherMac.error.message, /guard rotate --key[\s\S]*guard revoke approver-/u);
  // An agent's run (or any process without the person's terminal) is handed the person's command.
  const agentRun = await approveInProcess(root, signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }));
  assert.equal(agentRun.error?.code, 'PSS_CARD_NOT_SHOWN', agentRun.error?.message);
  assert.equal(agentRun.error.details.nextAction.command, 'singularity-flow approve specification --work-id PSS-1');
  // Declining the Touch ID prompt writes nothing.
  const declined = await approveInProcess(root, signer(key, { sign: async () => { const error = new Error('Nothing was signed.'); error.code = 'PSS_PRESENCE_DECLINED'; throw error; } }));
  assert.equal(declined.error?.code, 'PSS_PRESENCE_DECLINED', declined.error?.message);
  assert.deepEqual(decisions(), []);
  assert.equal((await workflowOf(item)).phases.specification.status, 'awaiting_approval');

  // The card, then one touch: a signed approval.
  const person = signer(key);
  const approved = await approveInProcess(root, person);
  assert.equal(approved.error, undefined, `${approved.error?.message}\n${approved.lines.join('\n')}`);
  assert.equal(person.shown.length, 1, 'one card, shown before the touch');
  assert.match(person.shown[0].title, /approve PSS-1 \/ specification/u);
  const after = await workflowOf(item);
  assert.equal(after.phases.specification.status, 'approved');
  const record = after.phases.specification.approvals.at(-1);
  assert.equal(record.identityAssurance, 'presence-signed');
  assert.equal(record.presence.keyId, key.keyId);
  assert.equal(record.presence.approver, approverId(ONE));
  const summary = JSON.parse(await readFile(path.join(item, 'approvals/specification.json'), 'utf8'));
  assert.equal(summary.schemaVersion, 3, 'a summary holding a presence block is written at v3');
  forgetPresenceContexts();
  const context = await loadPresenceContext(root, after);
  assert.equal(context.required, true);
  assert.deepEqual(personRecordVerdict(context, record, { workflow: after }), { counts: true, state: 'signed', label: `signed with ${key.keyId}`, code: null, reason: null, signer: approverId(ONE) });

  // AC-007: a record changed after signing, a signature carried to another record, an unsigned
  // record, or one an agent signed with its own key: none counts.
  const verdict = (changed) => personRecordVerdict(context, changed, { workflow: after });
  assert.equal(verdict({ ...record, generation: record.generation + 1 }).code, 'PSS_SIGNATURE_INVALID');
  assert.equal(verdict({ ...record, phase: 'planning' }).code, 'PSS_SIGNATURE_INVALID');
  assert.equal(verdict({ ...record, reviewPacketSha256: `sha256:${'b'.repeat(64)}` }).code, 'PSS_SIGNATURE_INVALID');
  const { presence: _presence, ...unsigned } = record;
  assert.equal(verdict(unsigned).code, 'PSS_RECORD_UNSIGNED');
  const agent = softwarePresenceKey();
  const agentPresence = { ...record.presence, keyId: agent.keyId };
  agentPresence.signature = agent.sign(statementText(recordStatement(record, agentPresence, { chainId: context.chainId, workId: WORK })));
  assert.equal(verdict({ ...record, presence: agentPresence }).code, 'PSS_SIGNATURE_INVALID', 'an agent\'s own key is not the pinned key');
  // Two Stories on one chain keep their own pins: one pinned off before the opt-in counts every record.
  const offStory = { ...after, workItem: { ...after.workItem, id: 'PSS-OFF' },
    resolution: { ...after.resolution, presence: { ...after.resolution.presence, status: 'off', events: 0, tip: null } } };
  assert.equal((await loadPresenceContext(root, offStory)).required, false);
  assert.equal(presenceCounts(offStory), null);
  const counts = presenceCounts(after);
  assert.equal(typeof counts, 'function', 'the required Story still counts only verified records');
  const policy = after.phases.specification.approvalPolicy;
  assert.equal(approvalRequirementsMet(policy, [record], { counts }), true);
  assert.equal(approvalRequirementsMet(policy, [unsigned], { counts }), false, 'a forged approval does not count');
  assert.equal(approvalRequirementsMet(policy, [unsigned]), true, 'without SF Guard every record counts, as before');

  // The approval chain shows how each record stands.
  const chainView = cliAs(root, ONE.name, 'approvals', '--json');
  assert.equal(chainView.status, 0, chainView.stderr);
  const specView = JSON.parse(chainView.stdout).data.approvalChain.phases.find((phase) => phase.id === 'specification');
  assert.equal(specView.approval.decisions.at(-1).presence, `signed with ${key.keyId}`);
  assert.equal(specView.approval.state, 'approved');

  // Reject takes the same signature: a script is refused, a person's signed record verifies.
  const scriptedReject = cliAs(root, ONE.name, 'reject', 'specification', '--reason', 'Not yet.');
  assert.notEqual(scriptedReject.status, 0);
  const planning = { ...after.phases.specification, id: 'planning', label: 'Planning' };
  forgetPresenceContexts();
  const prepared = await preparePersonPresence(root, { workflow: after, phase: planning, actor: ONE, action: 'phase.reject' }, signer(key));
  const rejection = await attachPersonPresence(prepared, { decision: 'rejected', phase: 'planning', target: 'specification', reason: 'Not yet.',
    at: new Date().toISOString(), actor: ONE, authorityGroup: record.authorityGroup, identityAssurance: 'configured-local', generation: 1, reviewPacketSha256: `sha256:${'c'.repeat(64)}` });
  assert.equal(personRecordVerdict(prepared.context, rejection, { workflow: after }).state, 'signed');
  assert.equal(personRecordVerdict(prepared.context, { ...rejection, target: 'planning' }, { workflow: after }).code, 'PSS_SIGNATURE_INVALID');

  // AC-009: an approver under the signed per-person exception proceeds unsigned, labelled as a bypass.
  cli('prepare', 'planning');
  const { implementationPlan } = await import('./helpers/submitted-planning-story.mjs');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks');
  const bypassed = cliAs(root, TWO.name, 'approve', 'planning', '--yes');
  assert.equal(bypassed.status, 0, bypassed.stdout + bypassed.stderr);
  const planned = (await workflowOf(item)).phases.planning.approvals.at(-1);
  assert.equal(planned.presence.bypass, 'EXC-001');
  assert.notEqual(planned.identityAssurance, 'presence-signed', 'never read as signed');
  const labelled = JSON.parse(cliAs(root, ONE.name, 'approvals', '--json').stdout).data.approvalChain.phases.find((phase) => phase.id === 'planning');
  assert.equal(labelled.approval.decisions.at(-1).presence, 'bypass: per-person exception EXC-001');

  // The foreign-key alarm: a key pinned for this person that this Mac does not hold is named, with the
  // revoke route; one it holds is not.
  const held = await foreignPresenceKey(root, { identify: () => ONE, listIdentities: () => ({ available: true, identities: [{ keyId: key.keyId }] }) });
  assert.equal(held, null);
  const foreign = await foreignPresenceKey(root, { identify: () => ONE, listIdentities: () => ({ available: true, identities: [] }) });
  assert.deepEqual(foreign, { approver: approverId(ONE), keyId: key.keyId, seq: 0 });
  assert.match(foreignKeyWarning(foreign), /PSS_FOREIGN_KEY[\s\S]*guard revoke approver-[0-9a-f]{12} --reason "not my key"/u);
  git('status', '--short');
});

test('a Story started while SF Guard was off keeps its pinned policy: its approvals count, labelled pre-signing', async (t) => {
  const key = softwarePresenceKey();
  const story = await startedSpecificationStory(t, 'PSS-2', {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      // Registered, not yet on: the Story starts while SF Guard is off.
      await sfGuard(root, ['register'], guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH);
      git('commit', '-qm', 'Register a presence key');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { root, cli, item } = story;
  assert.equal((await workflowOf(item)).resolution.presence.status, 'off');
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification('PSS-2', 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  // The repository opts in afterwards; the running Story keeps the policy it started under.
  await sfGuard(root, ['enable'], guardPerson(ONE.email, [key]));
  const workflow = await workflowOf(item);
  assert.equal(workflow.phases.specification.status, 'approved');
  forgetPresenceContexts();
  const context = await loadPresenceContext(root, workflow);
  assert.deepEqual([context.required, context.optedIn], [false, true]);
  const record = workflow.phases.specification.approvals.at(-1);
  assert.equal(personRecordVerdict(context, record, { workflow }).label, 'pre-signing: SF Guard was off when this Story started');
  const view = JSON.parse(cliAs(root, ONE.name, 'approvals', '--json').stdout).data.approvalChain.phases.find((phase) => phase.id === 'specification');
  assert.deepEqual([view.approval.state, view.approval.decisions.at(-1).presence], ['approved', 'pre-signing: SF Guard was off when this Story started']);
  // Later steps follow the pinned policy: nothing asks this Story for a signature, and every record counts.
  assert.equal(presenceCounts(workflow), null);
  const prepared = await preparePersonPresence(root, { workflow, phase: workflow.phases.planning, actor: ONE, action: 'phase.approve' }, signer(key));
  assert.equal(prepared, null, 'an approval on this Story takes no signature');
  // Whereas a Story starting now pins the policy as it stands: required.
  const { presencePinForStart } = await import('../src/presence/person-records.mjs');
  assert.equal((await inRoot(root, () => presencePinForStart(root))).value.status, 'required');
});

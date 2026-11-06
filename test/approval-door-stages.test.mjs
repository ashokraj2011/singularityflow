/**
 * What approve refuses before the gate, and the Story's ending after it, is in the approval check first
 * [study 6.1 rule 4, 6.6 S2]. A preview only: `approve` runs its own door and ending unchanged.
 *
 * The check once said "would pass every check" and the door refused; a chat read a whole review, then
 * SF Guard refused for want of a terminal; the last step offered Approve and the ending refused it.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { approvalAdvisories } from '../src/approval-check.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { approveCommand } from '../src/commands/approve.mjs';
import { loadApprovalPacket } from '../src/commands/approval-packet.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { evaluateTerminalReadiness, terminalReadinessOnce } from '../src/evidence/terminal.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { main } from '../src/cli.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { specification, startedSpecificationStory, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };

const source = async (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');

/**
 * Every check at approve's door, and where the person hears of it first. `stage` is a stage of the
 * approval check; `consent` is the person's own answer to this approval, which no preview can know.
 */
const DOOR = Object.freeze({
  assertLifecycleWorktreeClean: 'check: worktreeRefusals',
  assertApprovalSubmitted: 'check: only explains a dirty step not yet submitted, which the check does not read',
  assertNoPendingPublication: 'gate stage: publication',
  assertPhaseSequence: 'gate stage: sequence',
  assertConvergencePublicationReady: 'gate stage: convergence',
  resolveSelectionReceipt: 'consent: the receipt the person answered',
  preparePersonPresence: 'check: presenceRefusals',
  requireApprovalAuthority: 'gate stage: identity',
  prepareApprovalDecisions: 'consent: the list options the person chose',
  confirm: 'consent: the typed confirmation'
});

test('every check at approve\'s door is in the approval check, or is the person\'s own answer', async () => {
  const door = `${await source('commands/shared/decision-workflow.mjs')}\n${await source('commands/approve.mjs')}`;
  const called = [...new Set([...door.matchAll(/\b((?:assert|require|prepare|resolve)[A-Z]\w+)\(/gu)].map((match) => match[1]))]
    .filter((name) => !['resolveWorkspace', 'requireApprovalAuthorityRoute'].includes(name)).sort();
  // A check nothing maps here could refuse without the check saying so first: map it, or make it a stage.
  assert.deepEqual(called.filter((name) => !Object.hasOwn(DOOR, name)), []);
  const check = await source('approval-check.mjs');
  for (const [name, where] of Object.entries(DOOR)) {
    if (where.startsWith('check: ') && !where.includes('only explains')) assert.ok(check.includes(where.slice(7)), `${name}: ${where}`);
  }
  const gate = await source('state.mjs');
  for (const where of Object.values(DOOR).filter((entry) => entry.startsWith('gate stage: '))) assert.ok(gate.includes(`await stage('${where.slice(12)}'`), where);
  // The ending is the check's last read, and approve still runs its own.
  assert.match(check, /\.\.\.gateHolds, \.\.\.await endingRefusals\(/u);
  assert.match(await source('story-publication-service.mjs'), /await assertTerminalTransition\(root, config, workflow\)/u);
});

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
    githubKeys: async () => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString() }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false })
  };
}

function signer(key, overrides = {}) {
  return {
    personTerminal: () => ({ person: true, reason: null }),
    signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => JSON.stringify(fields),
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false }),
    ...overrides
  };
}

async function inRoot(root, action) {
  const previous = process.cwd();
  const [log, warn] = [console.log, console.warn];
  process.chdir(root);
  console.log = () => {};
  console.warn = () => {};
  try { return { value: await action() }; } catch (error) { return { error }; } finally { console.log = log; console.warn = warn; process.chdir(previous); }
}

test('SF Guard\'s door is in the check: the same refusal, its route, and nothing recorded by looking', async (t) => {
  const WORK = 'DOOR-PSS';
  const key = softwarePresenceKey();
  const { root, git, cli, item } = await startedSpecificationStory(t, WORK, { configure: members,
    beforeStart: async ({ root: repository, git: run }) => {
      run('config', 'user.email', ONE.email);
      const person = guardPerson(ONE.email, [key]);
      assert.equal((await inRoot(repository, () => guard(['guard', 'register'], { positionals: ['guard', 'register'], options: { json: true } }, person))).error, undefined);
      assert.equal((await inRoot(repository, () => guard(['guard', 'enable'], { positionals: ['guard', 'enable'],
        options: { json: true, exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' } }, person))).error, undefined);
      run('add', PRESENCE_CHAIN_PATH, '.github/agents');
      run('commit', '-qm', 'Turn SF Guard on');
      run('push', '-q', 'origin', 'main');
    } });
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  forgetPresenceContexts();
  setPersonStepPresenceDependencies(signer(key));
  const published = await inRoot(root, () => main(['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place', '--json']));
  setPersonStepPresenceDependencies({});
  assert.equal(published.error, undefined, published.error?.message);
  cli('submit', 'specification', '--skip-checks');

  const head = git('rev-parse', 'HEAD');
  const check = async (overrides) => {
    forgetPresenceContexts();
    const { definition, workflow } = await loadAcceptedStoryExecution(root, WORK);
    return (await approvalAdvisories(root, definition, workflow, workflow.phases.specification, { presence: signer(key, overrides) })).approvalCheck;
  };
  const gateHolds = (value) => value.holds.filter((hold) => hold.code.startsWith('PSS_'));
  assert.deepEqual(gateHolds(await check({})), [], 'a person at the Mac that holds the key sees nothing');

  // A chat, or VS Code: the hold says so, and Approve stays offered, since that refusal hands over the command.
  const chat = await check({ personTerminal: () => ({ person: false, reason: 'an agent started this command' }) });
  const [card] = gateHolds(chat);
  assert.equal(card.code, 'PSS_CARD_NOT_SHOWN');
  assert.deepEqual([card.owner, card.clearedBy.kind, card.who], ['you-decide', 'viewer-terminal', 'You take this step in your own terminal']);
  assert.equal(card.action.command, `singularity-flow approve specification --work-id ${WORK}`);
  assert.equal(chat.ready, true, 'approving is not held; it is taken in the terminal');
  assert.equal(chat.statement, 'Approving specification takes your signature, in your own terminal.');
  const real = await inRoot(root, () => { forgetPresenceContexts(); return approveCommand(['approve', 'specification'], { yes: true }, { presence: signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }) }); });
  assert.equal(real.error?.code, card.code, 'approve refuses with what the check said');

  // A computer with no signer: nothing can be taken here, so it does hold, with a route.
  const noSigner = await check({ signerAvailability: () => ({ available: false, reason: 'presence signing needs macOS' }) });
  const [held] = gateHolds(noSigner);
  assert.deepEqual([held.code, held.owner, noSigner.ready, held.action.command], ['PSS_SIGNER_UNAVAILABLE', 'this-checkout', false, 'singularity-flow guard status']);
  const otherSigner = await inRoot(root, () => { forgetPresenceContexts(); return approveCommand(['approve', 'specification'], { yes: true }, { presence: signer(key, { signerAvailability: () => ({ available: false, reason: 'presence signing needs macOS' }) }) }); });
  assert.equal(otherSigner.error?.code, held.code);

  // /sf-approve says it before the review, with the person's exact command, and begins no receipt.
  const value = { approvalCheck: chat, phaseStatus: 'awaiting_approval', classification: 'already-submitted' };
  let begun = false;
  const packet = await loadApprovalPacket({ workId: WORK, cwd: root }, { runStep: async (argv) => { begun ||= argv[0] === 'choices'; return { ok: true, value }; } });
  assert.deepEqual([packet.begun, packet.reason, packet.nextAction.command, packet.nextAction.copilotCommand, begun],
    [false, 'approval-holds', `singularity-flow approve specification --work-id ${WORK}`, null, false]);

  // Looking wrote nothing.
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain=v1'), '');
});

test('the Story\'s ending is in the check at its last step, the one evaluation read once', async (t) => {
  const WORK = 'DOOR-END';
  const { git } = await submittedPlanningStory(t, WORK);
  const root = git('rev-parse', '--show-toplevel');
  const { definition, workflow } = await loadAcceptedStoryExecution(root, WORK);
  const before = (await approvalAdvisories(root, definition, workflow, workflow.phases.planning)).approvalCheck;
  assert.deepEqual(before.holds.filter((hold) => hold.code === 'STORY_COMPLETION_REFUSED'), [], 'a step that does not end the Story reads no ending');

  // The same Story with planning as its last step; nothing is written.
  const last = structuredClone(workflow);
  last.phaseOrder = last.phaseOrder.slice(0, last.phaseOrder.indexOf('planning') + 1);
  for (const id of Object.keys(last.phases)) if (!last.phaseOrder.includes(id)) delete last.phases[id];
  last.nextDecisions = [];
  const open = { blockers: ['WORK:AC-001 is unimplemented.'], recovery: ['singularity-flow evidence matrix DOOR-END --json'] };
  const check = (await approvalAdvisories(root, definition, last, last.phases.planning, { readEnding: async () => open })).approvalCheck;
  const ending = check.holds.at(-1);
  assert.equal(ending.code, 'STORY_COMPLETION_REFUSED', 'after the gate, as approve meets it');
  assert.equal(check.ready, false);
  assert.match(ending.summary, /^Story DOOR-END cannot finish yet: its final evaluation found an open obligation/u);
  assert.equal(ending.action.command, 'singularity-flow evidence matrix DOOR-END --json', 'with the route the evaluation names');
  assert.match(ending.message, /WORK:AC-001 is unimplemented/u);
  // An approval that does not reach the minimum ends nothing yet.
  const second = structuredClone(last);
  second.phases.planning.approvalPolicy.minimum = 2;
  assert.ok(!(await approvalAdvisories(root, definition, second, second.phases.planning, { readEnding: async () => open })).approvalCheck.holds.some((hold) => hold.code === 'STORY_COMPLETION_REFUSED'));

  // This fixture's real evaluation cannot run (nothing delivered a claim map), and the check says so
  // with its own refusal rather than "would pass every check", as readiness does: not who, but that.
  const expected = await evaluateTerminalReadiness(root, definition, last, { stage: 'approval' }).catch((error) => error);
  assert.equal(expected.code, 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED');
  const unavailable = (await approvalAdvisories(root, definition, last, last.phases.planning)).approvalCheck;
  assert.deepEqual([unavailable.holds.at(-1).code, unavailable.holds.at(-1).clearedBy.kind, unavailable.ready], [expected.code, 'nobody', false]);

  // One read per command, and a changed Story reads again.
  const once = terminalReadinessOnce(root, definition, last);
  assert.equal(terminalReadinessOnce(root, definition, last), once);
  await assert.rejects(once);
  last.status = 'changed';
  const again = terminalReadinessOnce(root, definition, last);
  assert.notEqual(again, once);
  await assert.rejects(again);
});

test('the ending names what the list already lists: one item for one problem, and a sign-off it waits for holds', () => {
  const step = (id, status) => ({ id, label: id, status, generation: 1, approvals: [], approvalPolicy: { authorities: ['all'], minimum: 1 } });
  const workflow = { workItem: { id: 'W-1' }, currentPhase: 'release', phaseOrder: ['release'], phases: { release: step('release', 'awaiting_approval') },
    resolution: { approvalAuthorities: { all: { label: 'Everyone', members: [ONE] } } } };
  const ending = { code: 'STORY_COMPLETION_REFUSED', owner: 'someone-decides', who: 'The decision list names who decides each', summary: 'Story W-1 cannot finish yet.', clearedBy: { kind: 'listed' },
    action: { label: '', command: 'singularity-flow evidence matrix W-1 --json' } };
  const list = (owed) => decisionPacket(workflow, { phaseId: 'release', pending: { owed }, approvalCheck: { holds: [ending] } },
    { authorities: workflow.resolution.approvalAuthorities, actor: ONE, at: '2026-11-06T00:00:00.000Z' });
  const witness = { kind: 'witness', clauseId: 'W-1:AC-001', clauseText: 'It works', slot: 'w1', method: 'visual', files: ['shot.png'], owners: ['release'], available: true, groups: ['all'], command: 'singularity-flow decision witness W-1' };
  const listed = list([witness]);
  assert.deepEqual(listed.items.map((item) => [item.kind, item.holdsApproval]), [['owed-decision', true], ['approval', false]]);
  assert.equal(listed.next.kind, 'owed-decision', 'what holds it comes first');
  const nothingListed = list([]);
  assert.deepEqual(nothingListed.items.map((item) => [item.kind, item.holdsApproval]), [['approval-hold', true], ['approval', false]]);
  assert.equal(nothingListed.next.command, 'singularity-flow evidence matrix W-1 --json');
});

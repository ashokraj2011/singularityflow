/**
 * Intent amendments from Copilot chat [owner, 2026-11-13]: the agent drafts and proposes; a person decides
 * and acknowledges on the decisions card (D1, D2); while an amendment proposed from a step waits, that step
 * pauses in every Copilot turn and plain chat (D3). Propose is offered only when it can succeed, and a step
 * an approved amendment reopened is told which clauses changed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { copilotAction } from '../src/copilot-guidance.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { plainChatChangeGuard } from '../src/copilot-plain-chat.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { intentAmendmentPause, intentAmendmentProposable } from '../src/intent-amendment-pause.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { assertIntentAmendmentNotPausing, phaseGovernanceHold } from '../src/phase-governance-routing.mjs';
import { deriveMutationContract } from '../src/phase-mutation-contract.mjs';
import { phasePromptExecutionContract } from '../src/phase-prompt-composer.mjs';
import { intentAmendmentDraftPath, phaseStagingPaths } from '../src/phase-staging-paths.mjs';
import { refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';

const WORK = 'IAC-1';
const pending = () => ({ intentAmendments: [{ id: 'AMD-001', status: 'proposed', changedClauses: [`${WORK}:REQ-001`] }],
  history: [{ event: 'intent_amendment_proposed', phase: 'build', detail: `AMD-001 proposes 1 clause change(s): ${WORK}:REQ-001` }] });

/** An approved scope step and a code step after it with its generation open; `amendment` adds a proposal from it. */
function story({ amendment = false, status = 'in_progress' } = {}) {
  return {
    workItem: { id: WORK, branch: WORK }, status: 'in_progress', currentPhase: 'build', phaseOrder: ['intake', 'build'],
    phases: {
      intake: { id: 'intake', label: 'Intake', status: 'approved', generation: 1, writeScope: 'artifact-only',
        requiredArtifact: { path: 'artifacts/intake/requirements.md', kind: 'requirements' }, generationPolicy: { task: 'document', requirement: 'required' } },
      build: { id: 'build', label: 'Build', status, generation: 0, writeScope: 'source-and-artifact',
        generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } }
    },
    resolution: { obligationGraph: { nodes: [{ id: 'intake', responsibilities: ['scope'] }, { id: 'build', responsibilities: ['implement'] }] } },
    history: [], intentAmendments: [], ...(amendment ? pending() : {})
  };
}

async function fixture(t, workflow) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-iac-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q', '-b', WORK); git('config', 'user.name', 'IAC Tester'); git('config', 'user.email', 'iac@example.test');
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 2\n');
  const definition = { workItemRoot: 'singularity/work-items' };
  const item = path.join(root, definition.workItemRoot, WORK);
  await mkdir(path.join(item, 'artifacts', 'intake'), { recursive: true });
  await writeFile(path.join(item, 'artifacts', 'intake', 'requirements.md'), `# Requirements\n\n- The value is 1. [${WORK}:REQ-001]\n`);
  await writeFile(path.join(item, 'workflow.json'), JSON.stringify(workflow));
  git('add', '-A'); git('commit', '-qm', 'fixture');
  await mkdir(path.join(root, '.git', 'singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git', 'singularity-flow', 'session.json'), JSON.stringify({ workId: WORK }));
  const accepted = { definition, workflow };
  const enter = async (skill, sessionId) => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  return { root, definition, workflow, enter };
}

const shell = (payload, root, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: root } });
const edit = (payload, file) => mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: file } });

test('D3: a step whose amendment waits pauses in every Copilot turn; reads, the amendment\'s status and draft stay open', async (t) => {
  const f = await fixture(t, story({ amendment: true }));
  const moving = ['singularity-flow phase publish build --authored governed-agent --channel copilot-host',
    'singularity-flow phase prepublish build --for-agent --json --publish-if-ready', 'singularity-flow submit build', `singularity-flow submit build --work-id ${WORK}`,
    'singularity-flow prepare build', 'singularity-flow phase begin build --json', `singularity-flow phase rollover build --confirm sha256:${'a'.repeat(64)}`];
  const open = [`singularity-flow story intent-amendment status --work-id ${WORK} --json`,
    `singularity-flow story intent-amendment draft --work-id ${WORK} --clause ${WORK}:REQ-001`, 'singularity-flow phase prepublish build --for-agent --json',
    `singularity-flow decisions ${WORK} --json`];
  for (const [skill, session] of [['/sf-code', 'code'], ['/sf-phase', 'phase'], ['/sf-next', 'next'], ['/sf-publish build', 'publish']]) {
    const payload = await f.enter(skill, session);
    for (const command of moving) {
      const denied = await shell(payload, f.root, command);
      assert.equal(denied.permissionDecision, 'deny', `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /^INTENT_AMENDMENT_PENDING_PAUSE: this would move the step AMD-001 was proposed from, which pauses until a person decides it on the decisions card/u, `${skill}: ${command}`);
      assert.match(denied.permissionDecisionReason, /AMD-001 waits for the requirements approvers; this step pauses until it is decided\. Decide it on the decisions card: \/sf-decide IAC-1 \(a stale one is refreshed there\)/u);
      assert.deepEqual([denied.next[0].copilotCommand, denied.next[0].command], ['/sf-decide IAC-1', 'singularity-flow decisions IAC-1'], `${skill}: ${command}`);
    }
    for (const command of open) assert.deepEqual(await shell(payload, f.root, command), {}, `${skill}: ${command}`);
  }
  // An authoring turn writes no file of the step or the application, only the amendment's own draft.
  const code = await f.enter('/sf-code', 'code-edits');
  const denied = await edit(code, 'src/App.jsx');
  assert.match(denied.permissionDecisionReason, /^INTENT_AMENDMENT_PENDING_PAUSE: no file of this step changes while its amendment waits[^\n]*\(src\/App\.jsx\)\. AMD-001 waits for the requirements approvers/u);
  assert.equal(denied.next[0].copilotCommand, '/sf-decide IAC-1');
  assert.equal((await edit(code, `singularity/work-items/${WORK}/artifacts/build/summary.md`)).permissionDecision, 'deny');
  assert.deepEqual(await edit(code, intentAmendmentDraftPath(gitDir(f.root), f.workflow)), {});
  // Another Story's command is not this step's.
  assert.deepEqual(await shell(code, f.root, 'singularity-flow submit build --work-id OTHER-1'), {});
});

test('D3: once nothing waits, the same turn edits and publishes as before', async (t) => {
  const f = await fixture(t, { ...story(), intentAmendments: [{ id: 'AMD-001', status: 'rejected' }], history: pending().history });
  const code = await f.enter('/sf-code', 'code');
  assert.deepEqual(await edit(code, 'src/App.jsx'), {});
  assert.deepEqual(await shell(code, f.root, 'singularity-flow phase publish build --authored governed-agent --channel copilot-host'), {});
  assert.deepEqual(await shell(code, f.root, 'singularity-flow submit build'), {});
  const contract = deriveMutationContract({ definition: f.definition, workflow: f.workflow, turnMode: 'authoring' });
  assert.equal(contract.policy.intentAmendmentPause, undefined);
  assert.equal(contract.allow.application, true);
});

test('D3: the pause is bound to the step it was proposed from, read from the proposal\'s own history entry', () => {
  const workflow = story({ amendment: true });
  assert.equal(intentAmendmentPause(workflow)?.id, 'AMD-001');
  assert.equal(intentAmendmentPause(workflow, 'intake'), null, 'only the current step');
  assert.equal(intentAmendmentPause({ ...workflow, history: [] }), null, 'an older proposal with no history entry pauses nothing');
  assert.equal(intentAmendmentPause({ ...workflow, history: [{ ...workflow.history[0], phase: 'intake' }] }), null, 'a proposal from another step');
  // The contract names the card as its one route and grants no edits; the composed prompt says so too.
  const contract = deriveMutationContract({ definition: {}, workflow, turnMode: 'authoring' });
  assert.deepEqual(contract.policy.intentAmendmentPause, { id: 'AMD-001', phaseId: 'build' });
  assert.deepEqual([contract.allow.application, contract.allow.artifacts], [false, []]);
  assert.deepEqual([contract.next[0].copilotCommand, contract.next[0].command], ['/sf-decide IAC-1', 'singularity-flow decisions IAC-1']);
  assert.match(phasePromptExecutionContract({}, workflow, workflow.phases.build).lines[0],
    /^- Changes allowed: AMD-001 waits for the requirements approvers; this step pauses until it is decided\. Decide it on the decisions card: \/sf-decide IAC-1/u);
  // An approval waiting on it keeps its own hold (approval-check.mjs): the step awaiting approval holds no governance pause.
  const awaiting = story({ amendment: true, status: 'awaiting_approval' });
  assert.equal(phaseGovernanceHold(awaiting, awaiting.phases.build), null);
});

test('D3: the engine refuses begin, prepare, publish and submit of the paused step, with the card and the reject route', () => {
  const workflow = story({ amendment: true });
  assert.throws(() => assertIntentAmendmentNotPausing(workflow, 'build'), (error) => {
    assert.equal(error.code, 'INTENT_AMENDMENT_PENDING_PAUSE');
    assert.match(error.message, /^AMD-001 waits for the requirements approvers; this step pauses until it is decided\. Decide it on the decisions card: \/sf-decide IAC-1 \(a stale one is refreshed there\)\.$/u);
    assert.deepEqual(error.details.actions.map((action) => [action.command, action.skill ?? null]), [
      ['singularity-flow decisions IAC-1', '/sf-decide'],
      ['singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001 --work-id IAC-1', null]]);
    return true;
  });
  // Its plan: the card first, then the reject route; nothing to repair, recover or return.
  let error;
  try { assertIntentAmendmentNotPausing(workflow, 'build'); } catch (caught) { error = caught; }
  const plan = refusalRemediationPlan(error, ['submit', 'build']);
  assert.deepEqual(plan.steps.map((step) => [step.copilotCommand ?? null, step.command]), [['/sf-decide IAC-1', 'singularity-flow decisions IAC-1'],
    [null, 'singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001 --work-id IAC-1']]);
  assert.match(plan.retry.label, /once the person has decided/u);
  assert.doesNotMatch(renderRefusalPlan(plan), /sf-recover|singularity-flow recover /u);
  assert.doesNotThrow(() => assertIntentAmendmentNotPausing(workflow, 'intake'));
  assert.doesNotThrow(() => assertIntentAmendmentNotPausing(story(), 'build'));
  // Submission reads the same hold through governance, so the planners lead with the card.
  const hold = phaseGovernanceHold(workflow, workflow.phases.build);
  assert.equal(hold.code, 'INTENT_AMENDMENT_PENDING_PAUSE');
  assert.deepEqual([hold.actions[0].copilotCommand, hold.actions[1].command, hold.actions[1].optional],
    ['/sf-decide IAC-1', `singularity-flow story intent-amendment status --work-id ${WORK} --json`, true]);
});

test('nextsteps leads with the card while an amendment waits or awaits acknowledgement; propose is offered only when it can succeed', () => {
  const plain = story();
  assert.equal(intentAmendmentProposable(plain), true);
  const offered = workflowGuide(plain).nextActions.find((action) => action.command.includes('intent-amendment propose'));
  assert.deepEqual([offered.skill, offered.copilotCommand, offered.optional], ['/sf-reject', '/sf-reject intent-amendment propose', true]);
  const proposeNext = workflowNextSteps(plain).find((action) => action.command.includes('intent-amendment propose'));
  assert.deepEqual([proposeNext.timing, proposeNext.copilotCommand], ['alternative', '/sf-reject intent-amendment propose']);

  const waiting = story({ amendment: true });
  assert.equal(intentAmendmentProposable(waiting), false);
  const steps = workflowNextSteps(waiting);
  assert.deepEqual([steps[0].timing, steps[0].command, steps[0].copilotCommand], ['now', 'singularity-flow decisions IAC-1', '/sf-decide IAC-1']);
  assert.ok(!steps.some((action) => action.command.includes('intent-amendment propose')), 'proposing again would be refused');
  assert.ok(!steps.some((action) => action.timing === 'now' && action !== steps[0]));

  // Proposed after the submission, it holds the approval: the card leads there too.
  const submitted = workflowGuide(story({ amendment: true, status: 'awaiting_approval' })).nextActions;
  assert.deepEqual([submitted[0].command, submitted[0].copilotCommand], ['singularity-flow decisions IAC-1', '/sf-decide IAC-1']);
  assert.match(submitted[0].reason, /decides AMD-001 on the decisions card; approving build waits for it/u);
  assert.match(submitted[1].command, /^singularity-flow approve build /u);

  const approved = { ...story(), intentAmendments: [{ id: 'AMD-001', status: 'approved', acknowledgementRequired: true, changedClauses: [`${WORK}:REQ-001`] }] };
  assert.equal(intentAmendmentProposable(approved), false);
  const acknowledge = workflowNextSteps(approved);
  assert.deepEqual([acknowledge[0].timing, acknowledge[0].copilotCommand], ['now', '/sf-decide IAC-1']);
  assert.match(acknowledge[0].reason, /^Acknowledge AMD-001 on the decisions card/u);
  assert.ok(!acknowledge.some((action) => action.command.includes('intent-amendment propose')));
  // Acknowledged, it may propose again.
  approved.intentAmendments[0] = { ...approved.intentAmendments[0], acknowledgedAt: '2026-11-13T00:00:00.000Z', acknowledgementRequired: false };
  assert.equal(intentAmendmentProposable(approved), true);
});

test('D1/D2: a returned decide or acknowledge route is the person\'s, on the card; the propose route names its own /sf-reject form', () => {
  for (const command of [`singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001 --work-id ${WORK}`,
    `singularity-flow story intent-amendment acknowledge AMD-001 --work-id ${WORK}`]) {
    const act = agentAct({ error: { code: 'X_REFUSED', message: 'No.' }, nextAction: { command, label: 'A person decides it.' } });
    assert.deepEqual([act.state, act.do.copilot, act.do.shell], ['confirm-in-terminal', `/sf-decide ${WORK}`, command]);
    assert.match(act.said, /on the decisions card: give them do\.copilot, or do\.shell for their own terminal; never run it/u);
  }
  assert.equal(copilotAction({ command: `singularity-flow story intent-amendment draft --work-id ${WORK}` }).copilotCommand, '/sf-reject intent-amendment propose');
});

test('an authoring turn may write the Story\'s amendment draft once its step may propose one, and no sooner', () => {
  const workflow = story();
  const draft = intentAmendmentDraftPath('/repo/.git', workflow);
  assert.deepEqual(phaseStagingPaths({ gitDirectory: '/repo/.git', definition: {}, workflow, turnMode: 'authoring' }), [draft]);
  assert.deepEqual(phaseStagingPaths({ gitDirectory: '/repo/.git', definition: {}, workflow, turnMode: 'kernel-only' }), []);
  const unapproved = story();
  unapproved.phases.intake.status = 'in_progress';
  assert.deepEqual(phaseStagingPaths({ gitDirectory: '/repo/.git', definition: {}, workflow: unapproved, turnMode: 'authoring' }), []);
});

test('a step an approved amendment reopened is told which clauses it added, revised and removed', () => {
  const workflow = story();
  workflow.phases.build.intentAmendmentRevalidation = { id: 'AMD-002', state: 'affected', changedClauses: [`${WORK}:REQ-002`, `${WORK}:REQ-001`, `${WORK}:AC-003`],
    added: [`${WORK}:REQ-002`], revised: [`${WORK}:REQ-001`], removed: [`${WORK}:AC-003`], acknowledgedAt: null, revalidatedAt: null };
  const lines = phasePromptExecutionContract({}, workflow, workflow.phases.build).lines;
  assert.ok(lines.includes(`- Intent amendment AMD-002 reopened this step: it added ${WORK}:REQ-002; revised ${WORK}:REQ-001; removed ${WORK}:AC-003. `
    + 'Cover each added and revised clause by its full ID; remove every citation and `@clause`/`@ac` tag that names a removed one; renumber nothing.'), lines.join('\n'));
  // An older record names only the changed clauses; a revalidated step is told nothing.
  workflow.phases.build.intentAmendmentRevalidation = { id: 'AMD-001', changedClauses: [`${WORK}:REQ-001`], revalidatedAt: null };
  assert.ok(phasePromptExecutionContract({}, workflow, workflow.phases.build).lines.some((line) => line.startsWith(`- Intent amendment AMD-001 reopened this step: it changed ${WORK}:REQ-001.`)));
  workflow.phases.build.intentAmendmentRevalidation.revalidatedAt = '2026-11-13T00:00:00.000Z';
  assert.ok(!phasePromptExecutionContract({}, workflow, workflow.phases.build).lines.some((line) => line.includes('reopened this step')));
});

test('plain chat: the approved requirements change only through an amendment, and a paused step\'s files stay as they were', async (t) => {
  const plainEdit = (root, file) => plainChatChangeGuard({ sessionId: 'plain', cwd: root, toolName: 'edit', toolArgs: { path: file } }, { policyFor: async () => 'record' });
  const f = await fixture(t, story());
  const scope = `singularity/work-items/${WORK}/artifacts/intake/requirements.md`;
  const refused = await plainEdit(f.root, scope);
  assert.match(refused.permissionDecisionReason, new RegExp(`^PLAIN_CHAT_APPROVED_SCOPE: ${scope} holds IAC-1's approved requirements, which change only through an intent amendment`, 'u'));
  assert.match(refused.permissionDecisionReason, /story intent-amendment draft --work-id IAC-1 --clause <CLAUSE-ID>, write only the changed clauses[^\n]*--authored governed-agent --channel copilot-host, then tell the person to decide it on the decisions card: \/sf-decide IAC-1\. build pauses until it is decided/u);
  assert.equal(await plainEdit(f.root, 'src/App.jsx'), null, 'an ordinary edit keeps its policy');

  const paused = await fixture(t, story({ amendment: true }));
  const denied = await plainEdit(paused.root, 'src/App.jsx');
  assert.match(denied.permissionDecisionReason, /^PLAIN_CHAT_STEP_PAUSED: AMD-001 waits for the requirements approvers, and build pauses until it is decided, so this edit to src\/App\.jsx did not run\. Tell the person to decide it on the decisions card: \/sf-decide IAC-1/u);
  // Git's own files (the amendment draft lives there) and reads are not the step's.
  assert.equal(await plainEdit(paused.root, '.git/singularity-flow/intent-amendment-drafts/IAC-1.md'), null);
  assert.equal(await plainChatChangeGuard({ sessionId: 'plain', cwd: paused.root, toolName: 'view', toolArgs: { path: 'src/App.jsx' } }), null);
});

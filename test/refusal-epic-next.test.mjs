/**
 * An Epic refused for where it stands names its own next action [owner, 2026-11-16].
 *
 * The Story half is test/refusal-story-next.test.mjs (the owner's Story of 2026-11-16). An Epic's phase refusals (prepare, publish,
 * approve, reject, compose or plan a phase that is not current, not in progress or not awaiting approval) carried no
 * route, so every one fell back to `singularity-flow help initiative`. Each now leads with the action
 * initiative-next.mjs already resolves for the Epic (initiativeNextDetails), then `initiative next <ID> --json`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { initiativeNextDetails } from '../src/initiative-next.mjs';
import { approveInitiative, publishInitiativePhase } from '../src/initiative-evidence.mjs';
import { rejectInitiative } from '../src/initiative-graph.mjs';
import { composeInitiativeContext } from '../src/initiative-context.mjs';
import { createPlanningContext } from '../src/planning.mjs';
import { addEpicStory, completeEpicPublication } from '../src/epic-lifecycle.mjs';
import {
  createInitiative, loadInitiative, prepareInitiativePhase, saveInitiative, selectInitiativePhaseOutputs
} from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

const ID = 'INIT-NEXT';
const OWNER = { name: 'Epic Next Owner', email: 'epic-next@example.invalid' };

async function repository(t, { profile = 'initiative-lite', id = ID, chain = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-next-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', OWNER.name], { cwd: root });
  run('git', ['config', 'user.email', OWNER.email], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Epic next\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [OWNER];
  portfolio.git.publish = 'off';
  // A one-step review chain on the business case, so a second approval meets a complete chain.
  if (chain) portfolio.initiativePhases.define.outputs.find((output) => output.id === 'business-case').approval = {
    mode: 'individual', allowSelfApproval: true, chain: [{ authority: 'product-approvers', label: 'Product Governance' }] };
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Initialize portfolio'], { cwd: root });
  run('git', ['switch', '-q', '-c', id], { cwd: root });
  await createInitiative(root, { id, title: 'Route every refusal', profile, agent: 'product-owner' });
  return root;
}

async function refusalOf(operation) {
  try { await operation(); } catch (error) { return error; }
  assert.fail('the operation was not refused');
}

/** The refusal leads with the Epic's own next action, as initiative-next.mjs resolves it now, and never with help. */
async function routed(root, error, argv, code, { id = ID } = {}) {
  assert.equal(error.code, code, error.message);
  const { initiative } = await loadInitiative(root, id);
  const expected = initiativeNextDetails(initiative).nextAction;
  assert.ok(expected?.command, `${code}: the Epic has a next action`);
  const envelope = refusalEnvelope(error, argv);
  const act = agentAct(envelope);
  const plan = envelope.remediationPlan;
  assert.equal(act.state, 'refused', code);
  assert.equal(act.do.shell, expected.command, `${code}: ${JSON.stringify(act.do)}`);
  assert.match(act.do.reason, /^Next for this Epic: /u, code);
  assert.deepEqual(plan.steps.map((entry) => entry.command), [expected.command, `singularity-flow initiative next ${id} --json`], code);
  assert.doesNotMatch(JSON.stringify(plan), /singularity-flow (?:help|doctor)\b|\/sf-help/u, code);
  assert.match(plan.retry.label, /^Nothing was changed\. Take the Epic's next step first/u, code);
  return expected;
}

/** Move the Epic's phases by hand, as other Epic tests do, to the state a refusal is about. */
async function setPhases(root, change) {
  const loaded = await loadInitiative(root, ID);
  change(loaded.initiative);
  await saveInitiative(root, loaded.portfolio, loaded.initiative);
}

test('an Epic phase that is not current routes to the current phase\'s action, from prepare, publish, approve, reject, compose and planning', async (t) => {
  const root = await repository(t);
  await prepareInitiativePhase(root, ID, 'define', { agent: 'product-owner' });
  const later = (await loadInitiative(root, ID)).initiative.phaseOrder[1];
  for (const [operation, argv] of [
    [() => prepareInitiativePhase(root, ID, later), ['initiative', 'phase', later]],
    [() => publishInitiativePhase(root, ID, later), ['initiative', 'phase', 'publish', later]],
    [() => approveInitiative(root, { initiativeId: ID, phaseId: later, subject: 'phase' }), ['initiative', 'approve', 'phase', '--phase', later]],
    [() => rejectInitiative(root, { initiativeId: ID, phaseId: later, subject: 'phase', reason: 'Not yet.' }), ['initiative', 'reject', 'phase', '--phase', later]],
    [() => composeInitiativeContext(root, ID, later), ['initiative', 'compose', later]],
    [() => createPlanningContext(root, { scope: 'initiative', id: ID, phase: later, agent: 'product-owner' }), ['editor', 'planning-context', '--scope', 'initiative']]
  ]) {
    const expected = await routed(root, await refusalOf(operation), argv, 'INITIATIVE_PHASE_NOT_CURRENT');
    assert.match(expected.command, /^singularity-flow initiative phase /u, 'the current phase is authored or published next');
  }
});

test('approving or rejecting an Epic phase not awaiting approval, and preparing or publishing one that is, route to its next action', async (t) => {
  const root = await repository(t);
  await prepareInitiativePhase(root, ID, 'define', { agent: 'product-owner' });
  await routed(root, await refusalOf(() => approveInitiative(root, { initiativeId: ID, phaseId: 'define', subject: 'phase' })),
    ['initiative', 'approve', 'phase'], 'INITIATIVE_PHASE_NOT_AWAITING_APPROVAL');
  await routed(root, await refusalOf(() => rejectInitiative(root, { initiativeId: ID, phaseId: 'define', subject: 'phase', reason: 'Not yet.' })),
    ['initiative', 'reject', 'phase'], 'INITIATIVE_PHASE_NOT_AWAITING_APPROVAL');
  await setPhases(root, (initiative) => { initiative.phases.define.status = 'awaiting_approval'; });
  for (const [operation, argv] of [
    [() => prepareInitiativePhase(root, ID, 'define'), ['initiative', 'phase', 'define']],
    [() => publishInitiativePhase(root, ID, 'define'), ['initiative', 'phase', 'publish', 'define']],
    [() => createPlanningContext(root, { scope: 'initiative', id: ID, phase: 'define', agent: 'product-owner' }), ['editor', 'planning-context', '--scope', 'initiative']]
  ]) {
    const expected = await routed(root, await refusalOf(operation), argv, 'INITIATIVE_PHASE_NOT_IN_PROGRESS');
    assert.equal(expected.command, 'singularity-flow initiative approve phase', 'a submitted phase is approved next');
  }
});

test('changing the outputs of an approved Epic phase routes to the next phase\'s action', async (t) => {
  const root = await repository(t);
  await prepareInitiativePhase(root, ID, 'define', { agent: 'product-owner' });
  let next = null;
  await setPhases(root, (initiative) => {
    [, next] = initiative.phaseOrder;
    initiative.phases.define.status = 'approved';
    initiative.phases.define.approvedAt = new Date().toISOString();
    initiative.phases[next].status = 'in_progress';
    initiative.currentPhase = next;
  });
  const expected = await routed(root, await refusalOf(() => selectInitiativePhaseOutputs(root, ID, 'define', [])),
    ['initiative', 'outputs', 'define'], 'INITIATIVE_PHASE_APPROVED');
  assert.equal(expected.command, `singularity-flow initiative phase ${next}`);
});

test('approving an Epic output whose review chain is complete routes to the Epic\'s next action', async (t) => {
  const root = await repository(t, { chain: true });
  await prepareInitiativePhase(root, ID, 'define', { agent: 'product-owner' });
  await publishInitiativePhase(root, ID, 'define', { agent: 'product-owner' });
  const approve = () => approveInitiative(root, { initiativeId: ID, phaseId: 'define', subject: 'business-case', agent: 'product-owner' });
  assert.equal((await approve()).reached, true);
  const expected = await routed(root, await refusalOf(approve), ['initiative', 'approve', 'business-case'], 'INITIATIVE_REVIEW_CHAIN_COMPLETE');
  assert.equal(expected.command, 'singularity-flow initiative approve phase');
});

test('editing an Epic\'s Stories before Planning, or publishing them before it is approved, routes to the Epic\'s next action', async (t) => {
  const root = await repository(t, { profile: 'epic-planning', id: 'EPIC-NEXT' });
  await routed(root, await refusalOf(() => addEpicStory(root, 'EPIC-NEXT', { title: 'A Story', repository: 'app' })),
    ['initiative', 'story', 'add', 'EPIC-NEXT'], 'EPIC_PLANNING_NOT_EDITABLE', { id: 'EPIC-NEXT' });
  await routed(root, await refusalOf(() => completeEpicPublication(root, 'EPIC-NEXT')),
    ['initiative', 'publish', 'EPIC-NEXT'], 'EPIC_PLANNING_NOT_APPROVED', { id: 'EPIC-NEXT' });
});

test('an Epic with no command to name (every phase approved) keeps the ordinary plan', () => {
  const details = initiativeNextDetails({ initiative: { id: ID }, currentPhase: null, phaseOrder: [], phases: {}, resolution: { phases: [] } });
  assert.deepEqual(details, { subjectKind: 'initiative', workId: ID });
});

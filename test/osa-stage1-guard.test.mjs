/**
 * SPEC-OSA v1.1 Stage 1 through the real pre-tool guard: for one basis, the kernel's decision, the entry's edit
 * permission and the guard's actual allow or deny agree for every write category, and the guard's refusal leads with
 * the decision's legal next action [OSA:AC-001, AC-002, AC-003, AC-006, REQ-010, REQ-013].
 *
 * The categories: the step's own artifact, application source, another step's artifact, governed state, another
 * repository, an excluded capability, the exact review staging file and the declared execution outputs. Expected
 * results come from section 6, not from the code: the test asks the real guard (mutationToolGuard) about each write.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { decisionRoutes, deriveMutationContract, mutationContractPresentation, mutationToolProtocol, stepSnapshotOf } from '../src/phase-mutation-contract.mjs';
import { stepState } from '../src/kernel/step-state.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { sourceReviewStagingPath } from '../src/phase-staging-paths.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

const RECORD = { path: 'singularity/work-items/OSA-G/publications/implement-1.json', sha256: `sha256:${'c'.repeat(64)}` };

/** A Story at `implement` (code) after an approved `design`, then `verify`, in a real Git checkout. */
async function fixture(t, changes = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-osa-guard-')));
  const root = path.join(directory, 'repository');
  const foreign = path.join(directory, 'other-repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(foreign, { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'OSA Guard']); git(['config', 'user.email', 'osa-guard@example.test']);
  await writeFile(path.join(root, 'src', 'App.java'), 'final class App {}\n');
  const implement = { id: 'implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
    generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/implement/summary.md', kind: 'implementation-summary' },
    generationIntent: { status: 'open', generation: 2 }, generationPublications: [{ generation: 1, record: RECORD }], ...changes };
  const workflow = { schemaVersion: 13, workItem: { id: 'OSA-G' }, status: 'in_progress', currentPhase: 'implement',
    phaseOrder: ['design', 'implement', 'verify'], history: [],
    phases: { design: { id: 'design', status: 'approved', generation: 1, writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' } },
      implement, verify: { id: 'verify', status: 'pending', generation: 0, writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' } } },
    resolution: { sourceReview: { mode: 'enforce', phases: ['implement'], kinds: { implement: 'code' }, reviewerAgent: 'sflow-source-reviewer' } } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  const workflowFile = path.join(root, 'singularity', 'work-items', 'OSA-G', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  let sessions = 0;
  const enter = async (skill) => {
    const payload = { cwd: root, sessionId: `osa-guard-${sessions += 1}`, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  const save = async () => writeFile(workflowFile, JSON.stringify(workflow));
  return { root, foreign, workflow, definition, implement, enter, save, workflowFile };
}

/** The writes section 6 names, by category, for the `implement` step. */
const WRITES = (f) => ({
  'step-artifact': 'singularity/work-items/OSA-G/artifacts/implement/summary.md',
  application: 'src/App.java',
  'other-step-artifact': 'singularity/work-items/OSA-G/artifacts/verify/report.md',
  'governed-state': 'singularity/work-items/OSA-G/workflow.json',
  'other-repository': path.join(f.foreign, 'App.java'),
  'protected-path': 'policy/rules.yml'
});

/** What section 6 allows: exactly the categories the decision grants, and nothing outside the step or the checkout. */
function expectedAllowed(decision, category) {
  if (category === 'step-artifact') return decision.edit.permittedCategories.includes('step-artifacts');
  if (category === 'application') return decision.edit.permittedCategories.includes('application');
  return false;
}

async function guardSays(payload, target) {
  return mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: target } });
}

const STATES = {
  'version 2 open (writing)': {},
  'version 1 not yet opened (not-started)': { generation: 0, generationIntent: undefined, generationPublications: [] },
  'returned for rework (reopened)': { generationIntent: { status: 'consumed', generation: 1 }, reworkRevalidation: { generation: 1 } },
  'published, awaiting its review': { generationIntent: { status: 'consumed', generation: 1 } },
  'submitted': { status: 'awaiting_approval', generationIntent: { status: 'consumed', generation: 1 } },
  'damaged': { generation: 2, generationIntent: { status: 'consumed', generation: 1 }, reworkRevalidation: { generation: 2 },
    generationPublications: [{ generation: 2, record: RECORD }] }
};

test('for one basis the decision, the entry\'s permission and the real guard agree on every write [OSA:AC-001, REQ-010]', async (t) => {
  for (const [name, changes] of Object.entries(STATES)) {
    const f = await fixture(t, changes);
    const decision = stepState(stepSnapshotOf({ workflow: f.workflow, turnMode: 'authoring' }));
    // The entry's edit permission, as phase entry presents it (phase-entry-context.mjs) for the same Story record.
    const entry = mutationContractPresentation(deriveMutationContract({ root: f.root, definition: f.definition, workflow: f.workflow,
      phase: f.implement, turnMode: 'authoring' }));
    assert.equal(entry.applicationEdits, decision.edit.permittedCategories.includes('application'), `${name}: entry application`);
    assert.equal(entry.artifacts.length > 0, decision.edit.permittedCategories.includes('step-artifacts'), `${name}: entry artifacts`);
    const turn = await f.enter('/sf-code');
    for (const [category, target] of Object.entries(WRITES(f))) {
      const said = await guardSays(turn, target);
      const allowed = said.permissionDecision !== 'deny';
      assert.equal(allowed, expectedAllowed(decision, category), `${name}: ${category} (${target}): ${String(said.permissionDecisionReason ?? 'allowed').slice(0, 300)}`);
      if (!allowed) {
        // A refusal keeps its code and leads with the decision's legal action, the entry's own next [OSA:AC-006, REQ-022].
        assert.match(said.permissionDecisionReason, /^[A-Z][A-Z_]+[: ]/u, `${name}: ${category} keeps its code`);
        if (/^PHASE_MUTATION_PATH_DENIED/u.test(said.permissionDecisionReason)) {
          assert.deepEqual(said.next.map((route) => route.command), entry.next.map((route) => route.command), `${name}: ${category} next`);
        }
      }
    }
  }
});

test('the guard, the entry and the authoring task give one next action for one basis [OSA:AC-002, AC-003, Stage 0 finding 1]', async () => {
  const { phaseAuthoringProgress } = await import('../src/phase-authoring-progress.mjs');
  for (const [name, changes] of Object.entries(STATES)) {
    const workflow = { workItem: { id: 'OSA-G' }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['implement'], history: [],
      phases: { implement: { id: 'implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
        generationPolicy: { requirement: 'required', task: 'code', allowedProducers: ['governed-agent'] },
        generationIntent: { status: 'open', generation: 2 }, generationPublications: [{ generation: 1, record: RECORD }], ...changes } }, resolution: {} };
    const decision = stepState(stepSnapshotOf({ workflow }));
    const guard = deriveMutationContract({ definition: {}, workflow });
    const entry = deriveMutationContract({ definition: {}, workflow, phase: workflow.phases.implement });
    assert.deepEqual(entry.next, guard.next, name);
    assert.deepEqual(guard.next, decisionRoutes(decision, workflow, workflow.phases.implement), name);
    assert.equal(guard.policy.step.next, decision.next.actionId, name);
    // The authoring task, where the step is being written, names the same first command.
    const task = phaseAuthoringProgress(workflow, workflow.phases.implement);
    if (task) assert.equal(task.next.command, guard.next[0].command, `${name}: task`);
    // Every rendered route has a supported mapping: the command validates and names the Story's own step [AC-003].
    for (const route of guard.next) {
      assert.ok(safeCommandGuidance({ command: route.command }), `${name}: ${route.command}`);
      assert.match(route.command, /\b(?:implement|OSA-G)\b/u, `${name}: names its target`);
    }
    // A person's action is rendered as the person's command, never as an agent's write [section 4.2 principals].
    if (decision.next.principalKind === 'human' && decision.next.operation === 'approve-step') assert.match(guard.next[0].copilotCommand, /^\/sf-approve\b/u, name);
  }
});

test('review staging and execution outputs are their own capabilities and grant no authoring [OSA:AC-001, REQ-013]', async (t) => {
  // A published code version under review: the reviewer's turn writes only its exact staging file.
  const f = await fixture(t, { generationIntent: { status: 'consumed', generation: 1 } });
  const review = await f.enter('/sf-review-source');
  const staging = sourceReviewStagingPath(gitDir(f.root), f.workflow, f.implement);
  assert.deepEqual(await guardSays(review, staging), {}, 'the exact staging file is writable');
  assert.equal((await guardSays(review, `${staging}.other`)).permissionDecision, 'deny', 'no other staging path');
  for (const [category, target] of Object.entries(WRITES(f))) {
    assert.equal((await guardSays(review, target)).permissionDecision, 'deny', `review turn: ${category}`);
  }
  // A run-and-test turn runs the declared tests and app through SFlow; it edits nothing, and its outputs are not authoring.
  const tests = await f.enter('/sf-test');
  for (const [category, target] of Object.entries(WRITES(f))) {
    assert.equal((await guardSays(tests, target)).permissionDecision, 'deny', `test turn: ${category}`);
  }
  const testContract = deriveMutationContract({ root: f.root, definition: f.definition, workflow: f.workflow, turnMode: 'run-and-test' });
  assert.equal(mutationToolProtocol(testContract).localVerification.allowed, false, 'execution outputs never widen to edits');
  // In an authoring turn with an open version, local test runs and their outputs are allowed, and still no other step's files.
  f.implement.generationIntent = { status: 'open', generation: 2 };
  const authoring = deriveMutationContract({ root: f.root, definition: f.definition, workflow: f.workflow, turnMode: 'authoring' });
  assert.equal(mutationToolProtocol(authoring).localVerification.allowed, true);
  assert.deepEqual(authoring.allow.staging, []);
});

test('a moved basis or an expired turn revokes an earlier grant: nothing carries over [OSA:AC-001, section 6]', async (t) => {
  const f = await fixture(t);
  const turn = await f.enter('/sf-code');
  assert.deepEqual(await guardSays(turn, 'src/App.java'), {}, 'version 2 open: application edits');
  // The lifecycle moves (version 2 published): the guard re-derives from the new record before the next write.
  Object.assign(f.implement, { generation: 2, generationIntent: { status: 'consumed', generation: 2 },
    generationPublications: [{ generation: 2, record: { ...RECORD, path: RECORD.path.replace('-1', '-2') } }] });
  await f.save();
  const moved = await guardSays(turn, 'src/App.java');
  assert.equal(moved.permissionDecision, 'deny', 'a published version takes no more source edits');
  // The turn's window ends: the grant ends with it, whatever a screen still shows.
  const fresh = await fixture(t);
  const later = await fresh.enter('/sf-code');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 60_000 });
  const expired = await guardSays(later, 'src/App.java');
  t.mock.timers.reset();
  assert.match(String(expired.permissionDecisionReason ?? ''), /^PHASE_MUTATION_TURN_EXPIRED/u);
  assert.match(await readFile(fresh.workflowFile, 'utf8'), /"generation":2/u, 'the record is unchanged by a refusal');
});

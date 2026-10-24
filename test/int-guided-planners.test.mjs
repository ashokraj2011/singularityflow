/**
 * The last declared planners: comparison, watches, the ceremony destination, the assisted fallback,
 * and the mutation planners that turn a resolution into a content-hashed plan. `[INT:CON-110]`
 *
 * Every assertion runs against real state — a Git repository, a directory of work records, a
 * machine-local store redirected per test — because a planner that reads the kernel's real state is
 * the whole requirement, and a stand-in for that state is the thing that hid "built but never
 * wired" in this product before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initializeDefinition } from '../src/config.mjs';
import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { comparePlanner } from '../src/gateway/planners/compare.mjs';
import { impactQuickAssisted } from '../src/gateway/planners/impact-quick.mjs';
import {
  evaluateWatch, watchCreateExecute, watchCreatePlan, watchList, watchRevokeExecute, watchRevokePlan
} from '../src/gateway/planners/watches.mjs';
import { workStartArguments } from '../src/gateway/planners/work-start.mjs';
import { previewDigest } from '../src/gateway/plan-descriptor.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { run } from '../src/util.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const OTHER = { login: 'dev-2', email: 'dev-2@example.com', name: 'Dev Two' };
const binding = {
  workspaceId: 'payments', repository: 'payments-api', branch: 'main', subjectKind: null, subjectId: null,
  sourceCommit: null, worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null,
  policyHash: 'sha256:policy', registryHash: 'sha256:registry', actorId: ACTOR.email, hostSessionId: 'sess-guided'
};

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  git(root, 'checkout', '-q', '-b', 'feature/address');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'address.mjs'), 'export const postal = true;\n');
  await writeFile(path.join(root, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'address');
  git(root, 'tag', 'v1.2.0');
  git(root, 'checkout', '-q', 'main');
  return root;
}

const story = (id, phase, { status = 'in_progress', generation = 1, at = '2026-10-01T10:00:00.000Z', approval = false } = {}) => ({
  workItem: { id, title: `Work ${id}`, workType: 'feature', branch: id },
  phaseOrder: ['design', 'implementation'],
  currentPhase: phase,
  phases: {
    [phase]: {
      status, generation,
      ...(approval ? { approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: false } } : {})
    }
  },
  history: [{ event: approval ? 'phase_submitted' : 'work_started', phase, actor: OTHER, at }],
  ...(approval ? { resolution: { approvalAuthorities: { developers: {
    label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
    members: [{ name: ACTOR.name, email: ACTOR.email, githubLogin: ACTOR.login }]
  } } } } : {})
});

async function writeStory(root, workflow) {
  const directory = path.join(root, 'singularity', 'work-items', workflow.workItem.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(workflow));
}

async function localStoreEnv(t) {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-store-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  return { ...process.env, SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json') };
}

// ---------------------------------------------------------------------------------------------------
// compare

test('a comparison resolves both sides exactly and reports binary paths without their bytes', async (t) => {
  const root = await repository(t);
  const result = validateSflowResult(await comparePlanner({
    arguments: { subjectKind: 'branch', left: 'main', right: 'feature/address' }, root, context: { repositoryId: 'payments-api' }
  }));
  assert.equal(result.kind, 'read');
  assert.match(result.data.left.commit, /^[0-9a-f]{40}$/);
  assert.match(result.data.right.commit, /^[0-9a-f]{40}$/);
  assert.equal(result.data.mergeBase, result.data.left.commit);
  assert.deepEqual(result.data.counts, { leftOnly: 0, rightOnly: 1 });
  assert.deepEqual(result.data.changed.entries.map((entry) => [entry.status, entry.path, entry.binary]),
    [['A', 'logo.bin', true], ['A', 'src/address.mjs', false]]);
  assert.equal(result.data.changed.entries.find((entry) => entry.binary).added, null);
  assert.equal(result.data.bounds.patchesIncluded, false);
  assert.ok(Object.values(result.effects).every((value) => value === false));

  // A release is a tag that names it exactly, with or without the `v`.
  const release = await comparePlanner({ arguments: { subjectKind: 'release', left: '1.2.0', right: 'v1.2.0' }, root });
  assert.equal(release.data.changed.total, 0);
});

test('a side that does not resolve is refused by name and nothing is guessed in its place', async (t) => {
  const root = await repository(t);
  const missing = await comparePlanner({ arguments: { subjectKind: 'branch', left: 'main', right: 'no-such-branch' }, root });
  assert.equal(missing.kind, 'refusal');
  assert.deepEqual([missing.why[0].code, missing.why[0].slots.side], ['compare.side-unresolved', 'right']);
  // A commit comparison takes object names only, so a branch name is not quietly accepted as one.
  const typed = await comparePlanner({ arguments: { subjectKind: 'commit', left: 'main', right: 'feature/address' }, root });
  assert.equal(typed.why[0].code, 'compare.side-unresolved');
  // An option-shaped value never reaches Git as an option.
  const option = await comparePlanner({ arguments: { subjectKind: 'branch', left: '--output=/tmp/x', right: 'main' }, root });
  assert.equal(option.why[0].code, 'compare.side-unresolved');
});

test('comparison kinds without an evidence source here are unavailable, not empty', async (t) => {
  const root = await repository(t);
  for (const subjectKind of ['build', 'artifact', 'generation', 'plan', 'provider-observation']) {
    const result = await comparePlanner({ arguments: { subjectKind, left: 'a', right: 'b' }, root });
    assert.equal(result.kind, 'refusal');
    assert.equal(result.restState, 'unavailable');
    assert.equal(result.why[0].code, 'compare.subject-unavailable');
  }
});

test('a working-tree comparison says it read tracked files only', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'README.md'), '# fixture, edited\n');
  const result = await comparePlanner({ arguments: { subjectKind: 'worktree', left: 'HEAD', right: 'worktree' }, root });
  assert.equal(result.data.sides.right, 'working-tree-tracked-files');
  assert.deepEqual(result.data.changed.entries.map((entry) => entry.path), ['README.md']);
  assert.ok(result.warnings.some((warning) => warning.code === 'compare.untracked-not-compared'));
});

test('the kernel seals the comparison follow-up into a signed impact handle', async (t) => {
  const root = await repository(t);
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root });
  const resolved = await kernel.resolve({
    utterance: 'compare these', arguments: { subjectKind: 'branch', left: 'main', right: 'feature/address' }
  });
  assert.equal(resolved.kind, 'read');
  const result = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(result.operation.id, 'compare');
  assert.match(result.next[0].handle, /^sel_/);
  assert.equal(JSON.stringify(result).includes('impact.quick'), false, 'the target operation is not reconstructable');
});

// ---------------------------------------------------------------------------------------------------
// watches

test('a watch is planned from records, written only by its executor, and evaluated against now', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await localStoreEnv(t);
  await writeStory(root, story('WRK-1', 'design'));
  const context = { actor: ACTOR };

  const plan = await watchCreatePlan({ arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' }, root, context, env });
  assert.deepEqual(plan.effects, {
    contextChanged: true, stateChanged: false, filesChanged: false,
    gitRefsChanged: false, publicationCreated: false, externalSystemsChanged: false
  });
  assert.equal(plan.review.digest, previewDigest(plan.review.preview));
  assert.equal((await watchList({ root, context, env })).data.watches.length, 0, 'planning wrote nothing');

  await watchCreateExecute({ plan, context, env });
  const quiet = await watchList({ root, context, env });
  assert.deepEqual(quiet.data.watches.map((watch) => [watch.subject.id, watch.state]), [['WRK-1', 'quiet']]);

  await writeStory(root, story('WRK-1', 'implementation', { at: '2026-10-02T10:00:00.000Z' }));
  const fired = validateSflowResult(await watchList({ root, context, env }));
  assert.equal(fired.data.watches[0].state, 'fired');
  assert.equal(fired.next[0].reasonCode, 'watch.fired');

  // Identity-scoped: another person on the same machine sees none of it.
  assert.equal((await watchList({ root, context: { actor: OTHER }, env })).data.watches.length, 0);

  const revoke = await watchRevokePlan({ arguments: { watchId: fired.data.watches[0].id }, context, env });
  await watchRevokeExecute({ plan: revoke, context, env });
  assert.equal((await watchList({ root, context, env })).data.watches.length, 0);
});

test('an unknown predicate, subject or duplicate watch is refused before any plan exists', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await localStoreEnv(t);
  await writeStory(root, story('WRK-1', 'design'));
  const context = { actor: ACTOR };
  await assert.rejects(watchCreatePlan({ arguments: { subjectId: 'WRK-1', predicate: 'anything' }, root, context, env }),
    { code: 'WATCH_PREDICATE_UNKNOWN' });
  await assert.rejects(watchCreatePlan({ arguments: { subjectId: 'WRK-9', predicate: 'phase-changed' }, root, context, env }),
    { code: 'WATCH_SUBJECT_UNKNOWN' });
  await watchCreateExecute({ plan: await watchCreatePlan({ arguments: { subjectId: 'WRK-1', predicate: 'material-event' }, root, context, env }), context, env });
  await assert.rejects(watchCreatePlan({ arguments: { subjectId: 'WRK-1', predicate: 'material-event' }, root, context, env }),
    { code: 'WATCH_EXISTS' });
  // A subject that is not visible is unknown, which is a different fact from quiet.
  assert.equal(evaluateWatch({ predicate: 'material-event', baseline: {} }, null).state, 'unknown');
});

// ---------------------------------------------------------------------------------------------------
// plans: every non-read resolution is a content-hashed plan, even in a read-only kernel

test('a mutation resolution is a signed plan a read-only kernel can show and cannot run', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeStory(root, story('WRK-1', 'design'));
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR } });
  const planned = await kernel.resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' } });
  assert.equal(planned.kind, 'plan');
  assert.match(planned.data.plan.handle, /^pla_/);
  assert.match(planned.data.plan.planHash, /^[0-9a-f]{64}$/);
  assert.equal(planned.data.plan.confirmation, 'host-confirm');
  assert.equal(planned.data.plan.review.digest, previewDigest(planned.data.plan.review.preview));
  assert.equal(planned.next[0].executable, false);
  const ran = await kernel.run({ planId: planned.data.plan.handle });
  assert.deepEqual([ran.kind, ran.why[0].code], ['refusal', 'gateway.read-only']);

  // A host without the planner gets a named absence, not a plan-shaped result with nothing in it.
  const small = gatewayPlanners();
  small.delete('watch-create');
  const absent = await createGatewayKernel({ binding, planners: small, root, plannerContext: { actor: ACTOR } })
    .resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'phase-changed' } });
  assert.deepEqual([absent.kind, absent.why[0].code, absent.restState], ['refusal', 'gateway.planner-unavailable', 'unavailable']);

  // A planner refusal is a refusal that names its reason, and plans nothing.
  const refused = await kernel.resolve({ utterance: 'watch this', arguments: { subjectId: 'WRK-1', predicate: 'whenever' } });
  assert.deepEqual([refused.kind, refused.why[0].code, refused.why[0].slots.code], ['refusal', 'gateway.plan-invalid', 'WATCH_PREDICATE_UNKNOWN']);
});

test('work start plans the exact normalized record from a session intake and derives its argv from it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  await initializeDefinition(root);
  await writeStory(root, story('WRK-1', 'design'));
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR, repositoryId: 'payments-api' } });

  const { intakeId } = kernel.recordIntake({
    workId: 'WRK-7', workType: 'feature', title: 'Stop duplicate checkout submissions',
    description: 'Submitting twice creates two orders.', baseBranch: 'main'
  });
  assert.throws(() => kernel.recordIntake({ workId: '../escape', workType: 'feature' }), { code: 'INVALID_OPERATION_ARGUMENT' });

  const planned = await kernel.resolve({ utterance: 'create the work item', arguments: { intakeId } });
  assert.equal(planned.kind, 'plan');
  const { preview } = planned.data.plan.review;
  assert.deepEqual(preview.subject, { kind: 'story', id: 'WRK-7', title: 'Stop duplicate checkout submissions' });
  assert.equal(preview.workProfile.workType, 'feature');
  assert.ok(preview.workProfile.phases.length > 1);
  assert.deepEqual(preview.branch, { name: 'WRK-7', base: 'main', isolatedWorktree: true });
  assert.equal(planned.data.plan.confirmation, 'exact-confirm');
  assert.equal(planned.data.plan.effects.publicationCreated, true);
  assert.deepEqual(workStartArguments(preview), [
    'start', 'WRK-7', '--json', '--fetch', '--title', 'Stop duplicate checkout submissions',
    '--description', 'Submitting twice creates two orders.', '--work-type', 'feature', '--isolated-worktree',
    '--ref', 'WRK-7', '--from-branch', 'main'
  ]);

  for (const [fields, code] of [
    [{ workId: 'WRK-8', workType: 'not-declared', title: 'T', description: 'D' }, 'WORK_TYPE_UNKNOWN'],
    [{ workId: 'WRK-1', workType: 'feature', title: 'T', description: 'D' }, 'WORK_ALREADY_STARTED'],
    [{ workId: 'WRK-9', workType: 'feature' }, 'WORK_INTAKE_INCOMPLETE'],
    [{ workId: 'WRK-9', workType: 'feature', shape: 'initiative' }, 'WORK_START_SHAPE_EXPLICIT_ONLY']
  ]) {
    const refused = await kernel.resolve({ utterance: 'create the work item', arguments: { intakeId: kernel.recordIntake(fields).intakeId } });
    assert.deepEqual([refused.kind, refused.why[0].slots.code], ['refusal', code]);
  }
  // An intake from another session — or none at all — is not a thing this session can start.
  const unknown = await kernel.resolve({ utterance: 'create the work item', arguments: { intakeId: 'int_never_recorded' } });
  assert.equal(unknown.why[0].slots.code, 'WORK_INTAKE_UNKNOWN');
});

// ---------------------------------------------------------------------------------------------------
// the ceremony destination

test('opening a review resolves to its destination and never to an executable verdict', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeStory(root, story('WRK-2', 'design', { status: 'awaiting_approval', approval: true }));
  await writeStory(root, story('WRK-3', 'design'));
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root, plannerContext: { actor: ACTOR } });

  const destination = await kernel.resolve({ utterance: 'open the approval ceremony', arguments: { workId: 'WRK-2' } });
  assert.equal(destination.kind, 'ceremony');
  assert.equal(destination.operation.classification, 'authorization');
  assert.equal(destination.restState, 'awaiting-decision');
  assert.equal(destination.next.length, 1);
  assert.equal(destination.next[0].executable, false);
  assert.equal(destination.next[0].confirmation, 'ceremony');
  assert.equal(destination.next[0].fallback.command, 'sflow approve design --work-id WRK-2 --fetch');
  assert.equal(destination.data.ceremony.hostAction, 'vscode.openReviewCeremony');
  assert.ok(Object.values(destination.effects).every((value) => value === false));
  assert.equal(destination.data.plan, undefined, 'an authorization has no plan');

  const nothing = await kernel.resolve({ utterance: 'open the approval ceremony', arguments: { workId: 'WRK-3' } });
  assert.deepEqual([nothing.kind, nothing.why[0].code], ['refusal', 'review.nothing-awaiting-decision']);
});

// ---------------------------------------------------------------------------------------------------
// the assisted fallback

test('assisted quick impact returns the deterministic facts and says nothing interpreted them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guided-assisted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await impactQuickAssisted({ root, context: { changedPaths: ['src/a.mjs'] } });
  assert.equal(result.operation.id, 'impact.quick.assisted');
  assert.deepEqual([result.data.assisted.requested, result.data.assisted.invoked], [true, false]);
  // Since P3 the assisted half carries the relay request a host model would answer [INT:CON-069].
  assert.equal(result.data.assisted.relay.contract, 'sflow-assisted-relay-v1');
  assert.ok(result.warnings.some((warning) => warning.code === 'impact.assistance-not-invoked'));
  assert.deepEqual(result.data.affected.paths, ['src/a.mjs']);
});

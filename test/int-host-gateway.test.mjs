/**
 * The gateway's first production wiring.
 *
 * Everything under `src/gateway/` was built, tested and reachable from nothing: `grep gateway/ src/`
 * returned no hits outside the directory itself. These tests cover the seam that ends that — the
 * binding read from a real repository, and the resolve → handle → read round trip a surface makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_GATEWAY_POLICY, resolveGatewayPolicy } from '../src/gateway/policy.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { createHostGateway, hostBinding } from '../src/gateway/host.mjs';
import { createActionExecutor } from '../src/gateway/executor.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-host-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.email', 'dev@example.test'], { cwd: root });
  run('git', ['config', 'user.name', 'Dev'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'first'], { cwd: root });
  return root;
}

test('the resolved policy is content-addressed so a handle can bind to it', () => {
  /**
   * The gap the first wiring hit. `frozenBinding` rejects a falsy `policyHash` — "a handle without
   * them binds nothing" — and nothing produced one, so no real caller could build a legal binding.
   */
  const policy = resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY]);
  assert.match(policy.contentHash, /^sha256:[0-9a-f]{64}$/);

  // Same decisions, same address — a resolve that changed nothing must not expire outstanding work.
  assert.equal(resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY]).contentHash, policy.contentHash);

  // Different decisions, different address.
  const denied = resolveGatewayPolicy([{ ...DEFAULT_GATEWAY_POLICY, denied: ['work.list'] }]);
  assert.notEqual(denied.contentHash, policy.contentHash);
});

test('a degraded policy hashes differently from a working one', () => {
  // A handle issued while policy was unreadable must not verify once policy loads: it was computed
  // against a fallback nobody chose.
  const degraded = resolveGatewayPolicy([]);
  assert.equal(degraded.degraded, true);
  assert.match(degraded.contentHash, /^sha256:/);
  assert.notEqual(degraded.contentHash, resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY]).contentHash);
});

test('the binding names the repository and branch it was computed in', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const registry = gatewayRegistry();
  const policy = resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY], { registry });
  const binding = hostBinding(root, { hostSessionId: 'sess-1', registry, policy, workspaceId: 'w1' });

  assert.equal(binding.repository, root);
  assert.equal(binding.branch, 'main');
  assert.match(binding.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(binding.actorId, 'dev@example.test');
  assert.equal(binding.policyHash, policy.contentHash);
  assert.equal(binding.registryHash, registry.contentHash);
  // Declared, never absent: a missing field cannot be told from one that did not apply.
  for (const field of ['subjectKind', 'subjectId', 'lifecycleRevision']) {
    assert.ok(field in binding, `${field} is not declared`);
    assert.equal(binding[field], null);
  }
  assert.match(binding.worktreeHash, /^[0-9a-f]{64}$/);
  assert.equal(binding.worktreeAlgorithm, 'sflow-worktree-v2');
});

test('a host session requires the session it is issuing handles for', () => {
  // A default would be a shared session ID, under which a handle issued in one window verifies in
  // another — the confusion binding exists to prevent.
  assert.throws(() => createHostGateway({ root: '/tmp', hostSessionId: null, planners: gatewayPlanners() }), /requires the host session/);
});

test('resolve issues a handle and read revalidates it against the world', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { kernel } = createHostGateway({ root, hostSessionId: 'sess-1', workspaceId: 'w1', planners: gatewayPlanners() });
  const resolution = await kernel.resolve({ utterance: 'home' });

  assert.equal(resolution.kind, 'read');
  assert.equal(resolution.operation.id, 'home.overview');
  assert.equal(resolution.next.length, 1);
  // Exactly one legal next action means exactly one filled button `[UXH:REQ-023]`.
  assert.equal(resolution.next[0].emphasis, 'primary');
  // The model is handed an ID, never the operation name.
  assert.match(resolution.next[0].handle, /^rea_[0-9a-f]{32}$/);

  const envelope = await kernel.read({ resolutionId: resolution.next[0].handle });
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.operation.id, 'home.overview');
  assert.equal(envelope.outcome.status, 'succeeded');
  assert.equal(envelope.data.personalization.source, 'git-identity');
  assert.equal(envelope.data.personalization.displayName, 'Dev');
  assert.equal(envelope.data.personalization.replyName, 'Dev');
  assert.equal(hostBinding(root, {
    hostSessionId: 'sess-1', registry: gatewayRegistry(),
    policy: resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY], { registry: gatewayRegistry() }), workspaceId: 'w1'
  }).actorId, 'dev@example.test', 'the signed binding still uses the stable email, never the greeting name');
  assert.ok(envelope.next.length, 'the home offers choices');
  assert.equal(envelope.next.filter((action) => action.emphasis === 'primary').length, 1);
});

test('a handle is single-session: the same words in another session do not redeem it', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = createHostGateway({ root, hostSessionId: 'sess-1', planners: gatewayPlanners() });
  const resolution = await first.kernel.resolve({ utterance: 'home' });
  const handle = resolution.next[0].handle;

  const second = createHostGateway({ root, hostSessionId: 'sess-2', planners: gatewayPlanners() });
  const refused = await second.kernel.read({ resolutionId: handle });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.handle-unknown');
  // And it says what survived, rather than only that it was blocked `[DHR:REQ-061]`.
  assert.ok(refused.preserved.length);
});

test('the same repository on a different branch is a different binding', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const registry = gatewayRegistry();
  const policy = resolveGatewayPolicy([DEFAULT_GATEWAY_POLICY], { registry });
  const before = hostBinding(root, { hostSessionId: 's', registry, policy });

  run('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: root });
  const after = hostBinding(root, { hostSessionId: 's', registry, policy });

  /**
   * `branch` is one of the two fields this work added to `BINDING_FIELDS`, and this is why. Nothing
   * else moves when someone switches branches in the same clone at the same commit — not the head,
   * not the policy, not the registry — so without it a plan resolved on `main` stays valid on a
   * feature branch, which is exactly where it must not be.
   */
  assert.equal(before.sourceCommit, after.sourceCommit, 'the commit is unchanged, as intended');
  assert.notEqual(before.branch, after.branch);
});

test('a long-lived host derives home state from the current branch on every read', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity', 'work-items', 'WRK-1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-1', title: 'Started work', branch: 'wi/WRK-1' },
    lineage: { canonicalBranch: 'wi/WRK-1', childBranches: [{ name: 'main' }] },
    phaseOrder: ['intake'], currentPhase: 'intake',
    phases: { intake: { label: 'Intake', status: 'in_progress', generation: 1 } },
    history: [{ event: 'work_started', phase: 'intake', at: '2026-08-16T10:00:00.000Z' }]
  }));

  const { kernel } = createHostGateway({ root, hostSessionId: 's-context', planners: gatewayPlanners() });
  const readHome = async () => {
    const resolution = await kernel.resolve({ utterance: 'home' });
    return kernel.read({ resolutionId: resolution.next[0].handle });
  };
  const onRegisteredBranch = await readHome();
  assert.equal(onRegisteredBranch.data.activeWork?.id, 'WRK-1');
  assert.equal(onRegisteredBranch.next[0].id, 'home:work.continue');

  run('git', ['checkout', '-q', '-b', 'unrelated'], { cwd: root });
  const elsewhere = await readHome();
  assert.equal(elsewhere.data.activeWork, null);
  assert.ok(!elsewhere.next.some((entry) => entry.id === 'home:work.continue'));
  assert.equal(elsewhere.next[0].id, 'home:work.list');
});

test('planner navigation is sealed by the kernel and reaches the selected operation', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity', 'work-items', 'WRK-SEALED');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WRK-SEALED', title: 'Sealed navigation', branch: 'main', workType: 'feature' },
    lineage: { canonicalBranch: 'main', childBranches: [] },
    phaseOrder: ['intake'], currentPhase: 'intake',
    phases: { intake: { label: 'Intake', status: 'in_progress', generation: 1 } },
    history: [{ event: 'work_started', phase: 'intake', at: '2026-08-16T10:00:00.000Z' }]
  }));

  const gateway = createHostGateway({ root, hostSessionId: 's-sealed', planners: gatewayPlanners() });
  const homeResolution = await gateway.kernel.resolve({ utterance: 'home' });
  const home = await gateway.kernel.read({ resolutionId: homeResolution.next[0].handle });
  const offered = home.next.find((entry) => entry.id === 'home:work.continue');
  assert.match(offered.handle, /^sel_[0-9a-f]{32}$/,
    'the planner prefix never crosses the kernel boundary');

  const executor = createActionExecutor({ gateway });
  const selected = await executor.execute(offered);
  assert.equal(selected.outcome, 'resolved');
  assert.equal(selected.result.operation.id, 'work.continue');
  assert.match(selected.result.next[0].handle, /^rea_[0-9a-f]{32}$/);

  const continued = await executor.execute(selected.result.next[0]);
  assert.equal(continued.outcome, 'read');
  assert.equal(continued.result.operation.id, 'work.continue');
  assert.equal(continued.result.outcome.status, 'succeeded');
});

test('a read declares the revision its handle was bound to, not a row of nulls', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { kernel, binding } = createHostGateway({ root, hostSessionId: 's-rev', planners: gatewayPlanners() });
  const resolution = await kernel.resolve({ utterance: 'home' });
  const envelope = await kernel.read({ resolutionId: resolution.next[0].handle });

  /**
   * The producer half of a bug that had no symptom. `[INT:REQ-035]`
   *
   * `kernel.read()` handed the planner the handle's *binding* — flat, with `lifecycleRevision` where
   * the contract says `lifecycleHash` — and `sflowResult` reads `subject.revision?.sourceCommit`.
   * The path does not exist on a binding, so every field validated as null and every read the
   * gateway served declared that it depended on nothing.
   *
   * It is only visible from outside: a consumer comparing two answers to say what moved got two
   * identical rows of nulls and concluded, honestly and wrongly, that nothing had.
   */
  assert.equal(envelope.subject.revision.sourceCommit, binding().sourceCommit);
  assert.match(envelope.subject.revision.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(envelope.subject.revision.policyHash, binding().policyHash);
  assert.equal(envelope.subject.revision.registryHash, binding().registryHash);
});

test('a home declares the uncommitted bytes its ordering depended on', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const clean = createHostGateway({ root, hostSessionId: 's-clean', planners: gatewayPlanners() });
  const before = await clean.kernel.read({
    resolutionId: (await clean.kernel.resolve({ utterance: 'home' })).next[0].handle
  });
  /** The hash binds observation state; `data.localChanges` is what says whether it is dirty. */
  assert.match(before.subject.revision.worktreeHash, /^[0-9a-f]{64}$/);
  assert.equal(before.data.localChanges.dirty, false);

  await writeFile(path.join(root, 'README.md'), '# fixture\nlocal edit\n');
  const dirty = createHostGateway({ root, hostSessionId: 's-dirty', planners: gatewayPlanners() });
  const after = await dirty.kernel.read({
    resolutionId: (await dirty.kernel.resolve({ utterance: 'home' })).next[0].handle
  });

  assert.match(after.subject.revision.worktreeHash, /^[0-9a-f]{64}$/);
  assert.equal(after.data.localChanges.dirty, true);
  // The commit did not move, so a consumer reading only that would report no change at all.
  assert.equal(after.subject.revision.sourceCommit, before.subject.revision.sourceCommit);
});

test('editing an assume-unchanged file invalidates an issued read handle', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['update-index', '--assume-unchanged', 'README.md'], { cwd: root });
  const { kernel } = createHostGateway({
    root, hostSessionId: 's-hidden-drift', planners: gatewayPlanners()
  });
  const issued = (await kernel.resolve({ utterance: 'home' })).next[0].handle;
  await writeFile(path.join(root, 'README.md'), '# hidden edit\n');

  const refused = await kernel.read({ resolutionId: issued });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.handle-drifted');
});

test('editing bytes inside an already-dirty path invalidates an issued read handle', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'README.md');
  await writeFile(target, '# dirty version one\n');

  const { kernel } = createHostGateway({
    root,
    hostSessionId: 's-worktree-drift',
    planners: gatewayPlanners()
  });
  const resolution = await kernel.resolve({ utterance: 'home' });
  const issued = resolution.next[0].handle;

  // Git status is still exactly "README.md modified"; only the reviewed bytes changed.
  await writeFile(target, '# dirty version two\n');
  const refused = await kernel.read({ resolutionId: issued });
  assert.equal(refused.kind, 'refusal');
  assert.equal(refused.why[0].code, 'gateway.handle-drifted');
});

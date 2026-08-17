/**
 * The dispatcher every surface shares, and the drift it exists to catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createActionExecutor } from '../src/gateway/executor.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-exec-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.email', 'dev@example.test'], { cwd: root });
  run('git', ['config', 'user.name', 'Dev'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'first'], { cwd: root });
  return root;
}

test('an executor requires a host gateway, not a bare kernel', () => {
  assert.throws(() => createActionExecutor({}), /requires a host gateway/);
});

test('an action without its handle is refused before anything is dispatched', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = createActionExecutor({ gateway: createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() }) });
  await assert.rejects(() => executor.execute({ id: 'home:work.list' }), /must carry the handle/);
});

test('a read action dispatches through its handle and returns a result', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() });
  const executor = createActionExecutor({ gateway });

  const resolution = await gateway.kernel.resolve({ utterance: 'home' });
  const { outcome, result } = await executor.execute(resolution.next[0]);
  assert.equal(outcome, 'read');
  assert.equal(result.operation.id, 'home.overview');
  assert.equal(result.outcome.status, 'succeeded');
});

test('switching branch invalidates a handle resolved before the switch', async (t) => {
  /**
   * The hole this work closed. The kernel used to compare a handle's binding against the binding it
   * was *constructed* with, so in a session that outlives a branch switch both sides were the same
   * stale snapshot and drift detection saw nothing. With a binding thunk, the handle is compared
   * against the world now.
   */
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() });
  const executor = createActionExecutor({ gateway });

  const resolution = await gateway.kernel.resolve({ utterance: 'home' });
  run('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: root });

  const { outcome, result } = await executor.execute(resolution.next[0]);
  assert.equal(outcome, 'stale');
  assert.equal(result.kind, 'refusal');
  assert.equal(result.why[0].code, 'gateway.handle-drifted');
  // Recoverable, so it offers a way back rather than stopping `[INT:REQ-041]`.
  assert.equal(result.next.length, 1);
  assert.equal(result.next[0].interaction, 'recovery');
  assert.equal(result.next[0].emphasis, 'primary');
  assert.match(result.next[0].handle, /^rea_/);
  const recovered = await executor.execute(result.next[0]);
  assert.equal(recovered.outcome, 'read');
  assert.equal(recovered.result.operation.id, 'home.overview');
  // And it says nothing was carried out `[DHR:REQ-061]`.
  assert.equal(result.preserved[0].scope, 'all');
});

test('a stale refusal is a result, never a thrown error', async (t) => {
  // A host that has to catch exceptions renders them as error toasts, which is the dead end
  // `[UXH:CON-007]` prohibits.
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() });
  const executor = createActionExecutor({ gateway });

  const { outcome, result } = await executor.execute({
    handle: 'rea_0000000000000000000000000000dead', id: 'ghost', confirmation: 'none', interaction: 'read'
  });
  assert.equal(outcome, 'stale');
  assert.equal(result.kind, 'refusal');
  assert.equal(result.why[0].code, 'gateway.handle-unknown');
  const recovered = await executor.execute(result.next[0]);
  assert.equal(recovered.outcome, 'read');
  assert.equal(recovered.result.operation.id, 'home.overview');
});

test('an invalid selection offers a signed recovery that reaches Home', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() });
  const executor = createActionExecutor({ gateway });

  const refused = await gateway.kernel.resolve({ selectionHandle: 'sel_not-issued' });
  assert.equal(refused.kind, 'refusal');
  assert.match(refused.next[0].handle, /^rea_/);
  const recovered = await executor.execute(refused.next[0]);
  assert.equal(recovered.outcome, 'read');
  assert.equal(recovered.result.operation.id, 'home.overview');
});

test('a ceremony is handed back to be opened, never carried out', async (t) => {
  /**
   * `[INT:CON-113]`: an authorization decision is never executable by an ambient tool. Enforced
   * here rather than left to each view to remember, which is what 25 separate command paths meant.
   */
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = createActionExecutor({ gateway: createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() }) });

  const { outcome, action } = await executor.execute({
    handle: 'ceremony:review.approve', id: 'approve', confirmation: 'ceremony', interaction: 'ceremony'
  });
  assert.equal(outcome, 'ceremony');
  assert.equal(action.id, 'approve');
});

test('a non-executable action re-resolves rather than acting', async (t) => {
  /**
   * A menu item rendered ten minutes ago must not act on a world that has moved: the click selects,
   * and resolution runs again from the top `[INT:IFC-001]`.
   */
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() });
  const executor = createActionExecutor({ gateway });

  const home = await gateway.kernel.read({
    resolutionId: (await gateway.kernel.resolve({ utterance: 'home' })).next[0].handle
  });
  const menuItem = home.next.find((action) => action.executable === false);
  assert.ok(menuItem, 'the home menu is not executable');

  const { outcome, result } = await executor.execute(menuItem);
  assert.equal(outcome, 'resolved');
  assert.equal(result.schemaVersion, 2);
});

test('executeById refuses an id this result did not offer', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createHostGateway({ root, hostSessionId: 's1', planners: gatewayPlanners() });
  const executor = createActionExecutor({ gateway });
  const resolution = await gateway.kernel.resolve({ utterance: 'home' });

  await assert.rejects(() => executor.executeById(resolution, 'something:invented'), /is not an action this result offered/);
  const { outcome } = await executor.executeById(resolution, resolution.next[0].id);
  assert.equal(outcome, 'read');
});

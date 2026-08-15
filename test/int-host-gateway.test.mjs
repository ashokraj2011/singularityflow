/**
 * The gateway's first production wiring.
 *
 * Everything under `src/gateway/` was built, tested and reachable from nothing: `grep gateway/ src/`
 * returned no hits outside the directory itself. These tests cover the seam that ends that — the
 * binding read from a real repository, and the resolve → handle → read round trip a surface makes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_GATEWAY_POLICY, resolveGatewayPolicy } from '../src/gateway/policy.mjs';
import { createHostGateway, hostBinding } from '../src/gateway/host.mjs';
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
  for (const field of ['subjectKind', 'subjectId', 'worktreeHash', 'lifecycleRevision']) {
    assert.ok(field in binding, `${field} is not declared`);
    assert.equal(binding[field], null);
  }
});

test('a host session requires the session it is issuing handles for', () => {
  // A default would be a shared session ID, under which a handle issued in one window verifies in
  // another — the confusion binding exists to prevent.
  assert.throws(() => createHostGateway({ root: '/tmp', hostSessionId: null }), /requires the host session/);
});

test('resolve issues a handle and read revalidates it against the world', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { kernel } = createHostGateway({ root, hostSessionId: 'sess-1', workspaceId: 'w1' });
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
  assert.ok(envelope.next.length, 'the home offers choices');
  assert.equal(envelope.next.filter((action) => action.emphasis === 'primary').length, 1);
});

test('a handle is single-session: the same words in another session do not redeem it', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = createHostGateway({ root, hostSessionId: 'sess-1' });
  const resolution = await first.kernel.resolve({ utterance: 'home' });
  const handle = resolution.next[0].handle;

  const second = createHostGateway({ root, hostSessionId: 'sess-2' });
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

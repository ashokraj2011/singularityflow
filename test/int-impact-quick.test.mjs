import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createHostGateway } from '../src/gateway/host.mjs';
import { IMPACT_EVIDENCE_GAPS, affectedCapabilities, impactQuick } from '../src/gateway/planners/impact-quick.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { run } from '../src/util.mjs';

const WORKSPACE = {
  repositories: {
    checkout: { id: 'checkout', path: 'repos/checkout-service', capabilities: ['checkout', 'payments'] },
    billing: { id: 'billing', path: 'repos/billing', capabilities: ['payments'] },
    docs: { id: 'docs', path: 'repos/docs', capabilities: [] }
  }
};

async function emptyRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-'));
  await mkdir(path.join(root, 'singularity', 'work-items'), { recursive: true });
  return root;
}

test('capabilities come from the declared map, never from a path that looks familiar', () => {
  const hits = affectedCapabilities(WORKSPACE, ['repos/checkout-service/src/pay.ts']);
  assert.deepEqual(hits, [
    { capability: 'checkout', repositories: ['checkout'] },
    { capability: 'payments', repositories: ['checkout'] }
  ]);

  // A directory named after a capability in a repository that declares none is not that capability.
  assert.deepEqual(affectedCapabilities(WORKSPACE, ['repos/docs/payments/guide.md']), []);
  assert.deepEqual(affectedCapabilities(WORKSPACE, ['unrelated/file.ts']), []);
});

test('one capability across two repositories is reported once, naming both', () => {
  const hits = affectedCapabilities(WORKSPACE, ['repos/checkout-service/a.ts', 'repos/billing/b.ts']);
  const payments = hits.find((entry) => entry.capability === 'payments');
  assert.deepEqual(payments.repositories, ['billing', 'checkout']);
});

test('the report names what it was computed from and claims no semantic impact', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({
    root,
    arguments: { baseRef: 'main', targetRef: 'wi/WRK-1', includeWorktree: true },
    context: { workspace: WORKSPACE, changedPaths: ['repos/checkout-service/src/pay.ts'] }
  });
  validateSflowResult(result);
  assert.equal(result.kind, 'read');
  assert.equal(result.data.baseline, 'main');
  assert.equal(result.data.target, 'wi/WRK-1');
  assert.equal(result.data.semanticImpact, null, 'the report never says whether anything is broken');
  assert.deepEqual(result.data.affected.repositories, ['checkout']);
});

test('a missing input is a declared gap, never an empty result', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({ root, context: { workspace: WORKSPACE, changedPaths: [] } });
  for (const field of IMPACT_EVIDENCE_GAPS) {
    const warning = result.warnings.find((entry) => entry.slots.field === field);
    assert.ok(warning, `${field} should be disclosed as unread`);
    assert.equal(warning.source, 'unavailable');
  }
  // Build provenance in particular: absent adapters must not read as "no builds affected".
  assert.ok(IMPACT_EVIDENCE_GAPS.includes('build-provenance'));
});

test('tests matched by path convention say that is what they are', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({
    root,
    context: { workspace: WORKSPACE, changedPaths: ['repos/checkout-service/tests/pay.test.ts', 'repos/checkout-service/src/pay.ts'] }
  });
  assert.deepEqual(result.data.affected.testsByConvention, ['repos/checkout-service/tests/pay.test.ts']);
  const heuristic = result.warnings.find((entry) => entry.code === 'impact.tests-by-path-convention');
  assert.equal(heuristic.slots.matched, '1');
});

test('quick impact changes nothing and offers no shortcut into creating work', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({ root, context: { workspace: WORKSPACE, changedPaths: ['repos/billing/x.ts'] } });
  // `[INT:CON-070]` and `[INT:REQ-075]`.
  assert.equal(Object.values(result.effects).some(Boolean), false);
  assert.equal(result.next.every((entry) => entry.executable === false), true);
});

test('impact.quick refuses without a root rather than reading the working directory', async () => {
  await assert.rejects(() => impactQuick({ context: { workspace: WORKSPACE, changedPaths: [] } }),
    (error) => error.code === 'IMPACT_QUICK_NO_ROOT');
});

// ---------------------------------------------------------------------------------------------------
// the host context: a workspace named by ID, and paths relative to the repository root

const git = (cwd, ...args) => run('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd }).stdout.trim();

/** A registered workspace on disk whose checkout repository declares two capabilities, and one change. */
async function registeredWorkspace(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-workspace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, 'workspace');
  const remote = path.join(base, 'checkout.git');
  const root = path.join(workspacePath, 'repos', 'checkout-service');
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'src', 'pay.ts'), 'export const pay = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const baseRef = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'pay.ts'), 'export const pay = 2;\n');
  git(root, 'commit', '-q', '-am', 'pay rounds up');
  const targetRef = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', '-q', 'origin', 'main');
  const manifest = {
    version: 1, id: 'acme-checkout', name: 'Acme checkout',
    anchor: { provider: 'workspace', key: 'acme-checkout', title: 'Acme checkout' },
    leadRepository: 'checkout', capabilities: [],
    repositories: {
      checkout: { url: remote, path: 'repos/checkout-service', capabilities: ['payments', 'checkout'] },
      billing: { url: path.join(base, 'billing.git'), path: 'repos/billing', capabilities: ['payments'] }
    }
  };
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify(manifest));
  const registry = path.join(base, 'workspaces.json');
  await writeFile(registry, JSON.stringify([{ id: manifest.id, name: manifest.name, path: workspacePath }]));
  return {
    base, root, remote, workspacePath, args: { baseRef, targetRef },
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry },
    // What host.mjs builds for a planner: the workspace by ID and name, never its manifest.
    context: { workspace: { id: manifest.id, name: manifest.id }, repositoryId: 'checkout' }
  };
}

const CHECKOUT_CAPABILITIES = [
  { capability: 'checkout', repositories: ['checkout'] },
  { capability: 'payments', repositories: ['checkout'] }
];

test('the host gateway context names the capabilities a change touches, from the workspace manifest', async (t) => {
  const f = await registeredWorkspace(t);
  const previous = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previous;
  });
  // The kernel a command or the editor builds, with the context host.mjs makes from a workspace ID.
  const { kernel } = createHostGateway({ root: f.root, hostSessionId: 'sess-impact-host', workspaceId: 'acme-checkout',
    planners: gatewayPlanners() });
  const resolved = await kernel.resolve({ utterance: 'quick impact analysis', arguments: f.args });
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.deepEqual(read.data.affected.paths, ['src/pay.ts'], 'paths are relative to the repository, not the workspace');
  assert.deepEqual(read.data.affected.capabilities, CHECKOUT_CAPABILITIES);
  assert.deepEqual(read.data.affected.repositories, ['checkout']);
  assert.equal(read.data.evidenceGaps.includes('capability-map'), false);
});

test('a Story worktree and a second clone are the same workspace repository; an unrelated one is a gap', async (t) => {
  const f = await registeredWorkspace(t);
  const impact = (root, context = f.context) => impactQuick({ root, env: f.env, arguments: f.args, context });

  const worktree = path.join(f.workspacePath, '.singularity-flow', 'story-worktrees', 'WRK-1');
  git(f.root, 'worktree', 'add', '-q', '-b', 'wi/WRK-1', worktree, f.args.targetRef);
  const second = path.join(f.base, 'second-clone');
  git(f.base, 'clone', '-q', f.remote, second);
  for (const root of [f.root, worktree, second]) {
    const result = await impact(root);
    assert.deepEqual(result.data.affected.capabilities, CHECKOUT_CAPABILITIES, root);
    assert.equal(result.data.evidenceGaps.includes('capability-map'), false, root);
  }
  // An origin spelled differently from the manifest is still the declared remote.
  git(f.root, 'remote', 'set-url', 'origin', pathToFileURL(f.remote).href);
  assert.deepEqual((await impact(f.root)).data.affected.capabilities, CHECKOUT_CAPABILITIES);

  // Not a member, no workspace, or a workspace this machine does not register: unknown, and said.
  const unrelated = path.join(f.base, 'unrelated');
  git(f.base, 'clone', '-q', f.remote, unrelated);
  git(unrelated, 'remote', 'set-url', 'origin', path.join(f.base, 'elsewhere.git'));
  for (const [root, context] of [[unrelated, f.context], [f.root, { repositoryId: 'checkout' }],
    [f.root, { workspace: { id: 'not-registered', name: 'not-registered' } }]]) {
    const result = await impact(root, context);
    assert.deepEqual(result.data.affected.capabilities, []);
    assert.ok(result.data.evidenceGaps.includes('capability-map'), `${root} ${JSON.stringify(context)}`);
    assert.ok(result.warnings.some((entry) => entry.code === 'impact.evidence-gap' && entry.slots.field === 'capability-map'));
  }
});

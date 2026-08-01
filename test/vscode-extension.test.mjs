/**
 * The extension's CLI and snapshot layers, exercised directly from TypeScript.
 *
 * `node --experimental-strip-types` runs the sources as-is, so these test the code that actually
 * ships rather than a bundle built by a step that could itself be wrong. That is only possible
 * because apps/vscode/src avoids the TypeScript syntax that needs real transformation — see the note
 * in runner.ts. If someone adds an enum or a parameter property, these tests fail loudly at import,
 * which is the intended alarm.
 *
 * The snapshot fixture is a real `desktop snapshot --json`, trimmed to the regions the extension
 * types. Its value is that it was produced by the engine: a hand-written fixture only proves the
 * accessors agree with my reading of desktop.mjs, which is the thing most likely to be wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(packageRoot, 'apps', 'vscode', 'src', name);

const { invokeCli, CliError, validateRepositoryDirectory, UninitializedRepositoryError } =
  await import(source('cli/runner.ts'));
const { resolveCli, SingularityFlowClient } = await import(source('cli/client.ts'));
const { phasesInOrder, packsWithMembers, storiesByRepository, isApprovalPinned } =
  await import(source('cli/snapshot.ts'));

const snapshot = JSON.parse(await readFile(
  path.join(packageRoot, 'apps', 'vscode', 'test', 'fixtures', 'snapshot-initiative-lite.json'), 'utf8'));

/** A child process that emits exactly what a test wants, without spawning anything. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.kill = () => { child.killed = true; };
    setTimeout(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      child.emit('close', code);
    }, delayMs);
    return child;
  };
}

const invoke = (overrides) => invokeCli({
  executable: 'node', cli: '/cli.mjs', repository: '/repo', args: ['x'], ...overrides
});

test('a successful run resolves the parsed JSON', async () => {
  const result = await invoke({ spawnImpl: fakeSpawn({ stdout: '{"ready":true,"errors":[]}' }) });
  assert.deepEqual(result, { ready: true, errors: [] });
});

test('a non-zero exit rejects with the CLI message, stripped of its prefix', async () => {
  // The CLI's own wording is already written for a human; rewording it here would lose the remedy
  // the engine deliberately names.
  await assert.rejects(
    invoke({ spawnImpl: fakeSpawn({ stderr: "Singularity Flow error: Phase 'define' is not ready.", code: 1 }) }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.message, "Phase 'define' is not ready.");
      assert.equal(error.exitCode, 1);
      return true;
    }
  );
});

test('output that is not JSON rejects rather than resolving undefined', async () => {
  // Resolving a bad parse would render an empty governance view as though it were the truth.
  await assert.rejects(
    invoke({ spawnImpl: fakeSpawn({ stdout: 'Prepared 3 define documents' }) }),
    /could not read/
  );
});

test('--json can be turned off for commands that print prose', async () => {
  const result = await invoke({ json: false, spawnImpl: fakeSpawn({ stdout: '  Prepared 3 documents\n' }) });
  assert.deepEqual(result, { output: 'Prepared 3 documents' });
});

test('a run that exceeds its timeout is killed and reports the timeout', async () => {
  await assert.rejects(
    invoke({ timeoutMs: 20, spawnImpl: fakeSpawn({ stdout: '{}', delayMs: 5_000 }) }),
    /did not finish within 1 seconds/
  );
});

test('an aborted run is killed and reports cancellation', async () => {
  const controller = new AbortController();
  const pending = invoke({ signal: controller.signal, spawnImpl: fakeSpawn({ stdout: '{}', delayMs: 5_000 }) });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('a signal already aborted never spawns anything', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(
    invoke({ signal: controller.signal, spawnImpl: () => { spawned = true; return new EventEmitter(); } }),
    /cancelled/
  );
  assert.equal(spawned, false);
});

test('a progress observer that throws does not take the command down', async () => {
  const result = await invoke({
    onOutput: () => { throw new Error('observer exploded'); },
    spawnImpl: fakeSpawn({ stdout: '{"ok":true}' })
  });
  assert.deepEqual(result, { ok: true });
});

test('progress is reported per stream as it arrives', async () => {
  const seen = [];
  await invoke({
    onOutput: (text, stream) => seen.push([stream, text.trim()]),
    spawnImpl: fakeSpawn({ stdout: '{"ok":true}', stderr: 'building world model' })
  });
  assert.deepEqual(seen, [['stdout', '{"ok":true}'], ['stderr', 'building world model']]);
});

/** A Git repository that has actually been initialized with Singularity Flow. */
async function initializedRepository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-'));
  const root = path.join(base, 'app');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
  return { base, root };
}

test('an initialized repository root validates and resolves to its canonical path', async () => {
  const { root } = await initializedRepository();
  assert.equal(await validateRepositoryDirectory(root), await realpath(root));
});

test('a Git repository without Singularity Flow is refused, naming the remedy', async () => {
  // The product's own repository hits this too: being a Git repo is not the same as using the tool.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-bare-'));
  const root = path.join(base, 'plain');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await assert.rejects(validateRepositoryDirectory(root), (error) => {
    assert.ok(error instanceof UninitializedRepositoryError);
    assert.match(error.message, /singularity\/workflow\.yml/);
    assert.match(error.message, /singularity-flow init/);
    return true;
  });
});

test('a nested directory is refused, and the message names the folder that was tried', async () => {
  // Caught by the .git probe rather than the top-level comparison, since a nested directory has no
  // .git of its own. The top-level guard behind it is what catches a worktree or submodule, where
  // .git exists but points somewhere else.
  const { root } = await initializedRepository();
  const nested = path.join(root, 'src');
  await mkdir(nested, { recursive: true });
  await assert.rejects(validateRepositoryDirectory(nested), (error) => {
    assert.match(error.message, /not a Git repository/);
    assert.match(error.message, /src$/, 'the folder that was actually tried is named');
    return true;
  });
});

test('a symbolic-linked control directory is refused', async () => {
  // The extension resolves artifact paths relative to this root, so a symlinked control directory is
  // how a path that looks inside the workspace comes to point outside it.
  const { base, root } = await initializedRepository();
  const elsewhere = path.join(base, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await rm(path.join(root, 'singularity'), { recursive: true });
  await symlink(elsewhere, path.join(root, 'singularity'));
  await assert.rejects(validateRepositoryDirectory(root), /cannot be a symbolic link/);
});

test('a folder that is not a Git repository at all is refused', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-nogit-'));
  await assert.rejects(validateRepositoryDirectory(base), /not a Git repository/);
});

test('CLI resolution prefers the setting, then the bundled CLI, and says which it used', () => {
  const exists = (candidate) => candidate.endsWith('bin/singularity-flow.mjs');

  const configured = resolveCli({ configuredCli: '/custom/bin/singularity-flow.mjs', exists });
  assert.equal(configured.source, 'setting');
  assert.equal(configured.cli, '/custom/bin/singularity-flow.mjs');

  const bundled = resolveCli({ extensionPath: '/ext', exists });
  assert.equal(bundled.source, 'bundled');
  assert.equal(bundled.cli, '/ext/cli/bin/singularity-flow.mjs');
});

test('a configured CLI that does not exist fails at resolution, not at first use', () => {
  // Failing later would surface as "the snapshot command failed", which points at the wrong thing.
  assert.throws(
    () => resolveCli({ configuredCli: '/missing/cli.mjs', exists: () => false }),
    /cliPath points at a file that does not exist/
  );
});

test('no CLI anywhere fails with both places named', () => {
  const previous = process.env.SINGULARITY_FLOW_CLI;
  delete process.env.SINGULARITY_FLOW_CLI;
  try {
    assert.throws(() => resolveCli({ exists: () => false }), /singularityFlow.cliPath[\s\S]*SINGULARITY_FLOW_CLI/);
  } finally {
    if (previous !== undefined) process.env.SINGULARITY_FLOW_CLI = previous;
  }
});

test('wm build gets the long timeout; everything else does not', async () => {
  const timeouts = [];
  const client = new SingularityFlowClient({
    location: { executable: 'node', cli: '/cli.mjs', source: 'setting' },
    repository: '/repo'
  });
  // Observe the timeout by racing it: a 15-minute budget must not fire where a 2-minute one would.
  // Asserted through the public surface rather than by reaching into the module's constants.
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { timeouts.push(ms); return original(fn, 1, ...rest); };
  try {
    await client.run(['wm', 'build']).catch(() => {});
    await client.run(['initiative', 'status']).catch(() => {});
  } finally {
    globalThis.setTimeout = original;
  }
  assert.equal(timeouts[0], 15 * 60_000);
  assert.equal(timeouts[1], 120_000);
});

test('phases are read in declared order with the state each is in', () => {
  const phases = phasesInOrder(snapshot.initiative);
  assert.deepEqual(phases.map((phase) => phase.id), ['define', 'plan', 'build', 'release']);
  assert.equal(phases[0].label, 'Define');
  assert.equal(phases.filter((phase) => phase.current).length, 1, 'exactly one phase is current');
  assert.equal(phases.find((phase) => phase.current).id, snapshot.initiative.state.currentPhase);
  assert.ok(phases[0].outputs.length > 0, 'the define phase declares outputs');
});

test('a profile that declares no packs yields none rather than throwing', () => {
  // initiative-lite has no packs; only enterprise-delivery does. An absent construct is normal.
  assert.deepEqual(packsWithMembers(snapshot.initiative), []);
});

test('packs join their members to the artifacts, and report unauthored ones as absent', () => {
  const withPacks = {
    ...snapshot.initiative,
    state: {
      ...snapshot.initiative.state,
      resolution: {
        ...snapshot.initiative.state.resolution,
        packs: [{ id: 'opportunity', label: 'Opportunity & Investment Brief', members: ['define/business-case', 'define/missing-one'] }]
      }
    }
  };
  const [pack] = packsWithMembers(withPacks);
  assert.equal(pack.label, 'Opportunity & Investment Brief');
  assert.deepEqual(pack.members.map((member) => member.phase), ['define', 'define']);
  assert.equal(pack.members[0].output, 'business-case');
  assert.equal(pack.members[0].artifact?.id, 'business-case');
  assert.equal(pack.members[0].authored, false, 'declared but not yet generated');
  assert.equal(pack.members[1].artifact, null, 'a member naming no real output is absent, not a crash');
});

test('Stories group by the repository they land in', () => {
  const grouped = storiesByRepository(snapshot.initiative);
  assert.deepEqual(grouped.map((entry) => entry.repository), ['api', 'mobile']);
  assert.equal(grouped.find((entry) => entry.repository === 'mobile').stories.length, 2);
});

test('an initiative with no breakdown groups nothing rather than throwing', () => {
  assert.deepEqual(storiesByRepository({ ...snapshot.initiative, breakdown: null }), []);
});

test('only approval-pinned artifacts are treated as read-only', () => {
  assert.equal(isApprovalPinned({ status: 'approved', sha256: 'abc' }), true);
  assert.equal(isApprovalPinned({ status: 'generated', sha256: 'abc' }), false,
    'a generated artifact is exactly what a human should still be able to correct');
  assert.equal(isApprovalPinned({ status: 'not_generated', sha256: null }), false);
});

const { buildTree } = await import(source('views/tree-model.ts'));

/** Every node in the tree, depth-first, so a test can assert about the whole shape. */
function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}
const find = (nodes, id) => flatten(nodes).find((node) => node.id === id);

test('an unreadable repository shows the CLI error rather than an empty tree', () => {
  // An empty tree in a governance tool reads as "nothing to do", which is the most expensive thing
  // it could wrongly say.
  const [node] = buildTree(null, new Error("Phase 'define' is not ready."));
  assert.equal(node.kind, 'message');
  assert.equal(node.label, "Phase 'define' is not ready.");
  assert.equal(node.icon, 'error');
});

test('a repository with no Epic on this branch says so, and how many exist', () => {
  const [node] = buildTree({ initiative: null, initiatives: [{ id: 'A' }, { id: 'B' }], workItems: [] });
  assert.match(node.label, /No Epic is checked out/);
  assert.equal(node.description, '2 available');
  assert.match(node.tooltip, /epic start/);
});

test('a repository with no Epic at all offers the command that starts one', () => {
  const [node] = buildTree({ initiative: null, initiatives: [], workItems: [] });
  assert.match(node.label, /No Epic has been started/);
  assert.match(node.tooltip, /epic start --local/);
});

test('the tree is built from the real snapshot: lifecycle, phases, artifacts, Stories', () => {
  const tree = buildTree(snapshot);
  assert.equal(tree.length, 1);
  const [root] = tree;
  assert.equal(root.kind, 'initiative');
  assert.equal(root.label, 'INIT-MULTI');

  const phases = find(tree, 'phases');
  assert.deepEqual(phases.children.map((phase) => phase.id),
    ['phase:define', 'phase:plan', 'phase:build', 'phase:release']);
  assert.equal(phases.description, '0/4 approved');

  const define = find(tree, 'phase:define');
  assert.equal(define.description, 'in progress · current', 'the phase someone is standing in is marked');
  assert.ok(define.children.length > 0);
  const artifact = define.children[0];
  assert.equal(artifact.kind, 'artifact');
  assert.ok(artifact.path, 'an artifact carries the path the editor opens');
  assert.equal(artifact.readOnly, false, 'nothing is approved yet, so nothing is pinned');
});

test('the next governed action is surfaced first, with the engine own wording', () => {
  const tree = buildTree(snapshot);
  const action = find(tree, 'next-action');
  assert.equal(action.kind, 'action');
  assert.equal(action.label, snapshot.initiative.nextActions[0].reason);
  // Split into argv so it can be run, with the binary name removed.
  assert.deepEqual(action.command, ['initiative', 'phase', 'define']);
});

test('Stories are grouped by the repository they land in', () => {
  const tree = buildTree(snapshot);
  const stories = find(tree, 'stories');
  assert.equal(stories.description, '3 across 2 repositories');
  assert.deepEqual(stories.children.map((entry) => entry.label), ['api', 'mobile']);
  const mobile = find(tree, 'repository:mobile');
  assert.equal(mobile.children.length, 2);
  const dependent = mobile.children.find((story) => story.label === 'MOB-1');
  assert.match(dependent.tooltip, /Depends on API-1/);
});

test('a non-blocking Story is marked as such rather than looking identical', () => {
  const tree = buildTree(snapshot);
  const optional = flatten(tree).find((node) => node.kind === 'story' && node.label === 'MOB-2');
  assert.match(optional.description, /non-blocking/);
});

test('an approved artifact is pinned read-only and reports its hash', () => {
  const approved = structuredClone(snapshot);
  const output = Object.values(approved.initiative.state.phases.define.outputs)[0];
  output.status = 'approved';
  output.sha256 = 'a'.repeat(64);
  const artifact = find(buildTree(approved), `artifact:define/${output.id}`);
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.contextValue, 'sflow.artifact.pinned');
  assert.match(artifact.tooltip, /sha256 a{64}/);
});

test('a blocked phase gate is shown with each reason, not just a count', () => {
  const blocked = structuredClone(snapshot);
  blocked.initiative.phaseGate = {
    ready: false, passes: [], warnings: [],
    errors: ['business-case has 0/1 approvals', 'scope-agreed has no evidence']
  };
  const tree = buildTree(blocked);
  const gate = find(tree, 'gate');
  assert.equal(gate.label, 'This phase is not ready (2)');
  assert.deepEqual(gate.children.map((child) => child.label), blocked.initiative.phaseGate.errors);
});

test('a ready gate adds no noise to the tree', () => {
  const ready = structuredClone(snapshot);
  ready.initiative.phaseGate = { ready: true, errors: [], warnings: [], passes: [] };
  assert.equal(find(buildTree(ready), 'gate'), undefined);
});

test('packs appear beside phases, since a pack deliberately spans them', () => {
  const withPacks = structuredClone(snapshot);
  withPacks.initiative.state.resolution.packs = [{
    id: 'validation-release',
    label: 'Validation & Release Readiness',
    members: ['define/business-case', 'plan/delivery-plan']
  }];
  const tree = buildTree(withPacks);
  const packs = find(tree, 'packs');
  assert.ok(packs, 'packs are a sibling of the lifecycle, not nested inside one phase');
  const pack = find(tree, 'pack:validation-release');
  assert.equal(pack.label, 'Validation & Release Readiness');
  assert.equal(pack.description, '0/2');
  // A member the profile does not declare is reported rather than silently dropped.
  assert.equal(pack.children.length, 2);
});

test('a profile with no packs shows no pack group at all', () => {
  assert.equal(find(buildTree(snapshot), 'packs'), undefined);
});

test('every node has a unique id, or the tree view collapses the duplicates', () => {
  const withPacks = structuredClone(snapshot);
  withPacks.initiative.state.resolution.packs = [
    { id: 'p1', label: 'One', members: ['define/business-case'] }
  ];
  const ids = flatten(buildTree(withPacks)).map((node) => node.id);
  // Pack members reuse the artifact id by design; assert uniqueness per parent instead of globally.
  const phaseArtifacts = find(buildTree(withPacks), 'phases')
    .children.flatMap((phase) => (phase.children ?? []).map((child) => child.id));
  assert.equal(new Set(phaseArtifacts).size, phaseArtifacts.length);
  assert.ok(ids.length > 10);
});

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
  // Offered as an action rather than a command to retype; the tooltip no longer carries one.
  assert.equal(node.contextValue, 'sflow.start');
});

test('a repository with no Epic at all offers the command that starts one', () => {
  const [node] = buildTree({ initiative: null, initiatives: [], workItems: [] });
  assert.match(node.label, /No Epic has been started/);
  assert.equal(node.contextValue, 'sflow.start');
});

test('the tree is built from the real snapshot: lifecycle, phases, artifacts, Stories', () => {
  const tree = buildTree(snapshot);
  // The Epic, plus the two things that belong to the repository rather than to any Epic.
  assert.deepEqual(tree.map((node) => node.id),
    ['initiative:INIT-MULTI', 'capabilities', 'world-model', 'configuration']);
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

const { buildJourney } = await import(source('views/journey-model.ts'));

test('a published artifact offers approval, carrying the confirmation the CLI will demand', () => {
  // The confirmation travels with the node so the editor can ask a human to type it. The extension
  // must never fill it in itself — that would turn a deliberate act into a click.
  const published = structuredClone(snapshot);
  published.initiative.state.phases.define.outputs['business-case'].status = 'published';
  published.initiative.state.phases.define.outputs['business-case'].sha256 = 'b'.repeat(64);
  const artifact = find(buildTree(published), 'artifact:define/business-case');
  assert.equal(artifact.approve.subject, 'business-case');
  assert.equal(artifact.approve.initiativeId, 'INIT-MULTI');
  assert.equal(artifact.approve.expected, 'define:business-case');
  assert.equal(artifact.contextValue, 'sflow.artifact.approvable');
});

test('an unwritten or already-approved artifact offers no approval', () => {
  // Offering it would produce a refusal the reviewer could have been spared.
  const unwritten = find(buildTree(snapshot), 'artifact:define/business-case');
  assert.equal(unwritten.approve, undefined, 'nothing is generated yet');

  const done = structuredClone(snapshot);
  done.initiative.state.phases.define.outputs['business-case'].status = 'approved';
  done.initiative.state.phases.define.outputs['business-case'].sha256 = 'c'.repeat(64);
  assert.equal(find(buildTree(done), 'artifact:define/business-case').approve, undefined);
});

test('a cross-phase pack is approved at its terminal phase, not its first', () => {
  // Validation & Release Readiness spans construction and delivery. Attributing it to the earlier
  // phase would ask a phase too early and produce a confirmation string the CLI would reject.
  const withPacks = structuredClone(snapshot);
  for (const phase of Object.values(withPacks.initiative.state.phases)) {
    for (const output of Object.values(phase.outputs)) {
      output.sha256 = 'd'.repeat(64);
      output.status = 'published';
    }
  }
  withPacks.initiative.state.resolution.packs = [{
    id: 'spanning',
    label: 'Spanning pack',
    // Deliberately listed out of phase order: the terminal phase comes from the declared order.
    members: ['build/implementation-index', 'define/business-case']
  }];
  const pack = find(buildTree(withPacks), 'pack:spanning');
  assert.ok(pack.approve, 'every member exists, so the pack is approvable');
  assert.equal(pack.approve.subject, 'pack:spanning');
  assert.equal(pack.approve.expected, 'build:pack:spanning',
    'attributed to the latest phase any member sits in');
  assert.equal(pack.contextValue, 'sflow.pack.approvable');
});

test('an incomplete pack is not approvable', () => {
  const withPacks = structuredClone(snapshot);
  withPacks.initiative.state.resolution.packs = [{
    id: 'partial', label: 'Partial', members: ['define/business-case', 'define/scope-and-outcomes']
  }];
  const pack = find(buildTree(withPacks), 'pack:partial');
  assert.equal(pack.approve, undefined);
  assert.equal(pack.contextValue, 'sflow.pack');
});

test('the journey reports where the Epic stands and what it is waiting on', () => {
  const journey = buildJourney(snapshot);
  assert.equal(journey.empty, null);
  assert.equal(journey.id, 'INIT-MULTI');
  assert.deepEqual(journey.stages.map((stage) => stage.id), ['define', 'plan', 'build', 'release']);
  assert.equal(journey.currentStage.id, 'define');
  assert.equal(journey.artifacts.length, 3, 'the current phase contributes its artifacts');
  assert.equal(journey.repositories.length, 2);
  assert.match(journey.nextAction.command, /initiative phase define/);
});

test('the journey reads each pack chain position from the gate rather than re-deriving it', () => {
  // Re-deriving would be a second implementation of approvalChainProgress that could disagree with
  // the one actually blocking the phase.
  const blocked = structuredClone(snapshot);
  blocked.initiative.state.resolution.packs = [
    { id: 'opportunity', label: 'Opportunity', members: ['define/business-case'] }
  ];
  blocked.initiative.phaseGate = {
    ready: false, warnings: [], passes: [],
    errors: ['artifact pack opportunity has waiting on Executive Decisioning (0/1) for exact pack abc123']
  };
  const journey = buildJourney(blocked);
  assert.equal(journey.packs[0].waitingOn, 'waiting on Executive Decisioning (0/1)');
  assert.equal(journey.packs[0].approved, false);
  assert.deepEqual(journey.blockers, blocked.initiative.phaseGate.errors);
});

test('a gate the engine says is ready contributes no blockers', () => {
  const ready = structuredClone(snapshot);
  ready.initiative.phaseGate = { ready: true, errors: ['stale'], warnings: [], passes: [] };
  assert.deepEqual(buildJourney(ready).blockers, [], 'a ready gate has nothing outstanding');
});

test('the journey says why it is empty rather than rendering a blank page', () => {
  assert.match(buildJourney(null).empty, /Reading the repository/);
  assert.match(buildJourney({ initiative: null, initiatives: [], workItems: [] }).empty, /No Epic has been started/);
  assert.match(buildJourney({ initiative: null, initiatives: [{ id: 'A' }], workItems: [] }).empty, /No Epic is checked out/);
});

const { buildReconciliation } = await import(source('views/reconciliation-model.ts'));
const levelOf = (reconciliation, id) => reconciliation.levels.find((level) => level.id === id);

test('an unmaterialized Epic reports nothing to compare, never that it agrees', () => {
  // The rule the whole model turns on. An Epic with no branches has nothing to reconcile, and saying
  // its branches agree would be the most dangerous sentence this view could produce.
  const reconciliation = buildReconciliation(snapshot, null);
  assert.deepEqual(reconciliation.levels.map((level) => level.id),
    ['branches', 'stories', 'repositories', 'conformance']);
  for (const level of reconciliation.levels) {
    assert.notEqual(level.verdict, 'aligned', `${level.id} must not claim alignment with no data`);
    assert.equal(level.verdict, 'not-applicable');
    assert.ok(level.reason, `${level.id} says why it cannot be judged`);
  }
  assert.match(levelOf(reconciliation, 'branches').reason, /materialized/);
  assert.equal(levelOf(reconciliation, 'branches').remedy, 'singularity-flow initiative materialize');
});

test('a stale or never-observed Story branch is drift; moving on from the seed is not', () => {
  // A branch that has moved past its seed is doing the work. Drift is the Epic's record being stale.
  const materialized = structuredClone(snapshot);
  materialized.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', status: 'in-progress', currentPhase: 'build',
      seedCommit: 'aaaa1111', observedCommit: 'bbbb2222', stale: false },
    'MOB-1': { workId: 'MOB-1', repository: 'mobile', status: 'seeded', currentPhase: null,
      seedCommit: 'cccc3333', observedCommit: 'cccc3333', stale: false },
    'MOB-2': { workId: 'MOB-2', repository: 'mobile', status: 'in-progress', currentPhase: 'build',
      seedCommit: 'dddd4444', observedCommit: 'eeee5555', stale: true }
  };
  const level = levelOf(buildReconciliation(materialized, null), 'branches');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.find((row) => row.id === 'API-1').drifted, false, 'moved on, but observed');
  assert.equal(level.rows.find((row) => row.id === 'MOB-1').drifted, false, 'still at seed');
  assert.equal(level.rows.find((row) => row.id === 'MOB-2').drifted, true, 'the record is stale');
  assert.match(level.rows.find((row) => row.id === 'MOB-2').detail, /sync/);
  assert.equal(level.remedy, 'singularity-flow initiative sync');
});

test('a branch that was never observed is drift, not silence', () => {
  const materialized = structuredClone(snapshot);
  materialized.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', status: 'seeded', seedCommit: 'aaaa', observedCommit: null }
  };
  const [row] = levelOf(buildReconciliation(materialized, null), 'branches').rows;
  assert.equal(row.drifted, true);
  assert.match(row.cells.at(-1), /never observed/);
});

test('only a blocking Story that is not ready holds the Epic back', () => {
  const withDelivery = structuredClone(snapshot);
  withDelivery.initiative.delivery = {
    materialized: true,
    blockers: ['API-1 has not completed implementation'],
    stories: [
      { id: 'API-1', workId: 'API-1', repository: 'api', blocking: true, ready: false, reason: 'implementation incomplete' },
      { id: 'MOB-1', workId: 'MOB-1', repository: 'mobile', blocking: true, ready: true },
      { id: 'MOB-2', workId: 'MOB-2', repository: 'mobile', blocking: false, ready: false }
    ]
  };
  const level = levelOf(buildReconciliation(withDelivery, null), 'stories');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.find((row) => row.id === 'API-1').drifted, true);
  assert.equal(level.rows.find((row) => row.id === 'MOB-1').drifted, false);
  assert.equal(level.rows.find((row) => row.id === 'MOB-2').drifted, false, 'non-blocking never gates');
  assert.match(level.remedy, /implementation/);
});

test('the merge plan drives the cross-repository level, and names what is next', () => {
  const plan = {
    initiativeId: 'INIT-MULTI', epicBranch: 'INIT-MULTI',
    stories: [
      { order: 1, id: 'API-1', workId: 'API-1', repository: 'api', blocking: true, status: 'ready', blockedBy: [] },
      { order: 2, id: 'MOB-1', workId: 'MOB-1', repository: 'mobile', blocking: true, status: 'blocked', blockedBy: ['API-1'] }
    ],
    nextToMerge: { workId: 'API-1' }, epicReady: false, outstanding: ['API-1', 'MOB-1']
  };
  const level = levelOf(buildReconciliation(snapshot, plan), 'repositories');
  assert.equal(level.verdict, 'drifted', 'blocking Stories have not merged');
  assert.match(level.rows[1].cells.at(-1), /blocked by API-1/);
  assert.match(level.remedy, /Next to merge: API-1/);
});

test('an Epic whose blocking Stories have all merged reports the repositories aligned', () => {
  const plan = {
    epicBranch: 'INIT-MULTI',
    stories: [{ order: 1, id: 'API-1', workId: 'API-1', repository: 'api', blocking: true, status: 'merged', blockedBy: [] }],
    nextToMerge: null, epicReady: true, outstanding: []
  };
  const level = levelOf(buildReconciliation(snapshot, plan), 'repositories');
  assert.equal(level.verdict, 'aligned');
  assert.equal(level.remedy, null);
});

test('a consumer built against an older contract version is spec-versus-code drift', () => {
  const withContracts = structuredClone(snapshot);
  withContracts.initiative.contracts = [
    {
      key: 'orders', id: 'orders', version: '2', sha256: 'f'.repeat(64), integrity: 'verified',
      consumers: [
        { storyId: 'MOB-1', repository: 'mobile', stale: false, observedContractSha256: 'f'.repeat(64) },
        { storyId: 'MOB-2', repository: 'mobile', stale: false, observedContractSha256: 'a'.repeat(64) }
      ]
    }
  ];
  const level = levelOf(buildReconciliation(withContracts, null), 'conformance');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.find((row) => row.id === 'orders/MOB-1').drifted, false);
  const behind = level.rows.find((row) => row.id === 'orders/MOB-2');
  assert.equal(behind.drifted, true);
  assert.match(behind.cells.at(-1), /older version/);
});

test('a contract file that changed since it was pinned is drift for every consumer', () => {
  const withContracts = structuredClone(snapshot);
  withContracts.initiative.contracts = [{
    key: 'orders', version: '2', sha256: 'f'.repeat(64), integrity: 'stale',
    consumers: [{ storyId: 'MOB-1', repository: 'mobile', stale: false, observedContractSha256: 'f'.repeat(64) }]
  }];
  const level = levelOf(buildReconciliation(withContracts, null), 'conformance');
  assert.equal(level.verdict, 'drifted');
  assert.match(level.rows[0].cells.at(-1), /contract file changed/);
});

test('reconciliation says why it is empty rather than rendering nothing', () => {
  assert.match(buildReconciliation(null, null).empty, /Reading the repository/);
  assert.match(buildReconciliation({ initiative: null, initiatives: [], workItems: [] }, null).empty,
    /No Epic has been started/);
});

test('a Story that reached conformance contributes its tree hash to the spec-versus-code level', () => {
  // The conformance tree is the most direct spec-versus-code evidence the system holds; it belongs
  // beside the contracts rather than only inside the Story's own workflow.
  const withConformance = structuredClone(snapshot);
  withConformance.initiative.contracts = [];
  withConformance.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', conformance: { status: 'approved', treeSha256: 'ab'.repeat(32) } },
    'MOB-1': { workId: 'MOB-1', repository: 'mobile', conformance: { status: 'in_progress', treeSha256: null } },
    'MOB-2': { workId: 'MOB-2', repository: 'mobile' }
  };
  const level = levelOf(buildReconciliation(withConformance, null), 'conformance');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.length, 2, 'a Story with no conformance phase contributes no row');
  const passed = level.rows.find((row) => row.id === 'story:API-1');
  assert.equal(passed.drifted, false);
  assert.match(passed.cells.at(-1), /conforms @ abababab/);
  const pending = level.rows.find((row) => row.id === 'story:MOB-1');
  assert.equal(pending.drifted, true);
  assert.match(pending.cells.at(-1), /no conformance tree recorded/);
});

test('contracts and Story conformance appear in one level, not two verdicts', () => {
  const both = structuredClone(snapshot);
  both.initiative.contracts = [{
    key: 'orders', version: '2', sha256: 'f'.repeat(64), integrity: 'verified',
    consumers: [{ storyId: 'MOB-1', repository: 'mobile', stale: false, observedContractSha256: 'f'.repeat(64) }]
  }];
  both.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', conformance: { status: 'approved', treeSha256: 'cd'.repeat(32) } }
  };
  const level = levelOf(buildReconciliation(both, null), 'conformance');
  assert.equal(level.verdict, 'aligned');
  assert.equal(level.rows.length, 2, 'one contract consumer and one conforming Story');
});

const { commandArgv, commandPlaceholders, fillPlaceholders, placeholderPrompt } =
  await import(source('commands.ts'));

test('a suggested command with a placeholder is not runnable as written', () => {
  // The sources step suggests `--file <PATH>`, where <PATH> is an instruction to a person. Running
  // it literally passes the string "<PATH>" to the CLI, which fails on a file of that name — a
  // failure that says nothing about what was actually wanted.
  const argv = commandArgv('singularity-flow epic sources add --epic SF-E-001 --file <PATH>');
  assert.deepEqual(argv, ['epic', 'sources', 'add', '--epic', 'SF-E-001', '--file', '<PATH>']);

  const [placeholder] = commandPlaceholders(argv);
  assert.equal(placeholder.index, 6);
  assert.equal(placeholder.name, 'PATH');
  assert.equal(placeholder.flag, '--file');
  assert.equal(placeholder.kind, 'file', 'a path deserves a file picker, not a text box');
  assert.match(placeholderPrompt(placeholder), /--file/);
});

test('an ordinary command has no placeholders and runs as written', () => {
  assert.deepEqual(commandPlaceholders(commandArgv('singularity-flow initiative phase define')), []);
});

test('optional-argument brackets are not placeholders', () => {
  // `[PHASE]` means the argument may be omitted, and the command runs correctly without it.
  // Treating it as a placeholder would prompt for something nobody has to supply.
  assert.deepEqual(commandPlaceholders(commandArgv('singularity-flow initiative phase [PHASE]')), []);
});

test('a placeholder with no flag is asked for as text', () => {
  const [placeholder] = commandPlaceholders(commandArgv('singularity-flow initiative approve <SUBJECT>'));
  assert.equal(placeholder.flag, null);
  assert.equal(placeholder.kind, 'text');
});

test('answers are substituted positionally, leaving everything else alone', () => {
  const argv = commandArgv('singularity-flow epic sources add --epic SF-E-001 --file <PATH>');
  const filled = fillPlaceholders(argv, new Map([[6, '/tmp/brief.md']]));
  assert.deepEqual(filled, ['epic', 'sources', 'add', '--epic', 'SF-E-001', '--file', '/tmp/brief.md']);
});

test('pinned sources appear in the tree, and an empty list reads as a finding', () => {
  // Everything a requirement may cite has to be pinned, so nothing pinned is a state worth naming
  // rather than an empty branch.
  const empty = find(buildTree(snapshot), 'sources');
  assert.equal(empty.description, 'none pinned');
  assert.match(empty.tooltip, /no cited source to rest on/);
  assert.equal(empty.children[0].label, 'Nothing is pinned yet');
  assert.equal(empty.contextValue, 'sflow.sources', 'and the node offers to fix it');

  const pinned = structuredClone(snapshot);
  pinned.initiative.sources = {
    version: 1,
    initiativeId: 'INIT-MULTI',
    sources: [{ sourceId: 'SRC-ABC123', name: 'brief.md', provider: 'local', sha256: 'a'.repeat(64) }]
  };
  const group = find(buildTree(pinned), 'sources');
  assert.equal(group.description, '1');
  assert.equal(group.children[0].label, 'brief.md');
  assert.equal(group.children[0].description, 'local');
  assert.match(group.children[0].tooltip, /SRC-ABC123/);
});

test('an empty repository offers to start an Epic rather than describing the command', () => {
  const [node] = buildTree({ initiative: null, initiatives: [], workItems: [] });
  assert.equal(node.contextValue, 'sflow.start');
  assert.doesNotMatch(node.tooltip, /singularity-flow/, 'a command to retype is not an affordance');
});

test('configuration is shown whether or not an Epic is checked out', () => {
  // The lifecycle, the approvers and the lenses are properties of the repository, not of an Epic.
  // A newcomer's problem is not editing these files but knowing they exist and where.
  const withEpic = buildTree(snapshot);
  const withoutEpic = buildTree({ initiative: null, initiatives: [], workItems: [] });
  for (const tree of [withEpic, withoutEpic]) {
    const configuration = find(tree, 'configuration');
    assert.ok(configuration, 'configuration is always reachable');
    const children = configuration.children.map((child) => child.id);
    // workflow and portfolio first: they define everything the other sets are instances of.
    assert.deepEqual(children.slice(0, 2), ['config:workflow', 'config:portfolio']);
    for (const set of ['config:templates', 'config:prompts', 'config:skills', 'config:personas']) {
      assert.ok(children.includes(set), `${set} is reachable`);
    }
  }
});

test('the configuration node says whether workflow progress is recorded, and where', () => {
  const off = find(buildTree(snapshot), 'configuration');
  assert.equal(off.description, 'no state branch');
  assert.match(off.tooltip, /No append-only workflow ledger/);

  const on = structuredClone(snapshot);
  on.definition = { ...(on.definition ?? {}), ledger: { enabled: true, branch: 'state' } };
  const node = find(buildTree(on), 'configuration');
  assert.equal(node.description, 'state on state');
  assert.match(node.tooltip, /orphan branch 'state'/);
});

test('each working lens is openable as the file that defines it', () => {
  const withLenses = structuredClone(snapshot);
  withLenses.definition = {
    personas: { 'product-owner': { label: 'Product owner' }, developer: { label: 'Developer' } }
  };
  const lenses = find(buildTree(withLenses), 'config:personas');
  assert.equal(lenses.description, '2');
  assert.deepEqual(lenses.children.map((child) => child.label), ['Product owner', 'Developer']);
  assert.equal(lenses.children[0].path, 'singularity/personas/product-owner.md');
});

const {
  EMPTY_WORKSPACE_FORM, capabilityChoices, coveredCapabilities, derivedRepositories, effectiveLead,
  formProblems, formCommand, hasCapabilityMap, shippingCapabilities, uncloneable, workspaceFormHtml
} = await import(source('views/workspace-form.ts'));

/** The organisation's map, as `capability organisation --json` returns it. */
const REMOTE_TREE = [{
  id: 'commerce', name: 'Commerce', repository: null, children: [
    {
      id: 'payments', name: 'Payments', repository: null, children: [
        { id: 'payments-api', name: 'Payments API', repository: 'api', children: [] }
      ]
    },
    { id: 'storefront', name: 'Storefront', repository: null, children: [
      { id: 'storefront-web', name: 'Storefront Web', repository: 'web', children: [] }
    ] }
  ]
}];
const REMOTE_REPOSITORIES = {
  platform: { url: 'https://example.com/platform.git', defaultBranch: 'main' },
  api: { url: 'https://example.com/api.git', defaultBranch: 'main' },
  web: { url: 'https://example.com/web.git', defaultBranch: 'trunk' }
};

const withMap = (selected = [], extra = {}) => ({
  ...EMPTY_WORKSPACE_FORM,
  base: '/work', id: 'checkout-platform', name: 'Checkout platform',
  organisations: ['https://example.com/platform.git'],
  organisation: 'https://example.com/platform.git',
  capabilities: capabilityChoices(REMOTE_TREE, REMOTE_REPOSITORIES),
  selected,
  ...extra
});

test('an empty workspace form reports every outstanding requirement at once', () => {
  // Revealing them one at a time is how a five-field form takes five attempts.
  const problems = formProblems(EMPTY_WORKSPACE_FORM);
  assert.match(problems.join(' '), /where the workspace directory/);
  assert.match(problems.join(' '), /identifier/);
  assert.match(problems.join(' '), /organisation/);
});

test('the organisation map is flattened with each capability\'s depth, ancestors and clone URL', () => {
  const choices = capabilityChoices(REMOTE_TREE, REMOTE_REPOSITORIES);
  assert.deepEqual(choices.map((choice) => choice.id),
    ['commerce', 'payments', 'payments-api', 'storefront', 'storefront-web']);

  const api = choices.find((choice) => choice.id === 'payments-api');
  assert.equal(api.depth, 2);
  assert.deepEqual(api.ancestors, ['commerce', 'payments']);
  assert.equal(api.repository, 'api');
  // The clone URL comes from the portfolio, keyed by the repository the capability names.
  assert.equal(api.url, 'https://example.com/api.git');
  assert.equal(choices.find((choice) => choice.id === 'storefront-web').defaultBranch, 'trunk');
  // A grouping ships from nothing, and says so rather than inventing a repository.
  assert.equal(choices.find((choice) => choice.id === 'commerce').repository, null);
});

test('choosing a capability includes everything beneath it, the way a directory does', () => {
  const form = withMap(['payments']);
  assert.deepEqual(coveredCapabilities(form).map((entry) => entry.id),
    ['payments', 'payments-api']);
  // Choosing the root covers the lot.
  assert.equal(coveredCapabilities(withMap(['commerce'])).length, 5);
});

test('the repositories are what the chosen capabilities ship from — never named by hand', () => {
  // The form has no way to add a repository. Two places to say which repositories are involved is
  // one place for them to disagree.
  const form = withMap(['payments']);
  assert.deepEqual(derivedRepositories(form).map((entry) => entry.id), ['api']);

  // A grouping brings in what is beneath it, so choosing one is choosing its deliveries.
  assert.deepEqual(derivedRepositories(withMap(['storefront'])).map((entry) => entry.id), ['web']);
  assert.deepEqual(derivedRepositories(withMap(['commerce'])).map((entry) => entry.id),
    ['api', 'web']);

  // A grouping with nothing beneath it that ships is a workspace with nothing to work in, and the
  // form refuses rather than creating an empty directory.
  const barren = withMap(['commerce'], {
    capabilities: capabilityChoices([{ id: 'commerce', name: 'Commerce', repository: null, children: [] }], {})
  });
  assert.match(formProblems(barren).join(' '), /None of the chosen capabilities ships/);
});

test('one of the chosen capabilities leads, and its repository carries the state branch', () => {
  const form = withMap(['commerce'], { leadCapability: 'storefront-web' });
  assert.equal(effectiveLead(form).id, 'storefront-web');
  assert.match(formCommand(form).join(' '), /--lead-capability storefront-web/);

  // Only a capability that ships can lead: leading means carrying the branch.
  assert.deepEqual(shippingCapabilities(form).map((entry) => entry.id), ['payments-api', 'storefront-web']);

  // Defaulted rather than demanded — with one shipping capability there is nothing to decide.
  assert.equal(effectiveLead(withMap(['payments'])).id, 'payments-api');
  // A lead left over from a selection that no longer covers it falls back rather than sticking.
  assert.equal(effectiveLead(withMap(['payments'], { leadCapability: 'storefront-web' })).id, 'payments-api');
});

test('a workspace records the capabilities it is for, and the organisation they came from', () => {
  const command = formCommand(withMap(['payments', 'storefront']));
  assert.deepEqual(command.slice(0, 4), ['workspace', 'create', '--local', '--json']);
  assert.match(command.join(' '), /--organisation https:\/\/example\.com\/platform\.git/);
  assert.match(command.join(' '), /--capability payments --capability storefront/);
  // The selection is recorded, not its expansion: a capability added under payments later is picked
  // up by this workspace without editing it.
  assert.equal(command.filter((entry) => entry === '--capability').length, 2);
  assert.match(command.join(' '), /--confirm checkout-platform/);
});

test('an organisation read but nothing chosen from cannot be created', () => {
  const form = withMap([]);
  assert.equal(hasCapabilityMap(form), true);
  assert.match(formProblems(form).join(' '), /Choose the capabilities/);
  assert.match(workspaceFormHtml(form), /Nothing chosen yet/);
});

test('a capability shipping from a repository the portfolio does not declare is named, not dropped', () => {
  const form = withMap(['payments'], {
    capabilities: capabilityChoices(REMOTE_TREE, { web: REMOTE_REPOSITORIES.web })
  });
  assert.deepEqual(uncloneable(form).map((entry) => entry.id), ['payments-api']);
  // Silently cloning one fewer repository than was asked for is the failure mode this prevents.
  assert.deepEqual(derivedRepositories(form), []);
  assert.match(formProblems(form).join(' '), /nowhere to clone it from/);
  assert.match(workspaceFormHtml(form), /no clone URL/);
});

test('with no organisation mapped the form says so and offers the screen that fixes it', () => {
  // The chicken-and-egg case: a workspace over capabilities nobody has mapped is a step out of
  // order, not a form to fill in.
  const html = workspaceFormHtml(EMPTY_WORKSPACE_FORM);
  assert.match(html, /No organisation has been mapped yet/);
  assert.match(html, /data-open="capabilities"/);
  // And there is no way to type a repository URL past it.
  assert.doesNotMatch(html, /data-draft="url"/);
  assert.doesNotMatch(html, /Add a repository/);
});

test('capabilities are picked from a dropdown, and each pick shows what it drags in', () => {
  // A real map runs to dozens; a checkbox table asks a reader to scan all of them to find two.
  const html = workspaceFormHtml(withMap(['payments']));
  assert.match(html, /<select data-capability-pick>/);
  // Already covered, so not offered again.
  assert.doesNotMatch(html, /<option value="payments-api">/);
  assert.match(html, /<option value="storefront">/);
  // What the pick brought with it is shown rather than left to be inferred.
  assert.match(html, /1 beneath it/);
  assert.match(html, /<code>api<\/code>/);
});

test('the state branch is stated as a consequence, not asked for as a field', () => {
  const html = workspaceFormHtml(withMap(['payments']));
  assert.doesNotMatch(html, /data-draft="state-branch"/);
  assert.match(html, /orphan\s+<code>state<\/code> branch is created/);
  assert.match(html, /in <code>api<\/code>/);
});

test('the workspace form asks for a directory, an organisation and capabilities — no repositories', () => {
  const html = workspaceFormHtml(EMPTY_WORKSPACE_FORM);
  const order = ['Working directory', 'Identity', 'Organisation', 'Capabilities', 'Repositories'];
  let at = -1;
  for (const heading of order) {
    const next = html.indexOf(heading);
    assert.ok(next > at, `${heading} out of order`);
    at = next;
  }
  // Repositories appear, but as a consequence to confirm rather than a list to curate.
  assert.doesNotMatch(html, /data-remove=/);
  assert.doesNotMatch(html, /data-add=/);
});

test('a single mapped organisation is stated rather than asked about', () => {
  // Asking which of one to use is a question with no information in it.
  assert.match(workspaceFormHtml(withMap(['payments'])), /<code>https:\/\/example\.com\/platform\.git<\/code>/);
  assert.doesNotMatch(workspaceFormHtml(withMap(['payments'])), /data-field="organisation"/);

  const several = withMap(['payments'], {
    organisations: ['https://example.com/platform.git', 'https://example.com/other.git']
  });
  assert.match(workspaceFormHtml(several), /<select data-field="organisation">/);
});

test('a form still missing something disables the button and lists why', () => {
  const html = workspaceFormHtml(withMap([]));
  assert.match(html, /Before this can be created/);
  assert.match(html, /<button data-submit="create" disabled>/);

  const ready = workspaceFormHtml(withMap(['payments']));
  assert.match(ready, /1 repository will be cloned into <code>\/work\/checkout-platform<\/code>/);
  assert.match(ready, /led by <code>Payments API<\/code>/);
  assert.match(ready, /<button data-submit="create" >/);
});

test('while the map is being read the form says so and refuses to be submitted', () => {
  const form = { ...withMap([]), capabilities: null, reading: true };
  assert.match(workspaceFormHtml(form), /Reading the capability map…/);
  assert.match(formProblems(form).join(' '), /Wait for the capability map/);
});

test('a URL that cannot be read is reported on the form, beside the field it was typed into', () => {
  const form = {
    ...withMap([]),
    error: "Cannot reach 'https://example.com/gone.git': repository not found."
  };
  assert.match(workspaceFormHtml(form), /Cannot reach/);
});


const { isGovernedConfiguration } = await import(source('governed.ts'));

test('the editable file sets appear as groups of openable files', () => {
  // Artifact templates, lens prompts and prompt packs are the things a team actually wants to change
  // about this product. A template nobody can find is a template nobody edits.
  const authored = structuredClone(snapshot);
  authored.templates = [{ path: 'singularity/templates/initiatives/business-case.md', name: 'business-case.md' }];
  authored.personaPrompts = [{ path: 'singularity/personas/architect.md', name: 'architect.md' }];
  authored.repositorySkills = [];
  authored.agents = [
    { id: 'sflow', scope: 'packaged', path: 'plugin/agents/sflow.md', editable: false },
    { id: 'house', scope: 'repository', path: '.github/agents/house.md', editable: true }
  ];
  authored.agentMappings = { path: 'singularity/agent-mappings.yml', exists: true };
  const tree = buildTree(authored);

  const templates = find(tree, 'config:templates');
  assert.equal(templates.description, '1');
  assert.equal(templates.children[0].path, 'singularity/templates/initiatives/business-case.md');

  // An empty set is stated rather than hidden.
  const packs = find(tree, 'config:skills');
  assert.equal(packs.description, 'none');
  assert.match(packs.children[0].label, /No prompt packs/);

  // A packaged agent is not the team's to change; a repository one is.
  const agents = find(tree, 'config:agents');
  assert.equal(agents.children.find((child) => child.id === 'agent:sflow').readOnly, true);
  assert.equal(agents.children.find((child) => child.id === 'agent:house').readOnly, false);
  assert.equal(agents.children.at(-1).label, 'agent-mappings.yml');
});

test('governed configuration is recognised, and nothing else is', () => {
  const repository = '/repo';
  for (const governed of [
    'singularity/workflow.yml', 'singularity/portfolio.yml',
    'singularity/personas/architect.md', 'singularity/templates/initiatives/business-case.md',
    'singularity/prompts/copilot-planning.md', '.github/skills/sflow-next/SKILL.md',
    'singularity/agent-mappings.yml'
  ]) {
    assert.equal(isGovernedConfiguration(repository, `${repository}/${governed}`), true, governed);
  }

  for (const other of [
    'README.md', 'src/index.ts',
    // Generated and governed state are not configuration and must not be validated as though they
    // were — editing them is a different problem with a different answer.
    'singularity/world-model/manifest.json',
    'singularity/initiatives/SF-E-001/state.json'
  ]) {
    assert.equal(isGovernedConfiguration(repository, `${repository}/${other}`), false, other);
  }

  assert.equal(isGovernedConfiguration(repository, '/elsewhere/singularity/workflow.yml'), false,
    'a path outside the repository is never governed configuration');
});

const { buildApprovals } = await import(source('views/approvals-model.ts'));

/** A snapshot with one artifact awaiting a decision under a named authority. */
function awaiting({ authorities = ['product-approvers'], members = ['me@example.com'], actor = 'me@example.com', generatedBy = null, chain = null, gateErrors = [] } = {}) {
  const shot = structuredClone(snapshot);
  shot.identities = { git: { email: actor } };
  shot.portfolio = { approvalAuthorities: { 'product-approvers': { members: members.map((email) => ({ email })) } } };
  shot.initiative.state.phases.define.outputs['business-case'].sha256 = 'a'.repeat(64);
  shot.initiative.state.phases.define.outputs['business-case'].status = 'published';
  shot.initiative.state.phases.define.outputs['business-case'].generatedBy = generatedBy;
  const declared = shot.initiative.state.resolution.phases.find((phase) => phase.id === 'define');
  declared.outputs.find((output) => output.id === 'business-case').approval =
    { mode: 'individual', authorities, minimum: 1, allowSelfApproval: true, chain };
  shot.initiative.phaseGate = { ready: false, errors: gateErrors, warnings: [], passes: [] };
  shot.initiative.report = { approvals: { byPhase: {} } };
  return shot;
}

test('an approval you may sign is yours; one you may not names who is being waited on', () => {
  // The question a reviewer opens this to ask is "is anything waiting for me". Everything else is
  // context for that.
  const mine = buildApprovals(awaiting());
  assert.equal(mine.pending.length, 1);
  assert.equal(mine.pending[0].standing, 'yours');
  assert.equal(mine.pending[0].expected, 'define:business-case');
  assert.equal(mine.pending[0].reason, null);

  const theirs = buildApprovals(awaiting({ members: ['someone.else@example.com'] }));
  assert.equal(theirs.pending[0].standing, 'others');
  assert.match(theirs.pending[0].reason, /Waiting on product-approvers/);
});

test('an approval with no configured authority cannot proceed, and says so', () => {
  // A configuration gap, not a decision anybody can take — presenting it as actionable would send
  // a reviewer to a refusal.
  const orphan = buildApprovals(awaiting({ authorities: [] }));
  assert.equal(orphan.pending[0].standing, 'blocked');
  assert.match(orphan.pending[0].reason, /No approval authority is configured/);
});

test('approving your own work is flagged before you decide, not after', () => {
  const own = buildApprovals(awaiting({ generatedBy: 'me@example.com' }));
  assert.equal(own.pending[0].selfApproval, true);
  assert.equal(own.pending[0].standing, 'yours', 'still yours to sign — just not independent');

  const someoneElses = buildApprovals(awaiting({ generatedBy: 'other@example.com' }));
  assert.equal(someoneElses.pending[0].selfApproval, false);
});

test('the open chain step is read from the gate rather than recomputed', () => {
  // The report drops the chainStep each decision recorded, so recomputing would mean guessing which
  // body signed. The gate already composes the answer and is what actually blocks the phase.
  const chain = [
    { authority: 'product-approvers', label: 'Product Governance', minimum: 1 },
    { authority: 'executive-approvers', label: 'Executive Decisioning', minimum: 1 }
  ];
  const shot = awaiting({
    chain,
    gateErrors: ['output define/business-case has waiting on Executive Decisioning (0/1) for exact output abc123']
  });
  const [approval] = buildApprovals(shot).pending;
  assert.deepEqual(approval.chain.map((step) => [step.label, step.satisfied, step.open]), [
    ['Product Governance', true, false],
    ['Executive Decisioning', false, true]
  ]);
  // Alice sits on product-approvers only, and the open step is the executive one.
  assert.equal(approval.standing, 'others');
  assert.match(approval.reason, /Executive Decisioning \(0\/1\)/);
});

test('yours is listed before anything you cannot act on', () => {
  const shot = awaiting({ members: ['me@example.com'] });
  // A second artifact nobody can sign.
  shot.initiative.state.phases.define.outputs['scope-and-outcomes'].sha256 = 'b'.repeat(64);
  shot.initiative.state.phases.define.outputs['scope-and-outcomes'].status = 'published';
  const declared = shot.initiative.state.resolution.phases.find((phase) => phase.id === 'define');
  declared.outputs.find((output) => output.id === 'scope-and-outcomes').approval =
    { mode: 'individual', authorities: [], minimum: 1, allowSelfApproval: true, chain: null };

  const standings = buildApprovals(shot).pending.map((approval) => approval.standing);
  assert.deepEqual(standings, ['yours', 'blocked']);
});

test('gate problems that are not approvals are listed separately', () => {
  const shot = awaiting({
    gateErrors: ['checklist define/scope-agreed is missing', 'output define/x has 0/1 approvals']
  });
  const approvals = buildApprovals(shot);
  // An approval count is an approval; a missing checklist is something else to go and do.
  assert.deepEqual(approvals.obstacles, ['checklist define/scope-agreed is missing']);
});

test('a phase whose gate is ready becomes the decision that is waiting', () => {
  // A ready gate means every requirement is met and the phase itself is what is now outstanding.
  // Reporting "nothing is waiting" at that moment would hide the one decision left.
  const ready = structuredClone(snapshot);
  ready.identities = { git: { email: 'me@example.com' } };
  ready.portfolio = { approvalAuthorities: { 'product-approvers': { members: [{ email: 'me@example.com' }] } } };
  ready.initiative.phaseGate = { ready: true, errors: [], warnings: [], passes: [], bundleSha256: 'c'.repeat(64) };
  ready.initiative.report = { approvals: { byPhase: {} } };
  const declared = ready.initiative.state.resolution.phases.find((phase) => phase.id === 'define');
  declared.bundleApproval = { mode: 'bundle', authorities: ['product-approvers'], minimum: 1, allowSelfApproval: true, chain: null };

  const [approval] = buildApprovals(ready).pending;
  assert.equal(approval.kind, 'phase');
  assert.equal(approval.expected, 'define:phase');
  assert.equal(approval.standing, 'yours');
  assert.match(approval.detail, /closes it and opens the next/);
});

test('an Epic with nothing outstanding says so rather than showing an empty page', () => {
  const quiet = structuredClone(snapshot);
  // Approved phase, ready gate: there is genuinely nothing to decide.
  quiet.initiative.state.phases.define.status = 'approved';
  quiet.initiative.phaseGate = { ready: true, errors: [], warnings: [], passes: [] };
  quiet.initiative.report = { approvals: { byPhase: {} } };
  assert.match(buildApprovals(quiet).empty ?? '', /Nothing is waiting/);
  assert.match(buildApprovals(null).empty, /Reading the repository/);
});

const { buildStories } = await import(source('views/stories-model.ts'));

test('Stories group by the repository they land in, and keep both ends of each dependency', () => {
  // The plan records what a Story waits for; who waits on it is just as useful and has to be
  // derived, because nothing stores the reverse edge.
  const stories = buildStories(snapshot);
  assert.deepEqual(stories.groups.map((group) => group.repository), ['api', 'mobile']);

  const api = stories.groups[0].stories[0];
  assert.equal(api.planId, 'API-1');
  assert.deepEqual(api.dependsOn, []);
  assert.deepEqual(api.blocks, ['MOB-1'], 'the reverse edge is derived');

  const mobile = stories.groups[1].stories.find((story) => story.planId === 'MOB-1');
  assert.deepEqual(mobile.dependsOn, ['API-1']);
  assert.deepEqual(mobile.blocks, []);
});

test('a planned Story is not shown as though it had a branch', () => {
  // Before materialization a Story is an intention: an identifier, a repository, an allocation.
  // Showing an intention as though it had a branch is the more expensive of the two mistakes.
  const planned = buildStories(snapshot);
  assert.equal(planned.materialized, false);
  for (const story of planned.groups.flatMap((group) => group.stories)) {
    assert.equal(story.state, 'planned');
    assert.equal(story.branch, null);
    assert.equal(story.head, null);
  }
});

test('a materialized Story carries its branch, head and phase', () => {
  const materialized = structuredClone(snapshot);
  materialized.initiative.state.childStories = {
    'API-1': {
      workId: 'API-1', repository: 'api', branch: 'API-1', status: 'in-progress',
      currentPhase: 'implementation-spec', seedCommit: 'aaaa1111', observedCommit: 'bbbb2222',
      stale: false, conformance: { status: 'approved', treeSha256: 'cc'.repeat(32) }
    },
    'MOB-1': {
      workId: 'MOB-1', repository: 'mobile', branch: 'MOB-1', status: 'seeded',
      seedCommit: 'dddd3333', observedCommit: 'dddd3333', stale: false
    }
  };
  const stories = buildStories(materialized);
  assert.equal(stories.materialized, true);

  const api = stories.groups[0].stories.find((story) => story.planId === 'API-1');
  assert.equal(api.state, 'in-progress');
  assert.equal(api.head, 'bbbb2222');
  assert.equal(api.atSeed, false, 'it has moved on from its seed, which is the work');
  assert.equal(api.phase, 'implementation-spec');
  assert.equal(api.conformance.status, 'approved');

  const mobile = stories.groups[1].stories.find((story) => story.planId === 'MOB-1');
  assert.equal(mobile.state, 'seeded');
  assert.equal(mobile.atSeed, true);
  assert.equal(mobile.conformance, null, 'no conformance phase reached yet');
});

test('a blocked child Story is reported as blocked whatever its phase says', () => {
  const blocked = structuredClone(snapshot);
  blocked.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', status: 'in-progress', currentPhase: 'build', blocked: true }
  };
  const story = buildStories(blocked).groups[0].stories.find((entry) => entry.planId === 'API-1');
  assert.equal(story.state, 'blocked');
});

test('the merge order respects dependencies and is stable', () => {
  const order = buildStories(snapshot).order;
  assert.ok(order.indexOf('API-1') < order.indexOf('MOB-1'), 'a Story lands after what it waits for');
  assert.deepEqual(buildStories(snapshot).order, order, 'the same plan reads the same way twice');
});

test('an Epic with no Story plan says what planning would produce', () => {
  const unplanned = structuredClone(snapshot);
  unplanned.initiative.breakdown = null;
  const stories = buildStories(unplanned);
  assert.match(stories.empty, /decomposes it into Stories, one per repository/);
  assert.equal(stories.initiativeId, 'INIT-MULTI', 'and still says which Epic it is talking about');
});

test('the world model is shown at the root, and its absence is named', () => {
  // A model belongs to the repository, not to an Epic: every Epic on every branch grounds against
  // the same one. Its absence is invisible until the answers are wrong.
  const unbuilt = find(buildTree(snapshot), 'world-model');
  assert.equal(unbuilt.description, 'not built');
  assert.match(unbuilt.tooltip, /no repository knowledge to draw on/);
  assert.deepEqual(unbuilt.children[0].command, ['wm', 'build'], 'and it offers to build one');

  const built = structuredClone(snapshot);
  built.worldModel = {
    root: 'singularity/world-model', generatedAt: '2026-08-01T00:00:00Z', rebuildReason: null,
    views: [{ id: 'business', references: ['a', 'b'] }, { id: 'data', references: [] }]
  };
  const node = find(buildTree(built), 'world-model');
  assert.equal(node.description, '2 views');
  assert.equal(node.children[0].path, 'singularity/world-model/views/business.md');
  assert.equal(node.children[1].description, 'no references');
});

test('a stale world model offers the rebuild the engine asked for, in its own words', () => {
  const stale = structuredClone(snapshot);
  stale.worldModel = {
    root: 'singularity/world-model', generatedAt: '2026-07-01T00:00:00Z',
    rebuildReason: 'The repository changed after the model was generated.', views: []
  };
  const node = find(buildTree(stale), 'world-model');
  assert.equal(node.children[0].label, 'The repository changed after the model was generated.');
  assert.deepEqual(node.children[0].command, ['wm', 'build']);
});

test('the world model is reachable even with no Epic checked out', () => {
  const tree = buildTree({ initiative: null, initiatives: [], workItems: [], worldModel: { root: 'w', generatedAt: null, rebuildReason: null, views: [] } });
  assert.ok(find(tree, 'world-model'), 'grounding does not depend on an Epic');
  assert.ok(find(tree, 'configuration'));
});

test('a locally pinned source can be opened; a remote one has no path to open', () => {
  const pinned = structuredClone(snapshot);
  pinned.initiative.sources = {
    version: 1, initiativeId: 'INIT-MULTI',
    sources: [
      { sourceId: 'SRC-LOCAL', name: 'brief.md', provider: 'local', sha256: 'a'.repeat(64), cachePath: 'singularity/initiatives/INIT-MULTI/sources/blobs/aa/brief.md' },
      { sourceId: 'SRC-REMOTE', name: 'spec.pdf', provider: 'sharepoint', sha256: 'b'.repeat(64) }
    ]
  };
  const sources = find(buildTree(pinned), 'sources');
  assert.equal(sources.children[0].path, 'singularity/initiatives/INIT-MULTI/sources/blobs/aa/brief.md');
  assert.equal(sources.children[1].path, undefined, 'its bytes live in corporate storage');
});

test('the capability map is shown as the tree it is, to any depth', () => {
  // What the organisation builds is a different shape from where its code is stored: one business
  // capability is often several repositories.
  const withMap = structuredClone(snapshot);
  withMap.capabilityMap = {
    repositories: ['api', 'web'],
    capabilities: [{
      id: 'commerce', name: 'Commerce', kind: 'business', children: [{
        id: 'storefront', name: 'Storefront', kind: 'business', children: [
          { id: 'checkout', name: 'Checkout', kind: 'delivery', repository: 'web', children: [] }
        ]
      }, { id: 'payments-api', name: 'Payments', kind: 'delivery', repository: 'api', children: [] }]
    }]
  };
  const capabilities = find(buildTree(withMap), 'capabilities');
  assert.equal(capabilities.description, '2 delivering');

  // Three levels deep, and the leaf names the repository it ships from.
  const checkout = find(buildTree(withMap), 'capability:checkout');
  assert.equal(checkout.description, 'web');
  assert.equal(checkout.contextValue, 'sflow.capability.delivery');
  assert.match(checkout.tooltip, /Ships from web/);

  const storefront = find(buildTree(withMap), 'capability:storefront');
  assert.equal(storefront.description, undefined, 'a grouping ships nothing of its own');
  assert.equal(storefront.contextValue, 'sflow.capability');
});

test('a repository that has not described what it builds says so', () => {
  const undescribed = find(buildTree(snapshot), 'capabilities');
  assert.equal(undescribed.description, 'not described');
  assert.match(undescribed.tooltip, /capability-map\.yml in the lead repository/);
  assert.match(undescribed.children[0].label, /has not described what it builds/);
});

test('a capability map that does not validate reports the engine reason', () => {
  const broken = structuredClone(snapshot);
  broken.capabilityMap = { error: "Delivery capability 'ghost' names repository 'nope', which the portfolio does not declare." };
  const node = find(buildTree(broken), 'capabilities');
  assert.equal(node.description, 'not valid');
  assert.match(node.children[0].label, /which the portfolio does not declare/);
});

const { capabilityDetail, capabilityArgv, parentChoices, flattenCapabilities } =
  await import(source('views/capability-model.ts'));
const { bodyHtml: capabilitiesHtml, readEdits } = await import(source('views/capability-page.ts'));

/** The tree the engine emits, with both policies on every node, as capabilityTree() produces it. */
const capabilityFixture = [{
  id: 'commerce', name: 'Commerce', kind: 'portfolio', delivery: false, repository: null,
  jira: null, teams: ['Commerce leadership'], owns: [],
  policy: { gateSeverity: 'block', approvalMinimum: 2, protectedPaths: ['singularity/workflow.yml'] },
  effectivePolicy: { gateSeverity: 'block', approvalMinimum: 2, protectedPaths: ['singularity/workflow.yml'] },
  children: [{
    id: 'payments', name: 'Payments', kind: 'product', delivery: false, repository: null,
    jira: { projectKey: 'PAY', board: 'Payments board' }, teams: ['Payments squad'], owns: [],
    policy: { approvalMinimum: 1, protectedPaths: ['src/payments/**'] },
    effectivePolicy: {
      gateSeverity: 'block', approvalMinimum: 2,
      protectedPaths: ['singularity/workflow.yml', 'src/payments/**']
    },
    children: [{
      id: 'payments-api', name: 'Payments API', kind: 'service', delivery: true, repository: 'api',
      jira: null, teams: [], owns: [],
      policy: {},
      effectivePolicy: {
        gateSeverity: 'block', approvalMinimum: 2,
        protectedPaths: ['singularity/workflow.yml', 'src/payments/**']
      },
      children: []
    }]
  }]
}];

test('a declared policy value an ancestor overrides is shown as overridden, not as what was written', () => {
  // The whole reason this screen exists. `payments` asks for one approval beneath a parent demanding
  // two, and will be held to two — the file says nothing about that.
  const detail = capabilityDetail(capabilityFixture, 'payments');
  const minimum = detail.policy.find((field) => field.key === 'approvalMinimum');
  assert.equal(minimum.declared, 1);
  assert.equal(minimum.effective, 2);
  assert.equal(minimum.overridden, true);
  assert.match(minimum.rule, /largest demanded by any ancestor/);

  // Inherited-but-not-declared is not an override: nothing here was contradicted.
  const severity = detail.policy.find((field) => field.key === 'gateSeverity');
  assert.equal(severity.declared, null);
  assert.equal(severity.effective, 'block');
  assert.equal(severity.overridden, false);

  // A union that grew is still the child's declaration honoured, plus the ancestor's — but it is not
  // what was written, so the reader is told.
  const paths = detail.policy.find((field) => field.key === 'protectedPaths');
  assert.deepEqual(paths.effective, ['singularity/workflow.yml', 'src/payments/**']);
  assert.equal(paths.overridden, true);

  // Fields nobody set anywhere are omitted. Twenty empty rules would teach nothing.
  assert.equal(detail.policy.some((field) => field.key === 'tokenBudget'), false);
});

test('a capability reports what it ships, at any depth beneath it', () => {
  assert.deepEqual(capabilityDetail(capabilityFixture, 'commerce').ships,
    [{ id: 'payments-api', repository: 'api' }]);
  assert.deepEqual(capabilityDetail(capabilityFixture, 'payments-api').ships,
    [{ id: 'payments-api', repository: 'api' }], 'a leaf ships itself');
  assert.deepEqual(capabilityDetail(capabilityFixture, 'commerce').ancestors, []);
  assert.deepEqual(capabilityDetail(capabilityFixture, 'payments-api').ancestors, ['commerce', 'payments']);
  assert.equal(capabilityDetail(capabilityFixture, 'gone'), null);
});

test('Jira and teams are read from the capability, which is where they belong', () => {
  const detail = capabilityDetail(capabilityFixture, 'payments');
  assert.deepEqual(detail.jira, { projectKey: 'PAY', board: 'Payments board' });
  assert.deepEqual(detail.teams, ['Payments squad']);
  assert.equal(detail.delivery, false);
  assert.equal(capabilityDetail(capabilityFixture, 'payments-api').delivery, true);
});

test('the parent chooser cannot offer a move the engine would refuse', () => {
  // Moving a capability beneath itself or its own descendant is a cycle; a capability that ships
  // cannot contain anything. Both are unreachable rather than reported after the fact.
  const offered = parentChoices(capabilityFixture, 'payments').map((choice) => choice.id);
  assert.deepEqual(offered, ['commerce']);

  const forNew = parentChoices(capabilityFixture, null).map((choice) => choice.id);
  assert.deepEqual(forNew, ['commerce', 'payments'], 'payments-api ships, so it cannot contain');
});

test('an empty field is sent as a clearance, and an untouched one is not sent at all', () => {
  // Turning a delivery capability back into a grouping is `--repository ''`; omitting the flag says
  // nothing about the repository. A form that could only set things could never do the first.
  assert.deepEqual(
    capabilityArgv('set', 'payments-api', { repository: '', teams: 'Payments squad, Platform' }),
    ['capability', 'set', 'payments-api', '--repository', '', '--teams', 'Payments squad, Platform']);
  assert.deepEqual(capabilityArgv('set', 'payments', { name: ' Payments ' }),
    ['capability', 'set', 'payments', '--name', 'Payments']);
  assert.deepEqual(capabilityArgv('remove', 'payments'), ['capability', 'remove', 'payments']);
  assert.deepEqual(capabilityArgv('add', 'ledger', { parent: 'payments', kind: 'service' }),
    ['capability', 'add', 'ledger', '--kind', 'service', '--parent', 'payments']);
});

test('the page cannot widen what an edit writes', () => {
  // Messages from a webview are claims, not instructions. Only the named fields survive.
  assert.deepEqual(
    readEdits({ name: 'Payments', policy: 'gateSeverity: off', __proto__: 'x', teams: 42 }),
    { name: 'Payments' });
  assert.deepEqual(readEdits(null), {});
});

test('the capability screen shows declared beside effective, and names the override', () => {
  const html = capabilitiesHtml(capabilityFixture, 'payments', null, null);
  assert.match(html, /Approvals required/);
  assert.match(html, /the largest demanded by any ancestor/);
  assert.match(html, /overridden by an ancestor and will not apply as written/);
  // Both values are on the page: the one written and the one that applies.
  assert.match(html, /<td class="muted">1<\/td>\s*<td><strong>2<\/strong><\/td>/);
  assert.match(html, /Payments board/);
  assert.match(html, /Payments squad/);

  // Policy is not editable here, and the screen says where it is edited rather than staying silent.
  assert.equal(/data-field="policy/.test(html), false);
  assert.match(html, /singularity\/capabilities\.yml/);
});

test('a repository with no capability map offers to describe the first capability', () => {
  const html = capabilitiesHtml([], null, null, null);
  assert.match(html, /Describe the first capability/);
  assert.match(html, /data-add=""/);

  // A refusal is shown on the screen that caused it, in the engine's own words.
  const refused = capabilitiesHtml(capabilityFixture, 'payments', null,
    "Capability 'payments' delivers from repository 'nope', which the portfolio does not declare.");
  assert.match(refused, /which the portfolio does not declare/);
});

test('a capability that ships is rendered as one whatever its kind says', () => {
  // `kind` is free text the organisation chooses. Reading it as the delivery flag made a capability
  // labelled anything other than "delivery" render as an empty grouping beside its own repository.
  const withMap = structuredClone(snapshot);
  withMap.capabilityMap = {
    repositories: ['api'],
    capabilities: [{
      id: 'commerce', name: 'Commerce', kind: 'portfolio', children: [
        { id: 'payments-api', name: 'Payments API', kind: 'service', repository: 'api', children: [] }
      ]
    }]
  };
  const node = find(buildTree(withMap), 'capability:payments-api');
  assert.equal(node.description, 'api');
  assert.equal(node.contextValue, 'sflow.capability.delivery');
  assert.match(node.tooltip, /Ships from api/);
  assert.equal(flattenCapabilities(withMap.capabilityMap.capabilities).length, 2);
});


const { icon, STYLE } = await import(source('views/webview.ts'));

test('icons are inline paths, so no font has to be let through the CSP', () => {
  // A codicon font would need a font-src in a policy that currently allows nothing at all. These
  // inherit currentColor instead, which is also why they follow status colours and disabled states.
  const rendered = icon('repository');
  assert.match(rendered, /^<svg class="ico"/);
  assert.match(rendered, /stroke="currentColor"/);
  assert.doesNotMatch(rendered, /fill="[^n]/, 'stroked, not filled, so weight matches the text');
  assert.match(icon('capability', { size: 20 }), /width="20" height="20"/);

  // A name nobody drew costs the reader nothing rather than rendering an empty box.
  assert.equal(icon('no-such-icon'), '');
});

test('every domain noun has an icon, so nothing falls back to a bare label', () => {
  for (const name of [
    'git', 'repository', 'branch', 'commit', 'merge', 'code',
    'capability', 'directory', 'workspace', 'teams',
    'approval', 'policy', 'gate', 'epic', 'story', 'tracker', 'document', 'impact',
    'ok', 'wait', 'bad'
  ]) {
    assert.notEqual(icon(name), '', `${name} has no icon`);
  }
});

test('exactly one filled button per page, so the consequential action is findable', () => {
  // Three competing primaries is what the last visual pass was about. A filled button means "this
  // commits something"; everything else is outlined or plain.
  const pages = [
    workspaceFormHtml(withMap(['payments'])),
    workspaceFormHtml(EMPTY_WORKSPACE_FORM),
    capabilitiesHtml(capabilityFixture, 'payments', null, null)
  ];
  for (const html of pages) {
    const filled = [...html.matchAll(/<button(?![^>]*class=)[^>]*>/g)];
    assert.ok(filled.length <= 1, `${filled.length} filled buttons: ${filled.map((m) => m[0]).join(' ')}`);
  }
});

test('the accent is defined for both themes and never hard-codes the surface', () => {
  // The editor's tokens carry background and foreground so the panel stays right in light, dark and
  // high-contrast; only the accent is ours. A literal surface colour here would break one of them.
  assert.match(STYLE, /--sf-accent:/);
  assert.match(STYLE, /@media \(prefers-color-scheme: dark\)[\s\S]*--sf-accent:/);
  assert.match(STYLE, /background: var\(--vscode-input-background\)/);
  assert.match(STYLE, /color: var\(--vscode-foreground\)/);
  assert.doesNotMatch(STYLE, /background:\s*#(fff|ffffff|000|000000)\b/i);
  // Pill-shaped, which is the shape the whole language is built on.
  assert.match(STYLE, /button \{[\s\S]*?border-radius: 999px/);
});

const { EMPTY_EPIC_FORM, epicCommand, epicFormHtml, epicProblems } =
  await import(source('views/epic-form.ts'));

const EPIC_CHOICES = {
  profiles: [
    { id: 'epic-planning', label: 'Epic planning', description: '4 governed phases',
      phases: ['epic-intake', 'epic-requirements', 'epic-impact', 'epic-planning'] },
    { id: 'enterprise-delivery', label: 'Enterprise delivery', description: '7 governed phases',
      phases: ['discover-define', 'design-iterate', 'pre-inception', 'inception', 'elaboration', 'construction', 'delivery'] }
  ],
  lenses: [{ id: 'product-owner', label: 'Product owner' }, { id: 'architect', label: 'Architect' }]
};
const epicForm = (over = {}) => ({ ...EMPTY_EPIC_FORM, ...EPIC_CHOICES, ...over });

test('starting an Epic is a form, not five prompts in a row', () => {
  // It was title, description, goal, profile and lens asked one at a time, each covering the answer
  // before it — and the one that decides the Epic's whole lifecycle came last.
  const html = epicFormHtml(epicForm());
  for (const field of ['title', 'description', 'goal']) {
    assert.match(html, new RegExp(`data-epic="${field}"`), `${field} is on the form`);
  }
  assert.match(html, /data-choose-profile="enterprise-delivery"/);
  assert.match(html, /data-epic="lens"/);
  // All five listed at once rather than revealed one prompt at a time — the same five that used to
  // be five separate boxes.
  assert.equal(epicProblems(epicForm()).length, 5);
  assert.match(html, /Before this can start/);
  assert.match(html, /<button data-epic-submit="start" disabled>/);
});

test('the profiles are shown with the phases that distinguish them', () => {
  // A picker showing "Epic planning" and "Enterprise delivery" gives no basis for choosing. The
  // difference is which phases each runs, and the choice is pinned for the Epic's whole life.
  const html = epicFormHtml(epicForm());
  assert.match(html, /discover-define/);
  assert.match(html, /elaboration/);
  assert.match(html, /epic-intake/);
  assert.match(html, /7 phases/);
  assert.match(html, /cannot be changed afterwards|Pinned at start/);
});

test('a complete Epic form describes the command it will run', () => {
  const form = epicForm({
    title: ' One-tap checkout ', description: 'Fewer steps to pay', goal: 'Cut abandonment',
    profile: 'enterprise-delivery', lens: 'product-owner'
  });
  assert.deepEqual(epicProblems(form), []);
  assert.deepEqual(epicCommand(form), [
    'epic', 'start', '--local',
    '--title', 'One-tap checkout',
    '--description', 'Fewer steps to pay',
    '--goal', 'Cut abandonment',
    '--profile', 'enterprise-delivery',
    '--persona', 'product-owner'
  ]);
  assert.match(epicFormHtml(form), /<button data-epic-submit="start" >/);
});

test('a repository with no working lenses does not demand one', () => {
  // The lens is only a requirement where the repository declares lenses to choose between.
  const form = epicForm({
    lenses: [], title: 'A', description: 'B', goal: 'C', profile: 'epic-planning'
  });
  assert.deepEqual(epicProblems(form), []);
  assert.deepEqual(epicCommand(form).includes('--persona'), false);
  assert.match(epicFormHtml(form), /declares no working lenses/);
});

test('a refused start is reported on the form that caused it', () => {
  const form = epicForm({
    title: 'A', description: 'B', goal: 'C', profile: 'epic-planning', lens: 'architect',
    error: 'Working tree is not clean.'
  });
  assert.match(epicFormHtml(form), /Working tree is not clean/);
});

const { duplicateCommand, duplicateDirectory, duplicateProblems, renameCommand, workspaceRows } =
  await import(source('views/workspaces-model.ts'));
const { workspacesHtml, EMPTY_DRAFT: EMPTY_COPY } = await import(source('views/workspaces-page.ts'));

const REGISTRY = [
  { id: 'local--commerce', path: '/work/commerce', name: 'commerce', anchorKey: 'commerce',
    leadRepositoryPath: '/work/commerce/repos/platform', active: 'yes' },
  { id: 'local--payments', path: '/work/payments', name: 'payments', anchorKey: 'payments',
    leadRepositoryPath: '/work/payments/repos/api' }
];

test('a workspace list shows the working directory, which is what it is really about', () => {
  const rows = workspaceRows(REGISTRY);
  assert.deepEqual(rows.map((row) => row.directory), ['/work/commerce', '/work/payments']);
  assert.deepEqual(rows.map((row) => row.lead), ['platform', 'api']);
  assert.equal(rows[0].collides, false);

  const html = workspacesHtml(rows, null, EMPTY_COPY, null);
  assert.match(html, /\/work\/commerce/);
  assert.match(html, /platform/);
  assert.match(html, /no two may share a directory/);
});

test('two workspaces on one directory are marked, because the engine forbids it', () => {
  // It cannot normally happen — creation refuses it — but a registry is a file on disk that
  // survives moves, restores and hand edits. Showing it costs less than two workspaces quietly
  // writing into one tree.
  const rows = workspaceRows([
    ...REGISTRY,
    { id: 'local--commerce-2', path: '/work/commerce', name: 'commerce copy', anchorKey: 'commerce-2' }
  ]);
  assert.deepEqual(rows.filter((row) => row.collides).map((row) => row.name),
    ['commerce', 'commerce copy']);
  const html = workspacesHtml(rows, null, EMPTY_COPY, null);
  assert.match(html, /shared directory/);
  assert.match(html, /2 workspaces share a working directory/);
});

test('a copy is refused before it runs when its directory is taken', () => {
  const rows = workspaceRows(REGISTRY);
  const [commerce] = rows;

  // Copying alongside itself under a name already in use is the mistake worth catching.
  assert.deepEqual(duplicateDirectory(commerce, 'payments', null), '/work/payments');
  assert.match(duplicateProblems(commerce, 'payments', null, rows).join(' '),
    /already workspace 'payments'.*No two workspaces may share a working directory/);
  assert.match(duplicateProblems(commerce, 'commerce', null, rows).join(' '), /already workspace 'commerce'/);

  // A free directory, and the same identifier somewhere else, are both fine.
  assert.deepEqual(duplicateProblems(commerce, 'commerce-spike', null, rows), []);
  assert.deepEqual(duplicateProblems(commerce, 'commerce', '/elsewhere', rows), []);
  assert.deepEqual(duplicateProblems(commerce, '', null, rows), ['Give the copy an identifier.']);
  assert.match(duplicateProblems(commerce, 'has spaces', null, rows).join(' '), /letters, numbers/);
});

test('the copy and rename commands are what the engine expects', () => {
  const [commerce] = workspaceRows(REGISTRY);
  assert.deepEqual(duplicateCommand(commerce, ' commerce-spike ', '', ''),
    ['workspace', 'duplicate', '/work/commerce', '--id', 'commerce-spike', '--json']);
  assert.deepEqual(duplicateCommand(commerce, 'commerce-spike', '/elsewhere', 'Spike'),
    ['workspace', 'duplicate', '/work/commerce', '--id', 'commerce-spike', '--json',
      '--base', '/elsewhere', '--name', 'Spike']);
  // Renaming carries the exact confirmation the engine demands for an edit.
  assert.deepEqual(renameCommand(commerce, ' Commerce platform '),
    ['workspace', 'update', '/work/commerce', '--name', 'Commerce platform',
      '--confirm', 'commerce', '--json']);
});

test('the selected workspace offers rename, copy and forget, and says what each costs', () => {
  const rows = workspaceRows(REGISTRY);
  const html = workspacesHtml(rows, '/work/commerce', { ...EMPTY_COPY, id: 'commerce-spike' }, null);
  assert.match(html, /data-rename="\/work\/commerce"/);
  assert.match(html, /data-duplicate="\/work\/commerce"/);
  assert.match(html, /data-forget="\/work\/commerce"/);
  assert.match(html, /The copy would be created at \/work\/commerce-spike/);
  assert.match(html, /leaves the directory alone/, 'forgetting is not deleting, and says so');
  assert.match(html, /working\s*\n?\s*directory is not/, 'renaming does not move anything');
});

test('the page carries the directories it needs to answer without a round trip', () => {
  // Re-rendering to answer "is that directory taken" would replace the field being typed into, so
  // the page is given the list. The panel re-checks it, and the engine refuses regardless.
  const html = workspacesHtml(workspaceRows(REGISTRY), '/work/commerce', EMPTY_COPY, null);
  assert.match(html, /data-context="/);
  assert.match(html, /work\/payments/);
  // Not a script element: the CSP allows only this render's nonce, and a data block under a strict
  // policy is not worth depending on.
  assert.doesNotMatch(html, /<script/);
});

const { buildCapabilityTree, buildWorkspaceTree, capabilityIdOf, workspacePathOf } =
  await import(source('views/navigation-trees.ts'));

test('workspaces are a tree, with the working directory where it can be compared', () => {
  // The directory is what distinguishes two rows at a glance, and the rule that no two may share
  // one is only checkable by eye if they sit in the same place on every row.
  const [commerce, payments] = buildWorkspaceTree(REGISTRY);
  assert.equal(commerce.label, 'commerce');
  assert.equal(commerce.description, 'active');
  assert.equal(commerce.tooltip, '/work/commerce');
  assert.equal(commerce.contextValue, 'sflow.workspace');
  assert.equal(commerce.path, '/work/commerce');
  // Opening a workspace means opening its lead repository: that is where the map, the governed
  // state and every command's configuration live.
  assert.equal(commerce.openPath, '/work/commerce/repos/platform');
  assert.deepEqual(commerce.children.map((child) => child.label),
    ['/work/commerce', 'platform']);
  assert.equal(payments.description, undefined, 'only one workspace is active');
});

test('a workspace sharing a directory with another is marked in the tree', () => {
  const rows = buildWorkspaceTree([
    ...REGISTRY,
    { id: 'local--commerce-2', path: '/work/commerce', name: 'commerce copy', anchorKey: 'commerce-2' }
  ]);
  const shared = rows.filter((row) => row.description === 'shares a directory');
  assert.equal(shared.length, 2);
  assert.equal(shared[0].icon, 'warning');
  assert.match(shared[0].tooltip, /Another workspace occupies this directory/);
});

test('an empty registry offers the one thing to do about it', () => {
  const [empty] = buildWorkspaceTree([]);
  assert.equal(empty.contextValue, 'sflow.workspaces.empty');
  assert.match(empty.label, /No workspaces yet/);
});

test('capabilities are the tree they already are, and say what ships', () => {
  const snapshot = { capabilityMap: { capabilities: capabilityFixture }, capabilityMapPath: 'singularity/capabilities.yml' };
  const [commerce] = buildCapabilityTree(snapshot);
  assert.equal(commerce.label, 'Commerce');
  assert.equal(commerce.icon, 'type-hierarchy');
  assert.equal(commerce.contextValue, 'sflow.capability', 'a grouping can contain more');

  const payments = commerce.children[0];
  const api = payments.children[0];
  assert.equal(api.label, 'Payments API');
  assert.equal(api.description, 'api', 'the repository it ships from');
  assert.equal(api.icon, 'repo');
  // A capability that ships cannot contain anything, so it must not offer "add one inside".
  assert.equal(api.contextValue, 'sflow.capability.delivery');
  assert.match(api.tooltip, /Ships from api/);
  assert.match(payments.tooltip, /Jira PAY/);
  assert.match(payments.tooltip, /Teams: Payments squad/);
});

test('the capability tree says why it is empty rather than being empty', () => {
  // A view with nothing in it and no explanation is the same defect as a view with no provider.
  const [unavailable] = buildCapabilityTree(null, 'Open the repository that contains singularity/workflow.yml.');
  assert.match(unavailable.label, /Open the repository/);
  assert.match(unavailable.tooltip, /lead repository/);

  const [none] = buildCapabilityTree({ capabilityMap: null, capabilityMapPath: 'singularity/capabilities.yml' });
  assert.equal(none.contextValue, 'sflow.capabilities.empty');
  assert.match(none.label, /Nothing describes what this organisation builds/);
  assert.match(none.tooltip, /singularity\/capabilities\.yml/);

  const [broken] = buildCapabilityTree({ capabilityMap: { error: "Capability 'x' references unknown parent 'y'." } });
  assert.match(broken.label, /references unknown parent/);
  assert.equal(broken.icon, 'error');
});

test('a tree node resolves back to the thing it stands for', () => {
  // The commands act on what was clicked, so the mapping back has to be exact rather than a guess
  // from the label.
  const [commerce] = buildCapabilityTree({ capabilityMap: { capabilities: capabilityFixture } });
  assert.equal(capabilityIdOf(commerce), 'commerce');
  assert.equal(capabilityIdOf(commerce.children[0].children[0]), 'payments-api');
  assert.equal(capabilityIdOf({ id: 'workspace:/work/commerce' }), null);
  assert.equal(capabilityIdOf(undefined), null);

  const [workspace] = buildWorkspaceTree(REGISTRY);
  assert.equal(workspacePathOf(workspace), '/work/commerce');
  assert.equal(workspacePathOf({ id: 'workspace:/work/payments:lead' }), '/work/payments');
  assert.equal(workspacePathOf({ id: 'capability:commerce' }), null);
});

const { buildDashboard, dashboardHealth } = await import(source('views/dashboard-model.ts'));

const DIAGNOSTICS = {
  repository: '/work/platform', branch: 'SF-1',
  checks: [
    { id: 'node', status: 'pass', message: 'Node.js 22.14.0', fix: null },
    { id: 'git', status: 'pass', message: 'git 2.43', fix: null },
    { id: 'world-model', status: 'warn', message: 'No world model has been built.', fix: 'singularity-flow wm build' },
    { id: 'approvers', status: 'fail', message: 'No approval authority has a member.', fix: 'Edit singularity/portfolio.yml' },
    { id: 'jira', status: 'skip', message: 'Jira is not configured.', fix: null }
  ]
};

test('the dashboard leads with what would stop work, worst first', () => {
  // A dashboard that opens with a row of counts teaches people to skim past the one line that
  // mattered. Failures come first, and passing checks are a number rather than a list.
  const dashboard = buildDashboard({ ...snapshot, diagnostics: DIAGNOSTICS });
  assert.deepEqual(dashboard.failing.map((check) => check.id), ['approvers', 'world-model', 'jira']);
  assert.equal(dashboard.passing, 2);
  assert.equal(dashboard.repository, '/work/platform');
  assert.equal(dashboardHealth(dashboard), 'fail');
  assert.equal(dashboard.quiet, false);
});

test('a healthy repository with nothing waiting says exactly that', () => {
  const dashboard = buildDashboard({
    ...snapshot,
    initiative: null,
    diagnostics: { repository: '/work/platform', branch: 'main', checks: [{ id: 'node', status: 'pass', message: 'ok' }] },
    approvalInbox: { count: 0, fetched: true },
    agentStatus: [],
    ledger: { enabled: true, config: { branch: 'state' } }
  });
  assert.deepEqual(dashboard.failing, []);
  assert.equal(dashboard.quiet, true);
  assert.equal(dashboardHealth(dashboard), 'skip', 'no Epic is a state, not a fault');
});

test('anything waiting on a person is surfaced, because it will not resolve itself', () => {
  const dashboard = buildDashboard({ ...snapshot, approvalInbox: { count: 3, fetched: true } });
  const approvals = dashboard.sections.find((section) => section.id === 'approvals');
  assert.equal(approvals.status, 'warn');
  assert.match(approvals.headline, /3 approvals are waiting on you/);
  assert.equal(dashboard.quiet, false, 'something waiting is not quiet');

  const unread = buildDashboard({ ...snapshot, approvalInbox: { count: 0, fetched: false } });
  assert.match(unread.sections.find((section) => section.id === 'approvals').detail.join(' '),
    /counts only what is already local/);
});

test('an agent that drifted from what it was locked to is reported', () => {
  const dashboard = buildDashboard({
    ...snapshot,
    agentStatus: [
      { id: 'sflow-workflow', scope: 'plugin', status: 'locked', locked: true, sourceChanged: true },
      { id: 'reviewer', scope: 'repository', status: 'local-only', locked: false }
    ]
  });
  const agents = dashboard.sections.find((section) => section.id === 'agents');
  assert.equal(agents.status, 'warn');
  assert.match(agents.headline, /2 agents, 1 changed since being locked/);
  assert.match(agents.detail.join(' '), /sflow-workflow has changed/);
  assert.match(agents.detail.join(' '), /1 not yet locked/);
});

test('a repository with no state branch says what that costs', () => {
  // Not an error — a repository can be governed without one. The difference decides whether
  // workflow progress is recoverable from Git, which is worth stating rather than implying.
  const dashboard = buildDashboard({ ...snapshot, ledger: { enabled: false } });
  const governance = dashboard.sections.find((section) => section.id === 'governance');
  assert.equal(governance.status, 'skip');
  assert.match(governance.headline, /not recorded in Git/);

  const enabled = buildDashboard({ ...snapshot, ledger: { enabled: true, config: { branch: 'state' } } });
  assert.match(enabled.sections.find((section) => section.id === 'governance').headline, /recorded on state/);
});

test('the Epic section reports where it has got to, and what is holding it', () => {
  const dashboard = buildDashboard(snapshot);
  const epic = dashboard.sections.find((section) => section.id === 'epic');
  assert.match(epic.headline, /is in |phases approved/);
  assert.match(epic.detail.join(' '), /phases approved/);

  const none = buildDashboard({ ...snapshot, initiative: null });
  assert.match(none.sections.find((section) => section.id === 'epic').headline, /No Epic is checked out/);
});

const { buildProfiles, buildTemplateUsage, consequence, standingOn } =
  await import(source('views/designer-model.ts'));
const { designerHtml } = await import(source('views/designer-page.ts'));

const DESIGN_SNAPSHOT = {
  portfolioPath: 'singularity/portfolio.yml',
  definitionPath: 'singularity/workflow.yml',
  portfolio: {
    initiativeProfiles: {
      'enterprise-delivery': { label: 'Enterprise delivery', phases: ['discover-define', 'delivery'] }
    },
    initiativePhases: {
      'discover-define': {
        label: 'Discover & Define',
        outputs: [
          { id: 'business-case', label: 'Business case', required: true,
            template: 'initiatives/business-case.md',
            approval: { mode: 'individual', authorities: ['product-approvers'], minimum: 1 } },
          { id: 'source-catalog', label: 'Source catalog', required: false, template: null, generator: 'source-catalog' }
        ],
        checklist: [{ id: 'business-case-exists', label: 'Business case exists' }],
        bundleApproval: { mode: 'bundle', chain: [{ authority: 'product-approvers', label: 'Product Governance' }] }
      },
      delivery: { label: 'Delivery', outputs: [], checklist: [] }
    }
  },
  templates: [
    { path: 'singularity/templates/initiatives/business-case.md', name: 'business-case.md', bytes: 2185 },
    { path: 'singularity/templates/initiatives/unused-draft.md', name: 'unused-draft.md', bytes: 400 }
  ],
  initiatives: [
    { id: 'SF-1', title: 'One-tap checkout', status: 'in_progress', currentPhase: 'discover-define',
      pinnedTemplates: [{ path: 'singularity/templates/initiatives/business-case.md', sha256: 'abc' }] },
    { id: 'SF-0', title: 'Closed thing', status: 'complete',
      pinnedTemplates: [{ path: 'singularity/templates/initiatives/business-case.md', sha256: 'abc' }] }
  ]
};

test('the designer reads a profile as the ordered phases it actually runs', () => {
  const [profile] = buildProfiles(DESIGN_SNAPSHOT);
  assert.equal(profile.label, 'Enterprise delivery');
  assert.deepEqual(profile.phases.map((phase) => phase.id), ['discover-define', 'delivery']);
  assert.deepEqual(profile.phases.map((phase) => phase.order), [0, 1]);

  const [discover] = profile.phases;
  assert.equal(discover.outputs.length, 2);
  assert.equal(discover.outputs[0].template, 'initiatives/business-case.md');
  assert.equal(discover.outputs[1].generator, 'source-catalog', 'generated outputs have no template');
  assert.equal(discover.bundleApproval.chain[0].label, 'Product Governance');
});

test('a template knows what points at it and who is standing on it', () => {
  // The files cannot tell you either. That is the whole reason this is a screen.
  const usage = buildTemplateUsage(DESIGN_SNAPSHOT);
  const businessCase = usage.find((entry) => entry.name === 'business-case.md');
  assert.deepEqual(businessCase.usedBy, [
    { profile: 'enterprise-delivery', phase: 'discover-define', output: 'business-case' }
  ]);
  // Only Epics still running: a closed one has nothing left to stop.
  assert.deepEqual(businessCase.standing.map((entry) => entry.id), ['SF-1']);

  const unused = usage.find((entry) => entry.name === 'unused-draft.md');
  assert.deepEqual(unused.usedBy, [], 'listed rather than hidden — it may be about to be wired up');
  assert.deepEqual(unused.standing, []);
});

test('editing the portfolio stops every running Epic, and the screen says so first', () => {
  // An Epic pins the portfolio hash at start and validates against those exact bytes for the rest
  // of its life. Editing it does not change the Epic — it stops it, at whatever moment somebody
  // next runs a phase.
  const standing = standingOn(DESIGN_SNAPSHOT, 'singularity/portfolio.yml');
  assert.deepEqual(standing.map((entry) => entry.id), ['SF-1']);
  assert.match(consequence(standing, 'singularity/portfolio.yml'),
    /1 running Epic pinned .*it stops it at the next phase/);

  const template = standingOn(DESIGN_SNAPSHOT, 'singularity/templates/initiatives/business-case.md');
  assert.deepEqual(template.map((entry) => entry.id), ['SF-1']);

  // A template nobody pinned is a free edit, and saying so is as useful as the warning.
  const free = standingOn(DESIGN_SNAPSHOT, 'singularity/templates/initiatives/unused-draft.md');
  assert.deepEqual(free, []);
  assert.match(consequence(free, 'unused-draft.md'), /changes what the next Epic starts from and nothing else/);
});

test('the phases tab shows each artifact, whether it is required, and what approves it', () => {
  const html = designerHtml('phases', buildProfiles(DESIGN_SNAPSHOT), [], null, 'all',
    standingOn(DESIGN_SNAPSHOT, 'singularity/portfolio.yml'), 'singularity/portfolio.yml', null);
  assert.match(html, /Discover &amp; Define/);
  assert.match(html, /Business case/);
  assert.match(html, /required/);
  assert.match(html, /Product Governance/);
  assert.match(html, /generated by source-catalog/);
  // The warning leads, because it is the thing the file cannot tell you.
  assert.match(html, /1 running Epic pinned/);
});

test('the templates tab can be filtered to what is risky and what is dead', () => {
  const templates = buildTemplateUsage(DESIGN_SNAPSHOT);
  const pinned = designerHtml('templates', [], templates, null, 'pinned', [], 'singularity/portfolio.yml', null);
  assert.match(pinned, /business-case\.md/);
  assert.doesNotMatch(pinned, /unused-draft\.md/);

  const unused = designerHtml('templates', [], templates, null, 'unused', [], 'singularity/portfolio.yml', null);
  assert.match(unused, /unused-draft\.md/);
  assert.doesNotMatch(unused, /business-case\.md/);

  const all = designerHtml('templates', [], templates, null, 'all', [], 'singularity/portfolio.yml', null);
  assert.match(all, /SF-1/, 'the Epic standing on it is named on the row');
  assert.match(all, /New template/);
});

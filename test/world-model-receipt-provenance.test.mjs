import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { createPlanningContext, loadPlanningPack } from '../src/planning.mjs';
import { verifyInitiativeContext } from '../src/initiative-context.mjs';
import { loadInitiative } from '../src/state-stores.mjs';
import { writeV3Manifest } from '../src/world-model-materialization.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const actor = 'Receipt Tester';
const actorEmail = 'receipt@example.com';

function environment(root) {
  const machine = path.join(root, '.git', 'receipt-test-machine');
  return {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: actor,
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'initiative-lite' }),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'lead-registry.json'),
    SINGULARITY_FLOW_WMB_SHARED_CACHE: path.join(machine, 'wmb-cache')
  };
}

function execute(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: environment(root)
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-receipt-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', actor]);
  git(root, ['config', 'user.email', actorEmail]);
  await writeFile(path.join(root, 'README.md'), '# Receipt provenance fixture\n');
  execute(root, ['init']);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.git.publish = 'off';
  workflow.ledger.enabled = false;
  workflow.worldModel.grounding = 'enforce';
  workflow.worldModel.staleness = 'warn';
  workflow.worldModel.materialization.publish = 'governed';
  await writeFile(workflowFile, YAML.stringify(workflow));

  const portfolioFile = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.git.publish = 'off';
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: actor, email: actorEmail }];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));

  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize receipt provenance fixture']);
  const remote = `${root}.git`;
  git(root, ['init', '--bare', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'main']);
  return root;
}

async function removeWorktreeProjection(root) {
  await rm(path.join(root, 'singularity/world-model'), { recursive: true, force: true });
}

async function addFullStateView(root, view) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-state-view-'));
  const checkout = path.join(parent, 'state');
  git(root, ['worktree', 'add', checkout, 'state']);
  try {
    const directory = path.join(checkout, 'singularity/world-model');
    const brief = await readFile(path.join(directory, `views/${view}.brief.md`), 'utf8');
    await writeFile(path.join(directory, `views/${view}.md`), `${brief}\nFull detail.\n`);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    manifest.views[view].tiers.full = { status: 'ready', path: `views/${view}.md` };
    await writeV3Manifest(directory, manifest);
    git(checkout, ['add', 'singularity/world-model']);
    git(checkout, ['commit', '-m', `Add full ${view} state view`]);
    git(checkout, ['push', 'origin', 'state']);
  } finally {
    git(root, ['worktree', 'remove', '--force', checkout]);
    await rm(parent, { recursive: true, force: true });
  }
}

test('Story planning pins state-branch World-Model files by canonical path and exact commit', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  execute(root, ['start', 'PLAN-STATE', '--from-branch', 'main']);
  execute(root, ['wm', 'light', '--phase', 'intake']);
  const stateCommit = git(root, ['rev-parse', 'refs/heads/state']);
  await removeWorktreeProjection(root);

  const context = await createPlanningContext(root, {
    scope: 'work-item',
    id: 'PLAN-STATE',
    phase: 'intake',
    agent: 'product-owner',
    target: 'artifact'
  });
  const sources = context.manifest.sources.filter((source) => source.kind === 'world-model');
  assert.ok(sources.length > 0, 'expected a state-backed World-Model selection');
  for (const source of sources) {
    assert.match(source.path, /^singularity\/world-model\//);
    assert.equal(path.isAbsolute(source.path), false);
    assert.equal(source.path.includes(os.tmpdir()), false);
    assert.equal(source.commit, stateCommit);
    assert.equal(source.source, 'state-branch');
    const committed = spawnSync('git', ['show', `${source.commit}:${source.path}`], {
      cwd: root, encoding: null
    });
    assert.equal(committed.status, 0, committed.stderr?.toString('utf8'));
    assert.equal(createHash('sha256').update(committed.stdout).digest('hex'), source.sha256);
  }

  // A disposable extraction/current-worktree projection is not part of the durable receipt.
  // Even hostile local bytes at the same path cannot change what this planning pack verifies.
  const first = sources[0];
  await mkdir(path.dirname(path.join(root, first.path)), { recursive: true });
  await writeFile(path.join(root, first.path), 'different current-worktree bytes\n');
  const loaded = await loadPlanningPack(root, context.sessionId);
  assert.equal(loaded.stale, false);
  assert.deepEqual(loaded.changedSources, []);
});

test('Initiative context pins state-branch World-Model files by canonical path and exact commit', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  execute(root, ['initiative', 'start', 'INIT-STATE', '--title', 'State-backed initiative']);
  execute(root, ['wm', 'light', '--views', 'business']);
  await addFullStateView(root, 'business');
  const stateCommit = git(root, ['rev-parse', 'refs/heads/state']);
  await removeWorktreeProjection(root);

  execute(root, ['initiative', 'phase', 'define']);
  const recordPath = path.join(
    root,
    'singularity/initiatives/INIT-STATE/context/prompt-context-define-gen1.json'
  );
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.worldModel.available, true);
  assert.equal(record.worldModel.commit, stateCommit);
  assert.ok(record.worldModelFiles.length > 0);
  for (const file of record.worldModelFiles) {
    assert.match(file.path, /^singularity\/world-model\//);
    assert.equal(path.isAbsolute(file.path), false);
    assert.equal(file.path.includes(os.tmpdir()), false);
    assert.equal(file.commit, stateCommit);
    assert.equal(file.source, 'state-branch');
  }

  const first = record.worldModelFiles[0];
  await mkdir(path.dirname(path.join(root, first.path)), { recursive: true });
  await writeFile(path.join(root, first.path), 'different current-worktree bytes\n');
  const loaded = await loadInitiative(root, 'INIT-STATE');
  const verification = await verifyInitiativeContext(
    root, loaded.portfolio, loaded.initiative, 'define', 1
  );
  assert.equal(verification.valid, true, verification.errors.join('\n'));
});

test('Initiative World-Model availability receipts cannot contradict their consumed files', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  execute(root, ['initiative', 'start', 'INIT-RECEIPT', '--title', 'Receipt invariants']);
  execute(root, ['initiative', 'phase', 'define']);
  const recordPath = path.join(
    root,
    'singularity/initiatives/INIT-RECEIPT/context/prompt-context-define-gen1.json'
  );
  const original = JSON.parse(await readFile(recordPath, 'utf8'));
  const loaded = await loadInitiative(root, 'INIT-RECEIPT');
  const verify = () => verifyInitiativeContext(
    root, loaded.portfolio, loaded.initiative, 'define', 1
  );

  const fakeFile = {
    path: 'README.md',
    sha256: createHash('sha256').update('# Receipt provenance fixture\n').digest('hex'),
    bytes: Buffer.byteLength('# Receipt provenance fixture\n')
  };
  await writeFile(recordPath, `${JSON.stringify({
    ...original,
    worldModel: { ...original.worldModel, available: false, commit: null },
    worldModelFiles: [fakeFile]
  }, null, 2)}\n`);
  let result = await verify();
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /marks grounding unavailable but records 1 consumed file/);

  await writeFile(recordPath, `${JSON.stringify({
    ...original,
    worldModel: { ...original.worldModel, available: true, fresh: true, commit: null },
    worldModelFiles: [fakeFile]
  }, null, 2)}\n`);
  result = await verify();
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /world-model commit is missing/);

  await writeFile(recordPath, `${JSON.stringify({
    ...original,
    worldModel: { ...original.worldModel, available: true, fresh: false, commit: null },
    worldModelFiles: [fakeFile]
  }, null, 2)}\n`);
  result = await verify();
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /world-model commit is missing/);

  await writeFile(recordPath, `${JSON.stringify({
    ...original,
    worldModel: {
      ...original.worldModel,
      available: true,
      fresh: true,
      commit: git(root, ['rev-parse', 'HEAD'])
    },
    worldModelFiles: []
  }, null, 2)}\n`);
  result = await verify();
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /marks grounding available but records no consumed files/);
});

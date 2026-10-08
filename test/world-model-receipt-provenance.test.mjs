import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { verifyInitiativeContext } from '../src/initiative-context.mjs';
import { loadInitiative } from '../src/state-stores.mjs';

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

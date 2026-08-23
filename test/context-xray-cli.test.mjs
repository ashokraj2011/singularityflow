import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Context X-Ray CLI Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' })
  };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function git(root, ...args) { return run('git', args, root).trim(); }
function flow(root, ...args) { return run(process.execPath, [bin, ...args], root); }

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-context-xray-cli-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Context X-Ray CLI Tester');
  git(root, 'config', 'user.email', 'context-xray-cli@example.test');
  await writeFile(path.join(root, 'README.md'), '# Context X-Ray CLI\n');
  flow(root, 'init');
  const configPath = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', 'README.md', 'singularity', '.github/agents');
  git(root, 'commit', '-m', 'initialize');
  const remote = `${root}.git`;
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  flow(root, 'start', 'CXR-CLI-1', '--from-branch', 'main', '--title', 'Inspect context');
  return root;
}

test('context and tokens CLI commands separate read-only projections from machine-local compilation', async () => {
  const root = await repository();
  const before = git(root, 'status', '--porcelain');
  const xray = JSON.parse(flow(root, 'context', 'xray', 'CXR-CLI-1', '--json'));
  const ledger = JSON.parse(flow(root, 'tokens', 'report', 'CXR-CLI-1', '--json'));
  const doctor = JSON.parse(flow(root, 'context', 'doctor', '--json'));
  const compiled = JSON.parse(flow(root, 'context', 'compile', 'CXR-CLI-1', '--slice', 'evidence', '--json'));
  const text = flow(root, 'context', 'xray', 'CXR-CLI-1');

  assert.equal(xray.operation.id, 'context');
  assert.equal(xray.operation.classification, 'read');
  assert.equal(xray.rendered.preservedEverything, true);
  assert.equal(xray.data.xray.work.id, 'CXR-CLI-1');
  assert.equal(ledger.operation.id, 'tokens');
  assert.equal(ledger.data.ledger.phase, null);
  assert.equal(doctor.operation.id, 'context.doctor');
  assert.equal(doctor.data.diagnostic.policy.mode, 'observe');
  assert.equal(compiled.operation.id, 'context.compile');
  assert.equal(compiled.operation.classification, 'mutation');
  assert.equal(compiled.data.packet.correlation.storyId, 'CXR-CLI-1');
  assert.ok(compiled.data.packet.items.some((item) => item.mandatory));
  assert.match(text, /CONTEXT X-RAY · CXR-CLI-1/);
  assert.match(text, /No governed state, files, publications or external systems were changed/);
  assert.equal(git(root, 'status', '--porcelain'), before);
});

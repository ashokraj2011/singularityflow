/**
 * A Story whose Work ID is lowercase (`code-hex`) got lowercase clause anchors (`[code-hex:REQ-001]`)
 * from every template, while clause IDs are compared in capitals (`CODE-HEX:REQ-001`). An agent
 * that copied an anchor into a later step's review rows wrote an ID that step did not know.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('a lowercase Work ID prepares clause anchors in capitals and keeps its own spelling elsewhere', { timeout: 180_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-clause-case-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Clause Case Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Clause Case Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'clause.case@example.invalid' };
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Clause case fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'code-hex', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Add a HEX key', '--description', 'Show HEX.');
  sflow('prepare', 'intake');
  const intake = await readFile(path.join(root, 'singularity/work-items/code-hex/artifacts/intake/intake.md'), 'utf8');
  assert.match(intake, /^# code-hex — /mu, 'the title keeps the Work ID as written');
  assert.match(intake, /^\| \[CODE-HEX:AC-001\] \|/mu, 'the clause anchor is in its canonical form');
  assert.match(intake, /^\| `CODE-HEX:AC-001` \|/mu, 'the planned-evidence row names the same ID');
  assert.doesNotMatch(intake, /code-hex:AC-/u);
});

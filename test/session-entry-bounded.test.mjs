import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { completeAgentResult, DEFAULT_AGENT_OUTPUT_BYTES } from '../src/agent-output.mjs';
import { SESSION_ENTRY_PAUSE_GUARD } from '../src/copilot-mode.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(packageRoot, 'bin/singularity-flow.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * A Story pinned to the whole approved configuration: its pin lists every configuration file's
 * hashes (169 here, 55 KB), the shape a real Story's session entry spilled with on 2026-10-27.
 */
async function pinnedStory(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-entry-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'origin.git'), app = path.join(parent, 'app'), config = path.join(parent, 'config');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Entry Tester', NO_COLOR: '1', HOME: parent };
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: app, encoding: 'utf8', env });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  git(parent, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(app);
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'config', 'user.name', 'Entry Tester'); git(app, 'config', 'user.email', 'entry@example.invalid');
  await writeFile(path.join(app, 'package.json'), '{"type":"module","private":true}\n');
  git(app, 'add', '.'); git(app, 'commit', '-qm', 'application');
  git(app, 'remote', 'add', 'origin', remote); git(app, 'push', '-q', '-u', 'origin', 'main');
  await mkdir(config);
  git(config, 'init', '-q', '-b', 'sflow/config');
  git(config, 'config', 'user.name', 'Entry Tester'); git(config, 'config', 'user.email', 'entry@example.invalid');
  await initializeDefinition(config);
  const file = path.join(config, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(file, 'utf8'));
  workflow.worldModel.grounding = 'off';
  workflow.approvalSecurity = { profile: 'poc' };
  workflow.repositoryReadiness = { ...(workflow.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(workflow.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(file, YAML.stringify(workflow));
  git(config, 'add', '-A'); git(config, 'commit', '-qm', 'approved configuration');
  git(config, 'remote', 'add', 'origin', remote); git(config, 'push', '-q', 'origin', 'sflow/config');
  // A start agent outside the work type's closure keeps the whole approved copy.
  cli('start', 'ENTRY-1', '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--agent', 'demo-web-tester',
    '--target-url', 'https://staging.example.test', '--title', 'Entry', '--description', 'A pinned Story.');
  return { app, cli };
}

test('a Story skill turn\'s session entry fits in view with its binding, however large the pinned configuration', async t => {
  const { cli } = await pinnedStory(t);
  // The exact entry every Story read skill (/sf-decide among them) runs first.
  const entry = SESSION_ENTRY_PAUSE_GUARD.match(/`singularity-flow (session current [^`]+)`/u)[1].split(' ');
  assert.ok((await readFile(path.join(packageRoot, 'plugin/skills/sflow-decide/SKILL.md'), 'utf8')).includes(SESSION_ENTRY_PAUSE_GUARD));
  const full = JSON.parse(cli('session', 'current', '--json'));
  const pin = full.executionContext.story.configurationPin;
  assert.ok(Object.keys(pin.assets).length > 100, 'the fixture pins the whole approved configuration');

  const stdout = cli(...entry);
  const view = JSON.parse(stdout);
  assert.ok(Buffer.byteLength(stdout) <= DEFAULT_AGENT_OUTPUT_BYTES, `the entry is ${Buffer.byteLength(stdout)} bytes`);
  assert.equal(view.agentOutput, undefined, 'nothing was spilled, so the turn has nothing to read before its own work');
  assert.equal(view.omittedFields, undefined);
  assert.equal(view.act.state, 'read');
  assert.equal(view.act.do, null);
  // The binding, whole; the pin by its identity, never its per-file catalog.
  assert.equal(view.workId, 'ENTRY-1');
  assert.equal(view.executionContext.contextId, full.executionContext.contextId);
  assert.deepEqual(view.executionContext.story.binding, full.executionContext.story.binding);
  assert.equal(view.executionContext.story.binding.baseRef, 'main');
  const { files, assets, removed, closure, ...identity } = pin;
  assert.deepEqual(view.executionContext.story.configurationPin, { ...identity, assetCount: Object.keys(assets).length });

  // Opening the session is bounded the same way: its full result holds no catalog either.
  const opened = completeAgentResult(cli('session', 'open', 'ENTRY-1', '--for-agent', '--json'));
  assert.equal(opened.workId, 'ENTRY-1');
  assert.deepEqual(opened.executionContext.story.configurationPin, view.executionContext.story.configurationPin);
});

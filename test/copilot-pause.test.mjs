import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copilotPauseGuardForSkill, COPILOT_PAUSE_MARKER, copilotModeFile, readCopilotMode, setCopilotPaused
} from '../src/copilot-mode.mjs';
import { copilotAgentStartHook, sessionStartAgentHook, agentGuardHook } from '../src/agent-hooks.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { installDirectSkills, renderDirectSkill } from '../src/direct-skills.mjs';
import { loadSkillPolicy } from '../scripts/skill-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');
const sourceRoot = path.join(root, 'plugin', 'skills');

test('pause is persistent, bounded machine-local state and corrupt state never activates guidance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-pause-state-'));
  const file = path.join(directory, 'mode.json');
  assert.equal(copilotModeFile({}, directory), path.join(directory, '.singularity-flow', 'copilot-mode.json'));
  assert.equal(copilotModeFile({ SINGULARITY_FLOW_COPILOT_MODE_FILE: file }), file);
  assert.equal(readCopilotMode(file).paused, false);
  assert.equal((await setCopilotPaused(true, file)).paused, true);
  assert.equal(readCopilotMode(file).paused, true);
  assert.equal((await setCopilotPaused(false, file)).paused, false);
  await writeFile(file, '{broken');
  assert.deepEqual(readCopilotMode(file), { paused: true, stateAvailable: false, changedAt: null });
  assert.equal((await setCopilotPaused(false, file)).stateAvailable, true);
  await writeFile(file, 'x'.repeat(4097));
  assert.equal(readCopilotMode(file).paused, true);
  await writeFile(file, '{"schemaVersion":999,"paused":false}');
  assert.equal(readCopilotMode(file).paused, true, 'a newer unsupported shape cannot activate guidance');
});

test('pause rejects symlink writes and conservatively ignores unsafe mode state', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-pause-link-'));
  const outside = path.join(directory, 'personal.json');
  const file = path.join(directory, 'mode.json');
  await writeFile(outside, 'personal');
  await symlink(outside, file);
  assert.equal(readCopilotMode(file).paused, true);
  await assert.rejects(setCopilotPaused(false, file), { code: 'COPILOT_MODE_PATH_UNSAFE' });
  assert.equal(await readFile(outside, 'utf8'), 'personal');
});

test('pause, paused Home and hooks work without Git or any workspace, and leave work untouched', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-pause-cli-'));
  const file = path.join(directory, 'mode.json');
  const env = { ...process.env, PATH: '', SINGULARITY_FLOW_COPILOT_MODE_FILE: file,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'bad-registry.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'bad-selection.json') };
  await writeFile(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, '{broken');
  await writeFile(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, '{broken');
  await writeFile(path.join(directory, 'draft.md'), 'Uncommitted native work');
  const invoke = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    if (args[0] === 'pause') assert.equal(payload.resultType, 'command-result');
    return payload.data ?? payload;
  };
  const paused = invoke(['pause', '--json']);
  assert.equal(paused.paused, true);
  assert.equal(paused.storyStateChanged, false);
  assert.equal(paused.repositoryChanged, false);
  // Skills carry a short guard; the full paused rules arrive here, only while paused.
  assert.match(paused.agentInstruction, /answer as native Copilot/);
  assert.match(paused.agentInstruction, /only offer `\/sf-pause off`; never resume implicitly/);
  const status = invoke(['pause', 'status', '--json']);
  assert.equal(status.agentInstruction, paused.agentInstruction);
  assert.equal(invoke(['home', '--json', '--request', 'write ordinary code']).nativeCopilot, true);
  assert.equal(invoke(['phase', 'enter', '--for-agent', '--json']).nativeCopilot, true);
  assert.equal(invoke(['phase', 'enter', '--compose', '--for-agent', '--json']).nativeCopilot, true);
  assert.equal(invoke(['nextsteps', '--for-agent', '--json']).nativeCopilot, true);
  assert.equal(invoke(['inputs', '--dry-run', '--for-agent', '--json']).nativeCopilot, true);
  assert.equal(invoke(['inputs', '--for-agent', '--json']).nativeCopilot, true);
  assert.equal(invoke(['review-source', 'context', '--for-agent', '--json']).nativeCopilot, true);
  assert.equal(invoke(['review-source', 'context', 'custom-plan', '--for-agent', '--json']).nativeCopilot, true);
  for (const args of [['review-source', 'context', '--for-agent', '--allow-dirty', '--json'],
    ['review-source', 'submit', '--for-agent', '--json'], ['review-source', 'decide', '--for-agent', '--json']]) {
    const invalid = spawnSync(process.execPath, [cli, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(invalid.status, 0);
    assert.equal(JSON.parse(invalid.stdout).error.code, 'REVIEW_SOURCE_OPTIONS_INVALID');
  }
  for (const command of ['inputs', 'nextsteps']) {
    const invalid = spawnSync(process.execPath, [cli, command, '--for-agent', '--allow-dirty', '--json'],
      { cwd: directory, env, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(invalid.status, 0);
    assert.equal(JSON.parse(invalid.stdout).error.code, `${command.toUpperCase()}_OPTIONS_INVALID`);
  }
  for (const event of ['agent-start', 'session-start', 'agent-guard', 'turn-intent', 'turn-end']) {
    assert.deepEqual(invoke(['hook', event]), {});
  }
  assert.equal(invoke(['pause', 'status', '--json']).paused, true);
  const refusal = spawnSync(process.execPath, [cli, 'start', '--json'], { cwd: directory, env, encoding: 'utf8' });
  assert.notEqual(refusal.status, 0, 'pause cannot bypass explicit lifecycle command validation');
  assert.equal(JSON.parse(refusal.stdout).resultType, 'sflow-refusal-plan');
  assert.equal(invoke(['pause', 'off', '--json']).paused, false);
  assert.equal(invoke(['pause', 'status', '--json']).paused, false);
  assert.equal(await readFile(path.join(directory, 'draft.md'), 'utf8'), 'Uncommitted native work');
  assert.deepEqual((await readdir(directory)).sort(), ['bad-registry.json', 'bad-selection.json', 'draft.md', 'mode.json']);
});

test('all host hook helpers no-op before repository reads or session writes when paused', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-pause-hooks-'));
  const file = path.join(directory, 'mode.json');
  await setCopilotPaused(true, file);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = file;
  try {
    assert.deepEqual(await copilotAgentStartHook(null, { agentName: 'sflow-workflow' }), {});
    assert.deepEqual(await sessionStartAgentHook(null, null, null, {}), {});
    assert.deepEqual(await agentGuardHook(null, null, null, {}), {});
  } finally {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
  }
});

test('every packaged and direct skill is explicit-only and guards pause before boundary lookup', async () => {
  const { policy } = await loadSkillPolicy(root);
  assert.deepEqual(policy.automaticInvocationAllowlist, []);
  for (const [name, entry] of Object.entries(policy.skills)) {
    const source = await readFile(path.join(sourceRoot, name, 'SKILL.md'), 'utf8');
    assert.match(source, /^disable-model-invocation: true$/mu, name);
    if (name !== 'sflow-pause' && entry.class !== 'delegation') {
      assert.ok(source.includes(copilotPauseGuardForSkill(name)), name);
      assert.ok(source.indexOf(COPILOT_PAUSE_MARKER) < source.indexOf('<!-- sflow-execution-boundary -->'), name);
    }
    assert.match(renderDirectSkill(source, name), /^disable-model-invocation: true$/mu);
  }
  for (const agent of ['sflow-workflow', 'sflow-utility', 'sflow-source-reviewer']) {
    const source = await readFile(path.join(root, 'plugin', 'agents', `${agent}.agent.md`), 'utf8');
    assert.ok(source.indexOf('singularity-flow pause status') < source.indexOf('Resolve the active Story checkout'), agent);
  }
});

test('skill reinstall preserves pause, personal skills and the available mode control', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-pause-reinstall-'));
  const file = path.join(directory, 'mode.json');
  const targetRoot = path.join(directory, 'skills');
  await setCopilotPaused(true, file);
  await mkdir(path.join(targetRoot, 'sf-personal'), { recursive: true });
  await writeFile(path.join(targetRoot, 'sf-personal', 'SKILL.md'), 'Personal skill; not SFlow managed.');
  installDirectSkills({ sourceRoot, targetRoot });
  assert.equal(readCopilotMode(file).paused, true);
  assert.equal(await readFile(path.join(targetRoot, 'sf-personal', 'SKILL.md'), 'utf8'), 'Personal skill; not SFlow managed.');
  const control = await readFile(path.join(targetRoot, 'sf-pause', 'SKILL.md'), 'utf8');
  assert.match(control, /singularity-flow pause off --json/);
  assert.doesNotMatch(control, /<!-- sflow-copilot-pause -->/);
});

test('pause operations are model-free and guidance preserves exact on/off/status selectors', () => {
  for (const action of ['on', 'off', 'status']) {
    const operation = resolveOperation({ requestedCommand: 'pause', positionals: ['pause', action] });
    assert.equal(operation.modelPolicy, 'never');
    assert.equal(operation.classification, action === 'status' ? 'read' : 'mutation');
    assert.equal(copilotCommandForCommand(`singularity-flow pause ${action} --json`), `/sf-pause ${action}`);
  }
  assert.equal(copilotCommandForCommand('singularity-flow pause'), '/sf-pause');
});

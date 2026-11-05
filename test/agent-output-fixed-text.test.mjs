/**
 * Fixed text is named, not repeated. `[OUT:REQ-030]` `[OUT:REQ-031]` `[OUT:REQ-033]`
 *
 * Recorded sessions (2026-10-18 to 10-22, 432 SFlow results) carried the 417-byte path rule in 286
 * results, 51 of them returning no path at all, and the bounded-read instruction in 279. Every skill
 * states both rules in full, so a result names the rule in one sentence and only where it applies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { boundedAgentOutput, returnsAgentPaths } from '../src/agent-output.mjs';
import { sessionAgentResult } from '../src/session-agent-entry.mjs';
import { CLI_PATH_CONTRACT, CLI_PATH_REFERENCE } from '../src/safe-command-guidance.mjs';
import { COMPLETE_OUTPUT_CONTRACT } from '../scripts/skill-policy.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fixed-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  return root;
}

test('act names the path rule only on results that return paths the agent uses', async (t) => {
  const root = await repository(t);
  const view = async (result) => JSON.parse(await boundedAgentOutput(JSON.stringify({ repositoryPath: root, ...result }), { cwd: root }));
  const families = [
    [{ resultType: 'command-result', status: 'ok', data: { paused: false } }, false, 'pause state: cwd only'],
    [{ resultType: 'sflow-nextsteps', actions: [{ command: 'singularity-flow status --json' }] }, false, 'commands are not paths'],
    [{ resultType: 'sflow-refusal-plan', error: { code: 'X', message: 'No story.' } }, false, 'a refusal without a file'],
    [{ resultType: 'sflow-phase-entry', status: 'authoring-entry', stagingPath: '.git/sflow/staging/a.md' }, true, 'staging path'],
    [{ resultType: 'sflow-phase-prepublish', status: 'correct', findings: [{ code: 'F', path: 'src/a.js', line: 3 }] }, true, 'a finding to open'],
    [{ resultType: 'sflow-session-entry', workItemRoot: 'singularity/work-items' }, true, 'the work-item root'],
    [{ resultType: 'scope', changes: { files: ['README.md'] } }, true, 'a list of files'],
    [{ resultType: 'large', notes: Array.from({ length: 400 }, (_, index) => `note ${index} without any path in it`) }, true, 'a bounded view returns its own file']
  ];
  for (const [result, expected, why] of families) {
    const shown = await view(result);
    assert.equal(shown.act.paths === CLI_PATH_REFERENCE, expected, why);
    if (!expected) assert.equal('paths' in shown.act, false, why);
  }
  assert.equal(returnsAgentPaths({ repositoryPath: root }), false, 'repositoryPath alone is the command cwd');
  assert.equal(returnsAgentPaths({ artifact: { path: 'C:\\clone\\review.json' } }), true, 'Windows paths count');
  // The full rule stays where every turn reads it once.
  assert.ok(CLI_PATH_CONTRACT.length > CLI_PATH_REFERENCE.length);
  for (const fact of ['exactly as given', 'repositoryPath', '.git/worktrees', 'search for or recreate']) assert.ok(CLI_PATH_REFERENCE.includes(fact), fact);
});

test('no fixed instruction a result repeats is over 200 bytes', async (t) => {
  const root = await repository(t);
  const large = { resultType: 'sflow-phase-entry', status: 'clarification-required', repositoryPath: root,
    clarification: { checkpoint: { stage: 'derive-questions', instruction: 'Ask.' } },
    recovery: { blockers: Array.from({ length: 60 }, (_, index) => ({ id: index, detail: 'x'.repeat(120) })) } };
  const bounded = JSON.parse(await boundedAgentOutput(JSON.stringify(large), { cwd: root }));
  const session = sessionAgentResult({ repositoryPath: root, ready: true, workId: 'W-1' }, 'singularity/work-items');
  const source = await readFile(new URL('../src/commands/session-open.mjs', import.meta.url), 'utf8');
  const open = source.match(/agentInstruction: 'Reuse this verified[^']*'/u)?.[0];
  assert.ok(open, 'the session-open instruction is present in the source on every platform');
  const fixed = { 'act.paths': bounded.act.paths, 'agentOutput.instruction': bounded.agentOutput.instruction,
    'session agentInstruction': session.agentInstruction, 'session-open agentInstruction': open.replace(/^agentInstruction: '|'$/gu, '') };
  for (const [field, text] of Object.entries(fixed)) {
    assert.ok(text, field);
    assert.ok(bytes(text) <= 200, `${field}: ${bytes(text)} bytes`);
  }
  // The skill layer still holds what the short forms name.
  assert.match(COMPLETE_OUTPUT_CONTRACT, /agentOutput\.read[^;]*need[^;]*in one response[^;]*;[^.]*omittedFields[^.]*optional/u);
  assert.match(session.agentInstruction, /literally[^.]*never in artifacts or approval identity/u);
});

test('a small result\'s agent view is never larger than its JSON by more than act', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-fixed-text-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  const machine = path.join(directory, 'machine');
  await mkdir(root); await mkdir(machine);
  const env = { ...process.env, HOME: machine, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Fixed Text Tester',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(machine, 'copilot-mode.json') };
  const run = (args, check = true) => {
    const result = spawnSync(args[0] === 'git' ? 'git' : process.execPath, args[0] === 'git' ? args.slice(1) : [cli, ...args], { cwd: root, env, encoding: 'utf8' });
    if (check) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run(['git', 'init', '-q', '-b', 'main']);
  run(['git', 'config', 'user.name', 'Fixed Text Tester']);
  run(['git', 'config', 'user.email', 'fixed-text@example.test']);
  await writeFile(path.join(root, 'README.md'), '# Fixed text fixture\n');
  run(['--no-model', 'init']);
  run(['git', 'add', '.']); run(['git', 'commit', '-q', '-m', 'Fixture']);
  // The same result both ways: a command's --for-agent entry may answer differently (a strict refusal
  // where --json reports no Story), so each real JSON result is presented as an agent view.
  let small = 0;
  for (const command of [['about'], ['status'], ['nextsteps'], ['capabilities', 'list'], ['pause', 'status'], ['version']]) {
    const full = run([...command, '--json'], false).stdout;
    let parsed; try { parsed = JSON.parse(full); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const agent = await boundedAgentOutput(full, { cwd: root });
    const view = JSON.parse(agent);
    if (view.agentOutput) continue;
    small += 1;
    assert.ok(bytes(agent) <= bytes(full) + bytes(view.act ?? ''),
      `${command.join(' ')}: view ${bytes(agent)} > JSON ${bytes(full)} + act ${bytes(view.act ?? '')}`);
  }
  assert.ok(small >= 3, `${small} small results measured`);
});

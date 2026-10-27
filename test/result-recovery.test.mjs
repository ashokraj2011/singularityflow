/**
 * A result an agent's host cut off, or returned while the command still ran, is read again whole with
 * `result last --wait`, never by running the command again (office, 2026-10-27: /sf-code's prepublish
 * came back partial, the agent never saw which requirements lacked a test and pointed back to /sf-code).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentResultsDirectory, beginAgentResult, keepAgentResult, KEPT_RESULTS_PER_CHECKOUT, lastAgentResult
} from '../src/agent-result-keeper.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { keptResultView, run as resultCommand } from '../src/commands/result.mjs';
import { withCliJsonOutput } from '../src/cli-json-output.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { commandClass } from '../apps/vscode/src/cli/client.ts';
import { parseArgs } from '../src/util.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function checkout(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-result-recovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  return { base, root, env: { ...process.env, SINGULARITY_FLOW_AGENT_RESULTS: path.join(base, 'results') } };
}

/** A process that is alive until the test ends it. */
function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  return child;
}

test('a command keeps its whole result; result last returns it from anywhere in the checkout', async (t) => {
  const { root, env } = await checkout(t);
  const run = beginAgentResult(['phase', 'prepublish', 'implementation', '--for-agent', '--json', '--reason', 'secret words'], { cwd: root, env });
  assert.equal(run.command, 'singularity-flow phase prepublish implementation --for-agent --json --reason', 'option values are never kept');
  const running = await lastAgentResult({ cwd: root, env });
  assert.equal(running.status, 'running', 'this process is still running it');
  keepAgentResult(run, '{"resultType":"sflow-phase-prepublish","status":"draft-invalid"}\n');
  const found = await lastAgentResult({ cwd: path.join(root, 'src', 'deep'), env });
  assert.equal(found.status, 'kept');
  assert.equal(found.kept.command, run.command);
  assert.match(found.kept.output, /draft-invalid/u);
  assert.deepEqual(await readdir(path.join(agentResultsDirectory(root, env), 'running')), [], 'its running marker is cleared');
  assert.equal(agentResultsDirectory(path.join(root, 'src'), env), agentResultsDirectory(root, env), 'one checkout, one place');
});

test('result last waits while a command still runs, then returns its result, not a read made meanwhile', async (t) => {
  const { root, env } = await checkout(t);
  // The office case: prepublish still running after the host returned; the agent ran a read meanwhile.
  const long = beginAgentResult(['phase', 'prepublish', 'implementation', '--for-agent', '--json'], { cwd: root, env, now: 1_000 });
  const read = beginAgentResult(['phase', 'show', '--for-agent', '--json'], { cwd: root, env, now: 2_000 });
  keepAgentResult(read, '{"resultType":"phase-show"}', { now: 3_000 });
  let now = 10_000;
  let slept = 0;
  const found = await lastAgentResult({ cwd: root, env, wait: 30, clock: () => now, sleep: async (ms) => {
    now += ms; slept += ms;
    if (slept >= 2_000 && !long.kept) keepAgentResult(long, '{"resultType":"sflow-phase-prepublish","status":"draft-invalid"}', { now });
  } });
  assert.equal(found.status, 'kept');
  assert.equal(found.kept.command, 'singularity-flow phase prepublish implementation --for-agent --json');
  assert.deepEqual(found.others.map((entry) => entry.command), ['singularity-flow phase show --for-agent --json']);
  // Past the wait, it says the command still runs; nothing is guessed.
  beginAgentResult(['tests', 'run', '--for-agent', '--json'], { cwd: root, env });
  let later = 0;
  const still = await lastAgentResult({ cwd: root, env, wait: 1, clock: () => later, sleep: async (ms) => { later += ms; } });
  assert.deepEqual([still.status, still.running.map((entry) => entry.command)], ['running', ['singularity-flow tests run --for-agent --json']]);
  // --command picks the newest of one command.
  assert.equal((await lastAgentResult({ cwd: root, env, command: 'phase show' })).status, 'running', 'it still waits for the running one first');
});

test('a command that ended without a result is named, to run once more; only the newest few are kept', async (t) => {
  const { root, env } = await checkout(t);
  const child = sleeper(t);
  const directory = agentResultsDirectory(root, env);
  await mkdir(path.join(directory, 'running'), { recursive: true });
  const marker = { schema: 'sflow-running-agent-command@1', id: 'abc', directory, command: 'singularity-flow phase prepublish implementation --for-agent --json',
    startedAt: new Date().toISOString(), pid: child.pid };
  await writeFile(path.join(directory, 'running', 'abc.json'), JSON.stringify(marker));
  assert.equal((await lastAgentResult({ cwd: root, env })).status, 'running');
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  const ended = await lastAgentResult({ cwd: root, env });
  assert.deepEqual([ended.status, ended.interrupted.command], ['interrupted', marker.command]);
  assert.deepEqual(await readdir(path.join(directory, 'running')), [], 'the marker is cleared once named');

  for (let index = 0; index < KEPT_RESULTS_PER_CHECKOUT + 2; index += 1) {
    keepAgentResult(beginAgentResult(['nextsteps', String(index), '--json'], { cwd: root, env }), `{"n":${index}}`, { now: 5_000 + index });
  }
  assert.equal((await readdir(path.join(directory, 'kept'))).length, KEPT_RESULTS_PER_CHECKOUT);
  const newest = await lastAgentResult({ cwd: root, env });
  assert.equal(JSON.parse(newest.kept.output).n, KEPT_RESULTS_PER_CHECKOUT + 1);
  assert.equal(JSON.parse((await lastAgentResult({ cwd: root, env, command: 'nextsteps 3' })).kept.output).n, 3);
});

test('Copilot acts on a kept result as its command returned it; a running one is a wait, never a loop', () => {
  const kept = keptResultView({ status: 'kept', others: [], kept: { command: 'singularity-flow phase prepublish implementation --for-agent --json',
    startedAt: 'a', finishedAt: 'b', output: JSON.stringify({ resultType: 'sflow-phase-prepublish', status: 'draft-invalid',
      findings: [{ code: 'SPEC_COVERAGE_INCOMPLETE', message: 'REQ-002 has no test.' }], correction: { guidance: 'Write the missing tests now.' } }) } });
  assert.equal(kept.keptResult.command, 'singularity-flow phase prepublish implementation --for-agent --json');
  const act = agentAct(kept);
  assert.equal(act.state, 'correct');
  assert.match(act.said, /Write the missing tests now/u);
  const running = agentAct(keptResultView({ status: 'running', running: [{ command: 'singularity-flow phase prepublish implementation --for-agent --json', startedAt: 'a' }] }));
  assert.equal(running.state, 'wait');
  assert.equal(running.do.shell, 'singularity-flow result last --wait --for-agent --json');
  assert.match(running.said, /never run the command itself again/u);
  assert.match(agentAct(keptResultView({ status: 'interrupted', interrupted: { command: 'singularity-flow tests run', startedAt: 'a' } })).said,
    /singularity-flow tests run ended without a result[^.]*\. Run it again once/u);
  assert.equal(agentAct(keptResultView({ status: 'none' })).state, 'read');
});

test('result last is a read for the CLI and VS Code alike', () => {
  for (const argv of [['result', 'last', '--json'], ['result', 'last', '--wait', '--json'], ['result', 'last', '--command', 'phase prepublish', '--json']]) {
    const operation = resolveOperation({ requestedCommand: argv[0], ...parseArgs(argv) });
    assert.equal(operation.classification, 'read', argv.join(' '));
    assert.equal(commandClass(argv), 'read', argv.join(' '));
  }
});

test('the real CLI keeps an agent result and a refusal, and result last returns each act first', async (t) => {
  const { root, env: base } = await checkout(t);
  await rm(path.join(root, '.git'), { recursive: true, force: true });
  spawnSync('git', ['init', '-q', root]);
  const env = { ...base, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1' };
  delete env.NODE_TEST_CONTEXT;
  const sflow = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  const paused = sflow('pause', 'status', '--for-agent', '--json');
  assert.equal(paused.status, 0, paused.stderr);
  const first = JSON.parse(sflow('result', 'last', '--for-agent', '--json').stdout);
  assert.equal(first.keptResult.command, 'singularity-flow pause status --for-agent --json');
  assert.ok(first.act, 'the kept result is shown act first, like any agent result');

  const refused = sflow('phase', 'prepublish', 'implementation', '--for-agent', '--json');
  assert.notEqual(refused.status, 0);
  const again = sflow('result', 'last', '--for-agent', '--json');
  assert.equal(again.status, 0, again.stderr);
  const kept = JSON.parse(again.stdout);
  assert.equal(kept.keptResult.command, 'singularity-flow phase prepublish implementation --for-agent --json');
  assert.equal(kept.act.state, 'refused', 'a refusal is kept too, with its own route');
  assert.equal(JSON.parse(sflow('result', 'last', '--json').stdout).keptResult.command, kept.keptResult.command,
    'reading it never replaces it');
  const bad = sflow('result', 'show', '--json');
  assert.equal(JSON.parse(bad.stdout).error.code, 'RESULT_COMMAND_INVALID');
});

test('a composite\'s nested step neither replaces the composite\'s run nor keeps its own output as the result', async (t) => {
  const { root, env } = await checkout(t);
  const outer = beginAgentResult(['phase', 'prepublish', 'implementation', '--publish-if-ready', '--for-agent', '--json'], { cwd: root, env });
  globalThis.__SFLOW_AGENT_RESULT_RUN = outer;
  globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 1;
  const write = process.stdout.write;
  t.after(() => { globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 0; globalThis.__SFLOW_AGENT_RESULT_RUN = null; process.stdout.write = write; });
  process.stdout.write = () => true;
  try {
    await withCliJsonOutput(true, async () => { console.log('{"resultType":"nested-read"}'); }, { forAgent: true, kind: 'status', argv: ['status', '--for-agent', '--json'] });
  } finally { process.stdout.write = write; }
  assert.equal(globalThis.__SFLOW_AGENT_RESULT_RUN, outer, 'the nested read leaves the composite\'s run in place');
  keepAgentResult(outer, '{"resultType":"nested-refusal"}');
  assert.equal(outer.kept, undefined, 'a nested step\'s refusal is never kept as the composite\'s result');
  globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 0;
  keepAgentResult(outer, '{"resultType":"sflow-refusal-plan","error":{"code":"PHASE_PUBLISH_REFUSED"}}');
  const found = await lastAgentResult({ cwd: root, env });
  assert.equal(found.kept.command, 'singularity-flow phase prepublish implementation --publish-if-ready --for-agent --json');
  assert.match(found.kept.output, /PHASE_PUBLISH_REFUSED/u, 'the composite\'s own refusal is the kept result');
});

test('result last looks where the command was run from, not the Story checkout it moved into', async (t) => {
  const { base, root, env } = await checkout(t);
  const chat = path.join(base, 'chat-folder');
  await mkdir(chat);
  keepAgentResult(beginAgentResult(['phase', 'prepublish', 'implementation', '--for-agent', '--json'], { cwd: chat, env }), '{"resultType":"sflow-phase-prepublish"}');
  const printed = [];
  const log = console.log;
  const previousEnv = process.env.SINGULARITY_FLOW_AGENT_RESULTS;
  const previousCwd = process.cwd();
  t.after(() => { console.log = log; process.chdir(previousCwd); globalThis.__SFLOW_INVOCATION_CWD = undefined;
    if (previousEnv === undefined) delete process.env.SINGULARITY_FLOW_AGENT_RESULTS; else process.env.SINGULARITY_FLOW_AGENT_RESULTS = previousEnv; });
  process.env.SINGULARITY_FLOW_AGENT_RESULTS = env.SINGULARITY_FLOW_AGENT_RESULTS;
  globalThis.__SFLOW_INVOCATION_CWD = chat;
  process.chdir(root);
  console.log = (text) => printed.push(text);
  await resultCommand(['result', 'last', '--json'], { positionals: ['result', 'last'], options: { json: true } });
  console.log = log;
  assert.equal(JSON.parse(printed[0]).keptResult.command, 'singularity-flow phase prepublish implementation --for-agent --json');
});

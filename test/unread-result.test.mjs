/**
 * A result the host never showed reaches the agent through the post-tool hook [office, 2026-11-12]: VS Code ran
 * `session open --for-agent --json`, showed nothing (once only "exit code 1"), and the agent asked the person for
 * the error. The CLI had kept the result; the hook now adds it to the agent's context (src/unread-result.mjs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { beginAgentResult, keepAgentResult } from '../src/agent-result-keeper.mjs';
import { unreadResultContext, withUnreadResult } from '../src/unread-result.mjs';
import { repositoryPostToolGuard, repositoryToolFailure } from '../src/copilot-repository-boundary.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const REFUSAL = JSON.stringify({ schemaVersion: 1, resultType: 'sflow-refusal-plan', status: 'failed',
  error: { code: 'SESSION_SCOPE_REQUIRED', message: 'Choose the workspace this chat works in.' },
  remediationPlan: { schemaVersion: 1, status: 'blocked', code: 'SESSION_SCOPE_REQUIRED', steps: [] } }, null, 2);

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-unread-')));
  const root = path.join(directory, 'repository');
  await mkdir(root);
  spawnSync('git', ['init', '-q'], { cwd: root });
  const env = { ...process.env, SINGULARITY_FLOW_AGENT_RESULTS: path.join(directory, 'agent-results') };
  const saved = { results: process.env.SINGULARITY_FLOW_AGENT_RESULTS, mode: process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE };
  process.env.SINGULARITY_FLOW_AGENT_RESULTS = env.SINGULARITY_FLOW_AGENT_RESULTS;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    for (const [name, value] of [['SINGULARITY_FLOW_AGENT_RESULTS', saved.results], ['SINGULARITY_FLOW_COPILOT_MODE_FILE', saved.mode]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const keep = (argv, text, now = Date.now(), view = null) => keepAgentResult(beginAgentResult(argv, { cwd: root, env, now }), text, { now, view });
  return { directory, root, env, keep };
}

// VS Code's own chat: run_in_terminal's input and an empty response; Copilot CLI: bash with JSON args and toolResult.
const vscode = (root, command, response = '') => ({ cwd: root, sessionId: 'unread', tool_name: 'run_in_terminal',
  tool_input: { command, explanation: 'Open the session', isBackground: false }, tool_response: response });
const copilotCli = (root, command, text = '') => ({ cwd: root, sessionId: 'unread', toolName: 'bash',
  toolArgs: JSON.stringify({ command, description: 'Open the session' }), toolResult: { resultType: 'success', textResultForLlm: text } });

test('a kept --for-agent result the terminal did not show is handed to the agent, on both hosts', async (t) => {
  const { root, env, keep } = await fixture(t);
  keep(['session', 'open', '--for-agent', '--json'], REFUSAL);
  for (const payload of [vscode(root, 'singularity-flow session open --for-agent --json'),
    vscode(root, 'singularity-flow session open --for-agent --json', { exitCode: 1, output: '' }),
    copilotCli(root, 'cd /tmp && singularity-flow session open --for-agent --json')]) {
    const context = await unreadResultContext(payload, { env });
    assert.match(context, /^SFlow: your terminal did not show the result of `singularity-flow session open --for-agent --json`\. SFlow kept it/u);
    assert.match(context, /never run the command again, and never ask the person for its output/u);
    assert.match(context, /SESSION_SCOPE_REQUIRED/u, 'the refusal itself, as the command returned it');
  }
});

test('nothing is added when the result was shown, the command is not an agent read, or the kept one is old', async (t) => {
  const { root, env, keep } = await fixture(t);
  keep(['session', 'open', '--for-agent', '--json'], REFUSAL, Date.now() - 20 * 60 * 1000);
  assert.equal(await unreadResultContext(vscode(root, 'singularity-flow session open --for-agent --json'), { env }), null, 'older than 15 minutes');
  keep(['session', 'open', '--for-agent', '--json'], REFUSAL);
  assert.equal(await unreadResultContext(vscode(root, 'singularity-flow session open --for-agent --json', `Output:\n${REFUSAL}`), { env }), null);
  assert.equal(await unreadResultContext(copilotCli(root, 'singularity-flow session open --for-agent --json', REFUSAL), { env }), null);
  assert.equal(await unreadResultContext(vscode(root, 'singularity-flow session open --json'), { env }), null, 'only --for-agent results are kept');
  assert.equal(await unreadResultContext(vscode(root, 'git status'), { env }), null);
  assert.equal(await unreadResultContext({ cwd: root, tool_name: 'read_file', tool_input: { filePath: 'x', command: 'singularity-flow session open --for-agent' } }, { env }), null);
});

test('a command still running is read with result last --wait, never run again', async (t) => {
  const { root, env } = await fixture(t);
  beginAgentResult(['phase', 'prepublish', 'implementation', '--for-agent', '--json'], { cwd: root, env });
  const context = await unreadResultContext(vscode(root, 'singularity-flow phase prepublish implementation --for-agent --json'), { env });
  assert.match(context, /it is still running\. Read its result with `singularity-flow result last --wait --command "phase prepublish implementation" --for-agent --json`\. Never run it again/u);
});

test('the post-tool and failed-tool hooks add the kept result, in a plain chat too', async (t) => {
  const { root, keep } = await fixture(t);
  keep(['session', 'open', '--for-agent', '--json'], REFUSAL);
  const after = await repositoryPostToolGuard(vscode(root, 'singularity-flow session open --for-agent --json'));
  assert.match(after.additionalContext ?? '', /SESSION_SCOPE_REQUIRED/u, JSON.stringify(after));
  const failed = await repositoryToolFailure({ ...vscode(root, 'singularity-flow session open --for-agent --json'), error: 'no active terminal instance' });
  assert.match(failed.additionalContext ?? '', /SFlow kept it/u, JSON.stringify(failed));
  // Context the guard already gave is kept, and the result follows it.
  assert.deepEqual(withUnreadResult({ continue: false, additionalContext: 'Stop.' }, 'Kept.'), { continue: false, additionalContext: 'Stop.\n\nKept.' });
});

test('the view the agent was shown is what it gets; a large result without one is read with result last', async (t) => {
  const { root, env, keep } = await fixture(t);
  keep(['session', 'open', '--for-agent', '--json'], REFUSAL, Date.now(), '{"act":{"state":"stop"},"shown":"bounded view"}');
  const context = await unreadResultContext(vscode(root, 'singularity-flow session open --for-agent --json'), { env });
  assert.match(context, /"shown":"bounded view"/u);
  assert.doesNotMatch(context, /SESSION_SCOPE_REQUIRED/u, 'the whole output stays kept, not given twice');
  keep(['session', 'open', '--for-agent', '--json'], JSON.stringify({ resultType: 'x', filler: 'y'.repeat(9000) }));
  assert.match(await unreadResultContext(vscode(root, 'singularity-flow session open --for-agent --json'), { env }),
    /Read it with `singularity-flow result last --command "session open" --for-agent --json`; never run the command again/u);
});

test('the office case: session open refuses, the host shows nothing, and the agent is given the refusal with its next step', async (t) => {
  const { directory, env } = await fixture(t);
  // A chat folder with no repository and no workspace: `session open` refuses, exit 1, and keeps its refusal.
  const folder = path.join(directory, 'chat');
  await mkdir(folder);
  const ran = spawnSync(process.execPath, [CLI, 'session', 'open', '--for-agent', '--json'], { cwd: folder, encoding: 'utf8', env });
  assert.notEqual(ran.status, 0, ran.stdout);
  const shown = ran.stdout.trim();
  assert.match(shown, /"act"/u, 'what the terminal would have shown');
  const context = await unreadResultContext(vscode(folder, 'singularity-flow session open --for-agent --json', { exitCode: ran.status }), { env });
  assert.match(context, /SFlow kept it/u);
  assert.ok(context.endsWith(shown), 'exactly the view the command printed');
});

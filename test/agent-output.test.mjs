/**
 * An agent reads `act` first and never more than its host shows. `[agent-output]`
 *
 * Live Copilot runs stalled on long results it saw only the start of, or could not open at all
 * once the host saved them outside the workspace; agents then asked again what an earlier step
 * settled, ended without the next step, or looped on a preview.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { agentAct, agentOutputGoverned, boundedAgentOutput, DEFAULT_AGENT_OUTPUT_BYTES, LOOP_THRESHOLD, observeAgentLoop } from '../src/agent-output.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const digest = `sha256:${'e'.repeat(64)}`;

test('act reads each result by its own fields and never invents a next action', () => {
  assert.equal(agentAct({ paused: true }).state, 'paused');
  assert.equal(agentAct({ resultType: 'session-open', status: 'choose' }).state, 'ask-person');
  assert.equal(agentAct({ resultType: 'session-open', status: 'ready' }).do, null,
    'opening a session never authorizes another skill in the session-only turn');
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'implementation' }).do, null,
    'authoring is the skill\'s own step, never a next action to relay');
  assert.equal(agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required' }).state, 'ask-person');
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required' }).read, ['clarification', 'context']);
  const prepublish = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', commands: { publish: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host' } });
  assert.equal(prepublish.state, 'publish');
  assert.equal(prepublish.do.shell, 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host');
  assert.equal(agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{}, {}] }).state, 'correct');
  assert.equal(agentAct({ resultType: 'sflow-phase-prepublish', repairLoop: { status: 'escalate', instruction: 'Stop.' } }).state, 'escalate');
  const published = agentAct({ publishIfReady: { published: true, next: { instruction: 'Published. End the reply.', reason: 'Submit it.',
    commandGuidance: { copilotCommand: '/sf-submit', command: 'singularity-flow submit intake --work-id W', modelFreeCommand: null } } } });
  assert.deepEqual(published.do, { reason: 'Submit it.', copilot: '/sf-submit', shell: 'singularity-flow submit intake --work-id W', vscode: null });
  const refused = agentAct({ error: { code: 'X_REFUSED', message: 'No.' }, remediationPlan: { context: { strategy: 'repair-in-place' },
    steps: [{ label: 'Inspect recovery', command: 'singularity-flow recover W --phase p --json' }] } });
  assert.equal(refused.state, 'refused');
  assert.equal(refused.strategy, 'repair-in-place');
  assert.equal(refused.do.shell, 'singularity-flow recover W --phase p --json');
  assert.equal(agentAct({ resultType: 'x', note: 'nothing to do' }).state, 'read');
});

test('a returned confirmation becomes an ask with its exact value, and its Copilot route carries it', () => {
  const act = agentAct({ classification: 'convergence-advance-required', reason: 'Review it.',
    nextCommand: `singularity-flow story advance --work-id W --confirm ${digest}`, nextSkill: '/sf-submit' });
  assert.equal(act.state, 'confirm');
  assert.equal(act.ask.value, digest);
  assert.match(act.ask.how, /ask the person in this chat, and only on an explicit yes run do\.shell once/u);
  assert.ok(act.do.copilot.includes(digest), act.do.copilot);
});

test('a composed step reads its result whole; only the command a person or agent ran is bounded', () => {
  assert.equal(agentOutputGoverned({}), true);
  assert.equal(agentOutputGoverned({ SINGULARITY_FLOW_AGENT_OUTPUT: 'raw' }), false);
  assert.equal(agentOutputGoverned({ SINGULARITY_FLOW_AGENT_OUTPUT: 'full' }), false);
  globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 1;
  try { assert.equal(agentOutputGoverned({}), false); }
  finally { globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 0; }
});

test('a small result keeps every field with act first; a large one is written whole and its view fits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const small = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'x', status: 'ok', repositoryPath: root }), { cwd: root }));
  assert.deepEqual(Object.keys(small), ['act', 'resultType', 'status', 'repositoryPath']);

  const prose = Array.from({ length: 900 }, (_, index) => `Line ${index} of the composed context.`).join('\n');
  const large = { resultType: 'sflow-phase-entry', status: 'clarification-required', repositoryPath: root, workId: 'W',
    clarification: { checkpoint: { stage: 'derive-questions', instruction: 'Ask.' } },
    recovery: { blockers: Array.from({ length: 60 }, (_, index) => ({ id: index, detail: 'x'.repeat(120) })) },
    context: { text: prose, file: { path: 'singularity/work-items/W/context/prompts/p-gen1.md' } } };
  const text = await boundedAgentOutput(JSON.stringify(large), { cwd: root });
  assert.ok(Buffer.byteLength(text) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(text)} bytes`);
  const view = JSON.parse(text);
  assert.deepEqual(Object.keys(view).slice(0, 3), ['act', 'agentOutput', 'omittedFields']);
  assert.equal(view.act.state, 'ask-person');
  assert.equal(view.act.complete, false);
  assert.deepEqual(view.clarification, large.clarification, 'the field act reads stays in the view');
  assert.equal(view.workId, 'W', 'small fields stay');
  // The complete result lives inside the repository's Git directory, readable by line range.
  assert.match(view.agentOutput.relativePath, /^\.git\/singularity-flow\/agent-results\/sflow-phase-entry-.*\.json$/u);
  const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  const recovery = view.omittedFields.find((entry) => entry.field === 'recovery');
  const slice = lines.slice(recovery.lines[0] - 1, recovery.lines[1]).join('\n').replace(/^ {2}"recovery": /u, '').replace(/,$/u, '');
  assert.deepEqual(JSON.parse(slice), large.recovery, 'the named line range is exactly the omitted field');
  const context = view.omittedFields.find((entry) => entry.field === 'context');
  assert.equal(await readFile(context.textFiles[0].path, 'utf8'), prose, 'a long text is its own line-readable file, byte for byte');
});

test('the CLI bounds a real phase entry, and the bytes it leaves out are in the file it names', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-output-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Agent Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Agent Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'agent.tester@example.invalid' };
  delete env.SINGULARITY_FLOW_AGENT_OUTPUT;
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000 });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  await writeFile(path.join(root, 'README.md'), '# Agent output\n');
  must(process.execPath, [cli, '--no-model', 'init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-q', '-m', 'Agent output fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  must(process.execPath, [cli, '--no-model', 'start', 'OUT-1', '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Bound the entry', '--description', 'Agents read act first.']);

  const bounded = run(['phase', 'enter', '--compose', '--for-agent', '--json']);
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.ok(Buffer.byteLength(bounded.stdout) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(bounded.stdout)} bytes`);
  const view = JSON.parse(bounded.stdout);
  assert.equal(Object.keys(view)[0], 'act');
  assert.equal(view.act.state, 'ask-person');
  assert.ok(view.clarification?.checkpoint, 'the checkpoint act points at is in the view');
  const context = view.omittedFields.find((entry) => entry.field === 'context');
  const whole = JSON.parse(run(['phase', 'enter', '--compose', '--for-agent', '--json'], { SINGULARITY_FLOW_AGENT_OUTPUT: 'full' }).stdout);
  assert.equal(await readFile(context.textFiles[0].path, 'utf8'), whole.context.text, 'the composed context is complete in its file');
  // The composition records its own prompt; the bounded result adds nothing to the working tree.
  const changed = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(changed.every((line) => line.startsWith('?? singularity/work-items/OUT-1/context/')), changed.join('\n'));
  assert.match(view.agentOutput.relativePath, /^\.git\//u);
});

test('the same actionable result a third time in a row says it is a loop and names what changes it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-loop-'));
  const previous = process.env.SINGULARITY_FLOW_FINDING_STREAKS;
  process.env.SINGULARITY_FLOW_FINDING_STREAKS = path.join(root, 'streaks');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_FINDING_STREAKS;
    else process.env.SINGULARITY_FLOW_FINDING_STREAKS = previous;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const now = Date.parse('2026-10-15T12:00:00Z');
  // The Convergence preview the person kept following without confirming: readiness returns the
  // preview, and only the preview's own route carries the digest.
  const preview = { resultType: 'sflow-submission-readiness', workId: 'W', phaseId: 'convergence', head: 'h0',
    classification: 'convergence-advance-required', nextCommand: 'singularity-flow story advance --work-id W', nextSkill: '/sf-submit' };
  const previews = [1, 2, 3].map((minute) => observeAgentLoop(root, preview, agentAct(preview), { now: now - 30 * 60_000 + minute * 60_000 }));
  assert.equal(previews[2].state, 'confirm-review');
  assert.match(previews[2].loop.instruction, /Run do\.shell once to show the digest, then ask the person now in this chat to confirm it; only on an explicit yes run the returned --confirm command once\./u);
  const review = { ...preview, head: 'h1', nextCommand: `singularity-flow story advance --work-id W --confirm ${digest}` };
  const seen = [1, 2, 3].map((minute) => observeAgentLoop(root, review, agentAct(review), { now: now + minute * 60_000 }));
  assert.equal(seen[1].loop, undefined);
  assert.equal(seen[2].loop.repeated, LOOP_THRESHOLD);
  assert.match(seen[2].loop.instruction, /Ask them now in this chat to confirm the exact value; only on an explicit yes run do\.shell once\. Do not offer the preview again\./u);
  assert.match(seen[2].said, /^Repeated 3 times: /u);
  // A change of head is progress, not a repeat; nor is a result two hours later.
  assert.equal(observeAgentLoop(root, { ...review, head: 'h2' }, agentAct(review), { now: now + 4 * 60_000 }).loop, undefined);
  assert.equal(observeAgentLoop(root, { ...review, head: 'h2' }, agentAct(review), { now: now + 5 * 60_000 }).loop, undefined);
  assert.equal(observeAgentLoop(root, { ...review, head: 'h2' }, agentAct(review), { now: now + 4 * 60 * 60_000 }).loop, undefined);
  // Authoring and plain reads are never counted, however often they repeat.
  const authoring = { resultType: 'sflow-phase-entry', status: 'authoring-entry', workId: 'W', phase: 'code' };
  for (let index = 0; index < 4; index += 1) assert.equal(observeAgentLoop(root, authoring, agentAct(authoring)).loop, undefined);
});

test('JSON written to a terminal is an agent view; JSON read through a pipe or file stays whole', async () => {
  const { agentViewRequested } = await import('../src/cli-json-output.mjs');
  const terminal = { isTTY: true }, pipe = { isTTY: false };
  // A host agent runs commands in a terminal and saved a long /sf-session result where it could not read it.
  assert.equal(agentViewRequested({ json: true }, { stream: terminal, env: {} }), true);
  assert.equal(agentViewRequested({ json: true }, { stream: pipe, env: {} }), false, 'VS Code, scripts and tests read through pipes');
  assert.equal(agentViewRequested({ 'for-agent': true, json: true }, { stream: pipe, env: {} }), true, '--for-agent asks for it anywhere');
  assert.equal(agentViewRequested({ json: true }, { stream: terminal, env: { SINGULARITY_FLOW_AGENT_OUTPUT: 'full' } }), false);
  assert.equal(agentViewRequested({}, { stream: terminal, env: {} }), false, 'human text output is unchanged');
});

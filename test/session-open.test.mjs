import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('session open lists the Stories without an ID and opens one with its status, context and next steps in one command', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-open-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Session Opener',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Session Opener',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'session.opener@example.invalid' };
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
    return result;
  };
  const must = (command, args, cwd) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  await writeFile(path.join(root, 'README.md'), '# Session open\n');
  must(process.execPath, [cli, '--no-model', 'init']);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.ledger.enabled = true;
  await writeFile(definitionPath, YAML.stringify(definition));
  must('git', ['add', '.']);
  must('git', ['commit', '-q', '-m', 'Session open fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  must(process.execPath, [cli, '--no-model', 'start', 'OPEN-1', '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Open in one step', '--description', 'The session opens in one command.']);
  must('git', ['checkout', '-q', 'main']);

  const choose = JSON.parse(must(process.execPath, [cli, 'session', 'open', '--json']).stdout);
  assert.equal(choose.status, 'choose');
  assert.match(choose.table, /OPEN-1/);
  assert.match(choose.nextAction, /^singularity-flow session open <WORK-ID>/);

  const opened = JSON.parse(must(process.execPath, [cli, 'session', 'open', 'OPEN-1', '--json']).stdout);
  assert.equal(opened.status, 'ready');
  assert.equal(opened.workId, 'OPEN-1');
  assert.equal(opened.session.ready, true);
  assert.equal(opened.session.workId, 'OPEN-1');
  assert.equal(opened.session.activeAgent ?? null, opened.open.agent ?? null);
  assert.ok(opened.context, 'the brief context is included');
  assert.ok(opened.nextsteps, 'the next steps are included');
  assert.ok(opened.repositoryPath);

  const text = must(process.execPath, [cli, 'session', 'open', 'OPEN-1']).stdout;
  assert.match(text, /^OPEN-1 is ready at /);
  assert.match(text, /Work there with: cd /);

  // The brief reads only the local Story: no network round trip to look for sflow/config.
  const traced = spawnSync(process.execPath, [cli, 'session', 'context', '--work-id', 'OPEN-1', '--slice', 'brief', '--json'], {
    cwd: opened.repositoryPath, env: { ...env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '0' }, encoding: 'utf8', timeout: 180_000 });
  assert.equal(traced.status, 0, traced.stderr);
  assert.equal(JSON.parse(traced.stdout).work.id, 'OPEN-1');
  const gitDir = must('git', ['rev-parse', '--absolute-git-dir'], opened.repositoryPath).stdout.trim();
  const timing = (await readFile(path.join(gitDir, 'singularity-flow', 'dx', 'timings.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((entry) => entry.operationId === 'session.context').at(-1);
  assert.ok(timing, 'session context recorded its timing');
  assert.equal(timing.counters['git.remote.total'] ?? 0, 0, JSON.stringify(timing.counters));

  // A Story that does not exist is refused by the step that looked for it, with its own code.
  const missing = run(process.execPath, [cli, 'session', 'open', 'NOPE-1', '--json']);
  assert.notEqual(missing.status, 0);
  const refusal = JSON.parse(missing.stdout);
  assert.equal(refusal.resultType, 'sflow-refusal-plan');
  assert.ok(refusal.error.code && refusal.error.code !== 'SESSION_OPEN_STEP_FAILED', JSON.stringify(refusal.error));
  const unsupported = run(process.execPath, [cli, 'session', 'open', 'OPEN-1', '--table']);
  assert.notEqual(unsupported.status, 0);
});

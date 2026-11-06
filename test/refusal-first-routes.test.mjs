/**
 * The real dead ends from the route audit: each refusal's first route changes the state, or names a person's
 * decision they can run from that exact state. These run the real CLI, where the walker's fixture cannot stand:
 * outside any repository, or with a command a Story's step never reaches.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';

test('session open with no repository leads to selecting one', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-route-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, '--no-model', 'session', 'candidates', '--json'], { cwd: base, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'), SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json') } });
  const refusal = JSON.parse(result.stdout);
  assert.equal(refusal.error.code, 'SESSION_REPOSITORY_REQUIRED');
  assert.equal(refusal.remediationPlan.steps[0].command, 'singularity-flow session workspace <WORKSPACE>');
  assert.equal(refusal.remediationPlan.steps[0].skill, '/sf-session');
});

test('a source-review step with the agent flag gets the same command without it, and its reads take the flag', async (t) => {
  const repo = await repository(t, { implementCommands: false });
  await startQuickFix(repo);
  const run = (...args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: childTimeout(60_000) });
  const refused = run('review-source', 'submit', 'implement', '--report-file', '/tmp/report.json', '--for-agent', '--json');
  const plan = JSON.parse(refused.stdout);
  assert.equal(plan.error.code, 'REVIEW_SOURCE_OPTIONS_INVALID');
  assert.match(plan.error.message, /run review-source submit without it/u);
  assert.equal(plan.remediationPlan.steps[0].command, 'singularity-flow review-source submit implement --report-file /tmp/report.json');
  const status = run('review-source', 'status', 'implement', '--for-agent', '--json');
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.notEqual(JSON.parse(status.stdout).error?.code, 'REVIEW_SOURCE_OPTIONS_INVALID');
});

test('session current with an option it does not take reads without it, and a workspace it named is selected first', () => {
  const steps = (argv) => refusalRemediationPlan(Object.assign(new Error('refused'), { code: 'SESSION_AGENT_OPTIONS_INVALID', details: {} }), argv).steps;
  assert.equal(steps(['session', 'current', '--for-agent', '--json', '--fetch'])[0].command, 'singularity-flow session current --for-agent --json');
  assert.equal(steps(['session', 'current', '--workspace', 'cfa', '--fetch'])[0].command, 'singularity-flow session workspace cfa');
});

test('help answers a command and a served topic, in words and as JSON', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-route-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const help = (...args) => spawnSync(process.execPath, [cli, '--no-model', 'help', ...args], { cwd: base, encoding: 'utf8', timeout: childTimeout(60_000), env: { ...process.env, NODE_ENV: 'test' } });
  // A refusal's route: `help decision`, refused as an unknown topic under --for-agent --json.
  const command = help('decision', '--for-agent', '--json');
  assert.equal(command.status, 0, command.stdout + command.stderr);
  assert.match(JSON.parse(command.stdout).content, /singularity-flow decision witness/u);
  assert.match(help('decision').stdout, /singularity-flow decision witness/u);
  // A topic explain serves: `help phase-appeals` was refused while explain had the page.
  const topic = help('phase-appeals', '--json');
  assert.equal(topic.status, 0, topic.stdout + topic.stderr);
  assert.match(JSON.parse(topic.stdout).content, /singularity-flow explain phase-appeals/u);
  assert.match(help('phase-appeals').stdout, /singularity-flow explain phase-appeals/u);
  assert.notEqual(help('no-such-page').status, 0, 'an unknown topic is still refused');
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const cli = path.resolve('bin/singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Ad Hoc Tester',
      SINGULARITY_FLOW_NO_NETWORK: '1'
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(root, ...args) {
  return execute('git', args, root);
}

function sflow(root, ...args) {
  return execute(process.execPath, [cli, ...args], root);
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-adhoc-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Ad Hoc Tester');
  git(root, 'config', 'user.email', 'adhoc@example.com');
  sflow(root, 'init');
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  definition.spec.testCommands = {
    'adhoc-test': [process.execPath, '-e', "const fs=require('node:fs');if(!fs.readFileSync('app.mjs','utf8').includes('value = 2'))process.exit(1)"]
  };
  await writeFile(workflowPath, YAML.stringify(definition));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize ad hoc fixture');
  git(root, 'switch', '-c', 'feature/adhoc');
  return root;
}

test('dirty explicit start refuses silent adoption with a legal next action', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 2;\n');
  const result = execute(process.execPath, [cli, 'adhoc', 'start', 'change value', '--json'], root, { allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ADH_DIRTY_START_CHOICE_REQUIRED|Existing tracked or untracked work/);
  assert.match(result.stderr, /--include-existing/);
  assert.equal(git(root, 'diff', '--', 'app.mjs').stdout.includes('value = 2'), true);
});

test('unstarted work lands through exact intent, dispositions, verification, and the shared publication transaction', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 2;\n');

  const landing = JSON.parse(sflow(root, 'land', '--json').stdout);
  assert.equal(landing.status, 'needs-intent');
  assert.equal(landing.resources.length, 1);
  assert.equal(landing.resources[0].resourceId, 'app.mjs');
  assert.equal(landing.candidate.objective.provenance, 'deterministic-summary-discovered-at-landing');

  const confirmed = JSON.parse(sflow(
    root, 'adhoc', 'intent', 'confirm', landing.sessionId,
    '--objective', 'Change the exported value',
    '--success', 'The module exports value 2',
    '--confirm', landing.changeSetSha256,
    '--json'
  ).stdout);
  assert.equal(confirmed.intent.provenance.kind, 'discovered-at-landing');
  assert.equal(confirmed.dispositions.summary.unresolved, 1);

  const map = JSON.parse(sflow(
    root, 'adhoc', 'claim', '--all', '--clause', 'ADH-INTENT:SC-001', '--json'
  ).stdout);
  assert.equal(map.summary.claimed, 1);
  assert.equal(map.summary.unresolved, 0);

  const preview = JSON.parse(sflow(root, 'adhoc', 'landing', 'preview', landing.sessionId, '--json').stdout);
  assert.equal(preview.status, 'eligible');
  assert.equal(preview.verification.status, 'passed');
  assert.match(preview.packet.packetSha256, /^sha256:[0-9a-f]{64}$/);

  const published = JSON.parse(sflow(
    root, 'adhoc', 'publish', landing.sessionId, '--confirm', preview.packet.packetSha256, '--json'
  ).stdout);
  assert.equal(published.pushed, false);
  assert.equal(published.pending, false);
  assert.match(published.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
  assert.match(git(root, 'show', '-s', '--format=%B', 'HEAD').stdout, /Singularity-Flow-Event-SHA256:/);

  const work = JSON.parse(git(root, 'show', `HEAD:singularity/adhoc-work/${published.workId}/work.json`).stdout);
  assert.equal(work.origin.workflowExecuted, false);
  assert.equal(work.origin.intentProvenance, 'discovered-at-landing');
  const authorityReceipt = JSON.parse(git(root, 'show', `HEAD:${published.authorityReceipt}`).stdout);
  assert.equal(authorityReceipt.authority.commit, null);
  assert.equal(authorityReceipt.authority.commitBinding, 'lifecycle-event-and-commit-trailers');

  const status = JSON.parse(sflow(root, 'adhoc', 'status', landing.sessionId, '--json').stdout);
  assert.equal(status.session.status, 'landed');
  assert.equal(status.receipt.authority.commit, published.commit);
});

test('a changed effect set invalidates the exact landing packet without publishing', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 2;\n');
  const landing = JSON.parse(sflow(root, 'land', '--json').stdout);
  sflow(
    root, 'adhoc', 'intent', 'confirm', landing.sessionId,
    '--objective', 'Change the exported value', '--success', 'The module exports value 2',
    '--confirm', landing.changeSetSha256, '--json'
  );
  sflow(root, 'adhoc', 'claim', '--all', '--clause', 'ADH-INTENT:SC-001', '--json');
  const preview = JSON.parse(sflow(root, 'adhoc', 'landing', 'preview', landing.sessionId, '--json').stdout);
  await writeFile(path.join(root, 'extra.mjs'), 'export const extra = true;\n');
  const refusal = execute(process.execPath, [
    cli, 'adhoc', 'publish', landing.sessionId, '--confirm', preview.packet.packetSha256, '--json'
  ], root, { allowFailure: true });
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /Repository effects changed|ADH_PACKET_STALE/);
  assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'initialize ad hoc fixture');
  assert.equal(await readFile(path.join(root, 'extra.mjs'), 'utf8'), 'export const extra = true;\n');
});

test('protected-path work is preserved and routed to promotion without a landing packet', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 2;\n');
  await writeFile(workflowPath, `${await readFile(workflowPath, 'utf8')}\n# reviewed local policy experiment\n`);

  const landing = JSON.parse(sflow(root, 'land', '--json').stdout);
  sflow(
    root, 'adhoc', 'intent', 'confirm', landing.sessionId,
    '--objective', 'Evaluate an application and policy change',
    '--success', 'The application exports value 2',
    '--confirm', landing.changeSetSha256,
    '--json'
  );
  sflow(root, 'adhoc', 'claim', '--all', '--clause', 'ADH-INTENT:SC-001', '--json');

  const preview = JSON.parse(sflow(
    root, 'adhoc', 'landing', 'preview', landing.sessionId, '--json'
  ).stdout);
  assert.equal(preview.status, 'promotion-required');
  assert.equal(preview.packet, null);
  assert.match(preview.eligibility.promotionReasons.join('\n'), /protected paths touched: singularity\/workflow\.yml/);
  assert.equal(git(root, 'log', '-1', '--format=%s').stdout.trim(), 'initialize ad hoc fixture');
  assert.match(await readFile(workflowPath, 'utf8'), /reviewed local policy experiment/);

  const checkpoint = JSON.parse(sflow(root, 'adhoc', 'promote', landing.sessionId, '--json').stdout);
  assert.equal(checkpoint.status, 'review-required');
  assert.equal(checkpoint.preservedBranch, 'feature/adhoc');
  assert.equal(checkpoint.changeSetSha256, landing.changeSetSha256);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

// Refusals that sent a person from one refused command to another (unhappy-paths audit, 2026-10-28).
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { fail = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Publisher',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const git = (root, ...args) => run('git', args, root).stdout.trim();

async function story(t, id, { parent = os.tmpdir() } = {}) {
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(path.join(parent, 'sflow-wording-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  git(root, 'config', 'user.name', 'Publisher');
  git(root, 'config', 'user.email', 'publisher@example.com');
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# wording\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  git(root, 'push', '-u', 'origin', 'main');
  flow(root, ['start', id, '--from-branch', 'main']);
  return root;
}

test('a cancelled Story says it is final at prepare, reopen and resume, and names a way on', async (t) => {
  const id = 'CANCEL-1';
  const root = await story(t, id);
  flow(root, ['cancel', id, '--reason', 'The request was withdrawn.', '--confirm', id]);
  for (const args of [['prepare', 'intake'], ['reopen', id, '--to', 'intake', '--reason', 'Try again.'], ['resume', id]]) {
    const refused = flow(root, args, { fail: true });
    const text = refused.stdout + refused.stderr;
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.match(text, /a cancelled Story is final/u, args.join(' '));
    assert.match(text, /singularity-flow start <NEW-WORK-ID>/u, args.join(' '));
    assert.doesNotMatch(text, /has no valid agent|use reject while a phase is awaiting approval|must be reopened|-\s+of\s+sequence gates/u, args.join(' '));
  }
});

test('an approver whose clone is behind is told to bring the submission in, and --fetch does', async (t) => {
  const id = 'BEHIND-1';
  const root = await story(t, id);
  const other = path.join(path.dirname(root), 'approver');
  run('git', ['clone', '--quiet', '--branch', id, path.join(path.dirname(root), 'remote.git'), other], path.dirname(root));
  git(other, 'config', 'user.name', 'Publisher');
  git(other, 'config', 'user.email', 'publisher@example.com');
  flow(other, ['resume', id]);
  const artifact = path.join(root, `singularity/work-items/${id}/artifacts/intake/intake.md`);
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'Submitted from the author\'s clone.'));
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit', 'intake']);

  const behind = flow(other, ['approve', 'intake', '--yes'], { fail: true });
  const text = behind.stdout + behind.stderr;
  assert.notEqual(behind.status, 0);
  // The sequence refusal stays (its soft gate still cannot override review history), and now names the clone being behind.
  assert.match(text, /If intake was submitted from another clone, bring that in first: singularity-flow refresh-branch, or approve with --fetch/u);
  flow(other, ['approve', 'intake', '--yes', '--fetch']);
  const state = JSON.parse(await readFile(path.join(other, `singularity/work-items/${id}/workflow.json`), 'utf8'));
  assert.equal(state.phases.intake.status, 'approved');
});

test('resume says a commit is waiting to be published and names sync', async (t) => {
  const id = 'WAIT-1';
  const root = await story(t, id);
  const hook = path.join(path.dirname(root), 'remote.git', 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const artifact = path.join(root, `singularity/work-items/${id}/artifacts/intake/intake.md`);
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'Published while the remote refuses it.'));
  assert.notEqual(flow(root, ['phase', 'publish', 'intake'], { fail: true }).status, 0);
  const resumed = flow(root, ['resume', id]);
  assert.match(resumed.stdout, /A commit of WAIT-1 is waiting to be published, so other clones cannot see it yet: run singularity-flow sync WAIT-1\./u);
});

test('resume warns when the checkout keeps its Git data in an iCloud-synced folder', { skip: process.platform !== 'darwin' }, async (t) => {
  const id = 'SYNCED-1';
  // The suite runs with a home of its own, so this folder is that home's, never the developer's.
  const root = await story(t, id, { parent: path.join(os.homedir(), 'Library', 'Mobile Documents', 'sflow-tests') });
  const resumed = flow(root, ['resume', id]);
  assert.match(resumed.stdout, /Warning: this checkout's Git data is in .*Mobile Documents, which iCloud Drive syncs/u);
});

test('a document kept on this machine only says at upload that a handoff needs its original', async (t) => {
  const id = 'LOCALDOC-1';
  const root = await story(t, id);
  const file = path.join(path.dirname(root), 'brief.md');
  await writeFile(file, '# Brief\n\nThe approved request.\n');
  const uploaded = flow(root, ['documents', 'upload', file, '--name', 'Brief', '--store', 'local']);
  assert.match(uploaded.stdout, /Kept on this machine only: anyone continuing this Story on another machine needs the original file/u);
});

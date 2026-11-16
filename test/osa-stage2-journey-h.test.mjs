/**
 * SPEC-OSA v1.1 journey H, Stage 2: a shared opening becomes visible after another checkout refreshes, a stale view is
 * labelled and refused at its boundary, offline authority grants nothing, and a verified takeover fences the first writer
 * [OSA:REQ-031, REQ-033, REQ-034, AC-016, AC-017; §7.3].
 *
 * Two laptops, each its own machine state and clone of one bare remote (test/sda-m5-takeover.test.mjs's method). Each
 * laptop's Git is wrapped on PATH: with an `offline` marker present, its next push runs, then the remote goes away and the
 * push reports a dropped connection, so the remote took the update and nobody can read that back. Every step is the CLI.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { gitTestWrapperEnvironment, realGitForTest, writeGitTestWrapper } from './helpers/git-test-wrapper.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const json = (result) => JSON.parse(result.stdout);
/** A step's entry as the agent reads it: the bounded result and the full packet it names. */
const entered = async (laptop) => {
  const bounded = json(laptop.flow(['phase', 'enter', 'intake', '--for-agent', '--json']));
  return { ...(bounded.agentOutput?.path ? JSON.parse(await readFile(bounded.agentOutput.path, 'utf8')) : {}), ...bounded };
};

async function laptops(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-osa2-h-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const remote = path.join(base, 'remote.git');
  const exec = (command, args, cwd, env, { fail = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: childTimeout(180_000) });
    if (!fail && result.status !== 0) assert.fail(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  exec('git', ['init', '--bare', '-q', '-b', 'main', remote], base, process.env);
  const realGit = realGitForTest();
  async function laptop(name, { clone = false } = {}) {
    const state = path.join(base, `${name}-machine`);
    const repo = path.join(base, name, 'app');
    const bin = path.join(base, `${name}-git`);
    const loseNextPush = path.join(base, `${name}-lose-next-push`);
    await mkdir(state, { recursive: true });
    await writeGitTestWrapper(bin, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const status = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1;
const marker = ${JSON.stringify(loseNextPush)};
if (status === 0 && fs.existsSync(marker) && args.includes('push')) {
  if (fs.readFileSync(marker, 'utf8').includes('offline')) fs.renameSync(${JSON.stringify(remote)}, ${JSON.stringify(`${remote}.away`)});
  fs.rmSync(marker, { force: true });
  process.stderr.write('fatal: the remote end hung up unexpectedly\\n');
  process.exit(128);
}
process.exit(status);
`);
    const env = { ...gitTestWrapperEnvironment(bin, isolatedTestEnvironment(state, process.env)), NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Packager', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
    await mkdir(path.dirname(repo), { recursive: true });
    if (clone) exec('git', ['clone', '-q', '--no-local', remote, repo], base, env);
    else await mkdir(repo, { recursive: true });
    const git = (...args) => exec('git', args, repo, env).stdout.trim();
    if (!clone) { git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', remote); }
    git('config', 'user.name', 'Packager');
    git('config', 'user.email', 'packager@example.com');
    const flow = (args, { cwd = repo, extra = {} } = {}) => exec(process.execPath, [CLI, ...args], cwd, { ...env, ...extra }, { fail: true });
    return { name, repo, env, git, flow, loseNextPush };
  }
  return { base, remote, laptop, exec };
}

test('journey H: an opening is shared on refresh, a stale checkout is told so, a lost reply settles, and a verified takeover fences the first writer',
  slowLane({ timeout: 1_200_000 }), async (t) => {
    const f = await laptops(t);
    const a = await f.laptop('a');
    await writeFile(path.join(a.repo, 'README.md'), '# shared openings\n');
    assert.equal(a.flow(['init']).status, 0);
    const file = path.join(a.repo, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    definition.worldModel.grounding = 'off';
    for (const workType of Object.values(definition.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
    await writeFile(file, YAML.stringify(definition));
    a.git('add', '.'); a.git('commit', '-qm', 'Initialize Singularity Flow'); a.git('push', '-q', '-u', 'origin', 'main');
    assert.equal(a.flow(['start', 'OSA-H', '--from-branch', 'main']).status, 0);
    const intake = path.join(a.repo, 'singularity/work-items/OSA-H/artifacts/intake/intake.md');
    await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/gu, 'Share every version opening with the other laptop.'));
    const published = a.flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const b = await f.laptop('b', { clone: true });

    // Laptop A asks for a change to the published intake: version 2, previewed with its question, opened on the person's
    // yes at their own terminal. The remote takes the push, then goes away before anyone can read the outcome back.
    const preview = json(a.flow(['phase', 'rollover', 'intake', '--reason', 'Say which laptop wrote it', '--json']));
    assert.equal(preview.question, 'Start version 2 of Intake? Published version 1 will stay unchanged.');
    await writeFile(a.loseNextPush, 'offline');
    const lost = a.flow([...preview.argv, '--json']);
    assert.notEqual(lost.status, 0, `the reply was lost\n${lost.stdout.slice(-1500)}\n${lost.stderr.slice(-1500)}`);
    assert.equal(json(lost).error.code, 'VERSION_OPENING_OUTCOME_UNKNOWN', lost.stdout.slice(0, 1200));
    // Uncertain: the step grants nothing and names settling the same operation, never a replacement version. The entry's
    // act and the edit permission name one route for it, `phase opening --reconcile`, which settles the retained commit
    // under its original lease (Stage 3, Stage 2 finding 8) [OSA:REQ-010, REQ-033].
    const uncertain = await entered(a);
    assert.match(JSON.stringify(uncertain.act?.do ?? null), /phase opening intake --reconcile/u, JSON.stringify(uncertain.act ?? null).slice(0, 1200));
    assert.deepEqual(uncertain.mutationContract.artifacts, [], 'nothing of the step is writable while its opening is uncertain');
    assert.equal(uncertain.mutationContract.applicationEdits, false);
    assert.deepEqual(uncertain.mutationContract.policy.step.reasons, ['OPENING_UNKNOWN']);
    assert.match(JSON.stringify(uncertain.mutationContract.next), /phase opening intake --reconcile/u);
    assert.doesNotMatch(JSON.stringify(uncertain.act), /phase (?:rollover|begin)\b/u, 'no replacement version is offered');
    // Offline, settling cannot tell, and changes nothing; with the remote back, it finds the very commit there.
    const offline = a.flow(['phase', 'opening', 'intake', '--reconcile', '--json']);
    assert.notEqual(offline.status, 0);
    assert.equal(json(offline).error.code, 'VERSION_OPENING_OUTCOME_UNKNOWN', offline.stdout.slice(0, 1200));
    const { rename } = await import('node:fs/promises');
    await rename(`${f.remote}.away`, f.remote);
    const settled = json(a.flow(['phase', 'opening', 'intake', '--reconcile', '--json']));
    assert.equal(settled.settled, 'shared-confirmed', 'the remote held the very commit: the same operation is confirmed');
    const remoteTip = () => f.exec('git', ['--git-dir', f.remote, 'rev-parse', 'OSA-H'], f.base, process.env).stdout.trim();
    assert.equal(remoteTip(), a.git('rev-parse', 'HEAD'), 'no second commit was made to settle it');

    // Laptop B, before refreshing, has never seen it; after its verified takeover it holds the opening and its writer fence.
    const surface = { SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: b.repo }) };
    const taken = b.flow(['session', 'takeover', 'OSA-H', '--json'], { extra: surface });
    assert.equal(taken.status, 0, taken.stdout.slice(-1500) + taken.stderr.slice(-1500));
    const takeover = json(taken);
    assert.equal(takeover.exclusiveOwnership, true, JSON.stringify(takeover.writerFence));
    assert.equal(takeover.writerFence.taken, true);
    const seenOnB = json(b.flow(['phase', 'opening', 'intake', '--json'], { cwd: takeover.repositoryPath }));
    assert.equal(seenOnB.opening.version, 2);
    assert.equal(seenOnB.opening.operationId, settled.outcome.operationId);
    assert.equal(seenOnB.opening.writer.current, true, 'the takeover made laptop B the writer');
    assert.equal(seenOnB.opening.writer.fence, takeover.writerFence.fence);

    // Laptop A is now stale. Its entry reads the Story branch once, says so, and grants nothing until it refreshes.
    const stale = await entered(a);
    assert.equal(stale.sharedAuthority?.status, 'stale', JSON.stringify(stale.sharedAuthority ?? null));
    assert.match(JSON.stringify(stale.mutationContract.next), /refresh-branch/u, 'a stale view names its refresh');
    assert.deepEqual(stale.mutationContract.artifacts, [], 'a stale view grants nothing');
    // Its publication is refused at that boundary; after the refresh, its writer fence refuses it.
    await writeFile(intake, `${await readFile(intake, 'utf8')}\nA laptop A sentence.\n`);
    const early = a.flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place', '--json']);
    assert.notEqual(early.status, 0);
    assert.match(JSON.stringify(json(early).error ?? {}), /STORY_PUBLICATION_REMOTE_DIVERGED|VERSION_WRITER_FENCED/u, early.stdout.slice(0, 1200));
    a.git('checkout', '--', 'singularity/work-items/OSA-H/artifacts/intake/intake.md');
    assert.equal(a.flow(['refresh-branch']).status, 0);
    const fencedView = json(a.flow(['phase', 'opening', 'intake', '--json']));
    assert.equal(fencedView.opening.writer.current, false, 'laptop A may inspect version 2, no longer write it');
    await writeFile(intake, `${await readFile(intake, 'utf8')}\nA laptop A sentence.\n`);
    const fenced = a.flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place', '--json']);
    assert.equal(json(fenced).error.code, 'VERSION_WRITER_FENCED', fenced.stdout.slice(0, 1200));
    const entry = await entered(a);
    assert.deepEqual(entry.mutationContract.artifacts, [], 'the fenced writer may not edit');
    assert.match(JSON.stringify(entry.mutationContract.next), /session takeover OSA-H/u, 'the fenced writer is named the takeover, never an edit');
  });

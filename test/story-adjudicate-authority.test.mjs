/**
 * `story adjudicate` is a decision of the convergence phase's approval authority. `[SPK:REQ-079]`
 *
 * A disposition decides what the Story still owes: `dismissed` makes a finding disappear from the
 * blockers and `rework` sends the code back. It was bound to the current Git identity and nothing
 * else, so anyone with a checkout could dispose of convergence findings that only the convergence
 * approvers may advance past.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE, 'bin/singularity-flow.mjs');
const WORK = 'ADJ-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

test('story adjudicate refuses an identity outside the convergence approval authority before writing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-adjudicate-authority-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const git = (...args) => run('git', args, root).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const tryCli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Developer');
  git('config', 'user.email', 'developer@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  // No automatic enrollment: the developer must stay outside the convergence authority.
  configuration.approvalSecurity = { profile: 'poc', autoEnrollNewIdentities: false };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Convergence approval belongs to architecture reviewers in the shipped spec-driven profile.
  configuration.approvalAuthorities['architecture-reviewers'] = {
    label: 'Architecture reviewers', allowAnyGitIdentity: false,
    members: [{ name: 'Architect', email: 'architect@example.test' }]
  };
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize adjudication fixture');
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Adjudication authority', '--description', 'Only convergence approvers dispose of findings.');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', WORK, 'workflow.json'), 'utf8'));
  assert.deepEqual(workflow.phases.convergence.approvalPolicy.authorities, ['architecture-reviewers']);
  assert.deepEqual(workflow.resolution.approvalAuthorities['architecture-reviewers'].members.map((member) => member.email),
    ['architect@example.test']);
  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain');

  const adjudicate = () => tryCli('story', 'adjudicate', 'CF-000000000000', '--work-id', WORK,
    '--disposition', 'dismissed', '--reason', 'Refactor noise; no requirement claims it.');
  const outsider = adjudicate();
  assert.notEqual(outsider.status, 0);
  assert.match(outsider.stdout + outsider.stderr, /developer@example\.test' is not a member of: architecture-reviewers/);
  assert.equal(git('rev-parse', 'HEAD'), head, 'the refusal committed state');
  assert.equal(git('status', '--porcelain'), status, 'the refusal changed the worktree');

  // A convergence approver passes the authority check and meets the ordinary readiness refusal.
  git('config', 'user.email', 'architect@example.test');
  const approver = adjudicate();
  assert.notEqual(approver.status, 0, 'the Story has no convergence iteration to adjudicate yet');
  assert.doesNotMatch(approver.stdout + approver.stderr, /is not a member of/);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Replay Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input: '' });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options = {}) { return run(process.execPath, [bin, ...args], root, options); }

/** Two clones of one Story; `upload` in the second loses the race by pushing while the remote is away. */
async function race() {
  const first = await mkdtemp(path.join(os.tmpdir(), 'sflow-replay-a-'));
  run('git', ['init', '-b', 'main'], first); run('git', ['config', 'user.name', 'Replay Tester'], first); run('git', ['config', 'user.email', 'replay@example.com'], first);
  await writeFile(path.join(first, 'README.md'), '# Replay\n'); flow(first, ['init']);
  const configPath = path.join(first, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off'; config.documents.allowedPhases = ['intake']; config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(config.phases ?? {})) if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], first); run('git', ['commit', '-m', 'initialize'], first);
  const remote = `${first}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], first); run('git', ['remote', 'add', 'origin', remote], first); run('git', ['push', '-u', 'origin', 'main'], first);
  flow(first, ['start', 'RACE-1', '--from-branch', 'main', '--title', 'Concurrent uploads']);
  const second = await mkdtemp(path.join(os.tmpdir(), 'sflow-replay-b-'));
  run('git', ['clone', '--quiet', remote, second], os.tmpdir());
  run('git', ['config', 'user.name', 'Replay Tester'], second); run('git', ['config', 'user.email', 'replay@example.com'], second);
  run('git', ['checkout', '--quiet', 'RACE-1'], second);
  flow(second, ['resume', 'RACE-1']);
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-replay-docs-'));
  return { first, second, remote, uploads };
}

async function loseRace({ second, remote, uploads }, name, text) {
  const file = path.join(uploads, `${name.toLowerCase().replace(/\W+/g, '-')}.md`);
  await writeFile(file, text);
  await rename(remote, `${remote}.away`);
  const lost = flow(second, ['documents', 'upload', file, '--name', name], { allowFailure: true });
  await rename(`${remote}.away`, remote);
  assert.match(lost.stderr, /was retained locally but push failed/);
}

test('a document upload that lost a publication race replays onto the published Story with the next free ID', async () => {
  const fixture = await race();
  const { first, second, remote, uploads } = fixture;
  await loseRace(fixture, 'Notes from B', '# B\nWritten in the second clone.\n');
  const winner = path.join(uploads, 'a.md'); await writeFile(winner, '# A\nWritten in the first clone.\n');
  flow(first, ['documents', 'upload', winner, '--name', 'Notes from A']);

  const sync = flow(second, ['sync'], { allowFailure: true });
  assert.notEqual(sync.status, 0);
  assert.match(sync.stderr, /Another clone published to RACE-1 first[\s\S]*singularity-flow sync --replay/);
  const lostCommit = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();
  const preview = JSON.parse(flow(second, ['sync', '--replay', '--dry-run', '--json']).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.replayable, true);
  assert.deepEqual(preview.documents.map((document) => [document.id, document.name]), [['DOC-001', 'Notes from B']]);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout.trim(), lostCommit, 'a dry run moves nothing');

  const replay = JSON.parse(flow(second, ['sync', '--replay', '--json']).stdout);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.documents, [{ previousId: 'DOC-001', id: 'DOC-002', name: 'Notes from B' }]);
  assert.equal(replay.publication.pushed, true);
  assert.equal(run('git', ['rev-parse', replay.preservedRef], second).stdout.trim(), lostCommit, 'the lost commit stays reachable');
  const head = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();
  assert.match(run('git', ['ls-remote', remote, 'RACE-1'], second).stdout, new RegExp(`^${head}`));
  const listed = JSON.parse(flow(second, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));
  assert.deepEqual(listed.map((item) => [item.id, item.name]), [['DOC-001', 'Notes from A'], ['DOC-002', 'Notes from B']]);
  assert.match(flow(second, ['documents', 'view', 'Notes from B']).stdout, /Written in the second clone/);
  assert.match(flow(second, ['gate']).stdout, /document integrity: 2 supporting inputs/);
  assert.match(flow(second, ['sync']).stdout, /no pending publication/);
});

test('a lost upload whose name the winner took is not replayed, and nothing moves', async () => {
  const fixture = await race();
  const { first, second, uploads } = fixture;
  await loseRace(fixture, 'Shared notes', '# Mine\n');
  const winner = path.join(uploads, 'theirs.md'); await writeFile(winner, '# Theirs\n');
  flow(first, ['documents', 'upload', winner, '--name', 'Shared notes']);
  const lostCommit = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();
  const sync = flow(second, ['sync'], { allowFailure: true });
  assert.match(sync.stderr, /cannot be replayed: a document on the published Story already uses one of its names: 'Shared notes' \(DOC-001\)/);
  const replay = flow(second, ['sync', '--replay'], { allowFailure: true });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /cannot be replayed[\s\S]*Nothing was changed/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout.trim(), lostCommit);
});

test('a replay the published Story refuses puts the branch and its pending marker back', async () => {
  const fixture = await race();
  const { first, second } = fixture;
  await loseRace(fixture, 'Late notes', '# Late\n');
  // The winner approved intake, so the Story is past its document window.
  const itemDirectory = path.join(first, 'singularity/work-items/RACE-1');
  const intake = path.join(itemDirectory, JSON.parse(await readFile(path.join(itemDirectory, 'workflow.json'), 'utf8')).phases.intake.requiredArtifact.path);
  await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete intake evidence with measurable acceptance outcomes and linked design context.'));
  flow(first, ['phase', 'publish', 'intake']); flow(first, ['submit']); flow(first, ['approve', '--yes']);
  const lostCommit = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();

  const refused = flow(second, ['sync', '--replay'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /add --confirm-override continue:documentPhase/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout.trim(), lostCommit, 'the branch is back at the retained commit');
  assert.match(flow(second, ['sync'], { allowFailure: true }).stderr, /Another clone published to RACE-1 first/, 'the pending marker is back too');

  const replay = JSON.parse(flow(second, ['sync', '--replay', '--confirm-override', 'continue:documentPhase', '--json']).stdout);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.documents.map((document) => document.id), ['DOC-001']);
});

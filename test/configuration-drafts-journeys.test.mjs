/**
 * Configuration drafts through the CLI, as people meet them (SDA sweep, batch 2): every draft keeps a
 * correct state and a working way out, and no save says it saved what it did not.
 *
 * - C2: an edit back to an earlier value is saved; the same command again says it was already saved.
 * - C1: a draft approved from another clone is settled when proposing, and does not block a Studio
 *   batch; a draft that conflicts is named with its discard command.
 * - C5: a proposal whose upload was refused holds its drafts; the sync that uploads it names the approval.
 * - C6: a proposal merged by the Git host, which deleted its branch, is recorded by approving; one
 *   closed unmerged gives its drafts back.
 * - C3: a repository whose approved templatesRoot lies outside the reserved namespace saves drafts,
 *   and a refused change exits non-zero.
 * - C8: an empty Studio proposal is refused as nothing to propose.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A bare remote seeded with a configuration, a bootstrapped laptop on it, and the way to run the CLI. */
async function setup(t, { templatesRoot = null } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-draft-journeys-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Draft Author', SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Draft Author',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'draft.author@example.invalid' };
  const flow = (cwd, args, status = 0, input = undefined) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, input, encoding: 'utf8', timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
    if (status !== null) assert.equal(result.status, status, `singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const seed = path.join(base, 'seed'); const remote = path.join(base, 'remote.git'); const checkout = path.join(base, 'laptop-a');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'README.md'), '# Drafts\n');
  await initializeDefinition(seed);
  if (templatesRoot) {
    await cp(path.join(seed, 'singularity/templates'), path.join(seed, templatesRoot), { recursive: true });
    const workflow = path.join(seed, 'singularity/workflow.yml');
    await writeFile(workflow, (await readFile(workflow, 'utf8')).replace(/^templatesRoot: singularity\/templates$/mu, `templatesRoot: ${templatesRoot}`));
  }
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'seed');
  git(base, 'clone', '-q', '--bare', seed, remote);
  flow(base, ['bootstrap', remote, '--capability', 'drafts', '--into', checkout]);
  return { base, remote, checkout, flow };
}

const instructionFile = (remote) => git(remote, 'show', 'sflow/config:singularity/instruction-library/tone/INSTRUCTIONS.md');

test('drafts approved from another clone are settled, never block a Studio batch, and an edit back to an earlier value is saved', slowLane({ timeout: 900_000 }), async (t) => {
  const { base, remote, checkout: a, flow } = await setup(t);
  const b = path.join(base, 'laptop-b');
  git(base, 'clone', '-q', remote, b);
  const create = ['instruction', 'create', 'tone', '--description', 'Tone.', '--instructions', 'Be kind.'];
  assert.match(flow(a, create).stdout, /Saved as a draft; no Story uses it until it is approved\. Drafts waiting: 1\./);
  flow(b, [...create, '--propose']);
  flow(b, ['configuration', 'approve', '--yes']);

  // An unrelated Studio batch is not blocked: the draft approved elsewhere is left out, and said so.
  const changeSet = path.join(base, 'change.json');
  await writeFile(changeSet, JSON.stringify({ schema: 'sflow-studio-change-set@1',
    changes: [{ op: 'instruction.create', id: 'other', description: 'Other.', instructions: 'Other text.' }] }));
  const preview = JSON.parse(flow(a, ['workflow', 'studio', 'apply', '--change-set', changeSet, '--dry-run', '--json']).stdout);
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  assert.deepEqual(preview.files.map((file) => file.path), ['singularity/instruction-library/other/INSTRUCTIONS.md']);
  assert.match(preview.warnings.find((warning) => warning.code === 'CONFIGURATION_DRAFT_LEFT_OUT')?.message ?? '',
    /Draft 1, New instruction tone, was left out: the approved configuration already has it\./);

  // Proposing settles it: nothing is proposed, nothing stays waiting, and nothing loops.
  const proposed = flow(a, ['configuration', 'propose']);
  assert.match(proposed.stdout, /Already approved, no longer waiting: New instruction tone\nNothing to propose: the approved configuration already has these changes\. No drafts are waiting\./);
  assert.match(flow(a, ['configuration', 'drafts']).stdout, /^No drafts\./);

  // C2: First, Second, then First again is three changes; the same command once more is a retry.
  const editTo = (value) => flow(a, ['instruction', 'edit', 'tone', '--instructions', value]).stdout;
  assert.match(editTo('First.'), /Saved as a draft.*Drafts waiting: 1\./);
  assert.match(editTo('Second.'), /Drafts waiting: 2\./);
  assert.match(editTo('First.'), /^Saved as a draft; no Story uses it until it is approved\. Drafts waiting: 3\./);
  assert.match(editTo('First.'), /^Already saved as a draft; nothing new was saved\. Drafts waiting: 3\./);
  flow(a, ['configuration', 'propose']);
  flow(a, ['configuration', 'approve', '--yes']);
  assert.match(instructionFile(remote), /\n\nFirst\.$/, "the value saved last is the value approved");

  // C1: a draft the approved configuration no longer takes is named with its discard command.
  flow(a, ['instruction', 'edit', 'tone', '--instructions', 'Mine.']);
  git(b, 'pull', '-q', '--ff-only');
  flow(b, ['instruction', 'remove', 'tone', '--propose']);
  flow(b, ['configuration', 'approve', '--yes']);
  const refused = flow(a, ['configuration', 'propose'], 1);
  assert.match(refused.stderr, /A saved draft no longer applies to the approved configuration, so nothing was proposed:\n {2}1\. Edit instruction tone: Instruction 'tone' does not exist\./);
  const discard = /Discard it: (singularity-flow configuration discard 1 --listing [0-9a-f]{12})/u.exec(refused.stderr)?.[1];
  assert.ok(discard, refused.stderr);
  const listed = flow(a, ['configuration', 'drafts']).stdout;
  assert.match(listed, /Conflicts with the approved configuration: Instruction 'tone' does not exist\./);
  assert.ok(listed.includes(`Discard it: ${discard}`), listed);
  assert.match(flow(a, discard.split(' ').slice(1)).stdout, /Discarded: Edit instruction tone\n0 drafts left\./);
});

test('a proposal whose upload failed holds its drafts until it is approved; one merged or closed on the host is settled by approving', slowLane({ timeout: 900_000 }), async (t) => {
  const { base, remote, checkout: a, flow } = await setup(t);
  flow(a, ['instruction', 'create', 'tone', '--description', 'Tone.', '--instructions', 'Be kind.']);
  const marker = path.join(base, 'reject');
  await writeFile(marker, '1');
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/sflow/config-change/*) if [ -f "${marker}" ]; then echo "rejected for the test" >&2; exit 1; fi;; esac; done\nexit 0\n`);
  await chmod(hook, 0o755);
  const failed = flow(a, ['configuration', 'propose'], 1);
  const intent = /singularity-flow sync (psh_[0-9a-f-]+)/u.exec(failed.stderr)?.[1];
  assert.ok(intent, failed.stderr);
  const waiting = flow(a, ['configuration', 'drafts']).stdout;
  assert.match(waiting, /^No drafts\./, 'the drafts are held by the proposal, not offered again');
  assert.match(waiting, new RegExp(`Its upload has not finished; finish it first: singularity-flow sync ${intent}`));
  const branch = /Waiting for approval: (sflow\/config-change\/\S+)/u.exec(waiting)?.[1];
  assert.ok(branch, waiting);
  await rm(marker);
  const synced = flow(a, ['sync', intent]);
  assert.match(synced.stdout, new RegExp(`Shell: singularity-flow configuration approve ${branch.replaceAll('/', '\\/')}`));
  assert.doesNotMatch(synced.stdout, /This work is finished/);
  assert.doesNotMatch(flow(a, ['configuration', 'drafts']).stdout, /upload has not finished/);
  assert.match(flow(a, ['configuration', 'approve', '--yes']).stdout, /Approved\. New Stories use these changes/);
  assert.match(flow(a, ['configuration', 'drafts']).stdout, /^No drafts\. Each agent, skill or instruction change you make is saved here until you propose it\.\n$/);

  // Merged by the Git host, which then deleted the branch: approving records it.
  flow(a, ['instruction', 'create', 'other', '--description', 'Other.', '--instructions', 'Other text.']);
  const merged = JSON.parse(flow(a, ['configuration', 'propose', '--json']).stdout);
  git(remote, 'update-ref', 'refs/heads/sflow/config', merged.commit);
  git(remote, 'update-ref', '-d', `refs/heads/${merged.branch}`);
  assert.match(flow(a, ['configuration', 'approve', '--yes']).stdout,
    /was merged into sflow\/config through your Git host, which then removed its branch\. Recorded as approved/);
  assert.match(flow(a, ['configuration', 'drafts']).stdout, /^No drafts\. Each agent, skill or instruction change you make is saved here until you propose it\.\n$/);

  // Closed on the host without being merged: approving gives the drafts back, and proposing is the way on.
  flow(a, ['instruction', 'create', 'third', '--description', 'Third.', '--instructions', 'Third text.']);
  const closed = JSON.parse(flow(a, ['configuration', 'propose', '--json']).stdout);
  git(remote, 'update-ref', '-d', `refs/heads/${closed.branch}`);
  const gone = flow(a, ['configuration', 'approve', '--yes'], 1);
  assert.match(gone.stderr, /is no longer on the remote and its changes are not in sflow\/config, so there is nothing to approve\. The draft it held is waiting again: New instruction third\./);
  assert.match(gone.stderr, /singularity-flow configuration propose/);
  assert.match(flow(a, ['configuration', 'drafts']).stdout, /1 draft saved on this machine.*\n {2}1\. New instruction third/);
});

test('a custom approved templatesRoot saves drafts, a refused change exits non-zero, and an empty Studio proposal is refused', slowLane({ timeout: 600_000 }), async (t) => {
  const { base, checkout: a, flow } = await setup(t, { templatesRoot: 'company/templates' });
  const saved = flow(a, ['instruction', 'create', 'tone', '--description', 'Tone.', '--instructions', 'Be kind.']);
  assert.match(saved.stdout, /Saved as a draft; no Story uses it until it is approved\. Drafts waiting: 1\./);
  assert.doesNotMatch(saved.stdout, /Problem:/);
  assert.match(flow(a, ['instruction', 'create', 'tone2', '--description', 'x', '--instructions', 'y', '--dry-run']).stdout, /Preview: 2 file\(s\) would change\./);
  const refused = flow(a, ['skill', 'attach', 'missing', '--agent', 'qa'], 1);
  assert.match(refused.stdout, /Problem: /, 'a refused change says why, and exits non-zero');
  flow(a, ['configuration', 'discard', '--all']);
  const empty = path.join(base, 'empty.json');
  await writeFile(empty, JSON.stringify({ schema: 'sflow-studio-change-set@1', changes: [] }));
  const nothing = flow(a, ['workflow', 'studio', 'apply', '--change-set', empty, '--propose'], 1);
  assert.match(nothing.stderr, /There is nothing to propose: the change set holds no changes and no drafts are waiting\./);
});

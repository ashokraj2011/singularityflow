#!/usr/bin/env node
/**
 * SDA M6 compatibility check: Stories an older build wrote, used by this build (SDA §15, SDA-AC-009).
 *
 * The older build (--legacy-cli-root, a worktree of a commit from before SDA) initializes a
 * repository and starts two Stories: one with its intake published, submitted and approved, one at
 * intake. This build then uses them:
 * - reads: status, nextsteps, the Story list, `ledger verify`, and every stored record of the Story
 *   branches and the ledger through its family's migrations;
 * - `index rebuild`;
 * - another laptop, with its own machine state and home, takes the approved Story over;
 * - this build advances the Story the older build left at intake (publish, submit, approve).
 * After each step the bytes the older build wrote, the Story branches, the ledger and its pins, are
 * unchanged, locally and on the remote, and the advanced Story's earlier history is an ancestor of
 * its new tip: nothing is rewritten. Every process runs with the repository's isolated machine state
 * and home (scripts/test-machine-state.mjs); no model, no real network.
 *
 *   node scripts/sda-legacy-check.mjs --legacy-cli-root=DIR [--output=FILE]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { isolatedTestEnvironment } from './test-machine-state.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const legacyRoot = option('legacy-cli-root', null) && path.resolve(option('legacy-cli-root'));
const output = option('output', null);
if (!legacyRoot || !existsSync(path.join(legacyRoot, 'bin/singularity-flow.mjs'))) throw new Error('--legacy-cli-root must name a checkout with bin/singularity-flow.mjs.');

const stateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-legacy-')));
const isolated = isolatedTestEnvironment(path.join(stateRoot, 'laptop-a', 'machine'));
for (const name of Object.keys(process.env)) if (!(name in isolated)) delete process.env[name];
Object.assign(process.env, isolated);
const { familyForStoredPath, readRecord } = await import('../src/schema-migrations.mjs');

const identity = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Packager', SINGULARITY_FLOW_NO_MODEL: '1',
  SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Packager',
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'packager@example.com' };
const laptopA = { ...isolated, ...identity };
const laptopB = { ...isolatedTestEnvironment(path.join(stateRoot, 'laptop-b', 'machine')), ...identity };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, cwd, { env = laptopA, input, encoding = 'utf8' } = {}) => {
  const result = spawnSync(command, args, { cwd, env, input, encoding, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${String(result.stdout).slice(-2000)}\n${String(result.stderr).slice(-2000)}`);
  return result;
};
const git = (cwd, ...args) => run('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], cwd).stdout.trim();
const cli = (root, cwd, args, env = laptopA) => JSON.parse(run(process.execPath, [path.join(root, 'bin/singularity-flow.mjs'), '--no-model', ...args, '--json'], cwd, { env }).stdout || 'null');
const legacy = (cwd, ...args) => cli(legacyRoot, cwd, args);
const current = (cwd, ...args) => cli(packageRoot, cwd, args);
// A person's steps, as typed: some print text only.
const act = (root) => (cwd, ...args) => run(process.execPath, [path.join(root, 'bin/singularity-flow.mjs'), '--no-model', ...args], cwd);
const engine = (root) => execFileSync('git', ['-C', root, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim();

/** The bytes of every object the ledger, its pins and the Story branches reach, with their refs. */
function written(gitArgs, cwd, branches) {
  const refs = git(cwd, ...gitArgs, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/state', 'refs/singularity/pins',
    ...branches.map((name) => `refs/heads/${name}`));
  const ids = git(cwd, ...gitArgs, 'rev-list', '--objects', ...refs.split('\n').map((line) => line.split(' ')[0]))
    .split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
  const bytes = run('git', [...gitArgs, 'cat-file', '--batch'], cwd, { input: Buffer.from(`${ids.join('\n')}\n`), encoding: 'buffer' }).stdout;
  return { refs, objects: ids.length, sha256: sha256(bytes) };
}

const checks = [];
const check = (step, name, passed, detail = null) => checks.push({ step, check: name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
try {
  // The older build: a repository with lightweight approvals, its remote, and two Stories.
  const a = path.join(stateRoot, 'laptop-a', 'checkout');
  const remote = path.join(stateRoot, 'remote.git');
  await mkdir(a, { recursive: true });
  git(a, 'init', '-q', '-b', 'main');
  await writeFile(path.join(a, '.gitattributes'), '* text eol=lf\n');
  run(process.execPath, [path.join(legacyRoot, 'bin/singularity-flow.mjs'), '--no-model', 'init'], a);
  const workflowFile = path.join(a, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(workflowFile, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(workflowFile, YAML.stringify(configuration));
  git(a, 'add', '.');
  git(a, 'commit', '-qm', 'Initialize with the older build');
  git(stateRoot, 'init', '--bare', '-q', '-b', 'main', remote);
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  const stories = { approved: { id: 'LEG-1', branch: 'delivery/leg-1' }, intake: { id: 'LEG-2', branch: 'delivery/leg-2' } };
  const approveIntake = async (build, worktree, id) => {
    const file = path.join(worktree, 'singularity/work-items', id, 'artifacts/intake/intake.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu, 'Keep what an older build wrote exactly as it wrote it.'));
    build(worktree, 'artifact', 'scan', '--phase', 'intake');
    build(worktree, 'phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    build(worktree, 'submit', 'intake', '--skip-checks');
    build(worktree, 'approve', 'intake', '--yes');
  };
  for (const story of Object.values(stories)) {
    if (git(a, 'branch', '--show-current') !== 'main') git(a, 'switch', '-q', 'main');
    const started = legacy(a, 'start', story.id, '--isolated-worktree', '--from-branch', 'main', '--ref', story.branch,
      '--work-type', 'feature', '--title', `Started by the older build (${story.id})`, '--description', 'A Story an older build wrote.');
    story.worktree = (started.data ?? started).repositoryPath;
  }
  await approveIntake(act(legacyRoot), stories.approved.worktree, stories.approved.id);
  for (const story of Object.values(stories)) git(story.worktree, 'push', '-q', 'origin', story.branch);
  const branches = Object.values(stories).map((story) => story.branch);
  const before = { remote: written(['--git-dir', remote], stateRoot, branches), local: written([], a, branches),
    approved: git(stateRoot, '--git-dir', remote, 'rev-parse', stories.approved.branch),
    entries: current(stories.approved.worktree, 'ledger', 'verify').entries };
  const unchanged = (step) => {
    check(step, 'remote bytes the older build wrote are unchanged', JSON.stringify(written(['--git-dir', remote], stateRoot, branches)) === JSON.stringify(before.remote));
    check(step, 'local bytes the older build wrote are unchanged', JSON.stringify(written([], a, branches)) === JSON.stringify(before.local));
  };

  // This build reads what the older build wrote.
  for (const args of [['status', stories.approved.id], ['nextsteps', stories.approved.id], ['session', 'candidates']]) {
    const answer = current(stories.approved.worktree, ...args);
    check('reads', `${args.join(' ')} answers`, answer != null);
  }
  const verified = current(stories.approved.worktree, 'ledger', 'verify');
  check('reads', 'the ledger verifies with the same entries', verified.valid === true && verified.entries === before.entries, { entries: verified.entries });
  const families = new Map();
  const unreadable = [];
  for (const [ref, prefix] of [['refs/heads/state', '$state/'], ...branches.map((name) => [`refs/heads/${name}`, ''])]) {
    for (const line of git(a, 'ls-tree', '-r', ref).split('\n')) {
      const [meta, stored] = line.split('\t');
      const [, type, object] = meta.split(' ');
      const family = type === 'blob' && stored.endsWith('.json') ? familyForStoredPath(`${prefix}${stored}`) : null;
      if (!family) continue;
      try {
        readRecord(family.id, run('git', ['cat-file', 'blob', object], a, { encoding: 'buffer' }).stdout);
        families.set(family.id, (families.get(family.id) ?? 0) + 1);
      } catch (error) { unreadable.push({ stored, family: family.id, code: error.code ?? null }); }
    }
  }
  check('reads', 'every stored record reads through its family', unreadable.length === 0 && families.size > 0,
    { families: Object.fromEntries([...families].sort()), unreadable });
  unchanged('reads');

  for (const cwd of [stories.approved.worktree, a]) current(cwd, 'index', 'rebuild');
  unchanged('index rebuild');

  // Another laptop, with this build, takes the older build's approved Story over.
  const b = path.join(stateRoot, 'laptop-b', 'checkout');
  git(stateRoot, 'clone', '-q', remote, b);
  const taken = cli(packageRoot, b, ['session', 'takeover', stories.approved.id], laptopB);
  check('takeover', 'another laptop takes the Story over', taken?.workId === stories.approved.id, { ready: taken?.ready ?? null });
  check('takeover', 'the Story arrives exactly as the older build published it', git(b, 'rev-parse', stories.approved.branch) === before.approved);
  const verifiedB = cli(packageRoot, taken?.repositoryPath ?? b, ['ledger', 'verify'], laptopB);
  check('takeover', 'the ledger verifies there with the same entries', verifiedB.valid === true && verifiedB.entries === before.entries, { entries: verifiedB.entries });
  unchanged('takeover');

  // This build advances the Story the older build left at intake.
  const earlier = git(stories.intake.worktree, 'rev-parse', 'HEAD');
  await approveIntake(act(packageRoot), stories.intake.worktree, stories.intake.id);
  const advanced = git(stories.intake.worktree, 'rev-parse', 'HEAD');
  check('advance', 'the new transitions are committed on top of the older history',
    advanced !== earlier && spawnSync('git', ['merge-base', '--is-ancestor', earlier, advanced], { cwd: stories.intake.worktree }).status === 0);
  check('advance', 'the advanced Story is published', git(stateRoot, '--git-dir', remote, 'rev-parse', stories.intake.branch) === advanced);
  const after = current(stories.intake.worktree, 'ledger', 'verify');
  check('advance', 'the ledger verifies, with the older entries and the new ones', after.valid === true && after.entries > before.entries, { entries: after.entries });
  check('advance', 'the approved Story the older build wrote is unchanged',
    git(stateRoot, '--git-dir', remote, 'rev-parse', stories.approved.branch) === before.approved);

  const report = {
    schemaVersion: 1,
    specification: 'SDA-v1 M6 legacy compatibility check',
    legacyEngine: engine(legacyRoot),
    engine: engine(packageRoot),
    runtime: { platform: process.platform, architecture: process.arch, node: process.version,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() },
    fixture: { stories: 2, ledger: 'enabled', remote: 'local bare repository', laptops: 2 },
    passed: checks.every((entry) => entry.passed),
    checks
  };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of checks) console.log(`${entry.passed ? 'pass' : 'FAIL'}  ${entry.step.padEnd(14)} ${entry.check}`);
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

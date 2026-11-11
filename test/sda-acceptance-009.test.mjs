/**
 * SDA-AC-009: pinned and amended Stories keep their exact bytes, and the configuration identities
 * keep their derivation.
 *
 * - `cfp-` and `cft-` IDs are derived exactly as before SDA. The expected values were computed by
 *   the build that preceded SDA (`main@c6a65e33b`) from the inputs below, and never change
 *   (SDA §5, §15 safety rules).
 * - A Story pinned to its workflow closure keeps that closure after the approved workflow is
 *   amended. Its source, closure, artifacts, decisions and evidence, and the ledger with its pins,
 *   stay byte-identical, locally and on the remote, through:
 *   - export: the Story published by one laptop, and that laptop's backup;
 *   - import: another laptop, with its own machine state, taking the Story over and restoring the
 *     backup, and every stored record read through its family's migrations;
 *   - index rebuild on both laptops.
 *   The other laptop reads the Story under its pinned closure, not the amended one.
 * Stories an older build wrote (legacy) are qualified against that build itself:
 * `scripts/sda-legacy-check.mjs`, reported in `benchmarks/sda/m6-qualification-rollout.md`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { configurationProposalId, configurationProposalKey, createConfigurationTransaction } from '../src/configuration-state-contract.mjs';
import { familyForStoredPath, readRecord } from '../src/schema-migrations.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('existing cfp- and cft- IDs keep the derivation they had before SDA (SDA-AC-009)', () => {
  const branch = 'sflow/config-change/workflow/review-tone-3f2a9c1b';
  const key = configurationProposalKey(branch);
  assert.equal(key, 'review-tone', 'a legacy branch suffix is a revision, not part of the identity');
  const proposalId = configurationProposalId('a'.repeat(64), key);
  assert.equal(proposalId, 'cfp-12bdc629794ceec2306d2c673b4aae2e44b8908b0e1411a780c5a91aea3e135c');
  const transaction = createConfigurationTransaction({ proposalId, proposalRevision: '1'.repeat(40), branch,
    baseCommit: '2'.repeat(40), expectedAuthorityCommit: '3'.repeat(40), actor: { name: 'Reviewer', email: 'reviewer@example.invalid' },
    changes: [
      { path: 'singularity/instructions/tone.md', beforeSha256: null, afterSha256: 'b'.repeat(64), beforeMode: null, afterMode: '100644' },
      { path: 'singularity/agents/qa.md', beforeSha256: 'c'.repeat(64), afterSha256: 'd'.repeat(64), beforeMode: '100644', afterMode: '100644' }
    ] });
  assert.equal(transaction.id, 'cft-5cb8919e2df5b2483c0d03677d5f4762e169c3e1ccf926ed18e3406957ed5ad4');
  assert.equal(transaction.digest, '4dcb7587003ca99f61a8b64729daca42c7548d0fe2c9c98bdd1bb2ed3e278176');
});

/** A laptop: its own home and machine state, sharing nothing with another but the remote. */
function laptop(base, name) {
  const root = path.join(base, name);
  const env = { ...isolatedTestEnvironment(path.join(root, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Packager',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Packager',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'packager@example.com' };
  const run = (command, args, cwd, { input, encoding = 'utf8' } = {}) => {
    const result = spawnSync(command, args, { cwd, env, input, encoding, timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, `${name}: ${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (cwd, ...args) => run('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], cwd).stdout.trim();
  const cli = (cwd, ...args) => run(process.execPath, [CLI, '--no-model', ...args], cwd);
  const json = (cwd, ...args) => JSON.parse(cli(cwd, ...args, '--json').stdout);
  return { name, root, checkout: path.join(root, 'checkout'), run, git, cli, json };
}

/** Every path, mode and object of a tree: the Story's source, closure, artifacts, decisions and evidence. */
const tree = (l, gitArgs, cwd, ref) => l.git(cwd, ...gitArgs, 'ls-tree', '-r', '--full-tree', ref);

/** The bytes of every object the ledger, its pins and the Story branch reach, with their refs. */
function ledgerAndEvidence(l, gitArgs, cwd, branch) {
  const refs = l.git(cwd, ...gitArgs, 'for-each-ref', '--format=%(refname) %(objectname)',
    'refs/heads/state', 'refs/singularity/pins', `refs/heads/${branch}`);
  const ids = l.git(cwd, ...gitArgs, 'rev-list', '--objects', ...refs.split('\n').map((line) => line.split(' ')[0]))
    .split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
  const bytes = l.run('git', [...gitArgs, 'cat-file', '--batch'], cwd, { input: Buffer.from(`${ids.join('\n')}\n`), encoding: 'buffer' }).stdout;
  return { refs, objects: ids.length, sha256: sha256(bytes) };
}

test('a pinned Story under an amended workflow keeps its bytes through export, import and index rebuild (SDA-AC-009)', slowLane({ timeout: 900_000 }), async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-009-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const a = laptop(base, 'laptop-a');
  const b = laptop(base, 'laptop-b');
  const remote = path.join(base, 'remote.git');

  // Laptop A: a repository initialized by the CLI with lightweight approvals, and its remote.
  await mkdir(a.checkout, { recursive: true });
  a.git(a.checkout, 'init', '-q', '-b', 'main');
  await writeFile(path.join(a.checkout, '.gitattributes'), '* text eol=lf\n');
  a.cli(a.checkout, 'init');
  const workflowFile = path.join(a.checkout, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(workflowFile, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(configuration.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(workflowFile, YAML.stringify(configuration));
  a.git(a.checkout, 'add', '.');
  a.git(a.checkout, 'commit', '-qm', 'Initialize the pinned-Story fixture');
  a.git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  a.git(a.checkout, 'remote', 'add', 'origin', remote);
  a.git(a.checkout, 'push', '-q', '-u', 'origin', 'main');

  // A Story with a decision and its evidence: intake published, submitted and approved.
  const WORK = 'PIN-1', BRANCH = 'delivery/pin-1';
  const started = a.json(a.checkout, 'start', WORK, '--isolated-worktree', '--from-branch', 'main', '--ref', BRANCH,
    '--work-type', 'feature', '--title', 'Pinned through takeover', '--description', 'A Story keeps the workflow it started with.');
  const story = (started.data ?? started).repositoryPath;
  const intake = path.join(story, 'singularity/work-items', WORK, 'artifacts/intake/intake.md');
  await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/gu, 'Keep the pinned workflow on every laptop.'));
  a.cli(story, 'artifact', 'scan', '--phase', 'intake');
  a.cli(story, 'phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  a.cli(story, 'submit', 'intake', '--skip-checks');
  a.cli(story, 'approve', 'intake', '--yes');
  a.git(story, 'push', '-q', 'origin', BRANCH);
  assert.equal(a.git(base, '--git-dir', remote, 'rev-parse', BRANCH), a.git(story, 'rev-parse', 'HEAD'), 'the Story is published');
  const decisions = a.git(story, 'ls-tree', '-r', '--name-only', 'HEAD', `singularity/work-items/${WORK}`);
  assert.match(decisions, /submissions\//u, 'the Story carries its review packet as evidence');
  const pinnedWorkflow = a.git(story, 'rev-parse', 'HEAD:singularity/workflow.yml');

  // The approved workflow is amended after the Story started.
  const amended = YAML.parse(await readFile(workflowFile, 'utf8'));
  amended.workTypes.feature.label = 'Feature (amended after PIN-1 started)';
  await writeFile(workflowFile, YAML.stringify(amended));
  a.git(a.checkout, 'commit', '-qam', 'Amend the feature workflow');
  a.git(a.checkout, 'push', '-q', 'origin', 'main');
  assert.notEqual(a.git(a.checkout, 'rev-parse', 'HEAD:singularity/workflow.yml'), pinnedWorkflow);

  const before = { tree: tree(a, ['--git-dir', remote], base, BRANCH), remote: ledgerAndEvidence(a, ['--git-dir', remote], base, BRANCH),
    local: ledgerAndEvidence(a, [], a.checkout, BRANCH) };
  assert.ok(before.remote.objects > 0);
  const entries = (l, cwd) => {
    const verified = l.json(cwd, 'ledger', 'verify');
    assert.equal(verified.valid, true, JSON.stringify(verified));
    return verified.entries;
  };
  const ledgerEntries = entries(a, story);
  const unchanged = (step) => {
    assert.deepEqual(ledgerAndEvidence(a, ['--git-dir', remote], base, BRANCH), before.remote, `${step}: the remote Story, ledger or pins changed`);
    assert.deepEqual(ledgerAndEvidence(a, [], a.checkout, BRANCH), before.local, `${step}: laptop A's Story, ledger or pins changed`);
  };

  // Export: laptop A backs up what exists only there. Index rebuild on A.
  const carry = path.join(base, 'carry');
  a.json(a.checkout, 'backup', 'create', '--out', carry);
  for (const cwd of [story, a.checkout]) a.json(cwd, 'index', 'rebuild');
  unchanged('index rebuild on laptop A');

  // Import: every stored record read through its family's migrations, then the CLI readers.
  const families = new Set();
  for (const [ref, prefix] of [['refs/heads/state', '$state/'], [BRANCH, '']]) {
    for (const line of a.git(a.checkout, 'ls-tree', '-r', ref).split('\n')) {
      const [meta, stored] = line.split('\t');
      const [, type, object] = meta.split(' ');
      const family = type === 'blob' && stored.endsWith('.json') ? familyForStoredPath(`${prefix}${stored}`) : null;
      if (!family) continue;
      assert.ok(readRecord(family.id, a.run('git', ['cat-file', 'blob', object], a.checkout, { encoding: 'buffer' }).stdout).record,
        `${stored} reads as ${family.id}`);
      families.add(family.id);
    }
  }
  assert.ok(families.has('ledger-entry') && families.has('story-workflow'), [...families].join(', '));
  for (const args of [['status'], ['nextsteps'], ['session', 'candidates']]) a.json(story, ...args);
  unchanged('record reads on laptop A');

  // Import on laptop B: a clone with its own machine state takes the Story over and restores the backup.
  b.git(base, 'clone', '-q', remote, b.checkout);
  const taken = b.json(b.checkout, 'session', 'takeover', WORK);
  assert.ok(taken.localWorkNotCarried, JSON.stringify(taken));
  b.json(b.checkout, 'backup', 'restore', carry);
  b.json(b.checkout, 'index', 'rebuild');
  assert.equal(tree(b, [], b.checkout, BRANCH), before.tree, 'laptop B holds the Story exactly as published');
  assert.deepEqual(ledgerAndEvidence(b, [], b.checkout, BRANCH).refs.split('\n').filter((line) => line.includes(BRANCH)),
    before.remote.refs.split('\n').filter((line) => line.includes(BRANCH)));
  assert.equal(b.git(b.checkout, 'rev-parse', `${BRANCH}:singularity/workflow.yml`), pinnedWorkflow,
    'laptop B reads the Story under its pinned closure, not the amended workflow');
  assert.equal(entries(b, b.checkout), ledgerEntries, 'the ledger verifies on laptop B with the same entries');
  unchanged('takeover, backup restore and index rebuild on laptop B');
});

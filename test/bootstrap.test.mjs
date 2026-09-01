/**
 * Going from a repository that has never heard of Singularity Flow to one everything else can read.
 *
 * This was the product's only chicken-and-egg problem, and it was in the worst possible place: to
 * use the tool you needed a governed repository, and to get one you needed the tool. Every piece
 * existed — `init` governs a checkout, `capability add` writes a map, `ledger init` makes the orphan
 * branch — and nothing composed them from a URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import {
  bootstrapBranchPatterns, bootstrapRepository, repositoryIdFromUrl
} from '../src/bootstrap.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Bootstrap Tester';

/** A bare remote with one commit, which is what a real repository looks like before any of this. */
async function remote({ branch = 'main' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-'));
  const bare = path.join(base, 'acme-platform.git');
  await mkdir(bare);
  run('git', ['init', '-q', '--bare', bare], { cwd: base });
  const seed = path.join(base, 'seed');
  await mkdir(seed);
  run('git', ['init', '-q', '-b', branch, seed], { cwd: base });
  await writeFile(path.join(seed, 'README.md'), '# Acme platform\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['-c', 'user.email=a@b.com', '-c', 'user.name=A B', 'commit', '-qm', 'Initial'], { cwd: seed });
  run('git', ['push', '-q', bare, `${branch}:${branch}`], { cwd: seed });
  return { base, bare };
}

test('a repository identifier comes from the URL, however it is written', () => {
  assert.equal(repositoryIdFromUrl('https://git.example.corp/acme/Commerce-Platform.git'), 'commerce-platform');
  assert.equal(repositoryIdFromUrl('git@git.example.corp:acme/platform.git'), 'platform');
  assert.equal(repositoryIdFromUrl('/srv/git/platform.git/'), 'platform');
  assert.throws(() => repositoryIdFromUrl(''), /Cannot derive a repository identifier/);
  assert.deepEqual(bootstrapBranchPatterns(), [
    'HEAD', 'refs/heads/main', 'refs/heads/master'
  ], 'normal bootstrap discovery remains bounded to one conventional-ref request');
  assert.deepEqual(bootstrapBranchPatterns({ fallback: true }), ['refs/heads/*'],
    'all-head discovery is an explicit recovery request');
});

test('bootstrapping governs a repository that knew nothing about any of this', async () => {
  const { base, bare } = await remote();
  const result = await bootstrapRepository(bare, {
    capabilityId: 'commerce',
    capabilityName: 'Commerce',
    jiraProject: 'COM',
    teams: ['Platform', 'Payments'],
    base: path.join(base, 'work')
  });

  assert.equal(result.cloned, true);
  assert.equal(result.repositoryId, 'acme-platform');
  assert.equal(result.branch, 'main');
  assert.equal(result.configurationBranch, 'sflow/config');
  assert.equal(result.configurationCreated, true);

  // Nothing was written to the checkout. The definition lives on the configuration branch, and
  // `start` materializes it into each Story branch — so a protected application branch is never a
  // participant and there is no proposal to merge before work begins.
  assert.ok(!existsSync(path.join(result.root, 'singularity')), 'the checkout carries no governance');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: result.root }).stdout.trim(), '');
  assert.equal(run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.root }).stdout.trim(), 'main');

  // …and the three files everything else reads are on the configuration branch.
  const configFile = (file) =>
    run('git', ['--git-dir', bare, 'show', `sflow/config:singularity/${file}`]).stdout;
  for (const file of ['workflow.yml', 'portfolio.yml', 'capabilities.yml']) {
    assert.ok(configFile(file).trim(), `sflow/config carries singularity/${file}`);
  }

  // The capability the person named is the map's only root — not the placeholder init writes.
  const map = YAML.parse(configFile('capabilities.yml'));
  assert.deepEqual(Object.keys(map.capabilities), ['commerce']);
  assert.equal(map.capabilities.commerce.name, 'Commerce');
  assert.equal(map.capabilities.commerce.kind, 'collection');
  assert.equal(map.capabilities.commerce.repository, undefined);
  assert.equal(map.capabilities.commerce.parent, null);
  assert.equal(map.capabilities.commerce.jira.projectKey, 'COM');
  assert.deepEqual(map.capabilities.commerce.teams, ['Platform', 'Payments']);

  // The repository is declared, so a capability may deliver from it.
  const portfolio = YAML.parse(configFile('portfolio.yml'));
  assert.equal(portfolio.repositories['acme-platform'].url, bare);
  assert.equal(portfolio.repositories['acme-platform'].defaultBranch, 'main');

  // New authorities are immediately usable by the person establishing the repository. Story and
  // Initiative groups are both populated so the first failure cannot be deferred to approval time.
  assert.ok(Object.values(portfolio.approvalAuthorities).every((authority) =>
    authority.members?.some((member) => member.email === 'bootstrap.tester@example.com')),
  'every Initiative approval authority contains the current Git identity');
  const workflow = YAML.parse(configFile('workflow.yml'));
  assert.ok(Object.values(workflow.approvalAuthorities).every((authority) =>
    authority.members?.some((member) => member.email === 'bootstrap.tester@example.com')),
  'every Story approval authority contains the current Git identity');

  // The orphan state branch exists, locally and on the remote.
  assert.equal(result.stateBranch, 'state');
  assert.equal(result.ledgerCreated, true);
  const heads = run('git', ['ls-remote', '--heads', bare], { allowFailure: true }).stdout;
  assert.match(heads, /refs\/heads\/state/);
  assert.match(heads, /refs\/heads\/main/);
  assert.match(heads, /refs\/heads\/sflow\/config/);
  assert.doesNotMatch(heads, /refs\/heads\/sflow\/govern\//, 'no review branch is created');
  assert.notEqual(
    run('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], { cwd: result.root, allowFailure: true }).status,
    0,
    'application history stays unchanged until the governance proposal is reviewed'
  );
  assert.equal(
    run('git', ['--git-dir', bare, 'cat-file', '-e', 'sflow/config:singularity/workflow.yml'], {
      allowFailure: true
    }).status,
    0,
    'the orphan configuration authority is seeded from the review proposal'
  );

  // The state branch shares no ancestry with the code branch — that is what makes governance
  // history un-rewritable by a rebase of the work it records.
  const merged = run('git', ['merge-base', 'main', 'state'],
    { cwd: result.root, allowFailure: true });
  assert.notEqual(merged.status, 0, 'the state branch is an orphan');

  const configurationMergeBase = run('git', ['merge-base', 'main', 'sflow/config'],
    { cwd: result.root, allowFailure: true });
  assert.notEqual(configurationMergeBase.status, 0,
    'sflow/config is an orphan configuration authority');
});

test('a remote whose HEAD points nowhere is still bootstrapped onto its real branch', async () => {
  // `git init --bare` leaves HEAD pointing at a branch that never appears, so cloning detaches and
  // `rev-parse --abbrev-ref HEAD` answers "HEAD" — which was recorded as the default branch.
  const { base, bare } = await remote({ branch: 'trunk' });
  const result = await bootstrapRepository(bare, {
    capabilityId: 'commerce', base: path.join(base, 'work'), stateBranch: null, push: false
  });
  assert.equal(result.branch, 'trunk');
  const portfolio = YAML.parse(await readFile(path.join(result.root, 'singularity/portfolio.yml'), 'utf8'));
  assert.equal(portfolio.repositories['acme-platform'].defaultBranch, 'trunk');
  const workflow = YAML.parse(await readFile(path.join(result.root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(workflow.defaultBaseBranch, 'trunk', 'lifecycle guards use the detected application branch');
  assert.equal(
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.root }).stdout.trim(), 'trunk');
});

test('pushed bootstrap pins the detected non-main branch in approved configuration', async () => {
  const { base, bare } = await remote({ branch: 'trunk' });
  const result = await bootstrapRepository(bare, {
    capabilityId: 'commerce', base: path.join(base, 'work'), stateBranch: null
  });
  assert.equal(result.branch, 'trunk');
  const workflow = YAML.parse(run('git', [
    '--git-dir', bare, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  assert.equal(workflow.defaultBaseBranch, 'trunk');
});

test('repeat bootstrap rejects a requested capability absent from approved configuration', async () => {
  const { base, bare } = await remote();
  const into = path.join(base, 'work', 'acme-platform');
  await bootstrapRepository(bare, {
    capabilityId: 'alpha', capabilityName: 'ALPHA', into, stateBranch: null
  });
  await assert.rejects(
    () => bootstrapRepository(bare, {
      capabilityId: 'beta', capabilityName: 'BETA', into, stateBranch: null
    }),
    /does not define requested capability 'beta'/
  );
  const map = YAML.parse(run('git', [
    '--git-dir', bare, 'show', 'sflow/config:singularity/capabilities.yml'
  ]).stdout);
  assert.deepEqual(Object.keys(map.capabilities), ['alpha']);
});

test('bootstrap never attempts to update a protected application branch', async () => {
  const { base, bare } = await remote();
  const hookLog = path.join(base, 'received-refs.log');
  const hook = path.join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
while read old new ref
do
  printf '%s\\n' "$ref" >> "${hookLog}"
  if [ "$ref" = refs/heads/main ]; then
    echo "application branch is protected" >&2
    exit 1
  fi
done
`, 'utf8');
  await chmod(hook, 0o755);
  const before = run('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main']).stdout.trim();

  const result = await bootstrapRepository(bare, {
    capabilityId: 'commerce', base: path.join(base, 'work')
  });

  const received = await readFile(hookLog, 'utf8');
  assert.doesNotMatch(received, /^refs\/heads\/main$/m,
    'the protected application branch was never presented to the remote hook');
  assert.match(received, /^refs\/heads\/sflow\/config$/m);
  assert.match(received, /^refs\/heads\/state$/m);
  assert.equal(run('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main']).stdout.trim(), before);
});

test('the portfolio still parses, and still reads as the commented file it is', async () => {
  // A first attempt patched the file as text and appended a `repositories:` block when it could not
  // find an empty one. The starter declares `repositories: {}`, so the key ended up in the file
  // twice and nothing could parse it — including every command that would have reported the problem.
  const { base, bare } = await remote();
  const result = await bootstrapRepository(bare, {
    capabilityId: 'commerce', kind: 'delivery', base: path.join(base, 'work'), push: false
  });
  const text = await readFile(path.join(result.root, 'singularity/portfolio.yml'), 'utf8');
  assert.equal((text.match(/^repositories:/gm) ?? []).length, 1);
  assert.doesNotThrow(() => YAML.parse(text));
  const capabilities = YAML.parse(await readFile(
    path.join(result.root, 'singularity/capabilities.yml'), 'utf8'));
  assert.equal(capabilities.capabilities.commerce.kind, 'delivery');
  assert.equal(capabilities.capabilities.commerce.repository, 'acme-platform');
  // The commentary that explains each setting survived, on the first thing anybody does to the file.
  assert.match(text, /^#/m);
});

test('bootstrapping twice adopts the checkout rather than demanding a clean slate', async () => {
  // The first attempt may fail after cloning — no push access, a bad capability name — and asking
  // somebody to delete a directory before retrying is a poor recovery story.
  const { base, bare } = await remote();
  const into = path.join(base, 'work', 'acme-platform');
  const first = await bootstrapRepository(bare, {
    capabilityId: 'commerce', into, stateBranch: null, push: false
  });
  assert.equal(first.cloned, true);

  const again = await bootstrapRepository(bare, {
    capabilityId: 'commerce', into, stateBranch: null, push: false
  });
  assert.equal(again.cloned, false, 'the existing checkout was adopted');
  const portfolio = YAML.parse(await readFile(path.join(into, 'singularity/portfolio.yml'), 'utf8'));
  assert.equal(Object.keys(portfolio.repositories).length, 1, 'declared once, not twice');
});

test('a URL nothing answers is refused before anything is written', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-missing-'));
  await assert.rejects(
    () => bootstrapRepository(path.join(base, 'absent.git'), { capabilityId: 'commerce', base }),
    /Cannot clone/);
  assert.equal(existsSync(path.join(base, 'absent')), false);
});

test('bootstrap rejects an unborn remote after one bounded fallback inventory', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-unborn-'));
  const bare = path.join(base, 'unborn.git');
  await mkdir(bare);
  run('git', ['init', '-q', '--bare', bare], { cwd: base });
  await assert.rejects(
    () => bootstrapRepository(bare, { capabilityId: 'unborn', base }),
    (error) => error?.code === 'REMOTE_BRANCH_NOT_FOUND'
  );
  assert.equal(existsSync(path.join(base, 'unborn')), false);
});

test('bootstrap does not execute inherited Git transport commands', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-command-env-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const marker = path.join(base, 'transport-command-ran');
  const command = path.join(base, 'hostile-ssh.mjs');
  await writeFile(command, [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'executed\\n');`,
    'process.exit(1);',
    ''
  ].join('\n'));
  await chmod(command, 0o755);
  const changed = {
    GIT_SSH: command,
    GIT_SSH_COMMAND: `"${process.execPath}" "${command}"`,
    SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS: '1000'
  };
  const previous = new Map(Object.keys(changed).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changed);
  try {
    await assert.rejects(
      () => bootstrapRepository('ssh://127.0.0.1:1/acme/repository.git', {
        capabilityId: 'safe-transport', base
      }),
      /Cannot clone/
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(existsSync(marker), false,
    'bootstrap executed an inherited Git transport command');
});

test('bootstrap remote discovery is asynchronously supervised and bounded', {
  skip: process.platform === 'win32'
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bootstrap-deadline-'));
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  const fakeGit = path.join(bin, 'git');
  await writeFile(fakeGit, [
    '#!/usr/bin/env node',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));
  await chmod(fakeGit, 0o755);

  const keys = [
    'PATH', 'SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS',
    'SINGULARITY_FLOW_GIT_TERMINATION_GRACE_MS'
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS = '30';
  process.env.SINGULARITY_FLOW_GIT_TERMINATION_GRACE_MS = '40';
  let eventLoopAdvanced = false;
  const tick = setTimeout(() => { eventLoopAdvanced = true; }, 5);
  const startedAt = performance.now();
  try {
    await assert.rejects(
      bootstrapRepository('https://deadline.invalid/repository.git', {
        capabilityId: 'deadline', base
      }),
      (error) => error?.code === 'REMOTE_NETWORK_TRANSIENT'
    );
  } finally {
    clearTimeout(tick);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  assert.equal(eventLoopAdvanced, true,
    'bootstrap blocked the event loop while waiting for remote discovery');
  assert.ok(elapsedMs < 500, `bootstrap escaped its deadline plus grace (${elapsedMs}ms)`);
});

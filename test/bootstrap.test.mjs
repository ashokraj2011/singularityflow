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
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { bootstrapRepository, repositoryIdFromUrl } from '../src/bootstrap.mjs';

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
  assert.ok(result.commit, 'the governed configuration was committed');

  // singularity/ exists, with the three files everything else reads.
  for (const file of ['workflow.yml', 'portfolio.yml', 'capabilities.yml']) {
    assert.ok(existsSync(path.join(result.root, 'singularity', file)), `singularity/${file}`);
  }

  // The capability the person named is the map's only root — not the placeholder init writes.
  const map = YAML.parse(await readFile(path.join(result.root, 'singularity/capabilities.yml'), 'utf8'));
  assert.deepEqual(Object.keys(map.capabilities), ['commerce']);
  assert.equal(map.capabilities.commerce.name, 'Commerce');
  assert.equal(map.capabilities.commerce.kind, 'collection');
  assert.equal(map.capabilities.commerce.repository, undefined);
  assert.equal(map.capabilities.commerce.parent, null);
  assert.equal(map.capabilities.commerce.jira.projectKey, 'COM');
  assert.deepEqual(map.capabilities.commerce.teams, ['Platform', 'Payments']);

  // The repository is declared, so a capability may deliver from it.
  const portfolio = YAML.parse(await readFile(path.join(result.root, 'singularity/portfolio.yml'), 'utf8'));
  assert.equal(portfolio.repositories['acme-platform'].url, bare);
  assert.equal(portfolio.repositories['acme-platform'].defaultBranch, 'main');

  // An Epic cannot start until an authority has a member, and on a repository nobody else has
  // touched the person doing this is the only true answer.
  const named = Object.values(portfolio.approvalAuthorities).filter((authority) => authority.members?.length);
  assert.ok(named.length, 'at least one approval authority has a member');

  // The orphan state branch exists, locally and on the remote.
  assert.equal(result.stateBranch, 'state');
  assert.equal(result.ledgerCreated, true);
  const heads = run('git', ['ls-remote', '--heads', bare], { allowFailure: true }).stdout;
  assert.match(heads, /refs\/heads\/state/);
  assert.match(heads, /refs\/heads\/main/);

  // The state branch shares no ancestry with the code branch — that is what makes governance
  // history un-rewritable by a rebase of the work it records.
  const merged = run('git', ['merge-base', 'main', 'state'],
    { cwd: result.root, allowFailure: true });
  assert.notEqual(merged.status, 0, 'the state branch is an orphan');
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
  assert.equal(
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.root }).stdout.trim(), 'trunk');
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

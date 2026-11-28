/**
 * SFlow's own private refs never ask a repository's commit policy; a person's and Copilot's writes still do [owner,
 * 2026-11-28: no one gets stuck, and every decision says plainly why].
 *
 * SFlow keeps a configuration cache in a repository's .git/singularity-flow/ (configuration-object-store.mjs) and moves its
 * own retention refs there (refs/heads/sflow/config and the proposals beside it). In a repository whose approved policy
 * enforces commits, those writes were judged as the person's, so workspace setup stopped with
 * WORKSPACE_CAPABILITY_CATALOG_UNAVAILABLE ("This Git write needs an exact owner-issued plan"). Every such writer now takes
 * one rule, util.mjs withPrivateGitRef; a policy SFlow cannot read says why and how to fix it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertCommitGitAdmission, withPrivateGitRef } from '../src/util.mjs';
import { createWorkspaceConfiguration } from '../src/workspace.mjs';
import { sourceRefUpdates } from './helpers/ref-update-sites.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENFORCE = 'git:\n  commitPolicy:\n    mode: enforce\n';
const refused = { code: 'RCP_OWNER_ADMISSION_REQUIRED' };
const COMMIT = ['commit', '-m', 'a person\'s change'];

// Fixture Git runs as plain git, never through SFlow's own run(): the policy under test would refuse the fixture's commits.
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function base(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sflow-private-refs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function identify(checkout) {
  git(checkout, 'config', 'user.name', 'Private Refs Tester');
  git(checkout, 'config', 'user.email', 'private-refs@example.invalid');
}

function repository(root, id) {
  const source = path.join(root, `${id}-source`);
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  identify(source);
  writeFileSync(path.join(source, 'service.txt'), `${id}\n`);
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'initial');
  const bare = path.join(root, `${id}.git`);
  git(root, 'clone', '-q', '--bare', source, bare);
  return bare;
}

/**
 * The lead repository's approved sflow/config, as an organisation that enforces commits has it: the capability map, its
 * portfolio and a definition whose commit policy is enforced. A person's clone of it carries origin/sflow/config.
 */
function enforcingOrganisation(root) {
  const api = repository(root, 'api');
  const web = repository(root, 'web');
  const authority = path.join(root, 'authority');
  git(root, 'clone', '-q', api, authority);
  identify(authority);
  git(authority, 'switch', '-q', '--orphan', 'sflow/config');
  mkdirSync(path.join(authority, 'singularity'));
  writeFileSync(path.join(authority, 'singularity/workflow.yml'), ENFORCE);
  writeFileSync(path.join(authority, 'singularity/capabilities.yml'), [
    'version: 1', 'capabilities:',
    '  checkout: { name: Checkout, kind: collection, parent: null }',
    '  checkout-api: { name: Checkout API, kind: delivery, parent: checkout, repository: api }',
    '  checkout-web: { name: Checkout Web, kind: delivery, parent: checkout, repository: web }', ''].join('\n'));
  writeFileSync(path.join(authority, 'singularity/portfolio.yml'), [
    'version: 1', 'repositories:',
    `  api: { url: ${JSON.stringify(api)}, defaultBranch: main }`,
    `  web: { url: ${JSON.stringify(web)}, defaultBranch: main }`, ''].join('\n'));
  git(authority, 'add', '-A');
  git(authority, 'commit', '-qm', 'approve capabilities and an enforced commit policy');
  git(authority, 'push', '-q', 'origin', 'HEAD:refs/heads/sflow/config');
  const approved = git(authority, 'rev-parse', 'HEAD');
  const app = path.join(root, 'app');
  git(root, 'clone', '-q', api, app);
  identify(app);
  return { api, web, app, approved };
}

function inside(t, directory) {
  const before = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(before));
}

test('workspace setup where commits are enforced reads the approved capabilities; the person\'s writes are still checked', async (t) => {
  const root = base(t);
  const { api, web, app, approved } = enforcingOrganisation(root);
  const head = git(app, 'rev-parse', 'HEAD');
  assert.throws(() => assertCommitGitAdmission(app, COMMIT), refused, 'the policy holds here');

  // Setup runs where the person is, so SFlow's configuration cache lives in this repository's .git/singularity-flow/.
  inside(t, app);
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'checkout', name: 'Checkout', leadRepository: 'api',
    capabilities: ['checkout-api', 'checkout-web'],
    repositories: {
      api: { url: api, defaultBranch: 'main', capabilities: ['checkout-api'] },
      web: { url: web, defaultBranch: 'main', capabilities: ['checkout-web'] }
    }
  }, { confirmation: 'checkout', clone: false });
  assert.equal(created.workspace.id, 'local--checkout');

  // The cache kept its own retention ref; nothing of the person's moved.
  const pools = path.join(app, '.git/singularity-flow/configuration-objects-v1');
  const stores = readdirSync(pools, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.equal(stores.length, 1, stores.join(', '));
  assert.equal(git(path.join(pools, stores[0]), 'rev-parse', 'refs/heads/sflow/config'), approved);
  assert.equal(git(app, 'rev-parse', 'HEAD'), head);

  // A person's or Copilot's write in the same repository is checked as before.
  assert.throws(() => assertCommitGitAdmission(app, COMMIT), refused);
  assert.throws(() => assertCommitGitAdmission(app, ['update-ref', 'refs/heads/main', head]), refused);
  assert.throws(() => assertCommitGitAdmission(app, ['push', 'origin', 'main']), refused);
});

test('the private-ref rule admits exactly one ref update, never a commit, a push or another ref', (t) => {
  const { app } = enforcingOrganisation(base(t));
  const head = git(app, 'rev-parse', 'HEAD');
  const mine = ['update-ref', 'refs/heads/sflow-cache', head];
  assert.throws(() => withPrivateGitRef(app, COMMIT, {}, () => {}), TypeError);
  assert.throws(() => withPrivateGitRef(app, ['push', 'origin', 'main'], {}, () => {}), TypeError);
  withPrivateGitRef(app, mine, {}, () => {
    assert.doesNotThrow(() => assertCommitGitAdmission(app, mine));
    assert.throws(() => assertCommitGitAdmission(app, ['update-ref', 'refs/heads/main', head]), refused, 'another ref is the person\'s');
    assert.throws(() => assertCommitGitAdmission(app, COMMIT), refused, 'a commit is never private');
  });
  assert.throws(() => assertCommitGitAdmission(app, mine), refused, 'outside the rule the same write is checked');
});

test('a policy SFlow cannot read refuses in one plain line that says why and how to fix it', (t) => {
  const root = base(t);
  const { app } = enforcingOrganisation(root);

  // An approved ref Git cannot read: the policy is unknown, not adopted.
  const loose = path.join(app, '.git/refs/remotes/origin/sflow/config');
  mkdirSync(path.dirname(loose), { recursive: true });
  writeFileSync(loose, `${'1'.repeat(40)}\n`);
  const unreadable = (() => { try { assertCommitGitAdmission(app, COMMIT); } catch (error) { return error; } return null; })();
  assert.equal(unreadable?.code, 'RCP_OWNER_ADMISSION_REQUIRED');
  assert.equal(unreadable.details.reason, 'policy-unreadable');
  assert.match(unreadable.message, /^SFlow wrote nothing in .*: it could not tell whether a commit policy applies there, because Git could not read its sflow\/config commit 111111111111 \(.+\)\. Run git status there: it names what Git cannot read\. Repair that, then run this again\.$/u);
  assert.doesNotMatch(unreadable.message, /owner-issued|is adopted/u);
  assert.ok(!unreadable.message.includes('\n'));

  // The repository's HEAD is gone (the scratch-store case of 2026-11-28): Git sees no repository at all.
  rmSync(path.join(app, '.git/HEAD'));
  const headless = (() => { try { assertCommitGitAdmission(app, COMMIT); } catch (error) { return error; } return null; })();
  assert.equal(headless?.details?.reason, 'policy-unreadable');
  assert.match(headless.message, /because .*\.git[/\\]HEAD is missing, so Git sees no repository there\. Put that file back \(one line, such as ref: refs\/heads\/main\), then run this again\.$/u);

  // An adopted policy still says so.
  const again = path.join(root, 'again');
  mkdirSync(again);
  const adopted = enforcingOrganisation(again).app;
  assert.throws(() => assertCommitGitAdmission(adopted, COMMIT), (error) => error.code === 'RCP_OWNER_ADMISSION_REQUIRED'
    && !error.details.reason && /a commit policy is adopted/u.test(error.message));
});

// Every ref update in src is reviewed [owner, 2026-11-28]. SFlow's own (a cache's retention refs, a state branch mirroring its
// remote, the policy's own retention): through withPrivateGitRef, so no repository's commit policy can stop it. A person's or
// Copilot's (a Story branch, a checkout's HEAD, a configuration proposal): checked by the policy as before, and counted here.
const CHECKED_REF_UPDATES = Object.freeze({
  'src/auto/auto-candidate.mjs': 1, 'src/change-flight-plan.mjs': 4, 'src/cli.mjs': 1, 'src/configuration-branch.mjs': 5,
  'src/configuration-local-history-prune.mjs': 1, 'src/configuration-people.mjs': 2, 'src/configuration-projection.mjs': 1,
  'src/configuration-proposal.mjs': 1, 'src/configuration-state-git.mjs': 1, 'src/git-configuration-objects.mjs': 3,
  'src/git.mjs': 8, 'src/ledger.mjs': 5, 'src/organisation.mjs': 3, 'src/publication-recovery.mjs': 1,
  'src/reference-prefetch.mjs': 1, 'src/repository-commit-policy/runtime.mjs': 1, 'src/repository-commit-policy/writer.mjs': 1,
  'src/sgos/candidate-lifecycle.mjs': 3, 'src/state.mjs': 1, 'src/story-state-ref.mjs': 12, 'src/story-worktree.mjs': 3,
  'src/transport-intents.mjs': 1, 'src/workspace-configuration-refresh.mjs': 1
});

test('every ref update in src is SFlow\'s own through the private-ref rule, or a person\'s that the policy checks', () => {
  const found = sourceRefUpdates(packageRoot);
  const checked = Object.fromEntries(Object.entries(found).filter(([, sites]) => sites.checked).map(([file, sites]) => [file, sites.checked]));
  assert.deepEqual(checked, CHECKED_REF_UPDATES, 'A ref update changed. If the ref is SFlow\'s own (a cache, its retention, a mirror of '
    + 'what a remote holds), wrap it in withPrivateGitRef (util.mjs); if it is a person\'s or Copilot\'s, update CHECKED_REF_UPDATES.');
  // The configuration cache's refs are all SFlow's own: none of them can be stopped by the policy of the repository holding it.
  assert.deepEqual(found['src/configuration-object-store.mjs'], { private: 4, checked: 0 });

  // No writer makes its own private-ref admission beside the rule.
  const handMade = [];
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(packageRoot, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith('.mjs') && relative !== 'src/util.mjs'
        && readFileSync(path.join(packageRoot, relative), 'utf8').includes('\'private-ref\'')) handMade.push(relative);
    }
  };
  walk('src');
  assert.deepEqual(handMade, [], 'make a private ref through withPrivateGitRef, never a hand-made private-ref admission');
});

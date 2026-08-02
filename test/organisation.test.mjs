/**
 * Mapping an organisation, and building a workspace out of it.
 *
 * The two halves of the same model. A capability is mapped to a Git repository without anything
 * being checked out; a workspace is a set of those capabilities plus a local directory, and the
 * repositories it clones are what those capabilities ship from rather than a second list.
 *
 * These run against real repositories rather than stubs. Every claim here — the map reached the
 * remote, nothing was left on disk, the orphan branch exists — is only true of Git, so a fake would
 * be testing the fake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import {
  initializeWorkspaceState, mapCapability, readOrganisation, resolveWorkspacePlan
} from '../src/organisation.mjs';

/** Bare repositories with one commit each, standing in for an organisation's remotes. */
async function remotes(...names) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-org-'));
  const made = {};
  for (const name of names) {
    const bare = path.join(base, `${name}.git`);
    // -b main so the bare repo's HEAD names the branch that is actually pushed to it.
    run('git', ['init', '-q', '-b', 'main', '--bare', bare], { cwd: base });
    const seed = path.join(base, `${name}-seed`);
    run('git', ['init', '-q', '-b', 'main', seed], { cwd: base });
    run('git', ['config', 'user.email', 'a@b.com'], { cwd: seed });
    run('git', ['config', 'user.name', 'A B'], { cwd: seed });
    await writeFile(path.join(seed, 'README.md'), `# ${name}\n`);
    run('git', ['add', '-A'], { cwd: seed });
    run('git', ['commit', '-qm', 'Initial'], { cwd: seed });
    run('git', ['push', '-q', bare, 'main:main'], { cwd: seed });
    made[name] = bare;
  }
  return { base, ...made };
}

const registry = (base) => path.join(base, 'leads.json');

test('the first capability governs the repository it is mapped into', async () => {
  // The product's one circular dependency: mapping a capability needed a map, and the only way to
  // get a map was to map a capability. Refusing here is what made starting impossible.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);

  const first = await mapCapability(org.platform, {
    capabilityId: 'commerce', name: 'Commerce', kind: 'portfolio'
  });
  assert.equal(first.capabilityId, 'commerce');

  const governed = run('git', ['show', 'main:singularity/workflow.yml'], { cwd: org.platform }).stdout;
  assert.match(governed, /branch: state/, 'the orphan branch is named for a workspace to create');
  const map = run('git', ['show', 'main:singularity/capabilities.yml'], { cwd: org.platform }).stdout;
  assert.match(map, /commerce:/);
  // The placeholder root `init` writes gives way to the capability actually being mapped, rather
  // than colliding with it — a tree may have exactly one root.
  assert.doesNotMatch(map, /placeholder|your-capability/i);

  // And the second one finds the map already there rather than governing again.
  await mapCapability(org.platform, {
    capabilityId: 'payments', name: 'Payments', kind: 'product', parent: 'commerce'
  });
  const both = run('git', ['show', 'main:singularity/capabilities.yml'], { cwd: org.platform }).stdout;
  assert.match(both, /parent: commerce/);
});

test('mapping leaves nothing behind: the lead is borrowed, not checked out', async () => {
  // Nobody chose a folder, so nothing may be left in one. The temporary clone is the whole point of
  // this being callable from a window with no repository open.
  const org = await remotes('platform');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  const before = await readdir(org.base);

  await mapCapability(org.platform, { capabilityId: 'commerce', kind: 'portfolio' });

  assert.deepEqual((await readdir(org.base)).sort(), before.sort());
});

test('a capability that ships declares its repository; a grouping declares none', async () => {
  const org = await remotes('platform', 'api');
  process.env.SINGULARITY_FLOW_LEAD_REGISTRY = registry(org.base);
  await mapCapability(org.platform, { capabilityId: 'commerce', kind: 'portfolio' });
  await mapCapability(org.platform, {
    capabilityId: 'payments-api', name: 'Payments API', parent: 'commerce', repositoryUrl: org.api
  });

  const read = await readOrganisation(org.platform);
  assert.equal(read.capabilities[0].id, 'commerce');
  assert.equal(read.capabilities[0].repository, null, 'a grouping ships from nothing');
  assert.equal(read.capabilities[0].children[0].repository, 'api');
  // Declared in the portfolio in the same edit, so the capability can never name a repository that
  // has nowhere to be cloned from.
  assert.equal(read.repositories.api.url, org.api);
});

test('a workspace plan is what the chosen capabilities ship from, not a second list', () => {
  const organisation = {
    capabilities: [{
      id: 'commerce', name: 'Commerce', repository: null, children: [
        { id: 'payments', name: 'Payments', repository: null, children: [
          { id: 'payments-api', name: 'Payments API', repository: 'api', children: [] }
        ] },
        { id: 'storefront-web', name: 'Storefront Web', repository: 'web', children: [] }
      ]
    }],
    repositories: {
      api: { url: 'https://example.com/api.git', defaultBranch: 'main' },
      web: { url: 'https://example.com/web.git', defaultBranch: 'trunk' }
    }
  };

  // Choosing a grouping means everything beneath it, the way choosing a directory means its
  // contents.
  const whole = resolveWorkspacePlan(organisation, { capabilities: ['commerce'] });
  assert.deepEqual(Object.keys(whole.repositories).sort(), ['api', 'web']);
  assert.equal(whole.repositories.web.defaultBranch, 'trunk');
  assert.deepEqual(whole.capabilities, ['commerce'], 'the selection is recorded, not its expansion');

  const part = resolveWorkspacePlan(organisation, { capabilities: ['payments'] });
  assert.deepEqual(Object.keys(part.repositories), ['api']);

  // The lead is the workspace's centre of gravity, and defaults rather than being demanded.
  assert.equal(part.leadCapability, 'payments-api');
  assert.equal(part.leadRepository, 'api');
  assert.equal(
    resolveWorkspacePlan(organisation, { capabilities: ['commerce'], leadCapability: 'storefront-web' })
      .leadRepository, 'web');
});

test('a workspace plan refuses what would produce nothing to work in', () => {
  const organisation = {
    capabilities: [{ id: 'commerce', name: 'Commerce', repository: null, children: [] }],
    repositories: {}
  };
  assert.throws(() => resolveWorkspacePlan(organisation, { capabilities: [] }), /at least one capability/);
  assert.throws(() => resolveWorkspacePlan(organisation, { capabilities: ['nope'] }), /Unknown capability/);
  assert.throws(() => resolveWorkspacePlan(organisation, { capabilities: ['commerce'] }),
    /ships from a repository/);

  // A grouping cannot lead: leading means carrying the state branch, and it has no repository.
  const shipping = {
    capabilities: [{
      id: 'commerce', repository: null,
      children: [{ id: 'api-service', repository: 'api', children: [] }]
    }],
    repositories: { api: { url: 'https://example.com/api.git' } }
  };
  assert.throws(
    () => resolveWorkspacePlan(shipping, { capabilities: ['commerce'], leadCapability: 'commerce' }),
    /does not ship from a repository/);

  // A capability naming a repository the portfolio does not declare is named, not silently dropped.
  assert.throws(
    () => resolveWorkspacePlan({ ...shipping, repositories: {} }, { capabilities: ['commerce'] }),
    /does not declare/);
});

test('initialising a workspace creates the orphan state branch, and checks before it does', async () => {
  const org = await remotes('api');
  const work = path.join(org.base, 'work');
  run('git', ['clone', '-q', org.api, work], { cwd: org.base });
  run('git', ['config', 'user.email', 'a@b.com'], { cwd: work });
  run('git', ['config', 'user.name', 'A B'], { cwd: work });

  // A checkout with nothing on it is refused in words rather than in git's.
  const empty = path.join(org.base, 'empty');
  run('git', ['init', '-q', empty], { cwd: org.base });
  await assert.rejects(() => initializeWorkspaceState(empty), /no branch checked out/);

  const first = await initializeWorkspaceState(work);
  assert.equal(first.governed, false, 'a delivery repository is not governed in its own right');
  assert.equal(first.existed, false);
  assert.equal(first.created, true);
  assert.ok(existsSync(path.join(work, 'singularity/workflow.yml')));
  assert.match(run('git', ['ls-remote', '--heads', 'origin', 'state'], { cwd: work }).stdout,
    /refs\/heads\/state/, 'and it reached the remote');

  // The branch is an orphan: no shared ancestry with the code branch, so a rebase of the work
  // cannot rewrite the record of it.
  assert.equal(
    run('git', ['merge-base', 'origin/main', 'origin/state'], { cwd: work, allowFailure: true }).status,
    1);

  // Re-running finds both and does nothing, which is what makes it safe to call on every create.
  const second = await initializeWorkspaceState(work);
  assert.equal(second.governed, true);
  assert.equal(second.existed, true);
});

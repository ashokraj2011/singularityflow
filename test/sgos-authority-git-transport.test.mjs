import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { gitCommonDir } from '../src/git.mjs';
import {
  gitTrustedAuthorityProjectionPath, planGitTrustedAuthorityPublish,
  planGitTrustedAuthoritySync, publishGitTrustedAuthority, syncGitTrustedAuthority
} from '../src/sgos/authority-git-transport.mjs';
import {
  createSgosCapabilityPackGitTrustedTrustScaffold,
  SGOS_CAPABILITY_PACK_TRUST_PATH
} from '../src/sgos/capability-pack-authority.mjs';
import {
  createCapabilityPack, createCapabilityPackRegistry, createPackReview,
  openFilesystemAuthorityStore, platformPrincipalId, platformSha256,
  signPlatformRecord
} from '../src/sgos/platform/index.mjs';

const ACTOR_EMAIL = 'git.state.actor@example.test';
const AT = '2026-09-02T12:00:00.000Z';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function gitBuffer(root, ...args) {
  const result = spawnSync('git', args, { cwd: root });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr?.toString()}`);
  return result.stdout;
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

async function cas(store) {
  const state = await store.read();
  return { expectedRevision: state.revision, expectedStateSha256: state.recordSha256 };
}

async function activatePack(fixture, {
  packId = 'finance-core', domain = 'finance', createdAt = AT
} = {}) {
  const pack = createCapabilityPack({
    packId,
    version: '1.0.0',
    domain,
    operations: [`${domain}.run`, `${domain}.verify`],
    permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256(`${packId}:provenance`),
    sbomSha256: platformSha256(`${packId}:sbom`),
    publisherKeyId: 'publisher-a',
    createdAt
  });
  const signed = signPlatformRecord(pack, {
    privateKeyPem: fixture.publisher.privateKeyPem,
    keyId: 'publisher-a'
  });
  await fixture.registry.propose(signed, await cas(fixture.store));
  const review = createPackReview({
    packSha256: pack.recordSha256,
    reviewerId: platformPrincipalId({ email: ACTOR_EMAIL }),
    decision: 'approved',
    reason: 'reviewed exact declarative Pack',
    reviewedAt: createdAt
  });
  await fixture.registry.recordReview(review, await cas(fixture.store));
  await fixture.registry.activate({
    domain,
    packSha256: pack.recordSha256,
    reviewSha256: review.recordSha256,
    confirmPackSha256: pack.recordSha256,
    ...await cas(fixture.store)
  });
  return pack;
}

function storeRoot(root, storeId) {
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'sgos', 'platform-authority', storeId
  );
}

async function openStore(root, storeId) {
  return openFilesystemAuthorityStore({ root: storeRoot(root, storeId), storeId });
}

async function fixture(t, { activate = true } = {}) {
  const parent = await temporaryDirectory(t, 'sflow-authority-git-state-');
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'source');
  await mkdir(root);
  git(parent, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Git State Actor');
  git(root, 'config', 'user.email', ACTOR_EMAIL);
  git(root, 'remote', 'add', 'origin', remote);
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  for (const authority of Object.values(workflow.approvalAuthorities)) {
    authority.members = [{ name: 'Git State Actor', email: ACTOR_EMAIL }];
  }
  workflow.ledger.enabled = true;
  workflow.ledger.remote = 'origin';
  workflow.ledger.branch = 'state';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const publisher = keyPair();
  const storeId = 'pack-authority';
  const manifest = createSgosCapabilityPackGitTrustedTrustScaffold({
    root,
    storeId,
    publishers: { 'publisher-a': publisher.publicKeyPem },
    stateRemote: 'origin'
  });
  await mkdir(path.dirname(path.join(root, SGOS_CAPABILITY_PACK_TRUST_PATH)), {
    recursive: true
  });
  await writeFile(path.join(root, SGOS_CAPABILITY_PACK_TRUST_PATH),
    `${JSON.stringify(manifest)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'approve Git-trusted Authority Store');
  git(root, 'branch', 'sflow/config');
  git(root, 'push', 'origin', 'main', 'sflow/config');
  const stateCommit = git(root, 'commit-tree', git(root, 'rev-parse', 'HEAD^{tree}'),
    '-m', 'initialize state authority');
  git(root, 'update-ref', 'refs/heads/state', stateCommit);
  git(root, 'push', 'origin', 'refs/heads/state:refs/heads/state');
  const store = await openStore(root, storeId);
  const registry = createCapabilityPackRegistry({
    authorityStore: store,
    trustedPublishers: { 'publisher-a': publisher.publicKeyPem },
    repositoryRoot: root
  });
  const result = { parent, remote, root, storeId, store, registry, publisher, manifest };
  if (activate) await activatePack(result);
  return result;
}

async function cloneFixture(t, source, name = 'clone') {
  const root = path.join(source.parent, name);
  git(source.parent, 'clone', '--branch', 'main', source.remote, root);
  git(root, 'config', 'user.name', 'Git State Actor');
  git(root, 'config', 'user.email', ACTOR_EMAIL);
  return root;
}

test('git-trusted publication previews exact state, CAS publishes, and no-ops without moving the application checkout', async (t) => {
  const fixtureValue = await fixture(t);
  const before = {
    head: git(fixtureValue.root, 'rev-parse', 'HEAD'),
    branch: git(fixtureValue.root, 'branch', '--show-current'),
    status: git(fixtureValue.root, 'status', '--porcelain=v1'),
    refs: git(fixtureValue.root, 'for-each-ref', '--format=%(refname) %(objectname)')
  };
  const preview = await planGitTrustedAuthorityPublish(fixtureValue.root);
  assert.equal(preview.mode, 'git-trusted');
  assert.equal(preview.remote, 'origin');
  assert.equal(preview.branch, 'state');
  assert.equal(preview.projectionPath,
    gitTrustedAuthorityProjectionPath(fixtureValue.storeId));
  assert.equal(preview.revision, 3);
  assert.equal(preview.changed, true);
  assert.match(preview.plan.confirmationSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    git(fixtureValue.root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    before.refs
  );

  const published = await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: preview.plan.confirmationSha256
  });
  assert.equal(published.changed, true);
  assert.notEqual(published.stateCommit, preview.stateCommit);
  assert.match(published.authorizationSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(git(fixtureValue.root, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(fixtureValue.root, 'branch', '--show-current'), before.branch);
  assert.equal(git(fixtureValue.root, 'status', '--porcelain=v1'), before.status);

  const noopPreview = await planGitTrustedAuthorityPublish(fixtureValue.root);
  assert.equal(noopPreview.changed, false);
  const noop = await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: noopPreview.plan.confirmationSha256
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.stateCommit, noopPreview.stateCommit);
  assert.equal(git(fixtureValue.root, 'rev-parse', 'HEAD'), before.head);
});

test('git-trusted synchronization installs in a fresh clone, no-ops, and fast-forwards exact Pack lineage', async (t) => {
  const fixtureValue = await fixture(t);
  const publishPlan = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: publishPlan.plan.confirmationSha256
  });
  const clone = await cloneFixture(t, fixtureValue);
  const cloneHead = git(clone, 'rev-parse', 'HEAD');
  const installPlan = await planGitTrustedAuthoritySync(clone);
  assert.equal(installPlan.localStoreExists, false);
  await assert.rejects(() => readFile(path.join(
    storeRoot(clone, fixtureValue.storeId), 'state.json'
  )), (error) => error.code === 'ENOENT');
  assert.equal(installPlan.importMode, 'install');
  assert.equal(installPlan.changed, true);
  const installed = await syncGitTrustedAuthority(clone, {
    confirmationSha256: installPlan.plan.confirmationSha256
  });
  assert.equal(installed.importMode, 'install');
  assert.equal(installed.changed, true);
  assert.match(installed.authorizationSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), cloneHead);

  const noopPlan = await planGitTrustedAuthoritySync(clone);
  assert.equal(noopPlan.importMode, 'noop');
  const noop = await syncGitTrustedAuthority(clone, {
    confirmationSha256: noopPlan.plan.confirmationSha256
  });
  assert.equal(noop.changed, false);

  await activatePack(fixtureValue, {
    packId: 'operations-core', domain: 'operations',
    createdAt: '2026-09-02T12:01:00.000Z'
  });
  const nextPublish = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: nextPublish.plan.confirmationSha256
  });
  const fastForwardPlan = await planGitTrustedAuthoritySync(clone);
  assert.equal(fastForwardPlan.importMode, 'fast-forward');
  const fastForwarded = await syncGitTrustedAuthority(clone, {
    confirmationSha256: fastForwardPlan.plan.confirmationSha256
  });
  assert.equal(fastForwarded.changed, true);
  assert.equal(fastForwarded.importMode, 'fast-forward');
  assert.equal(fastForwarded.importedEventCount, 3);
});

test('fresh-clone genesis sync retains an exact Git installation receipt', async (t) => {
  const fixtureValue = await fixture(t, { activate: false });
  const publishPlan = await planGitTrustedAuthorityPublish(fixtureValue.root);
  assert.equal(publishPlan.revision, 0);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: publishPlan.plan.confirmationSha256
  });
  const clone = await cloneFixture(t, fixtureValue, 'genesis-clone');
  const installPlan = await planGitTrustedAuthoritySync(clone);
  assert.equal(installPlan.importMode, 'install');
  const installed = await syncGitTrustedAuthority(clone, {
    confirmationSha256: installPlan.plan.confirmationSha256
  });
  assert.equal(installed.changed, true);
  assert.equal(installed.importMode, 'install');
  assert.match(installed.cutoverSha256, /^sha256:[a-f0-9]{64}$/u);
  const receipts = await readdir(path.join(
    storeRoot(clone, fixtureValue.storeId), 'transport', 'receipts'
  ));
  const projections = await readdir(path.join(
    storeRoot(clone, fixtureValue.storeId), 'transport', 'git-projections'
  ));
  assert.equal(receipts.length, 1);
  assert.equal(projections.length, 1);
});

test('genesis synchronization resumes when the process stopped after creating the local Store', async (t) => {
  const fixtureValue = await fixture(t, { activate: false });
  const publishPlan = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: publishPlan.plan.confirmationSha256
  });
  const clone = await cloneFixture(t, fixtureValue, 'interrupted-genesis-clone');
  const absentPlan = await planGitTrustedAuthoritySync(clone);
  assert.equal(absentPlan.localStoreExists, false);
  assert.equal(absentPlan.importMode, 'install');

  // Simulate a stop after openLocalStore created byte-identical genesis but before the atomic Git
  // projection cutover retained its projection and receipt.
  await openStore(clone, fixtureValue.storeId);
  const resumedPlan = await planGitTrustedAuthoritySync(clone);
  assert.equal(resumedPlan.localStoreExists, true);
  assert.equal(resumedPlan.importMode, 'install');
  assert.equal(resumedPlan.changed, true);
  const installed = await syncGitTrustedAuthority(clone, {
    confirmationSha256: resumedPlan.plan.confirmationSha256
  });
  assert.equal(installed.changed, true);
  assert.equal(installed.importMode, 'install');
  assert.match(installed.cutoverSha256, /^sha256:[a-f0-9]{64}$/u);

  const current = await planGitTrustedAuthoritySync(clone);
  assert.equal(current.importMode, 'noop');
  assert.equal(current.changed, false);
});

test('git-trusted authority bypasses ambient fetch and push URL rewrites', async (t) => {
  const fixtureValue = await fixture(t);
  const initial = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: initial.plan.confirmationSha256
  });
  const decoy = path.join(fixtureValue.parent, 'decoy.git');
  git(fixtureValue.parent, 'clone', '--bare', fixtureValue.remote, decoy);
  const decoyBefore = git(fixtureValue.parent,
    'ls-remote', decoy, 'refs/heads/state').split(/\s+/u)[0];
  const decoyWork = path.join(fixtureValue.parent, 'decoy-work');
  git(fixtureValue.parent, 'clone', '--branch', 'sflow/config', decoy, decoyWork);
  git(decoyWork, 'config', 'user.name', 'Decoy Authority');
  git(decoyWork, 'config', 'user.email', 'decoy@example.test');
  await writeFile(path.join(decoyWork, SGOS_CAPABILITY_PACK_TRUST_PATH),
    '{"format":"counterfeit-authority"}\n');
  git(decoyWork, 'add', SGOS_CAPABILITY_PACK_TRUST_PATH);
  git(decoyWork, 'commit', '-m', 'install counterfeit configuration authority');
  git(decoyWork, 'push', 'origin', 'sflow/config');
  git(fixtureValue.root, 'config', '--local',
    `url.${decoy}.insteadOf`, fixtureValue.remote);
  git(fixtureValue.root, 'config', '--local',
    `url.${decoy}.pushInsteadOf`, fixtureValue.remote);
  assert.equal(git(fixtureValue.root, 'remote', 'get-url', 'origin'), decoy);
  assert.equal(git(fixtureValue.root, 'remote', 'get-url', '--push', 'origin'), decoy);

  await activatePack(fixtureValue, {
    packId: 'rewrite-proof', domain: 'rewrite-proof',
    createdAt: '2026-09-02T12:04:00.000Z'
  });
  const plan = await planGitTrustedAuthorityPublish(fixtureValue.root);
  const published = await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: plan.plan.confirmationSha256
  });
  assert.equal(published.changed, true);
  const realAfter = git(fixtureValue.parent,
    'ls-remote', fixtureValue.remote, 'refs/heads/state').split(/\s+/u)[0];
  const decoyAfter = git(fixtureValue.parent,
    'ls-remote', decoy, 'refs/heads/state').split(/\s+/u)[0];
  assert.equal(realAfter, published.stateCommit);
  assert.notEqual(realAfter, decoyBefore);
  assert.equal(decoyAfter, decoyBefore);
});

test('git-trusted publication never rewinds a newer shared Authority Store', async (t) => {
  const fixtureValue = await fixture(t);
  const first = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: first.plan.confirmationSha256
  });
  const stale = await cloneFixture(t, fixtureValue, 'stale-publisher');
  const install = await planGitTrustedAuthoritySync(stale);
  await syncGitTrustedAuthority(stale, {
    confirmationSha256: install.plan.confirmationSha256
  });

  await activatePack(fixtureValue, {
    packId: 'newer-core', domain: 'newer', createdAt: '2026-09-02T12:05:00.000Z'
  });
  const newer = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: newer.plan.confirmationSha256
  });

  await assert.rejects(
    () => planGitTrustedAuthorityPublish(stale),
    (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED'
  );
});

test('v3 publisher expansion preserves the projection while unsafe publisher removal fails closed', async (t) => {
  const fixtureValue = await fixture(t);
  const first = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: first.plan.confirmationSha256
  });
  const manifestPath = path.join(fixtureValue.root, SGOS_CAPABILITY_PACK_TRUST_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const secondPublisher = keyPair();
  manifest.publishers['publisher-b'] = secondPublisher.publicKeyPem;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  git(fixtureValue.root, 'add', SGOS_CAPABILITY_PACK_TRUST_PATH);
  git(fixtureValue.root, 'commit', '-m', 'approve an additional Pack publisher');
  git(fixtureValue.root, 'push', '--force', 'origin', 'HEAD:refs/heads/sflow/config');

  const expanded = await planGitTrustedAuthorityPublish(fixtureValue.root);
  assert.equal(expanded.policySha256, first.policySha256);
  assert.equal(expanded.projectionSha256, first.projectionSha256);
  assert.equal(expanded.changed, false);
  const clone = await cloneFixture(t, fixtureValue, 'publisher-expanded');
  const sync = await planGitTrustedAuthoritySync(clone);
  assert.equal(sync.importMode, 'install');

  delete manifest.publishers['publisher-a'];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  git(fixtureValue.root, 'add', SGOS_CAPABILITY_PACK_TRUST_PATH);
  git(fixtureValue.root, 'commit', '-m', 'remove the active Pack publisher');
  git(fixtureValue.root, 'push', '--force', 'origin', 'HEAD:refs/heads/sflow/config');
  await assert.rejects(
    () => planGitTrustedAuthorityPublish(fixtureValue.root),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_UNTRUSTED'
  );
});

test('git-trusted plans fail closed for unreachable or absent state and stale confirmation', async (t) => {
  await t.test('unreachable remote', async (st) => {
    const fixtureValue = await fixture(st);
    const offline = `${fixtureValue.remote}.offline`;
    await rename(fixtureValue.remote, offline);
    await assert.rejects(
      () => planGitTrustedAuthorityPublish(fixtureValue.root),
      (error) => [
        'SGOS_AUTHORITY_GIT_REMOTE_UNAVAILABLE',
        'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED'
      ].includes(error.code)
    );
  });

  await t.test('missing state branch', async (st) => {
    const fixtureValue = await fixture(st);
    git(fixtureValue.root, 'push', 'origin', ':refs/heads/state');
    await assert.rejects(
      () => planGitTrustedAuthorityPublish(fixtureValue.root),
      (error) => error.code === 'SGOS_AUTHORITY_GIT_STATE_BRANCH_MISSING'
    );
  });

  await t.test('state moved after preview', async (st) => {
    const fixtureValue = await fixture(st);
    const preview = await planGitTrustedAuthorityPublish(fixtureValue.root);
    const moved = git(fixtureValue.root, 'commit-tree',
      git(fixtureValue.root, 'rev-parse', 'state^{tree}'),
      '-p', git(fixtureValue.root, 'rev-parse', 'state'),
      '-m', 'concurrent state update');
    git(fixtureValue.root, 'push', 'origin', `${moved}:refs/heads/state`);
    await assert.rejects(
      () => publishGitTrustedAuthority(fixtureValue.root, {
        confirmationSha256: preview.plan.confirmationSha256
      }),
      (error) => error.code === 'SGOS_AUTHORITY_GIT_PLAN_STALE'
    );
  });
});

test('git-trusted synchronization refuses another repository and divergent local authority', async (t) => {
  const fixtureValue = await fixture(t);
  const initial = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: initial.plan.confirmationSha256
  });

  const wrong = await cloneFixture(t, fixtureValue, 'wrong-repository');
  const other = path.join(fixtureValue.parent, 'other.git');
  git(fixtureValue.parent, 'init', '--bare', other);
  git(wrong, 'push', other,
    `${git(wrong, 'rev-parse', 'refs/remotes/origin/sflow/config')}:refs/heads/sflow/config`);
  git(wrong, 'remote', 'set-url', 'origin', other);
  await assert.rejects(
    () => planGitTrustedAuthoritySync(wrong),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_MISMATCH'
  );

  const clone = await cloneFixture(t, fixtureValue, 'divergent');
  const install = await planGitTrustedAuthoritySync(clone);
  await syncGitTrustedAuthority(clone, {
    confirmationSha256: install.plan.confirmationSha256
  });
  const cloneStore = await openStore(clone, fixtureValue.storeId);
  const cloneRegistry = createCapabilityPackRegistry({
    authorityStore: cloneStore,
    trustedPublishers: { 'publisher-a': fixtureValue.publisher.publicKeyPem },
    repositoryRoot: clone
  });
  const cloneFixtureValue = {
    ...fixtureValue, root: clone, store: cloneStore, registry: cloneRegistry
  };
  await activatePack(cloneFixtureValue, {
    packId: 'local-core', domain: 'local',
    createdAt: '2026-09-02T12:02:00.000Z'
  });
  await activatePack(fixtureValue, {
    packId: 'remote-core', domain: 'remote',
    createdAt: '2026-09-02T12:03:00.000Z'
  });
  const next = await planGitTrustedAuthorityPublish(fixtureValue.root);
  await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: next.plan.confirmationSha256
  });
  await assert.rejects(
    () => planGitTrustedAuthorityPublish(clone),
    (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_DIVERGED'
  );
  await assert.rejects(
    () => planGitTrustedAuthoritySync(clone),
    (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_DIVERGED'
  );
});

test('git-trusted publication refuses a local Store below the approved minimum', async (t) => {
  const fixtureValue = await fixture(t);
  const initial = await planGitTrustedAuthorityPublish(fixtureValue.root);
  const published = await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: initial.plan.confirmationSha256
  });
  const manifestPath = path.join(fixtureValue.root, SGOS_CAPABILITY_PACK_TRUST_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.transport.minimumAuthority = {
    revision: initial.revision,
    stateSha256: initial.stateSha256,
    projectionSha256: initial.projectionSha256
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  git(fixtureValue.root, 'add', SGOS_CAPABILITY_PACK_TRUST_PATH);
  git(fixtureValue.root, 'commit', '-m', 'advance approved Authority Store floor');
  git(fixtureValue.root, 'push', '--force', 'origin', 'HEAD:refs/heads/sflow/config');

  const stale = await cloneFixture(t, fixtureValue, 'below-minimum');
  await openStore(stale, fixtureValue.storeId);
  await assert.rejects(
    () => planGitTrustedAuthorityPublish(stale),
    (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_STALE'
  );
  assert.equal(git(fixtureValue.root, 'ls-remote', 'origin', 'refs/heads/state')
    .startsWith(published.stateCommit), true);
});

test('git-trusted publication stages exact bytes without repository clean filters', async (t) => {
  const fixtureValue = await fixture(t);
  await writeFile(path.join(fixtureValue.root, '.gitattributes'),
    'singularity/sgos/authority-stores/** filter=sflow-authority-corrupt\n');
  git(fixtureValue.root, 'config', 'filter.sflow-authority-corrupt.clean',
    'sed s/platform/corrupted/g');
  git(fixtureValue.root, 'config', 'filter.sflow-authority-corrupt.smudge', 'cat');
  git(fixtureValue.root, 'add', '.gitattributes');
  git(fixtureValue.root, 'commit', '-m', 'adversarial state attributes');
  git(fixtureValue.root, 'push', '--force', 'origin', 'HEAD:refs/heads/state');

  const preview = await planGitTrustedAuthorityPublish(fixtureValue.root);
  const published = await publishGitTrustedAuthority(fixtureValue.root, {
    confirmationSha256: preview.plan.confirmationSha256
  });
  assert.equal(published.changed, true);
  git(fixtureValue.root, 'fetch', 'origin', 'state');
  const blob = gitBuffer(fixtureValue.root, 'show',
    `origin/state:${preview.projectionPath}`);
  assert.equal(platformSha256(blob), preview.projectionBytesSha256);
  assert.match(blob.toString('utf8'), /platform-authority-git-projection/u);
});

test('git-trusted publication never follows a state-tree symlink ancestor', {
  skip: process.platform === 'win32'
    ? 'Windows cannot create the directory symlink used by this adversarial fixture without elevated developer privileges.'
    : false
}, async (t) => {
  const fixtureValue = await fixture(t);
  const outside = path.join(fixtureValue.parent, 'outside');
  const stateWorktree = path.join(fixtureValue.parent, 'state-worktree');
  await mkdir(outside);
  git(fixtureValue.root, 'worktree', 'add', '--detach', stateWorktree, 'state');
  await rm(path.join(stateWorktree, 'singularity'), { recursive: true, force: true });
  await symlink(outside, path.join(stateWorktree, 'singularity'));
  git(stateWorktree, 'add', '-A');
  git(stateWorktree, 'commit', '-m', 'adversarial state symlink');
  git(stateWorktree, 'push', '--force', 'origin', 'HEAD:refs/heads/state');

  const preview = await planGitTrustedAuthorityPublish(fixtureValue.root);
  let result = null;
  let refused = null;
  try {
    result = await publishGitTrustedAuthority(fixtureValue.root, {
      confirmationSha256: preview.plan.confirmationSha256
    });
  } catch (error) {
    refused = error;
  }
  assert.equal(await lstat(path.join(
    outside, 'sgos', 'authority-stores', fixtureValue.storeId, 'current.json'
  )).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
  // Index-only staging may safely replace the symlink with a tree, or Git may reject the D/F
  // conflict. Both outcomes are secure; following the symlink into `outside` is never permitted.
  if (result) {
    assert.equal(result.changed, true);
    git(fixtureValue.root, 'fetch', 'origin', 'state');
    assert.equal(platformSha256(gitBuffer(
      fixtureValue.root, 'show', `origin/state:${preview.projectionPath}`
    )), preview.projectionBytesSha256);
  } else {
    assert.ok(refused instanceof Error);
  }
});

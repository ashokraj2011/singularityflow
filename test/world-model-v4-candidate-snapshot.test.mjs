import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { publishToStateBranch } from '../src/ledger.mjs';
import { sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { planWorldModelV4 } from '../src/world-model/plan.mjs';
import { buildWorldModelV4 } from '../src/world-model/runtime.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { readPublishedWorldModelV4 } from '../src/world-model/store.mjs';
import {
  assertCurrentSourceMatchesCandidateSnapshot, captureCandidateSourceSnapshot,
  loadCandidateSourceSnapshot, validateSourceSnapshot, verifyExactSourceSnapshot,
  verifyHistoricalSourceSnapshot
} from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function repository(t, name = 'repo') {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-candidate-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, name);
  t.after(() => rm(parent, { recursive: true, force: true }));
  run('git', ['init', '--bare', remote]);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Candidate Snapshot Tests');
  git(root, 'config', 'user.email', 'candidate@example.invalid');
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return root;
}

function scope(capabilityId = 'candidate-fixture') {
  return createScopeManifest({
    capabilityId,
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySourceSha256: sha256({ fixture: 'candidate-source' })
  });
}

function options(candidateSnapshot = null) {
  return {
    views: ['dev.impact'],
    composer: 'deterministic',
    capabilityId: 'candidate-fixture',
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySnapshotSha256: sha256({ fixture: 'candidate-source' }),
    ...(candidateSnapshot ? { candidateSnapshot } : {})
  };
}

test('Candidate Snapshot accepted as exact source while dirty bytes remain opt-in', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'service.mjs'), [
    'export const value = 2;',
    'export function candidateOnly() { return value; }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'new.mjs'), 'export const added = true;\n');

  assert.throws(
    () => planWorldModelV4(root, options()),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
      && error.details.dirtyPaths.includes('src/service.mjs')
  );

  const captured = await captureCandidateSourceSnapshot(root, {
    subjectId: 'candidate-fixture', scopeManifest: scope()
  });
  assert.equal(captured.authority.kind, 'candidate-snapshot');
  assert.equal(captured.authority.baseRevision.commit, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(captured.files.map((entry) => entry.path), ['src/new.mjs', 'src/service.mjs']);
  assert.ok(captured.files.every((entry) => /^[a-f0-9]{40}$/.test(entry.objectId)));
  assert.equal(git(root, 'status', '--short').includes('src/service.mjs'), true);

  const loaded = await loadCandidateSourceSnapshot(root, captured.sourceManifestSha256, {
    scopeManifest: scope()
  });
  assert.equal(loaded.sourceManifestSha256, captured.sourceManifestSha256);
  const planned = planWorldModelV4(root, options(loaded));
  assert.equal(planned.sourceSnapshot.sourceManifestSha256, captured.sourceManifestSha256);
  assert.equal(planned.request.source.commit, captured.revision.commit);

  const built = await buildWorldModelV4(root, {
    ...options(loaded), generatedAt: '2026-09-01T12:00:00.000Z'
  });
  assert.equal(built.status, 'ready-to-publish');
  const claims = built.registration.factLedger.facts.map((fact) => JSON.stringify(fact.claim));
  assert.equal(claims.some((claim) => claim.includes('candidateOnly')), true);
  assert.equal(claims.some((claim) => claim.includes('src/new.mjs')), true);

  await assert.rejects(
    buildAndPublishWorldModelV4(root, {
      ...options(loaded),
      outputDir: 'singularity/world-model',
      ledgerConfig: {
        enabled: true, branch: 'state', remote: 'origin', behind: 'block',
        enforcement: 'shadow', signing: 'off', trustTier: 'T0', maxRetries: 3
      },
      generatedAt: '2026-09-01T12:01:00.000Z'
    }),
    (error) => error.code === 'WMB_CANDIDATE_SNAPSHOT_LOCAL_ONLY'
  );
  assert.equal(git(root, 'branch', '--list', 'state'), '');
});

test('Candidate Snapshot is repository, scope, ref, path, mode, and content bound', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = 9;\n');
  const captured = await captureCandidateSourceSnapshot(root, {
    subjectId: 'candidate-fixture', scopeManifest: scope()
  });

  const other = path.join(path.dirname(root), 'other');
  await mkdir(path.join(other, 'src'), { recursive: true });
  git(other, 'init', '-b', 'main');
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.invalid');
  await writeFile(path.join(other, 'src', 'service.mjs'), 'export const value = 9;\n');
  git(other, 'add', '.');
  git(other, 'commit', '-m', 'base');
  assert.throws(
    () => verifyExactSourceSnapshot(other, captured, { scopeManifest: scope() }),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_TAMPERED'
  );

  const wrongScope = createScopeManifest({
    capabilityId: 'other-scope', allowedPaths: ['src/service.mjs'], excludedPaths: []
  });
  assert.throws(
    () => verifyExactSourceSnapshot(root, captured, { scopeManifest: wrongScope }),
    (error) => error.code === 'WMB_SCOPE_MISMATCH'
  );

  const pathForgery = structuredClone(captured);
  pathForgery.files[0].path = '../escape.mjs';
  assert.throws(() => validateSourceSnapshot(pathForgery), /normalized repository-relative path/);

  const contentForgery = structuredClone(captured);
  contentForgery.files[0].contentSha256 = `sha256:${'f'.repeat(64)}`;
  delete contentForgery.sourceManifestSha256;
  assert.throws(
    () => validateSourceSnapshot(sealRecord(contentForgery, 'sourceManifestSha256')),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_TAMPERED'
  );

  const modeForgery = structuredClone(captured);
  modeForgery.files[0].mode = modeForgery.files[0].mode === '100644' ? '100755' : '100644';
  delete modeForgery.sourceManifestSha256;
  assert.throws(
    () => validateSourceSnapshot(sealRecord(modeForgery, 'sourceManifestSha256')),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_TAMPERED'
  );

  git(root, 'update-ref', `refs/singularity-flow/world-model-candidates/${captured.sourceManifestSha256.slice(7)}`, captured.authority.baseRevision.commit);
  assert.throws(
    () => verifyExactSourceSnapshot(root, captured, { scopeManifest: scope() }),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_TAMPERED'
  );
});

test('historical Candidate integrity is portable without inheriting capture-time authority', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = "portable";\n');
  const captured = await captureCandidateSourceSnapshot(root, {
    subjectId: 'candidate-fixture', scopeManifest: scope()
  });
  // Make the private Candidate commit reachable just long enough to copy its objects into a
  // different Git object store. The private Candidate ref itself is deliberately not copied.
  git(root, 'update-ref', 'refs/heads/candidate-transfer', captured.revision.commit);
  const portable = path.join(path.dirname(root), 'portable');
  run('git', ['clone', '--quiet', '--no-local', root, portable]);
  assert.equal(
    run('git', ['for-each-ref', '--format=%(refname)',
      'refs/singularity-flow/world-model-candidates'], { cwd: portable }).stdout.trim(),
    ''
  );

  assert.throws(
    () => verifyExactSourceSnapshot(portable, captured, { scopeManifest: scope() }),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_TAMPERED'
      && /different Git repository object store/.test(error.message)
  );
  const verified = verifyHistoricalSourceSnapshot(portable, captured, {
    scopeManifest: scope()
  });
  assert.equal(verified.sourceManifestSha256, captured.sourceManifestSha256);
  assert.equal(verified.revision.commit, captured.revision.commit);
});

test('Candidate Snapshot capture refuses symbolic-link source paths', async (t) => {
  const root = await repository(t);
  await symlink('/tmp', path.join(root, 'src', 'escaped'));
  git(root, 'add', 'src/escaped');
  await assert.rejects(
    () => captureCandidateSourceSnapshot(root, {
      subjectId: 'candidate-fixture', scopeManifest: scope()
    }),
    (error) => error.code === 'WMB_SOURCE_PATH_UNSAFE'
  );
});

test('Candidate Snapshot rejects a source mutation between its two exact capture passes', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = 2;\n');
  await assert.rejects(
    () => captureCandidateSourceSnapshot(root, {
      subjectId: 'candidate-fixture',
      scopeManifest: scope(),
      captureInterlock: () => writeFile(
        path.join(root, 'src', 'service.mjs'), 'export const value = 3;\n'
      )
    }),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_STALE'
  );
  assert.equal(
    run('git', ['for-each-ref', '--format=%(refname)',
      'refs/singularity-flow/world-model-candidates'], { cwd: root }).stdout.trim(),
    '',
    'a raced capture must not publish an immutable Candidate ref'
  );
});

test('an old Candidate cannot identify a changed current generation and comparison is read-only', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = "candidate-a";\n');
  const candidateA = await captureCandidateSourceSnapshot(root, {
    subjectId: 'candidate-fixture', scopeManifest: scope()
  });
  assert.equal(
    assertCurrentSourceMatchesCandidateSnapshot(root, candidateA, {
      scopeManifest: scope()
    }).sourceManifestSha256,
    candidateA.sourceManifestSha256
  );

  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = "implementation-b";\n');
  const statusBefore = git(root, 'status', '--porcelain=v1');
  const refsBefore = git(root, 'for-each-ref', '--format=%(refname) %(objectname)',
    'refs/singularity-flow/world-model-candidates');
  assert.throws(
    () => assertCurrentSourceMatchesCandidateSnapshot(root, candidateA, {
      scopeManifest: scope()
    }),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_STALE'
      && error.details?.expectedCandidateSha256 === candidateA.authority.candidateSha256
  );
  assert.equal(git(root, 'status', '--porcelain=v1'), statusBefore);
  assert.equal(
    git(root, 'for-each-ref', '--format=%(refname) %(objectname)',
      'refs/singularity-flow/world-model-candidates'),
    refsBefore,
    'comparison must not capture or advance a Candidate'
  );
});

test('a historical Candidate-backed model cannot authorize later implementation bytes', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = "candidate-a";\n');
  const candidateA = await captureCandidateSourceSnapshot(root, {
    subjectId: 'candidate-fixture', scopeManifest: scope()
  });
  const localBuild = await buildAndPublishWorldModelV4(root, {
    ...options(candidateA),
    outputDir: 'singularity/world-model',
    publish: false,
    generatedAt: '2026-09-12T00:00:00.000Z'
  });
  await publishToStateBranch(root, {
    enabled: true,
    branch: 'candidate-state',
    remote: 'missing-test-remote',
    behind: 'block',
    enforcement: 'shadow',
    signing: 'off',
    trustTier: 'T0',
    maxRetries: 3
  }, localBuild.staged.files, '[test] retain historical candidate model', {
    replaceRoots: localBuild.staged.replaceRoots
  });
  assert.equal(
    readPublishedWorldModelV4(root, {
      ref: 'candidate-state',
      expectedSourceSnapshot: candidateA
    }).freshness.status,
    'fresh'
  );

  const privateReference = `refs/singularity-flow/world-model-candidates/${candidateA.sourceManifestSha256.slice(7)}`;
  git(root, 'update-ref', '-d', privateReference);
  const retained = readPublishedWorldModelV4(root, {
    ref: 'candidate-state',
    sourceVerification: 'historical-integrity'
  });
  assert.equal(retained.sourceSnapshot.sourceManifestSha256, candidateA.sourceManifestSha256);
  assert.equal(retained.freshness.source.status, 'unavailable');
  assert.equal(retained.freshness.source.reason, 'historical-current-comparison-not-requested');
  assert.throws(
    () => readPublishedWorldModelV4(root, { ref: 'candidate-state' }),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_TAMPERED'
  );
  git(root, 'update-ref', privateReference, candidateA.revision.commit);

  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = "implementation-b";\n');
  const authorityBefore = git(root, 'rev-parse', 'candidate-state');
  const statusBefore = git(root, 'status', '--porcelain=v1');
  const refused = readPublishedWorldModelV4(root, {
    ref: 'candidate-state',
    expectedSourceSnapshot: candidateA
  });
  assert.equal(refused.freshness.fresh, false);
  assert.equal(refused.freshness.source.status, 'unavailable');
  assert.equal(refused.freshness.source.reason, 'WMB_SOURCE_SNAPSHOT_STALE');
  assert.match(refused.freshness.source.detail, /does not match the current generation source/);
  assert.equal(git(root, 'rev-parse', 'candidate-state'), authorityBefore);
  assert.equal(git(root, 'status', '--porcelain=v1'), statusBefore);
});

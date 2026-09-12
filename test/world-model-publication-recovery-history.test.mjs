import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  initializeLedger, publishToStateBranch, stateBranchPublicationTargetIdentity
} from '../src/ledger.mjs';
import { run } from '../src/util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { createWmpHandoff } from '../src/world-model/history/contracts.mjs';
import { worldModelHistoryHandoffPath } from '../src/world-model/history/paths.mjs';
import {
  inspectWorldModelPublicationRecovery, listWorldModelPublicationRecoveries,
  prepareWorldModelPublicationRecovery, resumeWorldModelPublication
} from '../src/world-model/recovery.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';

const LEDGER = Object.freeze({
  enabled: true,
  branch: 'state',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
});

function git(root, ...args) {
  return run('git', args, { cwd: root });
}

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-recovery-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  t.after(() => rm(parent, { recursive: true, force: true }));
  run('git', ['init', '--bare', remote]);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP Recovery Tests');
  git(root, 'config', 'user.email', 'wmp-recovery@example.invalid');
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const ready = true;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'application source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  return root;
}

async function stagedProjection(root) {
  const result = await buildAndPublishWorldModelV4(root, {
    outputDir: 'singularity/world-model',
    ledgerConfig: LEDGER,
    views: ['dev.impact'],
    composer: 'deterministic',
    capabilityId: 'recovery-fixture',
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySnapshotSha256: sha256({ fixture: 'wmp-recovery-history' }),
    generatedAt: '2026-09-12T00:00:00.000Z',
    publish: false,
    preserveIndependentViews: false
  });
  assert.equal(result.status, 'completed');
  return result.staged;
}

async function stagedOptionalRefusalProjection(root) {
  const result = await buildAndPublishWorldModelV4(root, {
    outputDir: 'singularity/world-model',
    ledgerConfig: LEDGER,
    views: [{ viewId: 'dev.impact', required: false }],
    composer: 'model',
    provider: null,
    capabilityId: 'large-recovery-fixture',
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySnapshotSha256: sha256({ fixture: 'wmp-large-v1-recovery' }),
    generatedAt: '2026-09-12T00:00:00.000Z',
    publish: false,
    preserveIndependentViews: false,
    allowUnavailableOptionalViews: true
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.refusals.length, 1);
  return result.staged;
}

function legacyRecoveryId(record) {
  return `wmb4-${sha256({
    createdAt: record.createdAt,
    requestSha256: record.requestSha256,
    planSha256: record.planSha256,
    manifestSha256: record.manifestSha256,
    projectionSha256: record.projectionSha256,
    ledger: record.ledger,
    publicationOptions: record.publicationOptions
  }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function historyEnvelope(contents, target = null) {
  const bytes = Buffer.from(contents, 'utf8');
  const digest = sha256(bytes);
  const hex = digest.slice('sha256:'.length);
  const relative = target
    ?? `singularity/world-model-history/objects/sha256/${hex.slice(0, 2)}/${hex}`;
  return Object.freeze({
    historyDir: 'singularity/world-model-history',
    historyAdditions: Object.freeze({ [relative]: contents }),
    historyExpectations: Object.freeze({
      [relative]: Object.freeze({
        condition: 'absent-or-identical', sha256: digest,
        bytes: bytes.length, gitMode: '100644'
      })
    }),
    exactBlobSha256: Object.freeze({ [relative]: digest })
  });
}

function withHistory(staged, history) {
  return { ...staged, ...history };
}

async function commitStatePathWithMode(root, baseCommit, target, mode) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-recovery-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
    run('git', ['read-tree', baseCommit], { cwd: root, env });
    const object = git(root, 'rev-parse', `${baseCommit}:${target}`).stdout.trim();
    run('git', ['update-index', '--add', '--cacheinfo', `${mode},${object},${target}`], {
      cwd: root, env
    });
    const tree = run('git', ['write-tree'], { cwd: root, env }).stdout.trim();
    const commit = run('git', [
      'commit-tree', tree, '-p', baseCommit, '-m', '[test] malformed projection mode'
    ], { cwd: root, env }).stdout.trim();
    run('git', ['update-ref', 'refs/heads/state', commit, baseCommit], { cwd: root });
    run('git', ['push', 'origin', `${commit}:refs/heads/state`], { cwd: root });
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const RECOVERY_OPTIONS = Object.freeze({
  createdAt: '2026-09-12T00:00:00.000Z',
  publicationOptions: Object.freeze({ expectedRemoteSha: null, refreshRemote: false })
});

test('publication recovery identity binds every exact immutable history byte', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const first = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, historyEnvelope('{"value":"first"}\n')), RECOVERY_OPTIONS
  );
  const second = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, historyEnvelope('{"value":"second"}\n')), RECOVERY_OPTIONS
  );

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.record.historySha256, second.record.historySha256);
  assert.match(first.record.historySha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 2);

  const projectionOnly = await prepareWorldModelPublicationRecovery(
    root, LEDGER, staged, RECOVERY_OPTIONS
  );
  const legacy = structuredClone(projectionOnly.record);
  legacy.schemaVersion = 1;
  delete legacy.historySha256;
  await writeFile(projectionOnly.path, canonicalJson(sealRecord(legacy, 'recoverySha256')));
  const migrated = await inspectWorldModelPublicationRecovery(root, projectionOnly.id);
  assert.equal(migrated.historySha256, null, 'a projection-only v1 marker remains recoverable');

  const raw = JSON.parse(await readFile(first.path, 'utf8'));
  const target = Object.keys(raw.publication.historyAdditions)[0];
  const replacement = '{"value":"tampered"}\n';
  const replacementBytes = Buffer.from(replacement, 'utf8');
  const replacementSha256 = sha256(replacementBytes);
  raw.publication.historyAdditions[target] = replacement;
  raw.publication.historyExpectations[target] = {
    condition: 'absent-or-identical', sha256: replacementSha256,
    bytes: replacementBytes.length, gitMode: '100644'
  };
  raw.publication.exactBlobSha256[target] = replacementSha256;
  const resealed = sealRecord(raw, 'recoverySha256');
  await writeFile(first.path, canonicalJson(resealed));
  await assert.rejects(
    inspectWorldModelPublicationRecovery(root, first.id),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_INVALID'
      && /exact projection/.test(error.message)
  );
});

test('recovery preparation refuses drift from the reviewed Git endpoint', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const reviewedEndpointSha256 = stateBranchPublicationTargetIdentity(
    root, LEDGER
  ).effectiveUrlSha256;
  const replacement = path.join(path.dirname(root), 'replacement.git');
  run('git', ['init', '--bare', replacement]);
  git(root, 'remote', 'set-url', '--push', 'origin', replacement);

  await assert.rejects(
    prepareWorldModelPublicationRecovery(root, LEDGER, staged, {
      ...RECOVERY_OPTIONS,
      publicationOptions: {
        ...RECOVERY_OPTIONS.publicationOptions,
        remoteEndpointSha256: reviewedEndpointSha256
      }
    }),
    (error) => error.code === 'WMB_GATEWAY_PLAN_DRIFTED'
      && error.details?.expectedEndpointSha256 === reviewedEndpointSha256
      && error.details?.currentEndpointSha256 !== reviewedEndpointSha256
  );
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 0);
});

test('a migrated v1 recovery keeps the previously admitted 128 MiB sidecar boundary', async (t) => {
  const root = await repository(t);
  let publication = await stagedOptionalRefusalProjection(root);
  const seed = await prepareWorldModelPublicationRecovery(
    root, LEDGER, publication, RECOVERY_OPTIONS
  );
  publication = structuredClone(publication);
  const refusalPath = 'singularity/world-model/refusals/dev.impact.json';
  const refusal = JSON.parse(publication.files[refusalPath]);
  delete refusal.refusalSha256;
  refusal.failures[0].reason = 'x'.repeat(96 * 1024 * 1024);
  publication.files[refusalPath] = canonicalJson(sealRecord(refusal, 'refusalSha256'));

  const stagedBytes = Buffer.byteLength(canonicalJson(publication), 'utf8');
  assert.ok(stagedBytes > 96 * 1024 * 1024, stagedBytes);
  await assert.rejects(
    prepareWorldModelPublicationRecovery(root, LEDGER, publication, RECOVERY_OPTIONS),
    (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
      && error.details?.maximumBytes === 96 * 1024 * 1024
  );
  const projectionSha256 = sha256({
    outputDir: publication.outputDir,
    manifestPath: publication.manifestPath,
    replaceRoots: publication.replaceRoots,
    files: publication.files
  });
  const legacyCore = {
    ...seed.record,
    schemaVersion: 1,
    projectionSha256,
    publication
  };
  delete legacyCore.historySha256;
  delete legacyCore.recoverySha256;
  legacyCore.id = legacyRecoveryId(legacyCore);
  let legacy = sealRecord(legacyCore, 'recoverySha256');
  const legacyBytes = Buffer.from(canonicalJson(legacy), 'utf8');
  assert.ok(legacyBytes.length > 96 * 1024 * 1024, legacyBytes.length);
  assert.ok(legacyBytes.length <= 128 * 1024 * 1024, legacyBytes.length);
  const recoveryPath = path.join(path.dirname(seed.path), `${legacy.id}.json`);
  await writeFile(recoveryPath, legacyBytes);

  const recoveryId = legacy.id;
  publication = null;
  legacy = null;
  let migrated = await inspectWorldModelPublicationRecovery(root, recoveryId);
  assert.equal(migrated.status, 'pending');
  assert.equal(migrated.projectionSha256, projectionSha256);
  assert.equal(migrated.historySha256, null);
  migrated = null;

  let publisherCalls = 0;
  const resumed = await resumeWorldModelPublication(root, recoveryId, {
    confirm: recoveryId,
    publicationOptions: {
      publisher: async () => {
        publisherCalls += 1;
        return Object.freeze({
          branch: 'state', commit: 'f'.repeat(40), changed: true,
          published: Object.freeze([]), removed: Object.freeze([])
        });
      }
    }
  });
  assert.equal(publisherCalls, 1);
  assert.equal(resumed.reconciled, false);
  await assert.rejects(
    inspectWorldModelPublicationRecovery(root, recoveryId),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_UNKNOWN'
  );
});

test('recovery accepts a concurrent byte-identical projection and history winner', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const history = historyEnvelope('{"kind":"retained-object","value":1}\n');
  const publication = withHistory(staged, history);
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, publication, RECOVERY_OPTIONS
  );
  const siblingBytes = '{"kind":"independent-retained-object"}\n';
  const siblingSha256 = sha256(Buffer.from(siblingBytes, 'utf8'));
  const siblingHex = siblingSha256.slice('sha256:'.length);
  const siblingPath = `singularity/world-model-history/objects/sha256/${siblingHex.slice(0, 2)}/${siblingHex}`;

  const winner = await publishToStateBranch(root, LEDGER, {
    ...staged.files, ...history.historyAdditions, [siblingPath]: siblingBytes
  }, '[concurrent] byte-identical persisted world model', {
    replaceRoots: staged.replaceRoots,
    pathPreconditions: {
      ...history.historyExpectations,
      [siblingPath]: {
        condition: 'absent-or-identical', sha256: siblingSha256,
        bytes: Buffer.byteLength(siblingBytes, 'utf8'), gitMode: '100644'
      }
    },
    exactBlobSha256: { ...history.exactBlobSha256, [siblingPath]: siblingSha256 }
  });
  let replayCalls = 0;
  const resumed = await resumeWorldModelPublication(root, recovery.id, {
    confirm: recovery.id,
    publicationOptions: {
      publisher: async () => { replayCalls += 1; }
    }
  });

  assert.equal(resumed.reconciled, true);
  assert.equal(resumed.publication.commit, winner.commit);
  assert.equal(replayCalls, 0);
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 0);
});

test('recovery resumes a first publication after only the exact pristine ledger root landed', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, staged, RECOVERY_OPTIONS
  );

  // Simulate interruption between publishToStateBranch's first root push and its WMP commit push.
  const initialized = await initializeLedger(root, LEDGER);
  assert.equal(initialized.created, true);
  const resumed = await resumeWorldModelPublication(root, recovery.id, {
    confirm: recovery.id
  });

  assert.equal(resumed.reconciled, false);
  assert.equal(resumed.publication.changed, true);
  assert.notEqual(resumed.publication.commit, initialized.commit);
  assert.equal(
    git(root, 'rev-parse', 'refs/remotes/origin/state').stdout.trim(),
    resumed.publication.commit
  );
  assert.equal(
    git(root, 'show', `${resumed.publication.commit}:${staged.manifestPath}`).stdout,
    staged.files[staged.manifestPath]
  );
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 0);
});

test('recovery refuses matching projection bytes stored as a non-regular Git entry', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, staged, RECOVERY_OPTIONS
  );
  const winner = await publishToStateBranch(
    root, LEDGER, staged.files, '[concurrent] exact projection bytes', {
      replaceRoots: staged.replaceRoots
    }
  );
  await commitStatePathWithMode(
    root, winner.commit, 'singularity/world-model/manifest.json', '120000'
  );

  let replayCalls = 0;
  await assert.rejects(
    resumeWorldModelPublication(root, recovery.id, {
      confirm: recovery.id,
      publicationOptions: { publisher: async () => { replayCalls += 1; } }
    }),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_REQUIRED'
      && error.details.causeCode === 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED'
  );
  assert.equal(replayCalls, 0);
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 1);
});

test('recovery rejects an otherwise identical winner that changes unrelated state', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const history = historyEnvelope('{"kind":"retained-object","value":"scoped"}\n');
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, history), RECOVERY_OPTIONS
  );
  await publishToStateBranch(root, LEDGER, {
    ...staged.files,
    ...history.historyAdditions,
    'unrelated/configuration.json': '{"changed":true}\n'
  }, '[concurrent] matching world model with unrelated state', {
    replaceRoots: staged.replaceRoots,
    pathPreconditions: history.historyExpectations,
    exactBlobSha256: history.exactBlobSha256
  });

  let replayCalls = 0;
  await assert.rejects(
    resumeWorldModelPublication(root, recovery.id, {
      confirm: recovery.id,
      publicationOptions: { publisher: async () => { replayCalls += 1; } }
    }),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_REQUIRED'
      && error.details.causeCode === 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED'
      && /outside the exact WMB v4 publication scope/.test(error.message)
  );
  assert.equal(replayCalls, 0);
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 1);
});

test('recovery rejects an added history object whose bytes do not match its content path', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const history = historyEnvelope('{"kind":"retained-object","value":"owned"}\n');
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, history), RECOVERY_OPTIONS
  );
  const claimedBytes = Buffer.from('{"kind":"claimed-object"}\n', 'utf8');
  const claimedHex = sha256(claimedBytes).slice('sha256:'.length);
  const siblingPath = `singularity/world-model-history/objects/sha256/${claimedHex.slice(0, 2)}/${claimedHex}`;
  await publishToStateBranch(root, LEDGER, {
    ...staged.files,
    ...history.historyAdditions,
    [siblingPath]: '{"kind":"different-object"}\n'
  }, '[concurrent] matching world model with false history identity', {
    replaceRoots: staged.replaceRoots,
    pathPreconditions: history.historyExpectations,
    exactBlobSha256: history.exactBlobSha256
  });

  await assert.rejects(
    resumeWorldModelPublication(root, recovery.id, { confirm: recovery.id }),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_REQUIRED'
      && error.details.causeCode === 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED'
  );
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 1);
});

test('recovery rejects an added keyed history path without a canonical matching binding', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const history = historyEnvelope('{"kind":"retained-object","value":"binding-owner"}\n');
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, history), RECOVERY_OPTIONS
  );
  const falseBindingPath = `singularity/world-model-history/models/${'a'.repeat(64)}.json`;
  await publishToStateBranch(root, LEDGER, {
    ...staged.files,
    ...history.historyAdditions,
    [falseBindingPath]: '{}\n'
  }, '[concurrent] matching world model with false model binding', {
    replaceRoots: staged.replaceRoots,
    pathPreconditions: history.historyExpectations,
    exactBlobSha256: history.exactBlobSha256
  });

  await assert.rejects(
    resumeWorldModelPublication(root, recovery.id, { confirm: recovery.id }),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_REQUIRED'
      && error.details.causeCode === 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED'
  );
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 1);
});

test('recovery rejects a canonical added keyed record without its verified CAS closure', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const history = historyEnvelope('{"kind":"retained-object","value":"owned-closure"}\n');
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, history), RECOVERY_OPTIONS
  );
  const proofBytes = Buffer.from(canonicalJson({ schemaVersion: 1 }), 'utf8');
  const publicationRef = {
    role: 'publication-receipt', family: 'specification-index',
    mediaType: 'application/json', sha256: sha256(proofBytes), bytes: proofBytes.length
  };
  const handoff = createWmpHandoff({
    repositoryDomainSha256: sha256({ repository: 'concurrent-keyed-fixture' }),
    authorityCut: {
      stateRef: 'refs/heads/state', commit: 'a'.repeat(40), publicationRef
    },
    sourceBindingSha256: sha256({ source: 'concurrent-keyed-fixture' }),
    modelBindings: [], viewBindings: [], inputObjects: [], sourceObjects: [], missing: [],
    readerRequirements: [],
    confidentiality: { classification: 'repository-authorized', exportAllowed: false },
    adoption: {
      required: false, targetRepositoryDomainSha256: null, authorizationRef: null
    }
  });
  const keyedPath = worldModelHistoryHandoffPath(handoff.handoffSha256);
  await publishToStateBranch(root, LEDGER, {
    ...staged.files,
    ...history.historyAdditions,
    [keyedPath]: canonicalJson(handoff)
  }, '[concurrent] matching world model with unclosed canonical handoff', {
    replaceRoots: staged.replaceRoots,
    pathPreconditions: history.historyExpectations,
    exactBlobSha256: history.exactBlobSha256
  });

  await assert.rejects(
    resumeWorldModelPublication(root, recovery.id, { confirm: recovery.id }),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_REQUIRED'
      && error.details.causeCode === 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED'
      && /outside the exact WMB v4 publication scope/.test(error.message)
  );
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 1);
});

test('recovery refuses a matching current projection when any immutable history path is absent', async (t) => {
  const root = await repository(t);
  const staged = await stagedProjection(root);
  const history = historyEnvelope('{"kind":"retained-object","value":2}\n');
  const recovery = await prepareWorldModelPublicationRecovery(
    root, LEDGER, withHistory(staged, history), RECOVERY_OPTIONS
  );
  await publishToStateBranch(
    root, LEDGER, staged.files, '[concurrent] projection without retained history', {
      replaceRoots: staged.replaceRoots
    }
  );

  let replayCalls = 0;
  await assert.rejects(
    resumeWorldModelPublication(root, recovery.id, {
      confirm: recovery.id,
      publicationOptions: { publisher: async () => { replayCalls += 1; } }
    }),
    (error) => error.code === 'WMB_PUBLICATION_RECOVERY_REQUIRED'
      && error.details.causeCode === 'WMB_PUBLICATION_RECOVERY_REMOTE_ADVANCED'
  );
  assert.equal(replayCalls, 0);
  assert.equal((await listWorldModelPublicationRecoveries(root)).total, 1);
});

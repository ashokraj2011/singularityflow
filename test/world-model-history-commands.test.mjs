import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';
import { run } from '../src/util.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import { canonicalJson, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { createWmpModelBinding } from '../src/world-model/history/contracts.mjs';
import {
  WMP_IDENTITY_VERSION, createWmpSourceBinding
} from '../src/world-model/history/identity.mjs';
import {
  worldModelHistoryModelPath, worldModelHistoryObjectPath, worldModelHistoryViewPath
} from '../src/world-model/history/paths.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { createExactSourceSnapshotAtRevision } from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function quiet(operation) {
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try { return await operation(); }
  finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
}

function objectRef(record, role, family = 'world-model-source-snapshot') {
  const text = canonicalJson(record);
  return Object.freeze({
    role,
    family,
    mediaType: 'application/json',
    sha256: sha256(Buffer.from(text, 'utf8')),
    bytes: Buffer.byteLength(text, 'utf8')
  });
}

function sortedRefs(values) {
  return [...values].sort((left, right) => (
    `${left.role}\0${left.family ?? ''}\0${left.sha256}`
      .localeCompare(`${right.role}\0${right.family ?? ''}\0${right.sha256}`)
  ));
}

async function persistedRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-history-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP History Command');
  git(root, 'config', 'user.email', 'wmp-history-command@example.invalid');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# application\n');
  await writeFile(path.join(root, 'singularity', 'worldmodel.json'), '{}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'application source');

  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const scopeManifest = createScopeManifest({
    capabilityId: 'history-command-fixture', allowedPaths: ['**']
  });
  const registration = runDeterministicRegistration({
    root,
    sourceSnapshot: createExactSourceSnapshotAtRevision(root, sourceCommit, {
      subjectId: 'history-command-fixture', scopeManifest
    }),
    scopeManifest,
    requestedViews: []
  });
  const snapshot = registration.sourceSnapshot;
  const snapshotText = canonicalJson(snapshot);
  const repositoryDomainRecord = createExactSourceSnapshotAtRevision(root, sourceCommit, {
    subjectId: 'history-command-repository-domain', scopeManifest
  });
  const extractionPolicyRecord = createExactSourceSnapshotAtRevision(root, sourceCommit, {
    subjectId: 'history-command-extraction-policy', scopeManifest
  });
  const extractorRegistryRecord = createExactSourceSnapshotAtRevision(root, sourceCommit, {
    subjectId: 'history-command-extractor-registry', scopeManifest
  });
  const completenessRecordValue = createExactSourceSnapshotAtRevision(root, sourceCommit, {
    subjectId: 'history-command-completeness', scopeManifest
  });
  const repositoryDomainRef = objectRef(repositoryDomainRecord, 'repository-domain');
  const sourceSnapshotRef = objectRef(snapshot, 'source-snapshot');
  const scopeManifestRef = objectRef(
    scopeManifest, 'scope-manifest', 'world-model-scope-manifest'
  );
  const extractionPolicyRef = objectRef(extractionPolicyRecord, 'extraction-policy');
  const extractorRegistryRef = objectRef(extractorRegistryRecord, 'extractor-registry');
  const completenessRecord = objectRef(completenessRecordValue, 'completeness-record');
  const evidenceCatalogRef = objectRef(
    registration.evidenceCatalog, 'evidence-catalog', 'world-model-evidence-catalog'
  );
  const derivationCatalogRef = objectRef(
    registration.derivationCatalog, 'derivation-catalog', 'world-model-derivation-catalog'
  );
  const factLedgerRef = objectRef(
    registration.factLedger, 'fact-ledger', 'world-model-fact-ledger'
  );
  const extractionProfile = {
    kind: 'wmp/extraction-profile',
    version: 1,
    extractors: [],
    parseSchemaSha256: sha256({ fixture: 'parse-schema' }),
    normalizationContractSha256: sha256({ fixture: 'normalization' }),
    configurationRefs: []
  };
  const factRequirements = {
    kind: 'wmp/fact-requirements',
    version: 1,
    requiredFactTypes: [],
    optionalFactTypes: [],
    coverageRuleRefs: [],
    requiredUnavailableSubjects: []
  };
  const extractionInputs = {
    kind: 'wmp/extraction-inputs',
    version: 1,
    captures: []
  };
  const sourceBinding = createWmpSourceBinding({
    repositoryDomainRef,
    repositoryDomainSha256: repositoryDomainRef.sha256,
    sourceKind: 'committed',
    sourceSnapshotRef,
    sourceManifestSha256: snapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    gitObjectFormat: sourceCommit.length === 64 ? 'sha256' : 'sha1',
    requestedRevision: sourceCommit,
    effectiveRevision: sourceCommit,
    sourceAuthorityRef: null
  });
  const inputs = {
    identityVersion: WMP_IDENTITY_VERSION,
    repositoryDomainSha256: repositoryDomainRef.sha256,
    sourceBindingSha256: sha256(sourceBinding),
    sourceManifestSha256: snapshot.sourceManifestSha256,
    scopeManifestSha256: sourceBinding.scopeManifestSha256,
    extractionPolicySha256: sha256({ fixture: 'extraction-policy' }),
    extractorRegistrySha256: registration.extractorRegistrySha256,
    extractionProfileSha256: sha256(extractionProfile),
    factRequirementsSha256: sha256(factRequirements),
    extractionInputsSha256: sha256(extractionInputs)
  };
  const binding = createWmpModelBinding({
    inputs,
    inputDescriptors: {
      sourceBinding,
      extractionProfile,
      factRequirements,
      extractionInputs
    },
    inputObjects: sortedRefs([
      extractionPolicyRef, extractorRegistryRef, repositoryDomainRef,
      scopeManifestRef, sourceSnapshotRef
    ]),
    payloadObjects: sortedRefs([
      completenessRecord, derivationCatalogRef, evidenceCatalogRef, factLedgerRef
    ]),
    completeness: {
      totalPaths: snapshot.files.length,
      processedPaths: snapshot.files.length,
      unsupportedPaths: 0,
      failedPaths: 0,
      excludedPaths: 0,
      requiredSubjects: [],
      extractorCoverage: [],
      completenessRecord
    }
  });
  // Install an intentionally pre-contract fixture directly in Git. The read path must enumerate
  // it, but must not call this a verified binding: one Source Snapshot was falsely relabelled as
  // repository-domain and completeness authority before those owners existed.
  const bindingText = canonicalJson(binding);
  const bindingByteSha256 = sha256(Buffer.from(bindingText, 'utf8'));
  const historyFiles = {
    [worldModelHistoryModelPath(binding.modelKey)]: bindingText,
    [worldModelHistoryObjectPath(bindingByteSha256)]: bindingText,
    [worldModelHistoryObjectPath(sourceSnapshotRef.sha256)]: snapshotText,
    [worldModelHistoryObjectPath(repositoryDomainRef.sha256)]: canonicalJson(repositoryDomainRecord),
    [worldModelHistoryObjectPath(scopeManifestRef.sha256)]: canonicalJson(scopeManifest),
    [worldModelHistoryObjectPath(extractionPolicyRef.sha256)]: canonicalJson(extractionPolicyRecord),
    [worldModelHistoryObjectPath(extractorRegistryRef.sha256)]: canonicalJson(extractorRegistryRecord),
    [worldModelHistoryObjectPath(completenessRecord.sha256)]: canonicalJson(completenessRecordValue),
    [worldModelHistoryObjectPath(evidenceCatalogRef.sha256)]: canonicalJson(registration.evidenceCatalog),
    [worldModelHistoryObjectPath(derivationCatalogRef.sha256)]: canonicalJson(registration.derivationCatalog),
    [worldModelHistoryObjectPath(factLedgerRef.sha256)]: canonicalJson(registration.factLedger)
  };
  for (const [relative, contents] of Object.entries(historyFiles)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  // Deliberately make the same digest exist as a view-key filename. Omitting --kind must refuse
  // this ambiguity; selecting model still verifies the complete retained model closure.
  const collidingViewPath = worldModelHistoryViewPath(binding.modelKey);
  await mkdir(path.dirname(path.join(root, collidingViewPath)), { recursive: true });
  await writeFile(path.join(root, collidingViewPath), '{}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'persist model history fixture');
  git(root, 'branch', '-f', 'state', 'HEAD');
  return { root, authorityCommit: git(root, 'rev-parse', 'HEAD'), binding };
}

test('World-Model history list and show are registered read-only model-free operations', () => {
  const catalog = new Map(operationCatalog().map((entry) => [entry.id, entry]));
  for (const action of ['list', 'show']) {
    const resolved = resolveOperation({
      requestedCommand: 'wm',
      positionals: ['wm', 'history', action]
    });
    assert.equal(resolved.id, `wm.history.${action}`);
    assert.equal(resolved.classification, 'read');
    assert.equal(resolved.modelPolicy, 'never');
    assert.ok(catalog.has(resolved.id));
  }
  assert.throws(
    () => resolveOperation({
      requestedCommand: 'wm', positionals: ['wm', 'history', 'latest']
    }),
    (error) => error?.code === 'UNKNOWN_SUBCOMMAND'
  );
});

test('history list stays on its exact authority cut and show refuses an unowned semantic closure', async (t) => {
  const { root, authorityCommit, binding } = await persistedRepository(t);
  const headBefore = git(root, 'rev-parse', 'HEAD');
  const statusBefore = git(root, 'status', '--porcelain=v1', '--untracked-files=all');

  const listed = await quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
    'authority-commit': authorityCommit,
    json: true
  }));
  assert.equal(listed.authorityCommit, authorityCommit);
  assert.deepEqual(listed.entries.map((entry) => entry.kind), ['model', 'view']);
  assert.ok(listed.entries.every((entry) => entry.key === binding.modelKey));

  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'show', binding.modelKey], {
      'authority-commit': authorityCommit,
      json: true
    })),
    (error) => error?.code === 'WMP_SELECTION_AMBIGUOUS'
      && error?.details?.candidates?.length === 2
  );
  await assert.rejects(
    quiet(() => worldModelCommand(
      root, ['wm', 'history', 'show', binding.modelKey], {
        'authority-commit': authorityCommit,
        kind: 'model',
        json: true
      }
    )),
    (error) => error?.code === 'WMP_OBJECT_OWNER_UNAVAILABLE'
      && ['completeness-record', 'repository-domain'].includes(error?.details?.role)
  );

  assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(root, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
});

test('history listing pages a stable authority selection with a bounded continuation cursor', async (t) => {
  const { root, authorityCommit } = await persistedRepository(t);
  const first = await quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
    'authority-commit': authorityCommit,
    limit: 1,
    json: true
  }));
  assert.equal(first.count, 1);
  assert.equal(first.total, 2);
  assert.equal(first.limit, 1);
  assert.equal(first.hasMore, true);
  assert.match(first.continuation, /^wmp1\.[A-Za-z0-9_-]+$/);

  const second = await quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
    'authority-commit': authorityCommit,
    cursor: first.continuation,
    json: true
  }));
  assert.equal(second.count, 1);
  assert.equal(second.total, 2);
  assert.equal(second.hasMore, false);
  assert.equal(second.continuation, null);
  assert.notEqual(second.entries[0].kind, first.entries[0].kind);

  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
      'authority-commit': authorityCommit,
      kind: 'model',
      cursor: first.continuation,
      json: true
    })),
    (error) => error?.code === 'WMP_HISTORY_CURSOR_INVALID'
  );
  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
      'authority-commit': authorityCommit,
      limit: 501,
      json: true
    })),
    (error) => error?.code === 'WMP_HISTORY_LIMIT'
  );
});

test('history reads require an exact local cut and never route through --branch', async (t) => {
  const { root, authorityCommit, binding } = await persistedRepository(t);
  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], { json: true })),
    (error) => error?.code === 'WMB_COMMAND_ARGUMENT_REQUIRED'
      || error?.code === 'WMP_COMMAND_ARGUMENT_REQUIRED'
  );
  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'show', binding.modelKey], {
      'authority-commit': 'main', kind: 'model'
    })),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_REQUIRED'
  );
  const worktreesBefore = git(root, 'worktree', 'list', '--porcelain');
  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
      'authority-commit': authorityCommit, branch: 'main'
    })),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_REQUIRED'
  );
  assert.equal(git(root, 'worktree', 'list', '--porcelain'), worktreesBefore);
});

test('history commands never substitute an unpublished local state branch for configured remote authority', async (t) => {
  const { root, authorityCommit, binding } = await persistedRepository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-history-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote);

  await assert.rejects(
    quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
      'authority-commit': authorityCommit, kind: 'model', json: true
    })),
    (error) => error?.code === 'WMP_AUTHORITY_REFRESH_REQUIRED'
      && error?.details?.remote === 'origin'
      && error?.details?.remoteConfigured === true
  );

  // Once an exact remote-tracking cut is locally available, the same offline command admits it.
  git(root, 'update-ref', 'refs/remotes/origin/state', authorityCommit);
  const listed = await quiet(() => worldModelCommand(root, ['wm', 'history', 'list'], {
    'authority-commit': authorityCommit, kind: 'model', json: true
  }));
  assert.equal(listed.authorityRef, 'refs/remotes/origin/state');
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].key, binding.modelKey);
});

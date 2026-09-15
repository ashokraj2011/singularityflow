import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  buildPersistedWorldModelAfterLookupMiss,
  createPersistedWorldModelBindingFromBuild,
  deriveFrozenV1WorldModelExtractionPolicy,
  lookupPersistedWorldModelBeforeExtraction,
  preparePersistedWorldModelBuild
} from '../src/world-model/history/model-build.mjs';
import { resolvePersistedWorldModel } from '../src/world-model/history/store.mjs';
import {
  createWorldModelExtractionPolicy, createWorldModelRepositoryDomain
} from '../src/world-model/history/model-owners.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES,
  resolveExtractorExecutionContract, resolveExtractorManifest
} from '../src/world-model/registry/extractors.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { createExactSourceSnapshotAtRevision } from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

function digest(label) {
  return sha256({ fixture: label });
}

function repositoryAuthority(repositoryDomain, capabilityId, sourceCommit, variant = 'first') {
  const capabilityMapSha256 = digest('approved-capability-map');
  const base = {
    kind: 'wmp/repository-identity-authority',
    version: 1,
    repositoryDomainSha256: repositoryDomain.repositoryDomainSha256,
    repositoryId: repositoryDomain.repositoryId,
    repositoryIdentitySha256: repositoryDomain.repositoryIdentitySha256,
    capability: {
      id: capabilityId,
      mode: 'explicit-managed',
      resolutionSha256: digest('capability-resolution'),
      stateSha256: capabilityMapSha256
    },
    configurationAuthority: {
      kind: 'approved-configuration',
      repositoryIdentitySha256: digest('configuration-repository'),
      branch: 'sflow/config',
      commit: sourceCommit,
      capabilityMapSha256,
      portfolioSha256: digest(`portfolio-${variant}`)
    }
  };
  return sealRecord(base, 'authoritySha256');
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-model-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'WMP Model Build');
  git(root, 'config', 'user.email', 'wmp-model-build@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# exact application source\n');
  await writeFile(path.join(root, 'outside-scope.txt'), 'retained only in candidate roster\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'application source');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const capabilityId = 'application-api';
  const policySnapshotSha256 = digest('approved-extraction-policy');
  const scopeManifest = createScopeManifest({
    capabilityId,
    allowedPaths: ['README.md'],
    policySourceSha256: policySnapshotSha256
  });
  const sourceSnapshot = createExactSourceSnapshotAtRevision(root, sourceCommit, {
    subjectId: capabilityId,
    scopeManifest
  });
  const manifest = resolveExtractorManifest(
    BUILTIN_EXTRACTOR_REGISTRY, 'repository-files@1.0.0'
  );
  const extractorReference = `${manifest.id}@${manifest.version}`;
  const extractorReferences = [...DEFAULT_EXTRACTOR_REFERENCES].sort();
  const extractionPolicy = deriveFrozenV1WorldModelExtractionPolicy(
    scopeManifest, BUILTIN_EXTRACTOR_REGISTRY, extractorReferences
  );
  const repositoryDomain = createWorldModelRepositoryDomain({
    repositoryId: 'application',
    repositoryIdentitySha256: digest('application-repository')
  });
  const authority = repositoryAuthority(
    repositoryDomain, capabilityId, sourceCommit
  );
  const stableAuthority = async () => ({
    repositoryDomain,
    repositoryIdentityAuthority: authority,
    scopeManifest
  });
  const stableHistoryAuthority = async () => ({
    ref: 'refs/heads/main',
    commit: git(root, 'rev-parse', 'refs/heads/main'),
    repositoryIdentitySha256: null
  });
  const preparation = await preparePersistedWorldModelBuild(root, {
    sourceSnapshot,
    scopeManifest,
    extractionPolicy,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    resolveRepositoryAuthority: stableAuthority
  });
  assert.deepEqual(preparation.extractorReferences, extractorReferences);
  return {
    root,
    sourceCommit,
    capabilityId,
    policySnapshotSha256,
    scopeManifest,
    sourceSnapshot,
    manifest,
    extractorReference,
    extractorReferences,
    extractionPolicy,
    repositoryDomain,
    authority,
    stableAuthority,
    stableHistoryAuthority,
    preparation
  };
}

test('pre-extraction lookup returns a typed exact miss without extracting or mutating', async (t) => {
  const item = await fixture(t);
  let readCalls = 0;
  const result = await lookupPersistedWorldModelBeforeExtraction(item.root, {
    preparation: item.preparation,
    authorityCommit: item.sourceCommit,
    authorityRef: 'refs/heads/main',
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority,
    resolveModel() {
      readCalls += 1;
      const error = new Error('the exact model key does not exist');
      error.code = 'WMP_MODEL_MISSING';
      throw error;
    }
  });

  assert.equal(readCalls, 1);
  assert.equal(result.resultType, 'wmp-model-lookup');
  assert.equal(result.status, 'missing');
  assert.equal(result.reasonCode, 'WMP_MODEL_MISSING');
  assert.equal(result.modelKey, item.preparation.modelKey);
  assert.equal(result.repositoryDomainSha256,
    item.repositoryDomain.repositoryDomainSha256);
  assert.equal(result.inputPlanSha256, item.preparation.preparationSha256);
  assert.deepEqual(result.execution, {
    extraction: false, modelCalls: 0, astCalls: 0, cacheWrites: 0
  });
  assert.deepEqual(result.next, { action: 'build' });
  assert.equal(git(item.root, 'status', '--porcelain'), '');
});

test('caller authority arguments are assertions and cannot select another local ref', async (t) => {
  const item = await fixture(t);
  git(item.root, 'branch', 'attacker-controlled', item.sourceCommit);
  let historyReads = 0;
  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: item.preparation,
      authorityCommit: item.sourceCommit,
      authorityRef: 'refs/heads/attacker-controlled',
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      resolveModel() {
        historyReads += 1;
        throw new Error('caller-selected history must not be read');
      }
    }),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );
  assert.equal(historyReads, 0);
});

test('lookup binds an injected remote authority result to the approved Repository Domain', async (t) => {
  const item = await fixture(t);
  let receivedExpectedIdentity = null;
  let historyReads = 0;
  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: item.preparation,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: async (_root, options) => {
        receivedExpectedIdentity = options.expectedRepositoryIdentitySha256;
        return {
          ref: 'refs/remotes/origin/state',
          commit: item.sourceCommit,
          repositoryIdentitySha256: digest('substituted-state-endpoint')
        };
      },
      resolveModel() {
        historyReads += 1;
        throw new Error('a substituted endpoint must not reach history');
      }
    }),
    (error) => error?.code === 'WMP_STATE_AUTHORITY_IDENTITY_MISMATCH'
  );
  assert.equal(receivedExpectedIdentity, item.repositoryDomain.repositoryIdentitySha256);
  assert.equal(historyReads, 0);
});

test('lookup refuses when configured state authority advances during the history read', async (t) => {
  const item = await fixture(t);
  let authorityReads = 0;
  const advancingAuthority = async () => ({
    ref: 'refs/heads/main',
    commit: authorityReads++ === 0 ? item.sourceCommit : 'a'.repeat(40),
    repositoryIdentitySha256: null
  });

  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: item.preparation,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: advancingAuthority,
      resolveModel() {
        const error = new Error('not present at the original cut');
        error.code = 'WMP_MODEL_MISSING';
        throw error;
      }
    }),
    (error) => error?.code === 'WMP_REPOSITORY_AUTHORITY_CHANGED'
  );
  assert.equal(authorityReads, 2);
});

test('a typed miss cannot authorize extraction when source changes during history read', async (t) => {
  const item = await fixture(t);

  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: item.preparation,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      resolveModel() {
        writeFileSync(
          path.join(item.root, 'README.md'),
          '# source changed while persisted history was being read\n'
        );
        const error = new Error('not present at the original cut');
        error.code = 'WMP_MODEL_MISSING';
        throw error;
      }
    }),
    (error) => error?.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
      || error?.code === 'WMB_SOURCE_SNAPSHOT_STALE'
  );
});

test('lookup branches only on WMP_MODEL_MISSING and propagates every other refusal', async (t) => {
  const item = await fixture(t);
  for (const code of [
    'WMP_INTEGRITY_FAILED', 'WMP_READER_UNSUPPORTED', 'WMP_AUTHORITY_REF_MISMATCH'
  ]) {
    await assert.rejects(
      () => lookupPersistedWorldModelBeforeExtraction(item.root, {
        preparation: item.preparation,
        authorityCommit: item.sourceCommit,
        authorityRef: 'refs/heads/main',
        resolveRepositoryAuthority: item.stableAuthority,
        resolveHistoryAuthority: item.stableHistoryAuthority,
        resolveModel() {
          const error = new Error(code);
          error.code = code;
          throw error;
        }
      }),
      (error) => error?.code === code
    );
  }
});

test('preparation binds the extraction policy to the exact scope policy source', async (t) => {
  const item = await fixture(t);
  const substitutedPolicy = createWorldModelExtractionPolicy({
    policySnapshotSha256: digest('different-policy-authority'),
    allowedExtractors: item.extractionPolicy.allowedExtractors,
    factSemantics: item.extractionPolicy.factSemantics
  });

  await assert.rejects(
    () => preparePersistedWorldModelBuild(item.root, {
      capabilityId: item.capabilityId,
      sourceSnapshot: item.sourceSnapshot,
      scopeManifest: item.scopeManifest,
      extractionPolicy: substitutedPolicy,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractorReferences: item.extractorReferences,
      resolveRepositoryAuthority: item.stableAuthority
    }),
    (error) => error?.code === 'WMP_MODEL_INPUT_MISMATCH'
  );
});

test('preparation refuses different extraction semantics under the same governed policy digest', async (t) => {
  const item = await fixture(t);
  const substitutedPolicy = createWorldModelExtractionPolicy({
    policySnapshotSha256: item.policySnapshotSha256,
    allowedExtractors: item.extractionPolicy.allowedExtractors,
    factSemantics: {
      allowedFactTypes: item.extractionPolicy.factSemantics.allowedFactTypes,
      requiredFactTypes: item.extractionPolicy.factSemantics.allowedFactTypes,
      optionalFactTypes: [],
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [item.extractorReference]
    }
  });

  await assert.rejects(
    () => preparePersistedWorldModelBuild(item.root, {
      capabilityId: item.capabilityId,
      sourceSnapshot: item.sourceSnapshot,
      scopeManifest: item.scopeManifest,
      extractionPolicy: substitutedPolicy,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractorReferences: item.extractorReferences,
      resolveRepositoryAuthority: item.stableAuthority
    }),
    (error) => error?.code === 'WMP_EXTRACTION_POLICY_AUTHORITY_MISMATCH'
      && error?.details?.policySourceSha256 === item.policySnapshotSha256
  );
});

test('preparation refuses a caller-paired scope that is wider than governed configuration', async (t) => {
  const item = await fixture(t);
  const widerPolicySha256 = digest('caller-widened-scope-policy');
  const widerScope = createScopeManifest({
    capabilityId: item.capabilityId,
    allowedPaths: ['**'],
    policySourceSha256: widerPolicySha256
  });
  const widerSource = createExactSourceSnapshotAtRevision(item.root, item.sourceCommit, {
    subjectId: item.capabilityId,
    scopeManifest: widerScope
  });
  const pairedPolicy = deriveFrozenV1WorldModelExtractionPolicy(
    widerScope, BUILTIN_EXTRACTOR_REGISTRY, item.extractorReferences
  );

  await assert.rejects(
    () => preparePersistedWorldModelBuild(item.root, {
      capabilityId: item.capabilityId,
      sourceSnapshot: widerSource,
      scopeManifest: widerScope,
      extractionPolicy: pairedPolicy,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractorReferences: item.extractorReferences,
      resolveRepositoryAuthority: item.stableAuthority
    }),
    (error) => error?.code === 'WMP_SCOPE_AUTHORITY_MISMATCH'
      && error?.details?.expected === item.scopeManifest.scopeSha256
      && error?.details?.received === widerScope.scopeSha256
  );
});

test('preparation refuses a reduced installed extractor roster without a governed owner', async (t) => {
  const item = await fixture(t);
  const other = resolveExtractorManifest(
    BUILTIN_EXTRACTOR_REGISTRY, 'language-detection@1.0.0'
  );
  const otherExecution = resolveExtractorExecutionContract(other);
  const otherReference = `${other.id}@${other.version}`;
  const policy = createWorldModelExtractionPolicy({
    policySnapshotSha256: item.policySnapshotSha256,
    allowedExtractors: [{
      id: other.id,
      version: other.version,
      implementationSha256: other.producer.implementationSha256,
      manifestSha256: other.manifestSha256,
      coverage: otherExecution.coverage
    }],
    factSemantics: {
      allowedFactTypes: [...other.factTypes],
      requiredFactTypes: [],
      optionalFactTypes: [...other.factTypes],
      requiredUnavailableSubjects: [],
      coverageExtractorRefs: [otherReference]
    }
  });

  await assert.rejects(
    () => preparePersistedWorldModelBuild(item.root, {
      capabilityId: item.capabilityId,
      sourceSnapshot: item.sourceSnapshot,
      scopeManifest: item.scopeManifest,
      extractionPolicy: policy,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractorReferences: [otherReference],
      resolveRepositoryAuthority: item.stableAuthority
    }),
    (error) => error?.code === 'WMP_EXTRACTION_POLICY_AUTHORITY_MISMATCH'
      && error?.details?.receivedExtractorReferences?.includes(otherReference)
  );
});

test('preparation snapshots every caller input before awaiting governed authority', async (t) => {
  const item = await fixture(t);
  const mutableSource = structuredClone(item.sourceSnapshot);
  const mutableScope = structuredClone(item.scopeManifest);
  const mutablePolicy = structuredClone(item.extractionPolicy);
  const mutableRegistry = structuredClone(BUILTIN_EXTRACTOR_REGISTRY);
  const mutableReferences = [...item.extractorReferences];
  let releaseAuthority;
  let authorityStarted;
  const authorityStartedPromise = new Promise((resolve) => { authorityStarted = resolve; });
  const authorityReleasePromise = new Promise((resolve) => { releaseAuthority = resolve; });

  const pending = preparePersistedWorldModelBuild(item.root, {
    capabilityId: item.capabilityId,
    sourceSnapshot: mutableSource,
    scopeManifest: mutableScope,
    extractionPolicy: mutablePolicy,
    extractorRegistry: mutableRegistry,
    extractorReferences: mutableReferences,
    resolveRepositoryAuthority: async () => {
      authorityStarted();
      await authorityReleasePromise;
      return {
        repositoryDomain: item.repositoryDomain,
        repositoryIdentityAuthority: item.authority,
        scopeManifest: item.scopeManifest
      };
    }
  });
  await authorityStartedPromise;
  mutableSource.subject.id = 'mutated-source';
  mutableScope.allowedPaths[0] = '**';
  mutablePolicy.factSemantics.coverageExtractorRefs.length = 0;
  mutableRegistry.manifests.length = 0;
  mutableReferences.pop();
  releaseAuthority();

  const prepared = await pending;
  assert.equal(prepared.preparationSha256, item.preparation.preparationSha256);
  assert.deepEqual(prepared.extractorReferences, item.extractorReferences);
});

test('lookup refuses an authority digest change before reading persisted history', async (t) => {
  const item = await fixture(t);
  const changedAuthority = repositoryAuthority(
    item.repositoryDomain, item.capabilityId, item.sourceCommit, 'changed'
  );
  let historyReads = 0;

  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: item.preparation,
      authorityCommit: item.sourceCommit,
      authorityRef: 'refs/heads/main',
      resolveRepositoryAuthority: async () => ({
        repositoryDomain: item.repositoryDomain,
        repositoryIdentityAuthority: changedAuthority,
        scopeManifest: item.scopeManifest
      }),
      resolveHistoryAuthority: item.stableHistoryAuthority,
      resolveModel() {
        historyReads += 1;
        throw new Error('must not read after the authority changes');
      }
    }),
    (error) => error?.code === 'WMP_REPOSITORY_AUTHORITY_CHANGED'
  );
  assert.equal(historyReads, 0);
});

test('lookup re-verifies exact source and refuses post-preparation source tampering', async (t) => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, 'README.md'), '# source changed after preparation\n');
  let historyReads = 0;

  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: item.preparation,
      authorityCommit: item.sourceCommit,
      authorityRef: 'refs/heads/main',
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      resolveModel() {
        historyReads += 1;
        throw new Error('history must not be read for stale source');
      }
    }),
    (error) => error?.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
      || error?.code === 'WMB_SOURCE_SNAPSHOT_STALE'
  );
  assert.equal(historyReads, 0);
});

test('a tampered preparation cannot authorize registration', async (t) => {
  const item = await fixture(t);
  const miss = await lookupPersistedWorldModelBeforeExtraction(item.root, {
    preparation: item.preparation,
    authorityCommit: item.sourceCommit,
    authorityRef: 'refs/heads/main',
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority,
    resolveModel() {
      const error = new Error('missing');
      error.code = 'WMP_MODEL_MISSING';
      throw error;
    }
  });
  const tampered = structuredClone(item.preparation);
  tampered.inputs.sourceManifestSha256 = digest('substituted-source');
  let registrations = 0;

  await assert.rejects(
    () => buildPersistedWorldModelAfterLookupMiss(item.root, {
      preparation: tampered,
      lookup: miss,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      runRegistration() {
        registrations += 1;
        throw new Error('must not register an unsealed preparation');
      }
    }),
    (error) => error?.code === 'WMP_INTEGRITY_FAILED'
  );
  assert.equal(registrations, 0);
});

test('a fully rehashed Candidate Roster cannot substitute another tree for its named commit', async (t) => {
  const item = await fixture(t);
  const forged = structuredClone(item.preparation);
  const rosterObject = forged.retainedInputObjects.find(
    (entry) => entry.ref.role === 'candidate-roster'
  );
  const roster = JSON.parse(rosterObject.bytes);
  const selected = roster.candidates.find((entry) => entry.path === 'README.md');
  const excluded = roster.candidates.find((entry) => entry.path === 'outside-scope.txt');
  assert.ok(selected && excluded);
  excluded.objectId = selected.objectId;
  const treeInput = roster.candidates.map(
    (entry) => `${entry.mode} blob ${entry.objectId}\t${entry.path}\n`
  ).join('');
  roster.source.tree = run('git', ['mktree'], {
    cwd: item.root, input: treeInput
  }).stdout.trim();
  const sealedRoster = sealRecord(roster, 'candidateRosterSha256');
  const rosterBytes = canonicalJson(sealedRoster);
  const rosterRef = {
    ...rosterObject.ref,
    sha256: sha256(Buffer.from(rosterBytes, 'utf8')),
    bytes: Buffer.byteLength(rosterBytes, 'utf8')
  };
  rosterObject.ref = rosterRef;
  rosterObject.bytes = rosterBytes;
  const capture = forged.inputDescriptors.extractionInputs.captures.find(
    (entry) => entry.role === 'candidate-roster'
  );
  capture.objectRef = rosterRef;
  forged.retainedInputObjects.sort((left, right) => {
    const leftKey = `${left.ref.role}\0${left.ref.family ?? ''}\0${left.ref.sha256}`;
    const rightKey = `${right.ref.role}\0${right.ref.family ?? ''}\0${right.ref.sha256}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  forged.inputObjects = forged.retainedInputObjects.map((entry) => entry.ref);
  forged.inputs.extractionInputsSha256 = sha256(
    forged.inputDescriptors.extractionInputs
  );
  forged.modelKey = sha256({ kind: 'wmp/model-key', ...forged.inputs });
  const preparationCore = structuredClone(forged);
  delete preparationCore.preparationSha256;
  forged.preparationSha256 = sha256(preparationCore);
  let historyReads = 0;

  await assert.rejects(
    () => lookupPersistedWorldModelBeforeExtraction(item.root, {
      preparation: forged,
      authorityCommit: item.sourceCommit,
      authorityRef: 'refs/heads/main',
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      resolveModel() {
        historyReads += 1;
        throw new Error('history must not be read for a foreign Candidate Roster tree');
      }
    }),
    (error) => error?.code === 'WMP_CANDIDATE_ROSTER_SOURCE_MISMATCH'
  );
  assert.equal(historyReads, 0);
});

test('one explicit miss build registers once, persists one exact graph, and is then reused', async (t) => {
  const item = await fixture(t);
  const miss = await lookupPersistedWorldModelBeforeExtraction(item.root, {
    preparation: item.preparation,
    authorityCommit: item.sourceCommit,
    authorityRef: 'refs/heads/main',
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority,
    resolveModel() {
      const error = new Error('missing');
      error.code = 'WMP_MODEL_MISSING';
      throw error;
    }
  });
  let registrations = 0;
  const built = await buildPersistedWorldModelAfterLookupMiss(item.root, {
    preparation: item.preparation,
    lookup: miss,
    requestedViews: [],
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority,
    runRegistration(options) {
      registrations += 1;
      assert.equal(options.captureExtractorExecutions, true);
      assert.deepEqual(options.extractorReferences, item.extractorReferences);
      assert.deepEqual(options.requestedViews, []);
      return runDeterministicRegistration(options);
    }
  });
  assert.equal(registrations, 1);
  assert.equal(built.status, 'built');
  assert.equal(built.modelKey, item.preparation.modelKey);
  assert.equal(built.binding.completeness.excludedPaths, 1);
  assert.equal(
    built.objects.some((entry) => entry.ref.role === 'candidate-roster'
      && entry.ref.family === 'world-model-discovered-candidate-roster'),
    true
  );

  for (const [relative, contents] of Object.entries(built.stagedHistory.historyAdditions)) {
    await mkdir(path.dirname(path.join(item.root, relative)), { recursive: true });
    await writeFile(path.join(item.root, relative), contents);
  }
  git(item.root, 'add', '.');
  git(item.root, 'commit', '-qm', 'persist exact model graph');
  const authorityCommit = git(item.root, 'rev-parse', 'HEAD');

  const reused = await lookupPersistedWorldModelBeforeExtraction(item.root, {
    preparation: item.preparation,
    authorityCommit,
    authorityRef: 'refs/heads/main',
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority
  });
  assert.equal(registrations, 1, 'a hit does not invoke extraction again');
  assert.equal(reused.resultType, 'wmp-model-lookup');
  assert.equal(reused.status, 'reused');
  assert.equal(reused.modelKey, built.modelKey);
  assert.equal(reused.bindingByteSha256, sha256(Buffer.from(
    built.stagedHistory.historyAdditions[reused.bindingPath], 'utf8'
  )));
  assert.deepEqual(reused.execution, {
    extraction: false, modelCalls: 0, astCalls: 0, cacheWrites: 0
  });
  assert.equal(reused.resolved.binding.modelKey, item.preparation.modelKey);
  assert.equal(typeof reused.resolved.bindingCanonicalBytes, 'string');
  assert.equal('bindingBytes' in reused.resolved, false);
  assert.ok(Object.isFrozen(reused.resolved));
  assert.ok(Object.isFrozen(reused.resolved.binding));
  const retainedEntry = reused.resolved.closure.find((entry) => entry.record !== null);
  assert.ok(retainedEntry);
  assert.equal(typeof retainedEntry.canonicalBytes, 'string');
  assert.equal('bytes' in retainedEntry, false);
  assert.ok(Object.isFrozen(retainedEntry));
  assert.ok(Object.isFrozen(retainedEntry.ref));
  assert.ok(Object.isFrozen(retainedEntry.record));
  const originalRole = retainedEntry.ref.role;
  const originalKind = retainedEntry.record.kind;
  assert.throws(() => { retainedEntry.ref.role = 'mutated-role'; }, TypeError);
  assert.throws(() => { retainedEntry.record.kind = 'mutated-kind'; }, TypeError);
  assert.equal(retainedEntry.ref.role, originalRole);
  assert.equal(retainedEntry.record.kind, originalKind);

  const fabricatedCurrentMiss = {
    ...miss,
    authority: {
      ref: 'refs/heads/main', commit: authorityCommit,
      repositoryIdentitySha256: null
    }
  };
  let staleMissRegistrations = 0;
  await assert.rejects(
    () => buildPersistedWorldModelAfterLookupMiss(item.root, {
      preparation: item.preparation,
      lookup: fabricatedCurrentMiss,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      runRegistration() {
        staleMissRegistrations += 1;
        throw new Error('an exact binding already exists at this authority cut');
      }
    }),
    (error) => error?.code === 'WMP_MODEL_BUILD_NOT_AUTHORIZED'
  );
  assert.equal(staleMissRegistrations, 0);

  let forbiddenRegistrations = 0;
  await assert.rejects(
    () => buildPersistedWorldModelAfterLookupMiss(item.root, {
      preparation: item.preparation,
      lookup: reused,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: item.stableHistoryAuthority,
      runRegistration() {
        forbiddenRegistrations += 1;
        throw new Error('a reuse hit must not authorize a build');
      }
    }),
    (error) => error?.code === 'WMP_MODEL_BUILD_NOT_AUTHORIZED'
  );
  assert.equal(forbiddenRegistrations, 0);
});

test('post-extraction lookup adopts an exact byte-identical concurrent winner', async (t) => {
  const item = await fixture(t);
  const miss = await lookupPersistedWorldModelBeforeExtraction(item.root, {
    preparation: item.preparation,
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority,
    resolveModel() {
      const error = new Error('missing before extraction');
      error.code = 'WMP_MODEL_MISSING';
      throw error;
    }
  });
  const registration = runDeterministicRegistration({
    root: item.root,
    sourceSnapshot: item.sourceSnapshot,
    scopeManifest: item.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    extractorReferences: item.extractorReferences,
    requestedViews: [],
    captureExtractorExecutions: true
  });
  const expected = await createPersistedWorldModelBindingFromBuild(item.root, {
    preparation: item.preparation,
    registration,
    resolveRepositoryAuthority: item.stableAuthority
  });
  git(item.root, 'switch', '-q', '-c', 'concurrent-winner');
  for (const [relative, contents] of Object.entries(expected.stagedHistory.historyAdditions)) {
    await mkdir(path.dirname(path.join(item.root, relative)), { recursive: true });
    await writeFile(path.join(item.root, relative), contents);
  }
  git(item.root, 'add', '.');
  git(item.root, 'commit', '-qm', 'publish concurrent exact model');
  const winnerCommit = git(item.root, 'rev-parse', 'HEAD');
  git(item.root, 'switch', '-q', 'main');

  let authorityReads = 0;
  const movingHistoryAuthority = async () => {
    authorityReads += 1;
    return authorityReads <= 2
      ? {
          ref: 'refs/heads/main', commit: item.sourceCommit,
          repositoryIdentitySha256: null
        }
      : {
          ref: 'refs/heads/concurrent-winner', commit: winnerCommit,
          repositoryIdentitySha256: null
        };
  };
  let registrations = 0;
  const result = await buildPersistedWorldModelAfterLookupMiss(item.root, {
    preparation: item.preparation,
    lookup: miss,
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: movingHistoryAuthority,
    resolveModel(root, options) {
      if (options.authorityCommit === item.sourceCommit) {
        const error = new Error('missing at pre-extraction authority');
        error.code = 'WMP_MODEL_MISSING';
        throw error;
      }
      return resolvePersistedWorldModel(root, options);
    },
    runRegistration() {
      registrations += 1;
      return registration;
    }
  });

  assert.equal(registrations, 1);
  assert.equal(authorityReads, 4);
  assert.equal(result.status, 'reused');
  assert.equal(result.reasonCode, 'WMP_MODEL_CONCURRENT_WINNER');
  assert.equal(result.binding.bindingSha256, expected.binding.bindingSha256);
  assert.equal(result.authority.commit, winnerCommit);
  assert.equal(result.stagedHistory, null, 'an adopted winner cannot be republished');
  assert.deepEqual(result.execution, {
    extraction: true, registrationCalls: 1, modelCalls: 0, astCalls: 0,
    cacheWrites: 0
  });
});

test('post-extraction lookup refuses an advanced state cut without the exact key', async (t) => {
  const item = await fixture(t);
  const miss = await lookupPersistedWorldModelBeforeExtraction(item.root, {
    preparation: item.preparation,
    resolveRepositoryAuthority: item.stableAuthority,
    resolveHistoryAuthority: item.stableHistoryAuthority,
    resolveModel() {
      const error = new Error('missing before extraction');
      error.code = 'WMP_MODEL_MISSING';
      throw error;
    }
  });
  const tree = git(item.root, 'rev-parse', `${item.sourceCommit}^{tree}`);
  const advancedCommit = git(
    item.root, 'commit-tree', tree, '-p', item.sourceCommit, '-m', 'concurrent state advance'
  );
  git(item.root, 'update-ref', 'refs/heads/advanced-state', advancedCommit);
  let authorityReads = 0;
  const movingHistoryAuthority = async () => {
    authorityReads += 1;
    return authorityReads <= 2
      ? {
          ref: 'refs/heads/main', commit: item.sourceCommit,
          repositoryIdentitySha256: null
        }
      : {
          ref: 'refs/heads/advanced-state', commit: advancedCommit,
          repositoryIdentitySha256: null
        };
  };
  let registrations = 0;
  await assert.rejects(
    () => buildPersistedWorldModelAfterLookupMiss(item.root, {
      preparation: item.preparation,
      lookup: miss,
      resolveRepositoryAuthority: item.stableAuthority,
      resolveHistoryAuthority: movingHistoryAuthority,
      resolveModel() {
        const error = new Error('exact key remains missing');
        error.code = 'WMP_MODEL_MISSING';
        throw error;
      },
      runRegistration(options) {
        registrations += 1;
        return runDeterministicRegistration(options);
      }
    }),
    (error) => error?.code === 'WMP_REPOSITORY_AUTHORITY_CHANGED'
  );
  assert.equal(registrations, 1);
  assert.equal(authorityReads, 4);
});

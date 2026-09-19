import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { verifyGroundingRecord } from '../src/grounding.mjs';
import { recordInjection } from '../src/inject.mjs';
import { run } from '../src/util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { planWorldModelV4 } from '../src/world-model/plan.mjs';
import {
  createPersistedWorldModelBindingFromBuild,
  deriveFrozenV1WorldModelExtractionPolicy,
  preparePersistedWorldModelBuild
} from '../src/world-model/history/model-build.mjs';
import { createWmpGroundingPacket } from '../src/world-model/history/contracts.mjs';
import { createWorldModelRepositoryDomain } from '../src/world-model/history/model-owners.mjs';
import {
  worldModelGroundingPacketPath,
  worldModelGroundingPacketPayloadPath
} from '../src/world-model/history/paths.mjs';
import {
  materializePersistedWorldModelViews
} from '../src/world-model/history/saved-view-publication.mjs';
import {
  assertPinnedStoryWorldModelGroundingReplay,
  assertPinnedStoryWorldModelHistoryAuthority,
  persistPinnedStoryWorldModelGrounding,
  persistedStoryWorldModelGroundingReceipt,
  prepareStoryWorldModelHistoryPin,
  resolvePinnedStoryWorldModelGrounding,
  validateStoryWorldModelHistoryPin
} from '../src/world-model/history/story-grounding-activation.mjs';
import {
  resolvePersistedWorldModel,
  resolvePersistedWorldModelView
} from '../src/world-model/history/store.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES
} from '../src/world-model/registry/extractors.mjs';
import { BUILTIN_VIEW_REFERENCES } from '../src/world-model/registry/views.mjs';
import { configuredWorldModelV4ScopeOptions } from '../src/world-model/scope/configuration.mjs';

const STATE_REF = 'refs/remotes/origin/state';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

function objectRef(record, role, family) {
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  return Object.freeze({
    role, family, mediaType: 'application/json',
    sha256: sha256(bytes), bytes: bytes.length
  });
}

function closureDigest(authorityCommit, model, views) {
  const roots = [
    {
      ref: objectRef(model.binding, 'model-binding', 'world-model-model-binding'),
      bytes: model.bindingBytes
    },
    ...model.closure,
    ...views.flatMap((view) => [
      {
        ref: objectRef(view.binding, 'view-binding', 'world-model-view-binding'),
        bytes: view.bindingBytes
      },
      ...view.closure
    ])
  ];
  const unique = new Map();
  for (const entry of roots) {
    const bytes = Buffer.from(entry.canonicalBytes ?? entry.bytes);
    assert.equal(sha256(bytes), entry.ref.sha256);
    assert.equal(bytes.length, entry.ref.bytes);
    const prior = unique.get(entry.ref.sha256);
    if (prior) {
      assert.deepEqual(prior.ref, entry.ref);
      assert.ok(prior.bytes.equals(bytes));
    } else {
      unique.set(entry.ref.sha256, { ref: entry.ref, bytes });
    }
  }
  const objects = [...unique.values()].sort((left, right) => (
    `${left.ref.sha256}\0${left.ref.role}\0${left.ref.family ?? ''}`
      .localeCompare(`${right.ref.sha256}\0${right.ref.role}\0${right.ref.family ?? ''}`)
  ));
  return sha256({
    authorityCommit,
    objects: objects.map((entry) => ({
      ref: entry.ref, byteSha256: sha256(entry.bytes)
    }))
  });
}

function repositoryIdentityAuthority(repositoryDomain, capabilityId, commit) {
  const capabilityMapSha256 = sha256({ fixture: 'capability-map' });
  return sealRecord({
    kind: 'wmp/repository-identity-authority', version: 1,
    repositoryDomainSha256: repositoryDomain.repositoryDomainSha256,
    repositoryId: repositoryDomain.repositoryId,
    repositoryIdentitySha256: repositoryDomain.repositoryIdentitySha256,
    capability: {
      id: capabilityId, mode: 'explicit-managed',
      resolutionSha256: sha256({ fixture: 'resolution' }), stateSha256: capabilityMapSha256
    },
    configurationAuthority: {
      kind: 'approved-configuration',
      repositoryIdentitySha256: sha256({ fixture: 'configuration-repository' }),
      branch: 'sflow/config', commit, capabilityMapSha256,
      portfolioSha256: sha256({ fixture: 'portfolio' })
    }
  }, 'authoritySha256');
}

async function activationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-wmp-activation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Story WMP Activation');
  git(root, 'config', 'user.email', 'story-wmp@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# immutable application source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'application source');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  const capabilityId = 'application-api';
  const definition = {
    workItemRoot: 'singularity/work-items',
    worldModel: {
      format: 'registered-v4',
      historyDir: 'singularity/world-model-history',
      outputDir: 'singularity/world-model',
      sourceRoots: ['README.md'],
      agentViews: 'fallback'
    }
  };
  const workflow = {
    workItem: { id: 'WMP-STORY', baseCommit: sourceCommit },
    workflowSnapshot: { snapshotHash: sha256({ fixture: 'workflow-snapshot' }) },
    resolution: {
      capability: { id: capabilityId },
      worldModelGrounding: 'enforce',
      worldModelPolicy: { agentViews: 'fallback', context: {} },
      agents: {
        architect: { phases: ['design'], worldModelViews: [] },
        developer: { phases: ['implementation'], worldModelViews: [] }
      },
      phases: [{
        id: 'implementation',
        defaultAgent: 'developer',
        generation: { allowedProducers: ['governed-agent'] },
        worldModel: { views: ['development'], depth: 'quick', evidence: false }
      }]
    }
  };
  const plannedModel = planWorldModelV4(root, {
    views: [BUILTIN_VIEW_REFERENCES[0]],
    ...configuredWorldModelV4ScopeOptions(root, {
      definition, workflow, repositoryCapability: workflow.resolution.capability
    })
  });
  const { scopeManifest, sourceSnapshot } = plannedModel;
  const extractionPolicy = deriveFrozenV1WorldModelExtractionPolicy(
    scopeManifest, plannedModel.extractorRegistry, plannedModel.extractorReferences
  );
  const repositoryDomain = createWorldModelRepositoryDomain({
    repositoryId: 'application',
    repositoryIdentitySha256: sha256({ fixture: 'repository' })
  });
  const repositoryAuthority = repositoryIdentityAuthority(
    repositoryDomain, capabilityId, sourceCommit
  );
  const repositoryResolution = Object.freeze({
    repositoryDomain,
    repositoryIdentityAuthority: repositoryAuthority,
    scopeManifest
  });
  const resolveRepositoryAuthority = async () => repositoryResolution;
  const preparation = await preparePersistedWorldModelBuild(root, {
    sourceSnapshot,
    scopeManifest,
    extractionPolicy,
    extractorRegistry: plannedModel.extractorRegistry,
    extractorReferences: plannedModel.extractorReferences,
    resolveRepositoryAuthority
  });
  const registration = runDeterministicRegistration({
    root,
    sourceSnapshot,
    scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    extractorReferences: DEFAULT_EXTRACTOR_REFERENCES,
    requestedViews: [],
    captureExtractorExecutions: true
  });
  const built = await createPersistedWorldModelBindingFromBuild(root, {
    preparation, registration, resolveRepositoryAuthority
  });
  const saved = materializePersistedWorldModelViews({
    model: { binding: built.binding, objects: built.objects },
    views: ['development'], variants: ['brief']
  });

  git(root, 'switch', '-qc', 'state');
  for (const [relative, contents] of Object.entries(saved.stagedHistory.historyAdditions)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'persist exact world model and view');
  const authorityCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', STATE_REF, authorityCommit);
  const model = resolvePersistedWorldModel(root, {
    authorityCommit,
    authorityRef: STATE_REF,
    modelKey: saved.modelKey
  });
  const views = saved.views.map((entry) => resolvePersistedWorldModelView(root, {
    authorityCommit,
    authorityRef: STATE_REF,
    viewKey: entry.viewKey
  }));
  const pin = validateStoryWorldModelHistoryPin(sealRecord({
    schemaVersion: currentSchemaVersion('story-world-model-history-pin'),
    kind: 'story-world-model-history-pin',
    status: 'active',
    reasonCode: null,
    repositoryDomainSha256: repositoryDomain.repositoryDomainSha256,
    sourceRevision: sourceCommit,
    authority: {
      stateRef: STATE_REF,
      authorityCommit,
      repositoryIdentitySha256: repositoryDomain.repositoryIdentitySha256
    },
    historyDir: 'singularity/world-model-history',
    outputDir: 'singularity/world-model',
    model: {
      modelKey: model.binding.modelKey,
      bindingPath: model.bindingPath,
      bindingByteSha256: model.bindingByteSha256,
      bindingRef: objectRef(model.binding, 'model-binding', 'world-model-model-binding'),
      modelPayloadSha256: model.binding.modelPayloadSha256
    },
    views: views.map((view, index) => ({
      reference: `${view.binding.inputs.viewId}@${view.binding.inputs.viewVersion}`,
      variant: view.binding.inputs.variant,
      format: view.binding.inputs.format,
      viewKey: view.binding.viewKey,
      bindingPath: view.bindingPath,
      bindingByteSha256: view.bindingByteSha256,
      bindingRef: objectRef(view.binding, 'view-binding', 'world-model-view-binding'),
      renderedRef: view.binding.rendered,
      expansionHandle: saved.views[index].expansionHandle
    })),
    phasePlans: ['architect', 'developer'].map((agent) => ({
      phase: 'implementation', agent,
      orderedViewKeys: views.map((view) => view.binding.viewKey)
    })),
    composition: { maximumBytes: 128 * 1024 },
    closureSha256: closureDigest(authorityCommit, model, views)
  }, 'pinSha256'));
  workflow.resolution.worldModelHistoryPin = pin;
  const phase = { id: 'implementation', generation: 0 };
  const resolveCurrentAuthority = async () => ({
    ref: STATE_REF,
    commit: git(root, 'rev-parse', `${STATE_REF}^{commit}`),
    repositoryIdentitySha256: repositoryDomain.repositoryIdentitySha256
  });
  const resolve = (overrides = {}) => resolvePinnedStoryWorldModelGrounding(root, {
    definition,
    workflow,
    phase,
    agent: 'developer',
    resolveRepositoryAuthority,
    resolveCurrentAuthority,
    ...overrides
  });
  const persist = (resolved, overrides = {}) => persistPinnedStoryWorldModelGrounding(
    root, resolved, {
      definition,
      workflow,
      resolveRepositoryAuthority,
      resolveCurrentAuthority,
      ...overrides
    }
  );
  return {
    root, sourceCommit, authorityCommit, repositoryDomain,
    repositoryResolution, pin, workflow, definition, phase,
    resolveRepositoryAuthority, resolveCurrentAuthority, resolve, persist
  };
}

test('workflow schema exposes the optional exact Story world-model history-pin contract', async () => {
  const [workflowSchema, pinSchema] = await Promise.all([
    readFile(path.join(PACKAGE_ROOT, 'schemas', 'workflow.schema.json'), 'utf8').then(JSON.parse),
    readFile(
      path.join(PACKAGE_ROOT, 'schemas', 'story-world-model-history-pin.schema.json'), 'utf8'
    ).then(JSON.parse)
  ]);
  assert.deepEqual(
    workflowSchema.properties.resolution.properties.worldModelHistoryPin,
    {
      anyOf: [
        { type: 'null' },
        { $ref: 'story-world-model-history-pin.schema.json' }
      ]
    }
  );
  assert.equal(
    workflowSchema.properties.resolution.required?.includes('worldModelHistoryPin') ?? false,
    false
  );
  assert.deepEqual(pinSchema.oneOf, [
    { $ref: '#/$defs/active' },
    { $ref: '#/$defs/unavailable' }
  ]);
  for (const branch of ['active', 'unavailable']) {
    assert.equal(pinSchema.$defs[branch].additionalProperties, false);
    assert.deepEqual(
      [...pinSchema.$defs[branch].required].sort(),
      Object.keys(pinSchema.$defs[branch].properties).sort()
    );
  }
});

test('Story start prepares the same exact active pin from persisted history', async (t) => {
  const fixture = await activationFixture(t);
  git(fixture.root, 'switch', '-q', 'main');
  const workflow = structuredClone(fixture.workflow);
  delete workflow.resolution.worldModelHistoryPin;

  const prepared = await prepareStoryWorldModelHistoryPin(fixture.root, {
    definition: fixture.definition,
    workflow,
    maximumBytes: 128 * 1024,
    resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
    resolveCurrentAuthority: fixture.resolveCurrentAuthority
  });

  assert.equal(prepared.status, 'active');
  assert.equal(prepared.sourceRevision, fixture.sourceCommit);
  assert.equal(prepared.authority.authorityCommit, fixture.authorityCommit);
  assert.equal(prepared.pinSha256, fixture.pin.pinSha256);
  assert.deepEqual(prepared, fixture.pin);
});

test('Story pin retains exact grounding for an audited cross-phase agent override', async (t) => {
  const fixture = await activationFixture(t);
  git(fixture.root, 'switch', '-q', 'main');
  const workflow = structuredClone(fixture.workflow);
  delete workflow.resolution.worldModelHistoryPin;

  const prepared = await prepareStoryWorldModelHistoryPin(fixture.root, {
    definition: fixture.definition,
    workflow,
    maximumBytes: 128 * 1024,
    resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
    resolveCurrentAuthority: fixture.resolveCurrentAuthority
  });
  assert.deepEqual(
    prepared.phasePlans.map(({ phase, agent }) => `${phase}:${agent}`),
    ['implementation:architect', 'implementation:developer']
  );

  workflow.resolution.worldModelHistoryPin = prepared;
  const overridden = await resolvePinnedStoryWorldModelGrounding(fixture.root, {
    definition: fixture.definition,
    workflow,
    phase: fixture.phase,
    agent: 'architect',
    resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
    resolveCurrentAuthority: fixture.resolveCurrentAuthority
  });
  assert.equal(overridden.status, 'composed');
  assert.equal(overridden.authorityProven, true);
  assert.deepEqual(
    overridden.packet.views.map(({ viewKey }) => viewKey),
    prepared.phasePlans.find(({ agent }) => agent === 'architect').orderedViewKeys
  );
});

test('active Story pin resolves and persists an exact lifecycle-proven packet across a state fast-forward', async (t) => {
  const fixture = await activationFixture(t);
  const resolved = await fixture.resolve();
  assert.equal(resolved.status, 'composed');
  assert.equal(resolved.authorityProven, true);
  assert.equal(resolved.pinSha256, fixture.pin.pinSha256);
  assert.equal(resolved.packet.authority.authorityCommit, fixture.authorityCommit);
  assert.equal(resolved.execution.modelReads, 1);
  assert.equal(resolved.execution.viewReads, 1);
  assert.equal(resolved.content.endsWith('\n\n---\n\n'), true);

  const receipt = persistedStoryWorldModelGroundingReceipt(resolved);
  assert.deepEqual(
    assertPinnedStoryWorldModelGroundingReplay(resolved, {
      receipt,
      promptText: `# Prompt\n\n${resolved.content}Continue.\n`
    }),
    receipt
  );
  const substituted = structuredClone(receipt);
  substituted.groundingSha256 = sha256({ fixture: 'different-valid-looking-grounding' });
  assert.throws(
    () => assertPinnedStoryWorldModelGroundingReplay(resolved, {
      receipt: substituted,
      promptText: `# Prompt\n\n${resolved.content}Continue.\n`
    }),
    (error) => error.code === 'WMP_GROUNDING_REPLAY_MISMATCH'
  );

  const first = await fixture.persist(resolved);
  const second = await fixture.persist(resolved);
  assert.deepEqual(second, first);
  for (const file of resolved.files) {
    assert.equal(await readFile(path.join(fixture.root, file.path), 'utf8'), file.content);
  }
  await writeFile(path.join(fixture.root, resolved.files[0].path), '{"forged":true}\n');
  await assert.rejects(
    () => fixture.persist(resolved),
    (error) => error?.code === 'WMP_IDENTITY_CONFLICT'
  );

  await writeFile(path.join(fixture.root, 'STATE-NOTE.md'), '# fast-forward only\n');
  git(fixture.root, 'add', 'STATE-NOTE.md');
  git(fixture.root, 'commit', '-qm', 'advance admitted state authority');
  git(fixture.root, 'update-ref', STATE_REF, 'HEAD');
  const afterFastForward = await fixture.resolve();
  assert.equal(afterFastForward.authorityProven, true);
  assert.equal(afterFastForward.packet.authority.authorityCommit, fixture.authorityCommit);
  assert.equal(afterFastForward.content, resolved.content);
});

test('packet persistence rechecks authority and refuses a post-composition rewind', async (t) => {
  const fixture = await activationFixture(t);
  const resolved = await fixture.resolve();
  git(fixture.root, 'update-ref', STATE_REF, fixture.sourceCommit);

  await assert.rejects(
    () => fixture.persist(resolved),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );
  for (const file of resolved.files) {
    await assert.rejects(readFile(path.join(fixture.root, file.path)), { code: 'ENOENT' });
  }
});

test('recorded Story prompt reuse authority proof refuses a rewound or replaced state ref', async (t) => {
  const fixture = await activationFixture(t);
  const assertReusable = () => assertPinnedStoryWorldModelHistoryAuthority(fixture.root, {
    definition: fixture.definition,
    workflow: fixture.workflow,
    resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
    resolveCurrentAuthority: fixture.resolveCurrentAuthority
  });

  // This assertion is the reuse boundary invoked before an already-recorded generation prompt is
  // returned. It admits a fast-forwarded authority while preserving the Story's exact pinned cut.
  await assertReusable();
  await writeFile(path.join(fixture.root, 'STATE-FAST-FORWARD.md'), '# admitted descendant\n');
  git(fixture.root, 'add', 'STATE-FAST-FORWARD.md');
  git(fixture.root, 'commit', '-qm', 'advance reusable prompt authority');
  git(fixture.root, 'update-ref', STATE_REF, 'HEAD');
  assert.equal((await assertReusable()).pinSha256, fixture.pin.pinSha256);

  git(fixture.root, 'update-ref', STATE_REF, fixture.sourceCommit);
  await assert.rejects(
    assertReusable,
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );

  git(fixture.root, 'switch', '-q', '--orphan', 'replacement-authority');
  await writeFile(path.join(fixture.root, 'REPLACEMENT.md'), '# unrelated authority\n');
  git(fixture.root, 'add', 'REPLACEMENT.md');
  git(fixture.root, 'commit', '-qm', 'replace reusable prompt authority');
  git(fixture.root, 'update-ref', STATE_REF, 'replacement-authority');
  await assert.rejects(
    assertReusable,
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );
});

test('packet persistence refuses a symlinked grounding ancestor without writing outside', async (t) => {
  const fixture = await activationFixture(t);
  const resolved = await fixture.resolve();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-wmp-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const packetDirectory = path.dirname(resolved.files[0].path);
  const linkedAncestor = path.dirname(packetDirectory);
  await mkdir(path.dirname(path.join(fixture.root, linkedAncestor)), { recursive: true });
  await symlink(
    outside,
    path.join(fixture.root, linkedAncestor),
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  await assert.rejects(
    () => fixture.persist(resolved),
    (error) => error?.code === 'REPOSITORY_PATH_UNSAFE'
  );
  assert.deepEqual(await readdir(outside), []);
});

test('pinned Story cut fails closed after the admitted state ref is rewound or unrelated', async (t) => {
  const fixture = await activationFixture(t);
  assert.equal((await fixture.resolve()).authorityProven, true);

  git(fixture.root, 'update-ref', STATE_REF, fixture.sourceCommit);
  await assert.rejects(
    () => fixture.resolve(),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );

  git(fixture.root, 'switch', '-q', '--orphan', 'unrelated-state');
  await writeFile(path.join(fixture.root, 'UNRELATED.md'), '# unrelated authority\n');
  git(fixture.root, 'add', 'UNRELATED.md');
  git(fixture.root, 'commit', '-qm', 'unrelated state root');
  git(fixture.root, 'update-ref', STATE_REF, 'unrelated-state');
  await assert.rejects(
    () => fixture.resolve(),
    (error) => error?.code === 'WMP_AUTHORITY_CUT_NOT_ADMITTED'
  );
});

test('Story pin tampering and a missing exact pinned view are rejected before fallback', async (t) => {
  const fixture = await activationFixture(t);
  const tampered = structuredClone(fixture.pin);
  tampered.views[0].expansionHandle = `wmp-view:${sha256({ forged: 'handle' })}`;
  await assert.rejects(
    () => fixture.resolve({
      workflow: {
        ...fixture.workflow,
        resolution: { ...fixture.workflow.resolution, worldModelHistoryPin: tampered }
      }
    }),
    (error) => error?.code === 'WMP_LIFECYCLE_PIN_MISMATCH'
  );

  const missing = structuredClone(fixture.pin);
  missing.views[0].viewKey = sha256({ missing: 'exact-view' });
  for (const plan of missing.phasePlans) {
    plan.orderedViewKeys = [missing.views[0].viewKey];
  }
  const validMissing = validateStoryWorldModelHistoryPin(sealRecord({
    ...missing, pinSha256: undefined
  }, 'pinSha256'));
  await assert.rejects(
    () => fixture.resolve({
      workflow: {
        ...fixture.workflow,
        resolution: { ...fixture.workflow.resolution, worldModelHistoryPin: validMissing }
      }
    }),
    (error) => error?.code === 'WMP_VIEW_NOT_MATERIALIZED'
  );
});

test('unavailable Story pin is validated and resolves without touching history or authority', async () => {
  const pin = validateStoryWorldModelHistoryPin(sealRecord({
    schemaVersion: currentSchemaVersion('story-world-model-history-pin'),
    kind: 'story-world-model-history-pin',
    status: 'unavailable',
    reasonCode: 'WMP_MODEL_MISSING',
    repositoryDomainSha256: null,
    sourceRevision: null,
    authority: null,
    historyDir: 'singularity/world-model-history',
    outputDir: 'singularity/world-model',
    model: null,
    views: [],
    phasePlans: [],
    composition: { maximumBytes: 32_768 },
    closureSha256: null
  }, 'pinSha256'));
  let calls = 0;
  const touched = async () => { calls += 1; throw new Error('must not touch history'); };
  const result = await resolvePinnedStoryWorldModelGrounding('/not-used', {
    definition: {},
    workflow: { resolution: { worldModelHistoryPin: pin } },
    phase: { id: 'implementation', generation: 0 },
    agent: 'developer',
    resolveRepositoryAuthority: touched,
    resolveCurrentAuthority: touched,
    admitHistoryCut: touched,
    resolveModel: touched,
    resolveView: touched
  });
  assert.deepEqual(result, {
    status: 'unavailable', authorityProven: false, reasonCode: 'WMP_MODEL_MISSING'
  });
  assert.equal(calls, 0);
});

test('active Story pin preserves an explicit no-grounding result for an unplanned phase/agent', async (t) => {
  const fixture = await activationFixture(t);
  const phase = { id: 'planning', generation: 0, worldModel: { views: [] } };
  const unresolved = await resolvePinnedStoryWorldModelGrounding(fixture.root, {
    definition: fixture.definition,
    workflow: fixture.workflow,
    phase,
    agent: 'developer',
    resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
    resolveCurrentAuthority: fixture.resolveCurrentAuthority
  });
  assert.deepEqual(unresolved, {
    status: 'unavailable', authorityProven: false,
    reasonCode: 'WMP_VIEW_SELECTION_UNAVAILABLE'
  });

  const workDir = path.join(
    fixture.root, fixture.definition.workItemRoot, fixture.workflow.workItem.id
  );
  const recorded = await recordInjection(fixture.root, fixture.workflow, phase, {
    agent: 'developer', matchedRules: 0, mode: 'append', applied: false,
    depth: 'quick', evidence: false, sections: [], modelCommit: null,
    manifestSha256: null, modelSourceTreeSha256: null, composedSourceTreeSha256: null,
    fresh: null,
    groundingAvailability: {
      status: 'unavailable', reasonCode: 'WMP_VIEW_SELECTION_UNAVAILABLE'
    },
    sourceComparison: {
      status: 'unavailable', reasonCode: 'WMP_VIEW_SELECTION_UNAVAILABLE'
    },
    requiredViews: [], requiredSelections: [],
    renderedText: '# Planning prompt without a configured persisted view\n'
  }, { workDir });
  assert.equal(recorded.record.persistedGrounding, null);

  const definition = {
    ...fixture.definition,
    agents: { developer: { phases: ['planning'], worldModelViews: [] } }
  };
  const verified = await verifyGroundingRecord(
    fixture.root, definition, fixture.workflow, phase, { generation: 1, agent: 'developer' }
  );
  assert.deepEqual(verified.errors, []);
  assert.match(verified.warnings.join('\n'), /WMP_VIEW_SELECTION_UNAVAILABLE/u);

  const recordPath = path.join(workDir, 'context', 'planning-gen1.json');
  const exact = await readFile(recordPath, 'utf8');
  const substituted = JSON.parse(exact);
  substituted.groundingAvailability = { status: 'available', reasonCode: null };
  substituted.sourceComparison = { status: 'fresh', reasonCode: null };
  await writeFile(recordPath, `${JSON.stringify(substituted, null, 2)}\n`);
  const rejectedFallback = await verifyGroundingRecord(
    fixture.root, definition, fixture.workflow, phase, { generation: 1, agent: 'developer' }
  );
  assert.match(rejectedFallback.errors.join('\n'), /must retain the explicit no-grounding result/u);
  await writeFile(recordPath, exact);

  await assert.rejects(
    () => recordInjection(fixture.root, fixture.workflow, phase, {
      agent: 'developer', matchedRules: 0, mode: 'append', applied: true,
      depth: 'quick', evidence: false, sections: [], renderedText: '# forged substitution\n',
      persistedGrounding: { activation: 'story' }
    }, { workDir }),
    (error) => error?.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
});

test('enforced lifecycle verification accepts exact persisted Story grounding and rechecks authority', async (t) => {
  const fixture = await activationFixture(t);
  const definition = {
    ...fixture.definition,
    agents: { developer: { phases: ['implementation'], worldModelViews: [] } }
  };
  const resolved = await fixture.resolve();
  await fixture.persist(resolved);
  const receipt = persistedStoryWorldModelGroundingReceipt(resolved);
  const renderedText = `# Governed implementation prompt\n\n${resolved.content}Continue.\n`;
  const expectedViews = resolved.packet.views.map((view) => view.viewKey);
  const workDir = path.join(
    fixture.root, definition.workItemRoot, fixture.workflow.workItem.id
  );
  await recordInjection(fixture.root, fixture.workflow, fixture.phase, {
    agent: 'developer', matchedRules: 0, mode: 'append', applied: true,
    depth: 'quick', evidence: false,
    sections: resolved.files.filter((file) => file.path.endsWith('.md')).map((file) => ({
      path: file.path, sha256: file.sha256, bytes: file.bytes,
      injectedBytes: file.bytes, truncated: false, category: 'required', level: null,
      reason: 'pinned persisted Story grounding packet'
    })),
    modelCommit: fixture.authorityCommit,
    manifestSha256: null,
    modelSourceTreeSha256: null,
    composedSourceTreeSha256: null,
    fresh: true,
    groundingAvailability: { status: 'available', reasonCode: null },
    sourceComparison: { status: 'fresh', reasonCode: null },
    requiredViews: expectedViews,
    requiredSelections: resolved.packet.views.map((view) => ({
      kind: 'view', view: view.viewKey, tier: view.variant,
      reason: 'pinned persisted Story grounding'
    })),
    renderedText,
    persistedGrounding: receipt
  }, { workDir });

  const verified = await verifyGroundingRecord(
    fixture.root, definition, fixture.workflow, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.deepEqual(verified.errors, []);
  assert.deepEqual(verified.warnings, []);
  assert.match(verified.passes.join('\n'), /persisted Story grounding authority/u);
  assert.equal(verified.record.persistedGrounding.groundingSha256, receipt.groundingSha256);

  const recordPath = path.join(workDir, 'context', 'implementation-gen1.json');
  const exactRecord = await readFile(recordPath, 'utf8');
  const missingReceipt = JSON.parse(exactRecord);
  missingReceipt.persistedGrounding = null;
  await writeFile(recordPath, `${JSON.stringify(missingReceipt, null, 2)}\n`);
  const missing = await verifyGroundingRecord(
    fixture.root, definition, fixture.workflow, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.match(missing.errors.join('\n'), /requires a persisted grounding receipt/u);
  await writeFile(recordPath, exactRecord);

  const refreshedDefinition = { ...definition, agents: {} };
  const pinnedAgentStillValid = await verifyGroundingRecord(
    fixture.root, refreshedDefinition, fixture.workflow, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.deepEqual(pinnedAgentStillValid.errors, []);

  const conflictingEnvelope = JSON.parse(exactRecord);
  conflictingEnvelope.requiredViews = [];
  await writeFile(recordPath, `${JSON.stringify(conflictingEnvelope, null, 2)}\n`);
  const conflicted = await verifyGroundingRecord(
    fixture.root, definition, fixture.workflow, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.match(conflicted.errors.join('\n'), /envelope differs from its pinned phase plan/u);
  await writeFile(recordPath, exactRecord);

  // A coordinated attacker can make a replacement packet, payload, receipt, and prompt internally
  // self-consistent. Lifecycle verification must still replay the immutable model/view closure and
  // reject prose that the pinned registered renderer never produced.
  const forgedPayload = resolved.content.replace('- Expansion:', '- ExpansioN:');
  assert.notEqual(forgedPayload, resolved.content);
  assert.equal(Buffer.byteLength(forgedPayload), Buffer.byteLength(resolved.content));
  const forgedRenderedBlock = {
    ...resolved.packet.renderedBlock,
    sha256: sha256(Buffer.from(forgedPayload, 'utf8')),
    bytes: Buffer.byteLength(forgedPayload, 'utf8')
  };
  const { groundingSha256: _originalGroundingSha256, ...packetCore } = resolved.packet;
  const forgedPacket = createWmpGroundingPacket({
    ...packetCore,
    renderedBlock: forgedRenderedBlock,
    budget: { ...packetCore.budget, measured: forgedRenderedBlock.bytes }
  });
  const forgedPacketText = canonicalJson(forgedPacket);
  const forgedPacketPath = worldModelGroundingPacketPath(
    fixture.workflow.workItem.id, forgedPacket.groundingSha256,
    { workItemRoot: definition.workItemRoot }
  );
  const forgedPayloadPath = worldModelGroundingPacketPayloadPath(
    fixture.workflow.workItem.id, forgedPacket.groundingSha256,
    { workItemRoot: definition.workItemRoot }
  );
  const forgedPacketRef = {
    role: 'grounding-packet', family: 'world-model-grounding-packet',
    mediaType: 'application/json', sha256: sha256(Buffer.from(forgedPacketText, 'utf8')),
    bytes: Buffer.byteLength(forgedPacketText, 'utf8')
  };
  const forgedFiles = [
    {
      path: forgedPacketPath, sha256: forgedPacketRef.sha256,
      bytes: forgedPacketRef.bytes
    },
    {
      path: forgedPayloadPath, sha256: forgedRenderedBlock.sha256,
      bytes: forgedRenderedBlock.bytes
    }
  ];
  await Promise.all([
    writeFile(path.join(fixture.root, forgedPacketPath), forgedPacketText),
    writeFile(path.join(fixture.root, forgedPayloadPath), forgedPayload)
  ]);
  const forgedPrompt = renderedText.replace(resolved.content, forgedPayload);
  const coordinatedSubstitution = JSON.parse(exactRecord);
  coordinatedSubstitution.persistedGrounding = {
    ...coordinatedSubstitution.persistedGrounding,
    groundingSha256: forgedPacket.groundingSha256,
    packetRef: forgedPacketRef,
    renderedBlock: forgedRenderedBlock,
    files: forgedFiles
  };
  coordinatedSubstitution.renderedSha256 = sha256(
    Buffer.from(forgedPrompt, 'utf8')
  ).slice('sha256:'.length);
  coordinatedSubstitution.files = coordinatedSubstitution.files.map((file) => (
    file.path === receipt.files.find((entry) => entry.path.endsWith('.md')).path
      ? {
          ...file,
          path: forgedPayloadPath,
          sha256: forgedRenderedBlock.sha256,
          bytes: forgedRenderedBlock.bytes,
          injectedBytes: forgedRenderedBlock.bytes
        }
      : file
  ));
  const promptPath = path.join(
    workDir, 'context', 'prompts', 'implementation-gen1.md'
  );
  await Promise.all([
    writeFile(recordPath, `${JSON.stringify(coordinatedSubstitution, null, 2)}\n`),
    writeFile(promptPath, forgedPrompt)
  ]);
  const substituted = await verifyGroundingRecord(
    fixture.root, definition, fixture.workflow, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.match(
    substituted.errors.join('\n'),
    /differs from the exact closure pinned by this Story/u
  );
  await Promise.all([
    writeFile(recordPath, exactRecord),
    writeFile(promptPath, renderedText)
  ]);

  const projectionGroundingOff = {
    ...fixture.workflow,
    resolution: { ...fixture.workflow.resolution, worldModelGrounding: 'off' }
  };
  const exactHistoryStillVerified = await verifyGroundingRecord(
    fixture.root, definition, projectionGroundingOff, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.equal(exactHistoryStillVerified.mode, 'enforce');
  assert.deepEqual(exactHistoryStillVerified.errors, []);

  // A valid, sealed prompt cannot retain lifecycle authority after the configured state ref is
  // rewound. The verifier reports a normal enforce-mode blocker instead of falling back to legacy
  // projection assumptions or throwing past the caller's structured gate.
  git(fixture.root, 'update-ref', STATE_REF, fixture.sourceCommit);
  const rewound = await verifyGroundingRecord(
    fixture.root, definition, projectionGroundingOff, fixture.phase, {
      generation: 1,
      agent: 'developer',
      resolveRepositoryAuthority: fixture.resolveRepositoryAuthority,
      resolveCurrentAuthority: fixture.resolveCurrentAuthority
    }
  );
  assert.equal(rewound.warnings.length, 0);
  assert.match(rewound.errors.join('\n'), /persisted Story grounding verification failed/u);
  assert.match(rewound.errors.join('\n'), /not an admitted cut of the configured state authority/u);
});

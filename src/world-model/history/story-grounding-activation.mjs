import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readRecord, currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  ensureSecureRepositoryDirectory, secureRepositoryPath, SingularityFlowError,
  writeAtomicExclusive
} from '../../util.mjs';
import { resolveGroundingPlan } from '../../world-model-selection.mjs';
import { canonicalJson, compareText, deepFreeze, sealRecord, sha256 } from '../canonicalize.mjs';
import { planWorldModelV4 } from '../plan.mjs';
import { createExactSourceSnapshotAtRevision } from '../source/snapshot.mjs';
import { configuredWorldModelV4ScopeOptions } from '../scope/configuration.mjs';
import { BUILTIN_VIEW_REFERENCES, normalizeWmpOverviewViewReference } from '../registry/views.mjs';
import {
  deriveFrozenV1WorldModelExtractionPolicy,
  lookupPersistedWorldModelBeforeExtraction,
  preparePersistedWorldModelBuild
} from './model-build.mjs';
import {
  planPersistedWorldModelViews
} from './saved-view-publication.mjs';
import {
  preparePersistedStoryGrounding
} from './grounding-packet.mjs';
import {
  resolvePersistedWorldModel,
  resolvePersistedWorldModelView,
  resolveWorldModelHistoryAuthority
} from './store.mjs';
import {
  configuredWorldModelHistoryAuthorityCut
} from './authority-cut.mjs';
import {
  withStoryConfigurationSnapshotRead
} from '../../configuration-branch.mjs';
import { withWorldModelSourceScope } from '../../source-scope.mjs';
import {
  resolveWorldModelRepositoryIdentityAuthority
} from './repository-identity-authority.mjs';
import {
  DEFAULT_WORLD_MODEL_HISTORY_DIR,
  DEFAULT_WORLD_MODEL_OUTPUT_DIR,
  validateWorldModelHistoryRoots
} from './paths.mjs';

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SAFE_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const VIEW_REFERENCE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/u;
const ACTIVATION_KIND = 'story-world-model-history-pin';
const MAXIMUM_PHASE_PLANS = 1024;
const MAXIMUM_VIEWS = 256;
const DEFAULT_MAXIMUM_BYTES = 32_768;
const MAXIMUM_CLOSURE_OBJECTS = 100_000;
const MAXIMUM_CLOSURE_BYTES = 256 * 1024 * 1024;
const LIFECYCLE_PROVEN_GROUNDINGS = new WeakSet();
const INITIAL_UNAVAILABLE_CODES = new Set([
  'WMP_MODEL_MISSING',
  'WMP_VIEW_NOT_MATERIALIZED',
  'WMP_VIEW_SELECTION_UNAVAILABLE',
  'WMP_AUTHORITY_REFRESH_REQUIRED',
  'WMP_AUTHORITY_CUT_REQUIRED',
  'WMP_AUTHORITY_UNAVAILABLE',
  'WMP_REPOSITORY_AUTHORITY_REQUIRED',
  'WMP_REPOSITORY_AUTHORITY_EXPLICIT_CAPABILITY_REQUIRED',
  'WMP_REPOSITORY_AUTHORITY_UNGOVERNED',
  'WMP_REPOSITORY_AUTHORITY_PORTFOLIO_REQUIRED',
  'WMP_REPOSITORY_AUTHORITY_REPOSITORY_MISSING',
  'WMP_REPOSITORY_AUTHORITY_REMOTE_INVALID',
  'WMP_STATE_AUTHORITY_IDENTITY_REQUIRED',
  'WMP_STORY_CAPABILITY_PIN_REQUIRED'
]);
const WMB_TO_WMP = deepFreeze({
  'arch.contracts': 'architecture',
  'biz.rules': 'business',
  'dev.hotspots': 'development',
  'dev.impact': 'development'
});

function fail(message, code = 'WMP_LIFECYCLE_PIN_INVALID', details = {}, cause) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function exactKeys(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain record.`);
  }
  const received = Object.keys(value).sort(compareText);
  const expected = [...required].sort(compareText);
  if (canonicalJson(received) !== canonicalJson(expected)) {
    fail(`${label} has an invalid closed shape.`, 'WMP_LIFECYCLE_PIN_INVALID', {
      expected, received
    });
  }
}

function exactObjectRef(value, label) {
  exactKeys(value, ['role', 'family', 'mediaType', 'sha256', 'bytes'], label);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.role ?? '')
      || (value.family !== null
        && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.family ?? ''))
      || !['application/json', 'text/markdown'].includes(value.mediaType)
      || !DIGEST.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1
      || value.bytes > 32 * 1024 * 1024) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function exactAuthority(value) {
  exactKeys(value, [
    'stateRef', 'authorityCommit', 'repositoryIdentitySha256'
  ], 'Story World-Model history authority');
  if (!SAFE_REF.test(value.stateRef) || value.stateRef.includes('..')
      || value.stateRef.includes('//') || value.stateRef.endsWith('/')
      || value.stateRef.endsWith('.lock') || value.stateRef.includes('@{')
      || !COMMIT.test(value.authorityCommit)
      || (value.repositoryIdentitySha256 !== null
        && !DIGEST.test(value.repositoryIdentitySha256))) {
    fail('Story World-Model history authority is invalid.');
  }
  return value;
}

function pinCore(value) {
  const core = structuredClone(value);
  delete core.pinSha256;
  return core;
}

export function validateStoryWorldModelHistoryPin(value) {
  let pin;
  try { pin = readRecord(ACTIVATION_KIND, value).record; }
  catch (error) {
    fail(`Story World-Model history pin schema is unsupported: ${error.message}`,
      'WMP_LIFECYCLE_PIN_INVALID', {}, error);
  }
  exactKeys(pin, [
    'schemaVersion', 'kind', 'status', 'reasonCode', 'repositoryDomainSha256',
    'sourceRevision', 'authority', 'historyDir', 'outputDir', 'model', 'views',
    'phasePlans', 'composition', 'closureSha256', 'pinSha256'
  ], 'Story World-Model history pin');
  if (pin.kind !== ACTIVATION_KIND || !['active', 'unavailable'].includes(pin.status)) {
    fail('Story World-Model history pin kind or status is invalid.');
  }
  if (!Array.isArray(pin.views) || !Array.isArray(pin.phasePlans)) {
    fail('Story World-Model history pin rosters must be arrays.');
  }
  validateWorldModelHistoryRoots({
    historyDir: pin.historyDir,
    outputDir: pin.outputDir
  });
  exactKeys(pin.composition, ['maximumBytes'], 'Story World-Model history composition');
  if (!Number.isSafeInteger(pin.composition.maximumBytes)
      || pin.composition.maximumBytes < 1
      || pin.composition.maximumBytes > 32 * 1024 * 1024) {
    fail('Story World-Model history composition budget is invalid.');
  }
  if (pin.status === 'unavailable') {
    if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u.test(pin.reasonCode ?? '')
        || Buffer.byteLength(pin.reasonCode, 'utf8') > 128
        || pin.repositoryDomainSha256 !== null
        || pin.sourceRevision !== null || pin.authority !== null || pin.model !== null
        || pin.views.length || pin.phasePlans.length || pin.closureSha256 !== null) {
      fail('Unavailable Story World-Model history pin carries authority-shaped data.');
    }
  } else {
    if (pin.reasonCode !== null || !DIGEST.test(pin.repositoryDomainSha256)
        || !COMMIT.test(pin.sourceRevision) || !DIGEST.test(pin.closureSha256)) {
      fail('Active Story World-Model history pin identity is invalid.');
    }
    exactAuthority(pin.authority);
    exactKeys(pin.model, [
      'modelKey', 'bindingPath', 'bindingByteSha256', 'bindingRef',
      'modelPayloadSha256'
    ], 'Story World-Model history model');
    for (const field of ['modelKey', 'bindingByteSha256', 'modelPayloadSha256']) {
      if (!DIGEST.test(pin.model[field])) fail(`Story World-Model history model ${field} is invalid.`);
    }
    if (typeof pin.model.bindingPath !== 'string' || !pin.model.bindingPath.length
        || Buffer.byteLength(pin.model.bindingPath, 'utf8') > 4096) {
      fail('Story World-Model history model bindingPath is invalid.');
    }
    exactObjectRef(pin.model.bindingRef, 'Story World-Model history model bindingRef');
    if (!Array.isArray(pin.views) || !pin.views.length || pin.views.length > MAXIMUM_VIEWS) {
      fail('Active Story World-Model history pin requires a bounded view roster.');
    }
    const viewKeys = new Set();
    for (const [index, view] of pin.views.entries()) {
      exactKeys(view, [
        'reference', 'variant', 'format', 'viewKey', 'bindingPath',
        'bindingByteSha256', 'bindingRef', 'renderedRef', 'expansionHandle'
      ], `Story World-Model history view ${index}`);
      if (!VIEW_REFERENCE.test(view.reference ?? '')
          || !['brief', 'full'].includes(view.variant)
          || view.format !== 'md' || !DIGEST.test(view.viewKey)
          || !DIGEST.test(view.bindingByteSha256)
          || typeof view.bindingPath !== 'string' || !view.bindingPath.length
          || Buffer.byteLength(view.bindingPath, 'utf8') > 4096
          || !/^wmp-view:sha256:[a-f0-9]{64}$/u.test(view.expansionHandle)) {
        fail(`Story World-Model history view ${index} is invalid.`);
      }
      exactObjectRef(view.bindingRef, `Story World-Model history view ${index} bindingRef`);
      exactObjectRef(view.renderedRef, `Story World-Model history view ${index} renderedRef`);
      if (viewKeys.has(view.viewKey)) fail('Story World-Model history pin repeats a View Key.');
      viewKeys.add(view.viewKey);
    }
    if (!Array.isArray(pin.phasePlans) || !pin.phasePlans.length
        || pin.phasePlans.length > MAXIMUM_PHASE_PLANS) {
      fail('Active Story World-Model history pin requires a bounded phase plan roster.');
    }
    const planKeys = new Set();
    for (const [index, plan] of pin.phasePlans.entries()) {
      exactKeys(plan, ['phase', 'agent', 'orderedViewKeys'],
        `Story World-Model history phase plan ${index}`);
      const key = `${plan.phase}\0${plan.agent}`;
      if (!IDENTIFIER.test(plan.phase ?? '') || !IDENTIFIER.test(plan.agent ?? '')
          || planKeys.has(key) || !Array.isArray(plan.orderedViewKeys)
          || !plan.orderedViewKeys.length
          || new Set(plan.orderedViewKeys).size !== plan.orderedViewKeys.length
          || plan.orderedViewKeys.some((entry) => !viewKeys.has(entry))) {
        fail(`Story World-Model history phase plan ${index} is invalid.`);
      }
      planKeys.add(key);
    }
  }
  if (pin.pinSha256 !== sha256(pinCore(pin))) {
    fail('Story World-Model history pin self-hash does not verify.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
  return deepFreeze(pin);
}

function unavailablePin(reasonCode, { historyDir, outputDir } = {}) {
  return validateStoryWorldModelHistoryPin(sealRecord({
    schemaVersion: currentSchemaVersion(ACTIVATION_KIND),
    kind: ACTIVATION_KIND,
    status: 'unavailable',
    reasonCode,
    repositoryDomainSha256: null,
    sourceRevision: null,
    authority: null,
    historyDir: historyDir ?? DEFAULT_WORLD_MODEL_HISTORY_DIR,
    outputDir: outputDir ?? DEFAULT_WORLD_MODEL_OUTPUT_DIR,
    model: null,
    views: [],
    phasePlans: [],
    composition: { maximumBytes: DEFAULT_MAXIMUM_BYTES },
    closureSha256: null
  }, 'pinSha256'));
}

function mappedOverviewReference(value) {
  const raw = String(value ?? '').trim();
  const withoutVersion = raw.replace(/@[1-9][0-9]*$/u, '');
  const selected = WMB_TO_WMP[withoutVersion] ?? raw;
  try { return normalizeWmpOverviewViewReference(selected).reference; }
  catch { return null; }
}

function phaseSelectionPlans(definition, workflow) {
  const plans = [];
  const requiredPairs = new Map();
  const unsupported = new Set();
  // Story creation has already snapshotted the complete selectable agent catalog. A governed
  // session may explicitly select an agent outside its declared phase roster; that audited
  // compatibility override is a supported product path, not an invalid identity. Derive a plan for
  // every captured selectable agent so a later valid /sf-agent selection cannot escape the accepted
  // history cut or become unusable merely because it was an override.
  const agents = workflow.resolution?.agents ?? definition.agents ?? {};
  const worldModelPolicy = workflow.resolution?.worldModelPolicy
    ?? definition.worldModel ?? {};
  for (const phase of workflow.resolution?.phases ?? []) {
    if (Array.isArray(phase.generation?.allowedProducers)
        && !phase.generation.allowedProducers.includes('governed-agent')) {
      continue;
    }
    const agentIds = [...new Set([
      phase.defaultAgent,
      ...Object.keys(agents)
    ].filter(Boolean))].sort(compareText);
    for (const agent of agentIds) {
      const selected = resolveGroundingPlan({
        phase: phase.id,
        phaseViews: phase.worldModel?.views ?? [],
        agentViews: agents[agent]?.worldModelViews ?? [],
        agentViewMode: worldModelPolicy.agentViews ?? 'fallback',
        depth: phase.worldModel?.depth ?? 'standard',
        evidence: phase.worldModel?.evidence ?? false,
        context: worldModelPolicy.context ?? {}
      });
      const entries = [];
      const entryPairs = new Set();
      for (const view of selected.views) {
        const reference = mappedOverviewReference(view.view);
        if (!reference) {
          unsupported.add(String(view.view));
          continue;
        }
        const pair = `${reference}\0${view.tier}`;
        requiredPairs.set(pair, { reference, variant: view.tier });
        if (entryPairs.has(pair)) continue;
        entryPairs.add(pair);
        entries.push({ pair, reference, variant: view.tier });
      }
      if (entries.length) plans.push({ phase: phase.id, agent, entries });
    }
  }
  return {
    plans,
    requiredPairs: [...requiredPairs.values()],
    unsupported: [...unsupported].sort(compareText)
  };
}

function retainedBindingObject(resolved, kind) {
  const text = resolved.bindingCanonicalBytes
    ?? new TextDecoder('utf-8', { fatal: true }).decode(resolved.bindingBytes);
  const raw = Buffer.from(text, 'utf8');
  return {
    ref: {
      role: kind === 'model' ? 'model-binding' : 'view-binding',
      family: kind === 'model' ? 'world-model-model-binding' : 'world-model-view-binding',
      mediaType: 'application/json',
      sha256: sha256(raw),
      bytes: raw.length
    },
    bytes: text,
    record: resolved.binding
  };
}

function canonicalClosure(model, views, authority) {
  const values = [
    retainedBindingObject(model, 'model'),
    ...model.closure.map((entry) => ({
      ref: entry.ref,
      bytes: entry.canonicalBytes
        ?? new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes),
      record: entry.record
    }))
  ];
  for (const view of views) {
    values.push(retainedBindingObject(view, 'view'));
    values.push(...view.closure.map((entry) => ({
      ref: entry.ref,
      bytes: entry.canonicalBytes
        ?? new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes),
      record: entry.record
    })));
  }
  const byDigest = new Map();
  for (const entry of values) {
    const bytes = Buffer.from(entry.bytes, 'utf8');
    if (sha256(bytes) !== entry.ref.sha256 || bytes.length !== entry.ref.bytes) {
      fail('Story World-Model history closure bytes differ from their ObjectRef.',
        'WMP_INTEGRITY_FAILED', { sha256: entry.ref.sha256 });
    }
    const prior = byDigest.get(entry.ref.sha256);
    if (prior && (canonicalJson(prior.ref) !== canonicalJson(entry.ref)
        || !Buffer.from(prior.bytes, 'utf8').equals(bytes))) {
      fail('Story World-Model history closure repeats a digest with conflicting identity or bytes.',
        'WMP_IDENTITY_CONFLICT', { sha256: entry.ref.sha256 });
    }
    if (!prior) {
      if (byDigest.size >= MAXIMUM_CLOSURE_OBJECTS) {
        fail('Story World-Model history closure exceeds its object limit.',
          'WMP_CONTRACT_LIMIT', { maximumObjects: MAXIMUM_CLOSURE_OBJECTS });
      }
      byDigest.set(entry.ref.sha256, {
        ref: structuredClone(entry.ref), bytes: entry.bytes, record: structuredClone(entry.record)
      });
    }
  }
  const objects = [...byDigest.values()].sort((left, right) => compareText(
    `${left.ref.sha256}\0${left.ref.role}\0${left.ref.family ?? ''}`,
    `${right.ref.sha256}\0${right.ref.role}\0${right.ref.family ?? ''}`
  ));
  const totalBytes = objects.reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.bytes, 'utf8'), 0
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAXIMUM_CLOSURE_BYTES) {
    fail('Story World-Model history closure exceeds its aggregate byte limit.',
      'WMP_CONTRACT_LIMIT', {
        measuredBytes: Number.isSafeInteger(totalBytes) ? totalBytes : null,
        maximumBytes: MAXIMUM_CLOSURE_BYTES
      });
  }
  const closureSha256 = sha256({
    authorityCommit: authority.authorityCommit,
    objects: objects.map((entry) => ({ ref: entry.ref, byteSha256: sha256(Buffer.from(entry.bytes, 'utf8')) }))
  });
  return { objects, closureSha256 };
}

function renderedObject(view) {
  const matches = view.closure.filter((entry) => (
    entry.ref.sha256 === view.binding.rendered.sha256
  ));
  if (matches.length !== 1 || canonicalJson(matches[0].ref) !== canonicalJson(view.binding.rendered)) {
    fail('Persisted Story view does not contain its exact rendered object.',
      'WMP_LIFECYCLE_CLOSURE_MISMATCH');
  }
  return matches[0];
}

function expansionHandle(view) {
  const object = renderedObject(view);
  const text = object.canonicalBytes
    ?? new TextDecoder('utf-8', { fatal: true }).decode(object.bytes);
  const matches = [...text.matchAll(/^- Expansion: ([^\r\n]+)$/gmu)];
  const handle = matches.length === 1
    ? matches[0][1].replaceAll('&#58;', ':').replaceAll('\\-', '-') : null;
  if (!/^wmp-view:sha256:[a-f0-9]{64}$/u.test(handle ?? '')) {
    fail('Persisted Story view has no exact governed expansion handle.',
      'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH');
  }
  return handle;
}

function savedViewsFromResolved(model, resolvedViews) {
  const modelObject = retainedBindingObject(model, 'model');
  const closure = canonicalClosure(model, resolvedViews, {
    authorityCommit: model.authorityCommit
  });
  return deepFreeze({
    status: 'materialized',
    measurementPolicy: 'exact-bytes-v1',
    modelKey: model.binding.modelKey,
    modelBinding: model.binding,
    modelBindingRef: modelObject.ref,
    views: resolvedViews.map((view) => {
      const bindingObject = retainedBindingObject(view, 'view');
      return {
        reference: `${view.binding.inputs.viewId}@${view.binding.inputs.viewVersion}`,
        variant: view.binding.inputs.variant,
        format: view.binding.inputs.format,
        viewKey: view.binding.viewKey,
        bindingSha256: view.binding.bindingSha256,
        binding: view.binding,
        renderedRef: view.binding.rendered,
        expansionHandle: expansionHandle(view),
        bytes: view.binding.rendered.bytes
      };
    }),
    bindings: resolvedViews.map((view) => view.binding),
    objects: closure.objects
  });
}

function compareAuthority(left, right) {
  return left.ref === right.ref && left.commit === right.commit
    && left.repositoryIdentitySha256 === right.repositoryIdentitySha256;
}

function initialPinRecord({ workflow, lookup, planned, resolvedViews, phasePlans,
  historyDir, outputDir, maximumBytes }) {
  const authority = {
    stateRef: lookup.authority.ref,
    authorityCommit: lookup.authority.commit,
    repositoryIdentitySha256: lookup.authority.repositoryIdentitySha256
  };
  const closure = canonicalClosure(lookup.resolved, resolvedViews, authority);
  const byPair = new Map(planned.views.map((entry) => [
    `${entry.reference}\0${entry.variant}`, entry.viewKey
  ]));
  const plans = phasePlans.map((plan) => ({
    phase: plan.phase,
    agent: plan.agent,
    orderedViewKeys: plan.entries.map((entry) => byPair.get(entry.pair))
  })).sort((left, right) => compareText(
    `${left.phase}\0${left.agent}`, `${right.phase}\0${right.agent}`
  ));
  const modelObject = retainedBindingObject(lookup.resolved, 'model');
  const views = resolvedViews.map((view) => {
    const bindingObject = retainedBindingObject(view, 'view');
    return {
      reference: `${view.binding.inputs.viewId}@${view.binding.inputs.viewVersion}`,
      variant: view.binding.inputs.variant,
      format: view.binding.inputs.format,
      viewKey: view.binding.viewKey,
      bindingPath: view.bindingPath,
      bindingByteSha256: view.bindingByteSha256,
      bindingRef: bindingObject.ref,
      renderedRef: view.binding.rendered,
      expansionHandle: expansionHandle(view)
    };
  }).sort((left, right) => compareText(
    `${left.reference}\0${left.variant}\0${left.format}`,
    `${right.reference}\0${right.variant}\0${right.format}`
  ));
  return validateStoryWorldModelHistoryPin(sealRecord({
    schemaVersion: currentSchemaVersion(ACTIVATION_KIND),
    kind: ACTIVATION_KIND,
    status: 'active',
    reasonCode: null,
    repositoryDomainSha256: lookup.repositoryDomainSha256,
    sourceRevision: lookup.source.effectiveRevision,
    authority,
    historyDir,
    outputDir,
    model: {
      modelKey: lookup.modelKey,
      bindingPath: lookup.bindingPath,
      bindingByteSha256: lookup.bindingByteSha256,
      bindingRef: modelObject.ref,
      modelPayloadSha256: lookup.resolved.binding.modelPayloadSha256
    },
    views,
    phasePlans: plans,
    composition: { maximumBytes },
    closureSha256: closure.closureSha256
  }, 'pinSha256'));
}

/**
 * Select and prove one exact WMP history cut for a newly-created Story.
 *
 * This operation is read-only. It never turns an exact miss into extraction, rendering, model,
 * AST, cache, fetch, or publication work. Any state-tip movement during the multi-binding read
 * invalidates the candidate and the Story start transaction may be retried against the new tip.
 */
export async function prepareStoryWorldModelHistoryPin(root, {
  definition,
  workflow,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
  approvedConfigurationSnapshot = null,
  resolveModel = resolvePersistedWorldModel,
  resolveView = resolvePersistedWorldModelView,
  resolveCurrentAuthority = configuredWorldModelHistoryAuthorityCut,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority
} = {}) {
  // Story start has already selected and retained one verified sflow/config snapshot, but it has
  // not accepted the Story aggregate yet. Reuse that operation-bound proof for this read-only
  // lookup instead of asking the Story-backed authority resolver for a workflowSnapshot which
  // cannot exist until after this pin is selected. The private snapshot brand is validated by the
  // configuration owner; callers cannot substitute a copied configuration-source record. The
  // recursive call runs under the exact approved read overlay and deliberately drops the proof so
  // there is one bounded selection pass and no fetch, extraction, rendering, or publication.
  if (approvedConfigurationSnapshot) {
    return withStoryConfigurationSnapshotRead(root, approvedConfigurationSnapshot, () => (
      prepareStoryWorldModelHistoryPin(root, {
        definition,
        workflow,
        maximumBytes,
        resolveModel,
        resolveView,
        resolveCurrentAuthority,
        resolveRepositoryAuthority
      })
    ));
  }
  const historyDir = definition?.worldModel?.historyDir ?? DEFAULT_WORLD_MODEL_HISTORY_DIR;
  const outputDir = definition?.worldModel?.outputDir ?? DEFAULT_WORLD_MODEL_OUTPUT_DIR;
  if (definition?.worldModel?.format !== 'registered-v4'
      || workflow?.resolution?.worldModelGrounding === 'off') {
    return unavailablePin('WMP_STORY_ACTIVATION_NOT_CONFIGURED', { historyDir, outputDir });
  }
  const selected = phaseSelectionPlans(definition, workflow);
  if (selected.unsupported.length) {
    // The Story may proceed without this optional accelerator, but it must never activate a
    // partial roster that silently omits a configured view.
    return unavailablePin('WMP_VIEW_SELECTION_UNAVAILABLE', { historyDir, outputDir });
  }
  if (!selected.plans.length || !selected.requiredPairs.length) {
    return unavailablePin('WMP_VIEW_SELECTION_UNAVAILABLE', { historyDir, outputDir });
  }
  if (selected.plans.length > MAXIMUM_PHASE_PLANS) {
    // Never truncate the immutable override roster: doing so would make an accepted agent choice
    // depend on iteration order. Preserve a typed absence instead of blocking Story creation or
    // sealing a partial authority set.
    return unavailablePin('WMP_VIEW_SELECTION_UNAVAILABLE', { historyDir, outputDir });
  }
  try {
    // Match the repository-authority owner: capability source/shared roots are approved scope
    // policy, not merely descriptive capability metadata. Planning from the raw workflow policy
    // here while persisted-model admission planned from the selected delivery produced two valid
    // but different Scope Manifests and made exact approved-history reuse impossible.
    const scopedDefinition = withWorldModelSourceScope(
      definition,
      workflow.resolution?.capability?.sourceScope ?? null
    );
    const scopeConfiguration = {
      definition: scopedDefinition,
      workflow,
      repositoryCapability: workflow.resolution?.capability ?? null
    };
    const planOptions = {
      views: [BUILTIN_VIEW_REFERENCES[0]],
      ...configuredWorldModelV4ScopeOptions(root, scopeConfiguration)
    };
    let plannedModel = planWorldModelV4(root, planOptions);
    if (workflow.workItem?.baseCommit) {
      // A registered source snapshot intentionally identifies the last commit which changed its
      // governed scope. Story start may add an approved configuration-only commit after branching,
      // and an application base can itself contain later out-of-scope governance commits. Requiring
      // the two commit IDs to be equal therefore rejected byte-identical reusable history. Re-read
      // the immutable Story base object through the exact same scope and compare every selected
      // descriptor instead: this admits only an identical application cut, never current working
      // bytes or a model built for a different source tree.
      const baseSource = createExactSourceSnapshotAtRevision(
        root,
        workflow.workItem.baseCommit,
        {
          subjectId: plannedModel.scopeManifest.capabilityId,
          scopeManifest: plannedModel.scopeManifest
        }
      );
      if (canonicalJson(baseSource.files) !== canonicalJson(plannedModel.sourceSnapshot.files)) {
        fail('Story base revision differs from the exact World-Model source revision.',
          'WMP_STORY_SOURCE_REVISION_MISMATCH', {
            expected: workflow.workItem.baseCommit,
            received: plannedModel.sourceSnapshot.revision.commit
          });
      }
      // Equality proves the current scoped bytes have not moved, but the Story must still retain
      // the immutable application-base identity. Re-plan through the ordinary Candidate Snapshot
      // verifier so the preparation key, persisted lookup, and accepted pin all name baseCommit;
      // never let a later configuration-only materialization commit leak into reusable history.
      plannedModel = planWorldModelV4(root, {
        ...planOptions,
        candidateSnapshot: baseSource
      });
    }
    const extractionPolicy = deriveFrozenV1WorldModelExtractionPolicy(
      plannedModel.scopeManifest,
      plannedModel.extractorRegistry,
      plannedModel.extractorReferences
    );
    const preparation = await preparePersistedWorldModelBuild(root, {
      capabilityId: plannedModel.scopeManifest.capabilityId,
      sourceSnapshot: plannedModel.sourceSnapshot,
      scopeManifest: plannedModel.scopeManifest,
      extractionPolicy,
      extractorRegistry: plannedModel.extractorRegistry,
      extractorReferences: plannedModel.extractorReferences,
      requestedRevision: plannedModel.sourceSnapshot.revision.commit,
      resolveRepositoryAuthority
    });
    const lookup = await lookupPersistedWorldModelBeforeExtraction(root, {
      preparation,
      historyDir,
      outputDir,
      resolveModel,
      resolveRepositoryAuthority,
      resolveHistoryAuthority: async (checkout, options) => (
        resolveCurrentAuthority(checkout, definition, options)
      )
    });
    if (lookup.status === 'missing') {
      return unavailablePin('WMP_MODEL_MISSING', { historyDir, outputDir });
    }
    const acceptedModel = {
      binding: lookup.resolved.binding,
      objects: lookup.resolved.closure.map((entry) => ({
        ref: entry.ref, bytes: entry.canonicalBytes, record: entry.record
      }))
    };
    const variants = [...new Set(selected.requiredPairs.map((entry) => entry.variant))];
    const references = [...new Set(selected.requiredPairs.map((entry) => entry.reference))];
    const plannedViews = planPersistedWorldModelViews({
      model: acceptedModel,
      views: references,
      variants,
      format: 'md'
    });
    const requiredPairs = new Set(selected.requiredPairs.map(
      (entry) => `${entry.reference}\0${entry.variant}`
    ));
    const exactPlan = {
      ...plannedViews,
      views: plannedViews.views.filter((entry) => requiredPairs.has(
        `${entry.reference}\0${entry.variant}`
      ))
    };
    if (exactPlan.views.length !== requiredPairs.size) {
      fail('Exact saved-view planning did not cover every configured phase selection.',
        'WMP_VIEW_SELECTION_UNAVAILABLE', {
          required: requiredPairs.size, planned: exactPlan.views.length
        });
    }
    const resolvedViews = [];
    let missingViewCode = null;
    for (const view of exactPlan.views) {
      let resolved;
      try {
        resolved = await resolveView(root, {
          authorityCommit: lookup.authority.commit,
          authorityRef: lookup.authority.ref,
          viewKey: view.viewKey,
          historyDir,
          outputDir
        });
      } catch (error) {
        if (error?.code === 'WMP_VIEW_NOT_MATERIALIZED') {
          missingViewCode = error.code;
          break;
        }
        throw error;
      }
      if (canonicalJson(resolved.binding.inputs) !== canonicalJson(view.inputs)
          || resolved.authorityCommit !== lookup.authority.commit
          || resolved.authorityRef !== lookup.authority.ref) {
        fail('Persisted Story view differs from its exact planned inputs or authority cut.',
          'WMP_LIFECYCLE_CLOSURE_MISMATCH', { viewKey: view.viewKey });
      }
      resolvedViews.push(resolved);
    }
    const refreshedRepository = await resolveRepositoryAuthority(root, {
      capabilityId: plannedModel.scopeManifest.capabilityId
    });
    if (canonicalJson(refreshedRepository.repositoryDomain)
          !== canonicalJson(preparation.repositoryDomain)
        || canonicalJson(refreshedRepository.repositoryIdentityAuthority)
          !== canonicalJson(preparation.repositoryIdentityAuthority)
        || canonicalJson(refreshedRepository.scopeManifest)
          !== canonicalJson(plannedModel.scopeManifest)) {
      fail('Repository authority changed while selecting Story World-Model history.',
        'WMP_REPOSITORY_AUTHORITY_CHANGED');
    }
    const finalAuthority = await resolveCurrentAuthority(root, definition, {
      expectedRepositoryIdentitySha256: lookup.authority.repositoryIdentitySha256
    });
    if (!compareAuthority(lookup.authority, finalAuthority)) {
      fail('World-Model state authority changed while selecting the Story history cut.',
        'WMP_REPOSITORY_AUTHORITY_CHANGED', {
          before: lookup.authority, after: finalAuthority
        });
    }
    if (missingViewCode) {
      return unavailablePin(missingViewCode, { historyDir, outputDir });
    }
    return initialPinRecord({
      workflow, lookup, planned: exactPlan, resolvedViews,
      phasePlans: selected.plans, historyDir, outputDir, maximumBytes
    });
  } catch (error) {
    if (INITIAL_UNAVAILABLE_CODES.has(error?.code)) {
      return unavailablePin(error.code, { historyDir, outputDir });
    }
    throw error;
  }
}

function assertPinMatchesResolved(pin, model, views) {
  const modelObject = retainedBindingObject(model, 'model');
  if (model.bindingPath !== pin.model.bindingPath
      || model.bindingByteSha256 !== pin.model.bindingByteSha256
      || canonicalJson(modelObject.ref) !== canonicalJson(pin.model.bindingRef)
      || model.binding.modelKey !== pin.model.modelKey
      || model.binding.modelPayloadSha256 !== pin.model.modelPayloadSha256) {
    fail('Pinned Story model differs from the exact history binding.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
  const pinned = new Map(pin.views.map((entry) => [entry.viewKey, entry]));
  for (const view of views) {
    const expected = pinned.get(view.binding.viewKey);
    const bindingObject = retainedBindingObject(view, 'view');
    if (!expected || expected.bindingPath !== view.bindingPath
        || expected.bindingByteSha256 !== view.bindingByteSha256
        || canonicalJson(expected.bindingRef) !== canonicalJson(bindingObject.ref)
        || canonicalJson(expected.renderedRef) !== canonicalJson(view.binding.rendered)
        || expected.expansionHandle !== expansionHandle(view)) {
      fail('Pinned Story view differs from the exact history binding.',
        'WMP_LIFECYCLE_PIN_MISMATCH', { viewKey: view.binding.viewKey });
    }
  }
  const closure = canonicalClosure(model, views, pin.authority);
  if (closure.closureSha256 !== pin.closureSha256) {
    fail('Pinned Story World-Model closure differs from the exact history cut.',
      'WMP_LIFECYCLE_CLOSURE_MISMATCH');
  }
}

/** Re-resolve an accepted Story pin and compose one exact generation packet. */
export async function resolvePinnedStoryWorldModelGrounding(root, {
  definition,
  workflow,
  phase,
  agent,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority,
  resolveCurrentAuthority = configuredWorldModelHistoryAuthorityCut,
  admitHistoryCut = resolveWorldModelHistoryAuthority,
  resolveModel = resolvePersistedWorldModel,
  resolveView = resolvePersistedWorldModelView
} = {}) {
  const pin = validateStoryWorldModelHistoryPin(
    workflow?.resolution?.worldModelHistoryPin
  );
  if (pin.status !== 'active') return deepFreeze({
    status: 'unavailable', authorityProven: false, reasonCode: pin.reasonCode
  });
  const phasePlans = pin.phasePlans.filter((entry) => entry.phase === phase?.id);
  const selected = phasePlans.find((entry) => entry.agent === agent);
  if (!selected) {
    // The accepted roster may contain phases (or selectable agents) with no configured persisted
    // projection. Preserve that immutable absence and never fall back to another agent's plan or
    // mutable current World-Model state. Prompt receipt admission applies only when this exact
    // phase/agent pair has a plan.
    return deepFreeze({
      status: 'unavailable', authorityProven: false,
      reasonCode: 'WMP_VIEW_SELECTION_UNAVAILABLE'
    });
  }
  const repository = await resolveRepositoryAuthority(root, {
    capabilityId: workflow.resolution?.capability?.id ?? null,
    pinnedCapabilityResolution:
      workflow.resolution?.capability?.effectiveResolution ?? null
  });
  if (repository.repositoryDomain.repositoryDomainSha256 !== pin.repositoryDomainSha256
      || (pin.authority.repositoryIdentitySha256 !== null
        && repository.repositoryDomain.repositoryIdentitySha256
          !== pin.authority.repositoryIdentitySha256)) {
    fail('Current accepted Story repository authority differs from its World-Model pin.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
  const current = await resolveCurrentAuthority(root, definition, {
    expectedRepositoryIdentitySha256: pin.authority.repositoryIdentitySha256
  });
  if (current.ref !== pin.authority.stateRef
      || current.repositoryIdentitySha256 !== pin.authority.repositoryIdentitySha256) {
    fail('Configured state authority endpoint differs from the accepted Story pin.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
  if (typeof admitHistoryCut !== 'function') {
    fail('Story grounding requires the installed history-cut admission owner.');
  }
  await admitHistoryCut(root, pin.authority.authorityCommit, {
    authorityRef: pin.authority.stateRef
  });
  const model = await resolveModel(root, {
    authorityCommit: pin.authority.authorityCommit,
    authorityRef: pin.authority.stateRef,
    modelKey: pin.model.modelKey,
    historyDir: pin.historyDir,
    outputDir: pin.outputDir
  });
  const views = [];
  for (const entry of pin.views) {
    views.push(await resolveView(root, {
      authorityCommit: pin.authority.authorityCommit,
      authorityRef: pin.authority.stateRef,
      viewKey: entry.viewKey,
      historyDir: pin.historyDir,
      outputDir: pin.outputDir
    }));
  }
  assertPinMatchesResolved(pin, model, views);
  const finalRepository = await resolveRepositoryAuthority(root, {
    capabilityId: workflow.resolution?.capability?.id ?? null,
    pinnedCapabilityResolution:
      workflow.resolution?.capability?.effectiveResolution ?? null
  });
  if (canonicalJson(finalRepository) !== canonicalJson(repository)) {
    fail('Accepted Story repository authority changed while resolving pinned grounding.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED');
  }
  const finalAuthority = await resolveCurrentAuthority(root, definition, {
    expectedRepositoryIdentitySha256: pin.authority.repositoryIdentitySha256
  });
  if (finalAuthority.ref !== pin.authority.stateRef
      || finalAuthority.repositoryIdentitySha256
        !== pin.authority.repositoryIdentitySha256) {
    fail('Configured state authority endpoint changed while resolving pinned grounding.',
      'WMP_REPOSITORY_AUTHORITY_CHANGED');
  }
  await admitHistoryCut(root, pin.authority.authorityCommit, {
    authorityRef: pin.authority.stateRef
  });
  const savedViews = savedViewsFromResolved(model, views);
  const packet = preparePersistedStoryGrounding({
    activation: 'story',
    savedViews,
    viewKeys: selected.orderedViewKeys,
    subject: {
      repositoryDomainSha256: pin.repositoryDomainSha256,
      workId: workflow.workItem.id,
      workflowInstanceId: workflow.workflowSnapshot?.snapshotHash,
      phase: phase.id,
      generation: Number(phase.generation ?? 0) + 1
    },
    authority: {
      repositoryDomainSha256: pin.repositoryDomainSha256,
      stateRef: pin.authority.stateRef,
      authorityCommit: pin.authority.authorityCommit,
      repositoryIdentitySha256: pin.authority.repositoryIdentitySha256
    },
    maximumBytes: pin.composition.maximumBytes,
    workItemRoot: definition.workItemRoot ?? 'singularity/work-items'
  });
  const result = deepFreeze({
    ...packet,
    authorityProven: true,
    pinSha256: pin.pinSha256,
    content: packet.files.find((entry) => entry.path.endsWith('.md'))?.content ?? '',
    execution: {
      ...packet.execution,
      modelReads: 1,
      viewReads: views.length
    }
  });
  LIFECYCLE_PROVEN_GROUNDINGS.add(result);
  return result;
}

export async function assertPinnedStoryWorldModelHistoryAuthority(root, {
  definition,
  workflow,
  resolveRepositoryAuthority = resolveWorldModelRepositoryIdentityAuthority,
  resolveCurrentAuthority = configuredWorldModelHistoryAuthorityCut,
  admitHistoryCut = resolveWorldModelHistoryAuthority
} = {}) {
  if (!definition || !workflow) {
    fail('Story World-Model authority proof requires its accepted definition and workflow.',
      'WMP_LIFECYCLE_PIN_INVALID');
  }
  const pin = validateStoryWorldModelHistoryPin(
    workflow.resolution?.worldModelHistoryPin
  );
  if (pin.status !== 'active') {
    fail('Story World-Model authority proof requires an accepted active history pin.',
      'WMP_LIFECYCLE_PIN_INVALID');
  }
  const repository = await resolveRepositoryAuthority(root, {
    capabilityId: workflow.resolution?.capability?.id ?? null,
    pinnedCapabilityResolution:
      workflow.resolution?.capability?.effectiveResolution ?? null
  });
  if (repository.repositoryDomain.repositoryDomainSha256 !== pin.repositoryDomainSha256
      || (pin.authority.repositoryIdentitySha256 !== null
        && repository.repositoryDomain.repositoryIdentitySha256
          !== pin.authority.repositoryIdentitySha256)) {
    fail('Current accepted Story repository authority differs from its World-Model pin.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
  const current = await resolveCurrentAuthority(root, definition, {
    expectedRepositoryIdentitySha256: pin.authority.repositoryIdentitySha256
  });
  if (current.ref !== pin.authority.stateRef
      || current.repositoryIdentitySha256 !== pin.authority.repositoryIdentitySha256) {
    fail('Configured state authority endpoint differs from the accepted Story pin.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
  if (typeof admitHistoryCut !== 'function') {
    fail('Story grounding persistence requires the installed history-cut admission owner.');
  }
  await admitHistoryCut(root, pin.authority.authorityCommit, {
    authorityRef: pin.authority.stateRef
  });
  return pin;
}

export function persistedStoryWorldModelGroundingReceipt(resolved) {
  if (resolved?.status !== 'composed' || resolved.authorityProven !== true
      || !LIFECYCLE_PROVEN_GROUNDINGS.has(resolved)) {
    fail('Persisted Story grounding receipt requires the in-process lifecycle proof owner.',
      'WMP_LIFECYCLE_PIN_INVALID');
  }
  return deepFreeze({
    activation: 'story',
    pinSha256: resolved.pinSha256,
    groundingSha256: resolved.packet.groundingSha256,
    packetRef: structuredClone(resolved.packetRef),
    renderedBlock: structuredClone(resolved.renderedBlock),
    authority: structuredClone(resolved.packet.authority),
    files: resolved.files.map(({ content: _content, ...file }) => ({ ...file }))
  });
}

export function assertPinnedStoryWorldModelGroundingReplay(
  resolved, { receipt, promptText } = {}
) {
  const expected = persistedStoryWorldModelGroundingReceipt(resolved);
  const text = String(promptText ?? '');
  let occurrences = 0;
  let offset = 0;
  while (resolved.content && (offset = text.indexOf(resolved.content, offset)) !== -1) {
    occurrences += 1;
    offset += resolved.content.length;
  }
  if (canonicalJson(receipt) !== canonicalJson(expected) || occurrences !== 1) {
    fail('Recorded prompt grounding differs from the exact closure pinned by this Story.',
      'WMP_GROUNDING_REPLAY_MISMATCH', {
        groundingSha256: expected.groundingSha256,
        occurrences
      });
  }
  return expected;
}

async function revalidatePinnedStoryWorldModelGroundingAuthority(root, resolved, options = {}) {
  const pin = await assertPinnedStoryWorldModelHistoryAuthority(root, options);
  if (resolved.pinSha256 !== pin.pinSha256) {
    fail('Story grounding persistence differs from its accepted active history pin.',
      'WMP_LIFECYCLE_PIN_MISMATCH');
  }
}

/** Create content-addressed packet files once; an existing non-identical file is never replaced. */
export async function persistPinnedStoryWorldModelGrounding(root, resolved, options = {}) {
  if (resolved?.status !== 'composed' || resolved.authorityProven !== true) {
    fail('Only lifecycle-proven Story grounding may be persisted.');
  }
  if (!LIFECYCLE_PROVEN_GROUNDINGS.has(resolved)) {
    fail('Story grounding persistence requires the in-process lifecycle proof owner.',
      'WMP_LIFECYCLE_PIN_INVALID');
  }
  // Prompt construction can take long enough for the configured state ref to move. Re-prove the
  // repository identity, authority endpoint, and pinned-cut ancestry at the durable publication
  // boundary rather than relying on the earlier composition-time proof.
  await revalidatePinnedStoryWorldModelGroundingAuthority(root, resolved, options);
  const directories = new Map();
  for (const file of resolved.files) {
    const relative = path.posix.dirname(file.path);
    if (!directories.has(relative)) {
      directories.set(relative, await ensureSecureRepositoryDirectory(root, relative, {
        label: 'Persisted Story grounding directory'
      }));
    }
  }
  for (const file of resolved.files) {
    // Resolve the governed target only after its directory has passed both sides of secure mkdir.
    // A pre-existing final symlink or symlinked ancestor is rejected before any packet byte is
    // created. EEXIST is re-resolved with the same no-symlink rule before bytes are compared.
    const target = await secureRepositoryPath(root, file.path, {
      label: 'Persisted Story grounding file'
    });
    const expected = Buffer.from(file.content, 'utf8');
    const assertIdentical = async () => {
      const occupied = await secureRepositoryPath(root, file.path, {
        label: 'Persisted Story grounding file', mustExist: true, type: 'file'
      });
      const current = await readFile(occupied.absolute);
      if (!current.equals(expected)) {
        fail(`Existing Story grounding file differs at '${file.path}'.`,
          'WMP_IDENTITY_CONFLICT', { path: file.path });
      }
    };
    // Packet identities bind these exact bytes. Publish create-only: a concurrent occupied path or
    // symlink wins the race and is accepted only when its bytes are exactly identical.
    try { await writeAtomicExclusive(target.absolute, expected); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await assertIdentical();
    }
    // Detect an ancestor replacement during publication before the file can become authoritative.
    await secureRepositoryPath(root, directories.get(path.posix.dirname(file.path)).relative, {
      label: 'Persisted Story grounding directory', mustExist: true, type: 'directory'
    });
    await assertIdentical();
  }
  // A rewind or unrelated ref replacement during the multi-file write may leave harmless orphaned
  // content-addressed bytes, but it must never receive a prompt receipt. Re-prove immediately before
  // returning to the receipt publisher.
  await revalidatePinnedStoryWorldModelGroundingAuthority(root, resolved, options);
  return resolved.files.map(({ content, ...entry }) => entry);
}

export const STORY_WORLD_MODEL_HISTORY_PIN_KIND = ACTIVATION_KIND;

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { branch as currentBranch, repoRoot } from '../git.mjs';
import { runDraftTransaction } from '../draft-unit-of-work.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import {
  evaluateArchitectureIntentEvidence, resolveArchitectureIntentBase
} from '../architecture-intent-service.mjs';
import {
  ensureSecureRepositoryDirectory, exists, optionBoolean, optionString, requirePositional,
  secureRepositoryPath, SingularityFlowError, writeAtomic
} from '../util.mjs';
import { canonicalJson, compareText, sha256 } from '../world-model/canonicalize.mjs';
import { worldModelStateAuthority } from '../world-model/authority-config.mjs';
import {
  createArchitectureIntent,
  explainArchitectureElement, renderPlannedArchitecture, validateArchitectureIntent,
  validateArchitectureIntentFulfilment, validateCalmProjection
} from '../world-model/projections/calm/projection.mjs';
import {
  assertCurrentArchitectureProjection, resolveCurrentArchitectureProjectionInputs
} from '../world-model/projections/calm/authority.mjs';
import { validateCalmWithOfficialToolchain } from '../world-model/projections/calm/validator.mjs';
import { resolvePublishedWorldModelV4 } from '../world-model/store.mjs';
import { assertApprovedArchitectureIntent } from '../architecture-intent-gate.mjs';

const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function workId(value) {
  const normalized = String(value ?? '').trim();
  if (!WORK_ID.test(normalized)) fail('Architecture intent requires a safe Work ID.', 'WMC_INTENT_INVALID');
  return normalized;
}

function architectureRelativeDirectory(definition, id) {
  return path.posix.join(
    definition.workItemRoot ?? 'singularity/work-items', workId(id), 'context', 'architecture'
  );
}

async function architectureDirectory(root, definition, id, { create = false } = {}) {
  const relative = architectureRelativeDirectory(definition, id);
  const located = create
    ? await ensureSecureRepositoryDirectory(root, relative, { label: 'Story architecture directory' })
    : await secureRepositoryPath(root, relative, {
        label: 'Story architecture directory', mustExist: true, type: 'directory'
      });
  return located.absolute;
}

async function safeOutput(root, value, {
  mustExist = false, type = null, governedOutputDir = 'singularity/world-model'
} = {}) {
  const supplied = String(value ?? '').trim().replaceAll('\\', '/');
  const governed = String(governedOutputDir ?? 'singularity/world-model')
    .trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!supplied || path.posix.isAbsolute(supplied) || /^[A-Za-z]:\//.test(supplied)
      || supplied.split('/').includes('..')
      || supplied === governed || supplied.startsWith(`${governed}/`)) {
    fail('CALM export target must be a repository-relative path outside governed World-Model authority.',
      'WMC_EXPORT_TARGET_UNSAFE', { target: supplied || null });
  }
  const located = await secureRepositoryPath(root, supplied, {
    label: 'CALM repository path', mustExist, type
  });
  return located.absolute;
}

async function baseProjection(root, definition = null, { workflow = null } = {}) {
  definition ??= await loadDefinition(root);
  const authority = worldModelStateAuthority(definition, {});
  const store = resolvePublishedWorldModelV4(root, {
    outputDir: definition.worldModel?.outputDir ?? 'singularity/world-model',
    stateBranch: authority.branch, remote: authority.remote
  });
  // A Story consumes the configuration authority already sealed into the reusable projection.
  // Its saved execution definition is compared against those exact bytes; today's workflow.yml
  // is neither read nor allowed to stale an accepted Story after a configuration refresh.
  const inputs = await resolveCurrentArchitectureProjectionInputs(root, definition, {
    configurationSourceSha256: workflow
      ? store.records?.configurationSnapshot?.source?.sha256 ?? null
      : null
  });
  assertCurrentArchitectureProjection(store, inputs);
  const built = store.projections?.find((entry) => entry.projectionId === 'arch.calm');
  if (!built || built.status !== 'available') {
    fail('The reusable state authority does not contain an available arch.calm projection.',
      'WMC_PROJECTION_NOT_CONFIGURED', {
        nextAction: 'singularity-flow wm build --projections arch.calm'
      });
  }
  return { definition, store, built, inputs };
}

async function readIntent(root, definition, id) {
  const target = path.join(
    await architectureDirectory(root, definition, id), 'architecture-intent.json'
  );
  let parsed;
  try { parsed = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) {
    fail(`Architecture intent for '${id}' is unavailable: ${error.message}`, 'WMC_INTENT_INVALID', { path: target });
  }
  return { target, intent: validateArchitectureIntent(parsed) };
}

async function selectedProjection(root, options, suppliedDefinition = null) {
  let definition = suppliedDefinition ?? await loadDefinition(root);
  let workflow = null;
  let id = null;
  if (optionBoolean(options, 'planned')) {
    id = workId(optionString(options, 'work-id'));
    const accepted = await loadAcceptedStoryExecution(root, id);
    definition = accepted.definition;
    workflow = accepted.workflow;
  }
  const base = await baseProjection(root, definition, { workflow });
  if (!optionBoolean(options, 'planned')) return { ...base, selected: base.built, planned: false };
  const { target, intent } = await readIntent(root, definition, id);
  await assertApprovedArchitectureIntent(root, definition, workflow, intent, target);
  const selected = renderPlannedArchitecture({
    projection: base.built.projection,
    projectionSha256: base.built.projectionSha256,
    worldModelManifestSha256: base.store.manifest.manifestSha256,
    intent
  });
  return { ...base, selected, planned: true, workId: id, intent };
}

function summary(value) {
  const projection = value.selected.projection;
  const unavailable = value.built.factSet.unavailable.length;
  const contradictions = value.built.factSet.contradictions.length;
  return {
    schemaVersion: 1,
    kind: 'architecture-projection-summary',
    projection: value.planned ? 'arch.calm.planned' : 'arch.calm',
    projectionSha256: value.selected.projectionSha256,
    worldModelManifestSha256: value.store.manifest.manifestSha256,
    sourceManifestSha256: value.store.manifest.sourceManifestSha256,
    stateAuthorityCommit: value.store.commit,
    validation: 'passed',
    counts: {
      nodes: projection.nodes.length,
      relationships: projection.relationships.length,
      interfaces: projection.nodes.reduce((sum, node) => sum + (node.interfaces?.length ?? 0), 0),
      controls: Object.keys(projection.controls).length,
      flows: projection.flows.length,
      unavailable,
      contradictions
    },
    topLevel: projection.nodes
      .filter((node) => !projection.relationships.some((relationship) =>
        relationship['relationship-type']?.['composed-of']?.nodes?.includes(node['unique-id'])))
      .map((node) => ({ id: node['unique-id'], type: node['node-type'], name: node.name }))
  };
}

export function createArchitectureExportPlan({ target, projectionSha256, planned = false }) {
  const plan = {
    schemaVersion: 1, kind: 'architecture-export-plan', target,
    projectionSha256, planned: planned === true,
    effects: ['create-one-repository-file', 'leave-world-model-authority-unchanged']
  };
  return Object.freeze({ ...plan, planSha256: sha256(plan) });
}

function architectureElements(projection) {
  return [
    ...projection.nodes.map((value) => ({ kind: 'node', id: value['unique-id'], value })),
    ...projection.nodes.flatMap((node) => (node.interfaces ?? []).map((value) => ({
      kind: 'interface', id: value['unique-id'], value: { owner: node['unique-id'], ...value }
    }))),
    ...projection.relationships.map((value) => ({
      kind: 'relationship', id: value['unique-id'], value
    })),
    ...Object.entries(projection.controls).map(([id, value]) => ({ kind: 'control', id, value })),
    ...projection.flows.map((value) => ({ kind: 'flow', id: value['unique-id'], value }))
  ];
}

export function architectureProjectionDiff(from, to) {
  validateCalmProjection(from);
  validateCalmProjection(to);
  const before = new Map(architectureElements(from).map((entry) => [`${entry.kind}/${entry.id}`, entry]));
  const after = new Map(architectureElements(to).map((entry) => [`${entry.kind}/${entry.id}`, entry]));
  const added = []; const removed = []; const changed = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(compareText)) {
    const left = before.get(key); const right = after.get(key);
    const identity = { kind: (left ?? right).kind, id: (left ?? right).id };
    if (!left) added.push(identity);
    else if (!right) removed.push(identity);
    else if (canonicalJson(left.value) !== canonicalJson(right.value)) changed.push(identity);
  }
  return Object.freeze({
    identical: !added.length && !removed.length && !changed.length,
    added: Object.freeze(added), removed: Object.freeze(removed), changed: Object.freeze(changed)
  });
}

function printSummary(value) {
  console.log(`Architecture ${value.projection}: ${value.validation}`);
  console.log(`Projection: ${value.projectionSha256}`);
  console.log(`World model: ${value.worldModelManifestSha256}`);
  console.log(`Nodes ${value.counts.nodes} · relationships ${value.counts.relationships}`
    + ` · interfaces ${value.counts.interfaces} · controls ${value.counts.controls}`);
  console.log(`Contradictions ${value.counts.contradictions} · unavailable ${value.counts.unavailable}`);
  if (value.topLevel.length) {
    console.log('\nTop-level architecture');
    for (const item of value.topLevel) console.log(`  ${item.id} · ${item.type} · ${item.name}`);
  }
  console.log('\nExpand safely: singularity-flow architecture explain <ELEMENT-ID>');
}

const INTENT_CANDIDATE_KEYS = new Set(['phase', 'generation', 'clauses']);
const INTENT_SHA256 = /^sha256:[a-f0-9]{64}$/;

export function architectureIntentTargetGeneration(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase || !Number.isSafeInteger(phase.generation) || phase.generation < 0) {
    fail(`Architecture intent phase '${phaseId ?? 'missing'}' has no valid published generation.`,
      'WMC_INTENT_PHASE_INVALID');
  }
  return phase.generation + 1;
}

export function validateArchitectureIntentLifecyclePolicy(workflow, policy, ownerPhaseId) {
  const ownerIndex = workflow?.phaseOrder?.indexOf(ownerPhaseId) ?? -1;
  if (ownerIndex < 0 || !policy?.allowedPhases?.includes(ownerPhaseId)) {
    fail(
      `Architecture intent phase '${ownerPhaseId ?? 'missing'}' is not allowed by the pinned Story policy.`,
      'WMC_INTENT_PHASE_INVALID'
    );
  }
  const invalid = (policy.blockRequiredUnfulfilledAt ?? []).find((phaseId) => {
    const index = workflow.phaseOrder.indexOf(phaseId);
    return index < 0 || index <= ownerIndex;
  });
  if (invalid) {
    fail(
      `Architecture intent policy cannot enforce phase '${invalid}' before or at its owner phase '${ownerPhaseId}'.`,
      'WMC_INTENT_POLICY_INVALID',
      { ownerPhase: ownerPhaseId, enforcingPhase: invalid }
    );
  }
  return true;
}

export function normalizeArchitectureIntentCandidate(
  candidate, workflow, policy, { expectedOwnerPhase = null } = {}
) {
  if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('Architecture intent candidate must be a JSON object.', 'WMC_INTENT_INVALID');
  }
  const unknown = Object.keys(candidate).filter((key) => !INTENT_CANDIDATE_KEYS.has(key));
  if (unknown.length) {
    fail(
      `Architecture intent candidate contains unsupported field(s): ${unknown.sort().join(', ')}.`,
      'WMC_INTENT_INVALID', { unknownFields: unknown.sort() }
    );
  }
  if (typeof candidate.phase !== 'string' || !candidate.phase) {
    fail('Architecture intent candidate requires phase.', 'WMC_INTENT_PHASE_INVALID');
  }
  if (expectedOwnerPhase && candidate.phase !== expectedOwnerPhase) {
    fail(
      `Architecture intent revision cannot change owner phase '${expectedOwnerPhase}' to '${candidate.phase}'.`,
      'WMC_INTENT_PHASE_INVALID'
    );
  }
  validateArchitectureIntentLifecyclePolicy(workflow, policy, candidate.phase);
  const ownerPhase = workflow.phases[candidate.phase];
  if (workflow.currentPhase !== candidate.phase || ownerPhase.status !== 'in_progress') {
    fail(
      `Phase '${candidate.phase}' is not the currently authorable Story phase. Reopen it through the normal lifecycle before changing its architecture intent.`,
      'WMC_INTENT_GENERATION_CLOSED',
      { currentPhase: workflow.currentPhase, phaseStatus: ownerPhase.status }
    );
  }
  const generation = architectureIntentTargetGeneration(workflow, candidate.phase);
  if (candidate.generation !== undefined
      && (!Number.isSafeInteger(candidate.generation) || candidate.generation < 1
        || candidate.generation !== generation)) {
    fail(
      `Architecture intent generation ${JSON.stringify(candidate.generation)} does not match the next '${candidate.phase}' publication generation ${generation}.`,
      'WMC_INTENT_GENERATION_STALE',
      {
        phase: candidate.phase,
        currentPublishedGeneration: ownerPhase.generation,
        expectedGeneration: generation,
        suppliedGeneration: candidate.generation ?? null
      }
    );
  }
  if (!Array.isArray(candidate.clauses)) {
    fail('Architecture intent candidate requires a clauses array.', 'WMC_INTENT_INVALID');
  }
  return { phase: candidate.phase, generation, clauses: candidate.clauses };
}

async function readIntentCandidateSource(root, definition, from) {
  if (!from) fail('Architecture intent requires --from <reviewed-json-file>.', 'WMC_INTENT_INVALID');
  const source = await safeOutput(root, from, {
    mustExist: true, type: 'file', governedOutputDir: definition.worldModel?.outputDir
  });
  let bytes;
  let candidate;
  try {
    bytes = await readFile(source, 'utf8');
    candidate = JSON.parse(bytes);
  } catch (error) {
    fail(`Cannot read architecture intent candidate: ${error.message}`, 'WMC_INTENT_INVALID');
  }
  return { source, bytes, sourceSha256: sha256(Buffer.from(bytes, 'utf8')), candidate };
}

async function writeIntentDraft(root, definition, workflow, policy, {
  action, id, from, expectIntent = null
}) {
  const source = await readIntentCandidateSource(root, definition, from);
  const initial = normalizeArchitectureIntentCandidate(source.candidate, workflow, policy);
  if (action === 'revise' && !INTENT_SHA256.test(expectIntent ?? '')) {
    fail(
      'Architecture intent revise requires --expect-intent sha256:<current-intent-digest>.',
      'WMC_INTENT_REVISION_CONFLICT'
    );
  }
  const targetRelative = path.posix.join(
    architectureRelativeDirectory(definition, id), 'architecture-intent.json'
  );
  const target = path.join(root, targetRelative);
  if (path.resolve(source.source) === path.resolve(target)) {
    fail('Architecture intent candidate source must be different from the managed intent path.',
      'WMC_INTENT_INVALID');
  }
  const expectedRevision = workflow[Symbol.for('singularity-flow.state-revision')] ?? null;
  return runDraftTransaction(root, {
    subject: { kind: 'story', id, branch: expectedRevision?.branch ?? currentBranch(root) },
    expectedRevision,
    allowedPaths: [targetRelative],
    operation: `architecture-intent-${action}`,
    write: async () => {
      const currentSourceBytes = await readFile(source.source, 'utf8').catch((error) => {
        fail(`Architecture intent candidate changed or disappeared: ${error.message}`,
          'WMC_INTENT_REVISION_CONFLICT');
      });
      if (currentSourceBytes !== source.bytes
          || sha256(Buffer.from(currentSourceBytes, 'utf8')) !== source.sourceSha256) {
        fail('Architecture intent candidate changed before the guarded write.',
          'WMC_INTENT_REVISION_CONFLICT');
      }
      const currentWorkflow = await loadStoryAggregate(root, definition, id);
      const currentPolicy = currentWorkflow.resolution?.architectureIntent
        ?? definition.architectureIntent ?? {};
      const targetExists = await exists(target);
      const existing = targetExists ? await readIntent(root, definition, id) : null;
      if (!existing && action === 'revise') {
        fail('Architecture intent revise requires an existing valid intent.',
          'WMC_INTENT_REVISION_CONFLICT');
      }
      const normalized = normalizeArchitectureIntentCandidate(source.candidate, currentWorkflow, currentPolicy, {
        expectedOwnerPhase: action === 'revise' ? existing.intent.phase : null
      });
      const base = await baseProjection(root, definition, { workflow: currentWorkflow });
      const intent = createArchitectureIntent({
        workId: id,
        phase: normalized.phase,
        generation: normalized.generation,
        base: {
          worldModelManifestSha256: base.store.manifest.manifestSha256,
          calmProjectionSha256: base.built.projectionSha256
        },
        clauses: normalized.clauses
      });
      if (existing) {
        if (action === 'revise' && existing.intent.intentSha256 !== expectIntent) {
          fail(
            'Architecture intent changed after it was reviewed for revision.',
            'WMC_INTENT_REVISION_CONFLICT',
            {
              expectedIntentSha256: expectIntent,
              currentIntentSha256: existing.intent.intentSha256,
              nextAction: `Review the current intent and retry with --expect-intent ${existing.intent.intentSha256}.`
            }
          );
        }
        if (canonicalJson(existing.intent) === canonicalJson(intent)) {
          return { status: 'existing', intent, target: existing.target };
        }
        if (action === 'init') {
          fail(
            `A different architecture intent already exists for Story '${id}'. Use the guarded revise operation.`,
            'WMC_INTENT_ALREADY_EXISTS',
            {
              currentIntentSha256: existing.intent.intentSha256,
              nextAction: `singularity-flow architecture intent revise --work-id ${id} --from ${from} --expect-intent ${existing.intent.intentSha256}`
            }
          );
        }
      }
      await architectureDirectory(root, definition, id, { create: true });
      await writeAtomic(target, canonicalJson(intent), { mode: 0o600 });
      return { status: action === 'revise' ? 'revised' : 'created', intent, target };
    },
    validate: async (written) => {
      const stored = await readIntent(root, definition, id);
      if (stored.intent.intentSha256 !== written.intent.intentSha256
          || canonicalJson(stored.intent) !== canonicalJson(written.intent)) {
        fail('Architecture intent changed during its guarded write.',
          'WMC_INTENT_REVISION_CONFLICT');
      }
    }
  }).then(({ status, intent, target: resultTarget }) => ({
    status,
    workId: id,
    phase: initial.phase,
    generation: intent.generation,
    path: path.relative(root, resultTarget).replaceAll('\\', '/'),
    intentSha256: intent.intentSha256
  }));
}

async function intentCommand(root, positionals, options, json) {
  const action = positionals[2] ?? 'validate';
  const id = workId(optionString(options, 'work-id') ?? positionals[3]);
  const accepted = await loadAcceptedStoryExecution(root, id);
  const definition = accepted.definition;
  const workflow = accepted.workflow;
  const intentPolicy = workflow.resolution?.architectureIntent ?? definition.architectureIntent ?? {};
  if (intentPolicy.enabled !== true) {
    fail(`Architecture intent is disabled for Story '${id}'.`, 'WMC_INTENT_DISABLED');
  }
  if (action === 'init' || action === 'revise') {
    const result = await writeIntentDraft(root, definition, workflow, intentPolicy, {
      action,
      id,
      from: optionString(options, 'from'),
      expectIntent: optionString(options, 'expect-intent')
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(
      `Architecture intent ${result.status}: ${result.path}\n${result.intentSha256}\n`
      + `It targets ${result.phase} generation ${result.generation} and is not approved; publish it through the normal Story phase.`
    );
    return result;
  }
  const { target, intent } = await readIntent(root, definition, id);
  if (action === 'validate') {
    const result = { status: 'valid', workId: id, path: path.relative(root, target), intentSha256: intent.intentSha256 };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`Architecture intent: valid\n${result.intentSha256}`);
    return result;
  }
  await assertApprovedArchitectureIntent(root, definition, workflow, intent, target);
  if (action === 'render') {
    const directory = await architectureDirectory(root, definition, id);
    const projectionTarget = path.join(directory, 'arch.calm.planned.json');
    const receiptTarget = path.join(directory, 'planned-projection-receipt.json');
    const expectedIntentSha256 = intent.intentSha256;
    const expectedRevision = workflow[Symbol.for('singularity-flow.state-revision')] ?? null;
    const planned = await runDraftTransaction(root, {
      subject: {
        kind: 'story', id,
        branch: expectedRevision?.branch ?? currentBranch(root)
      },
      expectedRevision,
      allowedPaths: [projectionTarget, receiptTarget].map((file) =>
        path.relative(root, file).replaceAll('\\', '/')),
      operation: 'architecture-intent-render',
      write: async () => {
        // Approval and intent identity are re-read after acquiring the Story lock. The preimage
        // transaction restores both outputs if validation or either atomic replacement fails.
        const currentWorkflow = await loadStoryAggregate(root, definition, id);
        const currentIntent = await readIntent(root, definition, id);
        if (currentIntent.intent.intentSha256 !== expectedIntentSha256) {
          fail(
            'Architecture intent changed before deterministic rendering completed.',
            'WMC_INTENT_REVISION_CONFLICT',
            {
              expectedIntentSha256,
              currentIntentSha256: currentIntent.intent.intentSha256,
              nextAction: `Review the current intent and rerun singularity-flow architecture intent render --work-id ${id}.`
            }
          );
        }
        await assertApprovedArchitectureIntent(
          root, definition, currentWorkflow, currentIntent.intent, currentIntent.target
        );
        const base = await baseProjection(root, definition, { workflow: currentWorkflow });
        const rendered = renderPlannedArchitecture({
          projection: base.built.projection,
          projectionSha256: base.built.projectionSha256,
          worldModelManifestSha256: base.store.manifest.manifestSha256,
          intent: currentIntent.intent
        });
        await validateCalmWithOfficialToolchain(rendered.projection);
        await writeAtomic(projectionTarget, canonicalJson(rendered.projection), { mode: 0o600 });
        await writeAtomic(receiptTarget, canonicalJson(rendered.receipt), { mode: 0o600 });
        return rendered;
      },
      validate: async (written) => {
        // Re-observe the approval, intent and reusable base after both replacements. Editors and
        // state-ref refreshes are outside the Story lock, so pair equality alone is not enough.
        const currentWorkflow = await loadStoryAggregate(root, definition, id);
        const currentIntent = await readIntent(root, definition, id);
        if (currentIntent.intent.intentSha256 !== expectedIntentSha256) {
          fail(
            'Architecture intent changed while its planned projection was being rendered.',
            'WMC_INTENT_REVISION_CONFLICT'
          );
        }
        await assertApprovedArchitectureIntent(
          root, definition, currentWorkflow, currentIntent.intent, currentIntent.target
        );
        const currentBase = await baseProjection(root, definition, { workflow: currentWorkflow });
        const storedProjectionBytes = await readFile(projectionTarget, 'utf8');
        const storedProjection = JSON.parse(storedProjectionBytes);
        validateCalmProjection(storedProjection);
        const storedReceipt = JSON.parse(await readFile(receiptTarget, 'utf8'));
        const mismatches = [
          [canonicalJson(storedProjection) === canonicalJson(written.projection), 'projection-bytes'],
          [canonicalJson(storedReceipt) === canonicalJson(written.receipt), 'receipt-bytes'],
          [sha256({ utf8: canonicalJson(storedProjection) }) === written.projectionSha256,
            'projection-digest'],
          [storedReceipt.workId === id, 'work-id'],
          [storedReceipt.intentSha256 === expectedIntentSha256, 'intent'],
          [storedReceipt.baseProjectionSha256 === currentBase.built.projectionSha256, 'base-projection'],
          [currentBase.store.manifest.manifestSha256
            === currentIntent.intent.base.worldModelManifestSha256, 'base-manifest']
        ].filter(([matches]) => !matches).map(([, name]) => name);
        if (mismatches.length) {
          fail(
            `Planned architecture projection and receipt changed during guarded rendering (${mismatches.join(', ')}).`,
            'WMC_INTENT_REVISION_CONFLICT',
            { mismatches }
          );
        }
        await validateCalmWithOfficialToolchain(storedProjection);
      }
    });
    const result = { status: 'rendered', workId: id, projectionSha256: planned.projectionSha256,
      paths: [projectionTarget, receiptTarget].map((file) => path.relative(root, file)) };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`Planned architecture rendered: ${result.projectionSha256}`);
    return result;
  }
  if (action === 'verify') {
    const directory = await architectureDirectory(root, definition, id);
    const targetReport = path.join(directory, 'intent-fulfilment.json');
    const expectedIntentSha256 = intent.intentSha256;
    const expectedRevision = workflow[Symbol.for('singularity-flow.state-revision')] ?? null;
    const report = await runDraftTransaction(root, {
      subject: {
        kind: 'story', id,
        branch: expectedRevision?.branch ?? currentBranch(root)
      },
      expectedRevision,
      allowedPaths: [path.relative(root, targetReport).replaceAll('\\', '/')],
      operation: 'architecture-intent-verify',
      write: async () => {
        // Re-read both Story authority and intent after taking the Story lock. A report computed
        // from a pre-lock intent must never replace a report for a concurrently revised draft.
        const currentWorkflow = await loadStoryAggregate(root, definition, id);
        const currentIntent = await readIntent(root, definition, id);
        if (currentIntent.intent.intentSha256 !== expectedIntentSha256) {
          fail(
            'Architecture intent changed before deterministic verification completed.',
            'WMC_INTENT_REVISION_CONFLICT',
            {
              expectedIntentSha256,
              currentIntentSha256: currentIntent.intent.intentSha256,
              nextAction: `Review the current intent and rerun singularity-flow architecture intent verify --work-id ${id}.`
            }
          );
        }
        await assertApprovedArchitectureIntent(
          root, definition, currentWorkflow, currentIntent.intent, currentIntent.target
        );
        const evaluated = await evaluateArchitectureIntentEvidence(
          root, definition, currentWorkflow, currentIntent.intent,
          {
            intentPath: currentIntent.target,
            candidateSnapshot: optionString(options, 'candidate-snapshot')
          }
        );
        const securedDirectory = await architectureDirectory(root, definition, id);
        await writeAtomic(
          path.join(securedDirectory, 'intent-fulfilment.json'),
          canonicalJson(evaluated.report),
          { mode: 0o600 }
        );
        return evaluated.report;
      },
      validate: async (written) => {
        const stored = validateArchitectureIntentFulfilment(
          JSON.parse(await readFile(targetReport, 'utf8'))
        );
        if (canonicalJson(stored) !== canonicalJson(written)) {
          fail(
            'Architecture intent fulfilment report changed during atomic verification.',
            'WMC_INTENT_REPORT_MISMATCH'
          );
        }
      }
    });
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(`Architecture intent fulfilment: ${report.blocking ? 'blocking' : 'satisfied'}\n${report.reportSha256}`);
    return report;
  }
  fail(`Unknown architecture intent action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

export { resolveArchitectureIntentBase } from '../architecture-intent-service.mjs';

export async function run(_argv, { positionals, options } = {}) {
  const root = repoRoot();
  const action = positionals[1] ?? 'show';
  const json = optionBoolean(options, 'json');
  if (action === 'intent') return intentCommand(root, positionals, options, json);
  if (action === 'show') {
    const value = await selectedProjection(root, options);
    if (json) console.log(JSON.stringify({ ...summary(value), document: value.selected.projection }, null, 2));
    else printSummary(summary(value));
    return value;
  }
  if (['explain', 'sources'].includes(action)) {
    const elementId = requirePositional(positionals, 2, 'architecture element ID');
    const value = await selectedProjection(root, options);
    const explained = explainArchitectureElement({
      projection: value.selected.projection, sourceMap: value.built.sourceMap, elementId,
      intent: value.intent ?? null,
      intentPath: value.workId
        ? path.posix.join('singularity', 'work-items', value.workId, 'context', 'architecture', 'architecture-intent.json')
        : null
    });
    if (json) console.log(JSON.stringify(explained, null, 2));
    else {
      console.log(`${explained.elementKind} ${explained.elementId} · ${explained.status}`);
      for (const source of explained.sources) console.log(`  ${source.sourceKind}: ${source.path ?? source.factId ?? source.recordId}`);
      if (explained.changeAt.length) console.log(`Change the authoritative source: ${explained.changeAt.join(', ')}`);
    }
    return explained;
  }
  if (action === 'validate') {
    const value = await selectedProjection(root, options);
    validateCalmProjection(value.selected.projection);
    const official = await validateCalmWithOfficialToolchain(value.selected.projection);
    const result = {
      status: official.status,
      projectionSha256: value.selected.projectionSha256,
      toolchainLockSha256: official.toolchainLock.lockSha256,
      normalizedResultSha256: official.normalizedResultSha256,
      diagnostics: official.normalizedResult
    };
    if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`CALM validation: ${result.status}\n${result.projectionSha256}`);
    return result;
  }
  if (action === 'doctor') {
    try {
      const value = await baseProjection(root);
      const result = { status: 'ready', projectionSha256: value.built.projectionSha256,
        manifestSha256: value.store.manifest.manifestSha256, nextAction: 'singularity-flow architecture show' };
      if (json) console.log(JSON.stringify(result, null, 2)); else console.log(`Architecture projection: ready\n${result.nextAction}`);
      return result;
    } catch (error) {
      error.details = { ...(error.details ?? {}), nextAction: error.details?.nextAction ?? 'singularity-flow wm build --format registered-v4' };
      throw error;
    }
  }
  if (action === 'export') {
    const format = optionString(options, 'format', 'calm');
    if (format !== 'calm') fail("Initial WMC export supports only '--format calm'.", 'WMC_EXPORT_TARGET_UNSAFE');
    const definition = await loadDefinition(root);
    const target = await safeOutput(root, optionString(options, 'out'), {
      governedOutputDir: definition.worldModel?.outputDir
    });
    const value = await selectedProjection(root, options, definition);
    const relativeTarget = path.relative(root, target).replaceAll('\\', '/');
    const plan = createArchitectureExportPlan({
      target: relativeTarget,
      projectionSha256: value.selected.projectionSha256,
      planned: value.planned
    });
    if (optionString(options, 'confirm') !== plan.planSha256) {
      fail(
        `CALM export requires confirmation of exact destination and bytes. Review '${relativeTarget}' and retry with --confirm ${plan.planSha256}.`,
        'WMC_EXPORT_CONFIRMATION_REQUIRED',
        {
          plan,
          nextAction: `singularity-flow architecture export --format calm --out ${JSON.stringify(relativeTarget)} --confirm ${plan.planSha256}`
        }
      );
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, canonicalJson(value.selected.projection), { flag: 'wx', mode: 0o600 });
    const result = { status: 'exported', path: relativeTarget,
      projectionSha256: value.selected.projectionSha256, planSha256: plan.planSha256,
      stateChanged: false };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`CALM exported without changing SFlow authority: ${result.path}\n${result.projectionSha256}`);
    return result;
  }
  if (action === 'diff') {
    const definition = await loadDefinition(root);
    const fromPath = await safeOutput(root, optionString(options, 'from'), {
      mustExist: true, type: 'file', governedOutputDir: definition.worldModel?.outputDir
    });
    const toPath = await safeOutput(root, optionString(options, 'to'), {
      mustExist: true, type: 'file', governedOutputDir: definition.worldModel?.outputDir
    });
    const [fromBytes, toBytes] = await Promise.all([readFile(fromPath, 'utf8'), readFile(toPath, 'utf8')]);
    let from; let to;
    try { from = JSON.parse(fromBytes); to = JSON.parse(toBytes); }
    catch (error) { fail(`Architecture diff input is not valid JSON: ${error.message}`, 'WMC_CALM_SCHEMA_INVALID'); }
    const semantic = architectureProjectionDiff(from, to);
    const result = {
      ...semantic, fromSha256: sha256({ utf8: fromBytes }), toSha256: sha256({ utf8: toBytes })
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.identical) console.log('Architecture projections are semantically identical.');
    else console.log(`Architecture changed: +${result.added.length} -${result.removed.length} ~${result.changed.length}\n${result.fromSha256} -> ${result.toSha256}`);
    return result;
  }
  fail(`Unknown architecture action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

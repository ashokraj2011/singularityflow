import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  catalogArtifactSet, resolvedArtifactSet, unpublishableRequiredArtifactSetMembers
} from './artifact-sets.mjs';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { phaseDraftCheck } from './phase-draft-check.mjs';
import { authoredArtifactText } from './publication-preflight.mjs';
import { inspectPendingPublication } from './publication-pending.mjs';
import { inspectPhaseRecovery } from './recovery-plan.mjs';
import { readRecord } from './schema-migrations.mjs';
import { evaluateSpecificationGate } from './specification-gate.mjs';
import { MARKER_FINDING_KINDS } from './specification-quality.mjs';
import {
  buildSpecIndex, canonicalJson, derivePlannedClaimMap, evaluateSpecAcceptance,
  isSpecificationDefinitionPhase, loadActiveSpecRecords, normalizeClaimMap, normalizeSpecPolicy,
  predecessorSpecClauses
} from './specifications.mjs';
import { exists, posix, secureRepositoryPath, snapshot } from './util.mjs';

function findingKey(finding) {
  return [finding.code, finding.path ?? '', finding.line ?? '',
    finding.details?.clauseId ?? finding.value ?? ''].join('\0');
}

function plannedClaimOwner(workflow, phase) {
  const policy = workflow.resolution?.plannedClaims;
  if (policy?.mode === 'required') {
    return Object.entries(policy.owners ?? {})
      .some(([codeId, ownerId]) => ownerId === phase.id
        && phaseRequiresCodeDelivery(workflow.phases?.[codeId]));
  }
  if (policy) return false;
  const order = workflow.phaseOrder ?? workflow.resolution?.phases?.map((entry) => entry.id)
    ?? Object.keys(workflow.phases ?? {});
  const next = workflow.phases?.[order[order.indexOf(phase.id) + 1]];
  return phaseRequiresCodeDelivery(next);
}

function plannedClaimsEnforced(workflow, specPolicy) {
  const policy = workflow.resolution?.plannedClaims;
  return policy ? policy.mode === 'required' : specPolicy.mode === 'enforce';
}

function placeholderTestReason(reason) {
  const value = String(reason ?? '').trim();
  return !value
    || /\b(?:todo|tbd|fixme|placeholder|to be determined|to be defined)\b/i.test(value)
    || /^<[^>]+>$/.test(value)
    || /^(?:specific|concrete)\s+reason$/i.test(value);
}

/** Project the exact publication quality, index and claim-table checks without writing records. */
async function specificationPublicationBlockers(root, config, workflow, phase, draft) {
  const blockers = [];
  const actions = [];
  if (!draft.artifact?.exists) return { blockers, actions };

  const artifactPath = draft.artifact.path;
  const repair = {
    command: `singularity-flow phase show ${phase.id} --show-artifact`,
    skill: directCopilotSkill(generationSkillForPhase(phase)),
    detail: `Correct the cited specification or planned-test findings in ${artifactPath}, then rerun prepublish.`
  };
  let needsHumanClarification = false;
  const add = (code, category, message, { line = null, value = null, details = null } = {}) => {
    blockers.push({ code, category, path: artifactPath, line, value, message,
      ...(details ? { details } : {}) });
  };

  try {
    const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
      generation: draft.generation,
      artifactRelativePath: artifactPath,
      namespace: (workflow.resolution?.spec ?? config.spec)?.namespace ?? null
    });
    for (const message of gate.errors) {
      const source = gate.report?.findings.find((finding) => finding.message === message);
      const marker = MARKER_FINDING_KINDS.includes(source?.kind);
      needsHumanClarification ||= marker;
      add(`specification.${source?.kind ?? 'quality-required'}`,
        marker ? 'clarification' : 'specification-quality', message,
        { line: source?.line ?? null, value: source?.section ?? source?.clauseId ?? message,
          details: { clauseId: source?.clauseId ?? null } });
    }
  } catch (error) {
    add('specification.quality-unavailable', 'specification-quality', error.message,
      { details: { sourceCode: error.code ?? null } });
  }

  const specPolicy = normalizeSpecPolicy(workflow.resolution?.spec ?? config.spec ?? {});
  const plannedPolicy = workflow.resolution?.plannedClaims;
  const definesClauses = isSpecificationDefinitionPhase(phase)
    && (plannedPolicy?.mode !== 'required' || plannedPolicy.clausePhases?.includes(phase.id));
  const plansClaims = specPolicy.mode !== 'off' && specPolicy.acceptance !== 'off'
    && plannedClaimOwner(workflow, phase);
  const itemDirectory = path.join(root, config.workItemRoot ?? 'singularity/work-items',
    workflow.workItem.id);
  let records = null;
  let candidateIndex = null;
  if (specPolicy.mode !== 'off' && (definesClauses || plansClaims)) {
    try {
      records = await loadActiveSpecRecords(itemDirectory, workflow);
      if (definesClauses) {
        candidateIndex = await buildSpecIndex(root, artifactPath, {
          workId: workflow.workItem.id, phase: phase.id, generation: draft.generation,
          policy: specPolicy, write: false,
          externalClauses: predecessorSpecClauses(records, workflow, phase.id)
        });
        if (plannedClaimsEnforced(workflow, specPolicy) && !candidateIndex.clauses.length) {
          add('specification.clauses-required', 'specification-index',
            `Phase ${phase.id} requires stable clause anchors such as [${specPolicy.namespace ?? 'APP'}:REQ-001].`);
        }
      }
    } catch (error) {
      add('specification.index-invalid', 'specification-index', error.message,
        { details: { sourceCode: error.code ?? null } });
    }
  }

  if (plansClaims && records && (!definesClauses || candidateIndex)) {
    const indexes = candidateIndex
      ? [...records.indexes.filter((index) => index.phase !== phase.id), candidateIndex]
      : records.indexes;
    const clauseIds = [...new Set(indexes.flatMap((index) =>
      (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())))].sort();
    if (!clauseIds.length && plannedPolicy?.mode === 'required') {
      add('specification.clause-source-required', 'planning-table',
        `No authoritative specification clauses exist before the code phase owned by '${phase.id}'. Add stable fully qualified anchors before planning tests.`);
    } else if (clauseIds.length) {
      try {
        const source = await secureRepositoryPath(root, artifactPath, {
          label: 'Planned claim source', mustExist: true, type: 'file'
        });
        const sourceSnapshot = await snapshot(source.absolute);
        const authored = authoredArtifactText(await readFile(source.absolute, 'utf8'));
        const derived = derivePlannedClaimMap(authored, { clauseIds, policy: specPolicy });
        const placeholders = Object.entries(derived.claimMap.claims)
          .filter(([, claim]) => claim.testDisposition === 'not-applicable'
            && placeholderTestReason(claim.testReason))
          .map(([id]) => id).sort();
        for (const clauseId of placeholders) add('specification.planned-test-placeholder',
          'planning-table', `Clause ${clauseId} has a placeholder not-applicable test reason.`,
          { details: { clauseId } });
        const gaps = [...new Set([...derived.missingClauseIds, ...derived.missingTestClauseIds])].sort();
        if (plannedClaimsEnforced(workflow, specPolicy)) {
          for (const clauseId of gaps) add('specification.planned-test-missing', 'planning-table',
            `Clause ${clauseId} has no exact planned test or reviewed not-applicable reason. Complete the 'Clause | Expected paths | Planned tests' table.`,
            { details: { clauseId } });
        }
        const claimPath = posix(path.join(config.workItemRoot ?? 'singularity/work-items',
          workflow.workItem.id, 'context', 'claims',
          `${phase.id}-gen${draft.generation}-planned.json`));
        if (await exists(path.join(root, claimPath))) {
          const bound = await secureRepositoryPath(root, claimPath, {
            label: 'Existing planned claim map', mustExist: true, type: 'file'
          });
          const raw = JSON.parse(await readFile(bound.absolute, 'utf8'));
          const existing = readRecord('specification-claim-map', raw).record;
          if (existing.kind !== 'planned' || existing.workId !== workflow.workItem.id
              || existing.phase !== phase.id
              || Number(existing.generation) !== Number(draft.generation)) {
            throw new Error('Existing planned claim map does not bind this phase generation.');
          }
          normalizeClaimMap(existing, { kind: 'planned', clauseIds, policy: specPolicy });
          const expected = {
            ...derived.claimMap, recordedAt: existing.recordedAt,
            workId: workflow.workItem.id, phase: phase.id, generation: draft.generation,
            source: { path: artifactPath, sha256: sourceSnapshot.sha256,
              bytes: sourceSnapshot.size }
          };
          if (canonicalJson(raw) !== canonicalJson(expected)) {
            throw new Error(`Existing planned claim map ${claimPath} does not match the reviewed Markdown in ${artifactPath}.`);
          }
        }
        const effectiveGaps = evaluateSpecAcceptance({ indexes, planned: [derived.claimMap] },
          { ...specPolicy, acceptance: 'presence' }).missingPlannedTests;
        if (plannedClaimsEnforced(workflow, specPolicy)) {
          for (const clauseId of effectiveGaps.filter((id) => !gaps.includes(id))) {
            add('specification.planned-test-missing', 'planning-table',
              `Clause ${clauseId} has no planned test.`, { details: { clauseId } });
          }
        }
      } catch (error) {
        add('specification.planned-test-invalid', 'planning-table', error.message,
          { details: { sourceCode: error.code ?? null } });
      }
    }
  }

  if (needsHumanClarification) actions.push({
    command: `singularity-flow clarification status ${phase.id} --json`, skill: null,
    detail: 'Get a reviewed answer for each unresolved marker, record it as a clarification, then update the specification and recheck.'
  });
  if (blockers.some((blocker) => blocker.category !== 'clarification')) actions.push(repair);
  return { blockers, actions };
}

async function staticPublicationBlockers(root, config, workflow, phase) {
  const blockers = [];
  const actions = [];
  let artifactSetFingerprint = null;
  const id = workflow.workItem.id;
  const pending = await inspectPendingPublication(root, {
    kind: 'story', id,
    legacyPath: path.join(root, config.workItemRoot ?? 'singularity/work-items', id,
      'publication-pending.json'),
    roots: { workItemRoot: config.workItemRoot }
  });
  if (pending.status !== 'absent') {
    blockers.push({
      code: pending.status === 'pending' ? 'phase.publication.pending' : 'phase.publication.unreadable',
      category: 'lifecycle', path: pending.path, line: null,
      message: pending.status === 'pending'
        ? 'A retained publication has not reached its remote. Synchronize that exact publication before another generation.'
        : 'The retained publication marker cannot be verified. Inspect recovery before another generation.'
    });
    actions.push({ command: pending.status === 'pending' ? 'singularity-flow sync'
      : `singularity-flow recover ${id} --phase ${phase.id} --json`,
    skill: pending.status === 'pending' ? '/sf-next' : '/sf-recover',
    detail: 'Resolve the retained publication before editing or publishing another generation.' });
  }
  const pinned = workflow.resolution?.phases?.find((entry) => entry.id === phase.id);
  if (pinned?.kind === 'skill' || phase.kind === 'skill') {
    blockers.push({
      code: 'phase.skill-host.unavailable', category: 'host', path: null, line: null,
      message: `Skill phase '${phase.id}' cannot publish until the qualified execution host and delivery receipt are available.`
    });
  }
  if (workflow.resolution?.collaboration?.assignmentMode === 'required'
      && !workflow.collaboration?.assignments?.[phase.id]) {
    blockers.push({
      code: 'phase.assignment.required', category: 'collaboration', path: null, line: null,
      message: `Phase '${phase.id}' requires an assignment before publication.`
    });
    actions.push({ command: `singularity-flow assign ${phase.id} <assignee>`, skill: '/sf-assign',
      detail: `Assign the ${phase.id} owner, then rerun prepublish.` });
  }
  if (phaseRequiresCodeDelivery(phase)) {
    try {
      await verifyOpenGenerationIntent(root, workflow, phase);
    } catch (error) {
      blockers.push({
        code: 'phase.generation-intent.required', category: 'code-delivery', path: null, line: null,
        message: error.message, details: { sourceCode: error.code ?? null }
      });
      const consumed = phase.generationIntent?.status === 'consumed';
      actions.push({ command: `singularity-flow phase ${consumed ? 'rollover' : 'begin'} ${phase.id}`,
        skill: '/sf-code', detail: consumed
          ? 'Preview the guarded next generation; do not overwrite a published result.'
          : 'Open the governed code generation before changing source, then recheck.' });
    }
  }
  const sourceId = pinned?.testEvidenceFrom;
  if (sourceId) {
    const source = workflow.phases?.[sourceId];
    if (!source || source.status !== 'approved' || source.deliveryEvidence?.status !== 'ready'
        || source.deliveryEvidence?.validation?.status !== 'passed') {
      blockers.push({
        code: 'phase.prior-test-evidence.required', category: 'code-delivery', path: null, line: null,
        message: `Phase '${phase.id}' needs approved passing test evidence from '${sourceId}'.`
      });
    }
  }
  const artifactSet = resolvedArtifactSet(config, workflow, phase);
  if (artifactSet) {
    const itemRelative = posix(path.join(config.workItemRoot ?? 'singularity/work-items', id));
    const catalog = await catalogArtifactSet(root, itemRelative, phase, artifactSet);
    const unpublishable = (await unpublishableRequiredArtifactSetMembers(root, catalog))
      .filter((member) => !catalog.missingRequired.includes(member));
    artifactSetFingerprint = `${catalog.bundleSha256}\0${unpublishable.join('\0')}`;
    for (const missing of catalog.missingRequired) {
      blockers.push({
        code: 'phase.artifact-set.required-member-missing', category: 'artifact-set',
        path: missing, line: null,
        message: `Required artifact-set member '${missing}' is missing or contains no evidence files.`
      });
    }
    for (const member of unpublishable) {
      blockers.push({
        code: 'phase.artifact-set.required-member-unpublishable', category: 'artifact-set',
        path: member, line: null,
        message: `Required artifact-set member '${member}' contains evidence that Git would not publish. Remove ignored or unsafe files and add eligible evidence before publication.`
      });
    }
    if (catalog.missingRequired.length || unpublishable.length) actions.push({
      command: `singularity-flow phase prepublish ${phase.id} --json`,
      skill: phase.id === 'release' ? '/sf-release'
        : directCopilotSkill(generationSkillForPhase(phase)),
      detail: 'Complete the required members in the current phase artifact directory, then recheck.'
    });
  }
  return { blockers, actions, artifactSetFingerprint };
}

/**
 * Read-only, phase-scoped readiness projection for guided pre-publication repair.
 *
 * Draft-check owns authored Markdown and producer identity. Recovery adds known projection,
 * configuration, and code-delivery blockers. Neither is a substitute for the exact checks in the
 * publication transaction: tests and remote state can change after this read.
 */
export async function phasePrepublish(root, config, workflow, phase, options = {}) {
  const draft = await phaseDraftCheck(root, config, workflow, phase, options);
  const recovery = await inspectPhaseRecovery(root, config, workflow, phase);
  const staticChecks = await staticPublicationBlockers(root, config, workflow, phase);
  const specificationChecks = await specificationPublicationBlockers(root, config, workflow, phase, draft);
  const blockers = [...staticChecks.blockers, ...specificationChecks.blockers];
  const actions = [...staticChecks.actions, ...specificationChecks.actions];
  const lifecycleReady = workflow.currentPhase === phase.id && phase.status === 'in_progress';
  const findings = new Map(draft.findings.map((finding) => [findingKey(finding), finding]));
  for (const blocker of [...blockers, ...recovery.blockers]) {
    const key = findingKey(blocker);
    if (!findings.has(key)) findings.set(key, {
      ...blocker,
      message: blocker.message ?? blocker.details?.message ?? blocker.code
    });
  }
  if (!lifecycleReady) {
    const finding = {
      code: 'phase.lifecycle.not-publishable', category: 'lifecycle', path: null, line: null,
      message: `Phase '${phase.id}' is not the current in-progress phase. Publication cannot repair or bypass this lifecycle gate.`
    };
    findings.set(findingKey(finding), finding);
  }
  const ready = lifecycleReady && draft.status === 'ready'
    && blockers.length === 0 && recovery.blockers.length === 0;
  const action = !lifecycleReady
    ? {
        command: draft.commands.recover,
        skill: '/sf-recover',
        detail: 'The phase is not current and in progress. Inspect lifecycle recovery before changing evidence.'
      }
    : draft.status !== 'ready'
      ? recovery.actions[0] ?? actions[0] ?? null
      : actions[0] ?? recovery.actions[0] ?? null;
  const briefOnly = recovery.actions.length > 0
    && recovery.actions.every((entry) => entry.id === `repair-agent-brief-source:${phase.id}`);
  const hardBlocker = blockers.some((entry) =>
    ['lifecycle', 'host'].includes(entry.category));
  const authoringRepairOnly = blockers.length > 0
    && blockers.every((entry) => ['artifact-set', 'specification-quality',
      'specification-index', 'planning-table'].includes(entry.category))
    && recovery.blockers.length === 0;
  const needsHumanClarification = blockers.some((entry) => entry.category === 'clarification');
  const agentOwnsRepair = draft.ownership.proven && draft.producer === 'governed-agent';
  // A supporting evidence collection is not a prose draft, but its exact bundle hash must still
  // move the bounded same-turn repair fingerprint when an agent adds a file beneath it.
  const draftFingerprint = staticChecks.artifactSetFingerprint == null
    ? draft.draftFingerprint
    : `sha256:${createHash('sha256').update(`${draft.draftFingerprint}\0${staticChecks.artifactSetFingerprint}`)
      .digest('hex')}`;
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'sflow-phase-prepublish',
    status: ready ? 'ready' : 'correction-required',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: draft.generation,
    phaseStatus: phase.status,
    producer: draft.producer,
    ownership: draft.ownership,
    draftFingerprint,
    artifact: draft.artifact,
    artifacts: draft.artifacts,
    findings: Object.freeze([...findings.values()].map((finding) => Object.freeze(finding))),
    readiness: Object.freeze({
      lifecycle: lifecycleReady,
      authoring: draft.status === 'ready',
      knownRecoveryBlockers: blockers.length === 0 && recovery.blockers.length === 0,
      publicationTransaction: 'not-run'
    }),
    correction: Object.freeze({
      ...draft.correction,
      class: !lifecycleReady ? 'phase-recovery'
        : draft.status === 'ready' && (blockers.length || recovery.blockers.length)
        ? needsHumanClarification ? 'human-input'
          : authoringRepairOnly && agentOwnsRepair ? 'agent-authoring' : 'phase-recovery'
        : draft.correction.class,
      sameTurn: lifecycleReady && !ready && !hardBlocker && (draft.status !== 'ready'
        ? draft.correction.sameTurn
        : (briefOnly || authoringRepairOnly) && agentOwnsRepair),
      guidance: ready ? null : !lifecycleReady ? action.detail : draft.status !== 'ready'
        ? draft.correction.guidance
        : action?.detail ?? 'Resolve the reported phase-scoped blocker, then recheck before publication.',
      skill: ready ? null : !lifecycleReady ? action.skill
        : draft.status !== 'ready' ? draft.correction.skill : action?.skill ?? null
    }),
    commands: Object.freeze({
      recheck: `singularity-flow phase prepublish ${phase.id} --json`,
      draftCheck: draft.commands.recheck,
      recover: draft.commands.recover,
      next: ready ? null : action?.command ?? null,
      publish: ready ? draft.commands.publish : null
    }),
    mutates: false,
    modelInvocations: 0
  });
}

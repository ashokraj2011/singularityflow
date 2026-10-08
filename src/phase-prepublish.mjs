import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  catalogArtifactSet, resolvedArtifactSet, unpublishableRequiredArtifactSetMembers
} from './artifact-sets.mjs';
import { generationSkillForPhase, legacyAuthoringSkill, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { commandGuidanceForCommands } from './safe-command-guidance.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { phaseDraftCheck } from './phase-draft-check.mjs';
import { hasPublishedPhaseGeneration, requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { exactFileAtObject, changes } from './git.mjs';
import { workingTreeAction } from './collaboration.mjs';
import { inspectLifecycleWorktree } from './lifecycle-worktree.mjs';
import { submissionReadiness } from './submission-readiness.mjs';
import { inspectPhasePublicationReadiness } from './phase-publication-readiness.mjs';
import { authoredArtifactFingerprint, authoredArtifactText } from './publication-preflight.mjs';
import { inspectPendingPublication } from './publication-pending.mjs';
import { inspectPhaseRecovery } from './recovery-plan.mjs';
import { testExecutionHandoff } from './test-execution-handoff.mjs';
import { readRecord } from './schema-migrations.mjs';
import { evaluateSpecificationGate } from './specification-gate.mjs';
import { MARKER_FINDING_KINDS } from './specification-quality.mjs';
import {
  buildSpecIndex, canonicalJson, derivePlannedClaimMap, evaluateSpecAcceptance,
  isSpecificationDefinitionPhase, loadActiveSpecRecords, normalizeClaimMap, normalizeSpecPolicy,
  predecessorSpecClauses
} from './specifications.mjs';
import { exists, posix, secureRepositoryPath, snapshot } from './util.mjs';
import { phaseFindingPolicy } from './phase-finding-policy.mjs';
import { planningEvidenceRepair } from './planning-evidence-repair.mjs';

function findingKey(finding) {
  return [finding.code, finding.path ?? '', finding.line ?? '',
    finding.details?.clauseId ?? finding.value ?? ''].join('\0');
}

/** Render only safe, read-only test-plan facts for the human CLI route. */
export function prepublishTestExecutionLines(testExecution) {
  if (testExecution?.status !== 'not-run') return [];
  const lines = ['Required tests: planned, not run by prepublish.'];
  if (testExecution.handoff?.runnerStatus === 'ready') {
    lines.push('Runner: ready; hidden approved arguments do not require configuration adoption.');
    lines.push(`Required tests run during ${testExecution.handoff.executionOwner}; passing fresh results continue that operation automatically.`);
  }
  for (const command of testExecution.commands ?? []) {
    const argv = command.argvSource === 'inferred' && Array.isArray(command.argv)
      ? JSON.stringify(command.argv.map((argument) => redactDiagnosticText(argument)))
      : '[see approved qualityCommands configuration]';
    lines.push(`  - ${redactDiagnosticText(command.id)}: argv=${argv} cwd=${redactDiagnosticText(command.workingDirectory)} report=${redactDiagnosticText(command.result?.adapter)}:${redactDiagnosticText(command.result?.path)}`);
  }
  return lines;
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
  let evidenceRepair = null;
  if (!draft.artifact?.exists) return { blockers, actions };

  const artifactPath = draft.artifact.path;
  const repair = {
    command: `singularity-flow phase show ${phase.id} --show-artifact`,
    skill: directCopilotSkill(generationSkillForPhase(phase, workflow)),
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
      let plannedSource = null;
      try {
        const source = await secureRepositoryPath(root, artifactPath, {
          label: 'Planned claim source', mustExist: true, type: 'file'
        });
        const sourceSnapshot = await snapshot(source.absolute);
        plannedSource = await readFile(source.absolute, 'utf8');
        const authored = authoredArtifactText(plannedSource);
        const derived = derivePlannedClaimMap(authored, { clauseIds, policy: specPolicy,
          evidenceRoot: `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence` });
        // Derivation already validates contracts through the author-owned visibility boundary.
        // Re-parsing raw authored comments/examples would disagree with publication [E2G-013].
        const contracts = derived.claimMap.verificationContracts ?? [];
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
            ...derived.claimMap, ...(contracts.length ? { verificationContracts: contracts } : {}), recordedAt: existing.recordedAt,
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
          { details: { ...error.details, sourceCode: error.code ?? null } });
        if (plannedSource != null && ['SPEC_VERIFICATION_CONTRACT_INVALID',
          'SPEC_PLANNED_EVIDENCE_TYPE_INVALID'].includes(error.code)) {
          evidenceRepair = planningEvidenceRepair(plannedSource, { clauseIds, policy: specPolicy,
            evidenceRoot: `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence` });
        }
      }
    }
  }

  if (needsHumanClarification) actions.push({
    command: `singularity-flow clarification status ${phase.id} --json`, skill: null,
    detail: 'Get a reviewed answer for each unresolved marker, record it as a clarification, then update the specification and recheck.'
  });
  if (blockers.some((blocker) => blocker.category !== 'clarification')) actions.push(repair);
  return { blockers, actions, evidenceRepair };
}

async function staticPublicationBlockers(root, config, workflow, phase, { retained = false } = {}) {
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
  if (!retained && (pinned?.kind === 'skill' || phase.kind === 'skill')) {
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
  if (!retained && phaseRequiresCodeDelivery(phase)) {
    try {
      await verifyOpenGenerationIntent(root, workflow, phase);
    } catch (error) {
      blockers.push({
        code: 'phase.generation-intent.required', category: 'code-delivery', path: null, line: null,
        message: error.message, details: { sourceCode: error.code ?? null }
      });
      const consumed = phase.generationIntent?.status === 'consumed';
      actions.push({ command: consumed
        ? `singularity-flow recover ${id} --phase ${phase.id} --json`
        : `singularity-flow phase begin ${phase.id}`,
        skill: consumed ? '/sf-recover' : '/sf-code', detail: consumed
          ? 'Inspect the guarded phase rollover in recovery; do not overwrite a published result or route back to /sf-code before recovery clears.'
          : 'Open the governed code generation before changing source, then recheck.' });
    }
  }
  const sourceId = pinned?.testEvidenceFrom;
  if (sourceId) {
    const source = workflow.phases?.[sourceId];
    let acceptedUnavailable = false;
    if (source?.deliveryEvidence?.testRecovery) {
      try {
        const { assertPassedCodeDeliveryInput } = await import('./state.mjs');
        await assertPassedCodeDeliveryInput(root, config, workflow, phase);
        acceptedUnavailable = true;
      } catch (error) {
        blockers.push({ code: error.code ?? 'TRP_PHASE_GATE_BLOCKED', category: 'code-delivery', path: null, line: null,
          message: error.message, details: error.details ?? null });
      }
    }
    if (!source || source.status !== 'approved' || source.deliveryEvidence?.status !== 'ready'
        || (source.deliveryEvidence?.validation?.status !== 'passed' && !acceptedUnavailable)) {
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
      // The built-in release step keeps its evidence corrections with the release skill exactly
      // when that skill accepts the step: no chosen skill and the automatic document route.
      skill: legacyAuthoringSkill(phase, workflow) === 'sf-release' ? '/sf-release'
        : directCopilotSkill(generationSkillForPhase(phase, workflow)),
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
  const retained = workflow.currentPhase === phase.id && phase.status === 'in_progress'
    && hasPublishedPhaseGeneration(phase) && !requiresProspectivePhaseInspection(workflow, phase);
  // Publication prerequisites belong to authoring, not to a retained generation awaiting tests or
  // review. Authentication and submission/recovery still own every current integrity/quality gate.
  const dependencies = retained ? { blockers: [], actions: [], warnings: [], repairLoop: null,
    grounding: { status: 'not-applicable', reason: 'generation-already-published' } }
    : await inspectPhasePublicationReadiness(root, config, workflow, phase, {
    producer: draft.configuredProducer, generation: draft.generation,
    agent: draft.ownership.proven ? draft.ownership.agent : null
  });
  let generationDigest;
  if (retained && phase.generationIntent?.status === 'consumed') {
    const { generationResultDigest, generationResultMatches } = await import('./state.mjs');
    generationDigest = async (repositoryRoot, selectedPhase) => await generationResultMatches(
      repositoryRoot, config, workflow, selectedPhase)
      ? selectedPhase.generationIntent.publication.resultDigest
      : generationResultDigest(repositoryRoot, config, workflow, selectedPhase);
  }
  const recovery = await inspectPhaseRecovery(root, config, workflow, phase, {
    publicationReadiness: dependencies, modelEnabled: options.modelEnabled, generationDigest
  });
  // Recovery resolves the prospective structured command without running it. Keep that exact
  // argv/report contract visible while publication and its required test execution are pending.
  const testExecution = recovery.testExecution;
  const staticChecks = await staticPublicationBlockers(root, config, workflow, phase, { retained });
  const specificationChecks = retained ? { blockers: [], actions: [] }
    : await specificationPublicationBlockers(root, config, workflow, phase, draft);
  const blockers = [...staticChecks.blockers, ...specificationChecks.blockers];
  const actions = [...staticChecks.actions, ...specificationChecks.actions];
  // The transaction preserves an existing index instead of replacing staged governed bytes.
  // Expose that same prerequisite before offering publication, without unstaging anything.
  let worktreeAction = null;
  let worktreeInspection = null;
  if (!retained) {
    worktreeInspection = inspectLifecycleWorktree(root, config, workflow);
    const staged = worktreeInspection.entries.filter(entry => entry.xy && entry.xy.index !== '.');
    if (staged.length) {
      worktreeAction = await workingTreeAction(root, config, workflow, phase, changes(root), recovery, worktreeInspection);
      const owned = new Set(worktreeAction?.expectedPaths ?? []);
      const overlap = [...new Set(staged.flatMap(entry => [entry.path, entry.originalPath])
        .filter(value => value?.kind === 'utf8' && owned.has(value.value)).map(value => value.value))];
      if (overlap.length) {
        blockers.push({ code: 'LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED', category: 'worktree',
          path: overlap[0], message: 'Review the already staged current-phase paths before publication. Commit them through reviewed recovery or deliberately unstage them; no index changes were made.',
          details: { paths: overlap, indexPreserved: true } });
        actions.push({ command: draft.commands.recover, skill: '/sf-recover',
          detail: 'Review the exact staged diff and use the returned scoped commit if eligible. Preserve unrelated staged bytes; publication does not replace your index.' });
      }
    }
  }
  let retainedReadiness = null;
  if (retained) {
    try {
      const commit = publishedGenerationCommit(root, workflow, phase);
      if (!commit) throw new Error('The retained generation has no authenticated publication.');
      const bytes = draft.artifact?.exists ? exactFileAtObject(root, commit, draft.artifact.path,
        { maximumBytes: 16 * 1024 * 1024, regularOnly: true }) : null;
      if (!bytes || authoredArtifactFingerprint(bytes.toString('utf8')) !== draft.artifact.fingerprint) {
        throw new Error('The current authored artifact differs from its retained publication. Restore reviewed bytes or open an authorized successor; do not republish in place.');
      }
      retainedReadiness = await submissionReadiness(root, config, workflow, { phaseId: phase.id });
      if (!retainedReadiness.lifecycleReady) blockers.push({
        code: retainedReadiness.reasonCode, category: 'lifecycle', path: null,
        message: retainedReadiness.reason ?? 'Follow the retained generation\'s required review or recovery route.'
      });
      actions.push({ command: retainedReadiness.nextCommand, skill: retainedReadiness.nextSkill,
        detail: retainedReadiness.reason ?? 'Continue the retained generation through its required submission/review checks.' });
    } catch (error) {
      blockers.push({ code: error.code ?? 'GENERATION_PUBLICATION_INVALID', category: 'integrity',
        path: draft.artifact?.path ?? null, message: error.message });
      actions.push({ command: draft.commands.recover, skill: '/sf-recover',
        detail: 'Preserve this publication and inspect its exact committed identity and authored bytes.' });
    }
  }
  const lifecycleReady = workflow.currentPhase === phase.id && phase.status === 'in_progress';
  const agentOwnsRepair = draft.ownership.proven && draft.producer === 'governed-agent';
  const evidenceReview = entry => entry.code === 'phase.evidence-contract.not-ready'
    && entry.details?.sourceCode === 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED';
  // Publication and producer repair are different boundaries. Reuse the exact worktree guard,
  // never mark the pending decision repairable or remove it from readiness/findings.
  const evidenceOnlyDependencies = dependencies.blockers.length > 0 && dependencies.blockers.every(evidenceReview);
  const heldDraft = !retained && lifecycleReady && agentOwnsRepair && evidenceOnlyDependencies
    ? (worktreeAction ?? await workingTreeAction(root, config, workflow, phase, changes(root), recovery,
      worktreeInspection ?? inspectLifecycleWorktree(root, config, workflow)))?.authoringContinuation : null;
  const draftRepairAllowed = heldDraft?.allowed === true;
  const repairDependencies = draftRepairAllowed ? dependencies.blockers.filter(entry => !evidenceReview(entry)) : dependencies.blockers;
  const repairRecoveryBlockers = draftRepairAllowed ? recovery.blockers.filter(entry => !evidenceReview(entry)) : recovery.blockers;
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
  // A draft blocker that names its own route (the stale-Code repair, a convergence decision) keeps
  // it here, so prepublish and draft-check never offer two different next commands.
  const draftRoute = draft.commands.next ? {
    command: draft.commands.next, skill: draft.correction.skill, detail: draft.correction.guidance
  } : null;
  const briefOnly = recovery.actions.length > 0
    && recovery.actions.every((entry) => entry.id === `repair-agent-brief-source:${phase.id}`);
  const hardBlocker = [...blockers, ...recovery.blockers].some((entry) =>
    ['lifecycle', 'host', 'collaboration'].includes(entry.category)
      || entry.code === 'phase.generation-intent.required');
  // Recovery can detect source/test coverage that the Markdown draft checker does not own.
  // Apply the same installed finding policy to both sets; an unclaimed/invalid evidence path
  // remains an owner decision, never a producer repair merely because the summary is ready.
  const repairBlockers = [...blockers, ...repairRecoveryBlockers]
    .filter(entry => entry.code !== 'LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED');
  const authoringRepairOnly = repairBlockers.length > 0
    && repairBlockers.every((entry) => phaseFindingPolicy(entry).repairableByProducer);
  const ownedRecoveryRepair = !retained && lifecycleReady && !hardBlocker
    && !repairDependencies.length && authoringRepairOnly && agentOwnsRepair;
  const producerRoute = ownedRecoveryRepair ? {
    command: `singularity-flow phase prepublish ${phase.id} --json`,
    skill: directCopilotSkill(generationSkillForPhase(phase, workflow)),
    detail: 'Repair the cited owned draft/source/test bindings in this open generation, preserving the index; then recheck.'
      + (draftRepairAllowed ? ' Preserve held evidence; its pending human review still blocks publication.' : '')
  } : null;
  const action = !lifecycleReady
    ? {
        command: draft.commands.recover,
        skill: '/sf-recover',
        detail: 'The phase is not current and in progress. Inspect lifecycle recovery before changing evidence.'
      }
    : dependencies.blockers.length && !(draftRepairAllowed && (draft.status !== 'ready' || ownedRecoveryRepair)) ? dependencies.actions[0]
    : draft.status !== 'ready'
      ? draftRoute ?? recovery.actions[0] ?? actions[0] ?? null
      // A retained packet can be individually ready while changed application bytes require a
      // reviewed successor. Recovery owns that boundary; never advertise submission first.
      : retained && recovery.requiresLifecycleRecovery
        ? { command: draft.commands.recover, skill: '/sf-recover',
            detail: 'Inspect the reported lifecycle recovery and its exact successor/return plan before submitting this retained generation.' }
      : (ownedRecoveryRepair && blockers.some(entry => entry.code === 'LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED') ? producerRoute : null)
        ?? actions[0] ?? producerRoute ?? recovery.actions[0] ?? null;
  const needsHumanClarification = [...blockers, ...recovery.blockers].some((entry) => entry.category === 'clarification');
  // A supporting evidence collection is not a prose draft, but its exact bundle hash must still
  // move the bounded same-turn repair fingerprint when an agent adds a file beneath it.
  const draftFingerprint = staticChecks.artifactSetFingerprint == null
    ? draft.draftFingerprint
    : `sha256:${createHash('sha256').update(`${draft.draftFingerprint}\0${staticChecks.artifactSetFingerprint}`)
      .digest('hex')}`;
  const commands = Object.freeze({
    recheck: `singularity-flow phase prepublish ${phase.id} --json${options.modelEnabled === false ? ' --no-model' : ''}`,
    draftCheck: draft.commands.recheck,
    recover: draft.commands.recover,
    next: ready ? retainedReadiness?.nextCommand ?? null : action?.command ?? null,
    publish: ready && !retained ? draft.commands.publish : null
  });
  const planningRepairAllowed = specificationChecks.evidenceRepair?.status === 'producer-repair'
    && specificationChecks.evidenceRepair.sourceSha256 === String(draft.artifact?.sha256 ?? '').replace(/^sha256:/u, '')
    && !retained && lifecycleReady && !hardBlocker && !repairDependencies.length && agentOwnsRepair
    && (ownedRecoveryRepair || draft.correction.sameTurn);
  const { phaseResolutionProjection } = await import('./phase-resolution.mjs');
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'sflow-phase-prepublish',
    status: ready ? 'ready' : 'correction-required',
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: draft.generation,
    inspectionStage: draft.inspectionStage,
    submissionReadiness: retainedReadiness,
    phaseStatus: phase.status,
    producer: draft.producer,
    qualityDisposition: draft.qualityDisposition,
    acceptedQualityRisks: draft.acceptedQualityRisks,
    ownership: draft.ownership,
    draftFingerprint,
    artifact: draft.artifact,
    artifacts: draft.artifacts,
    findings: Object.freeze([...findings.values()].map((finding) => Object.freeze(finding))),
    resolution: phaseResolutionProjection(workflow, phase, [...findings.values(), ...(draft.advisories ?? [])]),
    repairLoop: dependencies.repairLoop,
    ...(draftRepairAllowed ? { draftRepair: { allowed: true, scope: 'draft-only',
      heldEvidence: heldDraft.heldEvidence, publicationBlocked: true, evidenceAccepted: false,
      deferredFindingCodes: ['PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED'] } } : {}),
    // Carried through unchanged: advisories never enter findings or readiness.
    advisories: draft.advisories,
    documentation: draft.documentation,
    coverage: draft.coverage,
    traceabilityRepair: draft.traceabilityRepair ? Object.freeze({
      ...draft.traceabilityRepair,
      sameTurn: lifecycleReady && !hardBlocker && !repairDependencies.length
        && draft.correction.sameTurn && draft.traceabilityRepair.sameTurn,
      actions: Object.freeze(draft.traceabilityRepair.actions.map((entry) => Object.freeze({
        ...entry, sameTurn: lifecycleReady && !hardBlocker && !repairDependencies.length
          && draft.correction.sameTurn && entry.sameTurn
      })))
    }) : null,
    // Suggestions belong only to this producer's open draft. They never amend a publication,
    // create evidence, weaken an explicit witness contract or grant permission to advance.
    planningEvidenceRepair: specificationChecks.evidenceRepair ? Object.freeze({
      ...specificationChecks.evidenceRepair,
      workId: workflow.workItem.id, phase: phase.id, generation: draft.generation,
      artifact: { path: draft.artifact.path, sha256: draft.artifact.sha256 },
      sameTurn: planningRepairAllowed,
      status: specificationChecks.evidenceRepair.status === 'author-review' ? 'author-review'
        : planningRepairAllowed ? 'producer-repair' : 'owner-review',
      patches: planningRepairAllowed ? specificationChecks.evidenceRepair.patches : []
    }) : null,
    grounding: Object.freeze(dependencies.grounding),
    warnings: Object.freeze(dependencies.warnings),
    readiness: Object.freeze({
      lifecycle: lifecycleReady,
      authoring: draft.status === 'ready',
      knownRecoveryBlockers: blockers.length === 0 && recovery.blockers.length === 0,
      requiredTests: testExecution.status,
      publicationTransaction: retained ? 'already-published' : 'not-run'
    }),
    testExecution: Object.freeze({
      status: testExecution.status,
      ...(testExecution.blockedBy ? { blockedBy: testExecution.blockedBy } : {}),
      ...(testExecution.reason ? { reason: testExecution.reason } : {}),
      commands: Object.freeze(testExecution.commands.map((command) => Object.freeze(command))),
      handoff: Object.freeze(testExecutionHandoff(testExecution, {
        published: retained,
        command: retained
          ? ready && retainedReadiness?.classification === 'ready-to-attempt' ? commands.next : null
          : commands.publish
      }))
    }),
    correction: Object.freeze({
      ...draft.correction,
      class: !lifecycleReady ? 'phase-recovery'
        : repairDependencies.length
          ? repairDependencies[0].category === 'clarification' ? 'human-input' : 'phase-recovery'
        : draftRepairAllowed && draft.status === 'ready' && !blockers.length && !repairRecoveryBlockers.length
          ? 'human-input'
        : draft.status === 'ready' && (blockers.length || repairRecoveryBlockers.length)
        ? needsHumanClarification ? 'human-input'
          : authoringRepairOnly && agentOwnsRepair ? 'agent-authoring' : 'phase-recovery'
        : draft.correction.class,
      sameTurn: !retained && lifecycleReady && !ready && !hardBlocker && !repairDependencies.length && (draft.status !== 'ready'
        ? draft.correction.sameTurn
        : (briefOnly || authoringRepairOnly) && agentOwnsRepair),
      guidance: ready ? null : !lifecycleReady || repairDependencies.length ? action.detail : draft.status !== 'ready'
        ? draft.correction.guidance
        : action?.detail ?? 'Resolve the reported phase-scoped blocker, then recheck before publication.',
      skill: ready ? null : !lifecycleReady || repairDependencies.length ? action.skill
        : draft.status !== 'ready' ? draft.correction.skill : action?.skill ?? null
    }),
    commands,
    commandGuidance: commandGuidanceForCommands(commands),
    mutates: false,
    modelInvocations: 0
  });
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findingOwnedByPhase } from './phase-finding-policy.mjs';

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
import { evaluateSpecificationGate, specificationGateDiagnostics } from './specification-gate.mjs';
import {
  buildSpecIndex, canonicalJson, derivePlannedClaimMap, evaluateSpecAcceptance,
  isSpecificationDefinitionPhase, loadActiveSpecRecords, normalizeClaimMap, normalizeSpecPolicy,
  predecessorSpecClauses
} from './specifications.mjs';
import { exists, posix, secureRepositoryPath, snapshot, SingularityFlowError } from './util.mjs';
import { phaseFindingCode, phaseFindingPolicy } from './phase-finding-policy.mjs';
import { planningEvidenceRepair } from './planning-evidence-repair.mjs';
import { phaseAuthoringContract, phasePlansDelivery } from './phase-authoring-contract.mjs';
import { clauseIntentOwner, upstreamChangeRoutes } from './upstream-routes.mjs';
import { ownerStepChecks } from './phase-roles.mjs';

/** What a plan's unmet intent says of its two owners: the step that approved the intent, and this plan. */
function intentOwnerWords(workflow, phase, intent) {
  const how = intent.openIssues.length ? `${intent.openIssues.join(', ')} already names it, so ${intent.owner}'s approvers decide it in the decision list`
    : intent.route?.command.includes(' intent-amendment ') ? `${intent.owner}'s approvers decide a reviewed intent amendment`
      : `raise it to ${intent.owner}'s approvers as an upstream issue`;
  return `${intent.owner} approved that intent: if the plan is right and the intent is not, ${how}; if the plan is wrong, correct its row in this draft.`;
}

function findingKey(finding) {
  // Distinct underlying failures share a surface code (code.delivery.incomplete); keep each one.
  return [finding.code, finding.details?.sourceCode ?? '', finding.path ?? '', finding.line ?? '',
    finding.details?.clauseId ?? finding.value ?? '', finding.details?.field ?? ''].join('\0');
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
  // What the gate would meet, said before it runs. It informs; only the gate refuses.
  for (const entry of testExecution.earlyChecks ?? []) lines.push(`Before the tests run: ${entry.words} ${entry.action}`);
  return lines;
}

function plannedClaimOwner(workflow, phase) {
  return phasePlansDelivery(workflow, phase);
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
  let planningContract = null;
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
    const diagnostics = specificationGateDiagnostics(gate, artifactPath);
    needsHumanClarification ||= diagnostics.findings.some(finding => finding.category === 'clarification');
    blockers.push(...diagnostics.findings);
  } catch (error) {
    add('specification.quality-unavailable', 'specification-quality', error.message,
      { details: { sourceCode: error.code ?? null } });
  }

  // A plan in a workflow with no code step meets publication's supporting-files refusal here.
  try {
    await (await import('./state.mjs')).assertUncodedPlanSupportingFiles(root, config, workflow, phase);
  } catch (error) {
    if (error?.code !== 'SPEC_SUPPORTING_FILE_INVALID') throw error;
    add('specification.supporting-file-invalid', 'planning-table', error.message,
      { details: { sourceCode: error.code, ownerPhase: phase.id, repairScope: 'current-draft' } });
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
      // The quality check reads the same clauses first; its finding already names this cause.
      if (!blockers.some(finding => finding.code === 'specification.clause-extraction-failed' && finding.message === error.message)) {
        add('specification.index-invalid', 'specification-index', error.message,
          { details: { sourceCode: error.code ?? null } });
      }
    }
  }

  if (plansClaims && records && (!definesClauses || candidateIndex)) {
    const indexes = candidateIndex
      ? [...records.indexes.filter((index) => index.phase !== phase.id), candidateIndex]
      : records.indexes;
    const clauseIds = [...new Set(indexes.flatMap((index) =>
      (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())))].sort();
    planningContract = { clauseIds, evidenceRoot: `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence` };
    if (!clauseIds.length && plannedPolicy?.mode === 'required') {
      // The clauses are the defining step's output, as at plan publication (noSpecificationClausesError):
      // this step routes it there and is never told to write them itself [PHR:REQ-001, finding 9].
      const owner = (plannedPolicy.clausePhases ?? []).at(-1) ?? null;
      add('specification.clause-source-required', 'planning-table',
        `No authoritative specification clauses exist before the code phase owned by '${phase.id}'. ${owner && owner !== phase.id
          ? `They are '${owner}''s to add: stable fully qualified anchors, before planning tests; ${phase.id} keeps its draft meanwhile.`
          : 'Add stable fully qualified anchors before planning tests.'}`,
        { details: { clausePhases: plannedPolicy.clausePhases ?? [], ownerPhase: owner ?? phase.id,
          ...(owner && owner !== phase.id ? { upstreamPhase: owner, recoveryCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${owner}` } : {}) } });
    } else if (clauseIds.length) {
      let plannedSource = null;
      try {
        const source = await secureRepositoryPath(root, artifactPath, {
          label: 'Planned claim source', mustExist: true, type: 'file'
        });
        const sourceSnapshot = await snapshot(source.absolute);
        plannedSource = await readFile(source.absolute, 'utf8');
        const authored = authoredArtifactText(plannedSource);
        // Rows the plan's approvers upheld against the approved intent: an accepted dispute of this exact
        // draft, or a decided upstream issue's accepted risk [PHR:REQ-003, finding 2].
        const upheldIntent = await (await import('./phase-finding-dispute.mjs')).upheldIntentRows(root, config, workflow, phase,
          { text: plannedSource, clauses: indexes.filter((index) => index.phase !== phase.id).flatMap((index) => index.clauses ?? []) });
        const derived = derivePlannedClaimMap(authored, { clauseIds, clauses: indexes.flatMap(index => index.clauses ?? []), policy: specPolicy,
          evidenceRoot: `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence`,
          requireComplete: plannedClaimsEnforced(workflow, specPolicy), upheldIntent });
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
        // Existing and removed rows against the Story's base, while the planner can correct them; the code
        // step met them first, after the plan was approved [PHR:REQ-002, finding 14].
        if (ownerStepChecks(workflow)) {
          for (const problem of (await import('./plan-base-paths.mjs')).plannedBasePathProblems(root, workflow, derived.claimMap.claims)) {
            add(problem.code, 'planning-table', problem.message, { value: problem.path, details: { clauseId: problem.clauseId, path: problem.path,
              fulfillment: problem.fulfillment, baseCommit: problem.baseCommit, ownerPhase: phase.id, repairScope: 'current-draft' } });
          }
        }
        const gaps = [...new Set([...derived.missingClauseIds, ...derived.missingTestClauseIds])].sort();
        // Wherever the Story's ending refuses a clause with no planned test (an enforced specification with
        // acceptance on), the plan refuses it here first, with the same predicate [PHR:REQ-007], G7.
        const plansEnforced = plannedClaimsEnforced(workflow, specPolicy)
          || (ownerStepChecks(workflow) && specPolicy.mode === 'enforce' && (specPolicy.acceptance ?? 'off') !== 'off');
        if (plansEnforced) {
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
            throw new SingularityFlowError('Existing planned claim map does not bind this phase generation.',
              { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE', details: { path: claimPath } });
          }
          normalizeClaimMap(existing, { kind: 'planned', clauseIds, policy: specPolicy });
          const expected = {
            ...derived.claimMap, ...(contracts.length ? { verificationContracts: contracts } : {}), recordedAt: existing.recordedAt,
            workId: workflow.workItem.id, phase: phase.id, generation: draft.generation,
            source: { path: artifactPath, sha256: sourceSnapshot.sha256,
              bytes: sourceSnapshot.size }
          };
          if (canonicalJson(raw) !== canonicalJson(expected)) {
            throw new SingularityFlowError(`Existing planned claim map ${claimPath} does not match the reviewed Markdown in ${artifactPath}.`,
              { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE', details: { path: claimPath } });
          }
        }
        const effectiveGaps = evaluateSpecAcceptance({ indexes, planned: [derived.claimMap] },
          { ...specPolicy, acceptance: 'presence' }).missingPlannedTests;
        if (plansEnforced) {
          for (const clauseId of effectiveGaps.filter((id) => !gaps.includes(id))) {
            add('specification.planned-test-missing', 'planning-table',
              `Clause ${clauseId} has no planned test.`, { details: { clauseId } });
          }
        }
      } catch (error) {
        const diagnostics = error.details?.diagnostics ?? [{ code: error.code, message: error.message, details: error.details }];
        planningContract.diagnosticSummary = error.details?.diagnosticSummary ?? { complete: true, omitted: 0 };
        for (const diagnostic of diagnostics) {
          // The plan falls short of an intent the clause's defining step approved: that step owns the
          // intent, the planner its plan. Either may be what is wrong [PHR:REQ-001, finding 2].
          const intent = diagnostic.details?.cause === 'intent-not-met'
            ? clauseIntentOwner(workflow, phase.id, indexes, diagnostic.details?.clauseId ?? diagnostic.clauseId) : null;
          add(diagnostic.code === 'SPEC_PLANNED_ROW_REQUIRED' ? 'specification.planned-test-missing' : 'specification.planned-test-invalid',
            'planning-table', intent ? `${diagnostic.message} ${intentOwnerWords(workflow, phase, intent)}` : diagnostic.message,
            { line: diagnostic.line ?? diagnostic.details?.line ?? null,
              details: { ...diagnostic.details, sourceCode: diagnostic.code ?? null, ownerPhase: intent?.owner ?? phase.id,
                ...(intent ? { upstreamPhase: intent.owner, ...(intent.openIssues.length
                  ? { upstreamIssues: intent.openIssues, nextAction: { command: `singularity-flow decisions ${workflow.workItem.id} --json`, skill: '/sf-decide',
                    label: `${intent.owner}'s approvers decide ${intent.openIssues.join(', ')} in the decision list.` } }
                  : intent.route ? { upstreamRoute: intent.route } : {}) } : {}),
                repairScope: 'current-draft' } });
        }
        if (planningContract.diagnosticSummary.omitted) add('specification.planned-diagnostics-bounded', 'planning-table',
          `${planningContract.diagnosticSummary.omitted} further draft diagnostics were omitted from this bounded packet. Repair the listed fields, then recheck; this is not a complete or passing plan.`,
          { details: { ownerPhase: phase.id, repairScope: 'current-draft' } });
        if (plannedSource != null && ['SPEC_VERIFICATION_CONTRACT_INVALID',
          'SPEC_PLANNED_EVIDENCE_TYPE_INVALID'].includes(error.code)) {
          evidenceRepair = planningEvidenceRepair(plannedSource, { clauseIds, clauses: indexes.flatMap(index => index.clauses ?? []), policy: specPolicy,
            evidenceRoot: `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence` });
        }
      }
    }
  }

  if (needsHumanClarification) actions.push({
    command: `singularity-flow clarification status ${phase.id} --json`, skill: null,
    detail: 'Get a reviewed answer for each unresolved marker, record it as a clarification, then update the specification and recheck.'
  });
  // What an earlier step owns goes to that step's correction, never to this draft [PHR:REQ-003]: the
  // decision list when an open issue already names it, else that step's own correction for it.
  const upstream = (blocker) => blocker.details?.upstreamPhase && blocker.details.upstreamPhase !== phase.id;
  for (const owner of new Set(blockers.filter(upstream).map((blocker) => blocker.details.upstreamPhase))) {
    const owned = blockers.filter((blocker) => upstream(blocker) && blocker.details.upstreamPhase === owner);
    const waiting = owned.find((blocker) => blocker.details.nextAction)?.details.nextAction;
    const named = owned.find((blocker) => blocker.details.upstreamRoute)?.details.upstreamRoute;
    const legal = waiting || named ? null : upstreamChangeRoutes(workflow, owner, { currentPhaseId: phase.id }).routes[0];
    if (waiting) actions.push({ command: waiting.command, skill: waiting.skill, detail: waiting.label });
    else if (named ?? legal) actions.push({ command: (named ?? legal).command, skill: (named ?? legal).skill,
      detail: `${(named ?? legal).label} ${phase.id} cannot correct ${owner}'s output in its own draft.` });
  }
  // A plan that may itself be what is wrong keeps its own correction beside the earlier step's.
  if (blockers.some((blocker) => blocker.category !== 'clarification' && (!upstream(blocker) || blocker.details?.repairScope === 'current-draft'))) actions.push(repair);
  return { blockers, actions, evidenceRepair, planningContract };
}

const CHANGE_SCOPE_CODES = new Set(['CHANGE_SET_POLICY_VIOLATION', 'PHASE_ARTIFACT_ONLY_CHANGES',
  'SOURCE_BOUNDARY_VIOLATION', 'PHASE_SOURCE_CHANGE_UNGOVERNED']);

async function changeScopeBlocker(root, config, workflow, phase) {
  try {
    await (await import('./state.mjs')).assertPhaseChangeScope(root, config, workflow, phase);
    return null;
  } catch (error) {
    // Only the scope refusals themselves; anything else stays publication's to report, as before.
    if (!CHANGE_SCOPE_CODES.has(error?.code)) return null;
    const paths = error.details?.paths ?? error.details?.changedPaths ?? [];
    const protectedPath = error.details?.violationKind === 'protected-process-path';
    return {
      blocker: { code: error.code, category: protectedPath ? 'integrity' : 'change-scope', path: paths[0] ?? null,
        line: null, message: `${error.message} (${error.code})`, details: { ...(error.details ?? {}), sourceCode: error.code } },
      // With no route of its own, recovery is the way: it offers a person's set-aside of the listed
      // files (a private copy kept). Prepublish itself only refused again (2026-10-27 blocker audit).
      action: error.details?.diagnosticAction?.command || error.details?.gate?.actions?.[0]?.command
        ? { command: error.details?.diagnosticAction?.command ?? error.details.gate.actions[0].command, skill: null,
          detail: `Phase ${phase.id} cannot publish these changes: take the route the refusal names, or move each listed file out of this step, then recheck.` }
        : { command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`, skill: '/sf-recover',
          detail: `Phase ${phase.id} cannot publish ${paths.length ? paths.slice(0, 5).join(', ') : 'these files'}: they are outside its documents. Move each out of the checkout, or set it aside with recovery (a person's step that keeps a private copy), then recheck. Editing the draft cannot clear this.` }
    };
  }
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
          : 'Open the code generation before changing source, then recheck.' });
    }
  }
  // A step that delivers no code meets its publication's change-scope refusal here, from the same
  // function: source a chore cannot publish was named only once `phase publish` refused it.
  const scope = !retained && !phaseRequiresCodeDelivery(phase)
    ? await changeScopeBlocker(root, config, workflow, phase) : null;
  if (scope) { blockers.push(scope.blocker); actions.push(scope.action); }
  // Constitution citations, checked against the Story's pin as publication checks them. Publication
  // refused an unknown article in enforce mode while prepublish said ready (2026-10-27 blocker audit).
  if (!retained && (workflow.resolution?.constitution?.mode ?? 'off') === 'enforce') {
    const [{ citedArticleIds, validateCitations }, { requiredRepoPath }] = await Promise.all([
      import('./constitution.mjs'), import('./story-state-validation.mjs')]);
    const relative = requiredRepoPath(config, workflow, phase);
    const text = await readFile(path.join(root, relative), 'utf8').catch(() => '');
    const citations = validateCitations(workflow.resolution?.constitutionPin ?? null, citedArticleIds(text), { label: `Phase ${phase.id}` });
    for (const message of citations.errors) {
      blockers.push({ code: 'constitution.citation-invalid', category: 'authoring', path: relative, line: null, message,
        details: { sourceCode: 'CONSTITUTION_CITATION_INVALID' } });
    }
  }
  const sourceId = pinned?.testEvidenceFrom;
  if (sourceId) {
    const source = workflow.phases?.[sourceId];
    let acceptedUnavailable = false;
    // A Code step carried by an accepted risk (TRP, or runs its approvers accepted could not
    // execute any test) is judged by the same gate the step itself will meet.
    if (source?.deliveryEvidence?.testRecovery
        || (source?.deliveryEvidence?.validation?.checks ?? []).some((check) => check?.testRunRisk)) {
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
 * What the final evaluation would refuse when this step ends the Story: submitting it runs that
 * evaluation, so its open obligations and their exact commands are named before publication, not
 * first by a refused submission. Advisory; null when the step does not end the Story.
 */
async function endingObligations(root, config, workflow, phase) {
  if (!(workflow.phaseOrder ?? []).includes(phase.id)) return null;
  const { endsStory, finalGatePreview } = await import('./upstream-entry-summary.mjs');
  if (endsStory(workflow, phase)) return finalGatePreview(root, config, workflow);
  // A decision route that ends the Story here: its own ending's applicability decisions.
  let pending;
  try {
    pending = (await import('./nextsteps.mjs')).endingApplicabilityDecisions(workflow, phase);
  } catch (error) {
    return { advisory: true, status: 'unavailable', reason: error?.code ?? 'evaluation-failed' };
  }
  return pending.length ? { advisory: true, status: 'blocked', blockers: pending.map((entry) => entry.message), more: 0,
    owners: [], recovery: pending.map((entry) => entry.command) } : null;
}

/**
 * Read-only, phase-scoped readiness projection for guided pre-publication repair.
 *
 * Draft-check owns authored Markdown and producer identity. Recovery adds known projection,
 * configuration, and code-delivery blockers. Neither is a substitute for the exact checks in the
 * publication transaction: tests and remote state can change after this read.
 */
export async function phasePrepublish(root, config, workflow, phase, options = {}) {
  const result = await computePhasePrepublish(root, config, workflow, phase, options);
  const { observeWorkflowTaskCheck, readWorkflowTaskResume } = await import('./workflow-task-store.mjs');
  await observeWorkflowTaskCheck(root, workflow, phase, result);
  const taskResume = await readWorkflowTaskResume(root, workflow, phase, { generation: result.generation,
    progress: { state: result.status === 'ready' ? 'publish-ready' : result.correction?.sameTurn ? 'repair-draft' : 'blocked',
      nextAction: result.commandGuidance?.next ?? result.commandGuidance?.publish } });
  return Object.freeze({ ...result, taskResume });
}

async function computePhasePrepublish(root, config, workflow, phase, options = {}) {
  await (await import('./document-runtime.mjs')).requirePhaseDocuments(root, config, workflow, phase.id);
  const draft = await phaseDraftCheck(root, config, workflow, phase, options);
  const scopeReview = await (await import('./scope/authoring.mjs')).scopeAuthoringCheckpoint(root, config, workflow, phase);
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
          detail: 'Recovery lists unstage-owned-paths for exactly these current-phase paths: apply it with its confirmed --apply command (their bytes stay on disk and publication stages them), or commit them yourself. Unrelated staged bytes stay untouched.' });
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
    && repairBlockers.every((entry) => findingOwnedByPhase(workflow, phase, entry)
      && phaseFindingPolicy(entry).repairableByProducer);
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
  const planningRepairCandidate = specificationChecks.evidenceRepair?.status === 'producer-repair'
    && specificationChecks.evidenceRepair.sourceSha256 === String(draft.artifact?.sha256 ?? '').replace(/^sha256:/u, '')
    && !retained && lifecycleReady && !hardBlocker && !repairDependencies.length && agentOwnsRepair
    && (ownedRecoveryRepair || draft.correction.sameTurn);
  const sameTurnCorrection = !retained && lifecycleReady && !ready && !hardBlocker && !repairDependencies.length
    && [...findings.values()].every(entry => findingOwnedByPhase(workflow, phase, entry))
    && ![...findings.values()].some(entry => phaseFindingPolicy(entry).classification === 'integrity-or-authority')
    && (draft.status !== 'ready' ? draft.correction.sameTurn
      : (briefOnly || authoringRepairOnly) && agentOwnsRepair);
  const planningRepairAllowed = planningRepairCandidate && sameTurnCorrection;
  const finalGate = lifecycleReady ? await endingObligations(root, config, workflow, phase) : null;
  const clauseOutlook = lifecycleReady ? await (await import('./evidence/clause-outlook.mjs')).clauseOutlookForStep(root, config, workflow, phase) : [];
  const { phaseResolutionProjection } = await import('./phase-resolution.mjs');
  // The same finding returning after the author changed something is a loop no repair can end:
  // say so, and hand it on [recoverable-findings M3]. Machine-local and advisory; nothing is accepted.
  let escalation = null;
  if (!ready && !retained && findings.size) {
    const { findingEscalation, findingFingerprint, observeFindingStreak, worktreeAttempt } = await import('./finding-escalation.mjs');
    const { DISPUTABLE_GATES } = await import('./phase-finding-dispute-schema.mjs');
    const blocking = [...findings.values()];
    const codes = blocking.map((finding) => phaseFindingCode(finding));
    const count = observeFindingStreak(root, { workId: workflow.workItem.id, phaseId: phase.id, generation: draft.generation,
      fingerprint: findingFingerprint(blocking), attempt: worktreeAttempt(root, draftFingerprint) });
    escalation = findingEscalation({ count, code: codes.find((code) => DISPUTABLE_GATES.includes(code)) ?? codes[0],
      workId: workflow.workItem.id, phaseId: phase.id });
  }
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
    authoringContract: phaseAuthoringContract(config, workflow, phase),
    producer: draft.producer,
    qualityDisposition: draft.qualityDisposition,
    acceptedQualityRisks: draft.acceptedQualityRisks,
    ...(draft.evidenceConsistency ? { evidenceConsistency: draft.evidenceConsistency } : {}),
    ownership: draft.ownership,
    draftFingerprint,
    artifact: draft.artifact,
    artifacts: draft.artifacts,
    findings: Object.freeze([...findings.values()].map((finding) => Object.freeze(finding))),
    resolution: phaseResolutionProjection(workflow, phase, [...findings.values()], {
      advisories: draft.advisories ?? [], transition: retained ? 'submit' : 'publish'
    }),
    repairLoop: escalation ? { ...(dependencies.repairLoop ?? {}), status: 'escalate', escalation, protocol: escalation.instruction }
      : dependencies.repairLoop,
    ...(escalation ? { escalation } : {}),
    ...(draftRepairAllowed ? { draftRepair: { allowed: true, scope: 'draft-only',
      heldEvidence: heldDraft.heldEvidence, publicationBlocked: true, evidenceAccepted: false,
      deferredFindingCodes: ['PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED'] } } : {}),
    // Carried through unchanged: advisories never enter findings or readiness.
    advisories: draft.advisories,
    scopeReview,
    ...(finalGate ? { finalGate: Object.freeze({ ...finalGate, submission: phase.id,
      blocksPublication: false }) } : {}),
    documentation: draft.documentation,
    coverage: draft.coverage,
    traceabilityRepair: draft.traceabilityRepair ? Object.freeze({
      ...draft.traceabilityRepair,
      sameTurn: sameTurnCorrection && draft.traceabilityRepair.sameTurn,
      actions: Object.freeze(draft.traceabilityRepair.actions.map((entry) => Object.freeze({
        ...entry, sameTurn: sameTurnCorrection && entry.sameTurn
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
    planningRepair: specificationChecks.planningContract ? Object.freeze({
      ...specificationChecks.planningContract, scope: 'current-draft',
      artifact: { path: draft.artifact.path, sha256: draft.artifact.sha256 },
      generation: draft.generation, mutates: false, previousPhasesEditable: false,
      sameTurn: sameTurnCorrection && agentOwnsRepair
        && specificationChecks.blockers.every(entry => phaseFindingPolicy(entry).repairableByProducer),
      // Diagnostic values are inert data. They cannot authorize patches or supply clause meaning.
      fields: specificationChecks.blockers.map(entry => ({ clauseId: entry.details?.clauseId ?? null,
        line: entry.line ?? null, field: entry.details?.field ?? null, code: entry.details?.sourceCode ?? entry.code }))
    }) : null,
    grounding: Object.freeze(dependencies.grounding),
    ...(clauseOutlook.length ? { clauseOutlook: Object.freeze(clauseOutlook) } : {}),
    warnings: Object.freeze([...dependencies.warnings, ...(scopeReview?.message ? [scopeReview.message] : []), ...clauseOutlook.map((entry) => entry.words),
      ...(finalGate?.status === 'blocked' ? [`Final evaluation: submitting ${phase.id} ends the Story and would be refused for ${finalGate.blockers.length + finalGate.more} open obligation(s) until each is resolved; this does not block publishing. See finalGate for each one and its command.`] : [])]),
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
      ...(testExecution.earlyChecks?.length ? { earlyChecks: testExecution.earlyChecks } : {}),
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
      sameTurn: sameTurnCorrection,
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

/** Canonical story state validation; legacy state exports delegate here. */
import { PROSPECTIVE_SKILL_AMENDMENT, committedResolutionPolicySha256, currentPhasePolicy, initialWorkflowRecord, resolutionPolicySha256, resolvedPhasePolicy } from "./story-policy-anchor.mjs";
import { branch } from "./git.mjs";
import { canonicalJson } from "./records.mjs";
import { currentPhase } from './kernel/phase-policy.mjs';
import { exists } from "./util.mjs";
import { isConvergencePhase } from "./kernel/phase-policy.mjs";
import { ledgerStatus, refreshLedgerRemoteView } from "./ledger.mjs";
import { normalizeContextPolicy } from "./context-policy.mjs";
import { normalizeLedgerConfig } from "./ledger-config.mjs";
import { normalizeSequenceGates, normalizeSessionPolicy, resolveWorkType } from "./config.mjs";
import { normalizeTokenEconomy } from "./token-economy.mjs";
import { default as path } from "node:path";
import { prospectiveTestCommandAmendment } from './test-command-amendment-contracts.mjs';
async function verifyAcceptedTestCommandAmendment(...args) { return (await import('./story-test-command-amendment.mjs')).verifyAcceptedTestCommandAmendment(...args); }
async function assertConvergencePublicationReady(...args) { return (await import('./convergence-context.mjs')).assertConvergencePublicationReady(...args); }
import { readConfigurationSource } from "./configuration-branch.mjs";
import { requiredArtifactRepoPath } from "./publication-preflight.mjs";
import { storyPublicationPending } from "./story-publication-read.mjs";
import { verifyWorkflowSnapshot } from "./workflow-snapshots.mjs";
import { workflowBranchAllowed } from "./story-paths.mjs";
async function validatePhase(...args) { return (await import('./state.mjs')).validatePhase(...args); }
async function verifyAcceptedSkillAmendmentRevalidation(...args) { return (await import('./state.mjs')).verifyAcceptedSkillAmendmentRevalidation(...args); }

export async function validateWorkflow(root, config, workflow, {
  strict = false, offline = false, reportWarnings = true
} = {}) {
  const errors = [], warnings = []; if (!workflowBranchAllowed(workflow, branch(root))) errors.push(`Current branch ${branch(root)} is not registered for Story ${workflow.workItem.id}.`);
  const prospective = PROSPECTIVE_SKILL_AMENDMENT.get(workflow) ?? prospectiveTestCommandAmendment(workflow);
  const prospectiveValid = Boolean(prospective
    && canonicalJson(prospective.reference) === canonicalJson(workflow.workflowSnapshot)
    && prospective.policySha256 === resolutionPolicySha256(workflow.resolution));
  const amendedRevision = Number(workflow.workflowSnapshot?.revision ?? 1) > 1;
  let workflowSnapshotStatus = null;
  try {
    // An accepted amendment is authority only when its complete append-only Git chain verifies.
    // The private prospective token applies solely to the aggregate owned by this transaction.
    workflowSnapshotStatus = await verifyWorkflowSnapshot(root, config, workflow,
      amendedRevision && !prospectiveValid ? { requireAccepted: true } : {});
    if (amendedRevision && !prospectiveValid) {
      await verifyAcceptedSkillAmendmentRevalidation(root, config, workflow,
        workflowSnapshotStatus);
      await verifyAcceptedTestCommandAmendment(root, config, workflow, workflowSnapshotStatus);
    }
    if (workflowSnapshotStatus.enrolled) {
      const initial = initialWorkflowRecord(root, config, workflow.workItem.id);
      const genesisReference = initial?.record?.workflowSnapshot ?? null;
      if (genesisReference && !amendedRevision
          && canonicalJson(genesisReference) !== canonicalJson(workflow.workflowSnapshot)) {
        errors.push('Workflow snapshot reference differs from the immutable Story creation commit.');
      }
      if (amendedRevision && !prospectiveValid
          && workflowSnapshotStatus.snapshotHash !== workflow.workflowSnapshot.snapshotHash) {
        errors.push('Story amendment differs from its accepted snapshot lineage tip.');
      }
    } else {
      warnings.push('Story has no captured WFA closure; portability is unproven.');
    }
  } catch (error) {
    errors.push(`Workflow snapshot: ${error.message}`);
  }
  const currentPolicySha256 = resolutionPolicySha256(workflow.resolution);
  let creationPolicySha256 = null;
  try {
    creationPolicySha256 = committedResolutionPolicySha256(root, config, workflow.workItem.id);
    if (creationPolicySha256 && creationPolicySha256 !== currentPolicySha256
        && !(amendedRevision && workflowSnapshotStatus?.enrolled)) {
      errors.push('Resolved Story policy differs from the immutable creation commit.');
    }
  } catch (error) {
    errors.push(`Story policy anchor: ${error.message}`);
  }
  if (workflow.resolution?.configurationSource) {
    try {
      const currentSource = await readConfigurationSource(root, { verify: true });
      const pinned = workflow.resolution.configurationSource;
      if (!currentSource || currentSource.commit !== pinned.commit
        || currentSource.repository !== pinned.repository) {
        const message = 'Current workspace configuration provenance differs from the accepted Story snapshot.';
        if (workflowSnapshotStatus?.enrolled) warnings.push(message);
        else errors.push(message);
      } else if (pinned.filesSha256 && currentSource.filesSha256 !== pinned.filesSha256) {
        // Only `commit` and `repository` used to be pinned, so the asset hash map could be rewritten
        // wholesale — change `approval.minimum`, repaste its hash — and both the self-check and this
        // comparison passed while the record still attested to the approved commit.
        const message = 'Current workspace configuration asset set differs from the accepted Story snapshot.';
        if (workflowSnapshotStatus?.enrolled) warnings.push(message);
        else errors.push(message);
      }
    } catch (error) {
      const message = `Current workspace configuration provenance is unavailable: ${error.message}`;
      if (workflowSnapshotStatus?.enrolled) warnings.push(message);
      else errors.push(message);
    }
  }
  if (workflow.resolution?.workType !== workflow.workItem.workType) errors.push('Work type differs from the immutable profile snapshot.');
  const resolvedOrder = workflow.resolution?.phases?.map((phase) => phase.id);
  if (resolvedOrder?.length && JSON.stringify(resolvedOrder) !== JSON.stringify(workflow.phaseOrder)) errors.push('Phase order differs from the immutable profile snapshot.');
  // A WFA-enrolled Story is interpreted from its verified, content-closed policy. Comparing it to
  // today's mutable workspace defaults would turn an ordinary configuration refresh into a false
  // lifecycle failure. Legacy Stories retain the old comparison because they have no closed input.
  if (!workflowSnapshotStatus?.enrolled && config.workTypes?.[workflow.workItem.workType]) {
    const expectedGates = resolveWorkType(config, workflow.workItem.workType).sequenceGates;
    const pinnedGates = normalizeSequenceGates(workflow.resolution?.sequenceGates ?? {});
    if (JSON.stringify(pinnedGates) !== JSON.stringify(expectedGates)) errors.push('Sequence gate policy differs from the immutable work-type configuration snapshot.');
    const expectedSession = normalizeSessionPolicy(config.session ?? {});
    const pinnedSession = normalizeSessionPolicy(workflow.resolution?.session ?? {});
    if (JSON.stringify(pinnedSession) !== JSON.stringify(expectedSession)) errors.push('Session agent policy differs from the immutable configuration snapshot.');
    const expectedContextPolicy = normalizeContextPolicy(config.contextPolicy ?? {}, { phaseIds: Object.keys(config.phases ?? {}) });
    const pinnedContextPolicy = normalizeContextPolicy(workflow.resolution?.contextPolicy ?? {});
    if (JSON.stringify(pinnedContextPolicy) !== JSON.stringify(expectedContextPolicy)) errors.push('Copilot context-boundary policy differs from the immutable configuration snapshot.');
    const expectedTokenEconomy = normalizeTokenEconomy(config.tokenEconomy ?? {});
    const pinnedTokenEconomy = normalizeTokenEconomy(workflow.resolution?.tokenEconomy ?? {});
    if (JSON.stringify(pinnedTokenEconomy) !== JSON.stringify(expectedTokenEconomy)) errors.push('Token-economy policy differs from the immutable configuration snapshot.');
  }
  let activeCount = 0;
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId]; if (!phase) { errors.push(`Missing phase ${phaseId}.`); continue; }
    if (creationPolicySha256) {
      const pinnedPhase = workflow.resolution?.phases?.find((candidate) => candidate.id === phaseId);
      if (!pinnedPhase) {
        errors.push(`Phase ${phaseId} has no immutable profile snapshot.`);
      } else if (Object.hasOwn(pinnedPhase, 'artifact')
        && canonicalJson(currentPhasePolicy(phase))
          !== canonicalJson(resolvedPhasePolicy(pinnedPhase, phase.order))) {
        errors.push(`Phase ${phaseId} operational policy differs from the immutable profile snapshot.`);
      }
    }
    if (['in_progress', 'awaiting_approval'].includes(phase.status)) activeCount += 1;
    if (phase.status === 'approved' && !(await exists(path.join(root, requiredRepoPath(config, workflow, phase))))) errors.push(`Approved artifact missing: ${requiredRepoPath(config, workflow, phase)}`);
  }
  if (workflow.pendingDecision && workflow.status !== 'in_progress') errors.push(`A ${workflow.status} workflow cannot wait for a decision.`);
  if (workflow.status === 'closed') { if (workflow.currentPhase !== null) errors.push('Closed workflow must have currentPhase null.'); if (activeCount) errors.push('Closed workflow cannot have an active phase.'); }
  else if (workflow.status === 'cancelled') {
    if (workflow.currentPhase !== null) errors.push('Cancelled workflow must have currentPhase null.');
    if (activeCount) errors.push('Cancelled workflow cannot have an active phase.');
    if (!workflow.cancellation?.reason?.trim()) errors.push('Cancelled workflow must record a cancellation reason.');
    if (!workflow.cancellation?.cancelledAt || !workflow.cancellation?.cancelledBy) errors.push('Cancelled workflow must record when and by whom it was cancelled.');
    // Cancelled while a decision waited after an approved step: that step stays approved (2026-10-28).
    const cancelledPhaseStatuses = workflow.cancellation?.pendingDecision ? ['cancelled', 'approved'] : ['cancelled'];
    if (!workflow.cancellation?.phase || !cancelledPhaseStatuses.includes(workflow.phases[workflow.cancellation.phase]?.status)) errors.push('Cancelled workflow must identify its cancelled phase.');
  } else if (workflow.pendingDecision) {
    // Waiting for a person: the phase before the decision is approved and stays current, and
    // nothing is active until someone chooses what happens next.
    if (workflow.currentPhase !== workflow.pendingDecision.after
        || workflow.phases[workflow.pendingDecision.after]?.status !== 'approved') {
      errors.push('A pending decision must follow the approved current phase.');
    }
    if (activeCount) errors.push(`A Story waiting for a decision cannot have an active phase; found ${activeCount}.`);
  } else { if (!workflow.currentPhase) errors.push('In-progress workflow must have a current phase.'); if (activeCount !== 1) errors.push(`In-progress workflow must have exactly one active phase; found ${activeCount}.`); }
  const active = currentPhase(workflow);
  if (strict && active && active.status === 'awaiting_approval') {
    if (isConvergencePhase(active)) {
      try { await assertConvergencePublicationReady(root, config, workflow, active); }
      catch (error) { errors.push(`Convergence publication integrity: ${error.message}`); }
    }
    errors.push(...await validatePhase(root, config, workflow, active, {
      placeholders: !isConvergencePhase(active),
      content: true
    }));
  }
  // Validation reports; it does not migrate. The enforcement paths that gate a mutation still do.
  if (await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false })) errors.push('Publication is pending; run singularity-flow sync.');
  const ledgerConfig = normalizeLedgerConfig(workflow.resolution?.ledger ?? config.ledger ?? {});
  // Only an enforced ledger turns its health into errors. A caller that discards warnings
  // (publication) gets nothing from the all-Stories health report otherwise: every remote Story
  // branch's intents, the whole ledger verified and its whole log read, about 33 Git processes per
  // publication. It keeps the remote state refresh the report starts with.
  const ledgerBlocks = ledgerConfig.enforcement === 'required' || ledgerConfig.behind === 'block';
  if (ledgerConfig.enabled && !reportWarnings && !ledgerBlocks) {
    try { await refreshLedgerRemoteView(root, ledgerConfig, { offline }); } catch { /* only ever a warning */ }
  } else if (ledgerConfig.enabled) {
    try {
      const ledger = await ledgerStatus(root, ledgerConfig, { offline });
      const messages = [];
      if (!ledger.initialized) messages.push(`Capability ledger branch '${ledgerConfig.branch}' is not initialized.`);
      if (ledger.verification && !ledger.verification.valid) messages.push(...ledger.verification.errors.map((message) => `Capability ledger: ${message}`));
      if (ledger.pending?.length) messages.push(`${ledger.pending.length} durable ledger intent(s) are pending reconciliation.`);
      if (ledgerConfig.enforcement === 'required' || ledgerConfig.behind === 'block') errors.push(...messages);
      else warnings.push(...messages);
    } catch (error) {
      const message = `Capability ledger could not be verified: ${error.message}`;
      if (ledgerConfig.enforcement === 'required' || ledgerConfig.behind === 'block') errors.push(message);
      else warnings.push(message);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function requiredRepoPath(config, workflow, phase) { return requiredArtifactRepoPath(config, workflow, phase); }

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists, SingularityFlowError } from './util.mjs';
import {
  validateArchitectureIntent, validateArchitectureIntentFulfilment
} from './world-model/projections/calm/projection.mjs';
import {
  architectureIntentApprovalStatus, assertApprovedArchitectureIntent,
  assertArchitectureIntentReportMatches, evaluateArchitectureIntentEvidence,
  resolveArchitectureIntentPublicationBinding
} from './architecture-intent-service.mjs';
import { canonicalJson } from './world-model/canonicalize.mjs';
import { resolveStoryExecutionDefinition } from './story-execution-context.mjs';

const EMPTY = Object.freeze({
  applies: false, errors: [], warnings: [], passes: [], code: null, reasonCodes: [],
  architectureDecision: null, authorityObservationCommit: null
});

function gateResult({
  applies = true, errors = [], warnings = [], passes = [], reasonCodes = [],
  architectureDecision = null, authorityObservationCommit = null
}) {
  const uniqueReasons = [...new Set(reasonCodes.filter(Boolean))];
  return Object.freeze({
    applies,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    passes: Object.freeze(passes),
    code: uniqueReasons[0] ?? null,
    reasonCodes: Object.freeze(uniqueReasons),
    architectureDecision: errors.length ? null : architectureDecision,
    // The stable decision binds the WMB publication commit. The mutable state tip remains a
    // separate operation-scoped observation so a ref move *during* validation is still detected
    // without making later unrelated Story ledger writes invalidate unchanged model evidence.
    authorityObservationCommit
  });
}

function policyFor(definition, workflow) {
  return workflow?.resolution?.architectureIntent ?? definition?.architectureIntent ?? {
    enabled: false, allowedPhases: [], blockRequiredUnfulfilledAt: []
  };
}

function storyArchitecturePath(root, definition, workflow, name) {
  const workItemRoot = workflow?.resolution?.workItemRoot
    ?? definition?.workItemRoot ?? 'singularity/work-items';
  return path.join(root, workItemRoot, workflow.workItem.id, 'context', 'architecture', name);
}

async function jsonFile(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

export { architectureIntentApprovalStatus, assertApprovedArchitectureIntent };

/**
 * Canonical identity of the architecture decision used at a lifecycle boundary. Presentation
 * strings are retained because a changed refusal is also a changed decision; object ordering is
 * removed so every host compares the same bytes.
 */
export function architectureIntentGateIdentity(result) {
  return canonicalJson({
    applies: result?.applies === true,
    errors: [...(result?.errors ?? [])],
    warnings: [...(result?.warnings ?? [])],
    passes: [...(result?.passes ?? [])],
    reasonCodes: [...(result?.reasonCodes ?? [])],
    architectureDecision: result?.architectureDecision ?? null,
    authorityObservationCommit: result?.authorityObservationCommit ?? null
  });
}

/**
 * Capture everything architecture-sensitive that one publication or submission is about to
 * accept. The returned canonical value is safe to compare before and after isolated Git staging.
 */
export async function architectureIntentStabilityIdentity(
  root, definition, workflow, phase, generation = phase?.generation,
  { candidateSnapshot = null } = {}
) {
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  if (!phase) return canonicalJson({ phase: null, generation: null, gate: EMPTY, intent: null });
  const gate = await evaluateArchitectureIntentGate(
    root, definition, workflow, phase.id, { candidateSnapshot }
  );
  const intent = await resolveArchitectureIntentPublicationBinding(
    root, definition, workflow, phase, generation
  );
  return canonicalJson({
    phase: phase.id,
    generation: Number(generation),
    gate: JSON.parse(architectureIntentGateIdentity(gate)),
    intent
  });
}

/**
 * Freeze and later re-check the architecture inputs accepted by one publication boundary.
 *
 * The Story lock serializes SFlow writers, but it cannot stop an editor or a state-ref refresh from
 * changing intent/source bytes after lifecycle validation. The isolated-commit stability hook calls
 * this guard immediately before and after staging, so either observation changing aborts rather than
 * committing a decision over different evidence.
 */
export async function createArchitectureIntentStabilityGuard(
  root, definition, workflow, phase, generation = phase?.generation,
  { candidateSnapshot = null, operation = 'governed publication' } = {}
) {
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  const expected = await architectureIntentStabilityIdentity(
    root, definition, workflow, phase, generation, { candidateSnapshot }
  );
  return async () => {
    let current;
    try {
      current = await architectureIntentStabilityIdentity(
        root, definition, workflow, phase, generation, { candidateSnapshot }
      );
    } catch (error) {
      // The initial observation above remains authoritative for ordinary readiness errors. Once
      // that observation succeeded, however, losing any of its Story/source/state inputs during
      // the publication window is a concurrency change, not permission to surface a different
      // gate result from mixed revisions. Keep diagnostics bounded and make the retry contract
      // consistent with an identity change that can still be represented canonically.
      throw new SingularityFlowError(
        `Architecture intent evidence became unavailable after validation and before ${operation}. Nothing was committed; retry against the current evidence.`,
        {
          code: 'PUBLICATION_SNAPSHOT_CHANGED',
          details: {
            causeCode: error?.code ?? null,
            nextAction: 'Retry the lifecycle action against one current Story, source, and state authority observation.'
          }
        }
      );
    }
    if (current !== expected) {
      throw new SingularityFlowError(
        `Architecture intent evidence changed after validation and before ${operation}. Nothing was committed; retry against the current evidence.`,
        { code: 'PUBLICATION_SNAPSHOT_CHANGED' }
      );
    }
    return current;
  };
}

/** Bounded Story architecture status for read-only lifecycle and IDE projections. */
export async function projectArchitectureIntentStatus(root, definition, workflow) {
  if (!workflow?.workItem?.id) return null;
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  const policy = policyFor(definition, workflow);
  const intentPath = storyArchitecturePath(root, definition, workflow, 'architecture-intent.json');
  const base = {
    workId: workflow.workItem.id,
    enabled: policy.enabled === true,
    present: false,
    status: policy.enabled === true ? 'absent' : 'disabled',
    phase: null,
    generation: null,
    approved: false,
    reasons: [],
    fulfilment: null
  };
  if (!(await exists(intentPath))) return Object.freeze(base);
  let intent;
  try { intent = validateArchitectureIntent(await jsonFile(intentPath)); }
  catch (error) {
    return Object.freeze({
      ...base, present: true, status: 'invalid', reasons: Object.freeze([error.message])
    });
  }
  const reasons = [];
  if (!policy.enabled) reasons.push('architecture intent is disabled by the pinned Story policy');
  if (intent.workId !== workflow.workItem.id) reasons.push('architecture intent belongs to another Work ID');
  if (!policy.allowedPhases?.includes(intent.phase)) {
    reasons.push(`architecture intent phase '${intent.phase}' is not allowed by the pinned Story policy`);
  }
  const approval = await architectureIntentApprovalStatus(
    root, definition, workflow, intent, intentPath
  );
  reasons.push(...approval.errors);
  let fulfilment = null;
  const reportPath = storyArchitecturePath(root, definition, workflow, 'intent-fulfilment.json');
  if (await exists(reportPath)) {
    try {
      const report = validateArchitectureIntentFulfilment(await jsonFile(reportPath));
      const current = report.workId === workflow.workItem.id
        && report.intentSha256 === intent.intentSha256
        && report.baseBeforeSha256 === intent.base.calmProjectionSha256;
      const verdictCounts = Object.fromEntries(
        ['fulfilled', 'missing', 'deviated', 'unplanned', 'not-observable'].map((verdict) => [
          verdict, report.clauses.filter((clause) => clause.verdict === verdict).length
        ])
      );
      fulfilment = Object.freeze({
        status: current ? 'recorded-unverified' : 'stale',
        blocking: true,
        reportedBlocking: report.blocking,
        reportSha256: report.reportSha256,
        baseAfterSha256: report.baseAfterSha256,
        counts: Object.freeze(verdictCounts)
      });
    } catch (error) {
      fulfilment = Object.freeze({
        status: 'invalid', blocking: true, reportSha256: null,
        counts: Object.freeze({}), reason: error.message
      });
    }
  }
  const approved = reasons.length === 0;
  return Object.freeze({
    ...base,
    present: true,
    status: !policy.enabled ? 'disabled' : approved ? 'approved' : 'candidate',
    phase: intent.phase,
    generation: intent.generation,
    approved,
    reasons: Object.freeze(reasons),
    fulfilment
  });
}

/**
 * Verify an opted-in Story architecture intent immediately before a configured lifecycle gate.
 *
 * Absence of an intent is not architecture impact and therefore does not create work. Once an
 * intent exists, however, its exact fulfilment receipt must describe the current reusable state
 * projection; an old or blocking receipt can never be carried through verification or release.
 */
export async function evaluateArchitectureIntentGate(
  root, definition, workflow, phaseId, { candidateSnapshot = null } = {}
) {
  definition = await resolveStoryExecutionDefinition(root, definition, workflow);
  const policy = policyFor(definition, workflow);
  if (!policy.enabled || !policy.blockRequiredUnfulfilledAt?.includes(phaseId)) return EMPTY;
  const intentPath = storyArchitecturePath(root, definition, workflow, 'architecture-intent.json');
  if (!(await exists(intentPath))) return EMPTY;

  const errors = [];
  const reasonCodes = [];
  let intent;
  try { intent = validateArchitectureIntent(await jsonFile(intentPath)); }
  catch (error) {
    return gateResult({
      errors: [`architecture intent is invalid: ${error.message}`],
      reasonCodes: [error.code ?? 'WMC_INTENT_UNFULFILLED']
    });
  }
  if (intent.workId !== workflow.workItem.id) {
    errors.push('architecture intent belongs to another Work ID');
    reasonCodes.push('WMC_INTENT_INVALID');
  }
  if (!policy.allowedPhases?.includes(intent.phase)) {
    errors.push(`architecture intent phase '${intent.phase}' is not allowed by the pinned Story policy`);
    reasonCodes.push('WMC_INTENT_POLICY_INVALID');
  }
  const approval = await architectureIntentApprovalStatus(
    root, definition, workflow, intent, intentPath
  );
  errors.push(...approval.errors);
  if (!approval.approved) reasonCodes.push('WMC_INTENT_NOT_APPROVED');

  const reportPath = storyArchitecturePath(root, definition, workflow, 'intent-fulfilment.json');
  if (!(await exists(reportPath))) {
    errors.push(`architecture intent has no fulfilment receipt; run singularity-flow architecture intent verify --work-id ${workflow.workItem.id}`);
    reasonCodes.push('WMC_INTENT_UNFULFILLED');
    return gateResult({ errors, reasonCodes });
  }
  let report;
  try { report = validateArchitectureIntentFulfilment(await jsonFile(reportPath)); }
  catch (error) {
    errors.push(`architecture intent fulfilment is invalid: ${error.message}`);
    reasonCodes.push(error.code ?? 'WMC_INTENT_UNFULFILLED');
    return gateResult({ errors, reasonCodes });
  }
  if (report.workId !== workflow.workItem.id || report.intentSha256 !== intent.intentSha256
      || report.baseBeforeSha256 !== intent.base.calmProjectionSha256) {
    errors.push('architecture intent fulfilment does not bind the pinned Story intent and base');
    reasonCodes.push('WMC_INTENT_REPORT_MISMATCH');
  }

  let evaluation = null;
  try {
    evaluation = await evaluateArchitectureIntentEvidence(
      root, definition, workflow, intent, { intentPath, candidateSnapshot }
    );
    assertArchitectureIntentReportMatches(report, evaluation.report);
  } catch (error) {
    const code = error?.code ? ` [${error.code}]` : '';
    errors.push(`the current architecture intent evidence cannot be verified${code}: ${error.message}`);
    reasonCodes.push(error?.code ?? 'WMC_INTENT_UNFULFILLED');
  }

  const evaluated = evaluation?.report ?? report;
  const verdicts = new Map(evaluated.clauses.map((clause) => [clause.clauseId, clause.verdict]));
  for (const clause of intent.clauses.filter((entry) => entry.required)) {
    const verdict = verdicts.get(clause.clauseId);
    if (verdict !== 'fulfilled') {
      errors.push(`required architecture clause ${clause.clauseId} is ${verdict ?? 'missing from the fulfilment receipt'}`);
    }
  }
  if (evaluated.blocking && !errors.some((message) => message.includes('required architecture clause'))) {
    errors.push('architecture intent fulfilment remains blocking');
  }
  if (evaluated.blocking) reasonCodes.push('WMC_INTENT_UNFULFILLED');
  return gateResult({
    errors,
    reasonCodes,
    passes: errors.length ? [] : [`architecture intent fulfilled: ${evaluation.report.reportSha256.slice(0, 19)}`],
    architectureDecision: evaluation?.decision ?? null,
    authorityObservationCommit: evaluation?.store?.commit ?? null
  });
}

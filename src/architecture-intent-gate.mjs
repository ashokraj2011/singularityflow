import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exists, run, SingularityFlowError } from './util.mjs';
import { canonicalJson } from './world-model/canonicalize.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
import {
  validateArchitectureIntent, validateArchitectureIntentFulfilment
} from './world-model/projections/calm/projection.mjs';
import {
  assertCurrentArchitectureProjection, resolveCurrentArchitectureProjectionInputs
} from './world-model/projections/calm/authority.mjs';
import { resolvePublishedWorldModelV4 } from './world-model/store.mjs';

const EMPTY = Object.freeze({ applies: false, errors: [], warnings: [], passes: [] });

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

/** Classify whether this exact intent is durable evidence of an approved phase generation. */
export function architectureIntentApprovalStatus(root, workflow, intent, intentPath) {
  const errors = [];
  const intentPhase = workflow.phases?.[intent.phase];
  let approval = null;
  if (!intentPhase) {
    errors.push(`architecture intent phase '${intent.phase}' is not present in the pinned Story workflow`);
  } else {
    approval = (intentPhase.approvals ?? []).find((candidate) =>
      candidate.decision === 'approved'
      && !candidate.invalidatedAt
      && Number(candidate.generation) === Number(intent.generation));
    if (!approval) {
      errors.push(
        `architecture intent generation ${intent.generation} is not approved in phase '${intent.phase}'`
      );
    }
  }
  if (approval) {
    const evidenceCommit = String(approval.evidenceCommit ?? '');
    const relativeIntentPath = path.relative(root, intentPath).replaceAll('\\', '/');
    if (!/^[a-f0-9]{40,64}$/.test(evidenceCommit)) {
      errors.push('architecture intent approval has no exact evidence commit');
    } else {
      const committed = run('git', ['show', `${evidenceCommit}:${relativeIntentPath}`], {
        cwd: root, allowFailure: true
      });
      if (committed.status !== 0) {
        errors.push('architecture intent was not present in its approval evidence commit');
      } else {
        try {
          const approvedIntent = validateArchitectureIntent(JSON.parse(committed.stdout));
          if (approvedIntent.intentSha256 !== intent.intentSha256
              || committed.stdout !== canonicalJson(intent)) {
            errors.push('architecture intent bytes changed after their phase approval');
          }
        } catch {
          errors.push('architecture intent in the approval evidence commit is invalid');
        }
      }
    }
  }
  return Object.freeze({ approved: errors.length === 0, approval, errors: Object.freeze(errors) });
}

/** Refuse governed planned/fulfilment products until the exact intent bytes are approved. */
export function assertApprovedArchitectureIntent(root, workflow, intent, intentPath) {
  const status = architectureIntentApprovalStatus(root, workflow, intent, intentPath);
  if (!status.approved) {
    throw new SingularityFlowError(
      'Architecture intent is still a candidate and cannot produce a governed planned or fulfilment view.',
      {
        code: 'WMC_INTENT_NOT_APPROVED',
        details: {
          reasons: status.errors,
          nextAction: `Publish and approve phase '${intent.phase}' generation ${intent.generation}, then retry.`
        }
      }
    );
  }
  return status;
}

/** Bounded Story architecture status for read-only lifecycle and IDE projections. */
export async function projectArchitectureIntentStatus(root, definition, workflow) {
  if (!workflow?.workItem?.id) return null;
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
  const approval = architectureIntentApprovalStatus(root, workflow, intent, intentPath);
  reasons.push(...approval.errors);
  let fulfilment = null;
  const reportPath = storyArchitecturePath(root, definition, workflow, 'intent-fulfilment.json');
  if (await exists(reportPath)) {
    try {
      const report = validateArchitectureIntentFulfilment(await jsonFile(reportPath));
      const current = report.workId === workflow.workItem.id
        && report.intentSha256 === intent.intentSha256;
      const verdictCounts = Object.fromEntries(
        ['fulfilled', 'missing', 'deviated', 'unplanned', 'not-observable'].map((verdict) => [
          verdict, report.clauses.filter((clause) => clause.verdict === verdict).length
        ])
      );
      fulfilment = Object.freeze({
        status: current ? (report.blocking ? 'recorded-blocking' : 'recorded-satisfied') : 'stale',
        blocking: current ? report.blocking : true,
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
export async function evaluateArchitectureIntentGate(root, definition, workflow, phaseId) {
  const policy = policyFor(definition, workflow);
  if (!policy.enabled || !policy.blockRequiredUnfulfilledAt?.includes(phaseId)) return EMPTY;
  const intentPath = storyArchitecturePath(root, definition, workflow, 'architecture-intent.json');
  if (!(await exists(intentPath))) return EMPTY;

  const errors = [];
  let intent;
  try { intent = validateArchitectureIntent(await jsonFile(intentPath)); }
  catch (error) {
    return { applies: true, errors: [`architecture intent is invalid: ${error.message}`], warnings: [], passes: [] };
  }
  if (intent.workId !== workflow.workItem.id) errors.push('architecture intent belongs to another Work ID');
  if (!policy.allowedPhases?.includes(intent.phase)) {
    errors.push(`architecture intent phase '${intent.phase}' is not allowed by the pinned Story policy`);
  }
  errors.push(...architectureIntentApprovalStatus(root, workflow, intent, intentPath).errors);

  const reportPath = storyArchitecturePath(root, definition, workflow, 'intent-fulfilment.json');
  if (!(await exists(reportPath))) {
    errors.push(`architecture intent has no fulfilment receipt; run singularity-flow architecture intent verify --work-id ${workflow.workItem.id}`);
    return { applies: true, errors, warnings: [], passes: [] };
  }
  let report;
  try { report = validateArchitectureIntentFulfilment(await jsonFile(reportPath)); }
  catch (error) {
    errors.push(`architecture intent fulfilment is invalid: ${error.message}`);
    return { applies: true, errors, warnings: [], passes: [] };
  }
  if (report.workId !== workflow.workItem.id || report.intentSha256 !== intent.intentSha256
      || report.baseBeforeSha256 !== intent.base.calmProjectionSha256) {
    errors.push('architecture intent fulfilment does not bind the pinned Story intent and base');
  }

  try {
    const authority = worldModelStateAuthority(definition, {});
    const store = resolvePublishedWorldModelV4(root, {
      outputDir: workflow.resolution?.worldModelOutputDir
        ?? definition.worldModel?.outputDir ?? 'singularity/world-model',
      stateBranch: authority.branch, remote: authority.remote
    });
    assertCurrentArchitectureProjection(
      store, await resolveCurrentArchitectureProjectionInputs(root, definition)
    );
    const current = store.projections?.find((entry) => entry.projectionId === 'arch.calm'
      && entry.status === 'available');
    if (!current) errors.push('the current reusable World Model has no available arch.calm projection');
    else if (report.baseAfterSha256 !== current.projectionSha256) {
      errors.push(`architecture intent fulfilment is stale for the current projection ${current.projectionSha256}`);
    }
  } catch (error) {
    errors.push(`the current reusable architecture projection cannot be verified: ${error.message}`);
  }

  const verdicts = new Map(report.clauses.map((clause) => [clause.clauseId, clause.verdict]));
  for (const clause of intent.clauses.filter((entry) => entry.required)) {
    const verdict = verdicts.get(clause.clauseId);
    if (verdict !== 'fulfilled') {
      errors.push(`required architecture clause ${clause.clauseId} is ${verdict ?? 'missing from the fulfilment receipt'}`);
    }
  }
  if (report.blocking && !errors.some((message) => message.includes('required architecture clause'))) {
    errors.push('architecture intent fulfilment remains blocking');
  }
  return {
    applies: true,
    errors,
    warnings: [],
    passes: errors.length ? [] : [`architecture intent fulfilled: ${report.reportSha256.slice(0, 19)}`]
  };
}

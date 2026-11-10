/**
 * A person's accepted risk on a failed visual comparison [PHR:REQ-006, REQ-007], owner decision 2026-11-10.
 *
 * A failed comparison stays in the visual evidence for good: a later passing one does not supersede it, so
 * no step could repair it once recorded, and the ending refused it (gate.visual.threshold). The owner chose
 * the way out: an approver of the visual verification step accepts its risk, in their own terminal, with an
 * expiry and a reason, bound to that exact comparison. It settles the comparison for that step's approval
 * and for the ending; a different or changed comparison is not covered. The visual step's approval holds a
 * failed comparison nobody accepted, with this decision as its route, so the ending finds nothing new.
 *
 * Recorded like a dated risk on an obligation (evidence/risk-decisions.mjs): append-only on the Story, the
 * same expiry and reason rules. The records are pure; the check reads the comparisons the ending reads.
 */
import { MAX_RISK_DAYS } from './evidence/risk-decisions.mjs';
import { ownerStepChecks, visualVerificationPhaseOf } from './phase-roles.mjs';
import { countedRecords } from './presence/counted.mjs';
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

const DAY = 24 * 60 * 60 * 1000;
const refused = (message, details = undefined) => {
  throw new SingularityFlowError(message, { code: 'VISUAL_RISK_INVALID', ...(details ? { details } : {}) });
};

/** The exact comparison a decision accepts: its recorded result, without where it was read from. */
export function comparisonDigest(comparison) {
  const { path: _path, ...record } = comparison ?? {};
  return `sha256:${recordSha256(record)}`;
}

/** Whether a comparison fails the policy's thresholds, as the ending reads it. */
export function comparisonFails(workflow, comparison) {
  return !comparison?.unreadable && comparison?.status === 'fail' && workflow?.resolution?.verification?.comparison?.mode === 'enforce';
}

/** The decision that carries this exact comparison at `at`, or null. */
export function activeVisualRisk(workflow, comparison, { at = new Date().toISOString() } = {}) {
  const digest = comparisonDigest(comparison);
  const decision = [...countedRecords(workflow, workflow?.visualRiskDecisions)].reverse()
    .find((entry) => entry.comparisonId === comparison?.id) ?? null;
  if (!decision || decision.comparisonSha256 !== digest) return null;
  return new Date(decision.expiresAt) > new Date(at) ? decision : null;
}

/** Record a decision on the aggregate; the caller found the comparison and checked the person's authority over `phase`. */
export function recordVisualRisk(workflow, { comparison, phase, expires, reason, actor, authorityGroup, identityAssurance = null, at }) {
  // Each refusal names the decision as it can be made [PHR:REQ-006].
  const status = { command: 'singularity-flow visual status --json', label: 'See the recorded comparisons and which of them fail.' };
  if (!comparison) refused('Name a recorded visual comparison with --comparison (singularity-flow visual status lists them).', { nextAction: status });
  if (!comparisonFails(workflow, comparison)) {
    refused(comparison.unreadable
      ? `${comparison.id} cannot be read, so its risk cannot be accepted: an unreadable record is an integrity failure; restore it.`
      : `${comparison.id} does not fail this Story's enforced thresholds; there is no risk to accept.`, { comparison: comparison.id, nextAction: status });
  }
  const again = { command: visualRiskCommand(workflow, comparison), label: `Accept the risk of ${comparison.id} with a date and a reason.` };
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? new Date(`${expires}T23:59:59.999Z`) : null;
  const now = new Date(at);
  if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= now || expiry - now > MAX_RISK_DAYS * DAY) {
    refused(`--expires must be a date after today and at most ${MAX_RISK_DAYS} days ahead (YYYY-MM-DD).`, { nextAction: again });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) refused('Say why the risk is acceptable in 20 to 1000 characters with --reason.', { nextAction: again });
  workflow.visualRiskDecisions ??= [];
  const record = { id: `VRK-${String(workflow.visualRiskDecisions.length + 1).padStart(3, '0')}`, comparisonId: comparison.id,
    comparisonSha256: comparisonDigest(comparison), profileId: comparison.profileId ?? null, phase,
    expiresAt: expiry.toISOString(), reason: text, actor, authorityGroup, identityAssurance, at };
  workflow.visualRiskDecisions.push(record);
  return record;
}

/** The command an approver of the visual step runs, in their own terminal, to accept one comparison's risk. */
export function visualRiskCommand(workflow, comparison) {
  return `singularity-flow decision visual-risk ${workflow.workItem.id} --comparison ${comparison.id} --expires <YYYY-MM-DD> --reason <why>`;
}

/**
 * The visual verification step's approval refusal for a failed comparison nobody accepted, or null: the same
 * comparisons, the same thresholds, the same accepted risks the ending reads. Only for a Story that pinned the
 * owner-step checks at level 2; one pinned before keeps its policy, and the ending's acceptance still applies.
 */
export async function visualThresholdRefusal(root, config, workflow, phase, { comparisons = null } = {}) {
  if (!ownerStepChecks(workflow, 2) || visualVerificationPhaseOf(workflow, null)?.id !== phase?.id) return null;
  const listed = comparisons ?? await (async () => {
    const [{ listVisualComparisons }, { workDir }] = await Promise.all([import('./visual-compare.mjs'), import('./story-paths.mjs')]);
    return listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  })();
  const open = listed.filter((comparison) => comparisonFails(workflow, comparison) && !activeVisualRisk(workflow, comparison));
  if (!open.length) return null;
  const routes = open.slice(0, 5).map((comparison) => ({ command: visualRiskCommand(workflow, comparison),
    label: `An approver of ${phase.id} accepts the risk of ${comparison.id} in their own terminal, with an expiry and a reason.` }));
  return new SingularityFlowError(
    `Phase '${phase.id}' cannot be approved while ${open.length} visual comparison(s) exceed the Story's thresholds and nobody accepted their risk:\n- `
    + open.map((comparison) => `${comparison.id} (${comparison.profileId ?? 'unprofiled'}): ${comparison.disposition ?? 'failed'}`).join('\n- ')
    + '\nA failed comparison stays in the evidence; an approver of this step accepts its risk, and the Story\'s ending reads the same decision.',
    { code: 'VISUAL_THRESHOLD_EXCEEDED', details: { workId: workflow.workItem.id, phase: phase.id, ownerPhase: phase.id,
      comparisons: open.slice(0, 20).map((comparison) => ({ id: comparison.id, profileId: comparison.profileId ?? null, path: comparison.path ?? null })),
      nextAction: routes[0], recoveryCommands: routes.slice(1) } }
  );
}

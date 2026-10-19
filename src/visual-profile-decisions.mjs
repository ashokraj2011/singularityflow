/**
 * Screen sizes that do not apply to a Story: a person's recorded decision.
 *
 * A workflow lists the verification profiles (screen sizes) its visual step checks, and enforced
 * coverage needs a current screenshot for every one. A Story may not ship to some of them: a
 * phone-only app has no tablet layout to capture. A person in the group that approves the visual
 * step may record that one profile does not apply to this Story, with a reason. Coverage then lists
 * that profile as not applicable, naming the reason, who decided and the decision, and never as
 * passed; a warning says it is an exception. At least one profile must still be evidenced.
 * Decisions and revocations are append-only in `workflow.visualProfileDecisions`; a revocation
 * makes the profile required again. Pure.
 */
import { activeVisualProfileDecisions, nativeCaptureCommand, profilePixelSize, visualProfileDecisionCommand } from './visual-coverage.mjs';
import { SingularityFlowError } from './util.mjs';

const DECISION_ID = /^VPD-[0-9]{3,}$/u;

function reasonText(reason, what) {
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) {
    throw new SingularityFlowError(`Say ${what} in 20 to 1000 characters with --reason.`, { code: 'VISUAL_PROFILE_DECISION_INVALID' });
  }
  return text;
}

/** The decision with this ID (never a revocation), or null. */
export function visualProfileDecision(workflow, decisionId) {
  return (workflow?.visualProfileDecisions ?? []).find((entry) => !entry.revokes && entry.id === decisionId) ?? null;
}

/**
 * Why this profile cannot be marked not applicable for the step now, as a coded refusal: the step
 * does not configure it, it already is, or it is the last profile left to evidence.
 */
export function assertVisualProfileDecidable(workflow, { phaseId, profileId }) {
  const profiles = workflow?.resolution?.verification?.profiles ?? [];
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new SingularityFlowError(`${phaseId} does not check a verification profile '${profileId}'; it checks ${profiles.map((entry) => entry.id).join(', ') || 'none'}.`, {
      code: 'VISUAL_PROFILE_UNKNOWN', details: { phase: phaseId, profileId, profiles: profiles.map((entry) => entry.id) }
    });
  }
  const active = activeVisualProfileDecisions(workflow, phaseId);
  if (active.has(profileId)) {
    throw new SingularityFlowError(`${profileId} is already not applicable for this Story (${active.get(profileId).id}); revoke that decision first to decide it again.`, {
      code: 'VISUAL_PROFILE_ALREADY_DECIDED', details: { phase: phaseId, profileId, decisionId: active.get(profileId).id }
    });
  }
  const remaining = profiles.filter((entry) => entry.id !== profileId && !active.has(entry.id));
  if (!remaining.length) {
    throw new SingularityFlowError(`${profileId} is the only verification profile of ${phaseId} still to be evidenced; at least one screen size must have a screenshot, so it cannot be marked not applicable.`, {
      code: 'VISUAL_PROFILE_LAST_REQUIRED', details: { phase: phaseId, profileId, notApplicable: [...active.keys()].sort() }
    });
  }
  return profile;
}

/** Record a not-applicable decision on the aggregate; the caller checked the step and authority. */
export function recordVisualProfileDecision(workflow, { phaseId, profileId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const profile = assertVisualProfileDecidable(workflow, { phaseId, profileId });
  const text = reasonText(reason, `why ${profileId} does not apply to this Story`);
  workflow.visualProfileDecisions ??= [];
  const decision = {
    id: `VPD-${String(workflow.visualProfileDecisions.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    phase: phaseId, profileId, profileLabel: profile.label, disposition: 'not-applicable',
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.visualProfileDecisions.push(decision);
  return decision;
}

/** Revoke a decision: the profile needs evidence again. The decision stays, and so does the revocation. */
export function recordVisualProfileRevocation(workflow, { decisionId, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const target = DECISION_ID.test(String(decisionId ?? '')) ? visualProfileDecision(workflow, decisionId) : null;
  if (!target) throw new SingularityFlowError(`This Story has no visual-profile decision ${decisionId}.`, { code: 'VISUAL_PROFILE_DECISION_UNKNOWN' });
  if ((workflow.visualProfileDecisions ?? []).some((entry) => entry.revokes === decisionId)) {
    throw new SingularityFlowError(`${decisionId} is already revoked.`, { code: 'VISUAL_PROFILE_DECISION_REVOKED' });
  }
  const text = reasonText(reason, 'why the decision is revoked');
  const revocation = { revokes: decisionId, phase: target.phase, profileId: target.profileId, reason: text,
    actor, authorityGroup, identityAssurance, at };
  workflow.visualProfileDecisions.push(revocation);
  return revocation;
}

/** Who may decide for a step: its approval groups, or the next approving step's when it has none. */
function decidingGroups(workflow, phaseId) {
  const groups = (id) => {
    const policy = workflow?.phases?.[id]?.approvalPolicy ?? {};
    return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
  };
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  for (const id of [phaseId, ...order.slice(order.indexOf(phaseId) + 1)]) {
    const found = groups(id);
    if (found.length) return found;
  }
  return [];
}

/**
 * The open choice for each profile a visual step still lacks evidence for, in plain words, for a
 * list of what people must decide. Each choice has two options with the exact command: capture
 * it, or record that it does not apply to this Story (needs a reason, and is unavailable when it
 * is the last profile left to evidence). `coverage` is an `evaluateVisualCoverage` result. Pure.
 */
export function visualProfileDecisionOptions(workflow, phaseId, coverage) {
  const step = phaseId ?? coverage?.phase ?? null;
  if (!step || !Array.isArray(coverage?.uncovered) || !coverage.uncovered.length) return [];
  const profiles = new Map((Array.isArray(coverage.profiles) ? coverage.profiles : workflow?.resolution?.verification?.profiles ?? [])
    .filter((entry) => entry && typeof entry === 'object').map((entry) => [entry.id, entry]));
  const required = profiles.size - (coverage.notApplicable?.length ?? 0);
  const groups = decidingGroups(workflow, step);
  return coverage.uncovered.map((profileId) => {
    const profile = profiles.get(profileId);
    const label = profile?.label ?? profileId;
    const size = profile ? profilePixelSize(profile) : null;
    const pixels = size ? `${size.width} × ${size.height} pixels` : 'its configured size';
    const available = required > 1;
    return {
      kind: 'visual-profile', phase: step, profileId, label,
      title: `No screenshot yet for ${label}`,
      why: `${step} checks the app at every screen size this workflow lists. ${label} has no current screenshot at ${pixels}, so the step cannot pass until it has one or a person says this screen size does not apply to this Story.`,
      options: [
        { id: 'capture', label: 'Capture it', needsReason: false, available: true,
          detail: `Take a screenshot at exactly ${pixels} and record it. A simulator, emulator or device screenshot is recorded as a native capture; a screenshot from a pinned MCP tool is recorded with mcp record instead.`,
          command: nativeCaptureCommand(step, profileId),
          alternativeCommands: [`singularity-flow mcp record <SERVER> --kind visual-artifact --tool <TOOL> --phase ${step} --profile-id ${profileId} --screen-id <SCREEN-ID> --state-id <STATE-ID> --output <PNG-PATH>`] },
        { id: 'not-applicable', label: 'Not applicable for this Story', needsReason: true, available, decidedBy: groups,
          detail: available
            ? `A person who approves ${step}${groups.length ? ` (${groups.join(', ')})` : ''} records why this screen size does not apply to this Story. It is then listed as not applicable, with the reason and who decided, never as passed.`
            : `Not available: ${label} is the only screen size left to check, and at least one must have a screenshot.`,
          command: available ? visualProfileDecisionCommand(workflow, step, profileId) : null }
      ]
    };
  });
}

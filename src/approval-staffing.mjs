/** Who could approve each step of a new Story besides its author, read once at Story start. */
import { eligibleApprovers, matchApprovalAuthority } from './approval-authority.mjs';

/**
 * Each gated step of a new Story that nobody but its author could approve [PHR:REQ-002], finding 16:
 * a step whose approval groups name no one else, where the author may not approve it themselves
 * (its policy forbids self-approval, or the author is in none of its groups). A later approval met it
 * as APPROVAL_IDENTITY_NOT_AUTHORIZED or APPROVAL_SELF_APPROVAL_PROHIBITED. Advisory: it blocks nothing.
 */
export function approvalStaffingWarnings(workflow, author) {
  const authorities = workflow?.resolution?.approvalAuthorities ?? {};
  const exclude = [author?.email, author?.login].filter(Boolean);
  const warnings = [];
  for (const id of workflow?.phaseOrder ?? []) {
    const policy = workflow.phases?.[id]?.approvalPolicy;
    if (!policy || ['none', 'policy'].includes(policy.mode) || !(Number(policy.minimum ?? 1) > 0) || !(policy.authorities ?? []).length) continue;
    const others = eligibleApprovers(authorities, policy, { exclude });
    if (others.anyIdentity || others.eligibleApprovers.length) continue;
    const authorMay = policy.allowSelfApproval !== false && matchApprovalAuthority(authorities, policy, author ?? {}).authorized;
    if (authorMay) continue;
    warnings.push({ id: 'approval-staffing', phase: id, authorities: others.authorities,
      message: `Nobody but this Story's author can approve ${id}, and ${policy.allowSelfApproval === false ? 'its policy forbids self-approval' : 'the author is in none of its approval groups'} (${others.authorities.join(', ')}). Add an approver to those groups before ${id} is submitted, then take them into this Story; nothing is held now.`,
      nextAction: { command: `singularity-flow story approvers refresh ${workflow.workItem.id} --reason <why>`,
        label: `Once the approval groups on sflow/config name another approver, take them into this Story's groups.` } });
  }
  return warnings;
}

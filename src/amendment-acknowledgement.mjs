/**
 * Who acknowledges an approved intent amendment (ask once, owner 2026-11-28): acknowledging a change you approved yourself
 * changes nothing, so when nobody else works on the Story SFlow records the approver's own acknowledgement with the
 * approval; otherwise someone else's is kept, with one line on why they are asked. Pure; loaded by the amendment's decision
 * (commands/story.mjs) and the decisions list, never eagerly.
 */
import { sameApprover } from './approval-authority.mjs';

/**
 * How many people besides `actor` worked on this Story, as its record names them (who started it, who acted in its history,
 * approved or sent back a step, or proposed an amendment); SFlow's own identities are no one. With none, the approver's own
 * acknowledgement of what they approved is all the Story needs, so SFlow records it (ask once, owner 2026-11-28).
 */
export function otherPeopleOnStory(workflow, actor) {
  const sflow = (entry) => entry?.automatic === true || /^(?:system|singularity-flow|sflow-[a-z-]+)$/u.test(String(typeof entry === 'string' ? entry : entry?.login ?? ''));
  const seen = [];
  const add = (entry) => {
    if (!entry || sflow(entry) || !sameApprover(entry, entry) || sameApprover(entry, actor) || seen.some((other) => sameApprover(other, entry))) return;
    seen.push(entry);
  };
  add(workflow?.workItem?.createdBy);
  for (const event of workflow?.history ?? []) add(event?.actor);
  for (const phase of Object.values(workflow?.phases ?? {})) for (const approval of phase?.approvals ?? []) add(approval?.actor);
  for (const request of workflow?.changeRequests ?? []) add(request?.requestedBy);
  for (const amendment of workflow?.intentAmendments ?? []) add(amendment?.proposedBy);
  return seen.length;
}

/** Why an approved amendment still waits for someone's acknowledgement, in one line: who else works on the Story. */
export const acknowledgementWhy = (id, others) => `${others === 1 ? 'Someone else works' : `${others} other people work`} on this Story, `
  + `so one of them reads what ${id} changed and acknowledges it before the steps it reopened go on.`;


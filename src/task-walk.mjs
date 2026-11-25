/**
 * A task's composed work type walked to its end before it starts or gains a step [ITW:REQ-003]: a plan that would loop
 * or stop is never started, and never changed into one. Shared by `work` (src/commands/work.mjs) and a task change
 * (src/task-amendment.mjs); reads only.
 */
import { SingularityFlowError } from './util.mjs';

/** Each approval group as Workflow Studio shows it, for the walk. */
function groupsOf(definition) {
  return new Map(Object.entries(definition.approvalAuthorities ?? {}).map(([id, group]) => [id, { id, label: group.label ?? id,
    status: (group.members ?? []).length ? 'people' : group.allowAnyGitIdentity ? 'anyone' : (group.githubTeams ?? []).length ? 'teams'
      : definition.approvalSecurity?.autoEnrollNewIdentities === false ? 'blocked' : 'auto' }]));
}

/** The composed work type walked to its end before anything starts or changes: a plan that would stop is refused. */
export async function walkTaskWorkType(overlaid, resolved) {
  const { quickWalkResolved, walkHosts } = await import('./workflow-walk/quick.mjs');
  const walk = quickWalkResolved(resolved, { approvalAuthorities: overlaid.approvalAuthorities, groups: groupsOf(overlaid), hosts: walkHosts() });
  if (walk.stops.length) {
    const stop = walk.stops[0];
    throw new SingularityFlowError(`This task's steps would stop before they finish: ${stop.title}${stop.detail ? ` ${stop.detail}` : ''}`, {
      code: 'TASK_PLAN_STOPS',
      details: { stops: walk.stops, nextAction: { command: 'singularity-flow workflow check', label: 'Check the workflow configuration the task is composed from.' } }
    });
  }
  return walk;
}


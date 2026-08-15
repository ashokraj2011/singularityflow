/**
 * `work.list`: what you are working on, grouped. `[INT:REQ-060]` `[INT:REQ-061]`
 *
 * A projection of `workRecords`, which is a projection of records that already exist. This planner
 * adds only three things: the group filter the caller asked for, one non-executable next action per
 * item, and the disclosure that the list is scoped to one repository.
 *
 * That last one matters more than it looks. §8.1 describes a view across a workspace, and this
 * reads a single repository's subject index. Saying so in `warnings` is the difference between a
 * partial answer and a wrong one.
 */
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';
import { WORK_GROUP_ORDER, workRecords } from '../work-records.mjs';

export function workListResult(records, { subject = null, group = null, repositoryScope = null } = {}) {
  const shown = group ? records.items.filter((item) => item.group === group) : records.items;

  return sflowResult({
    kind: 'read',
    operation: { id: 'work.list', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.read',
      slots: { count: shown.length, group: group ?? 'all' }
    },
    effects: noEffects(),
    why: [{
      code: 'work.from-governed-records',
      source: 'lifecycle',
      reference: repositoryScope,
      slots: { count: String(shown.length) }
    }],
    // One repository, and the reader is told so rather than left to infer it from what is absent.
    warnings: [{ code: 'work.single-repository-scope', source: 'unavailable', slots: { repository: repositoryScope ?? 'current' } }],
    next: shown
      .filter((item) => item.nextAction)
      .map((item, index) => ({
        handle: `work:${item.id}`,
        label: item.title,
        rank: index,
        kind: 'read',
        reasonCode: item.nextAction.reasonCode,
        confirmation: 'none',
        /**
         * Never executable from a list. The next action names the operation to resolve, and
         * resolving it is what binds a subject, revalidates legality and issues a handle — none of
         * which a row rendered ten minutes ago can stand in for.
         */
        executable: false,
        fallback: { label: item.nextAction.operation, command: `sflow status --work-id ${item.id}` }
      })),
    restState: shown.length ? null : 'informational',
    data: {
      group: group ?? null,
      groupOrder: [...WORK_GROUP_ORDER],
      groups: Object.fromEntries(WORK_GROUP_ORDER.map((name) => [name, records.groups[name] ?? []])),
      items: shown,
      repositoryScope
    }
  });
}

export async function workList({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  /**
   * No fall back to the working directory.
   *
   * A read model that quietly defaults to wherever the process happens to be would answer a question
   * about one repository with facts from another, and it would do it most often in the case that
   * matters — a host invoking the kernel from somewhere other than the workspace.
   */
  if (!root) throw new SingularityFlowError('work.list requires the repository root it should read.', { code: 'WORK_LIST_NO_ROOT' });
  const records = await workRecords(root, { includeCompleted: Boolean(args.includeCompleted), ...context });
  return workListResult(records, { subject, group: args.group ?? null, repositoryScope: root });
}

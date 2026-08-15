/**
 * `work.continue`: pick up one piece of work, without proposing to execute anything.
 * `[INT:REQ-063]` `[INT:CON-062]` `[INT:CON-063]`
 *
 * Four things in order: resolve the exact subject, refresh its governed state, detect stale local
 * context, and return the legal actions — and then stop. Proposing execution is a separate
 * resolution with its own confirmation, because the point of this read is that the user decides what
 * to continue with, having been told what is actually true.
 *
 * Continuation is reconstructed from records, never from what was said earlier `[INT:CON-062]`. That
 * constraint is why this planner takes no conversational input at all: it is handed a work ID and
 * reads. A version of this that accepted "where we left off" as context would work beautifully until
 * the day someone returned after a week, and then be confidently wrong.
 */
import { SingularityFlowError } from '../../util.mjs';
import { catalogued } from '../catalog.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';
import { workRecords } from '../work-records.mjs';

function notFound(workId) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'work.continue', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId } },
    effects: noEffects(),
    why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', slots: { workId } }],
    /**
     * A work ID that resolves nowhere is the refusal most likely to be read as "I am in the wrong
     * repository and have lost something" `[DHR:REQ-061]`. Saying nothing was touched is what keeps
     * the reader looking for the right repository instead of for their work.
     */
    preserved: preservedAll('work.nothing-was-carried-out', { reference: workId }),
    next: [{
      handle: 'goal:work.list',
      id: 'recover:work.list',
      label: 'See current work',
      rank: 0,
      kind: 'clarification',
      reasonCode: 'work.not-in-this-repository',
      confirmation: 'none',
      interaction: 'recovery',
      emphasis: 'primary',
      executable: false,
      fallback: { label: 'See current work', command: 'sflow inbox' }
    }],
    restState: null
  });
}

export function workContinueResult(item, { subject = null, localChanges = null, legalActions = null } = {}) {
  /**
   * Local development is preserved and disclosed, never quietly worked around `[INT:CON-063]`.
   *
   * The worktree hash travels with the disclosure so that any action later bound to these bytes can
   * be invalidated when they move. Reporting "you have local changes" without saying which revision
   * they were seen at is a disclosure nothing can be checked against.
   */
  const uncommitted = localChanges?.dirty
    ? [{
      code: 'work.local-changes-present',
      source: 'evidence',
      reference: localChanges.worktreeHash ?? null,
      slots: { files: String(localChanges.files ?? 0) }
    }]
    : [];

  const actions = legalActions ?? (item.nextAction ? [item.nextAction.operation] : []);

  return sflowResult({
    kind: 'read',
    operation: { id: 'work.continue', classification: 'read' },
    subject: subject ?? {
      kind: item.kind,
      id: item.id,
      revision: { sourceCommit: localChanges?.worktreeHash ?? null, lifecycleHash: null, policyHash: null, registryHash: null }
    },
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.read',
      slots: { work: item.id, phase: item.phase ?? 'none', group: item.group }
    },
    effects: noEffects(),
    why: [
      {
        code: 'work.reconstructed-from-records',
        source: 'lifecycle',
        reference: item.id,
        slots: { phase: item.phase ?? 'none', generation: String(item.generation ?? 0) }
      },
      ...item.blockers.map((blocker) => ({
        code: catalogued(`work.blocked.${blocker}`, 'work.blocked.unrecognised'),
        source: 'lifecycle',
        // The raw name rides in a slot, so an uncatalogued blocker is still nameable to the reader.
        slots: { work: item.id, blocker }
      }))
    ],
    warnings: uncommitted,
    /**
     * Legal actions, and not one of them executable from here.
     *
     * `[INT:REQ-063]` says legal actions come back *before* any execution is proposed. An executable
     * next action would collapse those two steps into one, which is exactly the collapse that makes
     * a returning developer advance a phase they had not yet understood.
     */
    next: actions.map((operation, index) => ({
      handle: `continue:${item.id}:${operation}`,
      id: `continue:${operation}`,
      label: operation,
      rank: index,
      kind: 'read',
      reasonCode: item.nextAction?.reasonCode ?? 'work.legal-now',
      confirmation: 'none',
      interaction: 'navigation',
      /**
       * The first legal action leads, and only the first `[UXH:REQ-023]`. The list is already
       * ordered by the lifecycle rather than by this planner, so leading with its head is deferring
       * to that order rather than inventing a second one.
       */
      emphasis: index === 0 ? 'primary' : 'secondary',
      executable: false,
      fallback: { label: operation, command: `sflow status --work-id ${item.id}` }
    })),
    restState: actions.length ? null : 'blocked',
    data: {
      work: item,
      localChanges: localChanges ?? { dirty: false, files: 0, worktreeHash: null },
      legalActions: actions,
      // The immediate goal in the reader's words; kernel phase detail is beside it, not instead `[INT:REQ-064]`.
      immediateGoal: item.nextAction?.reasonCode ?? 'work.no-legal-action',
      evidence: { phase: item.phase, generation: item.generation, lastMaterialEvent: item.lastMaterialEvent }
    }
  });
}

export async function workContinue({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) throw new SingularityFlowError('work.continue requires the repository root it should read.', { code: 'WORK_CONTINUE_NO_ROOT' });
  const records = await workRecords(root, { includeCompleted: true, ...context });
  const item = records.items.find((entry) => entry.id === args.workId);
  if (!item) return notFound(args.workId);
  return workContinueResult(item, { subject, localChanges: context.localChanges ?? null, legalActions: context.legalActions ?? null });
}

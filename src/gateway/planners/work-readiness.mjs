/**
 * `work.readiness`: "am I ready?", answered deterministically. `[INT:REQ-181]` `[INT:IFC-081]` `[INT:CON-180]`
 *
 * The readiness coach is the place a guided surface is most tempted to be helpful and least allowed
 * to be. `[INT:CON-180]` forbids four specific things — recommending approval, waiving a gate,
 * inventing evidence, and turning a model opinion into a readiness fact — and each of them is what
 * a sufficiently eager assistant does when it cannot find a real blocker.
 *
 * So this planner only ever *reports* and only ever from records. It reports what is missing, it
 * names the smallest legal remediation for each, and when nothing is missing it says the gates that
 * remain are somebody's decision rather than a step the reader can take.
 */
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, sflowResult } from '../result.mjs';
import { workRecords } from '../work-records.mjs';

/**
 * The smallest legal step for each blocker `[INT:IFC-081]`.
 *
 * Deliberately a lookup rather than a computation. A blocker with no known remediation must fall
 * through to "no step is known" instead of being handed the nearest plausible verb, because a
 * confident wrong instruction is how a reader ends up doing something nobody asked for.
 */
const REMEDIATION = Object.freeze({
  'publication-pending': { action: 'work.continue', reasonCode: 'readiness.resume-publication' },
  'approvals-outstanding': { action: null, reasonCode: 'readiness.awaiting-a-human-decision' },
  'required-artifact-missing': { action: 'work.continue', reasonCode: 'readiness.produce-the-artifact' }
});

export function workReadinessResult(item, { subject = null } = {}) {
  const blockers = item.blockers.map((blocker) => ({
    blocker,
    ...(REMEDIATION[blocker] ?? { action: null, reasonCode: 'readiness.no-known-step' })
  }));
  const ready = blockers.length === 0;

  /**
   * A blocker that only a person can clear is not a step, and is not counted as one.
   *
   * This is the whole difference between a readiness coach and a nag: "waiting for a reviewer" is a
   * true statement about the world, and presenting it as an outstanding task the reader could
   * complete would be an invitation to go and complete it.
   */
  const actionable = blockers.filter((entry) => entry.action);

  return sflowResult({
    kind: 'read',
    operation: { id: 'work.readiness', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.read',
      slots: { work: item.id, ready: String(ready), blockers: blockers.length }
    },
    effects: noEffects(),
    why: [
      {
        code: ready ? 'readiness.no-blockers-found' : 'readiness.blocked',
        source: 'lifecycle',
        reference: item.id,
        slots: { phase: item.phase ?? 'none', count: String(blockers.length) }
      },
      ...blockers.map((entry) => ({
        code: `readiness.${entry.blocker}`,
        source: 'lifecycle',
        slots: { remediation: entry.reasonCode }
      }))
    ],
    /**
     * What this answer does not cover, said out loud.
     *
     * Test gaps, stale approvals, unresolved clarifications and unclaimed changes are all part of
     * `[INT:IFC-081]` and none of them is derivable from the phase record this reads. A readiness
     * answer that quietly omits four of its nine inputs reads as "you are ready".
     */
    warnings: [{
      code: 'readiness.partial-inputs',
      source: 'unavailable',
      slots: { missing: 'tests, stale-approvals, clarifications, unclaimed-changes' }
    }],
    next: actionable.map((entry, index) => ({
      handle: `readiness:${item.id}:${entry.blocker}`,
      label: entry.blocker,
      rank: index,
      kind: 'read',
      reasonCode: entry.reasonCode,
      confirmation: 'none',
      executable: false,
      fallback: { label: entry.action, command: `sflow status --work-id ${item.id}` }
    })),
    // Ready, or blocked only by other people's decisions: both are answers, and both are a stop.
    restState: actionable.length ? null : 'informational',
    data: {
      work: item.id,
      ready,
      phase: item.phase,
      generation: item.generation,
      blockers,
      // Never a verdict, never a recommendation `[INT:CON-180]`.
      recommendation: null
    }
  });
}

export async function workReadiness({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) throw new SingularityFlowError('work.readiness requires the repository root it should read.', { code: 'WORK_READINESS_NO_ROOT' });
  const records = await workRecords(root, { includeCompleted: true, ...context });
  const item = records.items.find((entry) => entry.id === args.workId);
  if (!item) {
    return sflowResult({
      kind: 'refusal',
      operation: { id: 'work.readiness', classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId: args.workId } },
      effects: noEffects(),
      why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', slots: { workId: args.workId } }],
      restState: 'blocked'
    });
  }
  return workReadinessResult(item, { subject });
}

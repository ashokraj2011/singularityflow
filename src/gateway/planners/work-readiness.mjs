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
import { catalogued } from '../catalog.mjs';
import { noEffects, plannerNavigation, preservedAll, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';

/**
 * The smallest legal step for each blocker `[INT:IFC-081]`.
 *
 * Deliberately a lookup rather than a computation. A blocker with no known remediation must fall
 * through to "no step is known" instead of being handed the nearest plausible verb, because a
 * confident wrong instruction is how a reader ends up doing something nobody asked for.
 */
const REMEDIATION = Object.freeze({
  'publication-pending': { action: 'work.continue', reasonCode: 'readiness.resume-publication' },
  'publication-marker-unreadable': { action: null, reasonCode: 'readiness.repair-publication-marker' },
  'approvals-outstanding': { action: null, reasonCode: 'readiness.awaiting-a-human-decision' },
  'required-artifact-missing': { action: 'work.continue', reasonCode: 'readiness.produce-the-artifact' }
});

/**
 * The gates this planner can evaluate, in the order a reader meets them.
 *
 * Fixed rather than derived from the blockers found, because a checklist assembled only from
 * failures cannot show a met gate — and "2 of 5 unmet" is a materially different message from
 * "2 problems", which is the one a bare failure list delivers `[UXH:REQ-062]`.
 */
const GATES = Object.freeze(['publication-pending', 'publication-marker-unreadable', 'approvals-outstanding', 'required-artifact-missing']);

/**
 * The four inputs `[INT:IFC-081]` names that a phase record cannot answer.
 *
 * They appear as `unknown` rows rather than being left out. A gate nobody evaluated and a gate that
 * passed look identical on a screen that only lists problems, and the reader who acts on that
 * screen is the one submitting against an untested change.
 */
const UNEVALUATED_GATES = Object.freeze(['tests', 'stale-approvals', 'clarifications', 'unclaimed-changes']);

/**
 * A gate's catalog code, or the named fallback when the lifecycle grows a gate this build predates.
 *
 * Falling back rather than throwing is the same judgement `REMEDIATION` already makes one screen
 * up: an unrecognised gate still renders, as a row saying it has no name here, with the raw name in
 * a slot. Rejecting it would take out the whole readiness read — the reader would lose the four
 * gates this build *does* understand because a fifth appeared.
 */
const gateCode = (gate) => catalogued(`readiness.${gate}`, 'readiness.unrecognised-gate');

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
      messageId: ready ? 'gateway.read' : 'gateway.not-ready',
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
        code: gateCode(entry.blocker),
        source: 'lifecycle',
        slots: { gate: entry.blocker, remediation: entry.reasonCode }
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
    next: actionable.map((entry, index) => plannerNavigation({
      handle: `readiness:${item.id}:${entry.blocker}`,
      id: `fix:${entry.blocker}`,
      /**
       * The remediation, not the blocker's internal name.
       *
       * This used to be `entry.blocker`, so the button on a gate row read
       * `required-artifact-missing` — the identifier, in the place a reader looks for a verb. The
       * label names the step; `reasonCode` below carries the same fact in a form a catalog can
       * translate, and the two must not disagree.
       */
      label: entry.action === 'work.continue' ? 'Continue this work' : entry.action,
      rank: index,
      kind: 'read',
      reasonCode: entry.reasonCode,
      confirmation: 'none',
      interaction: 'navigation',
      /**
       * Fix buttons on a checklist are peers `[UXH:REQ-064]`. Emphasising the first would be this
       * planner ranking two remediations it has no basis to rank — the reader can see both rows and
       * knows which one they are able to do.
       */
      emphasis: 'secondary',
      executable: false,
      fallback: { label: entry.action, command: `sflow status --work-id ${item.id}` }
    }, entry.action, { workId: item.id, workKind: item.kind })),
    /**
     * One row per gate, met and unmet alike `[UXH:REQ-062]` `[UXH:AC-003]`.
     *
     * Each unmet row that has a remediation points at its own fix action by id, so the checklist and
     * `next[]` cannot drift apart — the contract rejects a row naming an action this result did not
     * offer, which is the failure that renders a button that goes nowhere.
     */
    checklist: [
      /**
       * The fixed gates, plus any blocker this build did not know to list.
       *
       * The union matters more than it looks. A blocker outside `GATES` still reaches `why[]` and
       * `next[]`, so a checklist built from `GATES` alone would count five gates all met while the
       * same result refused — and the count is what the card and the status bar both render
       * `[UXH:AC-002]`. A surface that says "all clear" next to a refusal is worse than one that
       * says nothing.
       */
      ...[...GATES, ...blockers.map((entry) => entry.blocker).filter((blocker) => !GATES.includes(blocker))]
        .map((gate) => {
          const blocked = blockers.find((entry) => entry.blocker === gate);
          return {
            id: gate,
            code: gateCode(gate),
            state: blocked ? 'unmet' : 'met',
            source: 'lifecycle',
            evidence: item.id,
            action: blocked?.action ? `fix:${gate}` : null,
            // An uncatalogued gate keeps its raw name here, the way an unrecognised blocker does.
            slots: blocked ? { gate, remediation: blocked.reasonCode } : { gate }
          };
        }),
      ...UNEVALUATED_GATES.map((gate) => ({
        id: gate,
        code: gateCode(gate),
        state: 'unknown',
        // Not `lifecycle`: nothing was read. The source says where the answer came from, and here
        // there is no answer — which is the fact the row exists to carry.
        source: 'unavailable',
        evidence: null,
        action: null,
        slots: {}
      }))
    ],
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
  const item = resolveWorkRecord(records, args);
  if (!item) {
    return sflowResult({
      kind: 'refusal',
      operation: { id: 'work.readiness', classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId: args.workId } },
      effects: noEffects(),
      why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', slots: { workId: args.workId } }],
      preserved: preservedAll('work.nothing-was-carried-out', { reference: args.workId }),
      restState: 'blocked'
    });
  }
  return workReadinessResult(item, { subject });
}

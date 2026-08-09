/**
 * Where a result's NEXT comes from.
 *
 * One planner, three consumers: the command result, the repository snapshot, and the VS Code
 * Journey's primary action. They share derivation and differ only in lifetime — the envelope is an
 * immediate interaction result, the snapshot is the durable read model. The Journey must never
 * depend on a transient envelope, because tomorrow morning there will not be one.
 *
 * `nextsteps.mjs` already computes the valid action set deterministically, so this resolves to it
 * rather than inventing a second opinion about what is allowed. Two things it must not do: run
 * before the command has committed (continuation is a function of post-state), and assume there is
 * always a Story (`init`, `about`, a refusal before subject resolution).
 */
import { workflowNextSteps } from '../nextsteps.mjs';
import { action } from './command-result.mjs';

/** Remediations keyed by the reason that blocked the command. */
const REMEDIATIONS = Object.freeze({
  'publication.pending': (subject) => action({
    id: 'sync-publication',
    label: 'Publish the commit that was retained locally',
    command: `singularity-flow sync${subject?.id ? ` ${subject.id}` : ''}`,
    rank: 'NOW',
    kind: 'remediation'
  }),
  'ledger.behind': () => action({
    id: 'reconcile-ledger',
    label: 'Reconcile the capability ledger',
    command: 'singularity-flow ledger reconcile',
    rank: 'NOW',
    kind: 'remediation'
  }),
  'grounding.not-ready': (subject, slots) => action({
    id: 'compose-grounding',
    label: 'Compose the world-model grounding for this phase',
    command: `singularity-flow wm compose --phase ${slots?.phase ?? '<phase>'}`,
    rank: 'NOW',
    kind: 'remediation'
  }),
  'artifact.missing': (subject, slots) => action({
    id: 'prepare-artifact',
    label: 'Create the artifact this phase requires',
    command: `singularity-flow prepare ${slots?.phase ?? '<phase>'}`,
    rank: 'NOW',
    kind: 'remediation'
  }),
  'generation.not-published': (subject, slots) => action({
    id: 'publish-generation',
    label: 'Publish a generation of this phase',
    command: `singularity-flow phase publish ${slots?.phase ?? '<phase>'}`,
    rank: 'NOW',
    kind: 'remediation'
  }),
  'sequence.gate-failed': (subject) => action({
    id: 'inspect-sequence-gates',
    label: 'See which sequence gates are failing',
    command: `singularity-flow validate${subject?.id ? ` ${subject.id}` : ''}`,
    rank: 'NOW',
    kind: 'remediation'
  })
});

/** Remediations for whatever blocked this result, most specific first, deduplicated. */
export function remediationActions(result) {
  const seen = new Set();
  return result.why
    .map((entry) => REMEDIATIONS[entry.code]?.(result.subject, entry.slots))
    .filter(Boolean)
    .filter((entry) => (seen.has(entry.id) ? false : seen.add(entry.id)));
}

const PLANNER_RANKS = Object.freeze({ now: 'NOW', alternative: 'NOW', then: 'SOON', later: 'LATER' });

/**
 * The planner's own vocabulary, translated rather than re-invented.
 *
 * `workflowNextSteps` emits `{ rank, skill, command, reason }`, where `reason` is the sentence
 * explaining why the step is the right one. That sentence is the label; guessing at `label`/`title`
 * produced a list of steps all captioned "Continue", which is worse than no caption at all.
 */
function fromWorkflowPlanner(workflow, { publicationPending = false, modelMode } = {}) {
  return workflowNextSteps(workflow, { publicationPending, modelMode })
    .map((step, index) => action({
      id: step.command ? step.command.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) : `step-${index}`,
      label: step.reason ?? step.command ?? 'Continue',
      command: step.command ?? `singularity-flow nextsteps ${workflow.workItem.id}`,
      rank: PLANNER_RANKS[step.rank] ?? (index === 0 ? 'NOW' : 'SOON'),
      kind: 'workflow',
      modelPolicy: step.modelPolicy ?? 'never'
    }));
}

/**
 * Attach a continuation to a result that has none.
 *
 * Ordered deliberately: an explicit continuation wins, then remediation for a blocked command, then
 * the deterministic planner for the subject, and only then a rest state. A refusal that reaches the
 * rest-state branch is a bug in the reason codes — it means we stopped someone without telling them
 * how to proceed.
 */
export function attachContinuation(result, { postState = null, publicationPending = false, modelMode, restStateWhenIdle = null } = {}) {
  if (result.next.length || result.restState) return result;

  const remediation = remediationActions(result);
  if (remediation.length) return { ...result, next: Object.freeze(remediation) };

  if (result.subject?.kind === 'story' && postState) {
    const planned = fromWorkflowPlanner(postState, { publicationPending, modelMode });
    if (planned.length) return { ...result, next: Object.freeze(planned) };
  }

  // A caller that knows the work finished can say so; otherwise a succeeded command with nothing
  // planned is complete and anything else is merely informational.
  if (restStateWhenIdle) return { ...result, restState: restStateWhenIdle };
  return { ...result, restState: result.outcome.status === 'succeeded' ? 'complete' : 'informational' };
}

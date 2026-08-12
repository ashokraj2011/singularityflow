/**
 * The CLI form of the five verbs. `[SPK:REQ-010]`
 *
 * This dispatcher is deliberately thin and deliberately deterministic. When the next step is
 * authoring, it returns a native agent handoff and stops — it never fabricates generated content
 * `[SPK:CON-015]`. The authoring itself belongs to the skill form, which does it with the resolved
 * phase agent and publishes through the very same kernel operation the advanced interface uses
 * `[SPK:REQ-018]`.
 *
 * Nothing here decides what is legal. `planFastPath` asks the existing planner and this prints the
 * answer, which is what keeps `[SPK:REQ-180]` — identical authoritative state between the fast path
 * and the advanced operations — achievable rather than aspirational.
 */
import { loadDefinition } from '../config.mjs';
import { repoRoot } from '../git.mjs';
// Through the revisioned state store, never `state.mjs` directly: application surfaces load and
// mutate aggregates across that boundary so the revision guard cannot be bypassed.
import { loadStoryAggregate, storyPublicationPending } from '../state-stores.mjs';
import { FAST_PATH_VERBS, planFastPath } from '../fast-path.mjs';
import {
  action, because, commandResult, noEffects, refused, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { operationById } from '../command-registry.mjs';
import { operationContext } from '../operation-context.mjs';
import { optionBoolean, optionString } from '../util.mjs';
import * as style from '../style.mjs';

/** Map a checkpoint to the NCL rest state, or null when the journey continues. */
function restStateFor(result) {
  if (result.outcome === 'milestone-reached' && !result.next.length) return 'complete';
  if (result.checkpoint.kind === 'approval') return 'awaiting-others';
  return null;
}

export async function runVerb(verb, argv, { positionals, options }) {
  const root = repoRoot();
  const definition = await loadDefinition(root);
  // `loadWorkflow` resolves the active Story when no id is given, which is the common case for a
  // verb typed with no arguments.
  const workflow = await loadStoryAggregate(root, definition, optionString(options, 'work-id') ?? positionals[1]);
  const pending = await storyPublicationPending(root, definition, workflow.workItem.id);
  const json = optionBoolean(options, 'json');

  const plan = planFastPath(workflow, definition, verb, {
    publicationPending: Boolean(pending),
    modelMode: operationContext()?.modelMode ?? { enabled: true }
  });

  const operation = operationById(verb);
  const reached = plan.outcome === 'milestone-reached';
  const result = commandResult({
    operation,
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: reached
      ? succeeded('fastpath.milestone', { verb, milestone: plan.milestone })
      : plan.outcome === 'blocked'
        ? refused('fastpath.blocked', { verb, checkpoint: plan.checkpoint.kind })
        : succeeded('fastpath.checkpoint', { verb, checkpoint: plan.checkpoint.kind }),
    // Planning changes nothing. The underlying operations the reader is handed are what mutate, and
    // they are named rather than run, so this result can never over-claim.
    effects: noEffects(),
    why: plan.why.map((entry) => because(entry.code, entry.source, { ref: plan.checkpoint.reason })),
    next: plan.next.map((entry) => action({
      id: entry.id,
      label: entry.label,
      command: entry.command,
      rank: entry.rank ?? 'NOW',
      kind: entry.command?.includes('approve') ? 'review' : 'workflow'
    })),
    restState: restStateFor(plan),
    // The fast-path payload travels whole, so every surface projects the same milestone and
    // checkpoint from the same result `[SPK:REQ-150]`.
    data: { fastPath: plan }
  });

  if (json) {
    emitCommandResult(result, { json: true });
    return {};
  }

  const mark = reached ? 'pass' : plan.outcome === 'blocked' ? 'fail' : 'warn';
  console.log(`${style.mark(mark)} ${verb} · ${plan.milestone}`);
  console.log(`  ${plan.checkpoint.reason}`);
  if (plan.underlyingOperations.length) {
    // Naming the kernel operations is the honesty that makes a small vocabulary safe: the reader can
    // always see which governed operation the friendly verb stands for.
    console.log(`  Underlying: ${plan.underlyingOperations.join(', ')}`);
  }
  emitCommandResult(result, { json: false });
  if (plan.outcome === 'blocked') process.exitCode = 2;
  return {};
}

/** One `run` per verb, so each is an ordinary registered command rather than a subcommand. */
export const runners = Object.fromEntries(FAST_PATH_VERBS.map((verb) => [
  verb, (argv, context) => runVerb(verb, argv, context)
]));

export async function run(argv, context) {
  const verb = argv?.[0];
  return runVerb(FAST_PATH_VERBS.includes(verb) ? verb : 'specify', argv, context);
}

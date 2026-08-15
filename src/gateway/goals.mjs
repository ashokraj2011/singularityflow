/**
 * The broad goals a host model may hint at. `[INT:IFC-012]`
 *
 * A goal is the coarsest thing the model is trusted to say: roughly what the user seems to want.
 * It is deliberately not an operation name, a command line, a lifecycle transition, an agent, a
 * persona, or a verdict `[INT:CON-035]` — the model proposes a direction, the kernel decides what
 * is legal in it.
 *
 * Fifteen, fixed, and small enough to read: the list is a vocabulary, not a taxonomy to grow. A
 * sixteenth goal is a product decision, and adding one has to be as visible as adding a command.
 */
import { SingularityFlowError } from '../util.mjs';

export const BROAD_GOALS = Object.freeze([
  'home',
  'work.list',
  'work.continue',
  'work.start',
  'work.ready',
  'workspace.switch',
  'impact.quick',
  'impact.what-if',
  'repository.explore',
  'problem.investigate',
  'intent.trace',
  'compare',
  'watch',
  'review.open',
  'help'
]);

const KNOWN = new Set(BROAD_GOALS);

export function isBroadGoal(id) {
  return KNOWN.has(id);
}

/**
 * A goal that is not on the list is a routing error, not a near miss to be repaired.
 *
 * Silently ignoring an unknown goal would let a host ship a private vocabulary that appears to work
 * — every unrecognized hint degrades to "no hint", which resolves *something* — and nothing would
 * ever report the divergence.
 */
export function assertBroadGoal(id) {
  if (!KNOWN.has(id)) {
    throw new SingularityFlowError(
      `'${id}' is not a broad goal. Known goals: ${BROAD_GOALS.join(', ')}.`,
      { code: 'UNKNOWN_BROAD_GOAL', details: { goal: id, known: [...BROAD_GOALS] } }
    );
  }
  return id;
}

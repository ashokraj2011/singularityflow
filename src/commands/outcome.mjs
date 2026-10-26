/**
 * `singularity-flow outcome [WORK-ID] [--capability ID] [--json]`: what a person checks once a
 * Story's code and tests are in (src/outcome-review.mjs). Optional and a read: it changes nothing,
 * nothing requires it, and its result names no next action, so no agent acts on it unasked.
 */
import { repoRoot } from '../git.mjs';
import { because, commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['capability', 'json', 'for-agent', 'timings']);

export async function run(_argv, { positionals, options = {} }) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key)).sort();
  if (unknown.length) {
    throw new SingularityFlowError(`outcome does not accept ${unknown.map((key) => `--${key}`).join(', ')}. Use: --capability, --json.`,
      { code: 'OUTCOME_COMMAND_INVALID' });
  }
  if (positionals.length > 2) throw new SingularityFlowError('outcome takes at most one WORK-ID.', { code: 'OUTCOME_COMMAND_INVALID' });
  const { outcomeReview } = await import('../outcome-review.mjs');
  const review = await outcomeReview(repoRoot(), { workId: positionals[1] ?? null, capabilityId: optionString(options, 'capability', null) });
  return emitCommandResult(commandResult({
    operation: { id: 'outcome.review', classification: 'read' },
    subject: { kind: 'story', id: review.workId },
    outcome: succeeded('outcome.review.reported', {
      workId: review.workId, criteria: review.criteria.length,
      open: review.open.signOffs.length + review.open.scopeItems.length
    }),
    effects: noEffects(),
    why: [because('outcome.from-story-records', 'evidence', { ref: review.workId, topic: 'outcome-review' })],
    restState: 'informational',
    next: [],
    data: { outcome: review }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}

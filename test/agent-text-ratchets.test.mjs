/**
 * What an agent reads says one thing, and only what is there. `[agent-output]`
 *
 * Models follow the words of a result literally and stop when they are unsure. On 2026-11-11 one stopped on
 * `complete: false` beside "do this step's drafting now", one refused to guess a reply format it was never given,
 * one relayed a fallback route while the reviewer it should have started never ran. These ratchets hold the
 * classes, not the instances: a new branch of `act`, a new flag or a new instruction meets them too.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { reviewSubagentHandoff } from '../src/review-subagent.mjs';

const handoff = reviewSubagentHandoff({ workId: 'QF-1', phase: 'implement', generation: 1, reviewerAgent: 'sflow-source-reviewer' });
const outcomeReview = { workId: 'QF-1', phase: 'implement', generation: 1, command: 'singularity-flow outcome QF-1', copilotCommand: '/sf-outcome QF-1',
  agentCommand: 'singularity-flow outcome QF-1 --for-agent --json', instruction: 'Open the outcome review.', reason: 'Try it.' };
const declared = { declared: true, question: 'Start the application to try it now?', choices: [
  { id: 'start', label: 'Start the application', copilotCommand: '/sf-run-app start', command: 'singularity-flow app plan --json' },
  { id: 'not-now', label: 'Not now', routes: [{ command: 'singularity-flow review-source status implement', copilotCommand: '/sf-review-source implement' }] }] };
const undeclared = { declared: false, words: 'This checkout declares no application to start.' };
const published = ({ review = true, outcome = true, start = null } = {}) => ({ phase: 'implement', publishIfReady: { published: true,
  ...(outcome ? { outcomeReview } : {}), ...(start ? { applicationStart: start } : {}), ...(review ? { reviewSubagent: handoff } : {}),
  next: { instruction: `Published. ${handoff.instruction}`, commandGuidance: { command: 'singularity-flow review-source context implement --json', copilotCommand: '/sf-review-source implement' } },
  output: 'Published implement generation 1.' } });

test('a returned reviewer comes first, whatever else the publication offers', () => {
  // A code step's application and outcome questions were asked first, so start-reviewer never came for a reviewed code
  // step, and "Not now" relayed /sf-review-source while no reviewer ran (agent-text audit, 2026-11-11).
  for (const outcome of [false, true]) for (const start of [null, declared, undeclared]) {
    if (!outcome && start) continue;
    const act = agentAct(published({ outcome, start }));
    const where = JSON.stringify({ outcome, start: start?.declared ?? null });
    assert.equal(act.state, 'start-reviewer', where);
    assert.equal(act.do, null, where);
    assert.equal(act.ask, undefined, where);
    assert.equal(act.read[0], 'publishIfReady.reviewSubagent', where);
    assert.doesNotMatch(JSON.stringify({ ask: act.ask, do: act.do }), /\/sf-review-source/u, where);
    if (outcome) assert.match(act.said, /only after a ready review, never before it/u, where);
  }
  // Without a reviewer to start, the code step's question stays where it was.
  assert.equal(agentAct(published({ review: false, start: declared })).state, 'ask-person');
});

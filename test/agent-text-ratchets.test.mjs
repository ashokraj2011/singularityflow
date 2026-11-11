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
import { clarificationCheckpoint } from '../src/clarifications.mjs';
import { CLARIFICATION_RESPONSE_FORMAT } from '../src/phase-staging-paths.mjs';
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

test('every publish result of a reviewed step acts start-reviewer, and the publish act goes through the route that hands one back', () => {
  // Story anu-bin verification (2026-11-11): plain prepublish acted 'publish' with `phase publish`, whose result named no
  // reviewer, so generation 3 was published and the turn ended with none started.
  const plain = { schemaVersion: 1, resultType: 'sflow-phase-publication', status: 'published', workId: 'QF-1', phase: 'implement', generation: 1 };
  for (const result of [published(), published({ outcome: false }), published({ start: declared }),
    { ...plain, reviewSubagent: handoff }, { ...plain, reviewSubagent: handoff, outcomeReview, applicationStart: declared }]) {
    const act = agentAct(result);
    assert.deepEqual([act.state, act.do], ['start-reviewer', null], JSON.stringify(Object.keys(result)));
    assert.match(act.read[0], /(?:^|\.)reviewSubagent$/u);
  }
  const ready = { resultType: 'sflow-phase-prepublish', status: 'ready', workId: 'QF-1', phase: 'verification',
    commands: { publish: 'singularity-flow phase publish verification --authored governed-agent --channel copilot-host' } };
  const act = agentAct(ready);
  assert.equal(act.state, 'publish');
  assert.equal(act.do.shell, 'singularity-flow phase prepublish verification --work-id QF-1 --for-agent --json --publish-if-ready');
  // Once --publish-if-ready itself could not run it, its own command stays, so nothing loops.
  const refused = agentAct({ ...ready, publishIfReady: { published: false, reason: 'publish-command-not-recognized', command: ready.commands.publish } });
  assert.equal(refused.do.shell, ready.commands.publish);
});

test('an instruction to write a file names the file and gives its shape in the same words', () => {
  // "Use a file-edit tool for issued JSON" survived b14f1c553 in the checkpoint's own instruction, where no file is
  // issued and recordAction (with its responseFormat) is absent until context is composed (agent-text audit, 2026-11-11).
  for (const mode of ['required', 'when-needed']) {
    const { instruction } = clarificationCheckpoint({ mode }, { recordState: 'missing', errors: [] });
    assert.doesNotMatch(instruction, /\bissued (?:JSON|staging file)\b/u, mode);
    assert.ok(instruction.includes(`at responseStagingPath as ${CLARIFICATION_RESPONSE_FORMAT}`), mode);
  }
});

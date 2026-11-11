/**
 * What an agent reads says one thing, and only what is there. `[agent-output]`
 *
 * Models follow the words of a result literally and stop when they are unsure. On 2026-11-11 one stopped on
 * `complete: false` beside "do this step's drafting now", one refused to guess a reply format it was never given,
 * one relayed a fallback route while the reviewer it should have started never ran. These ratchets hold the
 * classes, not the instances: a new branch of `act`, a new flag or a new instruction meets them too.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentAct, LOOP_THRESHOLD, observeAgentLoop } from '../src/agent-output.mjs';
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

test('the first convergence review act already says to ask in this chat, show the digest and confirm once', () => {
  // Only the loop warning on the third repeat said it (session mining N4, 2026-11-11).
  const act = agentAct({ resultType: 'sflow-submission-readiness', workId: 'W', phaseId: 'convergence', head: 'h0',
    classification: 'convergence-advance-required', nextCommand: 'singularity-flow story advance --work-id W', nextSkill: '/sf-submit' });
  assert.equal(act.state, 'confirm-review');
  assert.match(act.said, /Run do\.shell once to show the review and its digest, then ask the person now in this chat to confirm it; only on an explicit yes run the returned --confirm command once\./u);
});

test('questions that hold the task say the task goes on after the answers', () => {
  const act = agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required', context: { text: 'x' },
    taskCompletion: { complete: false, state: 'blocked', instruction: 'Finish the admitted task or preserve its exact blocker and owner route.' } });
  assert.equal(act.state, 'ask-person');
  assert.match(act.said, /taskCompletion is blocked only on these answers: once they are given, record them and author this step in this same turn\./u);
});

test('a correction line names where to fix, by path or by the packet field', () => {
  // Review findings carry `field`, not `path`, so act.fix named no place (agent-text audit, 2026-11-11).
  const act = agentAct({ resultType: 'source-review-check', findings: [
    { code: 'review-format-invalid', field: 'rows[3].sourceId', message: 'Invalid input' },
    { code: 'TRACE', path: 'src/a.mjs', line: 4, message: 'Tag the clause.' }] });
  assert.deepEqual(act.fix, ['review-format-invalid at rows[3].sourceId: Invalid input', 'TRACE at src/a.mjs:4: Tag the clause.']);
});

test('the loop warning never tells an agent to run what is the person\'s, nor to ask questions that are not there', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-text-loop-'));
  const previous = process.env.SINGULARITY_FLOW_FINDING_STREAKS;
  process.env.SINGULARITY_FLOW_FINDING_STREAKS = path.join(root, 'streaks');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_FINDING_STREAKS;
    else process.env.SINGULARITY_FLOW_FINDING_STREAKS = previous;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const now = Date.parse('2026-11-11T12:00:00Z');
  // A person-authored publication (confirm-in-terminal) and a raw Git route (ask-person, no questions).
  const cases = [
    { resultType: 'sflow-phase-prepublish', workId: 'W', phase: 'intake', status: 'ready', head: 'h0', publishIfReady: { published: false, reason: 'person-authored' },
      commands: { publish: 'singularity-flow phase publish intake --authored human --channel manual-in-place' } },
    { workId: 'W', phase: 'intake', head: 'h0', nextAction: { command: 'git stash push -m keep', reason: 'Keep the edits aside.' } }];
  for (const [index, result] of cases.entries()) {
    const act = agentAct(result);
    assert.ok(['confirm-in-terminal', 'ask-person'].includes(act.state), act.state);
    const seen = [1, 2, 3].map((minute) => observeAgentLoop(root, { ...result, workId: `W${index}` }, act, { now: now + minute * 60_000 }));
    assert.equal(seen[2].loop.repeated, LOOP_THRESHOLD);
    assert.doesNotMatch(seen[2].loop.instruction, /Do act\.do now|run do\.shell|questions/u, act.state);
    assert.match(seen[2].loop.instruction, /never run it/u, act.state);
  }
});

test('no app-start text offers only the governed proposal: each one says the local save that needs none', async () => {
  // "Add application.start … through a capability proposal" read as a governed change, and the agent stopped instead
  // of offering /sf-run-app (700eaaf95); the same words stayed in app plan, help and the start offer (2026-11-11).
  const { readFile } = await import('node:fs/promises');
  for (const file of ['src/commands/app.mjs', 'src/help-pages.mjs', 'src/application-start-offer.mjs', 'src/application-run.mjs']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const line of text.split('\n').filter((entry) => /application\.start|start entry|no application to start/iu.test(entry) && /proposal|declares one/iu.test(entry))) {
      const window = text.slice(text.indexOf(line), text.indexOf(line) + line.length + 400);
      assert.match(window, /this checkout only|save-local|saved on this checkout/u, `${file}: ${line.trim()}`);
    }
  }
});

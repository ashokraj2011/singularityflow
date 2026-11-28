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

import { agentAct, boundedAgentOutput, LOOP_THRESHOLD, observeAgentLoop } from '../src/agent-output.mjs';
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
    if (start?.declared) assert.match(act.said, /Once a ready review is submitted, ask publishIfReady\.applicationStart's one question; never before it/u, where);
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

test('the first convergence act submits the report for approval in the same turn, with no separate confirmation', () => {
  // The convergence confirmation folds into its approval (owner, 2026-11-19): the person says Yes once, at the approval; SFlow
  // approves a clean report itself (owner, 2026-11-21: convergence folds into the code approval).
  const act = agentAct({ resultType: 'sflow-submission-readiness', workId: 'W', phaseId: 'convergence', head: 'h0',
    classification: 'convergence-advance-required', nextCommand: 'singularity-flow story advance --work-id W', nextSkill: '/sf-submit' });
  assert.equal(act.state, 'next');
  assert.match(act.said, /Run do\.shell once; when it says the report is ready, run its --submit command once in this same turn: it sends the report for approval: SFlow approves a clean one itself, otherwise the person approves it there with one Yes\. Never ask them to confirm it first\./u);
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

// The keys act may carry. A new one is a decision a reviewer sees here, never a flag that slips in beside `said`.
const ACT_KEYS = new Set(['state', 'do', 'read', 'said', 'ask', 'strategy', 'story', 'next', 'fix', 'loop', 'paths']);
// Words that read as the work's own state when they sit beside act (Story cplus, 2026-11-11).
const WORK_STATE_WORDS = /^(?:complete|completed|done|finished|incomplete|retained|ready|state|blocked|failed|truncated)$/u;
const booleans = (value, trail = 'act') => (typeof value === 'boolean' ? [trail]
  : Array.isArray(value) ? value.flatMap((child, index) => booleans(child, `${trail}[${index}]`))
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => booleans(child, `${trail}.${key}`)) : []);

test('act carries only its own keys and no true/false flag, and the display block beside it names no work state', async (t) => {
  const corpus = [published(), published({ start: declared }), published({ review: false, start: declared }), published({ review: false, start: undeclared }),
    { resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'intake', authoringProgress: { stage: 'resume-draft' }, taskCompletion: { complete: false } },
    { resultType: 'sflow-phase-entry', status: 'clarification-required', taskCompletion: { complete: false, state: 'blocked' } },
    { resultType: 'sflow-phase-prepublish', status: 'ready', phase: 'intake', commands: { publish: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host' } },
    { resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{ code: 'X', message: 'Fix it.' }] },
    { resultType: 'sflow-kept-result', status: 'running', running: [{ command: 'singularity-flow phase prepublish intake' }], retry: 'singularity-flow result last --wait --for-agent --json' },
    { resultType: 'sflow-kept-result', status: 'interrupted', interrupted: { command: 'singularity-flow phase prepublish intake' } },
    { resultType: 'sflow-submission-readiness', classification: 'convergence-advance-required', nextCommand: 'singularity-flow story advance --work-id W' },
    { resultType: 'source-review-check', retentionReady: true, repair: {}, findings: [] },
    { error: { code: 'X', message: 'Refused.' }, remediationPlan: { steps: [{ command: 'singularity-flow recover W --json', label: 'Recover.' }] } }];
  for (const result of corpus) {
    const act = agentAct(result);
    const where = JSON.stringify(result).slice(0, 120);
    assert.deepEqual(Object.keys(act).filter((key) => !ACT_KEYS.has(key)), [], where);
    assert.deepEqual(booleans(act), [], where);
  }
  // The bounded views: kept in a checkout, a literal preview, and with nowhere to keep the rest.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-text-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const large = { resultType: 'sflow-phase-entry', status: 'clarification-required', workId: 'W', phase: 'intake', ready: true,
    clarification: { checkpoint: { stage: 'derive-questions' } }, context: { text: 'x'.repeat(20_000) }, notes: 'y'.repeat(9_000) };
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-text-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const [text, cwd] of [[JSON.stringify(large), root], [JSON.stringify([large, large]), root], [JSON.stringify(large), outside]]) {
    const view = JSON.parse(await boundedAgentOutput(text, { cwd }));
    assert.deepEqual(Object.keys(view).slice(0, 2), ['act', 'agentOutput']);
    assert.deepEqual(Object.keys(view.agentOutput).filter((key) => WORK_STATE_WORDS.test(key)), [], JSON.stringify(view.agentOutput).slice(0, 200));
    assert.deepEqual(booleans(view.agentOutput, 'agentOutput'), []);
    assert.ok(['bounded', 'preview', 'detail-unavailable'].includes(view.agentOutput.view), view.agentOutput.view);
  }
});

test('/sf-run-app frees a held port the way the refusal names, and never kills anything itself', async () => {
  // "Never kill any other process" overrode the person's own "kill the app on 5173 and start this one" (session mining N2).
  const { readFile } = await import('node:fs/promises');
  const skill = await readFile(new URL('../plugin/skills/sflow-run-app/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /`APP_PORT_IN_USE` names the port's holder: an SFlow run \(any checkout\) ends by its `details\.nextAction` once the person confirms; another process only the person ends, one they named, in their own terminal \(`details\.holder\.personStop`: `kill <pid>`, on Windows `taskkill \/PID <pid>`\)\. Never kill a process yourself\./u);
});

test('every skill line that starts a long-running command says how to wait for it', async () => {
  // `app start` stays attached until the app exits and `tests run` until the tests end: run with no word on waiting,
  // a host timeout cut them, and a plain --json result could not be read back (agent-text audit, 2026-11-11).
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../plugin/skills/', import.meta.url);
  const missing = [];
  for (const name of await readdir(root)) {
    let text;
    try { text = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!/\brun `singularity-flow (?:app start|tests run)\b/iu.test(line)) continue;
      // Kept and read back with `result last` (--for-agent), or run in the background and polled.
      if (!/--for-agent[^`]*`[^.]*(?:result last|foreground)|background \(async\) mode[^.]*app status/u.test(line)) missing.push(`${name}: ${line.slice(0, 160)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every text that names ask_user also names VS Code\'s question tool', async () => {
  // VS Code's own chat calls it vscode_askQuestions: a literal model found no ask_user there, took "unavailable: show
  // them and stop" and ended the turn (agent-text audit, 2026-11-11).
  const { readdir, readFile } = await import('node:fs/promises');
  const { QUESTION_TOOL_CONTRACT } = await import('../scripts/skill-policy.mjs');
  const root = new URL('../plugin/skills/', import.meta.url);
  const missing = [];
  for (const name of await readdir(root)) {
    let text;
    try { text = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
    if (text.includes('`ask_user`') && !text.includes(QUESTION_TOOL_CONTRACT)) missing.push(name);
  }
  assert.deepEqual(missing, []);
  assert.match(QUESTION_TOOL_CONTRACT, /vscode_askQuestions in VS Code/u);
  // Placed in the contract above the steps, it never counts as the steps' first question (plugin.test.mjs order checks).
  assert.doesNotMatch(QUESTION_TOOL_CONTRACT, /`ask_user`/u);
  for (const file of ['src/copilot-answer-binding.mjs', 'src/clarifications.mjs', 'src/agent-output.mjs']) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const line of text.split('\n').filter((entry) => /ask_user/u.test(entry) && !/^\s*(?:\/\/|\*)/u.test(entry))) {
      assert.match(line, /vscode_askQuestions|`ask_user` returns|`ask_user` is unavailable/u, `${file}: ${line.trim().slice(0, 120)}`);
    }
  }
});

test('a skill never stops or relays where the act its command returns says to go on', async () => {
  // Skill text that disagreed with act: /sf-phase relayed `handoff` while act said start-reviewer; /sf-review-source,
  // loaded by the reviewer sub-agent, ended "Run this in a new chat:"; and it stopped on a check's reload-context where
  // act said to read a fresh context and review again (agent-text audit, 2026-11-11).
  const { readFile } = await import('node:fs/promises');
  const skill = async (name) => readFile(new URL(`../plugin/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
  const clause = (text, word) => text.split(/(?<=[.;])\s+/u).filter((sentence) => sentence.includes(word));
  const review = await skill('sflow-review-source');
  const reload = agentAct({ resultType: 'source-review-check', repair: { status: 'reload-context', instruction: 'Inputs changed. Read a fresh context and independently review it.' },
    continuation: { nextAction: { command: 'singularity-flow review-source context implement --json' } } });
  assert.equal(reload.state, 'next');
  for (const sentence of clause(review, '`reload-context`')) assert.doesNotMatch(sentence, /\bstop\b|report the exact blocker/u, sentence);
  for (const sentence of clause(review, '`Run this in a new chat:`')) assert.match(sentence, /^Otherwise\b|^As a sub-agent|new-chat/u, sentence);
  for (const name of ['sflow-phase', 'sflow-code']) {
    const text = await skill(name);
    for (const sentence of clause(text, "Relay `handoff`")) assert.match(text.slice(Math.max(0, text.indexOf(sentence) - 160), text.indexOf(sentence)), /`reviewSubagent`/u, `${name}: ${sentence}`);
    assert.match(text, /`reviewSubagent`/u, name);
  }
});

test('a view that could not keep the rest never says to run the command again to read it', async (t) => {
  // "Run the command from the Story checkout to read them" sent a publication or a record to run again just to read its
  // result; only a read runs again (agent-text audit, 2026-11-11).
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-text-norepo-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const large = { resultType: 'sflow-phase-publication', status: 'published', workId: 'W', phase: 'intake', notes: 'y'.repeat(9_000) };
  for (const text of [JSON.stringify(large), 'z\n'.repeat(5_000)]) {
    const view = await boundedAgentOutput(text, { cwd: outside });
    assert.doesNotMatch(view, /Run the command (?:from the Story checkout|without --for-agent)/u);
    assert.match(view, /never run a command that changed anything again to read it/u);
  }
});

test('every field act names in read, said or how is in the same result', () => {
  // "stage the issued JSON" named a file that was not there; read lists and said texts name fields an agent then looks
  // for and, not finding, stops (agent-text audit, 2026-11-11).
  const own = /^(?:do|act|agentOutput|ask)\./u;
  const resolves = (result, trail) => trail.split('.').reduce((node, key) => (node == null ? undefined : node[key.replace(/\[\]$/u, '')]), result) !== undefined;
  const corpus = [
    published(), published({ start: declared }), published({ review: false, start: declared }),
    { resultType: 'sflow-phase-entry', status: 'clarification-required', context: { text: 'x' }, clarification: { checkpoint: { stage: 'derive-questions' } },
      taskCompletion: { complete: false, state: 'blocked' } },
    { resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'intake', authoring: {}, mutationContract: {}, authoringProgress: {}, scopeReview: {}, context: {} },
    { resultType: 'sflow-phase-prepublish', status: 'ready', phase: 'intake', scopeReview: {}, commands: { publish: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host' } },
    { resultType: 'sflow-kept-result', status: 'interrupted', interrupted: { command: 'singularity-flow phase prepublish intake' }, safeRead: 'singularity-flow nextsteps --for-agent --json' }];
  for (const result of corpus) {
    const act = agentAct(result);
    const where = `${result.resultType}/${result.status}`;
    for (const trail of act.read ?? []) assert.ok(resolves(result, trail), `${where}: read names ${trail}`);
    for (const text of [act.said, act.ask?.how].filter(Boolean)) {
      for (const [trail] of text.matchAll(/\b[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*(?:\[\])?)+\b/gu)) {
        if (own.test(trail) || !Object.hasOwn(result, trail.split('.')[0])) continue;
        assert.ok(resolves(result, trail), `${where}: said names ${trail}`);
      }
    }
  }
});

test('every example a review schema description gives is a value that schema accepts', async () => {
  // The schema said code:<path> while the real IDs are code:src:App.jsx, and the check answered only "Invalid input"
  // (dda58fc6d). Any "such as X" in a description must itself pass the field it describes.
  const { sourceReviewReportSchema } = await import('../src/source-review-contract.mjs');
  const examples = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    for (const [, example] of String(node.description ?? '').matchAll(/\bsuch as ([^\s,;)]+)/gu)) examples.push({ trail, example, pattern: node.pattern ?? null, values: node.enum ?? null });
    for (const [key, child] of Object.entries(node)) walk(child, `${trail}.${key}`);
  };
  for (const kind of ['specification', 'planning', 'document', 'code']) walk(sourceReviewReportSchema(kind), kind);
  // A source ID is not derivable from its path, so the code schema gives no example: it names sources[].id, and the check
  // writes the ID where the exact path was written [owner, 2026-11-20].
  assert.match(JSON.stringify(sourceReviewReportSchema('code')), /sources\[\]\.id; its exact path is accepted too, and review-source check writes the ID in its place/u);
  for (const { trail, example, pattern, values } of examples) {
    if (pattern) assert.match(example, new RegExp(pattern, 'u'), trail);
    if (values) assert.ok(values.includes(example), trail);
  }
});

test('a step whose document is still to write is named as its own work, not as a block with no way on', async () => {
  // "It's blocked because a required artifact is missing, so there's no next phase to advance to yet" (Story anu-bin).
  const { RESULT_MESSAGES } = await import('../src/gateway/messages.mjs');
  const entry = RESULT_MESSAGES['work.blocked.required-artifact-missing'];
  assert.doesNotMatch(entry.label, /missing/u);
  assert.equal(entry.label, 'This step\'s document is not written yet');
  // The readiness gate pairs it with its way on: continue this work, producing the artifact.
  const { RESULT_MESSAGES: all } = await import('../src/gateway/messages.mjs');
  assert.equal(all['readiness.produce-the-artifact'].label, 'Produce the artifact');
});

test('nothing tells an agent to cut an SFlow command\'s output, and every turn rule says reads run alone too', async () => {
  // Daily run 2026-11-17: in 3 of 5 turns the first call was `singularity-flow phase enter --compose --for-agent --json |
  // head -c 6000`, refused PHASE_MUTATION_SHELL_COMMAND_UNVERIFIED, one wasted call a turn. No skill said to pipe; the turn
  // rule said only "do not wrap or chain kernel mutations", which read as leave to pipe a read, and the entry's first line
  // said it "composes context", which read as a long reply. The reply is short and names files for the rest.
  const { readdir, readFile } = await import('node:fs/promises');
  const { PHASE_ENTRY_PAUSE_GUARD } = await import('../src/copilot-mode.mjs');
  const { mutationToolProtocol } = await import('../src/phase-mutation-contract.mjs');
  const root = new URL('../plugin/skills/', import.meta.url);
  // A command in backticks piped to a reader or redirected (` > file`, ` 2>&1`; a `<PLACEHOLDER>` is neither), or a head/tail cut.
  const cut = /`singularity-flow [^`\n]*(?:\|\s*(?:head|tail|jq|grep|cut|less|more)\b|\s(?:\d?>>?|&>)\s*\S)[^`\n]*`|\b(?:head|tail) -[cn]\s*\d/u;
  const found = [];
  for (const name of await readdir(root)) {
    let text;
    try { text = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
    if (cut.test(text)) found.push(`${name}: ${cut.exec(text)[0]}`);
    // Every skill entered by `phase enter` says to run it as written, alone, and why: its reply is short.
    if (text.includes(PHASE_ENTRY_PAUSE_GUARD)) assert.match(text, /Run it as written, alone: never piped to `head` or redirected; its reply is short/u, name);
  }
  assert.deepEqual(found, []);
  assert.match(PHASE_ENTRY_PAUSE_GUARD, /never piped to `head` or redirected/u);
  // The authoring turn's terminal rule: every SFlow command alone, reads included; repository commands stay the author's.
  const terminal = mutationToolProtocol({ turnMode: 'authoring', allow: { application: true, artifacts: [] } }).terminal;
  assert.match(terminal, /^Run every SFlow command standalone, reads included \(never piped to head, redirected or chained\)/u);
  assert.doesNotMatch(terminal, /chain kernel mutations/u);
});

test('a skill asks a next version as the engine\'s own "Start version N of …?", never a draft question of its own', async () => {
  // Daily run 2026-11-17: /sf-code's "offer 'start draft N+1 for this change'" became a true/false form titled "Start draft 2
  // for this change?". A draft is the private working copy; the person starts a version, and the question is the engine's.
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../plugin/skills/', import.meta.url);
  for (const name of await readdir(root)) {
    let text;
    try { text = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
    assert.doesNotMatch(text, /\bdraft (?:N(?:\+1)?|\d+)\b/u, name);
    if (/A change asked for after publication/u.test(text)) assert.match(text, /ask its "Start version N\+1 of …\?"/u, name);
  }
});

test('no skill routes the person back to itself, unless the sentence names what changed first', async () => {
  // Inside /sf-decide, "Next in Copilot: /sf-next" and /sf-next's "/sf-decide" sent a person round between the two, and a
  // refusal's /sf-decide route sent them round inside one (owner, 2026-11-19: "too many confusing loops", loops 1 and 15).
  // A sentence that names a skill's own command with a routing word, and no "never" or "not", is a route back to itself.
  // Each one below was reviewed: a rerun after the person changed something first, another form of the command, or words
  // that describe what was typed. A new one fails until it is the same kind and is added here with its reason.
  const { readdir, readFile } = await import('node:fs/promises');
  const REVIEWED = new Set([
    'sflow-cancel: the person reruns `/sf-cancel` after it.', // after /sf-recover kept the branch's changes
    'sflow-confirm: description: Run one reviewed SFlow confirmation, by the short code a returned /sf-confirm route carried, once.', // what it runs
    'sflow-explain: - Nothing after `/sf-explain`: run nothing and ask what to explain.', // what was typed
    'sflow-pause: An explicit SFlow request only offers `/sf-pause off`;', // another form: it lifts the pause
    'sflow-task: Show start\'s readiness lines in one line, then `/sf-task` as what carries the task on.', // another form: with no words it does the started task's next action [ITW M2]
    'sflow-ready: rerun `/sf-ready`), record secrets, or edit a Story checkout.', // the end of a "never" list
    'sflow-ready: rerun `/sf-ready` for a new `planId`,', // a new plan
    'sflow-recover: Then the person reruns `/sf-recover`.', // after the person's own step
    'sflow-refresh-branch: Then the person reruns `/sf-refresh-branch`.', // after /sf-recover kept the changes
    'sflow-session: Forward `/sf-session --refresh` with the same selectors.', // another form: it refreshes
    'sflow-start: The person commits, ignores, moves or lands them (`/sf-adhoc`), then reruns `/sf-start`.', // after the changes moved
    'sflow-worldmodel: - **Bare `/sf-worldmodel` is read-only.** With an active Story run `singularity-flow wm brief --phase <current phase> --json` (what that phase prompt carries);' // what was typed
  ]);
  const ROUTE = /\b(?:run|runs|rerun|reruns|invoke|invokes|give|gives|show|relay|offer|offers|forward|send|open|use|start|type|types|end with|Next in Copilot)\b/iu;
  const NOT = /\b(?:never|not|neither|nor|no)\b/iu;
  const root = new URL('../plugin/skills/', import.meta.url);
  const loops = [];
  for (const name of (await readdir(root)).sort()) {
    let text;
    try { text = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8'); } catch { continue; }
    const own = new RegExp(`/${name.replace(/^sflow-/u, 'sf-')}(?![\\w-])`, 'u');
    for (const sentence of text.split(/(?<=[.;!?])\s+|\n/u).map((entry) => entry.trim())) {
      if (own.test(sentence) && ROUTE.test(sentence) && !NOT.test(sentence) && !REVIEWED.has(`${name}: ${sentence}`)) loops.push(`${name}: ${sentence.slice(0, 200)}`);
    }
  }
  assert.deepEqual(loops, []);
  // The two loops themselves are gone: /sf-decide goes on with its own list, and a review chat reviews in itself.
  const decide = await readFile(new URL('sflow-decide/SKILL.md', root), 'utf8');
  assert.doesNotMatch(decide, /Next in Copilot: \/sf-next/u);
  assert.match(decide, /re-read the list; go on from 11, never `\/sf-next`\./u);
  assert.match(await readFile(new URL('sflow-review-source/SKILL.md', root), 'utf8'), /`status`: read\. Its `\/sf-review-source` route is this chat: review here\./u);
});

test('no two skills send VS Code\'s chat round between each other: /sf-approve and /sf-decide', async () => {
  // Owner's Story, 2026-11-20: VS Code's /sf-approve named `/sf-decide` as the approval page's route (steps 3 and 5), and
  // /sf-decide step 1 opened the card, read the list again and, its next being the approval, did /sf-approve 1-6 now. Nothing
  // changed between the two, so the chat went round and nothing was approved. A skill's route for VS Code (its own chat, the
  // approval page, the Decide card's approval row) to another skill that routes back to it is that loop, whatever the words.
  // A route back that only follows a change (an answer recorded first) may be reviewed here, with what changed.
  const { readdir, readFile } = await import('node:fs/promises');
  const REVIEWED = new Set([]);
  const root = new URL('../plugin/skills/', import.meta.url);
  const skills = new Map();
  for (const name of (await readdir(root)).sort()) {
    try { skills.set(name, await readFile(new URL(`${name}/SKILL.md`, root), 'utf8')); } catch { /* not a skill */ }
  }
  const sentences = (text) => text.split(/(?<=[.;!?])\s+|\n/u).map((entry) => entry.trim()).filter(Boolean);
  // A command named just after never, not or no is a way away from it, not a route to it.
  const routes = (text, target) => sentences(text).filter((sentence) => [...sentence.matchAll(new RegExp(`/${target.replace(/^sflow-/u, 'sf-')}(?![\\w-])`, 'gu'))]
    .some((match) => !/\b(?:never|not|no|nor|neither)\b[^.;:]{0,30}$/iu.test(sentence.slice(0, match.index))));
  const VS_CODE = /VS Code|approval page|approval row/u;
  const loops = [];
  for (const [from, text] of skills) {
    for (const [to, back] of skills) {
      const there = from === to ? [] : routes(text, to).filter((sentence) => VS_CODE.test(sentence));
      const returns = there.length ? routes(back, from).filter((sentence) => !REVIEWED.has(`${to}: ${sentence}`)) : [];
      if (returns.length) loops.push(`${from} -> ${to} (${there[0].slice(0, 120)}), back: ${returns.map((sentence) => sentence.slice(0, 120)).join(' | ')}`);
    }
  }
  assert.deepEqual(loops, []);
  // The incident's two skills: VS Code reaches the approval page through the card's own tool, never /sf-decide, and /sf-decide
  // reads its list again, whose approval branch is /sf-approve, only when the card did not open that page.
  const approve = skills.get('sflow-approve');
  const decide = skills.get('sflow-decide');
  assert.match(approve, /In VS Code's own chat never ask: the person approves or sends it back on the approval page, which `#sflowDecide` with `workId` opens; once open, end with only that, no command\./u);
  assert.doesNotMatch(approve, /approval (?:page|row)[^.]*`\/sf-decide/u);
  const step1 = decide.slice(decide.indexOf('\n1. '), decide.indexOf('\n2. '));
  // `approval-*`: the page opened on this Story (`approval-open`), or on a window that shows another (`approval-elsewhere`,
  // whose next selects this Story there) [hardening C, F4]: either way the approval is the page's, never this list's.
  const gate = step1.indexOf('Then, unless it returned `approval-*`, run `singularity-flow decisions <WORK-ID> --for-agent --json`');
  assert.ok(gate > 0 && gate < step1.indexOf('do /sf-approve 1-6 now'), 'the read whose approval branch is /sf-approve runs only when the card did not open the approval page');
  // The card says `approval-open` when it opened the page, and its tool tells the agent the turn ends there.
  const tool = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8')).contributes.languageModelTools
    .find((entry) => entry.name === 'singularityFlow_decide');
  assert.match(tool.modelDescription, /status approval-open\): end the turn there with no approve route at all, neither \/sf-approve, approve nor @sflow \/approve\. Only when it says the page could not open is its next @sflow \/approve/u);
  assert.match(tool.modelDescription, /\(status approval-elsewhere\), relay its next, which selects that Story there, and end the turn the same way/u);
});

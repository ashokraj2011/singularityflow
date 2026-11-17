/**
 * The third account of what a person typed (owner, 2026-11-18): "a question: answered, nothing to change". The words are
 * kept, always. The step's author records it as it records the other two (`departure account --as-question`), and the
 * approver sees it beside them; nothing guesses it from the words. On a published step the version question's third answer,
 * "No, it was just a question", records that same account on the person's own answer and opens nothing: on the decisions
 * card (`decisions record --just-a-question`, run by the card outside the chat), to the question tool in a /sf-code or
 * /sf-phase turn (`phase rollover --as-question --confirm`, held by the guard to the person's reply), or in their terminal.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { askedForGeneration, noteAskedFor, waitingWords } from '../src/asked-for.mjs';
import { accountWords, INSTRUCTION_ACCOUNTS } from '../src/asked-for-records.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { asQuestion, sideOf } from '../src/copilot-answer-binding.mjs';
import { JUST_A_QUESTION, NOT_NOW, runCard, START_VERSION, versionOpeningForm } from '../plugin/extensions/decisions/card.mjs';
import { copilotTurn, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';

const W = 'QAC-1';
const json = (story, args, { fail = false } = {}) => {
  const ran = story.raw([...args, '--json']);
  if (!fail) assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-2000)}`);
  return { status: ran.status, value: JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null') };
};
const argvOf = (command) => command.replace(/^singularity-flow\s+/u, '').split(/\s+/u);
const denied = (decision) => (decision.permissionDecision ?? decision.hookSpecificOutput?.permissionDecision) === 'deny';
const reasonOf = (decision) => decision.permissionDecisionReason ?? decision.hookSpecificOutput?.permissionDecisionReason ?? '';

test('a question is the third account: in plain words beside the other two, and a reply of "No, it was just a question" is its own answer', () => {
  assert.deepEqual(INSTRUCTION_ACCOUNTS, ['within-plan', 'departure', 'question']);
  assert.equal(accountWords({ as: 'question', clauses: [], departure: null }), 'accounted for as a question: answered, nothing to change');
  assert.equal(accountWords({ as: 'question', clauses: [], departure: null, answeredBy: { surface: 'decisions-card' } }),
    'accounted for as a question: answered, nothing to change (the person said so when asked to start a new version)');
  const yesNo = { yes: ['start it'], no: ["don't start"] };
  for (const words of ['no, it was just a question', 'no it was just a question', 'just a question', "no - it's just a question"]) {
    assert.equal(sideOf({ texts: [words] }, yesNo), 'question', words);
  }
  // Never a guess from the words: a plain No is a No, and a change worded as a question is no answer at all.
  assert.equal(sideOf({ texts: ['no'] }, yesNo), 'no');
  assert.equal(sideOf({ texts: ['can you make the button blue'] }, yesNo), null);
  assert.equal(sideOf({ texts: ['yes'] }, yesNo), 'yes');
});

test('the agent asks the version question with its third answer only for a typed change, and runs its command only on that answer', () => {
  const digest = `sha256:${'c0ffee12'.repeat(8)}`;
  const preview = { resultType: 'sflow-generation-rollover', mutates: false, question: 'Start version 2 of Intake? Published version 1 will stay unchanged.',
    nextAction: { command: `singularity-flow phase rollover intake --confirm ${digest}`, copilotCommand: `/sf-confirm phase rollover intake --confirm ${digest}`, reason: 'Start version 2.' } };
  assert.deepEqual(agentAct(preview).ask.choices.map((choice) => choice.label), ['Yes', 'No']);
  const typed = agentAct({ ...preview, justAQuestion: { answer: JUST_A_QUESTION, command: `singularity-flow phase rollover intake --as-question --confirm ${digest} --json` } });
  assert.deepEqual(typed.ask.choices.map((choice) => choice.label), ['Yes', 'No', JUST_A_QUESTION]);
  assert.match(typed.ask.how, /Only on their "No, it was just a question" run justAQuestion\.command once: it keeps their words as a question and opens nothing\. Never answer it yourself\.$/u);
  // The entry's own question: the third answer for a change the person typed, never for a review's corrections.
  const entry = (requests) => agentAct({ resultType: 'sflow-phase-entry', status: 'successor-confirmation-required', phase: 'intake',
    successor: { targetGeneration: 2, question: preview.question, choices: ['Yes', 'No'], preview: { command: 'singularity-flow phase rollover intake --json' }, findings: [], ...(requests ? { requests } : {}) } });
  assert.deepEqual(entry(['Why do the callers read the value?']).ask.choices.map((choice) => choice.label), ['Yes', 'No', JUST_A_QUESTION]);
  assert.deepEqual(entry(null).ask.choices.map((choice) => choice.label), ['Yes', 'No']);
  // The guard reads --as-question as the CLI does: present, and not false, is the question.
  assert.deepEqual([asQuestion({ 'as-question': true }), asQuestion({ 'as-question': 'true' }), asQuestion({ 'as-question': 'false' }), asQuestion({})], [true, true, false, false]);
});

test('the Copilot decisions card offers "No, it was just a question" for a typed change only, and records it outside the chat, opening nothing', async () => {
  const opening = { workId: W, phase: 'intake', version: 2, question: 'Start version 2 of Intake? Published version 1 will stay unchanged.', confirmation: 'sha256:c', digest: 'sha256:d' };
  // Proposed for a review's corrections or a return: two answers, as before.
  assert.deepEqual(versionOpeningForm(opening).requestedSchema.properties.start.enum, [START_VERSION, NOT_NOW]);
  const typed = { ...opening, justAQuestion: true };
  const form = versionOpeningForm(typed);
  assert.deepEqual(form.requestedSchema.properties.start.enum, [START_VERSION, JUST_A_QUESTION, NOT_NOW]);
  assert.match(form.message, /"No, it was just a question" keeps what you typed as a question and starts nothing\.$/u);
  // A host whose card cannot record it (no handler) never offers it.
  assert.deepEqual(versionOpeningForm(typed, { question: false }).requestedSchema.properties.start.enum, [START_VERSION, NOT_NOW]);
  const NEXT = { command: 'singularity-flow submit intake', copilotCommand: '/sf-submit intake', skill: '/sf-submit' };
  const run = async (reply, versionOpening = typed) => {
    const seen = { asked: [], consented: [], questions: [], shown: [] };
    const result = await runCard({
      read: async () => ({ workId: W, headline: 'Nothing else waits.', items: [], versionOpening }),
      ask: async (asked) => { seen.asked.push(asked); return reply; },
      show: async (text) => { seen.shown.push(text); },
      consent: async (value) => { seen.consented.push(value); return { words: 'kept', next: null }; },
      question: async (value) => { seen.questions.push(value); return { words: 'It was just a question: version 2 of Intake was not started.', next: NEXT }; },
      record: async () => assert.fail('nothing else is recorded'), witness: async () => null, inspect: async () => null
    });
    return { result, seen };
  };
  const question = await run({ action: 'accept', content: { start: JUST_A_QUESTION } });
  assert.deepEqual(question.seen.questions, [typed], 'the card records the person\'s answer through its own command');
  assert.deepEqual(question.seen.consented, [], 'no yes is kept: nothing opens');
  assert.equal(question.seen.asked.length, 1, 'nothing else is asked');
  assert.deepEqual({ status: question.result.status, recorded: question.result.recorded, message: question.result.message, next: question.result.next },
    { status: 'recorded', recorded: ['version-question'], message: 'It was just a question: version 2 of Intake was not started.', next: NEXT });
  // Offered only where it applies: the same answer to a version proposed for something else records nothing.
  const other = await run({ action: 'accept', content: { start: JUST_A_QUESTION } }, opening);
  assert.deepEqual([other.seen.questions, other.seen.consented, other.result.status], [[], [], 'nothing-to-decide']);
});

/** A quick fix whose intake is published, and the person typed something for it: its next version is previewed. */
async function previewedSuccessor(t, workId = W) {
  const story = await journeyRepository(t);
  startStory(story, workId, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(workId));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const preview = json(story, ['phase', 'rollover', 'intake', '--reason', 'Why do the callers read the value?']).value;
  assert.equal(preview.mutates, false);
  assert.equal(preview.toGeneration, 2);
  return { story, preview };
}

test('in a /sf-phase turn, "No, it was just a question" stands only on the person\'s own reply; it keeps the words as a question and opens nothing', { timeout: 300_000 }, async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  assert.equal(preview.justAQuestion.answer, JUST_A_QUESTION);
  assert.equal(preview.justAQuestion.command, `singularity-flow phase rollover intake --as-question --confirm ${preview.confirmation} --json`);
  const command = preview.justAQuestion.command;
  // Asked nothing: the agent cannot give the person's answer for them.
  const unasked = copilotTurn(story, 'question-unasked');
  unasked.prompt('/sf-phase');
  const refused = unasked.tool('bash', { command });
  assert.ok(denied(refused), JSON.stringify(refused).slice(0, 1500));
  assert.match(reasonOf(refused), /PHASE_MUTATION_ANSWER_UNBOUND: .*just a question is the person's own answer, never this turn's/u);
  // Their Yes is a yes, never "just a question"; and their "just a question" never starts the version.
  const yes = copilotTurn(story, 'question-yes');
  yes.prompt('/sf-phase');
  yes.tool('ask_user', { question: preview.question, choices: ['Yes', 'No', JUST_A_QUESTION] });
  yes.after('ask_user', { question: preview.question, choices: ['Yes', 'No', JUST_A_QUESTION] }, { resultType: 'success', textResultForLlm: 'User responded: Yes' });
  assert.match(reasonOf(yes.tool('bash', { command })), /did not answer that it was just a question/u);
  const asking = copilotTurn(story, 'question-answered');
  asking.prompt('/sf-phase');
  asking.tool('ask_user', { question: preview.question, choices: ['Yes', 'No', JUST_A_QUESTION] });
  asking.after('ask_user', { question: preview.question, choices: ['Yes', 'No', JUST_A_QUESTION] },
    { resultType: 'success', textResultForLlm: `User responded: ${JUST_A_QUESTION}` });
  const start = asking.tool('bash', { command: preview.command });
  assert.ok(denied(start), 'their answer never starts the version');
  assert.match(reasonOf(start), /did not say yes to starting the next version/u);
  const admitted = asking.tool('bash', { command });
  assert.ok(!denied(admitted), JSON.stringify(admitted).slice(0, 1500));
  // The card's command is the person's own step in every turn.
  const forged = asking.tool('bash', { command: `singularity-flow decisions record ${W} --just-a-question ${preview.confirmation} --expect sha256:${'0'.repeat(64)} --json` });
  assert.ok(denied(forged));
  // The command it admitted: one Story commit, nothing opened, the words kept and accounted for as a question.
  const commits = () => Number(story.git('rev-list', '--count', 'HEAD'));
  const before = commits();
  const answered = json(story, argvOf(command).filter((word) => word !== '--json')).value;
  assert.deepEqual({ answer: answered.answer, opened: answered.opened, instructions: answered.instructions, mutates: answered.mutates },
    { answer: JUST_A_QUESTION, opened: null, instructions: [1], mutates: true });
  assert.match(answered.words, /^It was just a question: version 2 of Scope and plan was not started\. What you typed is kept with the step, accounted for as a question with nothing to change/u);
  assert.equal(commits(), before + 1);
  const record = storyRecord(story);
  assert.equal(record.phases.intake.generation, 1, 'version 1 stays as published');
  assert.equal(existsSync(path.join(story.root, story.item, 'context/version-openings/intake-v2.json')), false, 'no version opened');
  assert.deepEqual(record.askedFor.map((entry) => [entry.phase, entry.instruction, entry.text]), [['intake', 1, 'Why do the callers read the value?']]);
  assert.deepEqual(record.instructionAccounts.map((entry) => [entry.instruction, entry.as, entry.answeredBy.surface, entry.author.producer]),
    [[1, 'question', 'question-tool', 'person']]);
  // Nothing else is asked: no version question on the list, and the step's preview has nothing to propose.
  assert.deepEqual(await waitingWords(path.join(story.root, '.git'), record, record.phases.intake), []);
  const listed = json(story, ['decisions', W]).value;
  assert.equal((listed.data ?? listed).versionOpening, undefined);
  assert.deepEqual((listed.data ?? listed).items.filter((item) => item.kind === 'generation-rollover'), []);
  const again = json(story, ['phase', 'rollover', 'intake'], { fail: true }).value;
  assert.equal(again.error?.code, 'GENERATION_CHANGE_NOT_REQUESTED', JSON.stringify(again).slice(0, 1500));
  // The same confirmation again changes nothing: the words are no longer waiting.
  assert.notEqual(story.raw(argvOf(command)).status, 0);
  assert.equal(commits(), before + 1);
});

test('on the decisions card, "No, it was just a question" is recorded for the exact question shown, and the version is not started', { timeout: 300_000 }, async (t) => {
  const { story, preview } = await previewedSuccessor(t);
  const listed = json(story, ['decisions', W]).value;
  const opening = (listed.data ?? listed).versionOpening;
  assert.equal(opening.justAQuestion, true);
  const wrong = json(story, ['decisions', 'record', W, '--just-a-question', opening.confirmation, '--expect', `sha256:${'0'.repeat(64)}`], { fail: true });
  assert.equal(wrong.value.error.code, 'VERSION_CONSENT_WRONG_TARGET');
  assert.equal(storyRecord(story).instructionAccounts, undefined, 'nothing recorded');
  const recorded = json(story, ['decisions', 'record', W, '--just-a-question', opening.confirmation, '--expect', opening.digest]).value;
  const data = recorded.data ?? recorded;
  assert.deepEqual({ answer: data.answer, phase: data.phase, version: data.version, opened: data.opened, instructions: data.instructions },
    { answer: 'just-a-question', phase: 'intake', version: 2, opened: null, instructions: [1] });
  assert.match(data.words, /^It was just a question: version 2 of Scope and plan was not started\./u);
  const record = storyRecord(story);
  assert.deepEqual(record.instructionAccounts.map((entry) => [entry.as, entry.answeredBy.surface]), [['question', 'decisions-card']]);
  assert.equal((json(story, ['decisions', W]).value.data ?? {}).versionOpening, undefined, 'the question is not asked again');
  // No yes was kept: the preview's confirmation opens nothing.
  const confirmed = story.raw(['phase', 'rollover', 'intake', '--confirm', preview.confirmation, '--json']);
  assert.notEqual(confirmed.status, 0, confirmed.stdout.slice(-1500));
  assert.equal(existsSync(path.join(story.root, story.item, 'context/version-openings/intake-v2.json')), false);
  assert.equal(storyRecord(story).phases.intake.generation, 1);
});

// ---------------------------------------------------------------------------------------------------
// A code step: the author's own account, and the approver's view of it.

async function codeStep(t) {
  const { repository, startQuickFix } = await import('./helpers/run-and-test-fixture.mjs');
  const repo = await repository(t, { implementCommands: false });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  config.phases.implement.generation = { requirement: 'required', task: 'code' };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'An agent-authored code step with a human review in this fixture']);
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  const state = async () => JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  const typed = async (text, turnId) => {
    const phase = (await state()).phases.implement;
    await noteAskedFor(path.join(repo.root, '.git'), { workId: 'QF-1', phase: 'implement', generation: askedForGeneration(phase), text, skill: 'sf-code', turnId,
      at: new Date().toISOString() });
  };
  return { repo, state, typed };
}

test('the code step\'s author accounts for a question with --as-question; submission and approval accept it, and the approver sees it', { timeout: 300_000 }, async (t) => {
  const { repo, state, typed } = await codeStep(t);
  const { cli } = await import('./helpers/run-and-test-fixture.mjs');
  await typed('why does the login test fail?', 'turn-a');
  // One of the three, never two at once.
  const both = repo.sflowJson('departure', 'account', '--instruction', '1', '--as-question', '--clauses', 'QF-1:AC-001');
  assert.notEqual(both.status, 0);
  assert.match(JSON.stringify(both.value), /DEPARTURE_OPTIONS_INVALID/u);
  const accounted = repo.sflowJson('departure', 'account', '--instruction', '1', '--as-question');
  assert.equal(accounted.status, 0, JSON.stringify(accounted.value));
  const recorded = await state();
  assert.deepEqual(recorded.askedFor.map((entry) => [entry.instruction, entry.text]), [[1, 'why does the login test fail?']], 'the words are kept');
  assert.deepEqual(recorded.instructionAccounts.map((entry) => [entry.instruction, entry.as, entry.clauses, entry.departure, entry.author.producer]),
    [[1, 'question', [], null, 'governed-agent']], 'the author records it, as it records the other two');
  const checked = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.equal(checked.status, 0, JSON.stringify(checked.value));
  assert.deepEqual(checked.value.askedFor.unaccounted, []);
  assert.equal(checked.value.askedFor.instructions[0].account.as, 'question');
  const summary = path.join(repo.root, 'singularity/work-items/QF-1/artifacts/implement/implementation-summary.md');
  await writeFile(summary, `${await readFile(summary, 'utf8')}\n## What changed\n\nThe value module returns the approved value 2, as the person asked.\n`);
  const published = repo.run(process.execPath, [cli, '--no-model', 'phase', 'publish', 'implement', '--authored', 'governed-agent', '--channel', 'copilot-host', '--json']);
  assert.equal(published.status, 0, published.stdout + published.stderr);
  repo.sflow('submit', 'implement');
  const packet = (({ value }) => value.data ?? value)(repo.sflowJson('decisions', 'QF-1'));
  assert.deepEqual(packet.items.filter((entry) => entry.kind === 'asked-for'), [], 'accounted for: nothing holds the approval');
  // The approver reads it as a question, beside every other account, and can return the step if it was a change.
  assert.deepEqual(packet.approvalEvidence.askedFor.instructions.map((item) => item.words),
    ['Asked for (1) "why does the login test fail?": accounted for as a question: answered, nothing to change']);
  const approved = repo.run(process.execPath, [cli, '--no-model', 'approve', 'implement', '--work-id', 'QF-1', '--yes', '--json']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.equal((await state()).phases.implement.status, 'approved');
});

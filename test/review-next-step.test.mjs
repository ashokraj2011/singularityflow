/**
 * A review's next step, in SFlow's own words and in one turn (owner, 2026-11-16). A person typed
 * `/sf-review-source implementation` in a Copilot CLI session; the review was retained correction-required with three
 * findings, and the reply ended on the findings with no next step. SFlow had returned one, as /sf-recover with "Review
 * the guarded code successor boundary"; followed, /sf-recover found nothing to recover and ran nothing, then said to use
 * /sf-code: two premium requests for one step, in words nobody reads.
 *
 * Now the review's status carries the next step ready to relay ("Now — Fix the review's findings (version 2)" and its
 * routes) and act.show says a review turn ends on it; whether a review runs as the author's sub-agent is SFlow's word
 * (reviewDispatch: author-turn), not the model's guess. The next step is /sf-code alone: its entry asks the person
 * "Start version 2 to fix the review's findings?" with the host's question tool and, on their yes, opens version 2 and
 * fixes the findings in the same turn. The yes is the person's: a confirmed rollover in an authoring turn is held to
 * their answer to that question, so the agent never answers it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { reviewCorrection, sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';
import { phaseHandoff, requestedSuccessorAction } from '../src/guide.mjs';
import { agentAct, nextOf } from '../src/agent-output.mjs';
import { nextStepsSnapshot, nextStepsText } from '../src/nextsteps.mjs';
import { copilotCommandForCommand, copilotSkillForCommand, directCopilotSkillId } from '../src/copilot-guidance.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationPostToolGuard, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { noteReviewerLaunch, REVIEWER_SUBAGENT_NOTE } from '../src/review-subagent.mjs';
import { copilotModeFile } from '../src/copilot-mode.mjs';

const SKILLS = fileURLToPath(new URL('../plugin/skills/', import.meta.url));

function story({ code = true, id = code ? 'implementation' : 'specification' } = {}) {
  const phase = { id, label: code ? 'Implementation' : 'Specification', status: 'in_progress', generation: 1,
    generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent', ...(code ? { task: 'code' } : {}) },
    requiredArtifact: { path: `artifacts/${id}/summary.md` },
    ...(code ? { generationIntent: { status: 'consumed', generation: 1 } } : {}),
    generationPublications: [{ generation: 1, record: { path: `context/${id}-gen1.json` } }] };
  return { workItem: { id: 'BIN-1', workType: 'custom' }, status: 'in_progress', currentPhase: id, phaseOrder: [id],
    phases: { [id]: phase }, history: [],
    resolution: { sourceReview: { mode: 'enforce', level: 2, phases: [id], kinds: { [id]: code ? 'code' : 'document' }, reviewerAgent: 'sflow-source-reviewer' } } };
}

// The incident's shape: three blocking findings, each with its check and the line it cites, and an advisory note.
const REPORT = { binding: { sources: [{ id: 'code:src:calc.mjs', path: 'src/calc.mjs' }, { id: 'code:test:calc.test.mjs', path: 'test/calc.test.mjs' }] },
  findings: [
    { id: 'F-1', severity: 'blocking', check: 'tests', message: 'AC-002 has no test that divides by zero.', sourceId: 'code:test:calc.test.mjs', line: 12 },
    { id: 'F-2', severity: 'blocking', check: 'quality', message: 'The input is parsed with eval.', sourceId: 'code:src:calc.mjs', line: 30 },
    { id: 'F-3', severity: 'blocking', check: 'plan', message: 'The history panel the plan names is missing.' },
    { id: 'N-1', severity: 'advisory', check: 'design', message: 'A shorter name would read better.', sourceId: 'code:src:calc.mjs', line: 2 }] };
const REVIEW = { status: 'correction-required', reportSha256: 'a'.repeat(64), report: REPORT, pendingDispositions: [],
  findings: REPORT.findings.filter((entry) => entry.severity === 'blocking')
    .map((entry) => ({ code: 'reviewer-blocker', reviewFindingId: entry.id, message: `Reviewer finding '${entry.id}': ${entry.message}` })) };
const PRESENTATION = ["Now — Fix the review's findings (version 2)", '- Copilot: `/sf-code implementation`',
  '- Shell: `singularity-flow phase rollover implementation`', '- VS Code (model-free): not available for this action'].join('\n');
const statusResult = (workflow, continuation) => ({ resultType: 'source-review-status', workId: 'BIN-1', phase: workflow.currentPhase, generation: 1,
  status: 'correction-required', reportSha256: REVIEW.reportSha256, findings: REVIEW.findings, pendingDispositions: [], continuation });

test('the incident: a code step\'s correction-required review leads to /sf-code alone, in plain words, ready to relay', () => {
  const workflow = story();
  const next = sourceReviewContinuation(workflow, workflow.phases.implementation, REVIEW);
  assert.equal(next.classification, 'successor-publication-required');
  assert.deepEqual([next.publishedGeneration, next.targetGeneration], [1, 2]);
  assert.deepEqual([next.nextSkill, next.copilotCommand, next.nextCommand], ['/sf-code', '/sf-code implementation', 'singularity-flow phase rollover implementation --json']);
  assert.equal(next.actions.length, 1, 'one turn: nothing before /sf-code');
  assert.equal(next.actions[0].label, "Fix the review's findings (version 2)");
  // The question with its actual numbers and the step's name; no tests are promised that were not recorded [OSA §7.1].
  assert.match(next.actions[0].reason, /^\/sf-code asks the person "Start version 2 of Implementation to fix the review's findings\?" and, on their yes, fixes them in the same turn\.$/u);
  assert.equal(next.presentation, PRESENTATION, 'the person\'s Shell line is the one that asks them in their own terminal');
  assert.doesNotMatch(JSON.stringify(next), /sf-recover|guarded code successor boundary/u);
  // The agent reads act first: act.show is that block, a review turn ends on it, and the tail says it is the person's.
  const act = agentAct(statusResult(workflow, next));
  assert.equal(act.state, 'next');
  assert.equal(act.show, PRESENTATION);
  assert.match(act.said, /A review turn ends its reply with act\.show exactly as given, after the findings; only a reviewer SFlow started as the author's sub-agent \(reviewDispatch: author-turn\) ends on the status and findings/u);
  assert.deepEqual([act.do.copilot, act.do.shell], ['/sf-code implementation', 'singularity-flow phase rollover implementation --json']);
  assert.equal(nextOf(act).next, 'next: end your reply with act.show for the person; only the step\'s author runs singularity-flow phase rollover implementation --json');
  // A review typed again after it was retained ends on the same next step.
  const again = agentAct({ resultType: 'source-review-agent-context', canReview: true, progress: { complete: true, instruction: 'The review is already retained for these inputs.' }, continuation: next });
  assert.deepEqual([again.state, again.show], ['review-complete', PRESENTATION]);
  // Every other surface names it the same way.
  assert.equal(phaseHandoff(workflow, workflow.phases.implementation, { sourceReviewEvidence: REVIEW })[0].label, "Fix the review's findings (version 2)");
  assert.match(nextStepsText(nextStepsSnapshot({ workflow, sourceReviewEvidence: REVIEW })),
    /1\. Now — Fix the review's findings \(version 2\)\n {3}- Copilot: \/sf-code implementation\n {3}- Shell: singularity-flow phase rollover implementation --json\n/u);
});

test('a document step a review asks to correct goes to its own drafting skill, which asks the person first [D3, journey I]', () => {
  const workflow = story({ code: false });
  const phase = workflow.phases.specification;
  const next = sourceReviewContinuation(workflow, phase, REVIEW);
  // Stage 2: a document's next version opens on the person's yes too, through the same preview and opening [OSA:REQ-030].
  assert.deepEqual([next.nextSkill, next.nextCommand], ['/sf-phase', 'singularity-flow phase rollover specification --json']);
  assert.equal(next.actions[0].label, "Fix the review's findings (version 2)");
  assert.equal(next.presentation, ["Now — Fix the review's findings (version 2)", '- Copilot: `/sf-phase specification`',
    '- Shell: `singularity-flow phase rollover specification`', '- VS Code (model-free): not available for this action'].join('\n'));
  const entry = phaseAuthoringEntry(workflow, phase, { review: REVIEW });
  assert.equal(entry.status, 'successor-confirmation-required');
  assert.equal(entry.successor.question, "Start version 2 of Specification to fix the review's findings? Published version 1 will stay unchanged.");
  assert.equal(entry.successor.preview.command, 'singularity-flow phase rollover specification --json');
});

test('/sf-code\'s entry asks the person to start version 2 with the review\'s findings, and version 2 is authored with them', () => {
  const workflow = story();
  const phase = workflow.phases.implementation;
  const entry = phaseAuthoringEntry(workflow, phase, { review: REVIEW });
  assert.equal(entry.status, 'successor-confirmation-required');
  assert.equal(entry.targetGeneration, 2);
  assert.equal(entry.successor.question, "Start version 2 of Implementation to fix the review's findings? Published version 1 will stay unchanged.");
  assert.deepEqual(entry.successor.choices, ['Yes', 'No']);
  assert.deepEqual(entry.successor.findings.map((entry) => [entry.id, entry.check, entry.at ?? null]),
    [['F-1', 'tests', 'test/calc.test.mjs:12'], ['F-2', 'quality', 'src/calc.mjs:30'], ['F-3', 'plan', null]], 'blocking findings only, where each points');
  assert.equal(entry.successor.preview.command, 'singularity-flow phase rollover implementation --json');
  // The entry's act: the person is asked, with the question tool; its route is the preview, run only on their Yes.
  const act = agentAct({ resultType: 'sflow-phase-entry', status: entry.status, phase: 'implementation', successor: { targetGeneration: 2, ...entry.successor }, next: entry.actions });
  assert.equal(act.state, 'confirm');
  assert.equal(act.ask.question, entry.successor.question);
  assert.deepEqual(act.ask.choices.map((choice) => choice.label), ['Yes', 'No']);
  assert.match(act.ask.how, /ask successor\.question now with your question tool \(ask_user; in VS Code, vscode_askQuestions\)\. On Yes run do\.shell \(the preview\), then the confirmation it returns, refresh the entry once and fix the findings in this same turn\. On No, or with no question tool, give the person next and end; never answer it yourself\./u);
  assert.equal(act.do.shell, 'singularity-flow phase rollover implementation --json');
  assert.match(nextOf(act).next, /^confirm: ask the person in this chat, and only on an explicit yes run singularity-flow phase rollover implementation --json$/u);
  // Without a retained report (an older status), the status's own reviewer findings are shown.
  assert.deepEqual(phaseAuthoringEntry(workflow, phase, { review: { ...REVIEW, report: null } }).successor.findings.map((entry) => entry.id), ['F-1', 'F-2', 'F-3']);
  // A review that asks for nothing, or only for a person's decision, asks no question.
  assert.notEqual(phaseAuthoringEntry(workflow, phase, { review: { status: 'ready', findings: [], pendingDispositions: [] } }).status, 'successor-confirmation-required');
  // Version 2 is authored with the review of version 1 loaded: the entry reads its findings from the retained report.
  const loaded = reviewCorrection({ report: REPORT }, 1);
  assert.deepEqual(loaded, { generation: 1, findings: entry.successor.findings });
  const author = agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'implementation', generatesCode: true, reviewCorrection: loaded });
  assert.equal(author.state, 'author');
  assert.ok(author.read.includes('reviewCorrection'), JSON.stringify(author.read));
  assert.match(author.said, /Fix each of reviewCorrection\.findings \(the review of version 1\) in this version\./u);
  assert.equal(reviewCorrection({ report: { findings: [REPORT.findings[3]] } }, 1), null, 'an advisory note asks for no correction');
});

/** Each skill's `singularity-flow` commands as its SKILL.md names them, as the words before any operand. */
async function namedCommands(skill) {
  const text = await readFile(path.join(SKILLS, `sflow-${skill.slice(4)}`, 'SKILL.md'), 'utf8');
  return [...text.matchAll(/`singularity-flow ([^`]+)`/gu)].map((match) => prefix(match[1]));
}
const prefix = (command) => {
  const words = [];
  for (const token of command.replace(/^(?:singularity-flow|sflow)\s+/u, '').split(/\s+/u)) {
    if (!/^[a-z][a-z-]*$/u.test(token) || words.length === 2) break;
    words.push(token);
  }
  return words.join(' ');
};
const covers = (commands, command) => commands.some((entry) => entry && (command === entry || command.startsWith(`${entry} `)));
// The skills that author a step: what their entry hands back with their own Copilot route is their own work ("it routes
// back to this skill ... do it, never relay it"). Every other skill runs its own entry, and only what that returns.
const AUTHORING = new Set(['/sf-code', '/sf-phase', '/sf-requirements', '/sf-design', '/sf-release', '/sf-document-intake', '/sf-scenario-check']);
const GENERIC = new Set(['session current', 'result last', 'pause status', 'workspace current']);

test('every continuation\'s Copilot skill runs or offers its own Shell command: no route hands a command to a skill that never runs it', async () => {
  // The states a review, an entry and a change request route from, for a code and a document step.
  const states = [];
  const add = (label, workflow, review = null) => states.push({ label, workflow, phase: workflow.phases[workflow.currentPhase], review });
  add('code: review asks for corrections', story(), REVIEW);
  add('document: review asks for corrections', story({ code: false }), REVIEW);
  add('code: review ready', story(), { status: 'ready', findings: [], pendingDispositions: [] });
  add('code: not reviewed yet', story(), { status: 'missing', findings: [{ code: 'review-missing', message: 'x' }], pendingDispositions: [] });
  add('code: a person decides a finding', story(), { status: 'correction-required', findings: [{ code: 'human-disposition-required', message: 'x' }], pendingDispositions: [{ id: 'D-1' }] });
  const reopened = story(); reopened.phases.implementation.reworkRevalidation = { generation: 1, invalidatedAt: 'now' };
  add('code: returned for rework', reopened, REVIEW);
  const submitted = story(); submitted.phases.implementation.status = 'awaiting_approval';
  add('code: submitted', submitted, REVIEW);
  const reviewerAuthored = story(); reviewerAuthored.phases.implementation.generatedAgent = 'sflow-source-reviewer';
  add('code: its reviewer authored it', reviewerAuthored, REVIEW);
  const routes = [];
  for (const { label, workflow, phase, review } of states) {
    const entry = phaseAuthoringEntry(workflow, phase, { review });
    const own = [...(entry.actions ?? []), ...(entry.successor?.preview ? [entry.successor.preview] : [])];
    for (const action of [...sourceReviewContinuation(workflow, phase, review).actions, ...own,
      ...[requestedSuccessorAction(workflow, phase), requestedSuccessorAction(workflow, phase, { requested: true }),
        requestedSuccessorAction(workflow, phase, { changedPaths: ['src/calc.mjs'] })].filter(Boolean)]) {
      if (!action.command || !action.copilotCommand) continue;
      routes.push({ label, skill: directCopilotSkillId(action.copilotCommand), command: prefix(action.command), full: action.command, entry: own });
    }
  }
  assert.ok(routes.length >= 20, `${routes.length} routes`);
  const misrouted = [];
  for (const route of routes) {
    const named = await namedCommands(route.skill);
    const entryCommand = named.find((command) => command && !GENERIC.has(command));
    const handedBack = AUTHORING.has(route.skill) && route.entry.some((action) => prefix(action.command) === route.command
      && directCopilotSkillId(action.copilotCommand) === route.skill);
    const runs = AUTHORING.has(route.skill) ? covers(named, route.command) || handedBack : covers([entryCommand], route.command)
      // /sf-submit's entry submits when ready (--submit-if-ready), and names the submit it runs.
      || (route.skill === '/sf-submit' && covers(named, route.command));
    if (!runs) misrouted.push(`${route.label}: ${route.skill} never runs ${route.full}`);
  }
  assert.deepEqual(misrouted, []);
  // The incident's pair, by name: /sf-recover runs `recover` first and previews a rollover only for changed published
  // bytes its own plan returns; handed `phase rollover` for an unchanged step, it found nothing and ran nothing.
  assert.equal((await namedCommands('/sf-recover')).find((command) => !GENERIC.has(command)), 'recover');
  assert.equal(copilotSkillForCommand('singularity-flow phase rollover implementation --json'), '/sf-code');
  assert.equal(safeCommandGuidance({ command: 'singularity-flow phase rollover implementation --json', skill: '/sf-recover' }), null,
    'an unchanged step\'s rollover is never /sf-recover\'s');
  assert.equal(safeCommandGuidance({ command: 'singularity-flow phase rollover specification --json', skill: '/sf-phase' })?.copilotCommand, '/sf-phase specification');
  // Its recovery plan's own confirmed rollover (changed bytes) stays its route; a person confirms it by its short code.
  assert.match(safeCommandGuidance({ command: `singularity-flow phase rollover implementation --confirm sha256:${'b'.repeat(64)}`, skill: '/sf-recover' })?.copilotCommand ?? '', /^\/sf-confirm [0-9A-Z]{4}-[0-9A-Z]{4}$/u);
});

/** A code step's turn, as the Copilot hooks record it (phase-mutation-contract.test.mjs's fixture, a published code generation). */
async function codeTurn(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-review-next-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'Review Next Tester']); git(['config', 'user.email', 'review-next@example.test']);
  await writeFile(path.join(root, 'src', 'calc.mjs'), 'export const value = 1;\n');
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const workflow = story();
  Object.assign(workflow.phases.implementation, { writeScope: 'source-and-artifact' });
  workflow.workItem.id = 'PMC-1';
  const file = path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(workflow));
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const enter = async (prompt, sessionId) => {
    const payload = { cwd: root, sessionId, prompt };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  return { root, enter };
}

const CONFIRM = `singularity-flow phase rollover implementation --confirm sha256:${'c'.repeat(64)} --json`;
const QUESTION = "Start version 2 of Implementation to fix the review's findings? Published version 1 will stay unchanged.";
/** What `phase rollover implementation --json` keeps on this clone when it previews version 2 (story-version-consent.mjs). */
async function previewed(root, { version = 2 } = {}) {
  const { gitDirectories } = await import('../src/story-version-acceptance.mjs');
  const { recordProposal, readGrant } = await import('../src/story-version-consent.mjs');
  const { commonDir } = gitDirectories(root);
  await mkdir(path.join(commonDir, 'singularity-flow'), { recursive: true });
  await writeFile(path.join(commonDir, 'singularity-flow', 'pending-publication-integrity.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`);
  const digest = `sha256:${'d'.repeat(64)}`;
  await recordProposal(commonDir, { proposal: { workId: 'PMC-1', phase: 'implementation', step: 'Implementation', version, from: { published: 1 } },
    digest, question: QUESTION, confirmation: `sha256:${'c'.repeat(64)}`, principal: { name: 'Review Next Tester', email: 'review-next@example.test' } });
  return { grant: () => readGrant(commonDir, digest) };
}
/** The question tool's call and the person's (or the host's) answer, as Copilot CLI and VS Code's agent host hand them to the hooks. */
async function asked(payload, question, answer) {
  const call = { ...payload, toolName: 'ask_user', toolArgs: { question, choices: ['Yes', 'No'] } };
  assert.deepEqual(await mutationToolGuard(call), {});
  await mutationPostToolGuard({ ...call, toolResult: { textResultForLlm: answer, resultType: 'success' } });
}

test('an agent never answers the version 2 confirmation: a confirmed rollover in an authoring turn needs the person\'s own yes in it', async (t) => {
  const f = await codeTurn(t);
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  // A confirmation of nothing previewed here binds to no version: refused before any question is read [OSA §7.1].
  const blind = await f.enter('/sf-code implementation', 'code-blind');
  await asked(blind, QUESTION, 'User responded: Yes');
  const unpreviewed = await shell(blind, CONFIRM);
  assert.equal(unpreviewed.permissionDecision, 'deny');
  assert.match(unpreviewed.permissionDecisionReason, /^PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded\. This confirmation names no version previewed on this machine/u);
  const preview = await previewed(f.root);
  // Nobody was asked: the agent ran the confirmation itself.
  const unasked = await f.enter('/sf-code implementation', 'code-unasked');
  assert.deepEqual(await shell(unasked, 'singularity-flow phase rollover implementation --json'), {}, 'the preview is a read the turn runs');
  const refused = await shell(unasked, CONFIRM);
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded\. Starting the step's next version is the person's yes, never this turn's\. Ask them the preview's question, which names version 2 \("Start version 2 of …\?"; Yes, No\), with your question tool \(ask_user; in VS Code, vscode_askQuestions\)/u);
  assert.match(refused.permissionDecisionReason, /- Copilot: \/sf-confirm [0-9A-Z]{4}-[0-9A-Z]{4}/u, 'the person\'s own route: the code they type');
  assert.doesNotMatch(refused.permissionDecisionReason, /sha256:/u, 'no digest is shown to a person');
  // Its short code is the same command: the agent cannot type it for the person either.
  const code = copilotCommandForCommand(`singularity-flow phase rollover implementation --confirm sha256:${'c'.repeat(64)}`).split(' ')[1];
  const byCode = await shell(unasked, `singularity-flow confirm ${code}`);
  assert.equal(byCode.permissionDecision, 'deny');
  assert.match(byCode.permissionDecisionReason, /^PHASE_MUTATION_ANSWER_UNBOUND/u);
  // The host answered instead of the person (Autopilot), the person said no, or the question asked something else.
  for (const [session, question, answer, words] of [
    ['code-host', QUESTION, 'The user is not available to respond and will review your work later.', /Ask them the preview's question, which names version 2/u],
    ['code-no', QUESTION, 'User responded: No', /did not say yes to starting the next version: start nothing/u],
    ['code-other', 'Shall I go on?', 'User responded: Yes', /Ask them the preview's question, which names version 2/u],
    // A yes to another version than the one previewed is not a yes to this one [OSA:REQ-030, wrong target].
    ['code-wrong-version', 'Start version 3 of Implementation?', 'User responded: Yes', /Ask them the preview's question, which names version 2/u]]) {
    const payload = await f.enter('/sf-code implementation', session);
    await asked(payload, question, answer);
    const denied = await shell(payload, CONFIRM);
    assert.equal(denied.permissionDecision, 'deny', session);
    assert.match(denied.permissionDecisionReason, words, session);
  }
  // The person's own Yes to that question, in this turn: the confirmation runs, and the turn goes on to the fix.
  assert.equal(await preview.grant(), null, 'no yes, no grant');
  const yes = await f.enter('/sf-code implementation', 'code-yes');
  await asked(yes, QUESTION, 'User responded: Yes');
  assert.deepEqual(await shell(yes, CONFIRM), {});
  // The host's delivery of that yes is kept, sealed, as the grant the opening command turns into the person's receipt.
  const granted = await preview.grant();
  assert.equal(granted.surface, 'question-tool');
  assert.deepEqual(granted.binding, { workId: 'PMC-1', phase: 'implementation', version: 2 });
  assert.match(granted.question, /start version 2 of implementation/u);
  assert.equal(granted.principal.email, 'review-next@example.test', 'the identity that previewed it, never one the model passed');
  // A yes from an earlier turn is not this turn's.
  const later = await f.enter('/sf-code implementation', 'code-yes');
  assert.equal((await shell(later, CONFIRM)).permissionDecision, 'deny', 'a new turn asks again');
  // VS Code's own chat, whose question answers may never reach SFlow: the person starts it themselves, and is not asked again.
  const local = await f.enter('/sf-code implementation', 'code-local');
  const vscode = await mutationToolGuard({ cwd: f.root, session_id: 'code-local', sessionId: 'code-local', tool_name: 'run_in_terminal', tool_input: { command: CONFIRM, cwd: f.root }, toolName: 'run_in_terminal', toolArgs: { command: CONFIRM, cwd: f.root } });
  assert.equal(vscode.permissionDecision, 'deny');
  assert.match(vscode.permissionDecisionReason, /answers do not reach SFlow, so the person's yes to starting the next version cannot be read here; do not ask again in this chat\. They can start it themselves: the preview's \/sf-confirm code, or in their own terminal singularity-flow phase rollover implementation, which asks them\./u);
  assert.ok(local);
  // The person's own /sf-confirm turn runs the code they typed, as before; it is not held to a question.
  const confirm = await f.enter(`/sf-confirm phase rollover implementation --confirm sha256:${'c'.repeat(64)}`, 'code-confirm');
  assert.notEqual((await shell(confirm, CONFIRM)).permissionDecisionReason?.startsWith('PHASE_MUTATION_ANSWER_UNBOUND') ?? false, true);
  // The code the person typed into their own prompt is their yes: kept as a grant of its own surface.
  assert.equal((await preview.grant()).surface, 'confirm-code');
  // In a chat with no /sf- command, starting a version is never run.
  const plain = await mutationToolGuard({ cwd: f.root, sessionId: 'no-skill-chat', toolName: 'bash', toolArgs: { command: CONFIRM, cwd: f.root } });
  assert.equal(plain.permissionDecision, 'deny');
  assert.match(plain.permissionDecisionReason, /^PHASE_MUTATION_ANSWER_UNBOUND: nothing was started\. Starting a step's next version is the person's yes, and this chat named no \/sf- command/u);
});

test('whether a review runs as the author\'s sub-agent is SFlow\'s word to it, never the model\'s guess', async (t) => {
  const f = await codeTurn(t);
  const boundaries = path.join(path.dirname(copilotModeFile()), 'copilot-boundaries');
  const record = (payload) => recordRepositoryBoundaryTurn(payload, { captureMutation: async () => ({}) });
  // A person types the review: no word of a sub-agent, so it ends on the next step.
  const typed = await record({ cwd: f.root, sessionId: 'person-review', prompt: '/sf-review-source implementation' });
  assert.doesNotMatch(typed.additionalContext ?? '', /reviewDispatch/u);
  // VS Code's runSubagent: the author's turn launched the reviewer, and the review's prompt arrives under the author's session.
  await noteReviewerLaunch({ sessionId: 'author-chat', toolName: 'runSubagent', toolCallId: 'launch-1',
    toolArgs: { agentName: 'sflow-source-reviewer', prompt: '/sf-review-source implementation' } }, boundaries);
  const started = await record({ cwd: f.root, sessionId: 'author-chat', prompt: '/sf-review-source implementation' });
  assert.ok(started.additionalContext?.includes(REVIEWER_SUBAGENT_NOTE), JSON.stringify(started));
  assert.match(REVIEWER_SUBAGENT_NOTE, /^SFlow: reviewDispatch: author-turn\. .*end with the retained status and findings only; that turn shows the person the next step\.$/u);
  // The skill reads that word, and otherwise always ends on the next step SFlow returned.
  const skill = await readFile(path.join(SKILLS, 'sflow-review-source', 'SKILL.md'), 'utf8');
  assert.match(skill, /SFlow's turn context says `reviewDispatch: author-turn`: end with the retained status and findings only; the author's turn follows `continuation`\. Otherwise always end with `act\.show` exactly as returned, after the findings/u);
  assert.doesNotMatch(skill, /Started as a sub-agent in the author's chat/u, 'the model no longer decides it is a sub-agent');
});

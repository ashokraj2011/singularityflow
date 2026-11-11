/**
 * `workflow walk [WORKFLOW]`: a model-free dry run of a workflow, shipped or a team's own. It drives
 * one throwaway Story through every step on an isolated copy (src/workflow-walk/sandbox.mjs) with the
 * kernel's own commands, a stub author (author.mjs) and a stub reviewer (reviewer.mjs), and reports
 * every place it would stop that is not a real decision a person is meant to make (refusals.mjs).
 *
 * Result (schemaVersion 1, resultType `workflow-walk`):
 *   { ok, source: { kind: shipped|approved|checkout|staged, ref?, commit? }, actionsLeftOut: [{ where, actions }],
 *     budget: { stepSeconds, totalSeconds },
 *     counts: { workflows, completed, stopped, notJudged, stops, expectedPersonSteps, expectedReviews },
 *     workflows: [{ id, label, outcome: completed|stopped|not-judged|not-walked, reason?, seconds,
 *       steps: [{ id, label, outcome: approved|completed|skipped|stopped|not-judged|not-reached,
 *         people: [{ class, kind, ask, where, command? }],      what a person (or reviewer) does here
 *         stops: [{ class: 'stop', command, code, message, cause, routes }],
 *         notJudged: [{ class: 'not-judged', command?, code, message }],
 *         notes: [string], commands: [{ command, status, code, seconds }] }],
 *       stops: [{ step, command, code, message, cause, routes }] }] }
 * `ok` is true when no workflow has a stop or a step the walk could not judge.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { ownTerminalStep, skillForCommandLine } from '../command-skills.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { answerSections, clauseSection, codeChange, definedClauses, fillDocument, hasPlannedClaimsTable, plannedClaimsSection, scenarioSection } from './author.mjs';
import { likelyCause, MET_REFUSALS, NOT_JUDGED_REFUSALS, shortMessage } from './refusals.mjs';
import { reviewReport } from './reviewer.mjs';
import { copySandbox, createSandbox, readConfigurationFolder, readRepositoryConfiguration, WALK_IDENTITY } from './sandbox.mjs';

export const WALK_WORK_ID = 'WALK-1';
const TITLE = 'Return the approved value';
const DESCRIPTION = 'The value module must return 2.';
const REASON = 'The workflow walk records this for its throwaway Story; no person decided it.';
const MAX_ACTIONS_PER_STEP = 30;
const MAX_STEP_VISITS = 40;

/**
 * Where a person runs a command: their own terminal when no Copilot turn may run it (the person-step
 * catalog), else the skill that carries it out in Copilot, or the shell.
 */
export function whereFor(command) {
  if (ownTerminalStep(command)) return "the person's own terminal (no Copilot turn may run it)";
  const skill = skillForCommandLine(command);
  return skill ? `/${skill} in Copilot, or the shell` : 'the shell';
}

/** The command as a person would type it, without the walk's own output flags. */
const commandText = (args) => `singularity-flow ${args.filter((arg) => !['--json', '--for-agent'].includes(arg))
  .map((arg) => (arg.length > 160 ? `<${arg.length} characters>` : arg))
  .map((arg) => (/[\s"]/u.test(arg) && !/^<\d+ characters>$/u.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`;

function parseOutput(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/^[{[]/mu);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch {
    // A command that prints its text and then its JSON keeps the last top-level object.
    const last = text.lastIndexOf('\n{');
    if (last >= 0) { try { return JSON.parse(text.slice(last + 1)); } catch { return null; } }
    return null;
  }
}

/** A refusal's code, message and the routes it returned, wherever its envelope puts them. */
function refusalOf(result) {
  const parsed = result.parsed;
  const error = parsed?.error ?? (parsed?.status === 'failed' || parsed?.status === 'refused' ? parsed : null);
  const routes = [...(parsed?.remediationPlan?.steps ?? []).map((step) => step.command ?? step.copilotCommand ?? null),
    ...(Array.isArray(parsed?.next) ? parsed.next.map((entry) => (typeof entry === 'string' ? entry : entry?.command ?? null)) : [])]
    .filter((entry) => typeof entry === 'string' && entry.trim());
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const code = error?.code ?? /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,})\b/u.exec(String(error?.message ?? text))?.[1] ?? (result.timedOut ? 'WORKFLOW_WALK_TIMEOUT' : null);
  const message = error?.message ?? (text.trim().split('\n').filter(Boolean).slice(-3).join(' ') || 'The command failed without a message.');
  // A failed required test keeps its run beside the details: the cause names that command.
  const details = error?.requiredTestExecution ? { ...(error.details ?? {}), requiredTestExecution: error.requiredTestExecution } : error?.details ?? null;
  return { code, message: shortMessage(message), details, routes: [...new Set(routes)] };
}

class WalkStop extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

/** One workflow's walk: its Story, its steps and the budget it runs under. */
class StoryWalk {
  constructor(sandbox, workflow, { stepSeconds, deadline }) {
    this.sandbox = sandbox;
    this.workflow = workflow;
    this.stepSeconds = stepSeconds;
    this.deadline = deadline;
    this.cwd = sandbox.repository;
    this.workItem = null;
    this.clauses = [];
    this.steps = new Map();
    this.order = [...(workflow.phases ?? [])];
    this.visits = new Map();
    this.stopped = false;
    this.notJudged = false;
    this.stepDeadline = deadline;
  }

  step(id) {
    if (!this.steps.has(id)) this.steps.set(id, { id, label: id, outcome: 'not-reached', people: [], stops: [], notJudged: [], notes: [], commands: [] });
    return this.steps.get(id);
  }

  /** Runs one CLI command for `step`, within the step's and the walk's time left. */
  async cli(stepId, args, { env = null, person = false } = {}) {
    const left = Math.min(this.stepDeadline, this.deadline) - Date.now();
    if (left <= 1000) this.outOfTime(stepId, args);
    const result = await this.sandbox.run(args, { cwd: this.cwd, timeoutMs: left, ...(env ? { env } : {}) });
    result.parsed = parseOutput(result.stdout);
    // A bounded --for-agent result keeps the rest in its saved file: the refusal's details are there.
    const saved = result.parsed?.agentOutput?.path;
    if (saved && !result.parsed.error) {
      const full = await readFile(saved, 'utf8').then(JSON.parse, () => null);
      if (full) result.parsed = { ...full, ...result.parsed, error: full.error ?? null, remediationPlan: full.remediationPlan ?? result.parsed.remediationPlan, findings: full.findings ?? result.parsed.findings };
    }
    result.ok = result.status === 0;
    const record = { command: commandText(args), status: result.status, seconds: Math.round(result.milliseconds / 100) / 10 };
    if (!result.ok) { const refusal = refusalOf(result); record.code = refusal.code; result.refusal = refusal; }
    if (person) record.person = true;
    this.step(stepId).commands.push(record);
    if (result.timedOut) this.outOfTime(stepId, args);
    return result;
  }

  outOfTime(stepId, args) {
    const late = Date.now() >= this.deadline;
    this.step(stepId).notJudged.push({ class: 'not-judged', command: commandText(args), code: 'WORKFLOW_WALK_OUT_OF_TIME',
      message: late ? 'The walk ran out of its total time here.' : 'This step ran out of its own time here.' });
    this.notJudged = true;
    throw new WalkStop('not-judged');
  }

  /** The walk cannot judge this step: an external tool, a live system, or a step kind its stub cannot write. */
  cannotJudge(stepId, args, code, message) {
    this.step(stepId).notJudged.push({ class: 'not-judged', command: args ? commandText(args) : null, code, message: shortMessage(message) });
    this.step(stepId).outcome = 'not-judged';
    this.notJudged = true;
    throw new WalkStop('not-judged');
  }

  person(stepId, entry) {
    const people = this.step(stepId).people;
    if (!people.some((known) => known.kind === entry.kind && known.ask === entry.ask)) people.push(entry);
  }

  stop(stepId, args, refusal, cause = null) {
    if (NOT_JUDGED_REFUSALS[refusal.code]) this.cannotJudge(stepId, args, refusal.code, `${NOT_JUDGED_REFUSALS[refusal.code]} ${refusal.message}`);
    this.step(stepId).stops.push({ class: 'stop', command: commandText(args), code: refusal.code ?? null, message: refusal.message,
      cause: cause ?? likelyCause(refusal.code, { message: refusal.message, routes: refusal.routes, step: stepId, details: refusal.details }), routes: refusal.routes.slice(0, 5) });
    this.step(stepId).outcome = 'stopped';
    this.stopped = true;
    throw new WalkStop('stop');
  }

  async readStory() {
    return readRecord('story-workflow', await readFile(path.join(this.cwd, this.workItem, 'workflow.json'))).record;
  }

  async readText(relative) { return readFile(path.join(this.cwd, relative), 'utf8'); }

  async writeText(relative, text) {
    await mkdir(path.dirname(path.join(this.cwd, relative)), { recursive: true });
    await writeFile(path.join(this.cwd, relative), text);
  }
}

// ------------------------------------------------------------------------------------- start

/** A read-only reference repository for a workflow that starts from one: a local bare repository in the walk's folder. */
async function referenceRepository(walk) {
  const { sandbox } = walk;
  const source = path.join(sandbox.base, 'reference');
  const bare = path.join(sandbox.base, 'reference.git');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'README.md'), '# Reference\n\nThe value a caller reads is 2.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'Reference for the workflow walk']]) {
    const result = await sandbox.git(args, { cwd: source });
    if (result.status !== 0) return null;
  }
  const cloned = await sandbox.git(['clone', '-q', '--bare', source, bare], { cwd: sandbox.base });
  return cloned.status === 0 ? bare : null;
}

async function startStory(walk) {
  let args = ['start', WALK_WORK_ID, '--from-branch', 'main', '--work-type', walk.workflow.id, '--title', TITLE, '--description', DESCRIPTION, '--json'];
  let started = await walk.cli('start', args);
  if (!started.ok && started.refusal.code === 'REFERENCE_REPOSITORIES_REQUIRED') {
    walk.person('start', { class: 'expected-person-step', kind: 'start-input', ask: 'Name the read-only reference repository and branch the Story builds from.',
      where: 'at Story start (--reference-repository ID=URL --reference-branch ID=BRANCH)' });
    const reference = await referenceRepository(walk);
    if (reference) {
      args = [...args.slice(0, -1), '--reference-repository', `reference=${reference}`, '--reference-branch', 'reference=main', '--json'];
      started = await walk.cli('start', args);
    }
  }
  if (!started.ok) walk.stop('start', args, started.refusal);
  const data = started.parsed?.data ?? {};
  if (data.repositoryPath) walk.cwd = data.repositoryPath;
  const YAML = (await import('yaml')).default;
  const configuration = YAML.parse(await walk.readText('singularity/workflow.yml').catch(() => '')) ?? {};
  walk.workItem = path.posix.join(configuration.workItemRoot ?? 'singularity/work-items', WALK_WORK_ID);
  const story = await walk.readStory();
  walk.order = story.phaseOrder ?? walk.order;
  walk.resolution = story.resolution ?? {};
  for (const phase of walk.resolution.phases ?? []) walk.step(phase.id).label = phase.label ?? phase.id;
  // Story start is a step of its own only when a person gives it something.
  if (!walk.step('start').people.length) walk.steps.delete('start');
  else walk.step('start').outcome = 'completed';
  return story;
}

// ------------------------------------------------------------------------------- person work

/** Clears an open decision list: each owed item takes its recommended (else first) option a person may choose. */
async function decideOpenItems(walk, stepId) {
  const listed = await walk.cli(stepId, ['decisions', WALK_WORK_ID, '--json']);
  const items = listed.parsed?.data?.items ?? [];
  let decided = 0;
  for (const item of items) {
    if (['approval', 'approval-hold'].includes(item.kind)) continue;
    // An option that needs a clause is open only when the Story has one to name.
    const usable = (entry) => entry.chat?.command && (!entry.needs?.clause || entry.needs.clause.known?.[0] || walk.clauses[0]);
    const options = (item.options ?? []).filter(usable);
    const option = options.find((entry) => entry.recommended && entry.decidedBy?.allowed !== false)
      ?? options.find((entry) => entry.decidedBy?.allowed !== false) ?? options[0];
    if (!option) continue;
    const clause = option.needs?.clause?.known?.[0] ?? walk.clauses[0] ?? null;
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const filled = option.chat.command.replace(/<CLAUSES?>/gu, clause ?? '').replace(/<REASON>/gu, REASON).replace(/<(?:EXPIRES|DATE)>/gu, expires);
    const deciders = option.decidedBy?.labels ?? item.decidedBy?.labels ?? [];
    walk.person(stepId, { class: 'expected-person-step', kind: 'decision', ask: `${item.title}${deciders.length ? ` (decided by ${deciders.join(' or ')})` : ''}`,
      where: whereFor(filled), command: filled.replace(/ --fetch\b/u, '') });
    if (/<[A-Z_]+>/u.test(filled)) {
      walk.stop(stepId, ['decisions', WALK_WORK_ID], { code: 'WORKFLOW_WALK_DECISION_VALUE', message: `The decision "${item.title}" needs a value the walk cannot supply: ${filled}`, routes: [] },
        'The decision list offers no option the walk can record without a value only a person has.');
    }
    const args = argvOf(filled);
    const decision = await walk.cli(stepId, [...args, '--json'], { person: true });
    if (!decision.ok) walk.stop(stepId, args, decision.refusal);
    decided += 1;
  }
  return decided;
}

/** A command line split as a shell would, without its program name. */
function argvOf(command) {
  const words = []; let current = null; let quote = null;
  for (const char of String(command)) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; current ??= ''; continue; }
    if (/\s/u.test(char)) { if (current !== null) { words.push(current); current = null; } continue; }
    current = (current ?? '') + char;
  }
  if (current !== null) words.push(current);
  return words.slice(1);
}

/** The step's independent review: the stub reviewer writes, checks and retains a report through review-source. */
async function review(walk, stepId) {
  walk.person(stepId, { class: 'expected-review', kind: 'review', ask: MET_REFUSALS.SOURCE_REVIEW_REQUIRED.ask,
    where: "the step's reviewer agent (a sub-agent the authoring turn starts), or /sf-review-source" });
  const context = await walk.cli(stepId, ['review-source', 'context', stepId, '--json']);
  if (!context.ok) walk.stop(stepId, ['review-source', 'context', stepId], context.refusal);
  const report = reviewReport(context.parsed);
  if (!report) {
    walk.cannotJudge(stepId, ['review-source', 'context', stepId], 'WORKFLOW_WALK_REVIEW_KIND', `The walk's stub reviewer cannot write a ${context.parsed?.kind ?? 'unknown'} review.`);
  }
  const staged = await walk.cli(stepId, ['review-source', 'stage', stepId, '--report-json', JSON.stringify(report), '--json']);
  // A report staged but not ready names where it is; its check says why.
  const stagingPath = staged.parsed?.stagingPath ?? /staged at (\S+?), but/u.exec(staged.refusal?.message ?? '')?.[1] ?? null;
  if (!staged.ok && !stagingPath) walk.stop(stepId, ['review-source', 'stage', stepId], staged.refusal);
  const checked = await walk.cli(stepId, ['review-source', 'check', stepId, '--report-file', stagingPath, '--json']);
  if (!checked.ok || checked.parsed?.retentionReady !== true) {
    const findings = (checked.parsed?.findings ?? []).map((entry) => entry.message ?? entry.code).filter(Boolean).slice(0, 3).join(' ');
    walk.cannotJudge(stepId, ['review-source', 'check', stepId], checked.refusal?.code ?? 'WORKFLOW_WALK_REVIEW_NOT_READY',
      `The stub reviewer's report for this step is not ready to retain: ${findings || checked.refusal?.message || 'no findings were returned'}`);
  }
  const retained = await walk.cli(stepId, ['review-source', 'submit', stepId, '--report-file', stagingPath, '--json']);
  if (!retained.ok) walk.stop(stepId, ['review-source', 'submit', stepId], retained.refusal);
}

/** An approver for `groups` the walk may act as, when its own identity is not one: a listed member. */
function listedApprover(walk, details, { excludeSelf = false } = {}) {
  const authorities = walk.resolution?.approvalAuthorities ?? {};
  const named = details?.eligibleApprovers ?? [];
  const emails = [...named, ...Object.values(authorities).flatMap((authority) => (authority.members ?? []).map((member) => member.email))]
    .filter((email) => typeof email === 'string' && email.includes('@') && !(excludeSelf && email === WALK_IDENTITY.email));
  return emails[0] ?? null;
}

const asIdentity = (email) => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: `Walk approver ${email.split('@')[0]}`,
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: email });

async function approve(walk, stepId, phase) {
  const groups = (phase.approvalPolicy?.authorities ?? []).join(', ') || 'its approval group';
  walk.person(stepId, { class: 'expected-person-step', kind: 'approval', ask: `Approve the step (${groups}, ${phase.approvalPolicy?.minimum ?? 1} needed${phase.approvalPolicy?.allowSelfApproval === false ? ', not its author' : ''}).`,
    where: `${whereFor(`singularity-flow approve ${stepId}`)}, by an approver; never the turn that authored it`, command: `singularity-flow approve ${stepId}` });
  const args = ['approve', stepId, '--yes', '--json'];
  let result = await walk.cli(stepId, args, { person: true });
  if (result.ok) return;
  let met = MET_REFUSALS[result.refusal.code];
  if (met?.handler === 'decisions' && await decideOpenItems(walk, stepId)) {
    result = await walk.cli(stepId, args, { person: true });
    if (result.ok) return;
    met = MET_REFUSALS[result.refusal.code];
  }
  if (met?.handler === 'approver') {
    const email = listedApprover(walk, result.refusal.details, { excludeSelf: true });
    if (email) {
      walk.step(stepId).notes.push(`The walk approved as ${email}, a member the approval group lists, because its own identity may not approve.`);
      result = await walk.cli(stepId, args, { person: true, env: asIdentity(email) });
      if (result.ok) return;
    }
  }
  walk.stop(stepId, args, result.refusal);
}

// ------------------------------------------------------------------------------------ authoring

function stepFacts(walk, stepId, phase) {
  const resolved = (walk.resolution?.phases ?? []).find((entry) => entry.id === stepId) ?? {};
  const generation = phase.generationPolicy ?? resolved.generation ?? {};
  const planned = walk.resolution?.plannedClaims ?? {};
  return {
    resolved,
    code: generation.task === 'code',
    deterministic: (generation.producer ?? generation.defaultProducer) === 'deterministic',
    clauseStep: (planned.clausePhases ?? []).includes(stepId) || ['requirements', 'implementation-spec', 'specification'].includes(phase.requiredArtifact?.kind),
    planOwner: Object.values(planned.owners ?? {}).includes(stepId),
    clarification: resolved.clarification ?? {},
    artifact: phase.requiredArtifact?.path ? path.posix.join(walk.workItem, phase.requiredArtifact.path) : null,
    reviewed: (walk.resolution?.sourceReview?.mode ?? 'off') !== 'off' && (walk.resolution?.sourceReview?.phases ?? []).includes(stepId)
  };
}

/** The stub author's draft for the step: its template filled, clauses and a plan added where the platform needs them. */
async function author(walk, stepId, facts) {
  const record = walk.step(stepId);
  if (facts.code) {
    // A step walked again (a loop) writes a change of its own: a new generation must change something.
    for (const [relative, text] of Object.entries(codeChange(walk.clauses, { pass: walk.visits.get(stepId) ?? 1 }))) await walk.writeText(relative, text);
    record.notes.push(walk.clauses.length ? `The stub author changed src/value.mjs and its test, tagging ${walk.clauses.join(', ')}.`
      : 'The stub author changed src/value.mjs and its test; the Story defines no clauses, so nothing is tagged.');
  }
  if (!facts.artifact || facts.deterministic) return;
  const before = await walk.readText(facts.artifact).catch(() => null);
  if (before == null) return;
  const cite = !facts.clauseStep && !facts.planOwner;
  let text = fillDocument(before, { clauses: walk.clauses, cite, defines: facts.clauseStep, workId: WALK_WORK_ID });
  // A template of prompts only: a sentence under each section, as an author answers each prompt.
  if (text === before) text = answerSections(text, { cite, clauses: walk.clauses });
  if (facts.clauseStep && !definedClauses(text, WALK_WORK_ID).length) {
    text += clauseSection(WALK_WORK_ID);
    record.notes.push("The step defines the Story's clauses but its template has no clause anchors; the stub added a Requirements section.");
  }
  if (facts.clauseStep) for (const clause of definedClauses(text, WALK_WORK_ID)) if (!walk.clauses.includes(clause)) walk.clauses.push(clause);
  const scenario = scenarioSection(text);
  if (scenario) { text = scenario; record.notes.push('The draft cites scenario S1 but its template has none; the stub added S1 in Given/When/Then form.'); }
  if (facts.planOwner && !hasPlannedClaimsTable(text)) {
    text += plannedClaimsSection(walk.clauses.length ? walk.clauses : [`${WALK_WORK_ID}:AC-001`]);
    record.notes.push('The step plans a code step but its template has no planned-claims table; the stub added one.');
  }
  if (text !== before) await walk.writeText(facts.artifact, text);
}

/** A question the step asks a person, answered in the documented record form. */
async function clarify(walk, stepId, facts) {
  const mode = facts.clarification.mode ?? 'off';
  if (mode === 'off') return;
  const topics = (facts.clarification.topics ?? []).slice(0, 3).join(', ');
  walk.person(stepId, { class: 'expected-person-step', kind: 'clarification',
    ask: `Answer up to ${facts.clarification.maxQuestions ?? 5} clarification question(s)${topics ? ` about ${topics}` : ''} (${mode}).`,
    where: 'in the authoring chat; the turn records the answers' });
  // The authoring turn composes the step's prompt before it asks; an answer binds to that prompt.
  const composeArgs = ['wm', 'compose', '--phase', stepId, '--json'];
  const composed = await walk.cli(stepId, composeArgs);
  if (!composed.ok) walk.stop(stepId, composeArgs, composed.refusal);
  const args = ['clarification', 'record', stepId, '--question', 'Is 2 the approved value every caller should read?', '--answer', 'Yes: 2 is the approved value, and every caller reads it.', '--json'];
  const recorded = await walk.cli(stepId, args, { person: true });
  if (!recorded.ok) walk.stop(stepId, args, recorded.refusal);
}

const MARKER_QUESTION = 'Should a caller that reads the value before it is set get 2 as well?';

/**
 * Where a step's markers warn or block, its author may write one `[NEEDS CLARIFICATION: …]` marker
 * rather than guess. The walk writes one, has the kernel see it, answers it as the person would and
 * takes it out of the draft: what a real Story does when its author is unsure.
 */
async function exerciseMarker(walk, stepId, facts) {
  const mode = facts.clarification.markers?.mode ?? 'off';
  if (mode === 'off' || !facts.artifact || facts.deterministic) return;
  const before = await walk.readText(facts.artifact).catch(() => null);
  if (before == null) return;
  const marker = `[NEEDS CLARIFICATION: ${MARKER_QUESTION}]`;
  await walk.writeText(facts.artifact, `${before.replace(/\s*$/u, '')}\n\n${marker}\n`);
  walk.person(stepId, { class: 'expected-person-step', kind: 'clarification-marker',
    ask: `Answer a question the draft marks [NEEDS CLARIFICATION: …]; the step ${mode === 'block' ? 'cannot publish' : 'warns'} until it is answered and taken out (markers: ${mode}).`,
    where: whereFor(`singularity-flow clarification answer ${stepId} --marker q --answer a`), command: `singularity-flow clarification answer ${stepId} --marker "<question>" --answer "<answer>"` });
  const seen = await walk.cli(stepId, ['phase', 'prepublish', stepId, '--work-id', WALK_WORK_ID, '--for-agent', '--json']);
  if (!JSON.stringify(seen.parsed ?? {}).includes(MARKER_QUESTION)) {
    walk.step(stepId).notes.push('The kernel did not report the marker the walk wrote; its marker gate was not exercised.');
  }
  // The route the step returns for the open question, followed as an agent would: may it be asked here?
  const route = seen.parsed?.act?.do?.shell ?? '';
  if (/^singularity-flow clarification status\b/u.test(route)) {
    const statusArgs = argvOf(route);
    const status = await walk.cli(stepId, statusArgs);
    const checkpoint = status.parsed?.data?.checkpoint ?? null;
    // Questioning closed because the step's clarification is off: nobody may ask, so nobody can answer.
    // Closed after answers were recorded (reuse) still leaves the marker's own answer route open.
    if (checkpoint && checkpoint.questioningAllowed === false && (checkpoint.stage === 'off' || facts.clarification.mode === 'off')) {
      walk.stop(stepId, statusArgs, { code: 'CLARIFICATION_QUESTIONING_NOT_ALLOWED',
        message: shortMessage(`${(seen.parsed?.act?.fix ?? [])[0] ?? 'An open clarification marker holds the step.'} The route it returns says: ${checkpoint.instruction ?? 'questioning is not allowed'}`),
        routes: [route] }, facts.clarification.mode === 'off'
        ? `The step's markers ${mode === 'block' ? 'block publication' : 'warn'} on an open [NEEDS CLARIFICATION: …] marker, but its clarification is off, so its route tells the author never to ask or record an answer and the marker cannot be resolved. Turn clarification on for the step (when-needed or required), or set clarification.markers.mode to off.`
        : null);
    }
  }
  const composeArgs = ['wm', 'compose', '--phase', stepId, '--json'];
  const composed = await walk.cli(stepId, composeArgs);
  if (!composed.ok) walk.stop(stepId, composeArgs, composed.refusal);
  const args = ['clarification', 'answer', stepId, '--marker', MARKER_QUESTION, '--answer', 'Yes: every caller reads 2.', '--json'];
  const answered = await walk.cli(stepId, args, { person: true });
  if (!answered.ok) {
    walk.stop(stepId, args, answered.refusal, facts.clarification.mode === 'off'
      ? `The step's markers ${mode === 'block' ? 'block publication' : 'warn'} on an open [NEEDS CLARIFICATION: …] marker, but its clarification is off, so no answer can be recorded and the marker can never be resolved. Turn clarification on for the step (when-needed or required), or set clarification.markers.mode to off.`
      : null);
  }
  await walk.writeText(facts.artifact, before);
}

// ---------------------------------------------------------------------------------- the step

/** The step's latest publication, so a publish can be told from one made on an earlier visit. */
const latestPublication = (phase) => (phase.authorship ?? []).filter((entry) => entry.publishedAt)
  .map((entry) => `${entry.publishedAt}#${entry.generation}`).sort().at(-1) ?? null;

/** What a prepublish result asks for, as words for a stop: its act, its fixes and its findings. */
function actWords(result) {
  const act = result.parsed?.act ?? {};
  const findings = (result.parsed?.findings ?? []).map((entry) => entry.message ?? entry.code).filter(Boolean);
  return shortMessage([act.said, ...(act.fix ?? []), ...findings.slice(0, 3)].filter(Boolean).join(' ') || result.refusal?.message || 'The draft was not published and no reason was returned.');
}

/**
 * Publishes the step's draft by following the prepublish result's own `act`, as an agent does: run
 * the publish it returns, or meet what it asks for when the walk can stand in for it (standIns).
 */
async function publish(walk, stepId) {
  let args = ['phase', 'prepublish', stepId, '--work-id', WALK_WORK_ID, '--for-agent', '--json'];
  const met = new Set();
  const before = latestPublication((await walk.readStory()).phases?.[stepId] ?? {});
  for (let round = 0; round < 8; round += 1) {
    const result = await walk.cli(stepId, args);
    if (latestPublication((await walk.readStory()).phases?.[stepId] ?? {}) !== before) return result;
    const act = result.parsed?.act ?? null;
    if (!result.ok && !act) walk.stop(stepId, args, result.refusal);
    const state = act?.state ?? null;
    if (state === 'publish' && act.do?.shell) { args = argvOf(act.do.shell); continue; }
    // A result only an external tool can give (a Figma MCP call, a browser): the walk has no such tool.
    if (/^singularity-flow mcp record\b/u.test(act?.do?.shell ?? '')) {
      walk.cannotJudge(stepId, args, 'WORKFLOW_WALK_EXTERNAL_TOOL', `The step needs a result recorded from an external tool before it can publish, which the walk has no connection to: ${actWords(result)}`);
    }
    // What the author writes besides the draft when the step asks for it (an evidence file), once each.
    const asked = [...(act?.fix ?? []), ...(result.parsed?.findings ?? []).map((entry) => `${entry.code ?? ''} at ${entry.path ?? ''}: ${entry.message ?? ''}`)].join('\n');
    const repair = FINDING_REPAIRS.find((entry) => !met.has(entry.id) && entry.pattern.test(asked));
    if (repair) {
      met.add(repair.id);
      await repair.run(walk, stepId, asked);
      args = ['phase', 'prepublish', stepId, '--work-id', WALK_WORK_ID, '--for-agent', '--json'];
      continue;
    }
    if (result.ok && state !== 'publish' && !args.includes('--publish-if-ready') && !act?.do?.shell) { args = [...args, '--publish-if-ready']; continue; }
    if (result.parsed?.error) walk.stop(stepId, args, refusalOf(result));
    walk.stop(stepId, args, { code: state ? `ACT_${state.toUpperCase().replaceAll('-', '_')}` : 'WORKFLOW_WALK_NOT_PUBLISHED',
      message: actWords(result), routes: [act?.do?.shell, act?.do?.copilot].filter(Boolean) });
  }
  walk.stop(stepId, args, { code: 'WORKFLOW_WALK_NOT_PUBLISHED', message: 'The draft was still not published after every route prepublish returned.', routes: [] });
}

/**
 * What the stub author writes besides the draft when a step's check asks for it, as an author would:
 * an evidence file its artifact set requires. Each is named in the step's notes.
 */
const FINDING_REPAIRS = [{
  id: 'artifact-set-evidence',
  pattern: /required-member-missing at (\S+?)(?=[:\s]|$)/u,
  async run(walk, stepId, asked) {
    for (const member of new Set([...asked.matchAll(/required-member-missing at (\S+?)(?=[:\s]|$)/gu)].map((match) => match[1]))) {
      const target = member.endsWith('/') ? `${member}evidence-index.md` : member;
      const cited = walk.clauses.map((clause) => `\`${clause}\``).join(', ') || 'The change';
      await walk.writeText(target, `# Evidence index — ${WALK_WORK_ID}\n\n${cited}: \`test/value.test.mjs\` passed against \`src/value.mjs\` on the run the code step recorded.\n`);
      walk.step(stepId).notes.push(`The stub author wrote ${target}, the evidence file the step's artifact set requires.`);
    }
  }
}];

/** A convergence step's submission: a person reviews the deterministic result and confirms its digest. */
async function advance(walk, stepId) {
  const args = ['story', 'advance', '--work-id', WALK_WORK_ID];
  const preview = await walk.cli(stepId, [...args, '--json'], { person: true });
  // The digest the preview binds its confirmation to, wherever its result puts it.
  const digest = /--confirm\s+\\?"?(sha256:[0-9a-f]{64})/u.exec(preview.stdout)?.[1] ?? /(sha256:[0-9a-f]{64})/u.exec(preview.stdout)?.[1] ?? null;
  walk.person(stepId, { class: 'expected-person-step', kind: 'advance', ask: MET_REFUSALS.CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED.ask,
    where: whereFor('singularity-flow story advance --work-id WALK-1 --confirm DIGEST'), command: 'singularity-flow story advance --work-id WALK-1' });
  if (!preview.ok || !digest) walk.stop(stepId, args, preview.ok ? { code: 'WORKFLOW_WALK_NO_DIGEST', message: 'story advance returned no confirmation digest.', routes: [] } : preview.refusal);
  const confirmed = await walk.cli(stepId, [...args, '--confirm', digest, '--json'], { person: true });
  if (!confirmed.ok) walk.stop(stepId, [...args, '--confirm', digest], confirmed.refusal);
}

async function submit(walk, stepId, facts) {
  const values = decisionValues(walk, stepId);
  const args = ['submit', stepId, ...values.flatMap((value) => ['--decision', value]), '--json'];
  for (let round = 0; round < 3; round += 1) {
    const result = await walk.cli(stepId, args);
    if (result.ok) return;
    const met = MET_REFUSALS[result.refusal.code];
    if (met?.handler === 'review' && round === 0) { await review(walk, stepId); continue; }
    if (met?.handler === 'advance') { await advance(walk, stepId); return; }
    if (met?.handler === 'decisions' && round < 2) { if (await decideOpenItems(walk, stepId)) continue; }
    walk.stop(stepId, args, result.refusal);
  }
}

/** A value that meets a route's condition on one input (`pass`, `{ in: [...] }`, `{ gte: 3 }` …). */
function valueFor(condition, input) {
  if (condition === undefined || condition === null) return input.values?.[0] ?? (input.type === 'number' ? 1 : null);
  if (typeof condition !== 'object') return condition;
  if (Array.isArray(condition)) return condition[0];
  if (Array.isArray(condition.in)) return condition.in[0];
  if ('equals' in condition) return condition.equals;
  if ('eq' in condition) return condition.eq;
  if ('gte' in condition) return condition.gte;
  if ('gt' in condition) return Number(condition.gt) + 1;
  if ('lte' in condition) return condition.lte;
  if ('lt' in condition) return Number(condition.lt) - 1;
  return input.values?.[0] ?? null;
}

/**
 * The route the walk takes at a decision: on to a step it has not walked yet (the next in order
 * first), so every step is walked once and a loop is followed once; else an ending that omits
 * nothing, else any ending, else the first route.
 */
function onwardRoute(walk, decision) {
  const routes = decision.routes ?? [];
  const walked = new Set(walk.visits.keys());
  const after = walk.order.indexOf(decision.after);
  const fresh = (id) => walk.order.indexOf(id) > after && !walked.has(id);
  const following = after >= 0 ? walk.order[after + 1] : null;
  return routes.find((route) => route.to === following && fresh(following))
    ?? routes.find((route) => fresh(route.to))
    ?? routes.find((route) => route.to === 'next' && following && fresh(following))
    ?? routes.find((route) => route.to === 'end' && !route.omits?.length) ?? routes.find((route) => route.to === 'end') ?? routes[0] ?? null;
}

/** The values a step's decisions read at submit, for the onward route. */
function decisionValues(walk, stepId) {
  const decisions = (walk.resolution?.decisions ?? walk.workflow.decisions ?? []).filter((entry) => entry.after === stepId);
  const values = [];
  for (const decision of decisions) {
    const onward = onwardRoute(walk, decision);
    for (const input of decision.inputs ?? []) {
      const value = valueFor(onward?.when?.[input.name], input);
      if (value !== null && value !== undefined) values.push(`${input.name}=${value}`);
    }
    walk.person(stepId, { class: 'expected-person-step', kind: 'decision', ask: `${decision.label ?? decision.id}: the walk took "${onward?.label ?? onward?.id ?? 'the first route'}" (to ${onward?.to ?? 'next'}).`,
      where: decision.kind === 'ask' ? whereFor('singularity-flow decision choose') : `recorded at submit with --decision NAME=VALUE (${whereFor(`singularity-flow submit ${stepId}`)})${decision.by?.length ? `, by ${decision.by.join(', ')}` : ''}` });
  }
  return values;
}

async function choosePending(walk, story) {
  const stepId = story.pendingDecision?.after ?? story.currentPhase ?? 'decision';
  const shown = await walk.cli(stepId, ['decision', 'show', WALK_WORK_ID, '--json']);
  const data = shown.parsed?.data ?? shown.parsed ?? {};
  const options = data.options ?? data.routes ?? data.decision?.routes ?? [];
  const option = options.find((entry) => entry.to === 'next') ?? options[0];
  walk.person(stepId, { class: 'expected-person-step', kind: 'decision', ask: `${data.label ?? data.decision?.label ?? 'Choose the next route'}`, where: whereFor('singularity-flow decision choose') });
  const args = ['decision', 'choose', WALK_WORK_ID, ...(option?.id ? ['--option', option.id] : ['--to', 'next']), '--reason', REASON,
    ...(data.expected ?? data.key ? ['--expected', data.expected ?? data.key] : []), '--json'];
  const chosen = await walk.cli(stepId, args, { person: true });
  if (!chosen.ok) walk.stop(stepId, args, chosen.refusal);
}

/** Drives one step from wherever it stands until it is approved, completed or skipped. */
async function driveStep(walk, stepId) {
  const record = walk.step(stepId);
  walk.visits.set(stepId, (walk.visits.get(stepId) ?? 0) + 1);
  walk.stepDeadline = Date.now() + walk.stepSeconds * 1000;
  const done = { prepared: false, authored: false, clarified: false, published: false, reviewed: false, submitted: false };
  for (let action = 0; action < MAX_ACTIONS_PER_STEP; action += 1) {
    const story = await walk.readStory();
    const phase = story.phases?.[stepId] ?? {};
    if (story.status === 'closed' || story.currentPhase !== stepId || ['approved', 'skipped', 'cancelled'].includes(phase.status)) {
      // A step a decision sent the Story back past is reset by that route; it was still walked to its end.
      record.outcome = phase.status === 'skipped' ? 'skipped' : phase.status === 'approved' ? (phase.approvalPolicy?.mode === 'none' ? 'completed' : 'approved')
        : done.submitted ? 'completed' : (phase.status ?? 'completed');
      return;
    }
    if (story.pendingDecision) { await choosePending(walk, story); continue; }
    const facts = stepFacts(walk, stepId, phase);
    if (phase.status === 'awaiting_approval') { await approve(walk, stepId, phase); continue; }
    if (!done.prepared) {
      done.prepared = true;
      const args = ['prepare', stepId, '--json'];
      const prepared = await walk.cli(stepId, args);
      if (!prepared.ok) walk.stop(stepId, args, prepared.refusal);
      continue;
    }
    if (!done.authored) { done.authored = true; await author(walk, stepId, facts); }
    if (!done.clarified) { done.clarified = true; await clarify(walk, stepId, facts); await exerciseMarker(walk, stepId, facts); }
    if (!done.published) { done.published = true; await publish(walk, stepId); continue; }
    if (facts.reviewed && !done.reviewed) { done.reviewed = true; await review(walk, stepId); continue; }
    if (!done.submitted) { done.submitted = true; await submit(walk, stepId, facts); continue; }
    walk.stop(stepId, ['status', WALK_WORK_ID], { code: 'WORKFLOW_WALK_NO_PROGRESS',
      message: `The step was published and submitted and is still ${phase.status}.`, routes: [] },
    'The step stays open after it was published and submitted, with no refusal naming why: a route is missing.');
  }
  walk.stop(stepId, ['status', WALK_WORK_ID], { code: 'WORKFLOW_WALK_NO_PROGRESS', message: `The step did not move after ${MAX_ACTIONS_PER_STEP} actions.`, routes: [] });
}

async function walkOne(template, workflow, { stepSeconds, deadline, keep }) {
  const started = Date.now();
  const sandbox = await copySandbox(template, { keep });
  const walk = new StoryWalk(sandbox, workflow, { stepSeconds, deadline });
  for (const id of walk.order) walk.step(id).label = id;
  let outcome = 'completed';
  try {
    let story = await startStory(walk);
    for (let visit = 0; visit < MAX_STEP_VISITS; visit += 1) {
      story = await walk.readStory();
      if (story.status === 'closed') break;
      const stepId = story.pendingDecision?.after ?? story.currentPhase;
      if (!stepId) break;
      await driveStep(walk, stepId);
    }
    story = await walk.readStory();
    if (story.status !== 'closed') {
      walk.stop(story.currentPhase ?? walk.order.at(-1), ['status', WALK_WORK_ID], { code: 'WORKFLOW_WALK_NOT_CLOSED',
        message: `Every step the walk could reach is done but the Story is ${story.status}.`, routes: [] });
    }
    for (const [id, phase] of Object.entries(story.phases ?? {})) {
      const record = walk.step(id);
      if (record.outcome === 'not-reached' && phase.status === 'skipped') record.outcome = 'skipped';
      if (record.outcome === 'not-reached' && phase.status === 'approved') record.outcome = 'approved';
    }
  } catch (error) {
    if (!(error instanceof WalkStop)) throw error;
    outcome = error.kind === 'stop' ? 'stopped' : 'not-judged';
    for (const record of walk.steps.values()) if (record.notJudged.length && record.outcome !== 'stopped') record.outcome = 'not-judged';
  } finally {
    await sandbox.dispose();
  }
  const steps = [...walk.steps.values()].sort((left, right) => walk.order.indexOf(left.id) - walk.order.indexOf(right.id));
  return {
    id: workflow.id, label: workflow.label ?? workflow.id, outcome, seconds: Math.round((Date.now() - started) / 100) / 10,
    ...(keep ? { folder: sandbox.base } : {}),
    steps,
    stops: steps.flatMap((step) => step.stops.map((stop) => ({ step: step.id, ...stop })))
  };
}

/** The Story workflows a walk can take, from the walk's own copy of the configuration. */
async function storyWorkflows(template) {
  const listed = await template.run(['workflow', 'list', '--json']);
  const value = parseOutput(listed.stdout);
  const list = Array.isArray(value) ? value : value?.workflows ?? value?.data?.workflows ?? [];
  if (listed.status !== 0 || !Array.isArray(list)) {
    throw new SingularityFlowError(`The walk could not list the workflows in its own copy: ${shortMessage(listed.stderr || listed.stdout)}`, { code: 'WORKFLOW_WALK_LIST_FAILED' });
  }
  return list;
}

/**
 * Walks `workflow` (or every Story workflow) of the repository at `root`, or of the shipped
 * configuration with `shipped`. Bounded by `stepSeconds` per step and `totalSeconds` in all.
 * `configurationRoot` (for in-process callers; the CLI never sets it) walks the configuration in that
 * folder instead of the repository's: a workflow build's staged copy, with a workflow the repository
 * does not have yet.
 */
export async function walkWorkflows(root, { workflow = null, shipped = false, configurationRoot = null, stepSeconds = 240, totalSeconds = 3600, keep = false, onWorkflow = null } = {}) {
  const deadline = Date.now() + totalSeconds * 1000;
  let configuration = null;
  if (!shipped) {
    configuration = configurationRoot ? await readConfigurationFolder(configurationRoot) : await readRepositoryConfiguration(root);
    if (!configuration.files.has('singularity/workflow.yml')) {
      throw new SingularityFlowError('This repository has no workflow configuration (singularity/workflow.yml) to walk. Run singularity-flow workflow walk --source shipped to walk the shipped workflows, or initialize the repository first.',
        { code: 'WORKFLOW_WALK_NO_CONFIGURATION' });
    }
  }
  const template = await createSandbox({ configuration, timeoutMs: Math.max(1000, Math.min(stepSeconds * 1000, deadline - Date.now())) });
  const actionsLeftOut = template.actionsLeftOut ?? [];
  const results = [];
  try {
    const listed = await storyWorkflows(template);
    const known = new Map(listed.map((entry) => [entry.id, entry]));
    if (workflow && !known.has(workflow)) {
      throw new SingularityFlowError(`There is no workflow '${workflow}' to walk. Known: ${[...known.keys()].join(', ') || 'none'}.`, { code: 'WORKFLOW_WALK_UNKNOWN_WORKFLOW' });
    }
    const chosen = workflow ? [known.get(workflow)] : listed.filter((entry) => (entry.governs ?? 'story') === 'story' && entry.status !== 'archived');
    for (const entry of chosen) {
      if ((entry.governs ?? 'story') !== 'story') {
        results.push({ id: entry.id, label: entry.label ?? entry.id, outcome: 'not-walked', reason: `It governs ${entry.governs}s; the walk drives Story workflows only.`, seconds: 0, steps: [], stops: [] });
        continue;
      }
      if (Date.now() >= deadline - 1000) {
        results.push({ id: entry.id, label: entry.label ?? entry.id, outcome: 'not-walked', reason: 'The walk ran out of its total time before this workflow.', seconds: 0, steps: [], stops: [] });
        continue;
      }
      const result = await walkOne(template, entry, { stepSeconds, deadline, keep });
      results.push(result);
      await onWorkflow?.(result);
    }
  } finally {
    await template.dispose();
  }
  const people = results.flatMap((entry) => entry.steps.flatMap((step) => step.people));
  const counts = {
    workflows: results.length,
    completed: results.filter((entry) => entry.outcome === 'completed').length,
    stopped: results.filter((entry) => entry.outcome === 'stopped').length,
    notJudged: results.filter((entry) => ['not-judged', 'not-walked'].includes(entry.outcome)).length,
    stops: results.reduce((sum, entry) => sum + entry.stops.length, 0),
    expectedPersonSteps: people.filter((entry) => entry.class === 'expected-person-step').length,
    expectedReviews: people.filter((entry) => entry.class === 'expected-review').length
  };
  return {
    schemaVersion: 1, resultType: 'workflow-walk', ok: counts.stops === 0 && counts.notJudged === 0,
    source: shipped ? { kind: 'shipped' } : configuration.source, modelUsed: false,
    // After-step actions send to other systems; the walk takes them out of its copy and sends nothing.
    actionsLeftOut,
    budget: { stepSeconds, totalSeconds }, counts, workflows: results
  };
}

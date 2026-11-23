/**
 * The Story fuzzer (owner, 2026-11-23: "do 1 and 2"). A small spec-driven Story, built once up to its Verification step,
 * is copied for each walk. A walk is a seeded sequence of what a person and an author do on it:
 * - advance: the author writes, publishes and submits the step, or the person approves it, or the next version or step
 *   is opened; a release report is sometimes edited first;
 * - raise one to three issues against an earlier step;
 * - answer one item on the decision list, or every item that shares a choice with one answer, as the card does;
 * - return a step that waits for approval for changes.
 *
 * After every action it checks what must hold (src/story-invariants.mjs):
 * - nothing the CLI logged as a violation;
 * - every choice the list shows records, tried on a copy of the Story, alone and as an answer for all;
 * - the Story is never left with nothing to do.
 *
 * A failure names its seed and the actions that led there, so it replays exactly.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { childTimeout } from './child-timeout.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPOSITORY, 'bin/singularity-flow.mjs');
export const FUZZ_WORK = 'FUZZ-1';
const IDENTITY = 'History Tester';

/** A seeded generator: the same seed walks the same Story the same way. */
export function seeded(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: (list) => list[Math.floor(next() * list.length)], chance: (p) => next() < p, int: (low, high) => low + Math.floor(next() * (high - low + 1)) };
}

/** The Story every walk starts from: spec-driven, its code approved, its Verification prepared. */
export async function fuzzTemplate(t) {
  const { storyAtVerification } = await import('./story-to-verification.mjs');
  const story = await storyAtVerification(t, FUZZ_WORK);
  return { parent: story.directory, item: path.relative(story.root, story.item), clauses: story.clauses };
}

function spawn(root, args, log) {
  const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: IDENTITY, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_INVARIANTS: log,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git', 'test-active-workspace.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git', 'test-workspaces.json'),
      SINGULARITY_FLOW_STORY_INDEX: path.join(root, '.git', 'test-story-index.json') } });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', args };
}

const jsonOf = (result) => {
  const text = result.stdout;
  const at = text.search(/^\s*\{/mu);
  try { return at < 0 ? null : JSON.parse(text.slice(at)); } catch { return null; }
};

/** One copy of a Story: the same bytes at another path, its remote its own, its invariant log its own. */
export async function storyCopyOf(t, source) {
  const parent = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-fuzz-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(source.parent, parent, { recursive: true, verbatimSymlinks: true });
  const root = path.join(parent, 'repository');
  const log = path.join(parent, 'invariants.jsonl');
  await rm(log, { force: true });
  spawnSync('git', ['remote', 'set-url', 'origin', path.join(parent, 'origin.git')], { cwd: root });
  const run = (...args) => spawn(root, args, log);
  const item = path.join(root, source.item);
  return {
    parent, root, log, item, clauses: source.clauses, run,
    state: async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')),
    list: () => jsonOf(run('decisions', FUZZ_WORK, '--json'))?.data ?? null,
    next: () => jsonOf(run('nextsteps', FUZZ_WORK, '--json')),
    logged: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  };
}

const choosable = (option) => option.recordable !== false && option.available !== false && option.decidedBy?.allowed === true && !option.action;
const answerable = (option) => choosable(option) && !option.needs?.cause && !option.needs?.clause && !option.needs?.article;
const openItems = (list) => (list?.items ?? []).filter((item) => !item.settled && !item.optional && item.decidedBy?.allowed && item.kind !== 'approval');
const REASON = 'The person decides this from what the Story shows now.';

/** The answers file a card writes for `choices` ([item, option] pairs) on `list`, every need filled as a person would. */
function answersFor(list, choices) {
  const answers = { choose: {}, reason: {}, expires: {}, confirm: list.packetSha256 };
  for (const [item, option] of choices) {
    answers.choose[item.id] = option.id;
    const reason = option.needs?.reason;
    if (reason) answers.reason[item.id] = String(reason.default ?? '').length >= (reason.minimum ?? 0) && reason.default ? reason.default : REASON;
    if (option.needs?.expires) answers.expires[item.id] = option.needs.expires.default;
  }
  return answers;
}

/** The answers for all the card offers: an option every one of several items shows, one reason for all of them. */
export function sharedChoices(list) {
  const groups = new Map();
  for (const item of openItems(list)) {
    for (const option of item.options.filter(answerable)) {
      if (option.oneByOne || option.needs?.expires) continue;
      groups.set(option.id, [...(groups.get(option.id) ?? []), [item, option]]);
    }
  }
  return [...groups.entries()].filter(([, choices]) => choices.length > 1).map(([id, choices]) => ({ id, choices }));
}

async function record(story, list, choices) {
  const file = path.join(story.parent, `answers-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  await writeFile(file, JSON.stringify(answersFor(list, choices)));
  const result = story.run('decisions', 'record', FUZZ_WORK, '--answers', file, '--json');
  await rm(file, { force: true });
  return result;
}

const said = (result) => `${result.args.join(' ')} → exit ${result.status}: ${(result.stderr || result.stdout).replace(/\s+/gu, ' ').slice(0, 600)}`;

// ---------------------------------------------------------------- what a person and an author do

async function writeStepDocument(story, phase, { edit = false } = {}) {
  const file = path.join(story.item, phase.requiredArtifact?.path ?? '');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text == null) return;
  let next = text.replace(/TODO:[^\n]*/gu, `${story.clauses.join(' and ')} are covered by \`test/value.test.mjs\` and \`src/value.mjs\`, on the run the entry names.`)
    .replace(/\bTODO\b/gu, 'none');
  // The author adds a note to a document SFlow wrote: it is theirs from then on (d-story's release report, 2026-11-23).
  if (edit) next = `${next.trimEnd()}\n\n## Notes\n\nThe author read this with the product owner before publishing it.\n`;
  if (next !== text) await writeFile(file, next);
}

/** Move the current step on by one: open it, write and publish it, submit it, or approve it. */
async function advance(story, r, { edit: editing = null } = {}) {
  const workflow = await story.state();
  if (workflow.status !== 'in_progress') return { skipped: `the Story is ${workflow.status}` };
  const step = workflow.currentPhase;
  const phase = workflow.phases[step];
  if (phase.status === 'awaiting_approval') {
    const result = story.run('approve', step, '--yes');
    return { did: `approve ${step}`, result, refusalOk: true };
  }
  // A step's next version opens on the person's yes; a step not begun is prepared.
  const preview = jsonOf(story.run('phase', 'rollover', step, '--json'));
  if (typeof preview?.confirmation === 'string' && /^Start version \d+ of /u.test(preview.question ?? '')) {
    const opened = story.run('phase', 'rollover', step, '--confirm', preview.confirmation, '--json');
    if (opened.status !== 0) return { did: `open the next version of ${step}`, result: opened, refusalOk: true };
  }
  const prepared = story.run('prepare', step);
  const now = (await story.state()).phases[step];
  const edit = step === 'release' && (editing ?? r.chance(0.5));
  await writeStepDocument(story, now, { edit });
  story.run('artifact', 'scan', '--phase', step);
  const authored = now.generationPolicy?.producer === 'deterministic' ? ['--authored', 'deterministic', '--channel', 'kernel-generator'] : ['--authored', 'human', '--channel', 'manual-in-place'];
  const published = story.run('phase', 'publish', step, ...authored);
  if (published.status !== 0) return { did: `publish ${step}${edit ? ' (report edited)' : ''}`, result: published, refusalOk: true, prepared };
  const submitted = story.run('submit', step);
  return { did: `publish and submit ${step}${edit ? ' (report edited)' : ''}`, result: submitted, refusalOk: true };
}

async function raise(story, r, { against: named = null, count: given = null } = {}) {
  const workflow = await story.state();
  if (workflow.currentPhase !== 'release' || !['in_progress', 'awaiting_approval'].includes(workflow.phases.release.status)) return { skipped: 'no later step reports a problem yet' };
  const against = named ?? r.pick(['verification', 'implementation']);
  const count = given ?? r.int(1, 3);
  const results = [];
  for (let index = 1; index <= count; index += 1) {
    results.push(story.run('upstream-issue', 'raise', '--phase', against, '--about', `${story.clauses[index % story.clauses.length]}`,
      '--problem', `Release reads ${against}'s evidence for case ${index}, and it does not show that case running.`));
  }
  const failed = results.find((result) => result.status !== 0);
  return { did: `raise ${count} issue(s) against ${against}`, result: failed ?? results.at(-1), refusalOk: true };
}

async function answerOne(story, r, { option: named = null } = {}) {
  const list = story.list();
  const items = openItems(list).filter((item) => item.options.some((entry) => answerable(entry) && (!named || entry.id === named)));
  if (!items.length) return { skipped: `nothing to answer${named ? ` with ${named}` : ''}` };
  const item = r.pick(items);
  const option = r.pick(item.options.filter((entry) => answerable(entry) && (!named || entry.id === named)));
  return { did: `answer ${item.id} (${item.kind}) with ${option.id}`, result: await record(story, list, [[item, option]]), refusalOk: false };
}

async function answerAll(story, r, { option = null } = {}) {
  const list = story.list();
  const groups = sharedChoices(list).filter((entry) => !option || entry.id === option);
  if (!groups.length) return { skipped: `no answer for all${option ? ` with ${option}` : ''}` };
  const group = r.pick(groups);
  return { did: `answer ${group.choices.map(([item]) => item.id).join(', ')} with ${group.id}, one answer for all`, result: await record(story, list, group.choices), refusalOk: false };
}

async function returnForChanges(story) {
  const workflow = await story.state();
  const step = workflow.currentPhase;
  if (workflow.phases[step]?.status !== 'awaiting_approval') return { skipped: 'nothing waits for approval' };
  return { did: `return ${step} for changes`, result: story.run('reject', step, '--to', step, '--reason', 'The approver wants this step written again before approving it.'), refusalOk: true };
}

/** For a script: advance until `phase` is the current step at `status`, at most `max` times. */
async function advanceUntil(story, r, { phase, status, max = 8, edit = null }) {
  const done = [];
  for (let index = 0; index < max; index += 1) {
    const workflow = await story.state();
    if (workflow.currentPhase === phase && workflow.phases[phase]?.status === status) break;
    const outcome = await advance(story, r, { edit });
    if (outcome.skipped) return { skipped: outcome.skipped };
    done.push(`${outcome.did} → exit ${outcome.result?.status}`);
    if (outcome.result?.status !== 0) return { did: done.join('; '), result: outcome.result, refusalOk: true };
  }
  const workflow = await story.state();
  const reached = workflow.currentPhase === phase && workflow.phases[phase]?.status === status;
  return { did: `${done.join('; ')}${reached ? '' : ` (did not reach ${phase} ${status}: ${workflow.currentPhase} is ${workflow.phases[workflow.currentPhase]?.status})`}`,
    result: { status: reached ? 0 : 1, stdout: '', stderr: '', args: ['advance', phase, status] }, refusalOk: reached };
}

export const ACTIONS = Object.freeze({ advance, advanceUntil, raise, answerOne, answerAll, returnForChanges });
const WEIGHTS = [['advance', 0.45], ['raise', 0.15], ['answerOne', 0.15], ['answerAll', 0.15], ['returnForChanges', 0.1]];

function chooseAction(r) {
  let roll = r.next();
  for (const [name, weight] of WEIGHTS) { if ((roll -= weight) < 0) return name; }
  return 'advance';
}

// ---------------------------------------------------------------- what must hold after every action

/**
 * Every choice the list shows records, tried on a copy: each item's choices alone (up to `cap` of them, returns first),
 * and every answer for all the card offers.
 */
async function offeredChoicesRecord(t, story, list, r, cap) {
  const problems = [];
  const singles = openItems(list).flatMap((item) => item.options.filter(answerable).map((option) => [item, option]));
  singles.sort(([, a], [, b]) => Number(/return/u.test(b.id)) - Number(/return/u.test(a.id)));
  const tried = [...singles.slice(0, cap).map((choice) => [choice]), ...sharedChoices(list).map((group) => group.choices)];
  for (const choices of tried) {
    const copy = await storyCopyOf(t, { parent: story.parent, item: path.relative(story.root, story.item), clauses: story.clauses });
    // The copy's own list, should its digest read where the Story is: the same items and choices, by their IDs.
    const own = copy.list() ?? list;
    const mapped = choices.map(([item, option]) => {
      const twin = (own.items ?? []).find((entry) => entry.id === item.id) ?? item;
      return [twin, twin.options?.find((entry) => entry.id === option.id) ?? option];
    });
    const result = await record(copy, own, mapped);
    const words = choices.map(([item, option]) => `${item.id}=${option.id}`).join(', ');
    if (result.status !== 0) problems.push({ invariant: 'offered-choice-refused', words: `${words}${choices.length > 1 ? ' (one answer for all)' : ''} was shown and is refused: ${said(result)}` });
    await rm(copy.parent, { recursive: true, force: true });
  }
  return problems;
}

/** What must hold now, besides what the CLI logged: the Story has something to do, and every choice it shows records. */
export async function checkStory(t, story, r, { cap = 3, seen = 0 } = {}) {
  const problems = (await story.logged()).slice(seen).map((entry) => ({ invariant: entry.invariant, words: `${entry.words} [${(entry.argv ?? []).join(' ')}]` }));
  const workflow = await story.state();
  // A closed Story has no list to read: only one in progress must have something to do.
  const list = workflow.status === 'in_progress' ? story.list() : null;
  if (workflow.status === 'in_progress' && !list) problems.push({ invariant: 'list-unreadable', words: 'the decision list could not be read' });
  if (workflow.status === 'in_progress') {
    const now = (story.next()?.actions ?? []).filter((entry) => entry.timing === 'now');
    if (!now.length && !openItems(list).length && !(list?.items ?? []).some((item) => item.kind === 'approval')) {
      problems.push({ invariant: 'dead-end', words: `${workflow.currentPhase} is ${workflow.phases[workflow.currentPhase]?.status}: no next step and nothing to decide` });
    }
    if (list) problems.push(...await offeredChoicesRecord(t, story, list, r, cap));
  }
  return { problems, seen: (await story.logged()).length };
}

/**
 * One walk: `steps` actions chosen by `seed` (or the `script` given, by name), each followed by the checks. Returns the
 * trail and every problem, each with the action that left it.
 */
export async function walkStory(t, template, { seed, steps = 10, script = null, cap = 3 }) {
  const story = await storyCopyOf(t, template);
  const r = seeded(seed);
  const trail = [];
  const problems = [];
  let seen = 0;
  for (let index = 0; index < (script?.length ?? steps); index += 1) {
    const [name, params] = script ? [script[index].do, script[index]] : [chooseAction(r), {}];
    const outcome = await ACTIONS[name](story, r, params);
    const line = outcome.skipped ? `${name}: skipped (${outcome.skipped})` : `${outcome.did} → exit ${outcome.result?.status}`;
    trail.push(line);
    if (outcome.result && outcome.result.status !== 0 && !outcome.refusalOk) {
      problems.push({ invariant: 'offered-choice-refused', words: said(outcome.result), at: line });
    }
    const checked = await checkStory(t, story, r, { cap, seen });
    seen = checked.seen;
    problems.push(...checked.problems.map((problem) => ({ ...problem, at: line })));
    if ((await story.state()).status !== 'in_progress') break;
  }
  return { seed, trail, problems, story };
}

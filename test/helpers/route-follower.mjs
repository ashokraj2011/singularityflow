/**
 * The route follower: drives an isolated Story the way an agent and a person do, by following the routes SFlow
 * returns and nothing else [owner, 2026-11-16]. The tests that call internal commands directly never walked the
 * path a person and an agent take, so every incident of one real Story passed them: a refusal routed to generic
 * help, a turn window lapsed while a person answered, a review's continuation named a skill that never ran the
 * routed command, an entry after a rollover was held, and a reviewer's reply dropped its next step.
 *
 * At each step it reads the route the last result returned (`act.do`, else the refusal's remediation plan, else a
 * review's continuation) and takes it as an agent does. A Copilot route is entered by the command its SKILL.md tells
 * the agent to run first (skillEntries(), derived from plugin/skills/<skill>/SKILL.md, never a hand list: a hand
 * list is what drifted). It then does the agent's or the person's part with the journey's scripted, deterministic
 * content: write the step's document or its code and tests, write a review report, answer a question through the
 * recorded-answer route the CLI accepts.
 *
 * Checks at every step [OSA:AC-010–AC-012]:
 *   - progress: the Story's state changed, or a person's question is pending. A read that only hands on to another
 *     route belongs to the step after it, at most two in a row;
 *   - no loop: the same state and route never come round again;
 *   - no circle: a skill is never entered again by a hand-off on the same commit and the same step state;
 *   - through the guard: every file the agent writes while authoring goes through the real pre-tool edit guard
 *     (`hook boundary-guard`), in the turn of the skill the route named, and is checked against the edit permission the
 *     entry returned first (act `author` must mean the permission allows that path). A deny fails before the write;
 *   - the person's view: at each hand-off, next steps, session current, phase show and submission readiness are read
 *     as a person reads them, and each one's "now" must name the same skill as the agent's route (walk.views).
 * A dead end ends the walk with the route trail: a refusal with no route, generic help for a refusal about the
 * Story's state, a Copilot route whose skill does not run the command it was routed with, or a result with nothing
 * to follow. A journey may give a detour for a dead end it expects (what the person would type instead), so the
 * rest of the journey is still checked; the dead end stays a finding.
 *
 * How a route is taken, as the skills tell an agent:
 *   - a route handed to the person (`act.state` next, a review's continuation) is typed in a new turn by its Copilot
 *     form; a route inside the turn, or back to the skill the turn runs, is run by its Shell form;
 *   - `author`: what the entry names before writing comes first (`mutationContract.next`'s `phase begin`, then the
 *     entry again; a `prepare-artifact` step), then the journey's writing, then the skill's own
 *     `phase prepublish <phase> --publish-if-ready`; a code step's summary is prepared again from its code;
 *   - `start-reviewer`: the reviewer sub-agent's /sf-review-source turn writes its report at the staging path, checks
 *     it and retains it, and ends on what the retained review returned;
 *   - `ask-person` with a clarification checkpoint: the answers are written in its response format and recorded by its
 *     recordAction; `confirm-review`: do.shell shows the review, and the person's yes runs the returned --confirm;
 *   - a command that answers in text whatever it is asked is read by its first NOW action's route lines.
 *
 * In VS Code's own chat (`host: 'vscode'`, with test/helpers/vscode-host.mjs) /sf-approve and /sf-decide are skills, never a
 * scripted terminal approval: their page tools run the extension's pages on the Story, and the walk fails on the same tool
 * answer coming back unchanged, or a route VS Code's chat does not have (vscodeTurn, at the end of this file).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './child-timeout.mjs';
import { ownTerminalStep } from '../../src/command-skills.mjs';
import { ISOLATED_RUN_SWITCHES, MACHINE_STATE_LOCATIONS } from '../../src/machine-state-locations.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = path.join(REPOSITORY, 'bin/singularity-flow.mjs');
const SKILLS = path.join(REPOSITORY, 'plugin/skills');
export const JOURNEY_IDENTITY = Object.freeze({ name: 'Journey Driver', email: 'journey-driver@example.test' });

// ------------------------------------------------------------------------------------ the skill entry map

// Checks every skill shares, that run before the skill's own entry: they bind nothing to the step.
const PAUSE_CHECK = /^singularity-flow (?:pause status|session current)\b/u;
// Never an entry: a cut-off result's recovery, and the shared recovery explainer.
const NOT_ENTRY = /^singularity-flow (?:result last|explain test-recovery)\b/u;
const SHARED_MARKER = /^<!-- sflow-(?:copilot-pause|output-contract[^>]*|execution-boundary|turn-boundary[^>]*) -->$/u;

/**
 * Every skill's entry: the first command its SKILL.md tells the agent to run. The pause paragraph's first command
 * beyond the pause check itself (`pause status`, `session current`); otherwise the first command of the skill's own steps,
 * past the shared paragraphs (pause, output contract, execution and turn boundaries), skipping a command pattern
 * (`a|b`). `finish` is the check-and-publish command an authoring skill names, `hint` its argument hint.
 */
export function skillEntries(skillsRoot = SKILLS) {
  const map = new Map();
  for (const directory of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || !directory.name.startsWith('sflow-')) continue;
    let body;
    try { body = readFileSync(path.join(skillsRoot, directory.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const name = `/sf-${directory.name.slice('sflow-'.length)}`;
    const front = /^---\n([\s\S]*?)\n---\n/u.exec(body);
    const hint = front ? (/^argument-hint:\s*"?(.*?)"?\s*$/mu.exec(front[1])?.[1] ?? null) : null;
    const lines = (front ? body.slice(front[0].length) : body).split('\n');
    const pause = [];
    const own = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (SHARED_MARKER.test(lines[index].trim())) {
        if (/copilot-pause/u.test(lines[index])) pause.push(lines[index + 1] ?? '');
        index += 1;
        continue;
      }
      own.push(lines[index]);
    }
    const commands = (text) => [...text.matchAll(/`(singularity-flow [^`]+)`/gu)].map((match) => match[1].replace(/\s+/gu, ' ').trim());
    const usable = (command) => !PAUSE_CHECK.test(command) && !NOT_ENTRY.test(command) && !command.includes('|');
    const fromPause = commands(pause.join('\n')).find(usable) ?? null;
    const fromSteps = commands(own.join('\n')).find(usable) ?? null;
    const entry = fromPause ?? fromSteps;
    const finish = commands(body).find((command) => /^singularity-flow phase prepublish\b.*--publish-if-ready/u.test(command)) ?? null;
    // An alias hands the turn to its canonical skill ("Run `/sflow-code` once", "Delegate once to `/sf-code`").
    // The delegation sentence names it; another skill the text mentions first (/sf-call's `/sf-start … --agent`) is not it.
    const delegate = /<!-- sflow-output-contract: canonical-delegation -->/u.test(body)
      ? (/(?:Delegate once to|Run) `\/(?:sf|sflow)-([a-z0-9-]+)\b[^`]*`/u.exec(own.join('\n'))
        ?? /`\/(?:sf|sflow)-([a-z0-9-]+)\b[^`]*`/u.exec(own.join('\n')))?.[1] ?? null : null;
    // A skill whose first step picks among subcommands (`spec analyze|coverage|trace`) has no single entry.
    const choice = !entry && commands(own.join('\n')).some((command) => !PAUSE_CHECK.test(command) && command.includes('|'));
    // "Successful begin: refresh entry once": opening a code version is followed by the skill's entry again.
    const refreshAfterBegin = /Successful begin: refresh entry once/u.test(body);
    // "The current step's own agent work is this turn's": /sf-next takes the step's work route in its own turn (D2).
    const worksInTurn = /The current step's own agent work is this turn's/u.test(body);
    // "`/sf-code` and `/sf-phase` are one work command": a route naming either is the turn's own work (D1).
    const oneWorkCommand = /`\/sf-code` and `\/sf-phase` are one work command/u.test(body);
    // /sf-task on an open task: "anything else: do the current step's own work in this turn, from `<entry>`" [ITW:REQ-008].
    const stepWork = /anything else: do the current step's own work in this turn, from `(singularity-flow [^`]+)`/u.exec(own.join('\n'))?.[1] ?? null;
    // /sf-task: "A refactor: run `data.task.before` once now, before any edit" [ITW:REQ-015].
    const runsBefore = /run `data\.task\.before` once now, before any edit/u.test(body);
    map.set(name, { skill: name, entry, source: fromPause ? 'pause' : entry ? 'steps' : null, finish, hint, refreshAfterBegin, worksInTurn, oneWorkCommand,
      ...(stepWork ? { stepWork } : {}), ...(runsBefore ? { runsBefore } : {}),
      ...(delegate && !entry ? { delegate: `/sf-${delegate}` } : {}), ...(choice ? { choice: true } : {}) });
  }
  for (const known of map.values()) {
    const target = known.delegate ? map.get(known.delegate) : null;
    if (target?.entry) Object.assign(known, { entry: target.entry, finish: known.finish ?? target.finish, refreshAfterBegin: known.refreshAfterBegin || target.refreshAfterBegin,
      source: `delegates to ${known.delegate}` });
  }
  return map;
}

/** A command's words, without the program name and from its first option on. */
export function commandWords(command) {
  const words = [];
  for (const word of String(command ?? '').replace(/^\s*(?:singularity-flow|sflow)\s+/u, '').split(/\s+/u)) {
    if (!word || word.startsWith('--')) break;
    words.push(word);
  }
  return words;
}

/**
 * The command an agent runs to take a Copilot route: the skill's entry with the route's arguments, the Story and its
 * step filled in. `null` when the skill names no command. A skill whose argument hint names `<phase>` and whose entry
 * has no slot for it is given the routed step after its subcommand (/sf-review-source: "include explicit phase").
 */
export function entryCommand(entries, route, { workId, phases = [], currentPhase = null } = {}) {
  const [name, ...rest] = String(route).trim().split(/\s+/u);
  const known = entries.get(name);
  if (!known?.entry) return null;
  const argumentsGiven = rest.join(' ');
  const phase = rest.find((word) => phases.includes(word)) ?? currentPhase;
  let command = known.entry;
  const slotted = /\$ARGUMENTS|<arguments>|<phase>|<PHASE-ID>|\[PHASE-ID\]/u.test(command);
  // `<arguments>` must be given: with none routed, a skill whose hint asks for the Work ID is given the Story's.
  const required = argumentsGiven || (/WORK-ID/u.test(known.hint ?? '') ? workId ?? '' : '');
  command = command.replaceAll('$ARGUMENTS', argumentsGiven).replaceAll('<arguments>', required || '<arguments>')
    .replaceAll('<WORK-ID>', workId ?? '<WORK-ID>').replaceAll('[WORK-ID]', workId ?? '')
    .replace(/<phase>|<PHASE-ID>|\[PHASE-ID\]/gu, phase ?? '<phase>');
  if (!slotted && rest.some((word) => phases.includes(word)) && /<phase>/u.test(known.hint ?? '')) {
    const words = commandWords(command);
    command = command.replace(`singularity-flow ${words.join(' ')}`, `singularity-flow ${[...words, phase].join(' ')}`);
  }
  return command.replace(/\s+/gu, ' ').trim();
}

// ------------------------------------------------------------------------------------ the isolated Story

const HELLO_TEST = (value, tags = []) => ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';", '',
  ...tags.map((tag) => `// @ac:${tag}`), `test('value', () => assert.equal(value, ${value}));`, ''].join('\n');

/**
 * A repository of its own for one journey, with a local bare remote, a home and every machine-wide SFlow location
 * under one folder: nothing reads or writes the person's ~/.singularity-flow, ~/.copilot or Git configuration.
 * `configure(configuration)` edits singularity/workflow.yml before the first commit; `files` are added first.
 */
export async function journeyRepository(t, { configure = null, files = {}, env: extra = {} } = {}) {
  const base = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-journey-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, 'repository');
  const remote = path.join(base, 'origin.git');
  const home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = ${JOURNEY_IDENTITY.name}\n\temail = ${JOURNEY_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n`);
  const env = { ...process.env,
    ...Object.fromEntries(Object.entries(MACHINE_STATE_LOCATIONS).map(([name, relative]) => [name, path.join(base, 'machine', relative)])),
    ...ISOLATED_RUN_SWITCHES,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: JOURNEY_IDENTITY.name, ...extra };
  for (const name of ['COPILOT_HOME', 'XDG_CONFIG_HOME', 'SINGULARITY_FLOW_SESSION_ID', 'COPILOT_AGENT_SESSION', 'GIT_DIR']) if (!(name in extra)) delete env[name];
  const story = { base, root, remote, home, env, workId: null, item: null };
  const spawn = (command, args, { cwd = root, input = null, environment = env } = {}) => {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', input: input ?? undefined, timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}` };
  };
  const must = (command, args, options) => {
    const result = spawn(command, args, options);
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
    return result.stdout;
  };
  Object.assign(story, {
    spawn, must,
    git: (...args) => must('git', args).trim(),
    /** A command the fixture runs as a person at a terminal: it must succeed. */
    cli: (...args) => must(process.execPath, [CLI, '--no-model', ...args]),
    /** Any command as an agent or a person types it, for its exit and its JSON: no model runs (SINGULARITY_FLOW_NO_MODEL),
     *  and no flag is added, since a read through --utility-entry admits only the flags its form names. */
    raw: (args, options = {}) => spawn(process.execPath, [CLI, ...args], options),
    write: async (relative, text) => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), text);
    },
    read: (relative) => readFile(path.join(root, relative), 'utf8')
  });
  await mkdir(root, { recursive: true });
  story.git('init', '-q', '-b', 'main');
  await story.write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await story.write('src/value.mjs', 'export const value = 1;\n');
  await story.write('test/value.test.mjs', HELLO_TEST(1));
  for (const [relative, text] of Object.entries(files)) await story.write(relative, text);
  story.cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configure?.(configuration);
  await writeFile(configurationPath, YAML.stringify(configuration));
  story.git('add', '-A');
  story.git('commit', '-qm', 'Initialize the journey repository');
  story.must('git', ['init', '-q', '--bare', '-b', 'main', remote], { cwd: base });
  story.git('remote', 'add', 'origin', remote);
  story.git('push', '-q', '-u', 'origin', 'main');
  return story;
}

/** The Story's record, as the checkout holds it now. */
export function storyRecord(story) {
  try { return JSON.parse(readFileSync(path.join(story.root, story.item, 'workflow.json'), 'utf8')); } catch { return null; }
}

/** The last generation of `phase` its record says was published (0 when none was). */
export function publishedGeneration(record, phase) {
  return Math.max(0, ...(record?.phases?.[phase]?.authorship ?? []).filter((entry) => entry?.publishedAt).map((entry) => Number(entry.generation ?? 0)));
}

/** Starts the Story as its person does at a terminal; the walk then follows what SFlow returns. */
export function startStory(story, workId, { workType, title = 'Return the approved value', description = 'The value module must return 2.' }) {
  story.workId = workId;
  story.item = `singularity/work-items/${workId}`;
  return story.cli('start', workId, '--from-branch', 'main', '--work-type', workType, '--title', title, '--description', description);
}

// ------------------------------------------------------------------------------------ one command, as run

/** The route a text answer gives: its first `NOW` action's Copilot and Shell lines, else its first pair of route lines. */
export function textRoute(text) {
  const lines = String(text ?? '').split('\n');
  const now = lines.findIndex((line) => /^\s*NOW\s/u.test(line));
  const block = now < 0 ? lines : lines.slice(now + 1, now + 1 + Math.max(1, lines.slice(now + 1).findIndex((line) => /^\s*(?:NOW|SOON|LATER)\s/u.test(line)) + 1 || lines.length));
  const copilot = block.map((line) => /^\s*(?:- )?Copilot: `?(\/sf[a-z-]+[^`\n]*?)`?\s*$/u.exec(line)?.[1]).find(Boolean) ?? null;
  const shell = block.map((line) => /^\s*(?:- )?Shell: `?(singularity-flow [^`\n]+?)`?\s*$/u.exec(line)?.[1]).find(Boolean) ?? null;
  return copilot || shell ? { copilot, shell } : null;
}

function parseOutput(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/^\s*\{/mu);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch {
    const last = text.lastIndexOf('\n{');
    if (last >= 0) { try { return JSON.parse(text.slice(last + 1)); } catch { return null; } }
    return null;
  }
}

/** A command line split as a shell splits it, without its program name. */
export function argvOf(command) {
  const words = []; let current = null; let quote = null;
  for (const char of String(command)) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; current ??= ''; continue; }
    if (/\s/u.test(char)) { if (current !== null) { words.push(current); current = null; } continue; }
    current = (current ?? '') + char;
  }
  if (current !== null) words.push(current);
  return /^(?:singularity-flow|sflow)$/u.test(words[0] ?? '') ? words.slice(1) : words;
}

async function runCommand(story, command, { agent = true } = {}) {
  const argv = argvOf(command);
  // An agent reads the bounded view SFlow gives it; a person at a terminal reads JSON the same way here.
  for (const flag of agent ? ['--for-agent', '--json'] : ['--json']) if (!argv.includes(flag)) argv.push(flag);
  const output = story.raw(argv);
  let result = parseOutput(output.stdout);
  // A command that answers in text whatever it was asked: its route is its first NOW action's Copilot and Shell lines.
  if (!result && output.status === 0) {
    const route = textRoute(output.stdout);
    result = { textOnly: true, text: `${output.stdout}\n${output.stderr}`.trim(), ...(route ? { act: { state: 'next', do: route } } : {}) };
  }
  if (result && !result.textOnly) {
    const { agentAct, completeAgentResult } = await import('../../src/agent-output.mjs');
    try { result = completeAgentResult(result); } catch { /* the view is what it returned */ }
    // A person's terminal result carries the same routes; read them as an agent's view would state them.
    if (!result.act) { try { const act = agentAct(result); if (act) result = { ...result, act }; } catch { /* no act to read */ } }
  }
  // Every result a walk read, kept for a person debugging a journey: SINGULARITY_FLOW_JOURNEY_DUMP=<folder>.
  if (process.env.SINGULARITY_FLOW_JOURNEY_DUMP) {
    dumped += 1;
    mkdirSync(process.env.SINGULARITY_FLOW_JOURNEY_DUMP, { recursive: true });
    writeFileSync(path.join(process.env.SINGULARITY_FLOW_JOURNEY_DUMP, `${story.workId}-${String(dumped).padStart(3, '0')}-${commandWords(argv.join(' ')).join('-').slice(0, 60)}.json`),
      JSON.stringify({ argv, status: output.status, result, ...(result ? {} : { stdout: output.stdout.slice(-4000) }), stderr: output.stderr.slice(-4000) }, null, 2));
  }
  // In a task's chat the host's after-tool hook sees every command the agent ran, as Copilot calls it: it may carry the
  // /sf-task turn on (task-turn.mjs taskTurnContinuation: a start into its intake, a submission into its approval question,
  // the person's Yes or SFlow's own approval into the next step), which the walk then follows in the same turn.
  const ran = `singularity-flow ${argv.join(' ')}`;
  const chat = chatHooks?.story === story ? chatHooks : null;
  // Where no hook runs (IntelliJ Copilot's local agent, a folder opened through a link), the /sf-task skill carries its own
  // turn on: after a start, a submission or an approval it reads `work status` and, when SFlow says the skill carries it
  // (no hook's turn record binds this checkout), goes on in the same turn [ITW:REQ-111].
  if (agent && chat?.hooks === false && output.status === 0 && !chat.guard.subagent && SKILL_CARRIES.test(commandWords(argv.join(' ')).join(' ') + (argv.includes('--start') ? ' --start' : '')
    + (argv.includes('--submit-if-ready') ? ' --submit-if-ready' : ''))) {
    const read = story.spawn(process.execPath, [CLI, '--no-model', 'work', 'status', '--json']);
    let status = null;
    try { status = JSON.parse(read.stdout); } catch { status = null; }
    if (status?.taskTurn?.carriedBy === 'skill' && status.status === 'in_progress') {
      chat.guard.carried = { after: commandWords(argv.join(' ')).join(' '), note: 'no hook ran; the /sf-task skill reads work status and goes on', by: 'skill' };
    }
  } else if (agent && chat?.guard.turn && !chat.guard.subagent && storyRecord(story)?.resolution?.composition) {
    // As the agent typed it: a word with a space or quote stays one word (a task's words starting "add …" are no `work add`).
    const typed = ['singularity-flow', ...argv].map((word) => (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(' ');
    const said = chat.guard.turn.after('bash', { command: typed }, { resultType: output.status === 0 ? 'success' : 'failure', textResultForLlm: output.stdout.slice(0, 200_000) });
    const note = String(said?.additionalContext ?? '');
    if (/this \/sf-task turn goes on/u.test(note)) chat.guard.carried = { after: commandWords(argv.join(' ')).join(' '), note: note.slice(0, 240) };
  }
  return { status: output.status, result, stdout: output.stdout, stderr: output.stderr, ran };
}
let dumped = 0;
// The walk whose chat the after-tool hook reports to (followRoutes): one at a time.
let chatHooks = null;
// The calls after which the /sf-task skill reads `work status` itself when no hook ran: a start, a submission, an approval.
const SKILL_CARRIES = /^(?:work .*--start|submit\b|status .*--submit-if-ready|approve\b)/u;

// ------------------------------------------------------------------------------------ state, routes and dead ends

/** Where the Story stands: its commit, its working tree's bytes (SFlow's own .sflow output aside) and its record. */
export function storyState(story) {
  const head = story.spawn('git', ['rev-parse', 'HEAD']).stdout.trim();
  const dirty = story.spawn('git', ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n')
    .filter((line) => line && !line.slice(3).startsWith('.sflow/')).sort()
    .map((line) => {
      try { return `${line}:${createHash('sha256').update(readFileSync(path.join(story.root, line.slice(3)))).digest('hex')}`; } catch { return line; }
    });
  const record = storyRecord(story);
  const phase = record?.phases?.[record?.currentPhase] ?? null;
  const intent = phase?.generationIntent?.status ? `:${phase.generationIntent.status}${phase.generationIntent.generation ?? ''}` : '';
  const mark = record ? `${record.status ?? ''}:${record.currentPhase}:${phase?.status}:g${phase?.generation ?? 0}${intent}` : 'no-story';
  return { key: createHash('sha256').update(JSON.stringify([head, dirty, mark])).digest('hex').slice(0, 12), mark, head: head.slice(0, 9) };
}

// The current step's work command, in either name (D1), or the fixed writer of kernel-built convergence.
const WORK_ROUTE = /^\/sf(?:low)?-(?:code|phase|converge)(?:\s|$)/u;
// The states in which SFlow waits for the person: a confirmation, a question, their own terminal step.
const PERSON_STATES = new Set(['confirm', 'confirm-in-terminal', 'ask-person', 'await-human', 'confirm-review']);
const PLACEHOLDER = /<[A-Za-z][A-Za-z0-9_|-]*>/u;
const agentRunnable = (shell) => typeof shell === 'string' && /\s--json(?=\s|$)/u.test(shell) && !/<[A-Za-z][A-Za-z0-9_|-]*>/u.test(shell);
const GENERIC_HELP = (route) => /^\/sf-help\b/u.test(route.copilot ?? '') || /^singularity-flow help\b/u.test(route.shell ?? '');
// Entering a skill (routed with a command) and running that command in the skill's own turn are two different steps.
const routeKey = (route) => `${route.copilot && !route.inTurn ? route.copilot : 'run'}|${route.shell ? argvOf(route.shell).filter((word) => !['--json', '--for-agent'].includes(word)).join(' ') : ''}`;

/**
 * The route a result returns, in the order an agent reads it: act.do, the refusal's plan, a review's continuation,
 * then a check's commands.publish or commands.next and an interrupted task's next action.
 */
export function returnedRoute(result) {
  const act = result?.act ?? null;
  if (act?.do && (act.do.shell || act.do.copilot)) return { shell: act.do.shell ?? null, copilot: act.do.copilot ?? null, source: 'act.do', state: act.state ?? null, turn: act.do.turn ?? null };
  const step = result?.remediationPlan?.steps?.find((entry) => entry?.command || entry?.copilotCommand);
  if (step) return { shell: step.command ?? null, copilot: step.copilotCommand ?? null, source: 'remediationPlan', state: act?.state ?? null };
  const next = (result?.continuation?.actions ?? []).find((entry) => entry?.command || entry?.copilotCommand);
  if (next) return { shell: next.command ?? null, copilot: next.copilotCommand ?? next.skill ?? null, source: 'continuation', state: act?.state ?? null };
  // A check's own routes, which the authoring skills say to use: its publication when ready, else its next step.
  for (const [field, value] of [['commands.publish', result?.commands?.publish], ['commands.next', result?.commands?.next], ['taskResume.nextAction', result?.taskResume?.nextAction]]) {
    const shell = typeof value === 'string' ? value : value?.command ?? value?.commandGuidance?.command ?? null;
    const copilot = typeof value === 'object' ? value?.copilotCommand ?? value?.commandGuidance?.copilotCommand ?? null : null;
    if (/^singularity-flow\s/u.test(shell ?? '') || /^\/sf-/u.test(copilot ?? '')) return { shell, copilot, source: field, state: act?.state ?? null };
  }
  return null;
}

const short = (command) => String(command ?? '').replace(/^singularity-flow /u, '').replaceAll(' --for-agent', '').replaceAll(' --json', '');

/** The route trail, one line a step, for a failure message. */
export function formatTrail(trail) {
  return trail.map((entry) => `#${entry.step} ${entry.turn ? `[${entry.turn}] ` : ''}${entry.taking ?? ''}${entry.ran ? ` → ${short(entry.ran)}` : ''}`
    + `${entry.status !== undefined ? ` (exit ${entry.status}${entry.code ? ` ${entry.code}` : ''}${entry.act ? `, act ${entry.act}` : ''})` : ''}`
    + `${entry.did ? `; ${entry.did}` : ''}${entry.finding ? ` !! ${entry.finding}` : ''}${entry.views ? ` (views differ: ${entry.views})` : ''}${entry.state ? ` [${entry.state}]` : ''}`).join('\n');
}

// ------------------------------------------------------------------------------------ the walk

/**
 * Follows routes from `start` until `done(context)` holds, a dead end, a loop, or `maxSteps`.
 *
 * - `start`: { copilot } or { shell }, what the person types first.
 * - `agent.author({ story, phase, generation, entry })`: writes the step's document or code (act.state author).
 * - `agent.correct({ story, phase, result })`: corrects a draft the check returned (act.state correct); returns true when it did.
 * - `agent.repair({ story, phase, result })`: repairs what a refused gate's failed test names (act.state repair), in the same
 *   turn; returns true when it did, and the same gate runs again.
 * - `agent.review({ story, phase, packet })`: the reviewer's report for a review packet.
 * - `agent.clarify({ story, phase, checkpoint })`: a step's clarification questions with the person's answers,
 *   [{ question, answer }], recorded through the checkpoint's own recordAction.
 * - `values`: the person's scripted answer per Story value a step's submission records (`{ channel: 'web' }`), filled into a
 *   route's `--decision <name>=<<name>>` when the agent asks them.
 * - `person({ story, route, result, act })`: what the person does at a question, confirmation or their own step:
 *   { command } to run as them, { route } to type instead, or null (unanswered; the walk stops there).
 * - `detour({ finding, route, result })`: for a dead end the journey expects, the route the person takes instead.
 * - `newChat({ step, result, story })`: true to go on in a new chat after this step, as a person who opens one does: a new
 *   session for the hooks, nothing else reset. A limit's route taken again on the same state there is still a loop
 *   [limit audit §6, check ii]: a new chat starts the same route only when something changed.
 *
 * Every kept result the walk reads (`result last`, the post-tool hook's handover) must have started at or after the walk's
 * last state change: an older one is an earlier run's, replayed as this one's (`stale-replay`) [limit audit §6, check i].
 *
 * Returns { reached, findings: [{ kind, detail, step }], trail, steps, views }: `views` lists each hand-off where one of
 * the person's views named another skill than the agent's route (see personViews).
 */
export async function followRoutes(story, { start, agent = {}, person = null, detour = null, newChat = null, done, maxSteps = 60, label = 'journey', host = 'cli', vscode = null, skillsRoot = SKILLS, values = {}, hooks = true }) {
  const entries = skillEntries();
  // VS Code's chat [hardening C]: /sf-approve and /sf-decide are entered as skills there, and their page tools are called on
  // the host's pages (test/helpers/vscode-host.mjs); every tool answer is kept to find the same one coming back unchanged.
  // `skillsRoot` reads the tool branches from other skill text, so a journey can show the walk sees a loop that text makes.
  const chat = host === 'vscode' ? { vscode, branches: skillToolBranches(skillsRoot), seen: new Map(), names: vscodeChatNames() } : null;
  const trail = [];
  const findings = [];
  const seen = new Map();
  // The chat the agent works in, as Copilot's hooks see it: one session, a new turn each time a skill is entered.
  const guard = { sessionId: `journey-${createHash('sha256').update(`${label}:${story.base}`).digest('hex').slice(0, 16)}`, turn: null, skill: null, contract: null };
  const views = [];
  const entered = new Map();
  let route = { ...start, source: 'start' };
  chatHooks = { story, guard, hooks };
  // With hooks off, the host runs none of SFlow's hooks: no turn is recorded and nothing is guarded (copilotTurn's stub).
  hooksOff = hooks === false ? story : null;
  let turn = null;
  let idle = 0;
  let last = null;
  const record = storyRecord(story);
  // When the Story's state last changed, for the kept-result check; and how many chats the walk has opened.
  let changedAt = Date.now();
  let chats = 1;
  const phases = () => storyRecord(story)?.phaseOrder ?? record?.phaseOrder ?? [];
  const current = () => storyRecord(story)?.currentPhase ?? null;
  const finding = (kind, detail, step) => { findings.push({ kind, detail, step }); return { kind, detail, step }; };

  for (let step = 1; step <= maxSteps; step += 1) {
    const before = storyState(story);
    // In VS Code the window's Story is part of where things stand: selecting it changes what the approval page shows.
    if (chat?.vscode) before.key = `${before.key}|window:${chat.vscode.shows}`;
    const key = `${before.key}|${routeKey(route)}`;
    const entry = { step, taking: route.copilot && !route.inTurn ? route.copilot : short(route.shell), state: before.mark };
    trail.push(entry);
    if (seen.has(key)) {
      entry.finding = 'loop';
      finding('loop', `the same route on the same state as step ${seen.get(key)}: ${routeKey(route)}`, step);
      break;
    }
    seen.set(key, step);
    // A circle: a skill entered again by a hand-off on the same commit and step state, with nothing done between [OSA:AC-012].
    const entering = route.copilot && !route.inTurn && !route.reentered && !['refresh entry', 'after answers'].includes(route.source)
      ? route.copilot.split(/\s+/u)[0] : null;
    if (entering) {
      const circle = `${before.head}|${before.mark}|${entering}${chat?.vscode ? `|${chat.vscode.shows}` : ''}`;
      if (entered.has(circle)) {
        entry.finding = 'circle';
        finding('circle', `${entering} was entered again on the same commit and step state as at step ${entered.get(circle)}, with no progress between`, step);
        break;
      }
      entered.set(circle, step);
    }
    const taken = chat && route.copilot && !route.inTurn && VSCODE_CARD_SKILLS.has(skillOf(route.copilot))
      ? await vscodeTurn({ story, route, entries, phases: phases(), currentPhase: current(), person, entry, guard, chat, step })
      : await takeRoute({ story, route, entries, phases: phases(), currentPhase: current(), agent, person, entry, turn, last, before, guard, values });
    turn = taken.turn ?? turn;
    last = taken.result ?? last;
    // A route the person types as /sf-task is that turn, whatever work command its steps run in it [ITW:REQ-008].
    entry.turn = route.typed ?? turn;
    // A kept result older than the walk's last state change is an earlier run's, never this call's: that is the finding,
    // whatever the replayed result then led to.
    const kept = taken.result?.keptResult;
    if (kept && Date.parse(kept.startedAt) < changedAt - 1000) {
      taken.finding = { kind: 'stale-replay', detail: `a result kept at ${kept.startedAt} was handed over after the Story changed at ${new Date(changedAt).toISOString()}: ${kept.command}` };
    }
    if (taken.finding) {
      const found = finding(taken.finding.kind, taken.finding.detail, step);
      entry.finding = found.kind;
      const instead = detour?.({ finding: found, route, result: taken.result, story });
      if (!instead) break;
      entry.did = `${entry.did ? `${entry.did}; ` : ''}detour: the person types ${instead.copilot ?? short(instead.shell)}`;
      route = { ...instead, source: 'detour' };
      turn = null;
      idle = 0;
      continue;
    }
    if (done({ story, result: taken.result, record: storyRecord(story), trail })) return { reached: true, findings, trail, steps: step, next: taken.next ?? null, last: taken.result ?? null, views };
    // /sf-task on an open task takes the turn of what comes next (its SKILL.md step 1, task-turn.mjs) [ITW:REQ-008]: a
    // person's approval stays the person's (its Shell route says so); anything else is the current step's own work, which
    // the task's turn does from the work command's entry, as /sf-next does. In the work command's own turn its route is that
    // turn's work; in the task's turn it is hosted there; after a person's answer the person types /sf-task in the same chat.
    const task = taken.next?.copilot ? entries.get(taken.next.copilot.trim()) : null;
    // SFlow's note after a command said this /sf-task turn goes on: its next action is this same turn's, nothing typed.
    const carried = guard.carried;
    guard.carried = null;
    if (carried) entry.did = `${entry.did ? `${entry.did}; ` : ''}${carried.by === 'skill' ? 'the /sf-task skill carries its own turn on, no hook ran' : 'SFlow carries the /sf-task turn on'} (after ${carried.after})`;
    if (carried && taken.next && isPersonRoute({ ...taken.next, inTurn: false })) taken.next = { ...taken.next, carried: true };
    if (task?.stepWork && !isPersonRoute({ ...taken.next, inTurn: false }) && !/^singularity-flow work\b/u.test(taken.next.shell ?? '') && current()) {
      const work = [...entries.values()].find((known) => known.oneWorkCommand && known.entry === task.stepWork)?.skill ?? null;
      const resolved = work ? { ...taken.next, copilot: work, source: `${taken.next.source ?? 'route'} (${task.skill}: the step's own work)` } : null;
      // The next step's work after this one completed (a submission SFlow approved) is a new turn the person types.
      const moved = before.mark.split(':')[1] !== storyState(story).mark.split(':')[1];
      const own = taken.next.turn !== 'new-turn' && !moved;
      if (resolved && carried) {
        guard.skill = task.skill;
        taken.next = { ...resolved, inTurn: false, within: task.skill, carried: true };
      } else if (resolved) taken.next = entries.get(turn)?.oneWorkCommand && own ? { ...resolved, inTurn: Boolean(resolved.shell) }
        : turn === task.skill && guard.skill === task.skill && own ? { ...resolved, inTurn: false, within: task.skill }
          : { ...resolved, inTurn: false, typed: task.skill };
    }
    // D1: in a turn of the work command, a route naming its other name is this turn's own work, run here by its command;
    // never a route the result says is for a new turn (a submission that completed the step ends the turn, decision 7).
    const named = taken.next?.copilot ? skillOf(taken.next.copilot) : null;
    if (named && named !== turn && entries.get(turn)?.oneWorkCommand && entries.get(named)?.oneWorkCommand && !taken.next.inTurn && taken.next.turn !== 'new-turn'
        && taken.next.shell && (taken.next.copilot.trim().split(/\s+/u)[1] ?? current()) === current()) {
      taken.next = { ...taken.next, inTurn: true, source: `${taken.next.source ?? 'route'} (one work command)` };
    }
    // A skill that does the current step's own work in its turn (/sf-next, D2) takes the step's work route there: the
    // work command's steps run in the same turn, with no second command typed [OSA:REQ-025, journey J].
    const host = guard.skill && entries.get(guard.skill)?.worksInTurn ? guard.skill : null;
    if (host && taken.next?.copilot && !taken.next.inTurn && !taken.next.subagent && taken.next.turn !== 'new-turn' && WORK_ROUTE.test(taken.next.copilot)
        && (taken.next.copilot.trim().split(/\s+/u)[1] ?? current()) === current()) {
      taken.next = { ...taken.next, within: host };
    }
    // At a hand-off the person reads their own views: each one's "now" names the agent's skill [OSA:AC-011].
    if (taken.next && !taken.next.inTurn && taken.next.copilot) {
      const agentSkill = skillOf(taken.next.copilot);
      const agentWords = commandWords(taken.next.shell).join(' ');
      for (const view of await personViews(story)) {
        // The same skill, or the same command (a person's confirmation of the step's own command names /sf-confirm).
        const differs = view.skill && agentSkill && view.skill !== agentSkill && !(agentWords && commandWords(view.command).join(' ') === agentWords);
        if (differs || view.completeWhileWriting) {
          views.push({ step, agent: agentSkill, agentCommand: short(taken.next.shell), view: view.view, skill: view.skill, command: short(view.command),
            ...(view.completeWhileWriting ? { said: 'complete while the step is being written' } : {}) });
          entry.views = (entry.views ?? 0) + 1;
        }
      }
    }
    const after = storyState(story);
    if (chat?.vscode) after.key = `${after.key}|window:${chat.vscode.shows}`;
    if (after.key !== before.key) changedAt = Date.now();
    // A new chat, as the person opens one: the hooks see a new session; what the walk has seen stays, so a limit's route
    // taken again on the same state is still a loop.
    if (newChat?.({ step, result: taken.result, story })) {
      chats += 1;
      Object.assign(guard, { sessionId: `${guard.sessionId.replace(/-chat-\d+$/u, '')}-chat-${chats}`, turn: null, skill: null, contract: null, hosts: {} });
      entry.did = `${entry.did ? `${entry.did}; ` : ''}new chat ${chats}`;
      turn = null;
    }
    // Progress: the Story changed, or a person is being asked. A pure hand-off joins the next step, two at most.
    if (after.key === before.key && !taken.personPending) {
      idle += 1;
      if (idle > 2) {
        entry.finding = 'no-progress';
        const found = finding('no-progress', `three routes in a row changed nothing and asked no one; the last was ${routeKey(route)}`, step);
        const instead = detour?.({ finding: found, route, result: taken.result, story });
        if (!instead) break;
        entry.did = `${entry.did ? `${entry.did}; ` : ''}detour: the person types ${instead.copilot ?? short(instead.shell)}`;
        route = { ...instead, source: 'detour' };
        turn = null;
        idle = 0;
        continue;
      }
    } else idle = 0;
    if (!taken.next) {
      entry.finding = 'dead-end';
      const found = finding('dead-end', `nothing to follow after ${short(entry.ran ?? routeKey(route))}${taken.result?.textOnly ? `, which printed no result, only: ${JSON.stringify(taken.result.text.slice(-600))}` : ''}`, step);
      const instead = detour?.({ finding: found, route, result: taken.result, story });
      if (!instead) break;
      route = { ...instead, source: 'detour' };
      turn = null;
      continue;
    }
    route = taken.next;
  }
  if (!findings.length) finding('over-budget', `${maxSteps} steps without reaching the end of ${label}`, trail.length);
  return { reached: false, findings, trail, steps: trail.length, next: null, last, views };
}

/** A route's skill, as `/sf-<name>` (an `/sflow-` alias read as its `/sf-` name); null for none. */
export const skillOf = (value) => {
  const word = String(value ?? '').trim().split(/\s+/u)[0];
  return /^\/(?:sf|sflow)-[a-z0-9-]+$/u.test(word) ? word.replace(/^\/sflow-/u, '/sf-') : null;
};

/**
 * What the person reads as "now", from the four views they open: next steps, session current, phase show and
 * submission readiness, each run as a person runs it (`--json`). Session current names a task's next action when one is
 * open, and says when the step's task is complete: complete while the step is being written is its own disagreement.
 */
export async function personViews(story) {
  const read = (argv) => { const ran = story.raw([...argv, '--json']); return ran.status === 0 ? parseOutput(ran.stdout) : null; };
  const record = storyRecord(story);
  const phase = record?.phases?.[record?.currentPhase] ?? null;
  const { stepBeingWritten } = await import('../../src/phase-generation-need.mjs');
  const writing = Boolean(phase) && stepBeingWritten(record, phase);
  const nextsteps = read(['nextsteps', story.workId]);
  const now = (nextsteps?.actions ?? []).find((entry) => entry.timing === 'now') ?? null;
  const session = read(['session', 'current']);
  const resume = session?.taskResume ?? null;
  const show = phase ? read(['phase', 'show', phase.id]) : null;
  const shown = show?.continuation?.nextAction ?? null;
  const readiness = phase?.status === 'in_progress' ? read(['status', story.workId, '--submission-readiness']) : null;
  return [
    { view: 'nextsteps', skill: skillOf(now?.skill ?? now?.copilotCommand), command: now?.command ?? null },
    // A route that says it has no Copilot form (copilotCommand null) names no skill to the person.
    { view: 'session current', skill: resume?.nextAction && Object.hasOwn(resume.nextAction, 'copilotCommand') && resume.nextAction.copilotCommand === null ? null
      : skillOf(resume?.nextAction?.copilotCommand ?? resume?.nextAction?.skill), command: resume?.nextAction?.command ?? null,
      completeWhileWriting: writing && resume?.complete === true },
    { view: 'phase show', skill: skillOf(shown?.skill ?? shown?.copilotCommand), command: shown?.command ?? null },
    { view: 'submission readiness', skill: skillOf(readiness?.nextSkill), command: readiness?.nextCommand ?? readiness?.command ?? null }
  ];
}

/** One check failing a journey at the write it found, with what was found. */
const stop = (kind, detail) => Object.assign(new Error(detail), { journeyFinding: { kind, detail } });

/**
 * Whether the entry's edit permission (its `mutationContract`) allows `relative`: one of its artifact paths, or an
 * application path when it grants application edits. The guard decides the rest (protected, kernel-owned paths).
 */
export function permissionAllows(contract, relative) {
  if (!contract) return { allowed: false, why: 'the entry returned no edit permission' };
  const covered = (contract.artifacts ?? []).some((prefix) => prefix.endsWith('/') ? relative.startsWith(prefix) : relative === prefix);
  if (covered) return { allowed: true };
  if (/^singularity\//u.test(relative)) return { allowed: false, why: `not one of its artifacts (${(contract.artifacts ?? []).join(', ') || 'none'})` };
  return contract.applicationEdits ? { allowed: true } : { allowed: false, why: 'it grants no application edits' };
}

/**
 * The agent's file writes while authoring, through the real pre-tool edit guard in the turn of `skill`, after the check
 * that the entry's `author` came with a permission for the path [OSA:AC-010]. A deny stops the journey before the write.
 */
function guardedStory(story, guard, skill, contract) {
  const written = [];
  const write = async (relative, text) => {
    if (contract !== undefined) {
      const permit = permissionAllows(contract, relative);
      if (!permit.allowed) throw stop('author-without-permission', `act author, but the edit permission the entry returned does not allow ${relative}: ${permit.why}`);
    }
    // A work command's steps run inside the skill that does them (/sf-next) are checked in that skill's turn.
    const turnSkill = guard.hosts?.[skill] ?? skill ?? guard.skill ?? '/sf-code';
    if (!guard.turn || guard.skill !== turnSkill) {
      guard.turn = copilotTurn(story, guard.sessionId);
      guard.turn.prompt(turnSkill);
      guard.skill = turnSkill;
    }
    const decision = guard.turn.tool('edit', { path: path.join(story.root, relative) });
    if (decision?.permissionDecision === 'deny') throw stop('guard-denied', `the edit guard denied ${relative} in the ${turnSkill} turn: ${String(decision.permissionDecisionReason ?? '').slice(0, 700)}`);
    written.push(relative);
    return story.write(relative, text);
  };
  return { story: { ...story, write }, written };
}

/** A command that starts a step's next version: it runs only on the person's yes, through the turn's own hooks [OSA:REQ-030]. */
const successorConfirmation = (command) => /^(?:singularity-flow|sflow) phase rollover \S+ (?:.* )?--confirm\s/u.test(`${command ?? ''} `);

/**
 * The agent runs a step's next-version confirmation only as Copilot would: the real pre-tool guard sees it first, and
 * holds it to the person's yes in this turn (it also keeps that yes for the opening). Returns the guard's refusal, or null.
 */
function guardedConfirmation(guard, command) {
  if (!guard?.turn || !successorConfirmation(command)) return null;
  const said = guard.turn.tool('bash', { command });
  return said?.permissionDecision === 'deny' ? said : null;
}

// `/decide` is Copilot CLI's own Decide card (plugin/extensions/decisions): the person answers it, as at /sf-decide's card.
// A person's own terminal step the result says never to run (act confirm-in-terminal) is theirs too (person-step-catalog.mjs).
const isPersonRoute = (route) => /^singularity-flow (?:approve|decisions record|story advance .*--confirm|reopen)\b/u.test(route.shell ?? '')
  || /^\/(?:sf-(?:approve|decide|confirm)|decide)\b/u.test(route.copilot ?? '') && !route.inTurn
  || (route.state === 'confirm-in-terminal' && Boolean(ownTerminalStep(route.shell ?? '')));

/**
 * Takes one route: runs what an agent runs for it, then does the agent's or the person's part its result asks for.
 * Returns { result, next, personPending, finding, turn }.
 */
async function takeRoute({ story, route, entries, phases, currentPhase, agent, person, entry, turn, last, before, guard, values = {} }) {
  // A task's approval is asked in its /sf-task chat (its SKILL.md step 1): the person's Yes there, never a terminal approve.
  if (guard && route.source !== 'start' && isPersonRoute(route) && chatApprovalRoute(story, route)) {
    return chatApproval({ story, route, person, entry, guard, phase: currentPhase, last });
  }
  // A person's own step (approval, their decisions, a confirmation): theirs to answer, scripted.
  if (route.person || (route.source !== 'start' && isPersonRoute(route))) {
    const answer = person?.({ story, route, result: last, act: last?.act ?? null, phase: currentPhase });
    if (!answer) return { finding: { kind: 'person-unanswered', detail: `the person's step ${route.copilot ?? short(route.shell)} has no scripted answer` }, personPending: true, turn: 'person' };
    if (answer.route) return { next: { ...answer.route, source: 'person' }, personPending: true, turn: 'person' };
    let ran = null;
    // The person types the code of a confirmation into their own prompt (/sf-confirm CODE): that turn's agent runs it,
    // through the guard, which keeps the typed code as the person's yes for a next version [OSA:REQ-030].
    const confirmTurn = guard && /^\/sf-confirm\b/u.test(route.copilot ?? '') ? copilotTurn(story, `${guard.sessionId}-confirm-${entry.n ?? Date.now()}`) : null;
    if (confirmTurn) confirmTurn.prompt(route.copilot);
    for (const command of answer.commands ?? [answer.command]) {
      entry.did = `${entry.did ? `${entry.did}; ` : 'the person ran '}${short(command)}`;
      if (confirmTurn && successorConfirmation(command)) {
        const said = confirmTurn.tool('bash', { command });
        if (said?.permissionDecision === 'deny') return { finding: { kind: 'guard-denied', detail: `the guard refused ${short(command)} in the person's /sf-confirm turn: ${String(said.permissionDecisionReason ?? '').slice(0, 500)}` }, personPending: true, turn: 'person' };
      }
      ran = await runCommand(story, command, { agent: Boolean(confirmTurn) });
      Object.assign(entry, { ran: ran.ran, status: ran.status, code: ran.result?.error?.code ?? null, act: ran.result?.act?.state ?? null });
      // A person's command refused is a refusal like any other: it routes on, or it is a dead end.
      if (ran.status !== 0) return refusalRoute(ran.result, command, 'person') ?? { result: ran.result, finding: { kind: 'person-refused', detail: `${short(command)} refused: ${ran.result?.error?.code ?? ran.stderr.slice(-300)}` }, turn: 'person' };
    }
    // What the person does next is what their own last command returned, or the route they were answering again.
    let next = answer.then ?? nextFrom(ran.result, { turn: null }) ?? (answer.retry ? { ...route, source: 'retry' } : null);
    // A decision on VS Code's Decide card after which the task's step goes on: VS Code sends /sf-task to the chat the person
    // used last, as after a page approval (extension.ts continueTaskAfterDecision), so nothing is typed [ITW:REQ-008].
    const carriedOn = answer.onCard ? ran.result?.data?.continueTask?.copilotCommand ?? null : null;
    if (carriedOn && next) {
      next = { ...next, sent: 'VS Code' };
      entry.did = `${entry.did}; VS Code sends ${carriedOn} to the chat the person used last`;
    }
    return { result: ran.result, next, personPending: false, turn: 'person' };
  }
  // A Story value the step's submission records (`--decision <name>=<<name>>`, a marketplace agent's hard gate): in the
  // turn the route names, the agent asks the person, and runs the command with the journey's scripted answer.
  const answered = route.shell ? storyValueAnswers(route.shell, values) : null;
  if (answered) {
    route = { ...route, shell: answered.command, inTurn: true };
    entry.did = `the person answered ${answered.names.map((name) => `${name}=${values[name]}`).join(', ')}`;
  }
  // A Copilot route crossing into a turn: the skill's own entry, with the routed command kept to compare.
  let command = route.shell;
  let skill = null;
  if (route.copilot && (!route.inTurn || !route.shell || PLACEHOLDER.test(route.shell))) {
    skill = route.copilot.split(/\s+/u)[0];
    command = entryCommand(entries, route.copilot, { workId: story.workId, phases, currentPhase });
    if (!command) return { finding: { kind: 'skill-without-entry', detail: `${skill}'s SKILL.md names no command to run` }, turn: skill };
    if (/<[A-Za-z][A-Za-z0-9_|-]*>/u.test(command)) return { finding: { kind: 'entry-needs-value', detail: `${skill} enters by ${command}` }, turn: skill };
    // The work command's own re-entry (a refresh, the answers recorded) stays inside the turn that hosts its steps.
    const within = route.within ?? (['refresh entry', 'after answers'].includes(route.source) ? guard?.hosts?.[skill] ?? null : null);
    if (within && guard?.skill === within) {
      // The work command's steps, run inside the turn of the skill that does them (/sf-next): no new prompt.
      guard.hosts = { ...(guard.hosts ?? {}), [skill]: within };
      entry.within = within;
      entry.did = `${within} does the step's own work in its turn, by ${skill}'s steps`;
    } else if (guard && route.subagent && storyRecord(story)?.resolution?.composition) {
      // A task's reviewer is a sub-agent with a chat of its own: the author's /sf-task turn, and what SFlow's notes carry on,
      // stay its own (a classic Story's reviewer keeps the walk's one chat, as before).
      copilotTurn(story, `${guard.sessionId}-reviewer`).prompt(skill);
      guard.subagent = skill;
    } else if (guard) {
      // The person types the skill: a new turn of the chat, as Copilot's hooks see it. What they typed first reaches the
      // prompt hook whole, so words after the skill (`/sf-code <what to change>`) are kept as they are in a real chat.
      guard.turn = copilotTurn(story, guard.sessionId);
      // A task's step work is typed as /sf-task, and its work command's steps run in that turn (`typed`) [ITW:REQ-008].
      guard.turn.prompt(route.typed ?? (route.source === 'start' ? route.copilot.trim() : skill));
      guard.skill = route.typed ?? skill;
      guard.hosts = route.typed ? { [skill]: route.typed } : {};
      if (route.typed) entry.did = `${route.sent ? `${route.sent} sends` : 'the person types'} ${route.typed}; it does the step's own work in its turn, by ${skill}'s steps`;
      if (!route.subagent && !route.sent && !['refresh entry', 'after answers'].includes(route.source)) entry.typed = true;
    }
  }
  if (!command) return { finding: { kind: 'no-route', detail: 'a route with neither a command nor a skill' } };
  if (/<[A-Za-z][A-Za-z0-9_|-]*>/u.test(command)) return { finding: { kind: 'route-needs-value', detail: `${short(command)} needs a value no script gives` } };
  // A task's words: the person types `/sf-task <words>`, and that turn starts the task (/sf-task step 4) [ITW:REQ-001].
  if (guard && route.source === 'start' && !route.copilot && /^singularity-flow work\s/u.test(command)) {
    guard.turn = copilotTurn(story, guard.sessionId);
    guard.turn.prompt(`/sf-task ${argvOf(command)[1] ?? ''}`.trim());
    Object.assign(guard, { skill: '/sf-task', hosts: {}, subagent: null });
    entry.typed = true;
    const said = guard.turn.tool('bash', { command: `${command} --json` });
    if (said?.permissionDecision === 'deny') return { finding: { kind: 'guard-denied', detail: `the guard refused the start in /sf-task's turn: ${String(said.permissionDecisionReason ?? '').slice(0, 500)}` }, turn: '/sf-task' };
  }
  const nextTurn = skill ?? (guard?.skill === '/sf-task' && route.source === 'start' ? '/sf-task' : turn);
  // Back from the reviewer sub-agent: the author's turn is the chat's again.
  if (guard && !route.subagent && route.source !== 'reviewSubagent') guard.subagent = null;
  const held = guardedConfirmation(guard, command);
  if (held) return { finding: { kind: 'guard-denied', detail: `the guard refused ${short(command)}: ${String(held.permissionDecisionReason ?? '').slice(0, 500)}` }, turn: nextTurn };
  const ran = await runCommand(story, command);
  const result = ran.result;
  const act = result?.act ?? null;
  Object.assign(entry, { ran: ran.ran, status: ran.status, code: result?.error?.code ?? null, act: act?.state ?? null });
  if (!result) return { finding: { kind: 'no-result', detail: `${short(command)} printed no JSON: ${(ran.stderr || ran.stdout).slice(-600)}` }, turn: nextTurn };
  const phase = result.phase ?? result.data?.phase ?? currentPhase;

  // A failed test the step's author repairs in this turn (act repair: "repair within the admitted authoring scope, then
  // rerun the original gate"): the agent repairs it, and the same command runs again.
  if (ran.status !== 0 && act?.state === 'repair' && agent.repair) {
    let repaired;
    try { repaired = await agent.repair({ story: guard ? guardedStory(story, guard, nextTurn, guard.contract ?? undefined).story : story, phase, result }); }
    catch (error) { if (error?.journeyFinding) return { result, finding: error.journeyFinding, turn: nextTurn }; throw error; }
    if (repaired) {
      entry.did = `the agent repaired ${phase}'s failed test, and runs its gate again`;
      return { result, next: { shell: command, source: 'repair', inTurn: true }, turn: nextTurn };
    }
  }
  if (ran.status !== 0) return refusalRoute(result, command, nextTurn);

  // /sf-task's own step: a refactor's start names its checks' run on the base, run once now, before any edit [ITW:REQ-015].
  const onBase = route.source === 'start' && [...entries.values()].some((known) => known.runsBefore) ? result.data?.task?.before ?? result.task?.before ?? null : null;
  if (onBase) {
    const base = await runCommand(story, onBase);
    entry.did = `the agent ran the checks on the base before any edit (exit ${base.status})`;
    if (base.status !== 0) return refusalRoute(base.result, onBase, nextTurn) ?? { result: base.result, finding: { kind: 'before-refused', detail: `${short(onBase)}: ${base.stderr.slice(-300)}` }, turn: nextTurn };
  }

  // A command the skill runs before its entry again ("Successful begin: refresh entry once").
  if (route.reenter && !PERSON_STATES.has(act?.state)) return { result, next: { copilot: route.reenter, source: 'refresh entry', reentered: true }, turn: nextTurn };
  // The same when the entry's own act was to open the version: a skill whose text says so enters again once it opened.
  if (!route.reentered && /^singularity-flow phase begin\b/u.test(command) && entries.get(nextTurn)?.refreshAfterBegin && !PERSON_STATES.has(act?.state)) {
    entry.did = 'the version is open; the skill refreshes its entry once, as its text says';
    return { result, next: { copilot: nextTurn, source: 'refresh entry', reentered: true }, turn: nextTurn };
  }

  // The skill was routed with a command: following it must run that command, or lead to it.
  const routedWith = skill && route.shell ? commandWords(route.shell).join(' ') : null;
  const entered = commandWords(command).join(' ');
  const next = nextFrom(result, { turn: nextTurn });

  // The agent's part in its own turn.
  // The agent acts on `act` first: an entry that is admitted for authoring but leads elsewhere is followed there.
  if (act?.state === 'author' || (!act && result.status === 'authoring-entry')) {
    // The entry names what comes before writing (authoringProgress.next): a code step's generation is opened first,
    // and the skill then refreshes its entry once; a missing draft is prepared, and preparing is not writing.
    // and the mutation contract names what source edits wait for (`phase begin` while codeAuthoringReady is false).
    const progress = result.authoringProgress ?? null;
    const guided = (value) => value?.commandGuidance?.command ?? value?.command ?? null;
    const setup = (progress?.next?.command && ['open-code-generation', 'review-successor'].includes(progress.stage) ? progress.next.command : null)
      ?? (result.codeAuthoringReady === false ? (result.mutationContract?.next ?? []).map(guided).find((line) => /^singularity-flow phase begin\b/u.test(line ?? '')) ?? null : null);
    if (setup && !route.reentered) {
      entry.did = 'the agent opens the code generation first, as the entry says';
      return { result, next: { shell: setup, copilot: null, inTurn: true, source: 'mutationContract', reenter: nextTurn }, turn: nextTurn };
    }
    const prepare = (progress?.next?.command && /^singularity-flow prepare\b/u.test(progress.next.command) ? progress.next.command : null)
      ?? (Array.isArray(result.next) ? result.next.filter((item) => /^prepare-artifact:/u.test(item?.id ?? '')).map(guided).find(Boolean) ?? null : null);
    const code = result.generatesCode === true || result.authoring?.generatesCode === true || /^\/sf-code\b/u.test(nextTurn ?? '');
    const steps = [];
    const inTurn = async (line) => {
      const done = await runCommand(story, line);
      steps.push(`${short(line)} (exit ${done.status})`);
      return done;
    };
    if (prepare) {
      const prepared = await inTurn(prepare);
      if (prepared.status !== 0) return { result: prepared.result, finding: { kind: 'prepare-refused', detail: `${short(prepare)}: ${prepared.result?.error?.code ?? prepared.stderr.slice(-300)}` }, turn: nextTurn };
    }
    const generation = Number(storyRecord(story)?.phases?.[phase]?.generation ?? 0);
    // Every write goes through the guard, in this skill's turn, and act author must come with a permission for it.
    if (guard) guard.contract = result.mutationContract ?? null;
    const writer = guard ? guardedStory(story, guard, nextTurn, result.mutationContract ?? null) : { story, written: [] };
    let wrote;
    try { wrote = await agent.author?.({ story: writer.story, phase, generation, entry: result }); }
    catch (error) { if (error?.journeyFinding) return { result, finding: error.journeyFinding, turn: nextTurn }; throw error; }
    if (wrote === false || !agent.author) return { result, finding: { kind: 'author-unscripted', detail: `${phase} asked for authoring the journey does not script` }, turn: nextTurn };
    // A code step's summary is built from the code: prepared again once the code is written.
    if (prepare && code) await inTurn(prepare);
    entry.did = `${steps.length ? `${steps[0]}; ` : ''}the agent wrote ${phase}${guard ? ` (${writer.written.length} file(s) through the guard)` : ''}${steps.length > 1 ? `; ${steps[1]}` : ''}`;
    const finish = entries.get(nextTurn)?.finish;
    if (!finish) return { result, finding: { kind: 'skill-without-finish', detail: `${nextTurn} authored ${phase} but its SKILL.md names no prepublish --publish-if-ready to finish with` }, turn: nextTurn };
    return { result, next: { shell: finish.replace('<phase>', phase), source: `${nextTurn} step`, inTurn: true }, turn: nextTurn };
  }
  if (act?.state === 'correct') {
    let corrected;
    try { corrected = await agent.correct?.({ story: guard ? guardedStory(story, guard, nextTurn, guard.contract ?? undefined).story : story, phase, result }); }
    catch (error) { if (error?.journeyFinding) return { result, finding: error.journeyFinding, turn: nextTurn }; throw error; }
    if (!corrected) return { result, finding: { kind: 'correction-unscripted', detail: `${phase}'s check asked for corrections: ${JSON.stringify((result.findings ?? []).map((item) => item.code ?? item.message)).slice(0, 600)}` }, turn: nextTurn };
    entry.did = `the agent corrected ${phase}`;
    return { result, next: { shell: command, source: 'recheck', inTurn: true }, turn: nextTurn };
  }
  if (act?.state === 'start-reviewer') {
    entry.did = `the agent starts ${phase}'s reviewer`;
    return { result, next: { copilot: `/sf-review-source ${phase}`, source: 'reviewSubagent', subagent: true }, turn: nextTurn };
  }
  // The reviewer's part: a review packet the reviewer writes its report against, checks and retains.
  if (result.reportTemplate && result.stagingProtocol && result.canReview !== false && agent.review) {
    const report = await agent.review({ story, phase: result.phase ?? phase, packet: result });
    if (!report) return { result, finding: { kind: 'review-unscripted', detail: `${phase}'s review packet (${result.kind}) has no scripted report` }, turn: nextTurn };
    await mkdir(path.dirname(result.stagingProtocol.path), { recursive: true });
    await writeFile(result.stagingProtocol.path, `${JSON.stringify(report, null, 2)}\n`);
    const check = result.stagingProtocol.check?.command ?? `singularity-flow review-source check ${result.phase ?? phase} --report-file ${result.stagingProtocol.path} --json`;
    const checked = await runCommand(story, check);
    if (checked.status !== 0 || checked.result?.retentionReady !== true) {
      return { result: checked.result, finding: { kind: 'review-not-ready', detail: `the scripted ${result.kind} report for ${phase} is not ready: ${JSON.stringify(checked.result?.findings ?? checked.result?.error ?? checked.stderr).slice(0, 800)}` }, turn: nextTurn };
    }
    const retain = result.stagingProtocol.retain?.command ?? `singularity-flow review-source submit ${result.phase ?? phase} --report-file ${result.stagingProtocol.path} --json`;
    const retained = await runCommand(story, retain);
    entry.did = `the reviewer wrote, checked and retained a ${result.kind} report: ${retained.result?.status ?? retained.result?.review?.status ?? 'exit ' + retained.status}`;
    // What the reviewer's reply is made from: the act it ends its turn on, and the continuation.
    entry.retained = { status: retained.result?.status ?? null, act: retained.result?.act ?? null, continuation: retained.result?.continuation ?? null };
    if (retained.status !== 0) return { result: retained.result, finding: { kind: 'review-not-retained', detail: `${short(retain)}: ${retained.result?.error?.code ?? retained.stderr.slice(-300)}` }, turn: nextTurn };
    // The reviewer ends its turn on the continuation: the next step must be in what it returned [incident 2026-11-16].
    const onward = returnedRoute(retained.result) ?? returnedRoute(result.afterRetention ? { continuation: result.afterRetention } : null);
    if (!onward) return { result: retained.result, finding: { kind: 'review-without-next', detail: `the retained review of ${phase} returned no next step` }, turn: nextTurn };
    // The author's turn goes on once its reviewer sub-agent returns (owner, 2026-11-19): a ready review is submitted there,
    // and the review's findings on a version only the reviewer has seen start the next version there, with no turn typed.
    if (route.subagent && turn && onward.shell && (retained.result?.act?.state === 'submit' || /\s--review-findings(?:\s|$)/u.test(onward.shell))) {
      entry.did = `${entry.did}; the author's turn goes on: ${short(onward.shell)}`;
      return { result: retained.result, next: { shell: onward.shell, copilot: null, inTurn: true, source: 'author turn after its reviewer' }, turn };
    }
    return { result: retained.result, next: { ...onward, inTurn: false }, turn: null };
  }
  // The step's clarification questions: the agent asks them, the person answers, and the answers are recorded by the
  // checkpoint's own route (written as its response format at its staging path, then recordAction run alone).
  const checkpoint = result.clarification?.checkpoint ?? null;
  const record = checkpoint?.recordAction?.commandGuidance?.command ?? null;
  if (act?.state === 'ask-person' && record && checkpoint.requiresHumanResponse !== false) {
    // A Story value the step's clarification asks in the agent's own words (phase-roles.mjs storyValueTopic), answered from the journey's
    // scripted answer for it, beside the agent's own questions: one ask of the person [ITW:REQ-011].
    const { storyValueOfTopic } = await import('../../src/phase-roles.mjs');
    const valued = (checkpoint.topics ?? []).map(storyValueOfTopic).filter((asked) => asked && Object.hasOwn(values, asked.name))
      .map((asked) => ({ question: `${asked.question} (${asked.choices.join(' / ')})`, answer: String(values[asked.name]) }));
    const responses = [...(await agent.clarify?.({ story, phase, checkpoint }) ?? []), ...valued];
    if (!responses?.length) return { result, personPending: true, finding: { kind: 'clarification-unscripted', detail: `${phase} asks clarification questions the journey does not answer` }, turn: nextTurn };
    const staging = result.clarification.responseStagingPath ?? argvOf(record)[argvOf(record).indexOf('--response-file') + 1];
    await mkdir(path.dirname(staging), { recursive: true });
    await writeFile(staging, `${JSON.stringify({ responses }, null, 2)}\n`);
    const recorded = await runCommand(story, record);
    entry.did = `the agent asked ${responses.length} question(s), the person answered, and the answers were recorded (exit ${recorded.status})`;
    if (recorded.status !== 0) return refusalRoute(recorded.result, record, nextTurn) ?? { result: recorded.result, finding: { kind: 'clarification-refused', detail: recorded.stderr.slice(-400) }, turn: nextTurn };
    // "Once they are given, record them and author this step in this same turn": the skill enters again.
    return { result: recorded.result, next: { copilot: nextTurn, source: 'after answers', reentered: route.reentered ?? false }, personPending: true, turn: nextTurn };
  }
  // A review to confirm: the agent runs do.shell once to show it and its digest, the person confirms what they read,
  // and only on their yes the returned --confirm command runs once.
  if (act?.state === 'confirm-review' && act.do?.shell) {
    const shown = await runCommand(story, act.do.shell);
    const offered = [returnedRoute(shown.result)?.shell, ...(shown.result?.next ?? []).map((item) => item?.command)].find((line) => /\s--confirm\s/u.test(line ?? ''))
      ?? (shown.result?.confirmationDigest ? `${act.do.shell} --confirm ${shown.result.confirmationDigest}` : null);
    if (shown.status !== 0 || !offered) return refusalRoute(shown.result, act.do.shell, nextTurn) ?? { result: shown.result, finding: { kind: 'confirm-review-without-confirmation', detail: `${short(act.do.shell)} showed no --confirm command or digest` }, turn: nextTurn };
    const answer = person?.({ story, route: { shell: offered }, result: shown.result, act: { state: 'confirm', do: { shell: offered } }, phase });
    if (!answer?.command) return { result: shown.result, personPending: true, finding: { kind: 'person-unanswered', detail: `confirm-review: ${short(offered)}` }, turn: nextTurn };
    const confirmed = await runCommand(story, answer.command, { agent: answer.agent !== false });
    entry.did = `the agent showed ${short(act.do.shell)}; the person confirmed: ${short(answer.command)}`;
    if (confirmed.status !== 0) return refusalRoute(confirmed.result, answer.command, nextTurn);
    return { result: confirmed.result, next: nextFrom(confirmed.result, { turn: nextTurn }), personPending: true, turn: nextTurn };
  }
  // A question or confirmation for the person.
  if (PERSON_STATES.has(act?.state) || act?.ask) {
    const answer = person?.({ story, route: returnedRoute(result) ?? {}, result, act, phase });
    if (!answer) return { result, personPending: true, finding: { kind: 'person-unanswered', detail: `${act?.state}: ${String(act?.ask?.question ?? act?.said ?? '').slice(0, 300)}` }, turn: nextTurn };
    if (answer.route) return { result, next: { ...answer.route, source: 'person' }, personPending: true, turn: nextTurn };
    // The agent asked this with the host's question tool, and the person's answer reaches SFlow as the host hands it to the
    // hooks: the turn's answer ledger keeps it, so the guard can hold a confirmation to it [OSA:REQ-030].
    if (guard?.turn && act?.ask?.question && answer.agent !== false) {
      guard.turn.tool('ask_user', { question: act.ask.question, choices: ['Yes', 'No'] });
      guard.turn.after('ask_user', { question: act.ask.question, choices: ['Yes', 'No'] }, { resultType: 'success', textResultForLlm: 'User responded: Yes' });
    }
    let ran2 = null;
    for (const line of answer.commands ?? [answer.command]) {
      entry.did = `${entry.did ? `${entry.did}; ` : 'the person answered: '}${short(line)}`;
      const refused = answer.agent !== false ? guardedConfirmation(guard, line) : null;
      if (refused) return { result, finding: { kind: 'guard-denied', detail: `the guard refused ${short(line)}: ${String(refused.permissionDecisionReason ?? '').slice(0, 500)}` }, turn: nextTurn };
      ran2 = await runCommand(story, line, { agent: answer.agent !== false });
      if (ran2.status !== 0) return { result: ran2.result, finding: { kind: 'person-refused', detail: `${short(line)} refused: ${ran2.result?.error?.code ?? ran2.stderr.slice(-300)}` }, turn: nextTurn };
    }
    return { result: ran2.result, next: answer.then ?? nextFrom(ran2.result, { turn: nextTurn }) ?? (answer.retry ? { ...route, source: 'retry' } : null), personPending: true, turn: nextTurn };
  }
  // Routed with a command its skill does not run: the entry must do the work or lead on. One that changes nothing and
  // gives nothing to follow has dropped the routed command (incident 3: /sf-recover for `phase rollover`).
  if (routedWith && entered !== routedWith) {
    const leads = next?.shell && commandWords(next.shell).join(' ') === routedWith;
    const back = next?.copilot && next.copilot.split(/\s+/u)[0] === skill && !next.inTurn;
    if (!leads && (!next || back) && storyState(story).key === before.key && !['author', 'confirm', 'publish', 'correct', 'start-reviewer'].includes(act?.state)) {
      return { result, finding: { kind: 'skill-skips-route', detail: `${skill} was routed with \`${short(route.shell)}\` but runs \`${short(command)}\`, which returned ${act?.state ?? 'no act'}${next ? ` and ${next.copilot ?? short(next.shell)}` : ' and nothing to follow'}` }, turn: nextTurn };
    }
  }
  return { result, next, turn: nextTurn };
}

/** Whether a person's route is a task's step approval, which /sf-task asks in its chat. */
function chatApprovalRoute(story, route) {
  const record = storyRecord(story);
  if (!record?.resolution?.composition || record.status !== 'in_progress') return false;
  return /^singularity-flow approve\s/u.test(route.shell ?? '') || /^\/sf-approve\b/u.test(route.copilot ?? '');
}

/**
 * A task's approval in its /sf-task chat, as its SKILL.md step 1 says: in the turn SFlow carried on (or the /sf-task the
 * person types), the agent runs `choices begin approve`, asks its question with the host's question tool, and on the
 * person's own Yes runs its onYes command, then the approval it returns; each through the real guard, and the after-tool
 * hook sees each, so the Yes carries the turn on into the next step.
 */
async function chatApproval({ story, route, person, entry, guard, phase, last }) {
  const said = [];
  if (!route.carried || !guard.turn) {
    guard.turn = copilotTurn(story, guard.sessionId);
    guard.turn.prompt('/sf-task');
    Object.assign(guard, { skill: '/sf-task', hosts: {}, subagent: null });
    entry.typed = true;
    said.push('the person types /sf-task');
  }
  const run = async (command) => {
    const decision = guard.turn.tool('bash', { command });
    if (decision?.permissionDecision === 'deny') throw stop('guard-denied', `the guard refused ${short(command)} in the /sf-task approval turn: ${String(decision.permissionDecisionReason ?? '').slice(0, 500)}`);
    return runCommand(story, command);
  };
  try {
    const begin = `singularity-flow choices begin approve ${story.workId} --fetch --for-agent --json --review-packet`;
    const begun = await run(begin);
    Object.assign(entry, { ran: begun.ran, status: begun.status, code: begun.result?.error?.code ?? null, act: begun.result?.act?.state ?? null });
    if (begun.status !== 0) return refusalRoute(begun.result, begin, '/sf-task');
    const ask = begun.result?.act?.ask ?? null;
    if (!ask?.question || !ask.onYes) return { result: begun.result, finding: { kind: 'approval-without-question', detail: `${short(begin)} asked no question with an onYes` }, turn: '/sf-task' };
    const answer = person?.({ story, route: { ...route, copilot: '/sf-approve' }, result: begun.result, act: begun.result.act, phase });
    if (!answer) return { result: begun.result, personPending: true, finding: { kind: 'person-unanswered', detail: `the approval question "${ask.question}"` }, turn: '/sf-task' };
    // The person's other answer on the same screen (`answer.choose`, a choice with its command: "Make it a big change"): the
    // agent runs that command, says its words and begins this approval again, in the same turn [ITW:REQ-113].
    if (answer.choose) {
      const other = (ask.choices ?? []).find((choice) => choice?.label === answer.choose && typeof choice.command === 'string');
      if (!other) return { result: begun.result, finding: { kind: 'choice-missing', detail: `"${answer.choose}" is not a choice with a command on "${ask.question}"` }, turn: '/sf-task' };
      const labels = (ask.choices ?? []).map((choice) => choice?.label ?? choice);
      guard.turn.tool('ask_user', { question: ask.question, choices: labels });
      guard.turn.after('ask_user', { question: ask.question, choices: labels }, { resultType: 'success', textResultForLlm: `User responded: ${other.label}` });
      const chose = await run(other.command);
      if (chose.status !== 0) return refusalRoute(chose.result, other.command, '/sf-task') ?? { result: chose.result, finding: { kind: 'choice-refused', detail: `${short(other.command)}: ${chose.result?.error?.code ?? ''}` }, turn: '/sf-task' };
      said.push(`the person answered "${other.label}" to "${ask.question}" in the chat`);
      entry.did = `${said.join('; ')}; the agent ran ${short(other.command)}: ${short(chose.result?.words ?? '')}; it begins the approval again`;
      Object.assign(entry, { ran: chose.ran, status: chose.status, act: chose.result?.act?.state ?? null });
      return { result: chose.result, next: { ...route, carried: true }, personPending: false, turn: '/sf-task' };
    }
    const yes = (ask.choices ?? []).map((choice) => choice?.label ?? choice).find((label) => typeof label === 'string' && !/^not now$/iu.test(label))
      ?? ask.question.replace(/\?$/u, '');
    guard.turn.tool('ask_user', { question: ask.question, choices: [yes, 'Not now'] });
    guard.turn.after('ask_user', { question: ask.question, choices: [yes, 'Not now'] }, { resultType: 'success', textResultForLlm: `User responded: ${yes}` });
    said.push(`the person answered Yes to "${ask.question}" in the chat`);
    let ran = null;
    for (const command of [ask.onYes].flat()) {
      ran = await run(command);
      if (ran.status !== 0) return refusalRoute(ran.result, command, '/sf-task') ?? { result: ran.result, finding: { kind: 'approval-refused', detail: `${short(command)}: ${ran.result?.error?.code ?? ''}` }, turn: '/sf-task' };
    }
    // The answer recorded names the approval itself as its next command, which this turn runs once.
    const approve = [ran.result?.next?.command, ran.result?.act?.do?.shell].find((command) => /^singularity-flow approve\s/u.test(command ?? ''));
    if (approve) {
      ran = await run(approve);
      if (ran.status !== 0) return refusalRoute(ran.result, approve, '/sf-task') ?? { result: ran.result, finding: { kind: 'approval-refused', detail: `${short(approve)}: ${ran.result?.error?.code ?? ''}` }, turn: '/sf-task' };
    }
    entry.did = `${said.join('; ')}; the agent ran its approval`;
    Object.assign(entry, { ran: ran.ran, status: ran.status, act: ran.result?.act?.state ?? null });
    return { result: ran.result, next: nextFrom(ran.result, { turn: '/sf-task' }), personPending: false, turn: '/sf-task' };
  } catch (error) {
    if (error?.journeyFinding) return { result: last, finding: error.journeyFinding, turn: '/sf-task' };
    throw error;
  }
}

/**
 * A command whose only placeholders are Story values a step's submission records (`--decision channel=<channel>`), each
 * with the journey's scripted answer: `{ command, names }` filled in; null otherwise.
 */
export function storyValueAnswers(command, values = {}) {
  const names = [];
  const filled = String(command ?? '').replace(/(--decision\s+)([A-Za-z][A-Za-z0-9_-]*)=<\2>/gu, (whole, flag, name) => {
    if (!Object.hasOwn(values, name)) return whole;
    names.push(name);
    return `${flag}${name}=${values[name]}`;
  });
  return names.length ? { command: filled, names } : null;
}

/** A refusal must return a route, and not generic help for a refusal about the Story's state. Null without a result. */
function refusalRoute(result, command, turn) {
  if (!result) return null;
  const onward = returnedRoute(result);
  if (!onward) return { result, finding: { kind: 'refusal-without-route', detail: `${short(command)} refused (${result.error?.code ?? 'no code'}) with no route` }, turn };
  if (GENERIC_HELP(onward)) return { result, finding: { kind: 'generic-help', detail: `${short(command)} refused (${result.error?.code ?? 'no code'}: ${String(result.error?.message ?? '').slice(0, 200)}) and routed only to ${onward.copilot ?? onward.shell}` }, turn };
  return { result, next: nextFrom(result, { turn }), turn };
}

/** What follows a result, as an agent takes it: in its own turn by the shell form, a hand-off by the skill's. */
function nextFrom(result, { turn }) {
  const onward = returnedRoute(result);
  if (!onward) return null;
  const relayed = onward.source === 'continuation' || onward.state === 'next' || onward.turn === 'new-turn';
  // A route back to the skill this turn runs is this turn's own work, never relayed (the skills say so), unless the result
  // names it for a new turn: a submission SFlow approved automatically completes the step, and the next step's skill may be
  // this turn's own (/sf-phase to /sf-phase), entered again after its /clear (approve twice with ceremony turns, landing-6).
  const sameTurn = Boolean(onward.copilot && turn && onward.turn !== 'new-turn' && onward.copilot.split(/\s+/u)[0] === turn);
  const inTurn = sameTurn || (!relayed && (!onward.copilot || agentRunnable(onward.shell)));
  return { ...onward, inTurn: inTurn && Boolean(onward.shell) };
}

// ------------------------------------------------------------------------------------ a Copilot turn, as the hooks see it

/**
 * One Copilot chat turn as the host's hooks report it to SFlow (`hook boundary-turn | boundary-guard | boundary-after`),
 * for a check of what a turn may do. `age(minutes)` moves the turn's prompt that far into the past, as the mutation
 * guard's own tests do with an earlier `now`: the turn's records keep the prompt's time as `recordedAt`, the only clock
 * the guard reads, and a record that carries an integrity digest gets it recomputed, as its writer computes it.
 */
let hooksOff = null;
export function copilotTurn(story, sessionId, { host = 'copilot-cli' } = {}) {
  // A host that runs none of SFlow's hooks: nothing reaches SFlow, nothing is recorded or refused.
  if (hooksOff === story) return { prompt: () => ({}), tool: () => ({}), after: () => ({}), answered: () => ({}), age: () => [] };
  const hook = (event, payload) => {
    const ran = story.spawn(process.execPath, [CLI, 'hook', event], { input: JSON.stringify({ cwd: story.root, sessionId, ...payload }) });
    try { return JSON.parse(ran.stdout || '{}'); } catch { return { unparsed: ran.stdout, stderr: ran.stderr }; }
  };
  const boundaries = path.join(path.dirname(story.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const prefix = createHash('sha256').update(sessionId).digest('hex');
  // VS Code's own chat says it as `tool_name`, `tool_input` and `tool_response`, its question tool being vscode_askQuestions
  // (src/copilot-answer-binding.mjs), never Copilot CLI's toolName, toolArgs and ask_user [hardening C].
  const vscode = host === 'vscode';
  const call = (toolName, toolArgs) => (vscode ? { tool_name: toolName, tool_input: toolArgs } : { toolName, toolArgs });
  return {
    prompt: (text) => hook('boundary-turn', { prompt: text }),
    tool: (toolName, toolArgs = {}) => hook('boundary-guard', call(toolName, { cwd: story.root, ...toolArgs })),
    after: (toolName, toolArgs, toolResult) => hook('boundary-after', { ...call(toolName, toolArgs), ...(vscode ? { tool_response: toolResult } : { toolResult }) }),
    /** The person's answer to the turn's question tool, as its host hands it to the post-tool hook. */
    answered: (words) => hook('boundary-after', vscode
      ? { tool_name: 'vscode_askQuestions', tool_input: { questions: [{ header: 'Answer', question: 'Your answer?' }] },
        tool_response: JSON.stringify({ answers: { Answer: { selected: [words], freeText: null, skipped: false } } }) }
      : { toolName: 'ask_user', toolArgs: { question: 'Your answer?' }, toolResult: { resultType: 'success', textResultForLlm: `User responded: ${words}` } }),
    age: (minutes) => {
      const turn = JSON.parse(readFileSync(path.join(boundaries, `${prefix}.json`), 'utf8'));
      const prompted = turn.recordedAt;
      const aged = [];
      for (const name of readdirSync(boundaries).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))) {
        const file = path.join(boundaries, name);
        const value = JSON.parse(readFileSync(file, 'utf8'));
        const visit = (node) => {
          if (!node || typeof node !== 'object') return;
          for (const [field, child] of Object.entries(node)) {
            if (field === 'recordedAt' && child === prompted) node[field] = prompted - minutes * 60_000;
            else visit(child);
          }
        };
        visit(value);
        if (typeof value.integritySha256 === 'string') {
          const { integritySha256: ignored, ...content } = value;
          writeFileSync(file, JSON.stringify({ ...content, integritySha256: createHash('sha256').update(JSON.stringify(content)).digest('hex') }));
        } else writeFileSync(file, `${JSON.stringify(value)}\n`);
        aged.push(name);
      }
      return aged;
    }
  };
}

// ------------------------------------------------------------------------------------ VS Code's chat [hardening C]

/** The skills whose VS Code branch goes through a page tool, never a scripted terminal approval: entered as skills there. */
const VSCODE_CARD_SKILLS = new Set(['/sf-approve', '/sf-decide']);
const TOOL_SENTENCE = /If `#(sflow\w+)` or `(sflow_\w+)` is available, call it once with `(\w+)`/u;
const THEN_SENTENCE = /Then(?:, unless it returned `([^`]+)`)?,? run `(singularity-flow [^`]+)`/u;

/**
 * Each skill's page-tool branches, from its SKILL.md as skillEntries reads it, never a hand list: "If `#sflowX` or `sflow_x`
 * is available, call it once with `field`", and what the same step runs after it ("Then, unless it returned `<status>`,
 * run `<command>`"), the instruction a real chat follows once the tool answered.
 */
export function skillToolBranches(skillsRoot = SKILLS) {
  const map = new Map();
  for (const directory of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || !directory.name.startsWith('sflow-')) continue;
    let body;
    try { body = readFileSync(path.join(skillsRoot, directory.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const branches = [];
    for (const line of body.split('\n').filter((text) => /^\d+\. /u.test(text))) {
      const tool = TOOL_SENTENCE.exec(line);
      if (!tool) continue;
      const then = THEN_SENTENCE.exec(line.slice(tool.index));
      branches.push({ step: Number(/^(\d+)\./u.exec(line)[1]), reference: `#${tool[1]}`, copilotCli: tool[2], inputs: [tool[3]],
        then: then ? { command: then[2].replace(/\s+/gu, ' ').trim(), unless: then[1] ?? null } : null });
    }
    if (branches.length) map.set(`/sf-${directory.name.slice('sflow-'.length)}`, branches);
  }
  return map;
}

/** A status a skill's "unless it returned `x`" names: exactly, or by its `prefix-*`. */
const statusMatches = (pattern, status) => Boolean(pattern) && (pattern.endsWith('*') ? String(status ?? '').startsWith(pattern.slice(0, -1)) : status === pattern);

/**
 * What VS Code's chat has: the skills (/sf-*, a plugin/skills folder), @sflow's commands, the page tools by their chat name
 * (#sflowDecide) and the Command Palette's titles. A route given to that chat outside these does not exist there.
 */
export function vscodeChatNames(root = REPOSITORY) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  const participant = JSON.parse(readFileSync(path.join(root, 'apps/vscode/src/participant-commands.json'), 'utf8'));
  const commands = Array.isArray(participant) ? participant : participant.commands ?? [];
  return {
    skills: new Set(readdirSync(path.join(root, 'plugin/skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('sflow-'))
      .map((entry) => `/sf-${entry.name.slice('sflow-'.length)}`)),
    participant: new Set(commands.map((command) => `@sflow /${command.name ?? command.id}`)),
    tools: new Map(manifest.contributes.languageModelTools.map((tool) => [`#${tool.toolReferenceName ?? tool.name}`, tool.name])),
    palette: new Set(manifest.contributes.commands.map((command) => (command.category ? `${command.category}: ${command.title}` : command.title)))
  };
}

/** Whether VS Code's chat has this route: a skill, an @sflow command, a page tool, or a Command Palette title. */
export function onVscodeChat(names, value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  const word = text.split(/\s+/u)[0];
  if (word.startsWith('#')) return names.tools.has(word);
  if (word === '@sflow') return names.participant.has(text.split(/\s+/u).slice(0, 2).join(' '));
  if (word.startsWith('/')) return names.skills.has(skillOf(word) ?? word);
  const palette = /^Command Palette: (.+)$/u.exec(text);
  return palette ? names.palette.has(palette[1]) : true;
}

/** A route's VS Code chat form: its #tool when it has one, else its Copilot command. */
const chatRouteOf = (next) => (next && typeof next === 'object' ? next.vscodeChat ?? next.copilotCommand ?? next.copilot ?? null : null);

/**
 * One /sf-approve or /sf-decide turn in VS Code's own chat, as its skill text and the results tell the agent: the page tool
 * is called where the skill names it (/sf-decide step 1) or a result does (an approval's `act.ask.how`, a Decide card's
 * `do.vscodeChat`), the person acts on the page, and the skill's own next instruction runs after it. The same tool, input,
 * status and next coming back on the same Story state is a loop (owner, 2026-11-20); each answer is also checked for a route
 * VS Code's chat does not have, a route back to the skill that called it, an approval page that shows another Story, and the
 * approval handed back as still open; the approval packet, for a route to the approval the turn is giving (owner, 2026-11-21).
 */
async function vscodeTurn({ story, route, entries, phases, currentPhase, person, entry, guard, chat, step }) {
  const { vscode, branches, seen, names } = chat;
  const skill = skillOf(route.copilot);
  const workId = story.workId;
  const callers = new Set([skill]);
  const answered = [];
  const did = [];
  const note = (text) => { did.push(text); entry.did = did.join('; '); };
  if (guard) {
    guard.turn = copilotTurn(story, guard.sessionId, { host: 'vscode' });
    guard.turn.prompt(route.source === 'start' ? route.copilot.trim() : skill);
    Object.assign(guard, { skill, hosts: {} });
  }
  entry.typed = true;
  const finding = (kind, detail) => ({ finding: { kind, detail }, turn: skill });

  /** The page tool, as VS Code's chat calls it; its answer checked. Returns { answer } or a finding. */
  const callTool = async (reference, input) => {
    const name = names.tools.get(reference);
    if (!name) return finding('not-on-vscode', `${reference} is no tool VS Code's chat has`);
    const state = storyState(story);
    const answer = await vscode.callTool(name, input);
    answered.push({ name, answer });
    const next = answer?.next && typeof answer.next === 'object' ? answer.next : null;
    const key = `${state.key}|window:${vscode.shows}|tool:${name}:${JSON.stringify(input)}|${answer?.status}|${chatRouteOf(next) ?? ''}|${next?.command ?? ''}`;
    note(`[tool ${name} ${JSON.stringify(input)}] → ${answer?.status}`);
    if (seen.has(key)) return finding('vscode-loop', `${name} answered ${answer?.status} again on the same Story state, as at step ${seen.get(key)}: nothing changed between`);
    seen.set(key, step);
    const words = `${answer?.message ?? ''} ${JSON.stringify(next ?? '')}`;
    const back = [...callers].find((caller) => new RegExp(`${caller}(?![\\w-])`, 'u').test(words));
    if (back && storyState(story).key === state.key) return finding('returns-to-caller', `${name} answered ${answer?.status} naming ${back}, the skill that called it, with nothing changed: ${String(answer?.message ?? '').slice(0, 300)}`);
    const chatRoute = chatRouteOf(next);
    if (chatRoute && !onVscodeChat(names, chatRoute) && !next?.vscodeChat) return finding('not-on-vscode', `${name} handed VS Code's chat ${chatRoute}, which it does not have`);
    if (next?.modelFreeCommand && !onVscodeChat(names, next.modelFreeCommand)) return finding('not-on-vscode', `${name} named ${next.modelFreeCommand}, which VS Code does not have`);
    const page = vscode.approvals.at(-1);
    if (answer?.status === 'approval-open' && page?.shown?.status === 'elsewhere') return finding('claims-elsewhere', `${name} said the approval page is open, but the window shows ${vscode.shows}, not ${workId}`);
    if (/^approval-/u.test(answer?.status ?? '') && (answer.remaining ?? []).some((line) => /\bApprove\b/u.test(line))) return finding('remaining-handed-off', `${name} opened the approval page and still listed it as open: ${answer.remaining.join('; ')}`);
    return { answer };
  };

  /** The approval page: the person selects the Story there when the window shows another, then approves. */
  const onApprovalPage = async (answer) => {
    const focus = vscode.approvals.at(-1)?.focus ?? { workId, phase: currentPhase };
    if (answer.status === 'approval-elsewhere') {
      const next = answer.next ?? {};
      if (!next.modelFreeCommand || !onVscodeChat(names, next.modelFreeCommand)) return finding('dead-end', `approval-elsewhere named no way to select ${workId} here`);
      vscode.windowStory = workId;
      note(`the person selects ${workId} in this window (${next.modelFreeCommand})`);
    }
    const said = person?.({ story, route: { page: 'approvals', focus }, result: answer, act: null, phase: focus.phase }) ?? null;
    // What the page's Approve ends in (approveWithReceipt), as the person's own command.
    const command = said?.command ?? `singularity-flow approve ${focus.phase} --work-id ${workId} --yes`;
    const ran = await runCommand(story, command, { agent: false });
    note(`the person approves on the approval page: ${short(command)} (exit ${ran.status})`);
    if (ran.status !== 0) return refusalRoute(ran.result, command, 'person') ?? finding('person-refused', `${short(command)} refused`);
    return { result: ran.result, next: nextFrom(ran.result, { turn: null }), personPending: true, turn: 'person' };
  };

  /** What follows a page tool's answer, in this turn: the approval page, or the skill's own next instruction. */
  const afterTool = async (answer, then) => {
    // The skill's own next instruction first, as its text gates it: a literal chat runs it whatever the page did (F1).
    if (then && !statusMatches(then.unless, answer?.status)) return readList(then.command.replace('<WORK-ID>', workId), { toolAnswered: true });
    if (/^approval-/u.test(answer?.status ?? '')) return onApprovalPage(answer);
    return { result: answer, next: null, personPending: true, turn: skill };
  };

  /** The list read in a /sf-decide turn, and what its act sends the agent to next. */
  const readList = async (command, { toolAnswered }) => {
    const ran = await runCommand(story, command);
    note(short(command));
    if (ran.status !== 0) return refusalRoute(ran.result, command, skill);
    const act = ran.result?.act ?? null;
    const list = ran.result?.data?.resultType === 'sflow-decisions' ? ran.result.data : ran.result;
    if (act?.do?.copilot && /^\/decide\b/u.test(act.do.copilot) && !act.do.vscodeChat) return finding('not-on-vscode', `the list's Decide card route is ${act.do.copilot}, which VS Code's chat does not have, and names no #sflowDecide`);
    // The Decide card in VS Code's chat: called once, never again after it answered in this turn (act.said, F3).
    if (act?.state === 'confirm-in-terminal' && act.do?.vscodeChat) {
      if (!toolAnswered) {
        callers.add('/sf-decide');
        const [reference] = act.do.vscodeChat.split(/\s+/u);
        const called = await callTool(reference, { workId });
        if (called.finding) return { ...called, result: ran.result };
        return afterTool(called.answer, null);
      }
      return { result: ran.result, next: { person: true, copilot: null, vscodeChat: act.do.vscodeChat, source: 'the card, for the person' }, personPending: true, turn: skill };
    }
    // "next `approval` you may approve: do /sf-approve 1-6 now" (sflow-decide step 1).
    const approval = list?.next?.kind === 'approval' && (list.items ?? []).find((item) => item.kind === 'approval')?.decidedBy?.allowed;
    if (approval) { callers.add('/sf-approve'); note('do /sf-approve 1-6 now'); return approveSteps(); }
    return { result: ran.result, next: nextFrom(ran.result, { turn: skill }), turn: skill };
  };

  /** /sf-approve steps 1-6 in VS Code's chat: its entry, then the page the approval packet's `ask.how` names. */
  const approveSteps = async () => {
    const command = entryCommand(entries, route.copilot.startsWith('/sf-approve') ? route.copilot : `/sf-approve ${currentPhase ?? ''}`.trim(), { workId, phases, currentPhase });
    const ran = await runCommand(story, command);
    note(short(command));
    if (ran.status !== 0) return refusalRoute(ran.result, command, skill);
    const result = ran.result;
    // `decisions-required`: /sf-decide 11-14 now, without its step 1 (sflow-approve step 1).
    if (result?.reason === 'decisions-required') { callers.add('/sf-decide'); return readList(`singularity-flow decisions ${workId} --for-agent --json`, { toolAnswered: answered.length > 0 }); }
    if (result?.begun === false) return { result, next: nextFrom(result, { turn: skill }), turn: skill };
    // The turn is this approval: what its packet says comes next is never that approval again, which the chat relayed as
    // three routes and the person took round (owner, 2026-11-21).
    const approving = result?.approvalContext?.phase;
    const own = JSON.stringify(result?.approvalPacket ?? null).match(new RegExp(`.{0,120}(?:/sf-approve\\b|singularity-flow approve ${approving}\\b).{0,60}`, 'u'));
    if (approving && own) return finding('approve-self-route', `the approval packet hands the turn approving ${approving} its own approval as a route: ${own[0]}`);
    const how = result?.act?.ask?.how ?? '';
    const reference = /#sflow\w+/u.exec(how)?.[0];
    if (!reference) return finding('no-vscode-route', `the approval asks "${result?.act?.ask?.question ?? ''}" with no route for VS Code's chat, whose question tool cannot record an approval`);
    const called = await callTool(reference, { workId });
    if (called.finding) return { ...called, result };
    return afterTool(called.answer, null);
  };

  // An approve turn never ends with no route: the approval page opened, the person's own @sflow /approve, or a next step
  // (owner's Story arshy, 2026-11-20: "nothing to decide… review on the approval page", and nothing to follow).
  const pagesBefore = vscode.approvals.length;
  const ended = (taken) => {
    const approving = callers.has('/sf-approve') || answered.some(({ answer }) => /^approval-/u.test(answer?.status ?? '') || answer?.next?.kind === 'approve-in-chat');
    const routed = vscode.approvals.length > pagesBefore || answered.some(({ answer }) => /^@sflow \/approve /u.test(answer?.next?.modelFreeCommand ?? '')) || taken.next;
    return taken.finding || !approving || routed ? taken
      : { ...taken, finding: { kind: 'approve-without-route', detail: `the approve turn ended with no approval page, no @sflow /approve and nothing to follow: ${answered.map(({ answer }) => answer?.status).join(', ')}` } };
  };
  if (skill === '/sf-approve') return ended(await approveSteps());
  const branch = branches.get('/sf-decide')?.[0];
  if (!branch) return finding('skill-without-entry', '/sf-decide names no page tool for VS Code');
  const called = await callTool(branch.reference, Object.fromEntries(branch.inputs.map((input) => [input, input === 'workId' ? workId : null])));
  if (called.finding) return called;
  return ended(await afterTool(called.answer, branch.then));
}

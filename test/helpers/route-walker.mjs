/**
 * A bot with no model that does only what SFlow returned. Run against the real binary on a fixture
 * repository, it tells a route that helps from a route that is merely well formed.
 *
 * It follows `act.do`, `next[]`, `remediationPlan.steps` and a skill's named command, and nothing else.
 * It answers a person's question only from the scenario's script, and it writes files only from that
 * script, keyed by step. When it runs out of returned routes, that is a finding, never a retry.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './child-timeout.mjs';
import { longFileRead } from '../../src/copilot-mutation-guard.mjs';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CLI = path.join(REPOSITORY, 'bin/singularity-flow.mjs');
export const WORK = 'WALK-1';
const IDENTITY = 'Route Walker';

function spawn(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: childTimeout(120_000), maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: IDENTITY, SINGULARITY_FLOW_NO_MODEL: '1',
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(cwd, '.git', 'test-active-workspace.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(cwd, '.git', 'test-workspaces.json'),
      SINGULARITY_FLOW_STORY_INDEX: path.join(cwd, '.git', 'test-story-index.json'), ...extraEnv } });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const helpers = (root) => {
  const must = (command, args) => {
    const result = spawn(command, args, root);
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  return { must, write, git: (...args) => must('git', args).stdout.trim(), cli: (...args) => must(process.execPath, [CLI, '--no-model', ...args]) };
};

/**
 * Building a Story takes half a minute, so each one is built once and each scenario walks its own
 * copy: the same bytes at another path, with the remote pointed at its own copy too.
 */
export async function storyCopy(t, template) {
  const parent = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-walk-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await cp(template.parent, parent, { recursive: true, verbatimSymlinks: true });
  const root = path.join(parent, 'repository');
  const remote = path.join(parent, 'origin.git');
  const { git, cli, write } = helpers(root);
  git('remote', 'set-url', 'origin', remote);
  return { ...template, parent, root, remote, git, cli, write, raw: (args, env = {}) => spawn(process.execPath, [CLI, '--no-model', ...args], root, env) };
}

/** A repository whose Story has an approved intake and an open code step with passing work in it. */
export async function codeStepTemplate(t, { configure = null } = {}) {
  const parent = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-walk-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repository');
  const remote = path.join(parent, 'origin.git');
  await mkdir(root);
  const { must, git, cli, write } = helpers(root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', IDENTITY); git('config', 'user.email', 'route-walker@example.test');
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,1));\n`);
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off'; config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  // The walker follows routes, not reviews: its Story is unreviewed. Reviews are walked in review-every-step-cli.test.mjs.
  config.workTypes['classic-delivery'].sourceReview = { mode: 'off' };
  configure?.(config);
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.'); git('commit', '-qm', 'Initialize the walker fixture');
  must('git', ['init', '-q', '--bare', '-b', 'main', remote]); git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main');
  const ready = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', ready.planId, '--json');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Use a value', '--description', 'Return 2.');
  const item = `singularity/work-items/${WORK}`;
  cli('prepare', 'intake');
  await write(`${item}/artifacts/intake/intake.md`, [
    `# ${WORK} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${WORK}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake'); cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${WORK}:AC-001 returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,2));\n`);
  const summary = `${item}/artifacts/implementation/implementation-summary.md`;
  await write(summary, (await readFile(path.join(root, summary), 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  return { parent, root, remote, git, cli, write, item, summary, raw: (args, env = {}) => spawn(process.execPath, [CLI, '--no-model', ...args], root, env) };
}

// ---------------------------------------------------------------- what a route can do

// A person's decision: the command is theirs to run, or the turn exists to ask them.
const PERSON_SKILLS = new Set(['/sf-decide', '/sf-approve', '/sf-converge', '/sf-confirm', '/sf-test-setup']);
const PERSON_WORDS = /^(?:approve|decision(?!s? show)|decisions|choices begin|upstream-issue (?:decide|raise)|story adjudicate|story intent-amendment|appeal (?:decide|submit|evidence-accept|risk-accept)|reopen|configuration approve)\b/u;
// Ending the work is always open to a person, so it never counts as a way through.
const GIVE_UP_WORDS = /^(?:cancel|reject|story discard-worktree|story abandon)\b/u;
const GIVE_UP_SKILLS = new Set(['/sf-cancel', '/sf-reject']);
const FINISHING_SKILLS = new Set(['/sf-sync', '/sf-publish']);
const FINISHING_WORDS = /^(?:sync|publish-retained|story sync|initiative sync|goal sync)\b/u;
const READ_SKILLS = new Set(['/sf-recover', '/sf-status', '/sf-doctor', '/sf-explain', '/sf-next', '/sf-nextsteps', '/sf-home', '/sf-advise', '/sf-report',
  '/sf-help', '/sf-logs', '/sf-session', '/sf-workspaces', '/sf-stories', '/sf-phase-documents', '/sf-inspect', '/sf-docs', '/sf-workflows', '/sf-about', '/sf-gate', '/sf-evidence']);

const commandWords = (command) => String(command ?? '').replace(/^singularity-flow\s+/u, '').replace(/\s+--.*$/u, '').split(/\s+/u).filter(Boolean);

/**
 * One route's effect: `can-change`, `person-decision`, `machine-finishing`, `read-only` or `gives-up`. The registry
 * says what a command is; the lists above say whose it is. `isRead` is the registry's answer, passed in
 * so that this stays one function for the walker and the static layer.
 */
export function routeEffect({ command = null, skill = null } = {}, isRead = () => false) {
  const name = skill ? String(skill).split(/\s+/u)[0] : null;
  const words = commandWords(command).join(' ');
  if ((command && GIVE_UP_WORDS.test(words)) || (name && GIVE_UP_SKILLS.has(name))) return 'gives-up';
  // A digest to confirm is what a person reviewed; no agent supplies one.
  if (command && /\s--confirm\b/u.test(command)) return 'person-decision';
  // The command says what it is; a skill speaks only for a route with no command.
  if (command) {
    if (PERSON_WORDS.test(words)) return 'person-decision';
    if (FINISHING_WORDS.test(words)) return 'machine-finishing';
    return isRead(commandWords(command)) && !/--publish-if-ready|--submit-if-ready|--apply\b/u.test(command) ? 'read-only' : 'can-change';
  }
  if (PERSON_SKILLS.has(name)) return 'person-decision';
  if (FINISHING_SKILLS.has(name)) return 'machine-finishing';
  if (name) return READ_SKILLS.has(name) ? 'read-only' : 'can-change';
  return 'none';
}

/** What the registry says about a command's words: true when it reads and changes nothing. */
export async function registryReader() {
  const { resolveOperation } = await import('../../src/command-registry.mjs');
  return (words) => {
    if (!words?.length) return false;
    try { return resolveOperation({ requestedCommand: words[0], positionals: words, options: {} }).classification === 'read'; } catch { return false; }
  };
}

/**
 * The routes a result returned, in the order it gave them. Nothing else counts as a route: not `said`,
 * `fix` or a refusal's words, which a model would have to interpret. These are the places the skills
 * tell an agent to follow.
 */
export function returnedRoutes(result) {
  const routes = [];
  const add = (command, skill, source) => {
    const clean = typeof command === 'string' && command.startsWith('singularity-flow') ? command : null;
    const named = typeof skill === 'string' && skill.startsWith('/') ? skill : null;
    if ((clean || named) && !routes.some((entry) => entry.command === clean && entry.skill === named)) routes.push({ command: clean, skill: named, source });
  };
  const addRoute = (value, source) => {
    if (typeof value === 'string') add(value, null, source);
    else if (value && typeof value === 'object') add(value.command, value.skill ?? value.copilotCommand, source);
  };
  add(result?.act?.do?.shell, result?.act?.do?.copilot, 'act.do');
  for (const step of result?.remediationPlan?.steps ?? []) addRoute(step, 'remediationPlan');
  for (const entry of Array.isArray(result?.next) ? result.next : []) addRoute(entry, 'next');
  addRoute(result?.commands?.publish, 'commands.publish');
  addRoute(result?.commands?.next, 'commands.next');
  addRoute(result?.commandGuidance?.next, 'commandGuidance.next');
  for (const issue of Array.isArray(result?.resolution?.issues) ? result.resolution.issues : []) {
    for (const choice of Array.isArray(issue?.choices) ? issue.choices : []) addRoute(choice?.commandGuidance ?? choice, 'resolution');
  }
  addRoute(result?.taskResume?.nextAction, 'taskResume');
  // `act.read` names what to read next, and a route inside one of those fields is a returned route.
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) { value.forEach((entry) => visit(entry, depth + 1)); return; }
    if (typeof value.command === 'string' || typeof value.copilotCommand === 'string') addRoute(value, 'act.read');
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  for (const field of Array.isArray(result?.act?.read) ? result.act.read : []) {
    visit(String(field).split('.').reduce((value, key) => value?.[key], result));
  }
  return routes;
}

/** A route printed as lines rather than fields: a guard's reason, or a command that answers in text whatever it was asked. */
export function lineRoutes(text, source) {
  const copilot = String(text).match(/^\s*- Copilot: (\/sf[a-z-]+[^\n]*)/mu)?.[1]; const shell = String(text).match(/^\s*- Shell: (singularity-flow [^\n]+)/mu)?.[1];
  return copilot || shell ? [{ command: shell ?? null, skill: copilot ?? null, source }] : [];
}

const guardCode = (answer) => (answer.permissionDecision === 'deny'
  ? String(answer.permissionDecisionReason ?? '').match(/^([A-Z][A-Z0-9_]{3,})\b/u)?.[1] ?? 'GUARD_PROSE' : null);

/** The command a skill names first, past its pause check; `<phase>` and `<WORK-ID>` come from the Story. */
export function skillNamedCommands(skill, { phase = null } = {}) {
  const directory = `sflow-${String(skill).split(/\s+/u)[0].replace(/^\/sf-/u, '')}`;
  const body = readFileSync(path.join(REPOSITORY, 'plugin/skills', directory, 'SKILL.md'), 'utf8');
  const argumentsGiven = String(skill).split(/\s+/u).slice(1).join(' ');
  return [...body.matchAll(/`(singularity-flow [^`]+)`/gu)].map((match) => match[1])
    .filter((command) => !/^singularity-flow (?:session current|result last|decisions record)\b/u.test(command))
    .map((command) => command.replaceAll('$ARGUMENTS', argumentsGiven).replaceAll('<WORK-ID>', WORK).replaceAll('<phase>', phase ?? '<phase>').replace(/\s+/gu, ' ').trim())
    .filter((command) => !/<[^>]+>|\|/u.test(command));
}

// ---------------------------------------------------------------- the walk

function parseOutput(stdout) {
  const start = stdout.search(/^\s*\{/mu);
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

const argvOf = (command) => {
  const words = []; let current = null; let quote = null;
  for (const char of command) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; current ??= ''; continue; }
    if (/\s/u.test(char)) { if (current !== null) { words.push(current); current = null; } continue; }
    current = (current ?? '') + char;
  }
  if (current !== null) words.push(current);
  return words.slice(1);
};

function stateKey(story) {
  const head = spawn('git', ['rev-parse', 'HEAD'], story.root).stdout.trim();
  // SFlow's own output and saved results sit outside the Story's state.
  const dirty = spawn('git', ['status', '--porcelain', '--untracked-files=all'], story.root).stdout.split('\n').filter((line) => line && !line.includes('.sflow/')).sort();
  const bytes = dirty.map((line) => {
    try { return `${line}:${createHash('sha256').update(readFileSync(path.join(story.root, line.slice(3)))).digest('hex')}`; } catch { return line; }
  });
  return createHash('sha256').update(JSON.stringify([head, bytes])).digest('hex').slice(0, 16);
}

/** Where the Story stands. A route that moves this without reaching the outcome has lost what was asked. */
function storyMark(story) {
  try {
    const workflow = JSON.parse(readFileSync(path.join(story.root, story.item, 'workflow.json'), 'utf8'));
    const phase = workflow.phases?.[workflow.currentPhase];
    return `${workflow.currentPhase}|${phase?.status}|${phase?.generation}`;
  } catch { return null; }
}

/**
 * Walks one scenario. It starts from `scenario.start` (a command or a guard call the skill would make)
 * and returns its `outcome` (`reached`, `person-decision` or `dead-end`), the findings, and the trail.
 *
 * - `scenario.reached(result, story)`: the step's outcome, which ends the walk.
 * - `scenario.writes`: { [refusal code or skill]: { path: contents } }; applied once, when that step comes up.
 * - `scenario.answers`: { [placeholder]: value } for what a person would give; `scenario.personFlags` their confirmation.
 * - `scenario.reasons`: { [code]: { mustMatch?, mustNotMatch?, because } }, for a stated reason a test can check.
 * - `scenario.guard`: { prompt, toolName, toolArgs, answered } in place of `start`, for a call the host's hook answers first;
 *   `answered` is what the person typed to the turn's question (ask_user), handed to the post-tool hook before the call.
 *
 * It ends at the outcome, at a person's command that really runs, on the third identical refusal,
 * or when a route moves the Story on without what was asked: following that route lost the person's goal.
 */
/**
 * Every line range a kept result names for reading, with its file. An agent told to read one is
 * never to be refused for its length.
 */
export function namedReads(view) {
  if (!view?.agentOutput?.path) return [];
  const file = view.agentOutput.path;
  const found = (view.agentOutput.read ?? []).map(({ lines }) => ({ file, range: lines }));
  for (const entry of view.omittedFields ?? []) {
    if (entry.lines) found.push({ file, range: entry.lines });
    for (const range of entry.read ?? []) found.push({ file, range });
    for (const text of entry.textFiles ?? []) {
      for (const range of text.read ?? []) found.push({ file: text.path, range });
      if (text.lines) found.push({ file: text.path, range: [1, text.lines] });
    }
  }
  for (const range of view.omittedIndex?.read ?? []) found.push({ file: view.omittedIndex.path, range });
  return found;
}

/** Whether the read guard would turn this named range back, by the guard's own check. */
export async function namedReadRefused({ file, range }, cwd) {
  const refused = await longFileRead([{ name: 'view', args: { path: file, view_range: range } }], cwd);
  return refused?.code ?? null;
}

export async function walk(story, scenario, options = {}) {
  const reads = [];
  const result = await walkRoutes(story, scenario, options, reads);
  for (const read of reads) {
    const code = await namedReadRefused(read, story.root);
    if (code) result.findings.push({ kind: 'refused-read', code, detail: `${read.command} named ${path.basename(read.file)} ${read.range.join('-')}` });
  }
  return result;
}

async function walkRoutes(story, scenario, { maxSteps = 24 } = {}, reads = []) {
  const isRead = await registryReader();
  const { completeAgentResult } = await import('../../src/agent-output.mjs');
  const trail = []; const findings = []; const refusalsSeen = new Map(); const ran = new Set(); const written = new Set();
  const retriedTurns = new Set();
  const startMark = storyMark(story);
  const stuck = () => [...refusalsSeen.values()].some((count) => count >= 3);
  const finding = (kind, code, detail = null) => {
    if (!findings.some((entry) => entry.kind === kind && entry.code === code)) findings.push({ kind, code, ...(detail ? { detail } : {}) });
  };
  const phase = () => scenario.phase ?? 'implementation';
  // A person fills what a route leaves open: an optional part stays out, `<a|b>` takes their choice.
  const fill = (command) => command.replace(/\s*\[[^\]]*<[^\]]*\]/gu, '').replace(/<([^>]+)>/gu, (whole, name) => {
    const answer = name.includes('|') && name.split('|').includes(scenario.answers?.choice) ? scenario.answers.choice : scenario.answers?.[name];
    return answer === undefined ? whole : /\s/u.test(answer) ? `"${answer}"` : answer;
  });
  const writeFor = async (key) => {
    const files = scenario.writes?.[key];
    if (!files || written.has(key)) return;
    written.add(key);
    // A file's contents, or what the author makes of it as it is then (a summary that names a change).
    for (const [relative, contents] of Object.entries(files)) await story.write(relative, typeof contents === 'function' ? await contents(story) : contents);
    trail.push({ wrote: Object.keys(files), for: key });
  };
  const runCommand = (command, { person = false } = {}) => {
    const filled = fill(command);
    const argv = argvOf(filled);
    // Every command accepts these, and only their output carries `act`.
    for (const flag of ['--for-agent', '--json']) if (!argv.includes(flag)) argv.push(flag);
    if (person) for (const flag of scenario.personFlags ?? []) if (!argv.includes(flag)) argv.push(flag);
    const output = spawn(process.execPath, [CLI, '--no-model', ...argv], story.root, story.env ?? {});
    let parsed = parseOutput(output.stdout);
    reads.push(...namedReads(parsed).map((read) => ({ ...read, command: filled })));
    if (parsed) { try { parsed = completeAgentResult(parsed); } catch { /* the view is what it returned */ } }
    return { output, parsed, filled };
  };
  const guardCall = ({ prompt, toolName = 'bash', toolArgs, answered = null, sessionId = `walk-${scenario.id}` }) => {
    const hook = (event, payload) => {
      const result = spawnSync(process.execPath, [CLI, 'hook', event], { cwd: story.root, encoding: 'utf8', input: JSON.stringify(payload), timeout: childTimeout(60_000),
        env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: IDENTITY,
          SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(story.root, '.git', 'test-active-workspace.json'),
          SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(story.root, '.git', 'test-workspaces.json'),
          SINGULARITY_FLOW_STORY_INDEX: path.join(story.root, '.git', 'test-story-index.json') } });
      return JSON.parse(result.stdout || '{}');
    };
    hook('boundary-turn', { cwd: story.root, sessionId, prompt });
    // The person's own answer, as Copilot CLI and VS Code's agent host hand a question's result to the post-tool hook.
    if (answered !== null) {
      const question = { cwd: story.root, sessionId, toolName: 'ask_user', toolArgs: { question: 'Your answer?' } };
      hook('boundary-guard', question);
      hook('boundary-after', { ...question, toolResult: { textResultForLlm: `User responded: ${answered}`, resultType: 'success' } });
    }
    return hook('boundary-guard', { cwd: story.root, sessionId, toolName, toolArgs: { ...toolArgs, cwd: story.root } });
  };

  // A refusal's duties, whichever way it arrived: the reason must be true, a route must exist, and
  // it may not be only reads unless it names who decides.
  const onRefusal = (code, message, routes, result, state) => {
    const pair = `${code}|${state}`;
    if (refusalsSeen.has(pair)) finding('loop', code, 'the same refusal again, on an unchanged state');
    refusalsSeen.set(pair, (refusalsSeen.get(pair) ?? 0) + 1);
    const check = scenario.reasons?.[code];
    if (check && ((check.mustMatch && !check.mustMatch.test(message)) || (check.mustNotMatch?.test(message)))) finding('false-reason', code, check.because);
    const followable = routes.filter((route) => route.command || route.skill);
    const namesPerson = ['ask-person', 'await-human', 'confirm', 'escalate'].includes(result?.act?.state)
      || followable.some((route) => routeEffect(route, isRead) === 'person-decision');
    if (!followable.length && !namesPerson) finding('no-route', code);
    // The refused command itself, corrected, is the way through, even where that command only reads.
    else if (!namesPerson && followable.every((route) => routeEffect(route, isRead) === 'read-only' && !(scenario.start && route.command && commandWords(route.command).join(' ') === commandWords(scenario.start).join(' ')))) finding('read-only-route', code, followable.map((route) => route.skill ?? route.command.split(' ').slice(0, 3).join(' ')).join(', '));
  };

  let lastCode = null;
  // A guard names its routes in next[] and in its reason's Copilot and Shell lines.
  const guardRoutes = (answer) => {
    const returned = returnedRoutes(answer);
    const lines = lineRoutes(answer.permissionDecisionReason ?? '', 'reason').filter((line) => !returned.some((entry) => entry.command === line.command || entry.skill === line.skill));
    return [...returned, ...lines].map((entry) => ({ ...entry, fromGuard: true }));
  };
  // Set when what the scenario tried is refused, so it gets one more try if the state changes under it.
  let startRefusedAt = null;
  const stack = [];
  // The route SFlow puts first goes next; the others wait their turn, so no read crowds out a way through.
  const pushRoutes = (routes) => { const [first, ...rest] = routes; stack.push(...rest); if (first) stack.unshift(first); };
  // The person's decision is the end of what the bot may do, so it is checked by running it as them.
  const personRoute = (route, code, state) => {
    const skillName = route.skill ? route.skill.split(/\s+/u)[0] : null;
    const command = route.command ?? (skillName ? skillNamedCommands(route.skill, { phase: phase() })[0] : null);
    // A value no script gives is a gap in the scenario, not in the route.
    if (!command || /<[^>]+>/u.test(fill(command))) { trail.push({ skipped: command ?? route.skill, because: 'it needs a value no script gives' }); return false; }
    const { output, parsed, filled } = runCommand(command, { person: true });
    const refused = output.status !== 0;
    trail.push({ person: filled.replace(/^singularity-flow /u, '').replaceAll(' --for-agent', '').replaceAll(' --json', ''), status: output.status, code: parsed?.error?.code ?? null });
    if (refused) {
      const own = parsed?.error?.code ?? code ?? 'none';
      lastCode = own;
      if (route.source === 'start' || route.source === 'retry') startRefusedAt = state;
      // The scenario's own start is what the person tried; a route the walk was given has to work.
      if (route.source !== 'start') finding('person-route-refused', own, filled.split(' ').slice(0, 3).join(' '));
      const routes = parsed ? returnedRoutes(parsed) : lineRoutes(output.stdout, 'lines');
      onRefusal(own, String(parsed?.error?.message ?? output.stderr), routes, parsed, state);
      pushRoutes(routes);
      return false;
    }
    // A decisions list with nothing open decides nothing.
    if (/\bdecisions\b/u.test(filled) && /nothing waiting/u.test(String(parsed?.act?.said ?? ''))) { finding('person-route-empty', code ?? 'none'); return false; }
    return true;
  };

  if (scenario.guard) {
    const state = stateKey(story);
    const answer = guardCall(scenario.guard);
    const code = guardCode(answer);
    trail.push({ guard: scenario.guard.toolName ?? 'bash', code });
    if (!code) return { outcome: 'allowed', findings, trail };
    lastCode = code;
    const routes = guardRoutes(answer);
    onRefusal(code, String(answer.permissionDecisionReason), routes, answer, state);
    pushRoutes(routes);
  } else stack.push({ command: scenario.start, skill: null, source: 'start' });

  let steps = 0;
  while (steps < maxSteps && !stuck()) {
    // Once every route is followed, what was refused gets one more try if the state changed under it.
    if (!stack.length && scenario.start && startRefusedAt && startRefusedAt !== stateKey(story)) { startRefusedAt = null; stack.push({ command: scenario.start, skill: null, source: 'retry' }); ran.clear(); }
    if (!stack.length) break;
    const route = stack.shift();
    const key = `${route.command ?? ''}|${route.skill ?? ''}`;
    const state = stateKey(story);
    if (ran.has(`${key}|${state}`)) continue;
    ran.add(`${key}|${state}`);
    const effect = routeEffect(route, isRead);
    if (effect === 'gives-up') { trail.push({ skipped: route.skill ?? route.command.split(' ').slice(0, 2).join(' '), because: 'ending the work is no way through' }); continue; }
    steps += 1;
    // A refused call's own route: does the turn it names allow the call?
    if (route.fromGuard && route.skill && !retriedTurns.has(route.skill)) {
      retriedTurns.add(route.skill);
      const answer = guardCall({ ...scenario.guard, prompt: route.skill, sessionId: `walk-${scenario.id}-${retriedTurns.size}` });
      const code = guardCode(answer);
      trail.push({ guard: scenario.guard.toolName ?? 'bash', turn: route.skill, code });
      if (!code) return { outcome: 'reached', by: route.skill, findings, trail };
      onRefusal(code, String(answer.permissionDecisionReason), guardRoutes(answer), answer, state);
    }
    if (effect === 'person-decision') {
      if (personRoute(route, lastCode, state)) return { outcome: 'person-decision', by: route.skill ?? route.command, findings, trail };
      continue;
    }
    if (route.skill) await writeFor(route.skill.split(/\s+/u)[0]);
    // A skill route the bot enters by the command that skill names; a returned shell form goes first.
    const named = route.command ? [route.command] : skillNamedCommands(route.skill, { phase: phase() });
    // A code turn enters, authors what the script gives it, and checks with the command the skill names.
    const commands = route.command ? named : named.filter((command, index) => index === 0 || /phase prepublish .*--publish-if-ready/u.test(command) && route.skill.startsWith('/sf-code'));
    if (!commands.length) { trail.push({ skill: route.skill, skipped: 'names no command the bot can run' }); continue; }
    for (const command of commands) {
      if (/<[^>]+>/u.test(fill(command))) { trail.push({ skipped: command, because: 'it needs a value no script gives' }); continue; }
      const before = stateKey(story);
      const { output, parsed, filled } = runCommand(command);
      const code = parsed?.error?.code ?? parsed?.code ?? (parsed?.act?.state === 'refused' ? 'REFUSED' : null);
      const refused = output.status !== 0;
      trail.push({ run: filled.replace(/^singularity-flow /u, '').replaceAll(' --for-agent', '').replaceAll(' --json', ''), status: output.status, code, act: parsed?.act?.state ?? null });
      if (output.status === 0 && scenario.reached?.(parsed, story)) return { outcome: 'reached', findings, trail };
      if (storyMark(story) !== startMark) {
        finding('goal-lost', lastCode ?? 'none', 'a route moved the Story on without what was asked');
        return { outcome: 'dead-end', findings, trail };
      }
      const routes = parsed ? returnedRoutes(parsed) : lineRoutes(output.stdout, 'lines');
      if (refused) {
        lastCode = code ?? 'NO_CODE';
        if (route.source === 'start' || route.source === 'retry') startRefusedAt = before;
        await writeFor(lastCode);
        onRefusal(lastCode, String(parsed?.error?.message ?? output.stderr), routes, parsed, before);
      }
      pushRoutes(routes);
    }
  }
  if (steps >= maxSteps && !findings.length) finding('over-budget', lastCode ?? 'none', `${maxSteps} steps`);
  else finding('exhausted', lastCode ?? 'none', 'every returned route was followed and the outcome was not reached');
  return { outcome: 'dead-end', findings, trail };
}

/**
 * A spec-driven Story at its Release, drafted: Verification reused Implementation's run on the same source
 * tree, and the report says `verdict` of every clause, citing that run.
 */
export async function releaseDraftTemplate(t, { verdict = 'matched' } = {}) {
  const { storyAtVerification, writeVerificationEvidence } = await import('./story-to-verification.mjs');
  const story = await storyAtVerification(t, WORK);
  const { cli, item, root } = story;
  await writeVerificationEvidence(story);
  cli('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'verification');
  cli('approve', 'verification', '--yes');
  cli('prepare', 'release');
  const report = path.join(item, 'artifacts/release/conformance.md');
  const sample = `| \`${WORK}:REQ-001\` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |`;
  await mkdir(path.join(item, 'artifacts/release/verification'), { recursive: true });
  await writeFile(path.join(item, 'artifacts/release/verification/evidence-index.md'), `# Release verification evidence index — ${WORK}\n\nVerification generation 1 is approved, and it reused the run Implementation recorded on this same source tree.\n`);
  await writeFile(report, (await readFile(report, 'utf8')).replace(sample, story.clauses.map((clause) => `| \`${clause}\` | \`test/value.test.mjs\`, the run reused on this source tree | ${verdict} |`).join('\n'))
    .replace(/TODO:[^\n]*/gu, `Compared ${story.clauses.join(' and ')} against the recorded run.`).replace(/\bTODO\b/gu, 'none'));
  cli('artifact', 'scan', '--phase', 'release');
  return { parent: story.directory, root, item: path.relative(root, item), cli };
}

/**
 * A spec-driven Story whose code is approved and whose convergence is prepared with items open: the
 * plan has a requirement the code never claimed. Coverage only records here, as a person decides it.
 */
export async function openConvergenceTemplate(t, { configure = null } = {}) {
  const { approvedSpecificationStory, implementationPlan } = await import('./submitted-planning-story.mjs');
  const { directory, root, cli, item } = await approvedSpecificationStory(t, WORK, {
    configure: (configuration) => { configuration.workTypes['spec-driven-standard'].spec.coverage = 'record'; configure?.(configuration); } });
  const { write } = helpers(root);
  cli('prepare', 'planning');
  // The plan binds the second requirement to a test nobody delivers: the question convergence asks.
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK)
    .replace(`| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/second.test.mjs\` |`));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${WORK}:AC-001 returns the approved value to its callers\n// @clause:${WORK}:REQ-002 marks where the second requirement lands, with no test of its own yet\nexport const value = 1;\n`);
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,1));\n`);
  await write(`singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`, [
    '# Implementation summary', '', '## Agent brief', '', 'Added the value module. The second requirement is not claimed yet, which convergence asks about.', '',
    '## Changed components and decisions', '', '- `src/value.mjs`: exports the approved value.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n'));
  await write(`singularity/work-items/${WORK}/artifacts/implementation/operator-notes.md`, ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation'); cli('approve', 'implementation', '--yes');
  cli('prepare', 'convergence');
  return { parent: directory, root, item: path.relative(root, item), cli };
}

/**
 * SPEC-CIC switch 1 [CIC:REQ-021]: an amendment kept an approved design whose prompt held the changed clause, so its
 * approvers are asked whether it still holds; the code step reads the design and completes at its submission, which
 * therefore waits for their answer. The Story is left with the code step republished on the amended scope.
 */
export async function stillHoldsTemplate(t) {
  const parent = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-walk-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repository');
  const remote = path.join(parent, 'origin.git');
  await mkdir(root);
  const { must, git, cli, write } = helpers(root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', IDENTITY); git('config', 'user.email', 'route-walker@example.test');
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\ntest('value', () => assert.equal(value,1));\n");
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off'; config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  delete config.phases['fix-design'].clarification;
  config.spec = { ...config.spec, observedDependencies: 'on' };
  const quick = config.workTypes['quick-fix'];
  config.workTypes['quick-design'] = { ...quick, phases: ['intake', 'fix-design', 'implement', 'verify'], sourceReview: { mode: 'off' },
    phaseOverrides: { ...quick.phaseOverrides, implement: { inputs: ['intake', 'fix-design'] } } };
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.'); git('commit', '-qm', 'Initialize the walker fixture');
  must('git', ['init', '-q', '--bare', '-b', 'main', remote]); git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Use a value', '--description', 'Return 2.');
  const item = `singularity/work-items/${WORK}`;
  const intake = (outcome) => [`# ${WORK} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${WORK}:AC-001] | ${outcome} |`, `| [${WORK}:AC-002] | The value module stays a single export. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
    `| \`${WORK}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  const code = async () => {
    await write('src/value.mjs', `// @clause:${WORK}:AC-001 the exported value is the number 2\n// @clause:${WORK}:AC-002 the single export stays\nexport const value = 2;\n`);
    await write('test/value.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n"
      + `// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,2));\n// @ac:${WORK}:AC-002\ntest('one export', async () => assert.deepEqual(Object.keys(await import('../src/value.mjs')), ['value']));\n`);
  };
  cli('prepare', 'intake'); cli('phase', 'enter', 'intake', '--compose', '--json');
  await write(`${item}/artifacts/intake/intake.md`, intake('The exported value equals 2.'));
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'); cli('submit', 'intake'); cli('approve', 'intake', '--yes');
  cli('prepare', 'fix-design'); cli('phase', 'enter', 'fix-design', '--compose', '--json');
  await write(`${item}/artifacts/fix-design/fix-design.md`, [`# ${WORK} — Fix Design`, '', '## Root cause', '', 'The exported constant holds the old value; nothing computes it.', '',
    '## Minimal safe change', '', `Change the one literal that holds the value. ${WORK}:AC-002 keeps the module to a single export, so no import changes.`, '',
    '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
  cli('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place'); cli('submit', 'fix-design'); cli('approve', 'fix-design', '--yes');
  cli('phase', 'begin', 'implement', '--json'); await code(); cli('prepare', 'implement'); cli('phase', 'publish', 'implement', '--authored', 'deterministic');
  const amended = path.join(parent, 'amended.md');
  await writeFile(amended, intake('The exported value equals 2 and is a number.'));
  cli('story', 'intent-amendment', 'propose', '--file', amended, '--reason', 'Say the value is numeric.');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  cli('resume', WORK); cli('phase', 'begin', 'implement', '--json'); await code(); cli('prepare', 'implement');
  cli('phase', 'publish', 'implement', '--authored', 'deterministic');
  return { parent, root, item, cli };
}

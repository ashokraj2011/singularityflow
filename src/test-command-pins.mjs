/**
 * Test command pins [TCE:REQ-010].
 *
 * A test command Singularity Flow guessed for a module is recomputed at every publication, so an
 * agent could edit the package script behind it (`"test": "jest src/one"`) and the gate would run
 * the narrower suite. Now the first gate run of a command pins it for the Story: its argv, working
 * directory, affected roots, result adapter and `definition`, the digests of the package script
 * chain and the runner configuration it resolves through [TCE:REQ-011]. Configured and
 * Story-decision commands record their definition the same way, so an edited script behind
 * `npm test` is caught too [TCE:REQ-013].
 *
 * A later gate run whose command differs from its pin is refused before it runs
 * (TEST_COMMAND_PIN_CHANGED), naming what changed [TCE:REQ-012]. Anyone may request the new pin
 * (`decision test-command [WORK-ID] --phase P --repin ID`); a person who approves the step accepts
 * it, and the next gate run records the accepted pin in place of the old one. A pin is recorded on
 * the Story when its gate commits (publication or submission); until then the step's first recorded
 * run of the command stands for it, so a refused first run cannot be followed by a quiet edit. Each
 * attempt carries the pin it ran under, and receipt replay checks that pin is the Story's
 * [TCE:REQ-014]. Pins are kept in `workflow.testCommandPins`, append-only apart from the baseline a
 * pin gains at its first passing run. The gate also gathers here what narrows each run before it
 * runs (src/test-narrowing.mjs), from the same script texts.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { storyTestCommandState } from './story-test-commands.mjs';
import { SingularityFlowError } from './util.mjs';

const MAX_SCRIPTS = 64;
const MAX_CONFIG_BYTES = 1024 * 1024;
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const NODE_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'karma', 'ng', 'react-scripts']);
const PYTHON_RUNNERS = new Set(['python', 'python3', 'py', 'pytest', 'py.test', 'tox', 'nox', 'uv', 'poetry', 'hatch']);
// Runner configuration a Node module's tests resolve through, wherever its scripts point.
const NODE_RUNNER_CONFIG = /^(?:(?:jest|vitest|vite|playwright|cypress|karma)\.(?:config|conf)\.[cm]?[jt]s|jest\.config\.json|vitest\.workspace\.(?:[cm]?[jt]s|json)|\.mocharc\.(?:[cm]?js|jsonc?|ya?ml))$/u;
const PACKAGE_RUNNER_KEYS = ['jest', 'mocha', 'ava'];
// Option flags of npm, pnpm, yarn and bun that take a value before the script verb.
const VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '-w', '--workspace', '--filter', '-F', '--cwd']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// Line endings are a checkout's choice (core.autocrlf), never a change to what runs.
const textSha256 = (text) => sha256(String(text).replace(/\r\n?/gu, '\n'));

/** A launcher as one name: `.\mvnw.cmd`, `node_modules/.bin/jest` and `pnpm.exe` read as mvnw, jest, pnpm. */
export function launcherName(value) {
  return path.posix.basename(String(value ?? '').replaceAll('\\', '/')).toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/u, '');
}

/**
 * Argv as one platform reads it, so a Story worked on Windows and macOS keeps one pin: the wrapper
 * and launcher spellings inference chooses per platform (`.\mvnw.cmd`, `py -3`, `Scripts\python.exe`).
 */
export function portableArgv(argv) {
  const values = (argv ?? []).map(String);
  if (!values.length) return values;
  values[0] = values[0].replaceAll('\\', '/').replace(/\.(?:cmd|bat|exe)$/iu, '').replace(/(^|\/)Scripts\/python$/u, '$1bin/python');
  if (values[0] === 'py' && values[1] === '-3') values.splice(0, 2, 'python3');
  return values;
}

/** The package script an npm, pnpm, yarn or bun invocation runs, or null (`bun test` is bun's own runner). */
export function packageScriptName(tokens) {
  const [first, ...rest] = tokens ?? [];
  const runner = launcherName(first);
  if (!SCRIPT_RUNNERS.has(runner)) return null;
  const skipFlags = (index) => {
    let at = index;
    while (at < rest.length && rest[at].startsWith('-') && rest[at] !== '--') at += VALUE_FLAGS.has(rest[at]) ? 2 : 1;
    return at;
  };
  const at = skipFlags(0);
  const verb = rest[at];
  if (!verb || verb === '--') return null;
  if (['test', 't', 'tst'].includes(verb)) return runner === 'bun' ? null : 'test';
  if (['run', 'run-script', 'rum', 'urn'].includes(verb)) return rest[skipFlags(at + 1)] ?? null;
  if (runner === 'npm' || ['exec', 'dlx', 'x', 'install', 'add', 'ci'].includes(verb)) return null;
  return verb;
}

/** Split shell text into its commands (`&&`, `||`, `;`, `|`), each as tokens without quotes. */
export function shellSegments(text) {
  return String(text ?? '').split(/&&|\|\||[;|\n]/u)
    .map((segment) => (segment.match(/"[^"]*"|'[^']*'|\S+/gu) ?? []).map((token) => token.replace(/^(["'])([\s\S]*)\1$/u, '$2')))
    .filter((tokens) => tokens.length);
}

/** A segment without its leading `NAME=value` assignments and `cross-env`/`dotenv` wrappers. */
export function commandTokens(tokens) {
  let at = 0;
  while (at < tokens.length) {
    const name = launcherName(tokens[at]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[at]) || ['cross-env', 'env', 'dotenv'].includes(name) || tokens[at] === '--') at += 1;
    else break;
  }
  return tokens.slice(at);
}

/** The scripts one script text runs: `npm run X`, `yarn X`, `pnpm X`, and `run-s`/`run-p`/`npm-run-all` names. */
function scriptReferences(text, scripts) {
  const names = [];
  for (const segment of shellSegments(text)) {
    const tokens = commandTokens(segment);
    const named = packageScriptName(tokens);
    if (named) names.push(named);
    if (['run-s', 'run-p', 'npm-run-all'].includes(launcherName(tokens[0]))) {
      for (const pattern of tokens.slice(1).filter((token) => !token.startsWith('-'))) {
        // npm-run-all globs (`test:*`) name every matching script.
        const matcher = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^:]*')}$`, 'u');
        names.push(...Object.keys(scripts).filter((name) => matcher.test(name)));
      }
    }
  }
  return names;
}

/** The scripts `name` runs, in order: its pre and post scripts and every script it references. */
export function packageScriptChain(scripts, name) {
  const chain = [];
  const seen = new Set();
  const visit = (script, depth) => {
    for (const candidate of [`pre${script}`, script, `post${script}`]) {
      if (seen.has(candidate) || chain.length >= MAX_SCRIPTS || typeof scripts?.[candidate] !== 'string') continue;
      seen.add(candidate);
      chain.push({ name: candidate, text: scripts[candidate] });
      if (depth < 8) for (const reference of scriptReferences(scripts[candidate], scripts)) visit(reference, depth + 1);
    }
  };
  visit(name, 0);
  return chain;
}

async function readText(root, relative) {
  try { return (await readRepositoryManifest(root, relative, { maxBytes: MAX_CONFIG_BYTES })).bytes.toString('utf8'); }
  catch { return null; }
}

const join = (directory, name) => (directory === '.' || !directory ? name : path.posix.join(directory, name));

/** The lines of one INI or TOML section whose header starts with `header`, or null. */
function iniSection(text, header) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*\[/u.test(line)) inside = line.trim().toLowerCase().startsWith(header);
    if (inside) kept.push(line);
  }
  return kept.length ? kept.join('\n') : null;
}

/** The surefire and failsafe plugin blocks of a POM and its test-selection properties. */
function mavenTestConfiguration(pom) {
  const text = String(pom ?? '').replace(/<!--[\s\S]*?-->/gu, '');
  const plugins = [...text.matchAll(/<plugin>[\s\S]*?<\/plugin>/gu)].map((match) => match[0])
    .filter((block) => /<artifactId>\s*maven-(?:surefire|failsafe)-plugin\s*<\/artifactId>/u.test(block))
    .map((block) => block.replace(/\s+/gu, ' ').trim());
  const properties = [...text.matchAll(/<(skipTests|skipITs|test|it\.test|groups|excludedGroups|maven\.test\.[\w.]+|surefire\.[\w.]+|failsafe\.[\w.]+)>([\s\S]*?)<\/\1>/gu)]
    .map((match) => `${match[1]}=${match[2].trim()}`);
  return plugins.length || properties.length ? [...plugins, ...properties].join('\n') : null;
}

/** The `test` task blocks of a Gradle build script. */
function gradleTestConfiguration(build) {
  const text = String(build ?? '');
  const blocks = [];
  const start = /(?:^|\n)[ \t]*(?:tasks\s*\.\s*)?(?:test|named\s*(?:<Test>)?\s*\(\s*["']test["']\s*\)|withType\s*(?:<Test>|\(\s*Test(?:::class(?:\.java)?)?\s*\)))\s*(?:\.configure\s*)?\{/gu;
  for (const match of text.matchAll(start)) {
    let depth = 0;
    const open = match.index + match[0].length - 1;
    for (let at = open; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}' && --depth === 0) { blocks.push(text.slice(match.index, at + 1).trim()); break; }
    }
  }
  return blocks.length ? blocks.join('\n') : null;
}

/**
 * What a command resolves through [TCE:REQ-011]: each file and selector with its sha256, sorted,
 * and the script texts it runs (read by the narrowed-run check, never stored).
 */
export async function commandDefinition(root, command) {
  const directory = command.workingDirectory ?? '.';
  const argv = (command.argv ?? []).map(String);
  const launcher = launcherName(argv[0]);
  const entries = [];
  const scripts = [];
  const add = (relative, selector, text) => { if (text != null) entries.push({ path: relative, selector, sha256: textSha256(text) }); };
  const whole = async (relative) => add(relative, null, await readText(root, relative));
  if (SCRIPT_RUNNERS.has(launcher) || NODE_RUNNERS.has(launcher)) {
    const manifestPath = join(directory, 'package.json');
    const manifestText = await readText(root, manifestPath);
    let manifest = null;
    try { manifest = manifestText ? JSON.parse(manifestText) : null; } catch { manifest = null; }
    const name = packageScriptName(argv);
    if (manifest && name) {
      for (const script of packageScriptChain(manifest.scripts ?? {}, name)) {
        add(manifestPath, `scripts.${script.name}`, script.text);
        scripts.push({ source: `${manifestPath}#scripts.${script.name}`, text: script.text });
      }
    }
    for (const key of PACKAGE_RUNNER_KEYS) if (manifest?.[key] !== undefined) add(manifestPath, key, canonicalJson(manifest[key]));
    let names = [];
    try { names = await readdir(path.join(root, directory)); } catch { names = []; }
    for (const file of names.filter((entry) => NODE_RUNNER_CONFIG.test(entry)).sort()) await whole(join(directory, file));
  } else if (['mvn', 'mvnw'].includes(launcher)) {
    const modules = argv.flatMap((value, index) => (['-pl', '--projects'].includes(argv[index - 1]) ? value.split(',') : []))
      .filter((value) => value && !value.startsWith(':') && !value.startsWith('!'));
    for (const module of ['.', ...modules]) {
      const pom = join(module === '.' ? directory : join(directory, module), 'pom.xml');
      add(pom, 'test-plugins', mavenTestConfiguration(await readText(root, pom)));
    }
    await whole(join(directory, '.mvn/maven.config'));
  } else if (['gradle', 'gradlew'].includes(launcher)) {
    const project = argv.find((_, index) => ['-p', '--project-dir'].includes(argv[index - 1]));
    const base = project ? join(directory, project) : directory;
    for (const file of ['build.gradle', 'build.gradle.kts']) add(join(base, file), 'test-tasks', gradleTestConfiguration(await readText(root, join(base, file))));
  } else if (PYTHON_RUNNERS.has(launcher)) {
    await whole(join(directory, 'pytest.ini'));
    await whole(join(directory, 'conftest.py'));
    add(join(directory, 'pyproject.toml'), 'tool.pytest', iniSection(await readText(root, join(directory, 'pyproject.toml')), '[tool.pytest'));
    add(join(directory, 'setup.cfg'), 'tool:pytest', iniSection(await readText(root, join(directory, 'setup.cfg')), '[tool:pytest]'));
    add(join(directory, 'tox.ini'), 'pytest', iniSection(await readText(root, join(directory, 'tox.ini')), '[pytest]'));
  }
  // A repository script the command runs (`./scripts/test.sh`, `bash scripts/test.sh`, `node run-tests.mjs`).
  const scriptFile = ['bash', 'sh', 'zsh', 'node'].includes(launcher) ? argv.slice(1).find((value) => !value.startsWith('-')) : argv[0];
  if (scriptFile && /[/\\]|\.(?:sh|mjs|cjs|js|py|ps1)$/u.test(scriptFile) && !['mvnw', 'gradlew'].includes(launcher)
      && !path.posix.isAbsolute(scriptFile.replaceAll('\\', '/')) && !scriptFile.replaceAll('\\', '/').split('/').includes('..')) {
    await whole(join(directory, scriptFile.replaceAll('\\', '/').replace(/^\.\//u, '')));
  }
  const key = (entry) => `${entry.path}\u0000${entry.selector ?? ''}`;
  const unique = [...new Map(entries.map((entry) => [key(entry), entry])).values()].sort((left, right) => key(left).localeCompare(key(right)));
  return { entries: unique, scripts };
}

/** Where a gate's command comes from, as its pin names it: guessed, configured, or a Story decision. */
export function pinSource(phase, command) {
  const decided = (phase?.storyTestCommands ?? []).find((entry) => entry?.id === command.id && entry.storyDecision);
  if (command.provenance === 'story-decision' && decided) {
    return { kind: 'story-decision', decision: decided.storyDecision.id, recordSha256: decided.storyDecision.sha256 };
  }
  const configured = (phase?.qualityCommands ?? []).find((entry) => entry && typeof entry === 'object' && entry.id === command.id);
  if (command.provenance === 'configured' && configured) return { kind: 'configured', recordSha256: `sha256:${recordSha256(configured)}` };
  return { kind: 'inferred' };
}

/** Pins of one source are compared with each other; a person's newer source starts a new pin. */
export function pinSourceKey(source) {
  if (source?.kind === 'story-decision') return `story-decision:${source.decision}`;
  if (source?.kind === 'configured') return `configured:${source.recordSha256}`;
  return 'inferred';
}

/** The pin a gate run of `command` would record, identified by the digest of everything it pins. */
export function pinCandidate(phase, command, definition) {
  const identity = {
    commandId: command.id, source: pinSource(phase, command), argv: portableArgv(command.argv),
    workingDirectory: command.workingDirectory ?? '.', affectedRoots: [...(command.affectedRoots ?? [])].sort(),
    adapter: command.result?.adapter ?? null, definition
  };
  return { ...identity, sha256: `sha256:${recordSha256(identity)}` };
}

const pinIdentity = ({ commandId, source, argv, workingDirectory, affectedRoots, adapter, definition, sha256: digest }) =>
  ({ commandId, source, argv, workingDirectory, affectedRoots, adapter, definition, sha256: digest });

/** The Story's latest recorded pin of this command and source, or null. */
export function storyPin(workflow, candidate) {
  const key = pinSourceKey(candidate.source);
  return (workflow?.testCommandPins ?? []).filter((pin) => pin.commandId === candidate.commandId && pinSourceKey(pin.source) === key).at(-1) ?? null;
}

/** The pin a gate run is compared with: the Story's, else the step's first recorded run of it. */
export function referencePin(workflow, candidate, attempts = []) {
  const recorded = storyPin(workflow, candidate);
  if (recorded) return recorded;
  const key = pinSourceKey(candidate.source);
  return attempts.find((attempt) => attempt.commandId === candidate.commandId && attempt.purpose !== 'local'
    && attempt.pin?.sha256 && pinSourceKey(attempt.pin.source) === key)?.pin ?? null;
}

/** The accepted re-pin request that admits exactly this pin and no recorded pin has used yet. */
export function acceptedRepin(workflow, candidate) {
  const used = new Set((workflow?.testCommandPins ?? []).map((pin) => pin.acceptedBy).filter(Boolean));
  return (workflow?.testCommandDecisions ?? []).find((entry) => entry.id && entry.repin?.commandId === candidate.commandId
    && entry.repin.sha256 === candidate.sha256 && !used.has(entry.id)
    && storyTestCommandState(workflow, entry.id)?.state === 'accepted')?.id ?? null;
}

/** What differs between a pin and a candidate: argv, directory, roots, adapter, and each definition entry. */
export function pinChanges(pinned, candidate) {
  const changes = [];
  for (const field of ['argv', 'workingDirectory', 'affectedRoots', 'adapter']) {
    if (canonicalJson(pinned[field] ?? null) !== canonicalJson(candidate[field] ?? null)) changes.push({ field, pinned: pinned[field] ?? null, now: candidate[field] ?? null });
  }
  const key = (entry) => `${entry.path}#${entry.selector ?? ''}`;
  const before = new Map((pinned.definition ?? []).map((entry) => [key(entry), entry]));
  const after = new Map((candidate.definition ?? []).map((entry) => [key(entry), entry]));
  for (const [name, entry] of after) {
    const was = before.get(name);
    if (!was || was.sha256 !== entry.sha256) changes.push({ field: 'definition', path: entry.path, selector: entry.selector ?? null, change: was ? 'changed' : 'added' });
  }
  for (const [name, entry] of before) if (!after.has(name)) changes.push({ field: 'definition', path: entry.path, selector: entry.selector ?? null, change: 'removed' });
  return changes;
}

/** One change in words: "argv [npm, test] → [npm, test, --, --json]", "package.json scripts.test changed". */
export function pinChangeWords(change) {
  if (change.field === 'definition') return `${change.path}${change.selector ? ` ${change.selector}` : ''} ${change.change}`;
  const show = (value) => (Array.isArray(value) ? JSON.stringify(value) : String(value));
  return `${change.field} ${show(change.pinned)} → ${show(change.now)}`;
}

/** The request a refusal names: anyone may make it; a person who approves the step accepts it. */
export function repinRequestCommand(workflow, phaseId, commandId) {
  return `singularity-flow decision test-command ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId} --repin ${commandId} --reason "<why the test command changed>"`;
}

function pinChangedError(workflow, phase, pinned, candidate) {
  const changes = pinChanges(pinned, candidate).map(pinChangeWords);
  const workId = workflow?.workItem?.id ?? null;
  const command = repinRequestCommand(workflow, phase.id, candidate.commandId);
  const restore = [...new Set(pinChanges(pinned, candidate).filter((change) => change.field === 'definition').map((change) => change.path))];
  const restoreWords = restore.length ? `Or restore ${restore.join(', ')} as pinned.` : 'Or restore the module as pinned.';
  return new SingularityFlowError(
    `Test command '${candidate.commandId}' changed since it was pinned for this Story${pinned.id ? ` (${pinned.id})` : ''}: `
      + `${changes.join('; ')}. A changed test command is decided by a person who approves ${phase.id}: request it with ${command}, `
      + `and they accept it (/sf-decide ${workId ?? '<WORK-ID>'}); an agent never accepts it. ${restoreWords}`,
    { code: 'TEST_COMMAND_PIN_CHANGED', details: {
      workId, phase: phase.id,
      testCommandPin: { phase: phase.id, commandId: candidate.commandId, pin: pinned.id ?? null, changes, command },
      // The refusal's own route, which every surface renders: anyone requests, a person who approves accepts.
      nextAction: { command, label: `Request the new pin, saying why the test command changed; a person who approves ${phase.id} accepts it `
        + `from the decision list (/sf-decide ${workId ?? '<WORK-ID>'}), and an agent never accepts it. ${restoreWords}` }
    } }
  );
}

/** The first passing gate run of a pin in this step, the narrowed-run check's baseline. */
function firstPassingRun(attempts, sha) {
  const attempt = attempts.find((entry) => entry.purpose !== 'local' && entry.pin?.sha256 === sha
    && entry.status === 'passed' && Number.isInteger(entry.tests?.discovered));
  return attempt ? { discovered: attempt.tests.discovered, skipped: Number(attempt.tests.skipped) || 0, attemptId: attempt.attemptId } : null;
}

/** The recorded runs of one step, oldest first, that pins and baselines are read from. */
async function recordedRuns(root, config, workflow, phase) {
  const [{ stepAttempts }, { workDirRelative }] = await Promise.all([import('./verification/attempts.mjs'), import('./story-paths.mjs')]);
  return stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
}

/**
 * Check every test command a gate is about to run against its pin, before anything runs (the
 * candidate's `deliveryEvidence` names the changed test files it reads for focused tests); refuses
 * TEST_COMMAND_PIN_CHANGED for the first that changed with no accepted re-pin. Returns, per
 * command ID, the candidate pin (each attempt carries it) and how it stands, and `record`, which
 * the gate calls once it passed to write the pins of the commands that ran onto the Story.
 */
export async function gateTestCommandPins(root, config, workflow, phase, commands, deliveryEvidence = null) {
  const testPaths = deliveryEvidence?.testPaths ?? [];
  // What the Story changed is measured against its base: narrowing already there is the team's own [TCE:REQ-021].
  const baseCommit = deliveryEvidence?.changeSet?.base?.commit ?? phase.generationIntent?.baseline?.commit
    ?? workflow.workIntervals?.current?.sourceBaseCommit ?? null;
  const attempts = await recordedRuns(root, config, workflow, phase);
  const { gateNarrowing, narrowingFacts, skippedByAgreement } = await import('./test-narrowing.mjs');
  const prepared = new Map();
  for (const command of commands) {
    const { entries, scripts } = await commandDefinition(root, command);
    const candidate = pinCandidate(phase, command, entries);
    const reference = referencePin(workflow, candidate, attempts);
    const acceptedBy = reference && reference.sha256 !== candidate.sha256 ? acceptedRepin(workflow, candidate) : null;
    if (reference && reference.sha256 !== candidate.sha256 && !acceptedBy) throw pinChangedError(workflow, phase, reference, candidate);
    const recorded = storyPin(workflow, candidate);
    const baseline = (recorded?.sha256 === candidate.sha256 ? recorded.baseline : null) ?? firstPassingRun(attempts, candidate.sha256);
    // What narrows the run before it runs: filters, focused tests, and the pin's baseline [TCE:REQ-021].
    const narrowing = await narrowingFacts(root, command, { scripts, testPaths, baseline, inferred: candidate.source.kind === 'inferred', baseCommit });
    prepared.set(command.id, { candidate, reference, acceptedBy, scripts, baseline, narrowing });
  }
  return {
    prepared,
    // What an attempt of the command records: the pin it runs under and what narrows it before it runs.
    attempt: (commandId) => ({ pin: prepared.get(commandId)?.candidate ?? null, narrowing: prepared.get(commandId)?.narrowing ?? null }),
    // The gate's rule for a passing run's recorded narrowing: null, an acceptance's binding, or CODE_TEST_NARROWED.
    narrowed: (attempt, operation) => gateNarrowing(workflow, phase, attempt,
      { at: new Date().toISOString(), operation, skippedAccepted: skippedByAgreement(workflow) }),
    record: async (aggregate, ran, { at }) => recordTestCommandPins(aggregate, phase, prepared,
      { ran, at, attempts: await recordedRuns(root, config, aggregate, phase) })
  };
}

/**
 * Write the pins of the commands a passing gate ran onto the Story: a new pin at first use or
 * after an accepted re-pin (naming the pin it replaces and the request that admitted it), and a
 * pin's baseline at its first passing run.
 */
export function recordTestCommandPins(workflow, phase, prepared, { ran, at, attempts = [] }) {
  const ranIds = new Set(ran);
  for (const [commandId, entry] of prepared) {
    if (!ranIds.has(commandId)) continue;
    const current = storyPin(workflow, entry.candidate);
    if (current?.sha256 === entry.candidate.sha256) {
      current.baseline ??= firstPassingRun(attempts, current.sha256);
      continue;
    }
    workflow.testCommandPins ??= [];
    const previous = workflow.testCommandPins.filter((pin) => pin.commandId === commandId).at(-1) ?? null;
    workflow.testCommandPins.push({
      id: `TCP-${String(workflow.testCommandPins.length + 1).padStart(3, '0')}`, phase: phase.id,
      ...pinIdentity(entry.candidate),
      ...(previous ? { replaces: previous.id } : {}), ...(entry.acceptedBy ? { acceptedBy: entry.acceptedBy } : {}),
      baseline: firstPassingRun(attempts, entry.candidate.sha256), at
    });
  }
}

/**
 * What a re-pin request records for `command` as the gate resolves it now: the exact pin a person
 * accepts, by digest, and what changed from the pin it replaces. Refuses a command with no pin yet
 * (its first gate run pins it) or one unchanged since it was pinned.
 */
export async function repinRequest(root, config, workflow, phase, command) {
  const { entries } = await commandDefinition(root, command);
  const candidate = pinCandidate(phase, command, entries);
  const reference = referencePin(workflow, candidate, await recordedRuns(root, config, workflow, phase));
  if (!reference || reference.sha256 === candidate.sha256) {
    throw new SingularityFlowError(reference
      ? `Test command ${command.id} is unchanged since it was pinned for this Story${reference.id ? ` (${reference.id})` : ''}; there is nothing to re-pin.`
      : `Test command ${command.id} is not pinned for this Story yet; its first gate run pins it.`, { code: 'TEST_COMMAND_REPIN_UNNEEDED' });
  }
  const { sha256: digest, ...pin } = pinIdentity(candidate);
  return { commandId: command.id, sha256: digest, pinned: reference.sha256, pin, changes: pinChanges(reference, candidate).map(pinChangeWords) };
}

/**
 * Why one receipt execution's attempt does not replay its pin, or the narrowing a person accepted for
 * it, against the Story (`story`: { workflow, at }).
 */
export async function attemptReplayProblems(story, receipt, execution, attempt) {
  const { skippedByAgreement, testNarrowingReplayProblem } = attempt?.narrowing ? await import('./test-narrowing.mjs') : {};
  const narrowing = attempt?.narrowing ? testNarrowingReplayProblem(story?.workflow ?? null, execution, attempt,
    { phaseId: receipt.phase, at: story?.at, skippedAccepted: skippedByAgreement(story?.workflow) }) : null;
  return [pinReplayProblem(story?.workflow ?? null, attempt), narrowing].filter(Boolean);
}

/** Why a recorded attempt's pin does not replay against its Story, or null [TCE:REQ-014]. */
export function pinReplayProblem(workflow, attempt) {
  if (!attempt?.pin) return null;
  if (!workflow) return `the command pin of ${attempt.commandId} cannot be verified without its Story`;
  const { sha256: digest, ...identity } = pinIdentity(attempt.pin);
  if (`sha256:${recordSha256(identity)}` !== digest) return `the command pin of ${attempt.commandId} differs from its own digest`;
  return (workflow.testCommandPins ?? []).some((pin) => pin.commandId === attempt.commandId && pin.sha256 === attempt.pin.sha256)
    ? null : `${attempt.commandId} ran under a command pin that is not recorded on the Story`;
}

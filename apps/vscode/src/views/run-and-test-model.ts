/**
 * Run and test from a capability, as VS Code shows it. [RUN, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * The engine owns every rule: `app plan --json` says what each start entry runs (argv, working
 * directory, URL, readiness, allowed environments with their binding status, commandSha256),
 * `app status --json` says what is running and answering, `tests summary --json` says what the last
 * run found. This module turns those answers into the "Run & test" section and builds the exact
 * argv VS Code hands to a task. It never builds a shell string, never carries an environment value
 * (it never has one: the engine reports only names and binding status) and never decides whether a
 * run counts as evidence.
 *
 * Pure on purpose (no `vscode` import), so the tests pin every argv and every control.
 */
import { createHash } from 'node:crypto';
import type { CapabilityNode } from '../cli/snapshot.ts';
import type { ReviewConfirmationRequest } from './review-confirmation-page.ts';
import { evidenceClassLabel, totalsLine, type TestSummary } from './test-summary-model.ts';

/** One environment a start entry or test command may run against, as `env status` sees it. */
export interface EnvironmentChoice { name: string; status: string; default: boolean }

/** One `application.start` entry, resolved by `app plan --json`. */
export interface StartEntry {
  capability: string;
  repository: string | null;
  id: string;
  argv: string[];
  workingDirectory: string | null;
  url: string | null;
  ready: { http?: string; log?: string; timeoutMs?: number } | null;
  environments: EnvironmentChoice[];
  commandSha256: string;
}

/** One line of `app status --json`. */
export interface StartStatus {
  id: string;
  declared: boolean;
  started: boolean;
  ready: boolean;
  url: string | null;
  pid: number | null;
  environment: string | null;
}

/** One command `tests run` would run, from `tests plan --json` when the engine offers it. */
export interface TestCommandPlan {
  id: string;
  kind: string | null;
  argv: string[] | null;
  workingDirectory: string | null;
  environments: EnvironmentChoice[];
  commandSha256: string | null;
}

/** Whether the open checkout is this capability's repository: the check Test setup makes. */
export type Ownership = 'here' | 'not-delivery' | 'elsewhere' | 'unknown-repository';

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A command-result envelope (`{ resultType: 'command-result', data }`) or the bare answer. */
export function unwrapResult(raw: unknown): unknown {
  let value = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    const object = record(value);
    if (!object || !record(object.data) && !Array.isArray(object.data)) return value;
    value = object.data;
  }
  return value;
}

function listFrom(raw: unknown, keys: string[]): unknown[] {
  const value = unwrapResult(raw);
  if (Array.isArray(value)) return value;
  const object = record(value);
  if (!object) return [];
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as unknown[];
  return typeof object.id === 'string' ? [object] : [];
}

function argvFrom(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((entry) => typeof entry === 'string' && !CONTROL.test(entry))) return null;
  return [...value] as string[];
}

/** `environments: [{ name, status, default }]`; strings and the older single `environment` are read too. */
export function environmentsFrom(entry: Record<string, unknown>): EnvironmentChoice[] {
  const raw = Array.isArray(entry.environments) ? entry.environments
    : record(entry.environment) ? [entry.environment] : [];
  const seen = new Set<string>();
  const choices: EnvironmentChoice[] = [];
  for (const item of raw) {
    const object = record(item);
    const name = typeof item === 'string' ? item : text(object?.name);
    if (!name || !ENVIRONMENT.test(name) || seen.has(name)) continue;
    seen.add(name);
    choices.push({ name, status: text(object?.status) ?? 'unknown', default: object?.default === true });
  }
  if (choices.length && !choices.some((choice) => choice.default)) choices[0]!.default = true;
  return choices;
}

/** The start entries `app plan --json` returned; an entry VS Code cannot run exactly is left out. */
export function appPlanFrom(raw: unknown): { entries: StartEntry[]; dropped: string[] } {
  const entries: StartEntry[] = [];
  const dropped: string[] = [];
  for (const item of listFrom(raw, ['entries', 'start', 'plans', 'plan'])) {
    const entry = record(item);
    if (!entry) continue;
    const id = text(entry.id);
    const argv = argvFrom(entry.argv);
    const sha = text(entry.commandSha256);
    const capability = text(entry.capability);
    if (!id || !ID.test(id) || !argv || !sha || !SHA256.test(sha) || !capability || !ID.test(capability)) {
      dropped.push(id ?? '(unnamed)');
      continue;
    }
    const ready = record(entry.ready);
    entries.push({
      capability, repository: text(entry.repository), id, argv,
      workingDirectory: text(entry.workingDirectory), url: text(entry.url),
      ready: ready ? {
        ...(typeof ready.http === 'string' ? { http: ready.http } : {}),
        ...(typeof ready.log === 'string' ? { log: ready.log } : {}),
        ...(typeof ready.timeoutMs === 'number' ? { timeoutMs: ready.timeoutMs } : {})
      } : null,
      environments: environmentsFrom(entry),
      commandSha256: sha
    });
  }
  return { entries, dropped };
}

/** `app status --json`: what is declared, started (pid alive) and ready (URL responds). */
export function appStatusFrom(raw: unknown): StartStatus[] {
  return listFrom(raw, ['entries', 'start', 'status', 'applications']).flatMap((item) => {
    const entry = record(item);
    const id = text(entry?.id);
    if (!entry || !id) return [];
    const state = text(entry.state);
    const started = entry.started === true || state === 'started' || state === 'ready';
    return [{
      id, declared: entry.declared !== false, started,
      ready: started && (entry.ready === true || state === 'ready'),
      url: text(entry.url), pid: typeof entry.pid === 'number' ? entry.pid : null,
      environment: text(entry.environment) ?? text(record(entry.environment)?.name)
    }];
  });
}

/** `tests plan --json`: the commands a test run resolves, when the engine offers the read. */
export function testPlanFrom(raw: unknown): TestCommandPlan[] {
  return listFrom(raw, ['commands']).flatMap((item) => {
    const entry = record(item);
    const id = text(entry?.id);
    if (!entry || !id || !ID.test(id)) return [];
    const sha = text(entry.commandSha256);
    return [{
      id, kind: text(entry.kind), argv: argvFrom(entry.argv), workingDirectory: text(entry.workingDirectory),
      environments: environmentsFrom(entry), commandSha256: sha && SHA256.test(sha) ? sha : null
    }];
  });
}

/** The capability's repository is this checkout, as Test setup decides it (extension.ts). */
export function ownershipOf(capability: CapabilityNode | null | undefined, activeRepositoryId: string | null): Ownership {
  if (!capability || !(capability.delivery === true || capability.kind === 'delivery')) return 'not-delivery';
  const repositories = capability.repositories?.length ? capability.repositories : capability.repository ? [capability.repository] : [];
  if (!repositories.length) return 'here';
  if (!activeRepositoryId) return 'unknown-repository';
  return repositories.includes(activeRepositoryId) ? 'here' : 'elsewhere';
}

/** Every delivery capability in the tree whose repository is this checkout. */
export function capabilitiesHere(tree: CapabilityNode[], activeRepositoryId: string | null): CapabilityNode[] {
  const found: CapabilityNode[] = [];
  const visit = (nodes: CapabilityNode[]) => {
    for (const node of nodes) {
      if (ownershipOf(node, activeRepositoryId) === 'here') found.push(node);
      visit(node.children ?? []);
    }
  };
  visit(tree);
  return found;
}

export function findCapability(tree: CapabilityNode[], id: string): CapabilityNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const child = findCapability(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}

/** A start entry's URL, only when it is loopback http(s) with no credentials, query or fragment. */
export function loopbackUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.href;
}

/** "qa: not bound". Only the binding status is ever shown; values never reach VS Code. */
export function environmentStatusWords(status: string): string {
  if (status === 'bound') return 'bound';
  if (status === 'partial' || status === 'partially-bound') return 'partly bound';
  if (['unbound', 'not-bound', 'missing', 'unavailable', 'none'].includes(status)) return 'not bound';
  return status === 'unknown' ? 'status unknown' : status.replace(/-/g, ' ');
}

/** The command a person runs with their own secret helper on standard input. VS Code never runs it. */
export const bindCommand = (environment: string): string => `singularity-flow env bind ${environment} --stdin`;

/** Every environment the section can pick: start entries first, then test commands; first is the default. */
export function environmentOptions(entries: StartEntry[], tests: TestCommandPlan[]): EnvironmentChoice[] {
  const seen = new Map<string, EnvironmentChoice>();
  for (const choice of [...entries.flatMap((entry) => entry.environments), ...tests.flatMap((command) => command.environments)]) {
    if (!seen.has(choice.name)) seen.set(choice.name, { ...choice, default: false });
  }
  const options = [...seen.values()];
  const declaredDefault = [...entries, ...tests].flatMap((item) => item.environments).find((choice) => choice.default)?.name;
  const first = options.find((choice) => choice.name === declaredDefault) ?? options[0];
  if (first) first.default = true;
  return options;
}

/** The remembered choice when it is still allowed, else the declared default, else the first. */
export function chooseEnvironment(options: EnvironmentChoice[], remembered: string | null | undefined): string | null {
  if (remembered && options.some((choice) => choice.name === remembered)) return remembered;
  return options.find((choice) => choice.default)?.name ?? options[0]?.name ?? null;
}

/** The environment one start entry runs against: the chosen one when it allows it, else its own default. */
export function entryEnvironment(entry: Pick<StartEntry, 'environments'>, chosen: string | null): string | null {
  if (!entry.environments.length) return null;
  if (chosen && entry.environments.some((choice) => choice.name === chosen)) return chosen;
  return entry.environments.find((choice) => choice.default)?.name ?? entry.environments[0]!.name;
}

/** The environment a test run names: only one a command that will run allows; nothing otherwise. */
export function testsEnvironment(tests: TestCommandPlan[], chosen: string | null, commands: string[] = []): string | null {
  const planned = commands.length ? tests.filter((command) => commands.includes(command.id)) : tests;
  return chosen && planned.some((command) => command.environments.some((choice) => choice.name === chosen)) ? chosen : null;
}

const required = (value: string, label: string, pattern: RegExp): string => {
  if (!pattern.test(value)) throw new Error(`${label} is invalid: ${value}`);
  return value;
};

export const appPlanArgv = (capability: string): string[] =>
  ['app', 'plan', '--capability', required(capability, 'Capability', ID), '--json'];
export const appStatusArgv = (capability: string): string[] =>
  ['app', 'status', '--capability', required(capability, 'Capability', ID), '--json'];
export const appStopArgv = (capability: string, id: string): string[] =>
  ['app', 'stop', required(id, 'Start entry', ID), '--capability', required(capability, 'Capability', ID)];

/** What the start task runs after the CLI path: `app start <id> --capability <ID> [--environment ENV]`. */
export function appStartArgv(capability: string, id: string, environment: string | null): string[] {
  return ['app', 'start', required(id, 'Start entry', ID), '--capability', required(capability, 'Capability', ID),
    ...(environment ? ['--environment', required(environment, 'Environment', ENVIRONMENT)] : [])];
}

/** `tests run --capability <ID> [--command ID]... [--environment ENV]`; prose output for the terminal. */
export function testsRunArgv(capability: string, commands: string[], environment: string | null): string[] {
  return ['tests', 'run', '--capability', required(capability, 'Capability', ID),
    ...commands.flatMap((command) => ['--command', required(command, 'Test command', ID)]),
    ...(environment ? ['--environment', required(environment, 'Environment', ENVIRONMENT)] : [])];
}

export const testsPlanArgv = (capability: string): string[] =>
  ['tests', 'plan', '--capability', required(capability, 'Capability', ID), '--json'];

/** The public form of a command, for a person to read. Never executed: tasks run argv. */
export const displayCommand = (argv: string[]): string =>
  ['singularity-flow', ...argv].map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)).join(' ');

/** Keys remembered per workspace once a person confirmed what runs; a changed command asks again. */
export const CONFIRMED_COMMANDS_KEY = 'singularityFlow.runAndTest.confirmedCommands';
export const ENVIRONMENT_CHOICES_KEY = 'singularityFlow.runAndTest.environments';
const CONFIRMED_LIMIT = 200;

export function rememberConfirmed(confirmed: readonly string[], keys: readonly string[]): string[] {
  const next = [...confirmed.filter((key) => !keys.includes(key)), ...keys];
  return next.slice(Math.max(0, next.length - CONFIRMED_LIMIT));
}

/**
 * What a test run is confirmed by: each planned command's commandSha256 when the engine plans the
 * run, else one digest of the exact `tests run` argv (an older engine without `tests plan`).
 */
export function testsConfirmationKeys(tests: TestCommandPlan[], argv: string[], commands: string[]): string[] {
  const planned = commands.length ? tests.filter((command) => commands.includes(command.id)) : tests;
  if (planned.length && planned.every((command) => command.commandSha256)) return planned.map((command) => command.commandSha256!);
  return [`vscode-argv:sha256:${createHash('sha256').update(JSON.stringify(argv)).digest('hex')}`];
}

const readiness = (ready: StartEntry['ready']): string => {
  if (!ready) return 'the engine\'s default readiness check';
  const seconds = ready.timeoutMs ? ` within ${Math.round(ready.timeoutMs / 1000)} s` : '';
  if (ready.http) return `HTTP ${ready.http} answers below 500${seconds}`;
  if (ready.log) return `the output shows ${JSON.stringify(ready.log)}${seconds}`;
  return `the engine's default readiness check${seconds}`;
};

/** The review page shown before a start entry first runs, and again whenever its command changes. */
export function startConfirmationRequest(entry: StartEntry, environment: string | null): ReviewConfirmationRequest {
  const chosen = entry.environments.find((choice) => choice.name === environment);
  return {
    title: `Start ${entry.id} for ${entry.capability}`,
    summary: 'This command comes from singularity/capabilities.yml and runs on this computer. Review it once; you are asked again when it changes.',
    detail: [
      `Capability: ${entry.capability}`,
      `Start entry: ${entry.id}`,
      `Command: ${JSON.stringify(entry.argv)}`,
      `Working directory: ${entry.workingDirectory ?? '.'}${entry.repository ? ` (repository ${entry.repository})` : ''}`,
      `Opens at: ${entry.url ?? 'no URL declared'}`,
      `Ready when: ${readiness(entry.ready)}`,
      environment
        ? `Environment: ${environment} (${environmentStatusWords(chosen?.status ?? 'unknown')}). Its values go to this process only; VS Code never reads or shows them.`
        : 'Environment: none',
      `Command identity: ${entry.commandSha256}`,
      '',
      `VS Code runs it as a task: ${displayCommand(appStartArgv(entry.capability, entry.id, environment))}`
    ].join('\n'),
    confirmLabel: 'Run this command'
  };
}

/** The review page shown before a test selection first runs. */
export function testsConfirmationRequest(capability: string, tests: TestCommandPlan[], commands: string[],
  environment: string | null): ReviewConfirmationRequest {
  const planned = commands.length ? tests.filter((command) => commands.includes(command.id)) : tests;
  const lines = planned.length
    ? planned.flatMap((command) => [
      `${command.id}${command.kind ? ` (${command.kind})` : ''}: ${command.argv ? JSON.stringify(command.argv) : 'argv resolved by the engine'}`,
      ...(command.workingDirectory ? [`  in ${command.workingDirectory}`] : []),
      ...(command.commandSha256 ? [`  identity ${command.commandSha256}`] : [])
    ])
    : [commands.length ? `Commands: ${commands.join(', ')}` : 'Commands: the capability\'s tests, or what its code step runs, as the engine resolves them'];
  return {
    title: `Run tests for ${capability}`,
    summary: 'These test commands come from the workflow and run on this computer. Review them once; you are asked again when they change.',
    detail: [
      `Capability: ${capability}`,
      ...lines,
      environment ? `Environment: ${environment}. Its values go to the test process only; VS Code never reads or shows them.` : 'Environment: none named',
      '',
      `VS Code runs it as a task: ${displayCommand(testsRunArgv(capability, commands, environment))}`,
      'The run is a local preview: it is shown in the test summary and never counts as evidence for a Story.'
    ].join('\n'),
    confirmLabel: 'Run these tests'
  };
}

/** What VS Code knows of a start entry's task in this window. */
export interface StartTaskState { running: boolean; exitCode?: number | null }

export type StartState = 'ready' | 'starting' | 'started' | 'stopped' | 'failed' | 'not-declared';

export function startState(status: StartStatus | undefined, task: StartTaskState | undefined): StartState {
  if (status && !status.declared) return 'not-declared';
  if (status?.ready) return 'ready';
  if (task?.running) return 'starting';
  if (status?.started) return 'started';
  if (task && !task.running && typeof task.exitCode === 'number' && task.exitCode !== 0) return 'failed';
  return 'stopped';
}

const STATE_WORDS: Record<StartState, string> = {
  ready: 'Ready', starting: 'Starting', started: 'Running, not answering yet', stopped: 'Not running',
  failed: 'Stopped with an error', 'not-declared': 'No longer declared'
};

export interface StartRow {
  id: string; command: string; workingDirectory: string | null; url: string | null;
  state: StartState; stateWords: string; detail: string | null; environment: string | null;
  canStart: boolean; canStop: boolean; canOpen: boolean;
}

export interface EnvironmentRow { name: string; status: string; words: string; bound: boolean; selected: boolean }

export interface LastRunLine { runId: string; classLabel: string; line: string; label: string | null }

export interface RunAndTestState {
  plan?: StartEntry[] | null;
  planNote?: string | null;
  status?: StartStatus[] | null;
  tests?: TestCommandPlan[] | null;
  lastRun?: TestSummary | null;
  lastRunNote?: string | null;
  tasks?: Record<string, StartTaskState>;
  testsRunning?: boolean;
  environment?: string | null;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
}

export interface RunAndTestView {
  capability: string;
  name: string;
  ownership: Ownership;
  loading: boolean;
  error: string | null;
  notice: string | null;
  environments: EnvironmentRow[];
  environment: string | null;
  bind: string | null;
  starts: StartRow[];
  startsNote: string | null;
  testCommands: string[];
  testsRunning: boolean;
  lastRun: LastRunLine | null;
  lastRunNote: string | null;
}

/** The section for one capability: start entries, environment picker, test buttons, the last run. */
export function buildRunAndTestView(capability: CapabilityNode, ownership: Ownership, state: RunAndTestState): RunAndTestView {
  const plan = state.plan ?? [];
  const tests = state.tests ?? [];
  const options = environmentOptions(plan, tests);
  const environment = chooseEnvironment(options, state.environment);
  const chosen = options.find((choice) => choice.name === environment);
  const statuses = new Map((state.status ?? []).map((entry) => [entry.id, entry]));
  const starts = plan.map((entry): StartRow => {
    const status = statuses.get(entry.id);
    const task = state.tasks?.[entry.id];
    const current = startState(status, task);
    const url = loopbackUrl(status?.url ?? entry.url);
    const running = current === 'ready' || current === 'starting' || current === 'started';
    return {
      id: entry.id, command: entry.argv.join(' '), workingDirectory: entry.workingDirectory, url,
      state: current, stateWords: STATE_WORDS[current],
      detail: current === 'ready' && url ? `at ${url}`
        : current === 'starting' ? `waiting until ${readiness(entry.ready)}`
          : current === 'failed' ? `exit code ${task?.exitCode}` : null,
      environment: running ? status?.environment ?? null : entryEnvironment(entry, environment),
      canStart: !running, canStop: running, canOpen: current === 'ready' && Boolean(url)
    };
  });
  const lastRun = state.lastRun?.run ? {
    runId: state.lastRun.run.id,
    classLabel: evidenceClassLabel(state.lastRun.run.evidenceClass),
    line: `${totalsLine(state.lastRun.totals)}${state.lastRun.run.environment ? ` · environment ${state.lastRun.run.environment}` : ''}${state.lastRun.run.startedAt ? ` · ${state.lastRun.run.startedAt}` : ''}`,
    label: state.lastRun.run.label || null
  } : null;
  const fromSummary = (state.lastRun?.commands ?? []).map((command) => command.id).filter((id) => ID.test(id));
  return {
    capability: capability.id,
    name: capability.name ?? capability.id,
    ownership,
    loading: state.loading === true,
    error: state.error ?? null,
    notice: state.notice ?? null,
    environments: options.map((choice) => ({
      name: choice.name, status: choice.status, words: environmentStatusWords(choice.status),
      bound: choice.status === 'bound', selected: choice.name === environment
    })),
    environment,
    bind: chosen && chosen.status !== 'bound' ? bindCommand(chosen.name) : null,
    starts,
    startsNote: state.planNote ?? (state.plan && !plan.length
      ? 'No start entries are declared. Add application.start to this capability in singularity/capabilities.yml through a capability proposal.' : null),
    testCommands: tests.length ? tests.map((command) => command.id) : [...new Set(fromSummary)],
    testsRunning: state.testsRunning === true,
    lastRun,
    lastRunNote: state.lastRunNote ?? (state.lastRun === null ? 'No test run yet.' : null)
  };
}

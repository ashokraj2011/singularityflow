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
import { environmentFileCounts, type EnvironmentFile } from './environment-files-model.ts';

/** One environment a start entry or test command may run against, as `env status` sees it. */
export interface EnvironmentChoice { name: string; status: string; default: boolean }

/** The runtimes a start entry's `debug` block names. [RUN amendment 2] */
export type DebugRuntime = 'java' | 'python' | 'node' | 'go' | 'dotnet';
export const DEBUG_RUNTIMES: readonly DebugRuntime[] = ['java', 'python', 'node', 'go', 'dotnet'];

/** A coded refusal `app start --debug` would give before anything runs (APP_DEBUG_*). */
export interface DebugRefusal { code: string; message: string }

/** How a debug start runs in one environment, as `app plan` describes it, or why it cannot. */
export interface DebugLaunch {
  argv: string[] | null;
  /** Variables the engine sets for the application only (NODE_OPTIONS, npm_config_node_options, …): names. */
  environmentNames: string[];
  refusal: DebugRefusal | null;
}

/**
 * A start entry's `debug` block as `app plan --json` resolves it. A debug start has no identity of
 * its own: `commandSha256` covers the debug block, and `app start --debug --expect-command`
 * compares the entry's commandSha256. VS Code confirms it separately as `<commandSha256>:debug`.
 */
export interface DebugPlan extends DebugLaunch {
  runtime: DebugRuntime;
  /** The loopback port the debugger listens on; null for .NET, which attaches by process ID. */
  port: number | null;
  suspend: boolean;
  launcher: string | null;
  notes: string[];
  /** Each environment's own debug launch (`environments[].debug`); the block itself is the first one's. */
  environments: Record<string, DebugLaunch>;
}

/** One `application.start` entry, resolved by `app plan --json`. */
export interface StartEntry {
  capability: string;
  repository: string | null;
  id: string;
  /** The display name of a typed run configuration (`name`); null shows the ID. [RUN IntelliJ amendment §1] */
  name: string | null;
  /** Its type (`spring-boot`, `npm`, …); null for an entry written as argv (type `command`). */
  type: string | null;
  argv: string[];
  workingDirectory: string | null;
  url: string | null;
  ready: { http?: string; log?: string; timeoutMs?: number } | null;
  environments: EnvironmentChoice[];
  commandSha256: string;
  /** `arguments`: appended to argv for the chosen environment. */
  arguments: Record<string, string[]>;
  /** The argv each environment runs, as the engine resolved it (`environments[].argv`). */
  resolvedArgv: Record<string, string[]>;
  /**
   * What runs around the command line, per environment (`''` without one): a typed entry's
   * before-launch steps and the names of the variables it sets (`resolved.beforeLaunch`, `envNames`).
   */
  launch: Record<string, LaunchDetail>;
  debug: DebugPlan | null;
  /** Why a declared `debug` block is not offered: the engine's answer for it is incomplete. */
  debugIssue: string | null;
  dependencies?: StartEntry[];
}

/** A typed entry's before-launch steps (run in order before the application) and the variable names it sets. */
export interface LaunchDetail { beforeLaunch: Array<{ argv: string[]; workingDirectory: string | null }>; envNames: string[] }

/** One line of `app status --json`. */
export interface StartStatus {
  id: string;
  declared: boolean;
  started: boolean;
  ready: boolean;
  url: string | null;
  pid: number | null;
  environment: string | null;
  /** `debug: { runtime, port, listening }` for a start made with --debug. */
  debug: { runtime: string | null; port: number | null; listening: boolean } | null;
}

/** A capability's `policy.localIntegrationEvidence`: whether its environments' values may reach a local process. */
export type LocalIntegrationPolicy = 'off' | 'allowed';

/**
 * The capability's policy as `tests plan --json` reports it (`localIntegrationEvidence`, the same
 * folded policy `app start` checks); null when the engine does not say, so the engine decides.
 */
export function localIntegrationPolicy(raw: unknown): LocalIntegrationPolicy | null {
  const value = record(unwrapResult(raw))?.localIntegrationEvidence;
  return value === 'off' || value === 'allowed' ? value : null;
}

/** One command `tests run` would run, from `tests plan --json` when the engine offers it. */
export interface TestCommandPlan {
  id: string;
  kind: string | null;
  /** The report adapter (`junit-xml`, …), when `tests plan` names it. */
  adapter: string | null;
  argv: string[] | null;
  workingDirectory: string | null;
  environments: EnvironmentChoice[];
  commandSha256: string | null;
  /** The plan in words, when the engine says them: "Tests (Vitest)", where it was found, how finely its results are read. */
  title?: string | null;
  why?: string | null;
  resultsWords?: string | null;
}

/** What `tests plan` adds beside its commands: what it saw and does not run, and what to do before starting. None of it refuses. */
export interface TestPlanNotes {
  notUsed: string[];
  earlyChecks: Array<{ words: string; action: string | null }>;
}

/** Whether the open checkout is this capability's repository: the check Test setup makes. */
export type Ownership = 'here' | 'not-delivery' | 'elsewhere' | 'unknown-repository';

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TYPE = /^[a-z][a-z0-9-]{0,31}$/;

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

/** `{ <environment>: [string, …] }`, keeping only environment names and argv-safe lists. */
function argvMap(value: unknown, environments: string[] | null = null): Record<string, string[]> {
  const object = record(value);
  const map: Record<string, string[]> = {};
  if (!object) return map;
  for (const [name, list] of Object.entries(object)) {
    if (!ENVIRONMENT.test(name) || environments && !environments.includes(name)) continue;
    const argv = argvFrom(list);
    if (argv) map[name] = argv;
  }
  return map;
}

/** A TCP port the engine reported: an integer from 1 to 65535, nothing else. */
export const debugPort = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** `{ argv, environmentNames }` or `{ refusal: { code, message } }`, from the plan. */
function debugLaunchFrom(value: unknown): DebugLaunch {
  const launch = record(value) ?? {};
  const refusal = record(launch.refusal);
  const code = text(refusal?.code);
  return {
    argv: argvFrom(launch.argv),
    environmentNames: (Array.isArray(launch.environmentNames) ? launch.environmentNames : [])
      .filter((name): name is string => typeof name === 'string' && VARIABLE_NAME.test(name)),
    refusal: refusal ? { code: code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'APP_DEBUG_REFUSED',
      message: text(refusal.message) && !CONTROL.test(String(refusal.message)) ? String(refusal.message) : 'app start --debug would refuse this entry.' } : null
  };
}

/** The plan's `debug` block, or why VS Code cannot offer it. */
function debugFrom(value: unknown, environments: Array<{ name: string; debug?: unknown }>): { debug: DebugPlan | null; issue: string | null } {
  const debug = record(value);
  if (!debug) return { debug: null, issue: null };
  const runtime = text(debug.runtime) as DebugRuntime | null;
  if (!runtime || !DEBUG_RUNTIMES.includes(runtime)) return { debug: null, issue: `the debug runtime ${JSON.stringify(debug.runtime ?? null)} is not one VS Code attaches to` };
  // Only a port the engine reported: VS Code never assumes one (attach reads `app status` again).
  const port = runtime === 'dotnet' ? null : debugPort(debug.port);
  if (port === null && runtime !== 'dotnet' && debug.port != null) return { debug: null, issue: `the debug port ${JSON.stringify(debug.port)} is not a TCP port` };
  return {
    debug: {
      runtime, port, suspend: debug.suspend === true, launcher: text(debug.launcher),
      notes: (Array.isArray(debug.notes) ? debug.notes : []).filter((note): note is string => typeof note === 'string' && !CONTROL.test(note)),
      ...debugLaunchFrom(debug),
      environments: Object.fromEntries(environments.filter((environment) => record(environment.debug))
        .map((environment) => [environment.name, debugLaunchFrom(environment.debug)]))
    },
    issue: null
  };
}

/**
 * `resolved: { beforeLaunch, envNames }`, or 'invalid' when a step is not an argv VS Code can show
 * exactly: a step that would run unseen makes the entry one VS Code does not run.
 */
function launchDetailFrom(value: unknown): LaunchDetail | 'invalid' | null {
  const resolved = record(value);
  if (!resolved) return null;
  const steps = Array.isArray(resolved.beforeLaunch) ? resolved.beforeLaunch : [];
  const beforeLaunch = steps.flatMap((step) => {
    // `{ argv, workingDirectory }` as app plan answers it; a bare argv list is read the same way.
    const object = record(step);
    const argv = argvFrom(Array.isArray(step) ? step : object?.argv);
    return argv ? [{ argv, workingDirectory: text(object?.workingDirectory) }] : [];
  });
  if (beforeLaunch.length !== steps.length) return 'invalid';
  const envNames = (Array.isArray(resolved.envNames) ? resolved.envNames : []).filter((name): name is string => typeof name === 'string' && VARIABLE_NAME.test(name));
  return { beforeLaunch, envNames };
}

/** The start entries `app plan --json` returned; an entry VS Code cannot run exactly is left out. */
export function appPlanFrom(raw: unknown): { entries: StartEntry[]; dropped: string[] } {
  const entries: StartEntry[] = [];
  const dropped: string[] = [];
  for (const item of listFrom(raw, ['entries', 'start', 'plans', 'plan'])) {
    const entry = record(item);
    if (!entry) continue;
    const id = text(entry.id);
    // A typed entry may answer only its resolved command line (`resolved.argv`, per environment).
    const resolvedFirst = (Array.isArray(entry.environments) ? entry.environments : []).map((value) => record(record(value)?.resolved)?.argv)[0];
    const argv = argvFrom(entry.argv) ?? argvFrom(record(entry.resolved)?.argv) ?? argvFrom(resolvedFirst);
    const sha = text(entry.commandSha256);
    const capability = text(entry.capability);
    if (!id || !ID.test(id) || !argv || !sha || !SHA256.test(sha) || !capability || !ID.test(capability)) {
      dropped.push(id ?? '(unnamed)');
      continue;
    }
    const dependencies = Array.isArray(entry.dependencies) ? appPlanFrom({ entries: entry.dependencies }) : { entries: [], dropped: [] };
    if (dependencies.dropped.length) { dropped.push(id); continue; }
    const ready = record(entry.ready);
    const environments = environmentsFrom(entry);
    const names = environments.map((choice) => choice.name);
    const planned = (Array.isArray(entry.environments) ? entry.environments : []).flatMap((value) => {
      const object = record(value);
      const name = text(object?.name);
      return object && name && names.includes(name) ? [{ name, argv: record(object.resolved)?.argv ?? object.argv, debug: object.debug, resolved: object.resolved }] : [];
    });
    const launches = [['', launchDetailFrom(entry.resolved)] as const, ...planned.map((environment) => [environment.name, launchDetailFrom(environment.resolved)] as const)];
    if (launches.some(([, launch]) => launch === 'invalid')) {
      dropped.push(id);
      continue;
    }
    const launch: Record<string, LaunchDetail> = Object.fromEntries(launches.filter((pair): pair is readonly [string, LaunchDetail] => pair[1] !== null && pair[1] !== 'invalid'));
    const resolvedArgv: Record<string, string[]> = {};
    for (const environment of planned) {
      const resolved = argvFrom(environment.argv);
      if (resolved) resolvedArgv[environment.name] = resolved;
    }
    const { debug, issue } = debugFrom(entry.debug, planned);
    const name = text(entry.name);
    const type = text(entry.type);
    entries.push({
      capability, repository: text(entry.repository), id, argv,
      name: name && name.length <= 120 && !CONTROL.test(name) ? name.trim() : null,
      type: type && TYPE.test(type) ? type : null,
      workingDirectory: text(entry.workingDirectory), url: text(entry.url),
      ready: ready ? {
        ...(typeof ready.http === 'string' ? { http: ready.http } : {}),
        ...(typeof ready.log === 'string' ? { log: ready.log } : {}),
        ...(typeof ready.timeoutMs === 'number' ? { timeoutMs: ready.timeoutMs } : {})
      } : null,
      environments,
      commandSha256: sha,
      arguments: argvMap(entry.arguments, names),
      resolvedArgv,
      launch,
      debug,
      debugIssue: issue,
      ...(dependencies.entries.length ? { dependencies: dependencies.entries } : {})
    });
  }
  return { entries, dropped };
}

/**
 * The argv an entry runs in an environment: what `app plan` resolved for it, else `argv` followed
 * by that environment's `arguments`, the rule the amendment gives. Without an environment, `argv`.
 */
export function resolvedArgv(entry: Pick<StartEntry, 'argv' | 'arguments' | 'resolvedArgv'>, environment: string | null): string[] {
  if (!environment) return entry.argv;
  return entry.resolvedArgv[environment] ?? [...entry.argv, ...(entry.arguments[environment] ?? [])];
}

/** The before-launch steps and variable names in an environment: that environment's own, else the entry's. */
export function launchDetail(entry: Pick<StartEntry, 'launch'>, environment: string | null): LaunchDetail {
  return (environment ? entry.launch?.[environment] : null) ?? entry.launch?.[''] ?? { beforeLaunch: [], envNames: [] };
}

/** The debug launch in an environment: that environment's own, else the block's (the first environment's). */
export function debugLaunch(debug: DebugPlan, environment: string | null): DebugLaunch {
  return (environment ? debug.environments[environment] : null) ?? debug;
}

/** The key a debug start is confirmed under: the entry's identity, marked as its debug start. */
export const debugConfirmationKey = (entry: Pick<StartEntry, 'commandSha256'>): string => `${entry.commandSha256}:debug`;

/** `app status --json`: what is declared, started (pid alive) and ready (URL responds). */
export function appStatusFrom(raw: unknown): StartStatus[] {
  return listFrom(raw, ['entries', 'start', 'status', 'applications']).flatMap((item) => {
    const entry = record(item);
    const id = text(entry?.id);
    if (!entry || !id) return [];
    const state = text(entry.state);
    const started = entry.started === true || state === 'started' || state === 'ready';
    const debug = record(entry.debug);
    return [{
      id, declared: entry.declared !== false, started,
      ready: started && (entry.ready === true || state === 'ready'),
      url: text(entry.url), pid: typeof entry.pid === 'number' && Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : null,
      environment: text(entry.environment) ?? text(record(entry.environment)?.name),
      debug: debug ? { runtime: text(debug.runtime), port: debugPort(debug.port), listening: started && debug.listening === true } : null
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
      id, kind: text(entry.kind), adapter: text(entry.adapter), argv: argvFrom(entry.argv), workingDirectory: text(entry.workingDirectory),
      environments: environmentsFrom(entry), commandSha256: sha && SHA256.test(sha) ? sha : null,
      title: text(entry.title), why: text(entry.why), resultsWords: text(entry.resultsWords)
    }];
  });
}

/** `tests plan --json`: the lines beside its commands, shown as they are; an older engine has none. */
export function testPlanNotesFrom(raw: unknown): TestPlanNotes {
  const plan = record(unwrapResult(raw));
  return {
    notUsed: listFrom(plan?.notUsed, []).flatMap((item) => { const why = text(record(item)?.why); return why ? [why] : []; }),
    earlyChecks: listFrom(plan?.earlyChecks, []).flatMap((item) => {
      const entry = record(item);
      const words = text(entry?.words);
      return words ? [{ words, action: text(entry?.action) }] : [];
    })
  };
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
  if (status === 'undeclared') return 'not declared in singularity/environments.yml';
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

/**
 * Why a start entry cannot run in its environment, from the plan read just before: the engine would
 * refuse an incomplete binding or an undeclared environment after the task opened, so it is said
 * here, plainly, with what the person does about it. Null when it can run.
 */
export function startRefusal(entry: Pick<StartEntry, 'id' | 'environments'> & Partial<Pick<StartEntry, 'capability'>>, environment: string | null,
  policy: LocalIntegrationPolicy | null = null): string | null {
  // The engine refuses any start in an environment while the capability keeps values from local processes.
  if (environment && policy === 'off') {
    return `${entry.id} was not started: it needs environment ${environment}, whose values are given to a local process only when capability`
      + ` ${entry.capability ?? 'its capability'} sets policy.localIntegrationEvidence to allowed. It is off. Change it through a capability proposal; nothing ran.`;
  }
  const choice = environment ? entry.environments.find((item) => item.name === environment) : null;
  // Only a status the engine reported as not runnable; an unknown one is left to the engine.
  if (!choice || !['unbound', 'unavailable', 'partial', 'partially-bound', 'missing', 'not-bound', 'none', 'undeclared'].includes(choice.status)) return null;
  if (choice.status === 'undeclared') {
    return `${entry.id} was not started: environment ${choice.name} is not declared in singularity/environments.yml. Declare it through a configuration proposal, or pick another environment.`;
  }
  return `${entry.id} was not started: environment ${choice.name} is ${environmentStatusWords(choice.status)} on this computer. Bind its values with your own secret helper, on standard input: ${bindCommand(choice.name)}`;
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
  ['app', 'stop', required(id, 'Start entry', ID), '--capability', required(capability, 'Capability', ID), '--json'];
/** The capability the engine resolves for this checkout, for a window that does not know its repository. */
export const appPlanHereArgv = (): string[] => ['app', 'plan', '--json'];

const expect = (identities: string[]): string[] => identities.flatMap((sha) => ['--expect-command', required(sha, 'Command identity', SHA256)]);

/**
 * What the start task runs after the CLI path: `app start <id> --capability <ID> [--environment ENV]
 * [--debug] --expect-command <commandSha256>`. The engine refuses (APP_COMMAND_CHANGED) when the
 * entry is no longer the one the person confirmed. A debug start (--debug) is compared on the same
 * commandSha256, which covers the debug block.
 */
export function appStartArgv(capability: string, id: string, environment: string | null, commandSha256: string | null = null,
  debug = false): string[] {
  return ['app', 'start', required(id, 'Start entry', ID), '--capability', required(capability, 'Capability', ID),
    ...(environment ? ['--environment', required(environment, 'Environment', ENVIRONMENT)] : []),
    ...(debug ? ['--debug'] : []),
    ...expect(commandSha256 ? [commandSha256] : [])];
}

/** Every attach configuration VS Code builds connects to this host and nothing else. */
export const DEBUG_HOST = '127.0.0.1';

const RUNTIME_WORDS: Record<DebugRuntime, string> = { java: 'Java', python: 'Python', node: 'Node.js', go: 'Go', dotnet: '.NET' };

/** The extension that provides each runtime's attach type; Node's debugger is built into VS Code. */
export const DEBUGGER_EXTENSIONS: Record<DebugRuntime, { id: string; name: string } | null> = {
  java: { id: 'vscjava.vscode-java-debug', name: 'Debugger for Java' },
  python: { id: 'ms-python.debugpy', name: 'Python Debugger' },
  node: null,
  go: { id: 'golang.go', name: 'Go' },
  dotnet: { id: 'ms-dotnettools.csharp', name: 'C#' }
};

/**
 * The attach configuration for a runtime: loopback host, the port the engine reported, or for .NET
 * the process ID `app status` reported. Nothing here comes from a page: a webview message names an
 * entry, and the host reads the port and pid from the engine again.
 */
export function debugAttachConfiguration(runtime: DebugRuntime, name: string, target: { port?: number | null; pid?: number | null }):
  Record<string, unknown> | null {
  const port = debugPort(target.port);
  const pid = typeof target.pid === 'number' && Number.isInteger(target.pid) && target.pid > 0 ? target.pid : null;
  switch (runtime) {
    case 'java': return port ? { type: 'java', request: 'attach', name, hostName: DEBUG_HOST, port } : null;
    case 'python': return port ? { type: 'debugpy', request: 'attach', name, connect: { host: DEBUG_HOST, port } } : null;
    case 'node': return port ? { type: 'node', request: 'attach', name, address: DEBUG_HOST, port } : null;
    case 'go': return port ? { type: 'go', request: 'attach', name, mode: 'remote', host: DEBUG_HOST, port } : null;
    case 'dotnet': return pid ? { type: 'coreclr', request: 'attach', name, processId: pid } : null;
    default: return null;
  }
}

/** The debug session's name in VS Code's Run and Debug view. */
export const debugSessionName = (capability: string, id: string): string => `${id} · ${capability} (Singularity Flow)`;

/** Whether `app status` says the debugger can be attached to now: listening, or for .NET a live pid. */
export function debuggerReady(debug: DebugPlan, status: StartStatus | undefined): boolean {
  if (!status?.started) return false;
  return debug.runtime === 'dotnet' ? status.pid !== null : status.debug?.listening === true;
}

export type DebugAttachPlan =
  | { configuration: Record<string, unknown>; extension: { id: string; name: string } | null; where: string }
  | { error: string };

/** What VS Code attaches to, from the plan's runtime and the live `app status` port or pid. */
export function debugAttachPlan(entry: Pick<StartEntry, 'capability' | 'id' | 'debug'>, status: StartStatus | undefined): DebugAttachPlan {
  const debug = entry.debug;
  if (!debug) return { error: `${entry.id} declares no debug block in singularity/capabilities.yml.` };
  if (!debuggerReady(debug, status)) {
    return { error: debug.runtime === 'dotnet'
      ? `${entry.id} is not running, so there is no process to attach to.`
      : `${entry.id} has no debugger listening. Start it with Start (debug).` };
  }
  if (status?.debug?.runtime && status.debug.runtime !== debug.runtime) {
    return { error: `${entry.id} is running with the ${status.debug.runtime} debugger, but singularity/capabilities.yml now declares ${debug.runtime}. Stop it and start it again.` };
  }
  const port = status?.debug?.port ?? debug.port;
  const configuration = debugAttachConfiguration(debug.runtime, debugSessionName(entry.capability, entry.id), { port, pid: status?.pid ?? null });
  if (!configuration) return { error: `The engine did not report the ${debug.runtime === 'dotnet' ? 'process ID' : 'debugger port'} of ${entry.id}, so VS Code attached nothing.` };
  return {
    configuration, extension: DEBUGGER_EXTENSIONS[debug.runtime],
    where: debug.runtime === 'dotnet' ? `as process ${status!.pid}` : `with its debugger listening at ${DEBUG_HOST}:${port}`
  };
}

/** Said when the language's debugger extension is missing; the application stays running. */
export function missingDebuggerMessage(entryId: string, runtime: DebugRuntime, where: string): string {
  const extension = DEBUGGER_EXTENSIONS[runtime];
  return `${entryId} is running ${where}, but VS Code has no ${RUNTIME_WORDS[runtime]} debugger to attach with. `
    + `Install the ${extension?.name ?? RUNTIME_WORDS[runtime]} extension${extension ? ` (${extension.id})` : ''}, then choose Attach debugger. `
    + `${entryId} keeps running; Stop ends it.`;
}

/** "java debugger at 127.0.0.1:5005", for a row and the confirmation. */
export function debugWords(debug: DebugPlan): string {
  if (debug.runtime === 'dotnet') return '.NET: VS Code attaches to the started process by its ID';
  return `${RUNTIME_WORDS[debug.runtime]} debugger at ${DEBUG_HOST}:${debug.port ?? 'the port the engine reports'}${debug.suspend ? ', waiting for the debugger before it runs' : ''}`;
}

/**
 * `tests run --capability <ID> [--command ID]... [--environment ENV] [--expect-command SHA]...`, prose
 * output for the terminal. Every command that runs carries the identity the person confirmed; the
 * engine refuses (TESTS_COMMAND_CHANGED) and runs nothing when one changed.
 */
export function testsRunArgv(capability: string, commands: string[], environment: string | null, identities: string[] = []): string[] {
  return ['tests', 'run', '--capability', required(capability, 'Capability', ID),
    ...commands.flatMap((command) => ['--command', required(command, 'Test command', ID)]),
    ...(environment ? ['--environment', required(environment, 'Environment', ENVIRONMENT)] : []),
    ...expect(identities)];
}

/** The planned identities of the commands a run selects, when the engine planned every one. */
export function plannedIdentities(tests: TestCommandPlan[], commands: string[]): string[] {
  const planned = commands.length ? tests.filter((command) => commands.includes(command.id)) : tests;
  return planned.length && planned.every((command) => command.commandSha256) ? planned.map((command) => command.commandSha256!) : [];
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
  const planned = plannedIdentities(tests, commands);
  if (planned.length) return planned;
  return [`vscode-argv:sha256:${createHash('sha256').update(JSON.stringify(argv)).digest('hex')}`];
}

const readiness = (ready: StartEntry['ready']): string => {
  if (!ready) return 'the engine\'s default readiness check';
  const seconds = ready.timeoutMs ? ` within ${Math.round(ready.timeoutMs / 1000)} s` : '';
  if (ready.http) return `HTTP ${ready.http} answers below 500${seconds}`;
  if (ready.log) return `the output shows ${JSON.stringify(ready.log)}${seconds}`;
  return `the engine's default readiness check${seconds}`;
};

const environmentLine = (entry: StartEntry, environment: string | null): string => {
  const chosen = entry.environments.find((choice) => choice.name === environment);
  return environment
    ? `Environment: ${environment} (${environmentStatusWords(chosen?.status ?? 'unknown')}). Its values go to this process only; VS Code never reads or shows them.`
    : 'Environment: none';
};

const argumentsLine = (entry: StartEntry, environment: string | null): string[] =>
  environment && entry.arguments[environment]?.length ? [`Arguments for ${environment}: ${JSON.stringify(entry.arguments[environment])}`] : [];

/** A typed entry's before-launch steps, in order, and the variables it sets for the application. */
const launchLines = (entry: StartEntry, environment: string | null): string[] => {
  const launch = launchDetail(entry, environment);
  return [
    ...launch.beforeLaunch.map((step, index) => `Before launch, step ${index + 1} of ${launch.beforeLaunch.length}: ${JSON.stringify(step.argv)}`
      + `${step.workingDirectory && step.workingDirectory !== '.' ? ` in ${step.workingDirectory}` : ''}`),
    ...(launch.envNames.length ? [`Sets for the application only: ${launch.envNames.join(', ')}`] : [])
  ];
};

/**
 * One confirmation covers the entry in every environment (its command identity covers each one's
 * resolved form), so what the other environments run is shown too, not only the one starting now.
 */
const otherEnvironmentLines = (entry: StartEntry, environment: string | null, command: (name: string) => string[]): string[] => {
  const others = environment ? entry.environments.filter((choice) => choice.name !== environment) : [];
  if (!others.length) return [];
  return ['', `This confirmation also covers ${others.length === 1 ? 'its other environment' : 'its other environments'}:`,
    ...others.flatMap((choice) => [`  ${choice.name}: ${JSON.stringify(command(choice.name))}`, ...launchLines(entry, choice.name).map((line) => `    ${line}`)])];
};

/** "api (Api, node)" when the configuration has a name or type of its own. */
const dependencyLines = (entry: StartEntry, environment: string | null): string[] => (entry.dependencies ?? []).flatMap(service => [
  `Required service: ${service.name ?? service.id} in ${service.repository ?? 'this repository'}/${service.workingDirectory ?? '.'}`,
  `  Command: ${JSON.stringify(resolvedArgv(service, service.environments.length ? environment ?? service.environments[0]!.name : null))}`,
  ...launchLines(service, environment).map(line => `  ${line}`),
  ...otherEnvironmentLines(service, environment, name => resolvedArgv(service, name))
]);

const entryWords = (entry: StartEntry): string => {
  const extra = [entry.name && entry.name !== entry.id ? entry.name : null, entry.type].filter(Boolean);
  return extra.length ? `${entry.id} (${extra.join(', ')})` : entry.id;
};

/** The review page shown before a start entry first runs, and again whenever its command changes. */
export function startConfirmationRequest(entry: StartEntry, environment: string | null): ReviewConfirmationRequest {
  return {
    title: `Start ${entry.name ?? entry.id} for ${entry.capability}`,
    summary: 'This command comes from this checkout’s effective run configuration and runs on this computer. Review it once; you are asked again when it changes.',
    detail: [
      `Capability: ${entry.capability}`,
      `Start entry: ${entryWords(entry)}`,
      `Command: ${JSON.stringify(resolvedArgv(entry, environment))}`,
      ...dependencyLines(entry, environment),
      ...argumentsLine(entry, environment),
      ...launchLines(entry, environment),
      `Working directory: ${entry.workingDirectory ?? '.'}${entry.repository ? ` (repository ${entry.repository})` : ''}`,
      `Opens at: ${entry.url ?? 'no URL declared'}`,
      `Ready when: ${readiness(entry.ready)}`,
      environmentLine(entry, environment),
      ...otherEnvironmentLines(entry, environment, (name) => resolvedArgv(entry, name)),
      '',
      `VS Code runs it as a task: ${displayCommand(appStartArgv(entry.capability, entry.id, environment, entry.commandSha256))}`
    ].join('\n'),
    confirmLabel: 'Run this command'
  };
}

/**
 * The review page before a debug start first runs. It is confirmed as `<commandSha256>:debug`: asked
 * for separately from the plain start, and again whenever the entry (its debug block included) changes.
 */
export function debugStartConfirmationRequest(entry: StartEntry, environment: string | null): ReviewConfirmationRequest {
  const debug = entry.debug!;
  const launch = debugLaunch(debug, environment);
  const attach = debugAttachConfiguration(debug.runtime, debugSessionName(entry.capability, entry.id), { port: debug.port, pid: 1 });
  return {
    title: `Start ${entry.name ?? entry.id} with its debugger for ${entry.capability}`,
    summary: 'This command comes from this checkout’s effective run configuration and runs on this computer with a debugger that listens on 127.0.0.1 only. Review it once; you are asked again when it changes.',
    detail: [
      `Capability: ${entry.capability}`,
      `Start entry: ${entryWords(entry)}`,
      launch.argv ? `Command: ${JSON.stringify(launch.argv)}`
        : `Command: ${JSON.stringify(resolvedArgv(entry, environment))}, with the debugger the engine adds for ${debug.runtime}`,
      ...dependencyLines(entry, environment),
      ...argumentsLine(entry, environment),
      ...launchLines(entry, environment),
      ...(launch.environmentNames.length ? [`Set for the application only, by the engine: ${launch.environmentNames.join(', ')}`] : []),
      ...debug.notes.map((note) => `Note: ${note}`),
      `Working directory: ${entry.workingDirectory ?? '.'}${entry.repository ? ` (repository ${entry.repository})` : ''}`,
      `Debugger: ${debugWords(debug)}`,
      debug.runtime === 'dotnet'
        ? `VS Code then attaches with: ${JSON.stringify({ type: 'coreclr', request: 'attach', processId: 'the process ID app status reports' })}`
        : `VS Code attaches once app status says the debugger listens, on ${DEBUG_HOST} at the port app status reports: ${JSON.stringify(attach ?? { host: DEBUG_HOST, port: 'the port app status reports' })}`,
      `Opens at: ${entry.url ?? 'no URL declared'}`,
      `Ready when: ${readiness(entry.ready)}${debug.suspend ? ', after the debugger attaches' : ''}`,
      environmentLine(entry, environment),
      ...otherEnvironmentLines(entry, environment, (name) => debugLaunch(debug, name).argv ?? resolvedArgv(entry, name)),
      '',
      `VS Code runs it as a task: ${displayCommand(appStartArgv(entry.capability, entry.id, environment, entry.commandSha256, true))}`,
      `Ending the debug session leaves ${entry.id} running; Stop ends it.`
    ].join('\n'),
    confirmLabel: 'Run this command'
  };
}

/** The review page shown before a test selection first runs. */
export function testsConfirmationRequest(capability: string, tests: TestCommandPlan[], commands: string[],
  environment: string | null, scope?: { workId: string; phase: string; argv: string[]; checkout: string }, notes?: TestPlanNotes | null): ReviewConfirmationRequest {
  const planned = commands.length ? tests.filter((command) => commands.includes(command.id)) : tests;
  const lines = planned.length
    ? planned.flatMap((command) => [
      `${command.id}${command.kind ? ` (${command.kind})` : ''}: ${command.argv ? JSON.stringify(command.argv) : 'argv resolved by the engine'}`,
      ...(command.workingDirectory ? [`  in ${command.workingDirectory}`] : []),
      ...(command.why ? [`  ${command.why}${command.resultsWords ? ` ${command.resultsWords}` : ''}`] : [])
    ])
    : [commands.length ? `Commands: ${commands.join(', ')}` : 'Commands: the capability\'s tests, or what its code step runs, as the engine resolves them'];
  return {
    title: `Run tests for ${scope ? `${scope.workId} · ${scope.phase}` : capability}`,
    summary: 'These test commands come from the workflow and run on this computer. Review them once; you are asked again when they change.',
    detail: [
      `Capability: ${capability}`,
      ...lines,
      ...(notes?.notUsed.length ? ['Seen and not used:', ...notes.notUsed.map((why) => `  ${why}`)] : []),
      ...(notes?.earlyChecks.length ? ['Before you start (none of these stops the run):', ...notes.earlyChecks.flatMap((check) => [`  ${check.words}`, ...(check.action ? [`  What to do: ${check.action}`] : [])])] : []),
      environment ? `Environment: ${environment}. Its values go to the test process only; VS Code never reads or shows them.` : 'Environment: none named',
      '',
      `VS Code runs it as a task: ${displayCommand(scope?.argv ?? testsRunArgv(capability, commands, environment, plannedIdentities(tests, commands)))}`,
      ...(scope ? [`Checkout: ${scope.checkout}`, `Story: ${scope.workId} · phase ${scope.phase}`, 'Results are staged for the Story evidence checks. This does not publish, submit or approve the phase.'] : ['The run is a local preview: it is shown in the test summary and never counts as evidence for a Story.'])
    ].join('\n'),
    confirmLabel: 'Run these tests'
  };
}

/** What VS Code knows of a start entry's task in this window. */
export interface StartTaskState { running: boolean; exitCode?: number | null; debug?: boolean }

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
  /** Each environment's own arguments; `current` marks the one the command above runs with. */
  arguments: Array<{ environment: string; words: string; current: boolean }>;
  /** "Java debugger at 127.0.0.1:5005" when the entry declares a debug start. */
  debug: string | null;
  /** "Debugger listening at 127.0.0.1:5005" while a debug start listens. */
  listening: string | null;
  debugNote: string | null;
  canStart: boolean; canStop: boolean; canOpen: boolean; canDebug: boolean; canAttach: boolean;
}

export interface EnvironmentRow { name: string; status: string; words: string; bound: boolean; selected: boolean }

export interface LastRunLine {
  runId: string; classLabel: string; line: string; label: string | null;
  /** Commands the engine did not run, with its reason (an unbound environment, the policy). */
  blocked: string[];
}

export interface RunAndTestState {
  plan?: StartEntry[] | null;
  planNote?: string | null;
  status?: StartStatus[] | null;
  tests?: TestCommandPlan[] | null;
  /** What `tests plan` saw and does not run, and what to do before starting. */
  testNotes?: TestPlanNotes | null;
  /** The capability's local integration policy, from `tests plan`; null when unknown. */
  localIntegration?: LocalIntegrationPolicy | null;
  lastRun?: TestSummary | null;
  lastRunNote?: string | null;
  tasks?: Record<string, StartTaskState>;
  testsRunning?: boolean;
  environment?: string | null;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
  /** The error already shown with its fixes (a missing environment file): not shown a second time. */
  prompted?: string | null;
  /** This repository's environment files (`env files --json`); null when the engine has none to report. */
  environmentFiles?: EnvironmentFile[] | null;
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
  /** Each suite in words, when the engine says them. */
  testPlan: Array<{ id: string; title: string; why: string | null; results: string | null }>;
  testNotes: TestPlanNotes;
  testsRunning: boolean;
  lastRun: LastRunLine | null;
  lastRunNote: string | null;
  /** Per environment, the files a run places and how many are missing; null without `env files`. */
  environmentFiles: Array<{ environment: string; words: string; missing: number; current: boolean }> | null;
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
    const runsIn = running ? status?.environment ?? null : entryEnvironment(entry, environment);
    const refusal = entry.debug ? debugLaunch(entry.debug, runsIn).refusal : null;
    const listening = entry.debug && status?.debug?.listening
      ? `Debugger listening at ${DEBUG_HOST}:${status.debug.port ?? entry.debug.port}` : null;
    return {
      id: entry.id, command: resolvedArgv(entry, runsIn).join(' '), workingDirectory: entry.workingDirectory, url,
      state: current, stateWords: STATE_WORDS[current],
      detail: current === 'ready' && url ? `at ${url}`
        : current === 'starting' ? `waiting ${task?.debug && entry.debug && !listening ? 'for the debugger to listen, then ' : ''}until ${readiness(entry.ready)}`
          : current === 'failed' ? `exit code ${task?.exitCode}; its task terminal says why` : null,
      environment: runsIn,
      arguments: entry.environments.filter((choice) => entry.arguments[choice.name]?.length).map((choice) => ({
        environment: choice.name, words: entry.arguments[choice.name]!.join(' '), current: choice.name === runsIn
      })),
      debug: entry.debug ? debugWords(entry.debug) : null,
      listening,
      debugNote: entry.debugIssue ? `Start (debug) is not offered: ${entry.debugIssue}.`
        : refusal ? `Start (debug) is not available: ${refusal.message}` : null,
      canStart: !running, canStop: running, canOpen: current === 'ready' && Boolean(url),
      canDebug: Boolean(entry.debug) && !refusal && !running,
      canAttach: Boolean(entry.debug) && running && debuggerReady(entry.debug!, status)
    };
  });
  const lastRun = state.lastRun?.run ? {
    runId: state.lastRun.run.id,
    classLabel: evidenceClassLabel(state.lastRun.run.evidenceClass),
    line: `${totalsLine(state.lastRun.totals)}${state.lastRun.run.environment ? ` · environment ${state.lastRun.run.environment}` : ''}${state.lastRun.run.startedAt ? ` · ${state.lastRun.run.startedAt}` : ''}`,
    label: state.lastRun.run.label || null,
    blocked: state.lastRun.commands.filter((command) => command.status === 'blocked')
      .map((command) => `${command.id}${command.environment ? ` (${command.environment})` : ''}: ${command.note ?? 'not run'}`)
  } : null;
  const fromSummary = (state.lastRun?.commands ?? []).map((command) => command.id).filter((id) => ID.test(id));
  const repositories = capability.repositories?.length ? capability.repositories : capability.repository ? [capability.repository] : [];
  const workingDirectories = [...plan.map((entry) => entry.workingDirectory), ...tests.map((command) => command.workingDirectory)];
  const environmentFiles = state.environmentFiles ? environmentFileCounts(state.environmentFiles, {
    capability: capability.id, repositories, sourceRoots: capability.sourceRoots ?? [], workingDirectories
  }, options.map((choice) => choice.name)).map((count) => ({ environment: count.environment, words: count.words, missing: count.missing, current: count.environment === environment })) : null;
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
    // Binding helps only a declared environment; an undeclared one needs an environments.yml proposal.
    bind: chosen && chosen.status !== 'bound' && chosen.status !== 'undeclared' ? bindCommand(chosen.name) : null,
    starts,
    startsNote: state.planNote ?? (state.plan && !plan.length
      ? 'No start entries are declared. Add application.start to this capability in singularity/capabilities.yml through a capability proposal.' : null),
    testCommands: tests.length ? tests.map((command) => command.id) : [...new Set(fromSummary)],
    testPlan: tests.filter((command) => command.title).map((command) => ({ id: command.id, title: command.title as string, why: command.why ?? null, results: command.resultsWords ?? null })),
    testNotes: state.testNotes ?? { notUsed: [], earlyChecks: [] },
    testsRunning: state.testsRunning === true,
    lastRun,
    lastRunNote: state.lastRunNote ?? (state.lastRun === null ? 'No test run yet.' : null),
    environmentFiles
  };
}

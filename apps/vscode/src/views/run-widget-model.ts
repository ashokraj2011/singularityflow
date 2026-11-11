/**
 * The run widget, the Run view and the Testing view, as VS Code shows them. [RUN, IntelliJ-style run
 * configurations amendment §3 and §4, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * IntelliJ keeps the selected run configuration in its toolbar with Run, Debug and Stop beside it,
 * lists every configuration with its state in the Services window, and shows tests in a tree with an
 * icon beside each test in the editor. VS Code gets the same three things from answers the run and
 * test controller already holds: `app plan`, `app status`, `tests plan` and `tests summary`. This
 * module turns them into status bar text, quick pick entries, tree rows and test items. It decides
 * nothing the engine owns: a command line shown or copied is the engine's resolved argv for the
 * environment, a state is `app status` plus this window's tasks, and a test result is the summary's.
 *
 * Pure on purpose (no `vscode` import), so the tests pin every text, state and mapping.
 */
import {
  DEBUG_HOST, entryEnvironment, environmentStatusWords, loopbackUrl, resolvedArgv, startState,
  type EnvironmentChoice, type StartEntry, type StartStatus, type StartTaskState, type TestCommandPlan
} from './run-and-test-model.ts';
import { evidenceClassLabel, totalsLine, type TestSummary, type TestSummaryCase, type TestSummaryCommand } from './test-summary-model.ts';

/** The five states IntelliJ's Services window shows a configuration in. */
export type RunState = 'stopped' | 'starting' | 'ready' | 'debugging' | 'failed';

/** What the controller holds for one capability, as the widget reads it. */
export interface CapabilityRunReading {
  capability: string;
  name: string;
  plan: StartEntry[];
  status: StartStatus[];
  tasks: Record<string, StartTaskState>;
  /** Entries this window started with --debug that are still running. */
  debugging: ReadonlySet<string>;
  /** The environment a run uses now (the remembered choice per capability, else the default). */
  chosen: string | null;
}

/** One run configuration: a start entry of a capability this checkout runs. */
export interface RunConfiguration {
  /** `<capability>/<entry>`, the selection key. */
  key: string;
  capability: string;
  capabilityName: string;
  id: string;
  name: string;
  /** `command` for an entry written as argv. */
  type: string;
  state: RunState;
  /** The environment it runs against now: the one it was started in while running. */
  environment: string | null;
  environments: EnvironmentChoice[];
  url: string | null;
  debuggable: boolean;
  /** The engine's resolved argv for that environment, and the same quoted for a terminal. */
  argv: string[];
  commandLine: string;
  workingDirectory: string | null;
  pid: number | null;
  listening: string | null;
  exitCode: number | null;
}

export const RUNNING_STATES: readonly RunState[] = ['starting', 'ready', 'debugging'];
export const isRunning = (configuration: Pick<RunConfiguration, 'state'>): boolean => RUNNING_STATES.includes(configuration.state);

/** `app status` and this window's task, as one of the five states. */
export function configurationState(status: StartStatus | undefined, task: StartTaskState | undefined, debugHeld = false): RunState {
  const base = startState(status, task);
  if (base === 'failed') return 'failed';
  if (base === 'stopped' || base === 'not-declared') return 'stopped';
  const listening = status?.debug?.listening === true;
  if (base === 'ready') return debugHeld || listening ? 'debugging' : 'ready';
  // Starting, or started and not answering yet: a debugger that listens is already attachable.
  return listening ? 'debugging' : 'starting';
}

const PLAIN = /^[\w@%+=:,./-]+$/;

/** A command line a person can paste into a POSIX shell. It is only ever shown or copied, never run. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((part) => PLAIN.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
}

/** Every configuration of every capability here, in the order `app plan` lists them. */
export function runConfigurations(readings: readonly CapabilityRunReading[]): RunConfiguration[] {
  return readings.flatMap((reading) => reading.plan.map((entry): RunConfiguration => {
    const status = reading.status.find((item) => item.id === entry.id);
    const task = reading.tasks[entry.id];
    const state = configurationState(status, task, reading.debugging.has(entry.id));
    const running = RUNNING_STATES.includes(state);
    const environment = running && status?.environment && entry.environments.some((choice) => choice.name === status.environment)
      ? status.environment : entryEnvironment(entry, reading.chosen);
    const argv = resolvedArgv(entry, environment);
    return {
      key: `${reading.capability}/${entry.id}`, capability: reading.capability, capabilityName: reading.name, id: entry.id,
      name: entry.name ?? entry.id, type: entry.type ?? 'command', state, environment, environments: entry.environments,
      url: loopbackUrl(status?.url) ?? loopbackUrl(entry.url),
      debuggable: Boolean(entry.debug),
      argv, commandLine: commandLine(argv), workingDirectory: entry.workingDirectory,
      pid: running ? status?.pid ?? null : null,
      listening: entry.debug && status?.debug?.listening ? `${DEBUG_HOST}:${status.debug.port ?? entry.debug.port}` : null,
      exitCode: task && !task.running && typeof task.exitCode === 'number' ? task.exitCode : null
    };
  }));
}

/** What the widget remembers in this workspace: the capability shown and each capability's choice. */
export interface RunSelection { capability: string | null; entries: Record<string, string> }

export function selectionFrom(value: unknown): RunSelection {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const entries = object.entries && typeof object.entries === 'object' && !Array.isArray(object.entries)
    ? Object.fromEntries(Object.entries(object.entries as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    : {};
  return { capability: typeof object.capability === 'string' ? object.capability : null, entries };
}

/** The remembered configuration when it still exists, else the capability's first, else the first. */
export function selectedConfiguration(configurations: readonly RunConfiguration[], selection: RunSelection | null): RunConfiguration | null {
  const first = configurations[0];
  if (!first) return null;
  const capability = selection?.capability && configurations.some((item) => item.capability === selection.capability) ? selection.capability : first.capability;
  const id = selection?.entries[capability];
  return configurations.find((item) => item.capability === capability && item.id === id)
    ?? configurations.find((item) => item.capability === capability) ?? first;
}

export function rememberSelection(selection: RunSelection, configuration: Pick<RunConfiguration, 'capability' | 'id'>): RunSelection {
  return { capability: configuration.capability, entries: { ...selection.entries, [configuration.capability]: configuration.id } };
}

export const RUN_WIDGET_COMMANDS = {
  select: 'singularityFlow.selectRunConfiguration',
  run: 'singularityFlow.runSelectedConfiguration',
  debug: 'singularityFlow.debugSelectedConfiguration',
  stop: 'singularityFlow.stopRunningConfiguration',
  rerun: 'singularityFlow.rerunSelectedConfiguration'
} as const;

/** The codicon in front of the selected configuration's name, by state. */
const STATE_GLYPHS: Record<RunState, string> = {
  stopped: '$(play)', starting: '$(loading~spin)', ready: '$(vm-running)', debugging: '$(debug-alt)', failed: '$(error)'
};

export const STATE_WORDS: Record<RunState, string> = {
  stopped: 'Not running', starting: 'Starting', ready: 'Ready', debugging: 'Running with the debugger', failed: 'Stopped with an error'
};

export interface StatusItemSpec { text: string; tooltip: string; command: string }
export interface WidgetSpec { configuration: StatusItemSpec; primary: StatusItemSpec; debug: StatusItemSpec | null; stop: StatusItemSpec | null }

/** "Api · dev": the name and the environment it runs against. */
export const configurationLabel = (configuration: Pick<RunConfiguration, 'name' | 'environment'>): string =>
  `${configuration.name}${configuration.environment ? ` · ${configuration.environment}` : ''}`;

function stateLine(configuration: RunConfiguration): string {
  const where = configuration.state === 'ready' || configuration.state === 'debugging' ? configuration.url : null;
  return [STATE_WORDS[configuration.state], where ? `at ${where}` : null, configuration.listening ? `debugger at ${configuration.listening}` : null,
    configuration.pid ? `pid ${configuration.pid}` : null, configuration.exitCode !== null && configuration.state === 'failed' ? `exit code ${configuration.exitCode}` : null]
    .filter(Boolean).join(' · ');
}

/** The tooltip of the widget and of a Run view row: what it is, its state, and the command line. */
export function configurationTooltip(configuration: RunConfiguration): string {
  return [
    `${configuration.name} (${configuration.type}) · ${configuration.capabilityName}`,
    stateLine(configuration),
    configuration.environment ? `Environment: ${configuration.environment}` : 'Environment: none',
    `Command line: ${configuration.commandLine}`,
    `Working directory: ${configuration.workingDirectory ?? '.'}`
  ].join('\n');
}

/**
 * The status bar run widget: the selected configuration, then Run and Debug, which become Rerun and
 * Stop once it has started. No item has a keybinding of its own.
 */
export function widgetSpec(selected: RunConfiguration): WidgetSpec {
  const label = configurationLabel(selected);
  const configuration = {
    text: `${STATE_GLYPHS[selected.state]} ${label}`,
    tooltip: `${configurationTooltip(selected)}\n\nChoose a configuration or an environment.`,
    command: RUN_WIDGET_COMMANDS.select
  };
  if (isRunning(selected)) {
    return {
      configuration,
      primary: { text: '$(debug-restart)', tooltip: `Rerun ${label}`, command: RUN_WIDGET_COMMANDS.rerun },
      debug: null,
      stop: { text: '$(debug-stop)', tooltip: `Stop ${label}`, command: RUN_WIDGET_COMMANDS.stop }
    };
  }
  return {
    configuration,
    primary: { text: '$(play)', tooltip: `Run ${label}`, command: RUN_WIDGET_COMMANDS.run },
    debug: selected.debuggable ? { text: '$(debug-alt)', tooltip: `Debug ${label}`, command: RUN_WIDGET_COMMANDS.debug } : null,
    stop: null
  };
}

/** A codicon per configuration type; IntelliJ shows its own type icons in the same places. */
const TYPE_ICONS: Record<string, string> = {
  'spring-boot': 'server-environment', jar: 'package', application: 'coffee', maven: 'tools', gradle: 'tools',
  python: 'code', django: 'globe', fastapi: 'zap', flask: 'zap', node: 'server-process', npm: 'library',
  go: 'rocket', dotnet: 'circuit-board', command: 'terminal'
};
export const typeIcon = (type: string): string => TYPE_ICONS[type] ?? 'play-circle';

export type PickEntry =
  | { kind: 'configuration'; key: string; label: string; description: string; detail: string }
  | { kind: 'environment'; capability: string; name: string; label: string; description: string; detail?: string }
  | { kind: 'separator'; label: string }
  | { kind: 'edit'; label: string; description: string };

/** The quick pick behind the widget: configurations, the selected one's environments, and Edit Configurations…. */
export function quickPickEntries(configurations: readonly RunConfiguration[], selected: RunConfiguration | null): PickEntry[] {
  const several = new Set(configurations.map((item) => item.capability)).size > 1;
  const entries: PickEntry[] = [...configurations.map((item): PickEntry => ({
    kind: 'configuration', key: item.key,
    label: `$(${typeIcon(item.type)}) ${item.name}`,
    description: [item.type, several ? item.capabilityName : null, item.key === selected?.key ? 'selected' : null].filter(Boolean).join(' · '),
    detail: [STATE_WORDS[item.state], item.environment, item.url].filter(Boolean).join(' · ')
  }))];
  if (selected && selected.environments.length) {
    entries.push({ kind: 'separator', label: `Environment · ${selected.name}` });
    for (const choice of selected.environments) {
      const bound = choice.status === 'bound' || choice.status === 'undeclared';
      entries.push({
        kind: 'environment', capability: selected.capability, name: choice.name,
        label: `${choice.name === selected.environment ? '$(check)' : '$(circle-large-outline)'} ${choice.name}`,
        description: environmentStatusWords(choice.status),
        ...(bound ? {} : { detail: `Bind its values with your own secret helper: singularity-flow env bind ${choice.name} --stdin` })
      });
    }
  }
  entries.push({ kind: 'separator', label: '' }, { kind: 'edit', label: '$(gear) Edit Configurations…', description: selected ? selected.capabilityName : '' });
  return entries;
}

/** Context values the Run view's menus key on; every one is spelled out so a menu can name it. */
const CONTEXT_VALUES: Record<RunState, { plain: string; debuggable?: string; browsable?: string }> = {
  stopped: { plain: 'sflow.runConfiguration.stopped', debuggable: 'sflow.runConfiguration.stopped.debuggable' },
  failed: { plain: 'sflow.runConfiguration.failed', debuggable: 'sflow.runConfiguration.failed.debuggable' },
  starting: { plain: 'sflow.runConfiguration.starting' },
  ready: { plain: 'sflow.runConfiguration.ready', browsable: 'sflow.runConfiguration.ready.browsable' },
  debugging: { plain: 'sflow.runConfiguration.debugging', browsable: 'sflow.runConfiguration.debugging.browsable' }
};

export function contextValue(configuration: Pick<RunConfiguration, 'state' | 'debuggable' | 'url'>): string {
  const values = CONTEXT_VALUES[configuration.state];
  if (values.debuggable && configuration.debuggable) return values.debuggable;
  if (values.browsable && configuration.url) return values.browsable;
  return values.plain;
}

/** The state icon of a Run view row and the theme color it is drawn in. */
export const STATE_ICONS: Record<RunState, { icon: string; color: string | null }> = {
  stopped: { icon: 'circle-large-outline', color: null },
  starting: { icon: 'loading~spin', color: null },
  ready: { icon: 'pass-filled', color: 'testing.iconPassed' },
  debugging: { icon: 'debug-alt', color: 'debugIcon.startForeground' },
  failed: { icon: 'error', color: 'testing.iconFailed' }
};

export type RunTreeNode =
  | { kind: 'capability'; id: string; capability: string; label: string; description: string }
  | {
    kind: 'configuration'; id: string; key: string; capability: string; entry: string; label: string; description: string;
    tooltip: string; icon: string; color: string | null; contextValue: string;
  }
  | { kind: 'message'; id: string; label: string; tooltip: string };

/** One Run view row: the name, then environment and URL, with the state as its icon. */
export function configurationRow(configuration: RunConfiguration): RunTreeNode {
  const icon = STATE_ICONS[configuration.state];
  return {
    kind: 'configuration', id: `run:${configuration.key}`, key: configuration.key, capability: configuration.capability, entry: configuration.id,
    label: configuration.name,
    description: [configuration.environment ?? 'no environment', configuration.url].filter(Boolean).join(' · '),
    tooltip: configurationTooltip(configuration), icon: icon.icon, color: icon.color, contextValue: contextValue(configuration)
  };
}

/**
 * The Run view's top level: the configurations of one capability directly, or one node per
 * capability when this checkout runs several. A capability whose plan could not be read says so.
 */
export function runTreeRoots(configurations: readonly RunConfiguration[], capabilities: ReadonlyArray<{ id: string; name: string; note: string | null }>): RunTreeNode[] {
  const notes: RunTreeNode[] = capabilities.filter((item) => item.note)
    .map((item) => ({ kind: 'message', id: `run-note:${item.id}`, label: item.note!, tooltip: `${item.name}: ${item.note}` }));
  const shown = capabilities.filter((item) => configurations.some((configuration) => configuration.capability === item.id));
  if (shown.length <= 1) return [...configurations.map(configurationRow), ...notes];
  return [...shown.map((item): RunTreeNode => {
    const own = configurations.filter((configuration) => configuration.capability === item.id);
    const running = own.filter(isRunning).length;
    return { kind: 'capability', id: `run-capability:${item.id}`, capability: item.id, label: item.name,
      description: `${own.length} configuration${own.length === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}` };
  }), ...notes];
}

export const capabilityChildren = (configurations: readonly RunConfiguration[], capability: string): RunTreeNode[] =>
  configurations.filter((item) => item.capability === capability).map(configurationRow);

// ---------------------------------------------------------------------------------------------
// The Testing view: one item per test command, its test cases from the latest summary.

export interface TestItemSpec { id: string; label: string; description: string | null; tooltip: string | null }
export interface CommandItemSpec extends TestItemSpec { capability: string; command: string; perCase: boolean }
export interface CaseItemSpec extends TestItemSpec { capability: string; command: string; file: string | null; line: number | null; sortText: string }

/** The repository-relative file of a case, only when it cannot leave the repository. */
export function safeCaseFile(file: string | null | undefined): string | null {
  if (!file || /[\u0000-\u001f]/.test(file)) return null;
  const candidate = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:/.test(candidate) || candidate.split('/').includes('..')) return null;
  return candidate;
}

/** The test commands of a capability: `tests plan`, then any the latest summary adds (an older engine). */
export function testCommandItems(capability: string, plan: readonly TestCommandPlan[] | null, summary: TestSummary | null): CommandItemSpec[] {
  const planned = plan ?? [];
  const extra = (summary?.commands ?? []).filter((command) => !planned.some((item) => item.id === command.id));
  return [...planned.map((item) => ({ id: item.id, kind: item.kind, adapter: item.adapter, argv: item.argv, words: [item.why, item.resultsWords].filter(Boolean).join(' ') })),
    ...extra.map((command) => ({ id: command.id, kind: command.kind, adapter: command.adapter, argv: null, words: '' }))].map((item): CommandItemSpec => {
    const reported = summary?.commands.find((command) => command.id === item.id);
    const adapter = reported?.adapter ?? item.adapter;
    return {
      id: `${capability}/${item.id}`, capability, command: item.id, label: item.id,
      description: [item.kind && item.kind !== 'test' ? item.kind : null, adapter].filter(Boolean).join(' · ') || null,
      tooltip: [item.argv ? commandLine(item.argv) : null, item.words || null].filter(Boolean).join('\n') || null,
      perCase: reported ? reported.perCase : true
    };
  });
}

/** One item per test case of a command in the summary, with its file and line for the editor's icons. */
export function testCaseItems(capability: string, command: string, summary: TestSummary | null): CaseItemSpec[] {
  const seen = new Map<string, number>();
  return (summary?.cases ?? []).filter((entry) => (entry.command || 'other') === command).map((entry): CaseItemSpec => {
    const base = JSON.stringify([entry.suite ?? '', entry.name]);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const file = safeCaseFile(entry.file);
    return {
      id: count === 1 ? base : `${base}#${count}`, capability, command, label: entry.name,
      description: entry.suite, tooltip: [file ? `${file}${entry.line ? `:${entry.line}` : ''}` : null, entry.clauses.length ? entry.clauses.join(', ') : null].filter(Boolean).join('\n') || null,
      file, line: entry.line,
      sortText: `${file ?? '~'}:${String(entry.line ?? 0).padStart(8, '0')}`
    };
  });
}

/** What one test target in a Testing view request selects. `command` null means the whole capability. */
export interface TestTarget { capability: string; command: string | null }

export interface TestRunPlan { capability: string; commands: string[]; every: boolean }

/**
 * Which commands a request runs, per capability. The engine runs whole commands, so a test case
 * selects its command, and "Rerun Failed Tests" reruns the commands that have failures. A request
 * covering every command passes none, so the run resolves exactly as "Run all tests" does.
 */
export function testRunPlans(include: readonly TestTarget[] | null, exclude: readonly TestTarget[], all: Readonly<Record<string, readonly string[]>>): TestRunPlan[] {
  const chosen = new Map<string, Set<string>>();
  const add = (capability: string, commands: readonly string[]) => {
    if (!all[capability]) return;
    const set = chosen.get(capability) ?? new Set<string>();
    for (const command of commands) if (all[capability]!.includes(command)) set.add(command);
    chosen.set(capability, set);
  };
  if (!include) for (const [capability, commands] of Object.entries(all)) add(capability, commands);
  else for (const target of include) add(target.capability, target.command ? [target.command] : all[target.capability] ?? []);
  for (const target of exclude) {
    if (!target.command) chosen.delete(target.capability);
    else chosen.get(target.capability)?.delete(target.command);
  }
  return [...chosen.entries()].filter(([, commands]) => commands.size).map(([capability, commands]) => {
    const ordered = all[capability]!.filter((command) => commands.has(command));
    const every = ordered.length === all[capability]!.length && !exclude.some((target) => target.capability === capability);
    return { capability, commands: every ? [] : ordered, every };
  });
}

export type TestOutcome = 'passed' | 'failed' | 'skipped' | 'errored';

/** A case's outcome as the Testing view reports it; a flaky case passed in the end. */
export function caseOutcome(outcome: string): TestOutcome {
  if (outcome === 'passed' || outcome === 'flaky') return 'passed';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'skipped') return 'skipped';
  return 'errored';
}

export function caseMessage(entry: Pick<TestSummaryCase, 'name' | 'message' | 'outcome'>): string {
  if (entry.message) return entry.message;
  return entry.outcome === 'failed'
    ? `${entry.name} failed. The report gives no message; the task terminal and the Test summary page show the run.`
    : `${entry.name}: the report says ${entry.outcome}.`;
}

/**
 * A command's own result: what the Testing view shows on its item, and on it alone when the
 * report gives totals only (`perCase: false`).
 */
export function commandOutcome(command: TestSummaryCommand): { outcome: TestOutcome; message: string | null } {
  const counts = command.counts;
  const tally = counts ? `${counts.passed} passed${counts.failed ? `, ${counts.failed} failed` : ''}${counts.skipped ? `, ${counts.skipped} skipped` : ''} of ${counts.discovered}` : null;
  const words = [tally, command.note].filter(Boolean).join('. ') || null;
  if (command.status === 'passed') return { outcome: 'passed', message: words };
  if (command.status === 'failed') return { outcome: 'failed', message: words ?? `${command.id} failed${command.exitCode !== null ? ` with exit code ${command.exitCode}` : ''}.` };
  if (command.status === 'skipped') return { outcome: 'skipped', message: words };
  return { outcome: 'errored', message: words ?? `${command.id} was not run (${command.status ?? 'no status'}).` };
}

/** The lines the Testing view writes into a run's output: the engine's label first, with its class. */
export function runOutputLines(summary: TestSummary): string[] {
  const run = summary.run;
  if (!run) return ['The engine recorded no test run.'];
  return [
    `${run.label || evidenceClassLabel(run.evidenceClass)} [${run.evidenceClass}]`,
    `Run ${run.id}${run.environment ? `, environment ${run.environment}` : ''}${run.commit ? ', on your latest commit' : ''}${run.uncommittedChanges ? ', with uncommitted changes' : ''}: ${totalsLine(summary.totals)}.`,
    ...summary.commands.filter((command) => command.label && command.label !== run.label).map((command) => `${command.id}: ${command.label}`),
    ...summary.commands.filter((command) => command.note).map((command) => `${command.id}: ${command.note}`),
    ...(summary.truncated ? ['The summary lists the first 5,000 test cases; the Test summary page has the run.'] : [])
  ];
}

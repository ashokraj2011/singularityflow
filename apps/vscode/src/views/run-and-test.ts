/**
 * Start a capability's application and run its tests from VS Code. [RUN, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * Starting runs `singularity-flow app start <id> --capability <ID> [--environment ENV]` as a VS Code
 * task: a process execution of the CLI's argv, never a shell string, so its terminal shows the log
 * and ending the task stops it. The CLI owns the environment's values and the readiness check; VS
 * Code passes only names. Test runs are tasks the same way. The state shown is `app status --json`,
 * read again while a start is waiting and whenever a task ends.
 *
 * Nothing runs in an untrusted workspace. The first run of each command identity (`commandSha256`
 * from `app plan`, or from `tests plan`) asks for confirmation on a review page, remembered for this
 * workspace; a changed command asks again.
 *
 * Start (debug) runs the same task with `--debug`, confirmed separately (`<commandSha256>:debug`). Once
 * `app status` says the debugger listens (for .NET: once the process has a pid), VS Code attaches
 * with a loopback configuration built from the port or pid the engine reported, never from the
 * page. Ending the debug session leaves the application running; Stop still ends it.
 *
 * The capability page, the run widget, the Run view and the Testing view (run-widget.ts,
 * run-testing.ts) all act through this one controller, so trust, the confirmations, the tasks and
 * the state they show are the same wherever a run starts.
 *
 * Before a run in an environment, the files of that environment it would place are checked in the
 * `env files --json` read the plan is read with. A missing one stops the run before any task opens,
 * with plain words and the fixes (Create from template, Use existing file…, Open Environment Files)
 * instead of a refusal in a terminal; a run whose task ended with an error is checked the same way.
 * [ENVF, docs/SPEC-ENVIRONMENT-FILES-v1.md]
 */
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { CapabilityNode } from '../cli/snapshot.ts';
import { showCompactWarningMessage } from '../compact-message.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import {
  appPlanArgv, appPlanFrom, appPlanHereArgv, appStartArgv, appStatusArgv, appStatusFrom, appStopArgv, bindCommand, buildRunAndTestView,
  capabilitiesHere, chooseEnvironment, CONFIRMED_COMMANDS_KEY, debugAttachPlan, debugConfirmationKey, debuggerReady, debugLaunch,
  debugStartConfirmationRequest, entryEnvironment,
  environmentOptions, environmentStatusWords, ENVIRONMENT_CHOICES_KEY, findCapability, localIntegrationPolicy, loopbackUrl, missingDebuggerMessage, ownershipOf,
  rememberConfirmed, startConfirmationRequest, plannedIdentities, startRefusal, testPlanFrom, testsConfirmationKeys, testsConfirmationRequest,
  testsEnvironment, testsPlanArgv, testsRunArgv, unwrapResult, type DebugRuntime, type Ownership, type RunAndTestState, type StartEntry
} from './run-and-test-model.ts';
import { RunSuggestionsPanel, type RunSuggestionsHost } from './run-suggestions.ts';
import { RunConfigurationsPanel } from './run-configurations.ts';
import { runAndTestHtml } from './run-and-test-page.ts';
import { testsSummaryArgv, testSummaryFrom, totalsLine } from './test-summary-model.ts';
import { TestSummaryPanel } from './test-summary.ts';
import { taskStartFolder } from '../terminal-start.ts';
import {
  envFilesArgv, environmentFilesFrom, missingAsFile, missingAtWorkspaceLevel, missingForRun, missingFromRefusal, preflightButtons, preflightMessage,
  PREFLIGHT_CREATE, PREFLIGHT_LINK, PREFLIGHT_OPEN, refusalWords, trackedForRun, trackedMessage, type EnvironmentFile, type MissingFile
} from './environment-files-model.ts';
import { createEnvironmentFile, EnvironmentFilesPanel, onEnvironmentFilesChanged, useExistingEnvironmentFile } from './environment-files.ts';

export interface RunAndTestHost extends Omit<RunSuggestionsHost, 'client' | 'output'> {
  client: SingularityFlowClient;
  /** This workspace's memento: confirmed command identities and the chosen environment per capability. */
  state: vscode.Memento;
  output?: { appendLine(line: string): void };
  activeRepositoryId(): string | null;
  capabilities(): CapabilityNode[];
  /** The Story selected in this window, for the Story-scope summary. */
  workId?(): string | null;
}

export const TASK_TYPE = 'singularityFlow';
const POLL_MS = 1_500;
const STOP_SETTLE_READS = 6;
const STOP_SETTLE_MS = 500;
const UNTRUSTED = 'This workspace is not trusted, so Singularity Flow runs no application or test command here. Trust it (Manage Workspace Trust), then try again.';

/** A test run's task ended: the Testing view reads the run it recorded. */
export interface TestsEnded { capability: string; execution: vscode.TaskExecution; exitCode: number | null; cancelled: boolean }

/** What the run widget, the Run view and the Testing view read of one capability. */
export interface RunAndTestReading extends Readonly<RunAndTestState> {
  /** The environment a run uses now: the remembered choice when still allowed, else the default. */
  chosen: string | null;
  /** Entries this window started with --debug that are still running. */
  debugging: ReadonlySet<string>;
}

interface Held {
  execution: vscode.TaskExecution; capability: string; entry: string | null; stopping: boolean;
  /** The environment it runs in, for the environment-file check when it ends with an error. */
  environment?: string | null;
  /** Started with --debug: attach once `app status` says the debugger listens. */
  debug?: { runtime: DebugRuntime; attached: boolean };
}

const failureCode = (error: unknown): string => {
  const result = (error as { result?: { error?: { code?: unknown }; code?: unknown } } | null)?.result;
  return String(result?.error?.code ?? result?.code ?? '');
};

export class RunAndTest implements vscode.Disposable {
  private static instance: RunAndTest | null = null;
  static attach(host: RunAndTestHost): RunAndTest {
    if (!RunAndTest.instance) RunAndTest.instance = new RunAndTest(host);
    else RunAndTest.instance.host = host;
    return RunAndTest.instance;
  }
  static get current(): RunAndTest | null { return RunAndTest.instance; }

  private readonly changed = new vscode.EventEmitter<string>();
  readonly onDidChange = this.changed.event;
  private readonly testsEnded = new vscode.EventEmitter<TestsEnded>();
  readonly onDidEndTests = this.testsEnded.event;
  /** The terminal name of each start entry's last task: its log stays there after it ends. */
  private readonly taskNames = new Map<string, string>();
  private readonly states = new Map<string, RunAndTestState>();
  private readonly held = new Map<string, Held>();
  private readonly polls = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The capability the engine resolves for this checkout (`app plan --json`), per repository. */
  private here: { repository: string; capability: string | null } | null = null;
  private hereReading: Promise<string | null> | null = null;
  /** This repository's environment files, read with the plan; null when the engine has no `env files`. */
  private environmentFiles: { repository: string; files: EnvironmentFile[] | null; workspace: string | null } | null = null;
  /** Missing environment files the engine named when it refused a plan read (ENV_FILE_MISSING), per capability. */
  private readonly refusals = new Map<string, MissingFile[]>();

  private constructor(private host: RunAndTestHost) {
    // A file created, linked or moved anywhere (the Environment Files page) changes the counts here.
    this.subscriptions.push(onEnvironmentFilesChanged((repository) => {
      if (repository === this.host.client.repository) void this.readEnvironmentFiles();
    }));
    const tasks = (vscode as { tasks?: typeof vscode.tasks }).tasks;
    if (tasks?.onDidEndTaskProcess) this.subscriptions.push(tasks.onDidEndTaskProcess((event) => this.ended(event.execution, event.exitCode ?? null)));
    // A process that never started still ends its task; that is the only signal it gives.
    if (tasks?.onDidEndTask) this.subscriptions.push(tasks.onDidEndTask((event) => this.ended(event.execution, null)));
  }

  private key(capability: string, entry: string | null = null): string {
    return `${this.host.client.repository}\u0000${capability}\u0000${entry ?? '#tests'}`;
  }

  private stateOf(capability: string): RunAndTestState {
    const key = this.key(capability, '#state');
    let state = this.states.get(key);
    if (!state) { state = {}; this.states.set(key, state); }
    return state;
  }

  private update(capability: string, change: Partial<RunAndTestState>): void {
    Object.assign(this.stateOf(capability), change);
    this.changed.fire(capability);
  }

  private remembered(capability: string): string | null {
    return this.host.state.get<Record<string, string>>(ENVIRONMENT_CHOICES_KEY, {})?.[capability] ?? null;
  }

  private chosenEnvironment(capability: string): string | null {
    const state = this.stateOf(capability);
    return chooseEnvironment(environmentOptions(state.plan ?? [], state.tests ?? []), this.remembered(capability));
  }

  /**
   * Which capability the engine runs for this checkout. Asked only when the window does not know its
   * repository ID (a folder opened directly): `app plan` without --capability answers with the
   * capability that owns the checkout, the one `app start` and `tests run` would use.
   */
  private resolveHere(): Promise<string | null> {
    const repository = this.host.client.repository;
    if (this.here?.repository === repository) return Promise.resolve(this.here.capability);
    this.hereReading ??= (async () => {
      let capability: string | null = null;
      try {
        const answer = unwrapResult(await this.host.client.run(appPlanHereArgv())) as { capability?: unknown } | null;
        capability = typeof answer?.capability === 'string' ? answer.capability : null;
      } catch { capability = null; }
      this.here = { repository, capability };
      this.hereReading = null;
      this.changed.fire('*');
      return capability;
    })();
    return this.hereReading;
  }

  /** The Test setup check; when the window does not know its repository, the engine's answer. */
  private ownership(capability: CapabilityNode): Ownership | 'resolving' {
    const ownership = ownershipOf(capability, this.host.activeRepositoryId());
    if (ownership !== 'unknown-repository') return ownership;
    const known = this.here?.repository === this.host.client.repository ? this.here : null;
    if (!known) { void this.resolveHere(); return 'resolving'; }
    if (!known.capability) return 'unknown-repository';
    return known.capability === capability.id ? 'here' : 'elsewhere';
  }

  /** What this window knows of one capability, with this window's running tasks merged in. */
  reading(capability: string): RunAndTestReading {
    const state = this.stateOf(capability);
    const tasks: NonNullable<RunAndTestState['tasks']> = { ...(state.tasks ?? {}) };
    const debugging = new Set<string>();
    for (const held of this.held.values()) {
      if (held.capability !== capability || !held.entry) continue;
      tasks[held.entry] = { running: true, ...(held.debug ? { debug: true } : {}) };
      if (held.debug) debugging.add(held.entry);
    }
    return { ...state, tasks, testsRunning: this.held.has(this.key(capability)), chosen: this.chosenEnvironment(capability), debugging };
  }

  /** The delivery capabilities this checkout runs: the map's, else the one the engine resolves here. */
  async capabilityIdsHere(): Promise<string[]> {
    const active = this.host.activeRepositoryId();
    const here = capabilitiesHere(this.host.capabilities(), active).map((node) => node.id);
    if (here.length || active) return here;
    const resolved = await this.resolveHere();
    return resolved && findCapability(this.host.capabilities(), resolved) ? [resolved] : [];
  }

  /** `app status --json` again, for a light poll while something runs. */
  refreshStatus(capability: string): Promise<void> { return this.readStatus(capability); }

  /** Forget the last notice and error, before an action whose own words should be shown. */
  clearMessages(capability: string): void { this.update(capability, { error: null, notice: null, prompted: null }); }

  /** The task terminal a start entry's log is in: its current task, else the last one this window ran. */
  taskName(capability: string, entry: string): string | null {
    return this.held.get(this.key(capability, entry))?.execution.task?.name ?? this.taskNames.get(this.key(capability, entry)) ?? null;
  }

  /** The section's markup for one capability; reading it starts the first load. */
  sectionHtml(capability: CapabilityNode): string {
    const ownership = this.ownership(capability);
    if (ownership === 'resolving') return '';
    if (ownership !== 'here') return runAndTestHtml(buildRunAndTestView(capability, ownership, {}));
    const state = this.stateOf(capability.id);
    if (state.plan === undefined && !state.loading) void this.load(capability.id);
    const tasks: NonNullable<RunAndTestState['tasks']> = { ...(state.tasks ?? {}) };
    for (const held of this.held.values()) {
      if (held.capability === capability.id && held.entry) tasks[held.entry] = { running: true, ...(held.debug ? { debug: true } : {}) };
    }
    return runAndTestHtml(buildRunAndTestView(capability, ownership, {
      ...state, tasks, environment: this.remembered(capability.id), testsRunning: this.held.has(this.key(capability.id)),
      environmentFiles: this.filesHere()
    }));
  }

  /** The environment files read last for this window's repository; null when unknown or unsupported. */
  private filesHere(): EnvironmentFile[] | null {
    return this.environmentFiles?.repository === this.host.client.repository ? this.environmentFiles.files : null;
  }

  private keepEnvironmentFiles(repository: string, answer: PromiseSettledResult<unknown>): void {
    // An engine without `env files`, or a failed read, shows no counts and checks nothing: the engine still refuses.
    const reading = answer.status === 'fulfilled' ? environmentFilesFrom(answer.value) : null;
    this.environmentFiles = { repository, files: reading?.files ?? null, workspace: reading?.workspace ?? null };
  }

  /** `env files --json` again, after something changed a file; every section here redraws. */
  private async readEnvironmentFiles(): Promise<EnvironmentFile[] | null> {
    const repository = this.host.client.repository;
    const [answer] = await Promise.allSettled([this.host.client.run(envFilesArgv())]);
    this.keepEnvironmentFiles(repository, answer);
    this.changed.fire('*');
    return this.filesHere();
  }

  /** Plan, status, the test plan (when the engine offers it) and the last run, read together. */
  async load(capability: string): Promise<void> {
    this.update(capability, { loading: true });
    const { client } = this.host;
    const repository = client.repository;
    const [plan, status, tests, last, files] = await Promise.allSettled([
      client.run(appPlanArgv(capability)), client.run(appStatusArgv(capability)),
      client.run(testsPlanArgv(capability)), client.run(testsSummaryArgv({ kind: 'capability', capability })),
      client.run(envFilesArgv())
    ]);
    this.keepEnvironmentFiles(repository, files);
    this.refusals.set(this.key(capability, '#files'), [plan, tests].flatMap((answer) =>
      answer.status === 'rejected' ? missingFromRefusal((answer.reason as { result?: unknown } | null)?.result) : []));
    const parsed = plan.status === 'fulfilled' ? appPlanFrom(plan.value) : null;
    const summary = last.status === 'fulfilled' ? testSummaryFrom(last.value) : null;
    const lastCode = last.status === 'rejected' ? failureCode(last.reason) : '';
    this.update(capability, {
      loading: false,
      error: null,
      plan: parsed?.entries ?? [],
      planNote: plan.status === 'rejected' ? `The start entries could not be read: ${(plan.reason as Error).message}`
        : parsed?.dropped.length ? `Not shown, because the engine's answer for them is incomplete: ${parsed.dropped.join(', ')}.` : null,
      status: status.status === 'fulfilled' ? appStatusFrom(status.value) : null,
      tests: tests.status === 'fulfilled' ? testPlanFrom(tests.value) : null,
      localIntegration: tests.status === 'fulfilled' ? localIntegrationPolicy(tests.value) : null,
      lastRun: summary?.run ? summary : null,
      lastRunNote: summary?.run || last.status === 'fulfilled' || /NO_|NOT_FOUND|NONE/.test(lastCode) ? null
        : `The last test run could not be read: ${(last.reason as Error).message}`
    });
  }

  private async readStatus(capability: string): Promise<void> {
    try {
      this.update(capability, { status: appStatusFrom(await this.host.client.run(appStatusArgv(capability))) });
    } catch (error) {
      this.update(capability, { error: `The application state could not be read: ${(error as Error).message}` });
    }
  }

  /** Read status until the entry answers, its task ends or the readiness timeout (plus margin) passes. */
  private poll(capability: string, entry: StartEntry): void {
    const key = this.key(capability, entry.id);
    clearTimeout(this.polls.get(key));
    const deadline = Date.now() + (entry.ready?.timeoutMs ?? 120_000) + 15_000;
    const tick = async () => {
      this.polls.delete(key);
      await this.readStatus(capability);
      const status = this.stateOf(capability).status?.find((item) => item.id === entry.id);
      const held = this.held.get(key);
      // A suspended JVM is ready only after the debugger attaches, so attaching comes first.
      if (held?.debug && !held.debug.attached && entry.debug && debuggerReady(entry.debug, status)) {
        held.debug.attached = true;
        await this.attachTo(capability, entry, status);
      }
      const waitingToAttach = Boolean(held?.debug && !held.debug.attached);
      if (status?.ready && !waitingToAttach) return held?.debug ? undefined : this.update(capability, { notice: null });
      if (!this.held.has(key)) return;
      if (Date.now() > deadline) {
        if (!waitingToAttach) return;
        return this.update(capability, { notice: null,
          error: `${entry.id} is running, but app status never said its debugger was listening, so VS Code attached nothing. Its task terminal says why; Stop ends it.` });
      }
      this.polls.set(key, setTimeout(() => void tick(), POLL_MS));
    };
    this.polls.set(key, setTimeout(() => void tick(), POLL_MS));
  }

  private trusted(capability: string): boolean {
    if (vscode.workspace.isTrusted === true) return true;
    this.update(capability, { error: UNTRUSTED, notice: null });
    void showCompactWarningMessage(UNTRUSTED);
    return false;
  }

  /** What a run of the capability places, for the environment-file check: its repositories and roots. */
  private runScope(capability: string, workingDirectories: Array<string | null>) {
    const node = findCapability(this.host.capabilities(), capability);
    const repositories = node?.repositories?.length ? node.repositories : node?.repository ? [node.repository] : [];
    return { capability, repositories, sourceRoots: node?.sourceRoots ?? [], workingDirectories };
  }

  /**
   * Before a run in an environment: when a file of it that this run places is missing here, the run
   * is not started; the person sees why and the fixes instead of a refusal in a task terminal.
   */
  private async filesMissing(capability: string, environment: string | null, run: { kind: 'start' | 'debug' | 'tests'; label: string },
    workingDirectories: Array<string | null>): Promise<boolean> {
    if (!environment) return false;
    // The engine's own refusal of the plan read (ENV_FILE_MISSING) counts as much as what the list says.
    const refused = (this.refusals.get(this.key(capability, '#files')) ?? []).filter((file) => file.environment === environment);
    const files = this.filesHere();
    const scope = { environment, ...this.runScope(capability, workingDirectories) };
    // A path Git tracks is refused by the engine whatever else is ready: said first, with the page to look at.
    const tracked = files ? trackedForRun(files, scope) : [];
    if (tracked.length) {
      const message = trackedMessage(run, environment, tracked);
      this.update(capability, { error: message, notice: null, prompted: message });
      void showCompactWarningMessage(message, PREFLIGHT_OPEN).then((choice) => {
        if (choice === PREFLIGHT_OPEN) EnvironmentFilesPanel.show(this.host, { environment, capability });
      });
      return true;
    }
    const listed = files ? [...missingForRun(files, scope), ...await this.workspaceFilesMissing(environment)] : [];
    const missing = [...listed, ...refused.filter((file) => !listed.some((other) => other.path === file.path && other.repository === file.repository))];
    if (!missing.length) return false;
    this.refuseMissing(capability, environment, run, missing);
    return true;
  }

  /**
   * A checkout of a workspace member: a run places the workspace's own files of the environment too
   * (its root .env). Only a `--workspace` read lists them, so it is asked for that environment alone.
   */
  private async workspaceFilesMissing(environment: string): Promise<MissingFile[]> {
    if (!this.environmentFiles?.workspace || this.environmentFiles.repository !== this.host.client.repository) return [];
    try {
      const reading = environmentFilesFrom(await this.host.client.run(envFilesArgv({ environment, scope: 'workspace' })));
      return reading ? missingAtWorkspaceLevel(reading.files, environment) : [];
    } catch { return []; }
  }

  private refuseMissing(capability: string, environment: string, run: { kind: 'start' | 'debug' | 'tests'; label: string; exitCode?: number | null },
    missing: MissingFile[]): void {
    const message = preflightMessage(run, environment, missing);
    for (const command of missing.flatMap((file) => file.commands)) this.host.output?.appendLine(`  ${command}`);
    this.update(capability, { error: message, notice: null, prompted: message });
    void this.offerFixes(capability, environment, missing, message);
  }

  /** The message with its fixes; whatever the person picks runs through the Environment Files actions. */
  private async offerFixes(capability: string, environment: string, missing: MissingFile[], message: string): Promise<void> {
    const choice = await showCompactWarningMessage(message, ...preflightButtons(missing));
    const target = { activeRepository: this.host.activeRepositoryId(), scope: 'repository' as const };
    try {
      if (choice === PREFLIGHT_CREATE) {
        for (const file of missing) await createEnvironmentFile(this.host, missingAsFile(file), true, target);
        this.update(capability, { error: null, prompted: null, notice: missing.length === 1
          ? `Created ${missing[0]!.path} for ${environment} from its template and opened it. Fill in its values, then run again.`
          : `Created ${missing.length} files for ${environment} from their templates and opened them. Fill in their values, then run again.` });
      } else if (choice === PREFLIGHT_LINK) {
        if (await useExistingEnvironmentFile(this.host, missingAsFile(missing[0]!), target)) {
          this.update(capability, { error: null, prompted: null, notice: `${missing[0]!.path} now uses the file you chose for ${environment}. Run again.` });
        }
      } else if (choice === PREFLIGHT_OPEN) {
        EnvironmentFilesPanel.show(this.host, { environment, capability, scope: missing.some((file) => file.workspaceLevel) ? 'workspace' : null });
      }
    } catch (error) {
      this.update(capability, { error: refusalWords(error), notice: null, prompted: null });
    }
  }

  /**
   * A run that ended with an error may have been refused for a missing file (the file went after the
   * check, or another check of the engine's): read the files again and offer the same fixes.
   */
  private async checkFilesAfter(held: Held, exitCode: number | null, readAgain = true): Promise<void> {
    if (held.stopping || !held.environment || exitCode === null || exitCode === 0) return;
    const files = readAgain ? await this.readEnvironmentFiles() : this.filesHere();
    if (!files) return;
    const entry = held.entry ? this.stateOf(held.capability).plan?.find((item) => item.id === held.entry) : null;
    const working = held.entry ? [entry?.workingDirectory ?? null] : (this.stateOf(held.capability).tests ?? []).map((command) => command.workingDirectory);
    const missing = [...missingForRun(files, { environment: held.environment, ...this.runScope(held.capability, working) }),
      ...await this.workspaceFilesMissing(held.environment)];
    if (missing.length) this.refuseMissing(held.capability, held.environment, { kind: held.entry ? 'start' : 'tests',
      label: held.entry ?? `Tests for ${held.capability}`, exitCode }, missing);
  }

  /** Ask once per command identity; remember the answer for this workspace. */
  private async confirmed(keys: string[], request: Parameters<typeof collectReviewConfirmation>[0]): Promise<boolean> {
    const known = this.host.state.get<string[]>(CONFIRMED_COMMANDS_KEY, []) ?? [];
    if (keys.every((key) => known.includes(key))) return true;
    if (!await collectReviewConfirmation(request)) return false;
    await this.host.state.update(CONFIRMED_COMMANDS_KEY, rememberConfirmed(this.host.state.get<string[]>(CONFIRMED_COMMANDS_KEY, []) ?? [], keys));
    return true;
  }

  private task(action: 'app-start' | 'tests-run', capability: string, entry: string | null, environment: string | null, argv: string[],
    debug = false): vscode.Task {
    const { client } = this.host;
    const repository = client.repository;
    const env: Record<string, string> = {
      // The window's repository, as every CLI call from this window names it. Never a value.
      SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: path.resolve(repository) })
    };
    // The editor's own runtime runs the CLI only as Node; a separately configured Node needs nothing.
    if (process.versions.electron && client.location.executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    const execution = new vscode.ProcessExecution(client.location.executable, [client.location.cli, ...argv], { cwd: taskStartFolder(repository), env });
    // Each run keeps its own terminal, named by configuration and environment, as IntelliJ's run tabs are.
    const configuration = action === 'app-start' ? this.stateOf(capability).plan?.find((item) => item.id === entry) : null;
    const label = configuration?.name ?? entry;
    const name = action === 'app-start'
      ? `Start ${label}${environment ? ` · ${environment}` : ''}${debug ? ' (debug)' : ''} · ${capability}` : `Tests · ${capability}`;
    if (action === 'app-start' && entry) this.taskNames.set(this.key(capability, entry), name);
    const task = new vscode.Task({ type: TASK_TYPE, action, capability, ...(entry ? { entry } : {}), ...(environment ? { environment } : {}),
      ...(debug ? { debug: true } : {}) },
      vscode.TaskScope.Workspace, name, 'Singularity Flow', execution, []);
    task.isBackground = action === 'app-start';
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true, focus: false, showReuseMessage: false };
    return task;
  }

  private async execute(capability: string, task: vscode.Task): Promise<vscode.TaskExecution | null> {
    try {
      return await vscode.tasks.executeTask(task);
    } catch (error) {
      this.update(capability, { error: `VS Code could not start the task: ${(error as Error).message}`, notice: null });
      return null;
    }
  }

  private log(argv: string[]): void { this.host.output?.appendLine(`\n$ singularity-flow ${argv.join(' ')}`); }

  /** Start one entry as a task, after trust and the first-run confirmation of its command identity. */
  async start(capability: string, entryId: string): Promise<void> {
    if (!this.trusted(capability)) return;
    if (this.held.has(this.key(capability, entryId))) return this.update(capability, { notice: `${entryId} is already running in its task terminal.`, error: null });
    // Read the plan now: what is confirmed must be what the engine will run.
    await this.load(capability);
    const entry = this.stateOf(capability).plan?.find((item) => item.id === entryId);
    if (!entry) return this.update(capability, { error: `${entryId} is not a start entry of ${capability} any more.`, notice: null });
    const environment = entryEnvironment(entry, this.chosenEnvironment(capability));
    const refusal = startRefusal(entry, environment, this.stateOf(capability).localIntegration ?? null);
    if (refusal) return this.update(capability, { error: refusal, notice: null });
    if (await this.filesMissing(capability, environment, { kind: 'start', label: entry.id }, [entry.workingDirectory])) return;
    if (!await this.confirmed([entry.commandSha256], startConfirmationRequest(entry, environment))) {
      return this.update(capability, { notice: 'Nothing was started.', error: null });
    }
    const argv = appStartArgv(capability, entry.id, environment, entry.commandSha256);
    this.log(argv);
    const execution = await this.execute(capability, this.task('app-start', capability, entry.id, environment, argv));
    if (!execution) return;
    this.held.set(this.key(capability, entry.id), { execution, capability, entry: entry.id, stopping: false, environment });
    const tasks = { ...(this.stateOf(capability).tasks ?? {}) };
    delete tasks[entry.id];
    this.update(capability, { tasks, notice: `Starting ${entry.id}${environment ? ` against ${environment}` : ''}. Its log is in the task terminal.`, error: null });
    this.poll(capability, entry);
  }

  /**
   * Start one entry with its debugger, as a task, after trust and the first-run confirmation of its
   * debug start; then attach once `app status` says the debugger listens.
   */
  async startDebug(capability: string, entryId: string): Promise<void> {
    if (!this.trusted(capability)) return;
    if (this.held.has(this.key(capability, entryId))) {
      return this.update(capability, { notice: `${entryId} is already running in its task terminal. Stop it first to start it with the debugger.`, error: null });
    }
    await this.load(capability);
    const entry = this.stateOf(capability).plan?.find((item) => item.id === entryId);
    if (!entry) return this.update(capability, { error: `${entryId} is not a start entry of ${capability} any more.`, notice: null });
    if (!entry.debug) {
      return this.update(capability, { error: entry.debugIssue ? `${entryId} was not started: ${entry.debugIssue}.` : `${entryId} declares no debug block in singularity/capabilities.yml.`, notice: null });
    }
    const environment = entryEnvironment(entry, this.chosenEnvironment(capability));
    const refusal = startRefusal(entry, environment, this.stateOf(capability).localIntegration ?? null);
    if (refusal) return this.update(capability, { error: refusal, notice: null });
    // The engine would refuse it before anything runs (a missing debugpy or dlv, yarn): say so here.
    const declined = debugLaunch(entry.debug, environment).refusal;
    if (declined) return this.update(capability, { error: `${entryId} was not started: ${declined.message}`, notice: null });
    if (await this.filesMissing(capability, environment, { kind: 'debug', label: entry.id }, [entry.workingDirectory])) return;
    if (!await this.confirmed([debugConfirmationKey(entry)], debugStartConfirmationRequest(entry, environment))) {
      return this.update(capability, { notice: 'Nothing was started.', error: null });
    }
    const argv = appStartArgv(capability, entry.id, environment, entry.commandSha256, true);
    this.log(argv);
    const execution = await this.execute(capability, this.task('app-start', capability, entry.id, environment, argv, true));
    if (!execution) return;
    this.held.set(this.key(capability, entry.id), { execution, capability, entry: entry.id, stopping: false, environment, debug: { runtime: entry.debug.runtime, attached: false } });
    const tasks = { ...(this.stateOf(capability).tasks ?? {}) };
    delete tasks[entry.id];
    this.update(capability, {
      tasks, error: null,
      notice: `Starting ${entry.id} with its debugger${environment ? ` against ${environment}` : ''}. VS Code attaches once the debugger listens; the log is in the task terminal.`
    });
    this.poll(capability, entry);
  }

  /** Attach again to a running entry whose debugger listens (after its debug session ended, say). */
  async attach(capability: string, entryId: string): Promise<void> {
    await this.readStatus(capability);
    const state = this.stateOf(capability);
    const entry = state.plan?.find((item) => item.id === entryId);
    if (!entry) return;
    await this.attachTo(capability, entry, state.status?.find((item) => item.id === entryId));
  }

  /**
   * `vscode.debug.startDebugging` with the attach configuration for the runtime, on 127.0.0.1 and
   * the port (or pid) `app status` reported. A missing debugger extension is named; the
   * application keeps running either way.
   */
  private async attachTo(capability: string, entry: StartEntry, status: Parameters<typeof debugAttachPlan>[1]): Promise<void> {
    const plan = debugAttachPlan(entry, status);
    if ('error' in plan) return this.update(capability, { error: plan.error, notice: null });
    const runtime = entry.debug!.runtime;
    if (plan.extension && !vscode.extensions?.getExtension(plan.extension.id)) {
      const message = missingDebuggerMessage(entry.id, runtime, plan.where);
      void showCompactWarningMessage(message);
      return this.update(capability, { error: message, notice: null });
    }
    const repository = vscode.Uri.file(this.host.client.repository);
    const folder = vscode.workspace.getWorkspaceFolder?.(repository) ?? undefined;
    this.host.output?.appendLine(`\n  attach ${JSON.stringify(plan.configuration)}`);
    let attached = false;
    try {
      attached = await vscode.debug.startDebugging(folder, plan.configuration as unknown as vscode.DebugConfiguration);
    } catch (error) {
      return this.update(capability, { error: `VS Code could not attach the debugger to ${entry.id}: ${(error as Error).message}. ${entry.id} keeps running; Stop ends it.`, notice: null });
    }
    this.update(capability, attached
      ? { notice: `The debugger is attached to ${entry.id}, ${plan.where.replace(/^with its debugger listening at/, 'at')}. Ending the debug session leaves ${entry.id} running; Stop ends it.`, error: null }
      : { error: `VS Code did not start the debug session for ${entry.id}. ${entry.id} keeps running, ${plan.where}; Attach debugger tries again.`, notice: null });
  }

  /** End the task this window started; otherwise ask the CLI to stop what `app start` recorded. */
  async stop(capability: string, entryId: string): Promise<void> {
    const held = this.held.get(this.key(capability, entryId));
    if (held) {
      held.stopping = true;
      this.update(capability, { notice: `Stopping ${entryId}…`, error: null });
      held.execution.terminate();
      return;
    }
    await this.appStop(capability, entryId);
  }

  /**
   * `app stop --json`: `{ stopped, pid, reason }`; it exits 1 when the process did not stop. After this
   * window ended the entry's own task, a record that is already gone means that stop worked.
   */
  private async appStop(capability: string, entryId: string, afterTask = false): Promise<void> {
    const argv = appStopArgv(capability, entryId);
    this.log(argv);
    const words = (result: unknown): string | null => {
      const answer = unwrapResult(result) as { stopped?: unknown; reason?: unknown; pid?: unknown } | null;
      if (!answer || typeof answer !== 'object') return null;
      if (answer.stopped === true || afterTask) return `${entryId} was stopped.`;
      if (answer.reason === 'still-running') return null;
      return `${entryId} was not running from app start; nothing was stopped.`;
    };
    try {
      this.update(capability, { notice: words(await this.host.client.run(argv)) ?? `${entryId} was stopped.`, error: null });
    } catch (error) {
      const result = (error as { result?: { reason?: unknown; pid?: unknown } }).result;
      this.update(capability, {
        error: result?.reason === 'still-running'
          ? `${entryId} (pid ${String(result.pid)}) did not stop; stop it from your system's process manager.` : (error as Error).message,
        notice: null
      });
    }
    await this.readStatus(capability);
  }

  async open(capability: string, entryId: string): Promise<void> {
    const state = this.stateOf(capability);
    const url = loopbackUrl(state.status?.find((item) => item.id === entryId)?.url ?? state.plan?.find((item) => item.id === entryId)?.url);
    if (!url) return this.update(capability, { error: `${entryId} has no loopback URL to open.`, notice: null });
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * Run every test of the capability, or the named commands, as a task. The execution, or null when
   * nothing started (untrusted, already running, not confirmed); the state says why.
   */
  async runTests(capability: string, command: string | readonly string[] | null): Promise<vscode.TaskExecution | null> {
    if (!this.trusted(capability)) return null;
    if (this.held.has(this.key(capability))) {
      this.update(capability, { notice: 'A test run is already running for this capability.', error: null });
      return null;
    }
    await this.load(capability);
    const tests = this.stateOf(capability).tests ?? [];
    const commands = typeof command === 'string' ? [command] : [...new Set(command ?? [])];
    const environment = testsEnvironment(tests, this.chosenEnvironment(capability), commands);
    const planned = commands.length ? tests.filter((item) => commands.includes(item.id)) : tests;
    if (await this.filesMissing(capability, environment, { kind: 'tests', label: `Tests for ${capability}` }, planned.map((item) => item.workingDirectory))) return null;
    const argv = testsRunArgv(capability, commands, environment, plannedIdentities(tests, commands));
    if (!await this.confirmed(testsConfirmationKeys(tests, argv, commands), testsConfirmationRequest(capability, tests, commands, environment))) {
      this.update(capability, { notice: 'No tests were run.', error: null });
      return null;
    }
    this.log(argv);
    const execution = await this.execute(capability, this.task('tests-run', capability, null, environment, argv));
    if (!execution) return null;
    this.held.set(this.key(capability), { execution, capability, entry: null, stopping: false, environment });
    this.update(capability, { notice: `Running ${commands.length ? commands.join(', ') : 'every test'}${environment ? ` against ${environment}` : ''}. Output is in the task terminal.`, error: null });
    return execution;
  }

  cancelTests(capability: string): void {
    const held = this.held.get(this.key(capability));
    if (!held) return;
    held.stopping = true;
    held.execution.terminate();
  }

  private async ended(execution: vscode.TaskExecution, exitCode: number | null): Promise<void> {
    // VS Code hands every event the TaskExecution object executeTask returned. A definition match
    // would also catch the late end of an earlier run of the same entry, so identity alone decides.
    const found = [...this.held.entries()].find(([, held]) => held.execution === execution
      || (Boolean(execution?.task) && held.execution.task === execution.task));
    if (!found) return;
    const [key, held] = found;
    this.held.delete(key);
    clearTimeout(this.polls.get(key));
    if (held.entry) {
      this.update(held.capability, {
        // A stop the person asked for is not a failure, whatever signal ended the process.
        tasks: { ...(this.stateOf(held.capability).tasks ?? {}), [held.entry]: { running: false, exitCode: held.stopping ? null : exitCode } },
        notice: held.stopping ? `${held.entry} was stopped.` : `${held.entry} ended${exitCode === null ? '' : ` with exit code ${exitCode}`}.`
      });
      await this.readStatus(held.capability);
      if (!held.stopping) return void await this.checkFilesAfter(held, exitCode);
      // Ending the task ends the CLI, which stops the tree and clears its record a moment later.
      const stillStarted = () => this.stateOf(held.capability).status?.find((item) => item.id === held.entry)?.started === true;
      for (let attempt = 0; attempt < STOP_SETTLE_READS && stillStarted(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS));
        await this.readStatus(held.capability);
      }
      // When the engine still sees it, ask it to stop what app start recorded.
      if (stillStarted()) await this.appStop(held.capability, held.entry, true);
      return;
    }
    this.update(held.capability, {
      notice: held.stopping ? 'The test run was cancelled.' : `The test run finished${exitCode === null ? '' : ` with exit code ${exitCode}`}.`
    });
    const before = this.stateOf(held.capability).lastRun?.run?.id ?? null;
    await this.load(held.capability);
    const last = this.stateOf(held.capability).lastRun;
    if (!held.stopping && last?.run) {
      const notRun = last.commands.filter((command) => command.status === 'blocked').length;
      this.update(held.capability, { notice: `The test run finished: ${totalsLine(last.totals)}${notRun ? `; ${notRun} command${notRun === 1 ? '' : 's'} not run` : ''}.` });
    }
    TestSummaryPanel.refreshFor({ kind: 'capability', capability: held.capability });
    this.testsEnded.fire({ capability: held.capability, execution: held.execution, exitCode, cancelled: held.stopping });
    // The engine records no run when it refused one; a missing environment file is said with its fixes.
    if (!last?.run || last.run.id === before) await this.checkFilesAfter(held, exitCode, false);
  }

  async setEnvironment(capability: string, environment: string): Promise<void> {
    const state = this.stateOf(capability);
    if (!environmentOptions(state.plan ?? [], state.tests ?? []).some((choice) => choice.name === environment)) return;
    const choices = this.host.state.get<Record<string, string>>(ENVIRONMENT_CHOICES_KEY, {}) ?? {};
    await this.host.state.update(ENVIRONMENT_CHOICES_KEY, { ...choices, [capability]: environment });
    this.update(capability, { notice: null });
  }

  private async copyBind(capability: string, environment: string): Promise<void> {
    const state = this.stateOf(capability);
    if (!environmentOptions(state.plan ?? [], state.tests ?? []).some((choice) => choice.name === environment)) return;
    await vscode.env.clipboard.writeText(bindCommand(environment));
    void vscode.window.setStatusBarMessage('$(clippy) Copied. Run it in a terminal with your own secret helper.', 4_000);
  }

  /** A message from the capability page, checked against the map and this checkout again. */
  async handle(message: { action: string; capability: string; entry: string; command: string; environment: string }): Promise<void> {
    const node = findCapability(this.host.capabilities(), message.capability);
    if (!node || this.ownership(node) !== 'here') return;
    const { capability, entry, command, environment } = message;
    const state = this.stateOf(capability);
    const isEntry = Boolean(entry && state.plan?.some((item) => item.id === entry));
    switch (message.action) {
      case 'refresh': return this.load(capability);
      case 'start': return isEntry ? this.start(capability, entry) : undefined;
      case 'debug': return isEntry ? this.startDebug(capability, entry) : undefined;
      case 'attach': return isEntry ? this.attach(capability, entry) : undefined;
      case 'suggest': return void RunSuggestionsPanel.show({ ...this.host, afterLocalChange: async (id: string) => {
        await this.host.afterLocalChange?.(id);
        await this.load(id);
      } }, capability);
      case 'configurations': return void this.editConfigurations(capability, isEntry ? entry : null);
      case 'stop': return entry ? this.stop(capability, entry) : undefined;
      case 'open': return isEntry ? this.open(capability, entry) : undefined;
      case 'tests': return void await this.runTests(capability, command || null);
      case 'cancel-tests': return this.cancelTests(capability);
      case 'summary': return void TestSummaryPanel.show(this.host.client, { kind: 'capability', capability });
      case 'environment': return this.setEnvironment(capability, environment);
      case 'copy-bind': return this.copyBind(capability, environment);
      case 'env-files': return void EnvironmentFilesPanel.show(this.host, { environment: environment || null, capability });
      default: return undefined;
    }
  }

  /**
   * The Run/Debug Configurations editor for a capability, with one configuration selected. A save
   * reads `app plan` again, so this section shows what is declared now.
   */
  editConfigurations(capability: string, configuration: string | null = null): RunConfigurationsPanel {
    return RunConfigurationsPanel.show({ ...this.host, afterSave: (id: string) => this.load(id) }, capability, { configuration });
  }

  /** The capability owning this checkout, picked when several do; null after saying why there is none. */
  async pickCapability(title: string, story: string | null = null): Promise<{ capability: string } | { story: string } | null> {
    const active = this.host.activeRepositoryId();
    let here = capabilitiesHere(this.host.capabilities(), active);
    if (!here.length && !active) {
      const resolved = await this.resolveHere();
      const node = resolved ? findCapability(this.host.capabilities(), resolved) : null;
      if (node) here = [node];
    }
    const items = [
      ...(story ? [{ label: `Story ${story}`, description: 'this Story\'s current step', value: { story } }] : []),
      ...here.map((node) => ({ label: node.name ?? node.id, description: node.id, value: { capability: node.id } }))
    ];
    if (!items.length) {
      const anyDelivery = (nodes: CapabilityNode[]): boolean => nodes.some((node) => ownershipOf(node, active) === 'unknown-repository' || anyDelivery(node.children ?? []));
      void showCompactWarningMessage(!active && anyDelivery(this.host.capabilities())
        ? 'This window does not know which repository it has open. Open the repository from Workspaces, then try again.'
        : 'No delivery capability runs from this repository. Open Capabilities to see where each one runs.');
      return null;
    }
    if (items.length === 1) return items[0]!.value;
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Which capability?', ignoreFocusOut: true });
    return picked?.value ?? null;
  }

  /** Palette: pick the start entry (and environment, when it allows several), then start it. */
  async startFromPalette(capability: string): Promise<void> {
    if (!this.trusted(capability)) return;
    await this.load(capability);
    const state = this.stateOf(capability);
    const entries = state.plan ?? [];
    if (!entries.length) return void showCompactWarningMessage(state.planNote ?? `${capability} declares no start entry.`);
    const entry = entries.length === 1 ? entries[0]
      : (await vscode.window.showQuickPick(entries.map((item) => ({ label: item.id, description: item.argv.join(' '), entry: item })),
        { title: `Start ${capability}`, placeHolder: 'Which start entry?', ignoreFocusOut: true }))?.entry;
    if (!entry) return;
    if (entry.environments.length > 1 && !await this.pickEnvironment(capability, entry.environments)) return;
    await this.start(capability, entry.id);
  }

  /** Palette: all tests, or one command when the engine lists them. */
  async testsFromPalette(capability: string): Promise<void> {
    if (!this.trusted(capability)) return;
    await this.load(capability);
    const state = this.stateOf(capability);
    const commands = state.tests?.map((command) => command.id) ?? [...new Set((state.lastRun?.commands ?? []).map((command) => command.id))];
    const picked = commands.length
      ? await vscode.window.showQuickPick([{ label: 'All tests', command: null as string | null }, ...commands.map((id) => ({ label: id, command: id as string | null }))],
        { title: `Run tests · ${capability}`, placeHolder: 'Which tests?', ignoreFocusOut: true })
      : { label: 'All tests', command: null };
    if (!picked) return;
    const choices = environmentOptions([], state.tests ?? []);
    if (choices.length > 1 && !await this.pickEnvironment(capability, choices)) return;
    await this.runTests(capability, picked.command);
  }

  private async pickEnvironment(capability: string, choices: StartEntry['environments']): Promise<boolean> {
    const current = chooseEnvironment(choices, this.remembered(capability));
    const ordered = [...choices].sort((left, right) => Number(right.name === current) - Number(left.name === current));
    const picked = await vscode.window.showQuickPick(ordered.map((choice) => ({
      label: `${choice.name}: ${environmentStatusWords(choice.status)}`, name: choice.name,
      description: choice.status === 'bound' ? '' : `bind with: ${bindCommand(choice.name)}`
    })), { title: `Environment · ${capability}`, placeHolder: 'Which environment? VS Code never asks for its values.', ignoreFocusOut: true });
    if (!picked) return false;
    await this.setEnvironment(capability, picked.name);
    return true;
  }

  dispose(): void {
    for (const timer of this.polls.values()) clearTimeout(timer);
    this.polls.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.changed.dispose();
    this.testsEnded.dispose();
    if (RunAndTest.instance === this) RunAndTest.instance = null;
  }
}

const CONFIGURATION_TARGET = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `singularityFlow.editRunConfigurations`: "Singularity Flow: Edit Run Configurations…". Other surfaces
 * (the run widget's "Edit Configurations…", the Run view's Edit) pass `{ capability, configuration }`:
 * the capability ID, and the start entry ID to select (a capability ID alone, as a string, works too).
 * Without a capability, the one this checkout runs, picked when several do.
 */
export async function editRunConfigurationsCommand(host: RunAndTestHost, target?: unknown): Promise<void> {
  const controller = RunAndTest.attach(host);
  const requested = (typeof target === 'string' ? { capability: target } : target && typeof target === 'object' ? target : {}) as
    { capability?: unknown; configuration?: unknown };
  const configuration = typeof requested.configuration === 'string' && CONFIGURATION_TARGET.test(requested.configuration) ? requested.configuration : null;
  if (typeof requested.capability === 'string' && CONFIGURATION_TARGET.test(requested.capability)) {
    return void controller.editConfigurations(requested.capability, configuration);
  }
  const picked = await controller.pickCapability('Edit Run Configurations');
  if (picked && 'capability' in picked) controller.editConfigurations(picked.capability, configuration);
}

/** The three palette commands: Start Application, Run Tests, Test Summary. */
export async function runAndTestCommand(kind: 'start' | 'tests' | 'summary', host: RunAndTestHost, target?: unknown): Promise<void> {
  const controller = RunAndTest.attach(host);
  const requested = (target && typeof target === 'object' ? target : {}) as { workId?: unknown; phase?: unknown; capability?: unknown; beside?: unknown };
  if (kind === 'summary' && typeof requested.workId === 'string' && requested.workId) {
    return void TestSummaryPanel.show(host.client, { kind: 'story', workId: requested.workId, phase: typeof requested.phase === 'string' ? requested.phase : null },
      { beside: requested.beside === true });
  }
  if (kind === 'summary' && typeof requested.capability === 'string' && requested.capability) {
    return void TestSummaryPanel.show(host.client, { kind: 'capability', capability: requested.capability });
  }
  const title = kind === 'start' ? 'Start Application' : kind === 'tests' ? 'Run Tests' : 'Test Summary';
  const picked = await controller.pickCapability(title, kind === 'summary' ? host.workId?.() ?? null : null);
  if (!picked) return;
  if ('story' in picked) return void TestSummaryPanel.show(host.client, { kind: 'story', workId: picked.story, phase: null });
  if (kind === 'summary') return void TestSummaryPanel.show(host.client, { kind: 'capability', capability: picked.capability });
  return kind === 'start' ? controller.startFromPalette(picked.capability) : controller.testsFromPalette(picked.capability);
}

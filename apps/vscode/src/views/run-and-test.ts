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
  environmentOptions, environmentStatusWords, ENVIRONMENT_CHOICES_KEY, findCapability, loopbackUrl, missingDebuggerMessage, ownershipOf,
  rememberConfirmed, startConfirmationRequest, plannedIdentities, startRefusal, testPlanFrom, testsConfirmationKeys, testsConfirmationRequest,
  testsEnvironment, testsPlanArgv, testsRunArgv, unwrapResult, type DebugRuntime, type Ownership, type RunAndTestState, type StartEntry
} from './run-and-test-model.ts';
import { RunSuggestionsPanel, type RunSuggestionsHost } from './run-suggestions.ts';
import { runAndTestHtml } from './run-and-test-page.ts';
import { testsSummaryArgv, testSummaryFrom, totalsLine } from './test-summary-model.ts';
import { TestSummaryPanel } from './test-summary.ts';

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

interface Held {
  execution: vscode.TaskExecution; capability: string; entry: string | null; stopping: boolean;
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
  private readonly states = new Map<string, RunAndTestState>();
  private readonly held = new Map<string, Held>();
  private readonly polls = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The capability the engine resolves for this checkout (`app plan --json`), per repository. */
  private here: { repository: string; capability: string | null } | null = null;
  private hereReading: Promise<string | null> | null = null;

  private constructor(private host: RunAndTestHost) {
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
      ...state, tasks, environment: this.remembered(capability.id), testsRunning: this.held.has(this.key(capability.id))
    }));
  }

  /** Plan, status, the test plan (when the engine offers it) and the last run, read together. */
  async load(capability: string): Promise<void> {
    this.update(capability, { loading: true });
    const { client } = this.host;
    const [plan, status, tests, last] = await Promise.allSettled([
      client.run(appPlanArgv(capability)), client.run(appStatusArgv(capability)),
      client.run(testsPlanArgv(capability)), client.run(testsSummaryArgv({ kind: 'capability', capability }))
    ]);
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
    const execution = new vscode.ProcessExecution(client.location.executable, [client.location.cli, ...argv], { cwd: repository, env });
    const name = action === 'app-start' ? `Start ${entry}${debug ? ' (debug)' : ''} · ${capability}` : `Tests · ${capability}`;
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
    const refusal = startRefusal(entry, environment);
    if (refusal) return this.update(capability, { error: refusal, notice: null });
    if (!await this.confirmed([entry.commandSha256], startConfirmationRequest(entry, environment))) {
      return this.update(capability, { notice: 'Nothing was started.', error: null });
    }
    const argv = appStartArgv(capability, entry.id, environment, entry.commandSha256);
    this.log(argv);
    const execution = await this.execute(capability, this.task('app-start', capability, entry.id, environment, argv));
    if (!execution) return;
    this.held.set(this.key(capability, entry.id), { execution, capability, entry: entry.id, stopping: false });
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
    const refusal = startRefusal(entry, environment);
    if (refusal) return this.update(capability, { error: refusal, notice: null });
    // The engine would refuse it before anything runs (a missing debugpy or dlv, yarn): say so here.
    const declined = debugLaunch(entry.debug, environment).refusal;
    if (declined) return this.update(capability, { error: `${entryId} was not started: ${declined.message}`, notice: null });
    if (!await this.confirmed([debugConfirmationKey(entry)], debugStartConfirmationRequest(entry, environment))) {
      return this.update(capability, { notice: 'Nothing was started.', error: null });
    }
    const argv = appStartArgv(capability, entry.id, environment, entry.commandSha256, true);
    this.log(argv);
    const execution = await this.execute(capability, this.task('app-start', capability, entry.id, environment, argv, true));
    if (!execution) return;
    this.held.set(this.key(capability, entry.id), { execution, capability, entry: entry.id, stopping: false, debug: { runtime: entry.debug.runtime, attached: false } });
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

  /** Run every test of the capability, or one command, as a task. */
  async runTests(capability: string, command: string | null): Promise<void> {
    if (!this.trusted(capability)) return;
    if (this.held.has(this.key(capability))) return this.update(capability, { notice: 'A test run is already running for this capability.', error: null });
    await this.load(capability);
    const tests = this.stateOf(capability).tests ?? [];
    const commands = command ? [command] : [];
    const environment = testsEnvironment(tests, this.chosenEnvironment(capability), commands);
    const argv = testsRunArgv(capability, commands, environment, plannedIdentities(tests, commands));
    if (!await this.confirmed(testsConfirmationKeys(tests, argv, commands), testsConfirmationRequest(capability, tests, commands, environment))) {
      return this.update(capability, { notice: 'No tests were run.', error: null });
    }
    this.log(argv);
    const execution = await this.execute(capability, this.task('tests-run', capability, null, environment, argv));
    if (!execution) return;
    this.held.set(this.key(capability), { execution, capability, entry: null, stopping: false });
    this.update(capability, { notice: `Running ${command ?? 'every test'}${environment ? ` against ${environment}` : ''}. Output is in the task terminal.`, error: null });
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
      if (!held.stopping) return;
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
    await this.load(held.capability);
    const last = this.stateOf(held.capability).lastRun;
    if (!held.stopping && last?.run) {
      const notRun = last.commands.filter((command) => command.status === 'blocked').length;
      this.update(held.capability, { notice: `The test run finished: ${totalsLine(last.totals)}${notRun ? `; ${notRun} command${notRun === 1 ? '' : 's'} not run` : ''}.` });
    }
    TestSummaryPanel.refreshFor({ kind: 'capability', capability: held.capability });
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
      case 'stop': return entry ? this.stop(capability, entry) : undefined;
      case 'open': return isEntry ? this.open(capability, entry) : undefined;
      case 'tests': return this.runTests(capability, command || null);
      case 'cancel-tests': return this.cancelTests(capability);
      case 'summary': return void TestSummaryPanel.show(this.host.client, { kind: 'capability', capability });
      case 'environment': return this.setEnvironment(capability, environment);
      case 'copy-bind': return this.copyBind(capability, environment);
      default: return undefined;
    }
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
    if (RunAndTest.instance === this) RunAndTest.instance = null;
  }
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

/**
 * The Testing view controller "Singularity Flow" (lazy panels runtime). [RUN, IntelliJ-style run
 * configurations amendment §4, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * One item per test command from `tests plan`. Its children are the test cases of the latest
 * `tests summary`, each with its file and line, so VS Code draws its run and result icons beside the
 * test in the editor. Children are made when VS Code asks for them, or when a file a case names is
 * opened; nothing here runs a CLI command of its own except the summary of a run it started.
 *
 * The Run profile runs `tests run --capability <ID> [--command <id>]… [--environment ENV]
 * --expect-command …` through the run and test controller, so trust, the first-run confirmation and
 * the task are exactly the capability page's, and the environment is the run widget's. Once the
 * task ends it reads `tests summary --run=<id> --json` and reports each case, or the command alone
 * when its report gives totals only. Each run's output starts with the engine's label and evidence
 * class; the Testing view never presents a local preview as evidence.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import type { RunAndTest, RunAndTestHost, TestsEnded } from './run-and-test.ts';
import { findCapability } from './run-and-test-model.ts';
import { testsSummaryArgv, testSummaryFrom, type TestSummary } from './test-summary-model.ts';
import {
  caseMessage, caseOutcome, commandOutcome, runOutputLines, testCaseItems, testCommandItems, testRunPlans,
  type CommandItemSpec, type TestOutcome, type TestRunPlan, type TestTarget
} from './run-widget-model.ts';

interface ItemData { kind: 'capability' | 'command' | 'case'; capability: string; command: string | null }
interface Pending { capability: string; resolve(event: TestsEnded | null): void }

const line = (text: string): string => `${text.replace(/\r?\n/g, '\r\n')}\r\n`;

export class RunTesting implements vscode.Disposable {
  /** Null where this VS Code has no testing API. */
  static create(host: RunAndTestHost, runner: RunAndTest, capabilities: () => readonly string[], refresh: () => Promise<void>): RunTesting | null {
    const tests = (vscode as { tests?: typeof vscode.tests }).tests;
    return tests?.createTestController ? new RunTesting(host, runner, capabilities, refresh) : null;
  }

  private readonly controller: vscode.TestController;
  private readonly data = new WeakMap<vscode.TestItem, ItemData>();
  /** Every capability and command item by its ID; case items live in their command's children. */
  private readonly known = new Map<string, vscode.TestItem>();
  /** Command items whose cases VS Code asked for, or a run reported. */
  private readonly resolved = new Set<string>();
  /** Repository-relative file → the command items with a case in it, from the latest summaries. */
  private readonly files = new Map<string, Set<string>>();
  /** What each capability's items were last built from, so an unchanged reading builds nothing. */
  private readonly builtFrom = new Map<string, { tests: unknown; summary: unknown; name: string }>();
  private readonly pending = new Set<Pending>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(private readonly host: RunAndTestHost, private readonly runner: RunAndTest,
    private readonly capabilities: () => readonly string[], refresh: () => Promise<void>) {
    this.controller = vscode.tests.createTestController('singularityFlow', 'Singularity Flow');
    this.controller.resolveHandler = (item) => this.resolve(item);
    this.controller.refreshHandler = () => refresh();
    const profile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);
    this.subscriptions.push(this.controller, profile);
    const opened = vscode.workspace.onDidOpenTextDocument;
    if (opened) this.subscriptions.push(opened((document) => this.opened(document.uri)));
  }

  /** Rebuild the items from what the run and test controller now holds; no CLI command runs. */
  update(): void {
    if (this.disposed) return;
    const capabilities = this.capabilities();
    const grouped = capabilities.length > 1;
    const roots: vscode.TestItem[] = [];
    for (const capability of capabilities) {
      const reading = this.runner.reading(capability);
      const summary = reading.lastRun ?? null;
      const name = findCapability(this.host.capabilities(), capability)?.name ?? capability;
      const built = this.builtFrom.get(capability);
      const unchanged = built !== undefined && built.tests === reading.tests && built.summary === summary && built.name === name;
      const commands = unchanged ? this.commandItemsOf(capability)
        : testCommandItems(capability, reading.tests ?? null, summary).map((spec) => this.commandItem(spec, summary));
      if (!unchanged) {
        this.builtFrom.set(capability, { tests: reading.tests, summary, name });
        this.index(capability, commands, summary);
      }
      if (!grouped) { roots.push(...commands); continue; }
      const parent = this.known.get(capability) ?? this.controller.createTestItem(capability, name);
      parent.label = name;
      this.known.set(capability, parent);
      this.data.set(parent, { kind: 'capability', capability, command: null });
      parent.children.replace(commands);
      roots.push(parent);
    }
    this.controller.items.replace(roots);
    for (const editor of vscode.window.visibleTextEditors ?? []) this.opened(editor.document.uri);
  }

  private commandItemsOf(capability: string): vscode.TestItem[] {
    return [...this.known.entries()].filter(([id]) => id.startsWith(`${capability}/`)).map(([, item]) => item);
  }

  private commandItem(spec: CommandItemSpec, summary: TestSummary | null): vscode.TestItem {
    const item = this.known.get(spec.id) ?? this.controller.createTestItem(spec.id, spec.label);
    item.label = spec.label;
    item.description = spec.description ?? undefined;
    // A report with totals only has no cases to list; the command is the test.
    item.canResolveChildren = spec.perCase;
    this.known.set(spec.id, item);
    this.data.set(item, { kind: 'command', capability: spec.capability, command: spec.command });
    if (this.resolved.has(spec.id)) this.fillCases(item, summary);
    return item;
  }

  /** Remember which files the latest summary's cases are in, and drop commands that are gone. */
  private index(capability: string, commands: vscode.TestItem[], summary: TestSummary | null): void {
    const current = new Set(commands.map((item) => item.id));
    for (const id of [...this.known.keys()]) {
      if (id.startsWith(`${capability}/`) && !current.has(id)) { this.known.delete(id); this.resolved.delete(id); }
    }
    for (const owners of this.files.values()) for (const id of [...owners]) if (id.startsWith(`${capability}/`)) owners.delete(id);
    for (const item of commands) {
      const data = this.data.get(item);
      for (const spec of testCaseItems(capability, data?.command ?? '', summary)) {
        if (!spec.file) continue;
        const owners = this.files.get(spec.file) ?? new Set<string>();
        owners.add(item.id);
        this.files.set(spec.file, owners);
      }
    }
  }

  /** A command's cases from a summary, each with its file and line. */
  private fillCases(item: vscode.TestItem, summary: TestSummary | null): void {
    const data = this.data.get(item);
    if (!data?.command) return;
    const repository = this.host.client.repository;
    const children = testCaseItems(data.capability, data.command, summary).map((spec) => {
      const uri = spec.file ? vscode.Uri.file(path.join(repository, ...spec.file.split('/'))) : undefined;
      const child = this.controller.createTestItem(spec.id, spec.label, uri);
      child.description = spec.description ?? undefined;
      child.sortText = spec.sortText;
      if (spec.line) child.range = new vscode.Range(spec.line - 1, 0, spec.line - 1, 0);
      this.data.set(child, { kind: 'case', capability: data.capability, command: data.command });
      return child;
    });
    item.children.replace(children);
    this.resolved.add(item.id);
  }

  private resolve(item: vscode.TestItem | undefined): void {
    if (!item) return this.update();
    const data = this.data.get(item);
    if (data?.kind === 'command') this.fillCases(item, this.runner.reading(data.capability).lastRun ?? null);
  }

  /** A file a case names was opened: make that command's cases so the editor shows their icons. */
  private opened(uri: vscode.Uri | undefined): void {
    if (!uri || uri.scheme !== 'file' || !this.files.size) return;
    const relative = path.relative(this.host.client.repository, uri.fsPath).split(path.sep).join('/');
    for (const id of this.files.get(relative) ?? []) {
      const item = this.known.get(id);
      if (item && !this.resolved.has(id)) this.resolve(item);
    }
  }

  private target(item: vscode.TestItem): TestTarget | null {
    const data = this.data.get(item);
    return data ? { capability: data.capability, command: data.command } : null;
  }

  /** The Run profile: each selected capability's commands, one task at a time. */
  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const include = request.include ? request.include.map((item) => this.target(item)).filter((value): value is TestTarget => value !== null) : null;
    // The engine runs whole commands, so a case cannot be left out of its command's run.
    const exclude = (request.exclude ?? []).filter((item) => this.data.get(item)?.kind !== 'case')
      .map((item) => this.target(item)).filter((value): value is TestTarget => value !== null);
    const all = Object.fromEntries(this.capabilities().map((capability) => [capability,
      this.commandItemsOf(capability).map((item) => this.data.get(item)?.command).filter((id): id is string => Boolean(id))]));
    const run = this.controller.createTestRun(request, undefined, true);
    try {
      for (const plan of testRunPlans(include, exclude, all)) {
        if (token.isCancellationRequested || this.disposed) break;
        await this.runPlan(run, plan, all[plan.capability] ?? [], token);
      }
    } finally {
      run.end();
    }
  }

  /** Resolves with the next test task end of this capability, or null when this controller goes. */
  private nextEnd(capability: string): { ended: Promise<TestsEnded | null>; dispose(): void } {
    let subscription: vscode.Disposable | undefined;
    let pending: Pending | undefined;
    const ended = new Promise<TestsEnded | null>((resolve) => {
      pending = { capability, resolve: (event) => { subscription?.dispose(); this.pending.delete(pending!); resolve(event); } };
      this.pending.add(pending);
      subscription = this.runner.onDidEndTests((event) => { if (event.capability === capability) pending!.resolve(event); });
    });
    return { ended, dispose: () => { subscription?.dispose(); if (pending) this.pending.delete(pending); } };
  }

  private async runPlan(run: vscode.TestRun, plan: TestRunPlan, every: readonly string[], token: vscode.CancellationToken): Promise<void> {
    const { capability } = plan;
    const items = (plan.commands.length ? plan.commands : every).map((id) => this.known.get(`${capability}/${id}`))
      .filter((item): item is vscode.TestItem => Boolean(item));
    for (const item of items) run.enqueued(item);
    const before = this.runner.reading(capability).lastRun?.run?.id ?? null;
    const next = this.nextEnd(capability);
    const execution = await this.runner.runTests(capability, plan.commands);
    if (!execution) {
      next.dispose();
      const reading = this.runner.reading(capability);
      run.appendOutput(line(reading.error ?? reading.notice ?? 'No tests were run.'));
      for (const item of items) run.skipped(item);
      return;
    }
    for (const item of items) run.started(item);
    const cancel = token.onCancellationRequested(() => this.runner.cancelTests(capability));
    let end: TestsEnded | null;
    try { end = await next.ended; } finally { cancel.dispose(); }
    if (!end || end.cancelled) {
      run.appendOutput(line('The test run was cancelled.'));
      for (const item of items) run.skipped(item);
      return;
    }
    // The controller read the latest summary when the task ended; a new run ID is this run's.
    const latest = this.runner.reading(capability).lastRun ?? null;
    const runId = latest?.run?.id ?? null;
    if (!runId || runId === before) {
      const words = `The engine recorded no test run${end.exitCode !== null ? ` (the task ended with exit code ${end.exitCode})` : ''}; its task terminal says why.`;
      run.appendOutput(line(words));
      for (const item of items) run.errored(item, new vscode.TestMessage(words));
      return;
    }
    let summary: TestSummary | null = null;
    try {
      summary = testSummaryFrom(await this.host.client.run(testsSummaryArgv({ kind: 'capability', capability }, runId)));
    } catch (error) {
      run.appendOutput(line(`The summary of ${runId} could not be read: ${(error as Error).message}. The latest summary is shown.`));
    }
    this.report(run, summary ?? latest, items);
  }

  private result(run: vscode.TestRun, item: vscode.TestItem, outcome: TestOutcome, message: string | null, durationMs: number | null): void {
    const duration = durationMs ?? undefined;
    if (outcome === 'passed') return run.passed(item, duration);
    if (outcome === 'skipped') return run.skipped(item);
    const reported = new vscode.TestMessage(message ?? `${item.label} did not pass.`);
    const Location = (vscode as { Location?: typeof vscode.Location }).Location;
    if (item.uri && item.range && Location) reported.location = new Location(item.uri, item.range);
    return outcome === 'failed' ? run.failed(item, reported, duration) : run.errored(item, reported, duration);
  }

  /** Each case the run recorded, then each command's own result; a command not run is said so. */
  private report(run: vscode.TestRun, summary: TestSummary | null, items: vscode.TestItem[]): void {
    if (!summary) {
      for (const item of items) this.result(run, item, 'errored', 'The engine returned no test summary for this run.', null);
      return;
    }
    for (const text of runOutputLines(summary)) run.appendOutput(line(text));
    for (const item of items) {
      const data = this.data.get(item);
      const command = summary.commands.find((entry) => entry.id === data?.command);
      if (!data || !command) {
        run.appendOutput(line(`${item.label} was not run.`));
        run.skipped(item);
        continue;
      }
      if (command.perCase) {
        this.fillCases(item, summary);
        const cases = summary.cases.filter((entry) => (entry.command || 'other') === command.id);
        testCaseItems(data.capability, command.id, summary).forEach((spec, index) => {
          const entry = cases[index];
          const child = item.children.get(spec.id);
          if (!entry || !child) return;
          this.result(run, child, caseOutcome(entry.outcome), caseOutcome(entry.outcome) === 'passed' ? null : caseMessage(entry), entry.durationMs);
        });
      }
      const own = commandOutcome(command);
      this.result(run, item, own.outcome, own.message, null);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of [...this.pending]) pending.resolve(null);
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}

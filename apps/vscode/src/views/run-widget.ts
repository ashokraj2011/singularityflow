/**
 * The status bar run widget and the Run view (lazy panels runtime). [RUN, IntelliJ-style run
 * configurations amendment §3, docs/SPEC-RUN-AND-TEST-v1.md]
 *
 * Like IntelliJ's toolbar: the selected configuration and its environment (`$(play) Api · dev`),
 * then Run and Debug, which become Rerun and Stop once it has started. Clicking the name picks the
 * configuration or the environment, or opens Edit Configurations…. The Run view is IntelliJ's
 * Services window: one row per configuration with its state, environment and URL, and the actions
 * beside it. The palette commands have no default keybindings; IntelliJ's macOS ones clash with
 * VS Code's, so people bind them themselves.
 *
 * Every action goes through the run and test controller (run-and-test.ts): nothing runs in an
 * untrusted workspace, the first run of a command identity is confirmed, and an application is a VS
 * Code task of the CLI's argv. A command line shown or copied is the engine's resolved argv; nothing
 * here builds an argv or an attach configuration from text a person can edit.
 *
 * The extension attaches this only for a repository whose capability map declares an application
 * (extension.ts reads the file; it runs no CLI command to find out). While something starts or runs,
 * `app status` is read again every ten seconds; otherwise the widget reads nothing on its own.
 */
import * as vscode from 'vscode';
import { showCompactInformationMessage, showCompactWarningMessage } from '../compact-message.ts';
import { RunAndTest, type RunAndTestHost } from './run-and-test.ts';
import { environmentStatusWords, findCapability } from './run-and-test-model.ts';
import {
  capabilityChildren, configurationLabel, isRunning, quickPickEntries, rememberSelection, RUN_WIDGET_COMMANDS, runConfigurations,
  runTreeRoots, selectedConfiguration, selectionFrom, widgetSpec,
  type CapabilityRunReading, type PickEntry, type RunConfiguration, type RunSelection, type RunTreeNode, type StatusItemSpec
} from './run-widget-model.ts';
import { RunTesting } from './run-testing.ts';

/** True while this window has a run configuration: the Run view and the palette commands show. */
export const RUN_CONFIGURATIONS_CONTEXT = 'singularityFlow.runConfigurations';
const SELECTION_KEY = 'singularityFlow.runWidget.selection';
/** The Run/Debug Configurations editor, when this build has it (it takes `{ capability, configuration }`). */
const EDIT_RUN_CONFIGURATIONS = 'singularityFlow.editRunConfigurations';
const STATUS_POLL_MS = 10_000;
const STOP_WAIT_READS = 30;
const STOP_WAIT_MS = 500;
/** Errors and notices of a run started here are shown for this long, so a late one is not lost. */
const SURFACE_MS = 15 * 60_000;
/** Left, just after the branch and sync items (VS Code's source control entries use 10000). */
const PRIORITY = 9_999;

/** The Run view row commands; the palette ones are RUN_WIDGET_COMMANDS. */
export const RUN_VIEW_COMMANDS = {
  run: 'singularityFlow.runConfiguration',
  debug: 'singularityFlow.debugConfiguration',
  stop: 'singularityFlow.stopConfiguration',
  open: 'singularityFlow.openConfigurationInBrowser',
  log: 'singularityFlow.showConfigurationLog',
  edit: 'singularityFlow.editConfiguration',
  copy: 'singularityFlow.copyConfigurationCommandLine',
  environment: 'singularityFlow.runConfigurationInEnvironment',
  refresh: 'singularityFlow.refreshRunConfigurations'
} as const;

type StatusItems = Record<'configuration' | 'primary' | 'debug' | 'stop', vscode.StatusBarItem>;

export class RunWidget implements vscode.Disposable {
  private static instance: RunWidget | null = null;
  /** The one widget of this window; `changed` redraws the Run view the extension registered. */
  static attach(host: RunAndTestHost, changed: () => void): RunWidget {
    if (!RunWidget.instance) RunWidget.instance = new RunWidget(host, changed);
    else RunWidget.instance.host = host;
    return RunWidget.instance;
  }

  private readonly controller: RunAndTest;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** The capabilities this checkout runs, once read; empty hides everything. */
  private capabilities: string[] = [];
  private refreshing: Promise<void> | null = null;
  private again = false;
  private items: StatusItems | null = null;
  private testing: RunTesting | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private context: boolean | null = null;
  private readonly acted = new Map<string, number>();
  private readonly shown = new Map<string, { error: string | null; notice: string | null }>();
  private disposed = false;

  private constructor(private host: RunAndTestHost, private readonly changed: () => void) {
    this.controller = RunAndTest.attach(host);
    this.subscriptions.push(this.controller.onDidChange((capability) => {
      if (capability === '*' || this.capabilities.includes(capability)) this.render();
    }));
  }

  /** Read every capability here (the controller's plan, status, tests plan and last run), then show them. */
  refresh(): Promise<void> {
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.again = false;
        const capabilities = await this.controller.capabilityIdsHere();
        this.capabilities = capabilities;
        await Promise.all(capabilities.map((capability) => this.controller.load(capability)));
      } while (this.again && !this.disposed);
    })().finally(() => { this.refreshing = null; this.render(); });
    return this.refreshing;
  }

  /** The repository declares no application (any more): show nothing and read nothing. */
  hide(): void {
    this.capabilities = [];
    this.render();
  }

  private readings(): CapabilityRunReading[] {
    return this.capabilities.map((capability) => {
      const reading = this.controller.reading(capability);
      return {
        capability, name: findCapability(this.host.capabilities(), capability)?.name ?? capability,
        plan: reading.plan ?? [], status: reading.status ?? [], tasks: reading.tasks ?? {}, debugging: reading.debugging, chosen: reading.chosen
      };
    });
  }

  configurations(): RunConfiguration[] { return runConfigurations(this.readings()); }

  private selection(): RunSelection { return selectionFrom(this.host.state.get(SELECTION_KEY)); }

  selected(): RunConfiguration | null { return selectedConfiguration(this.configurations(), this.selection()); }

  private render(): void {
    if (this.disposed) return;
    const configurations = this.configurations();
    const selected = selectedConfiguration(configurations, this.selection());
    this.setContext(configurations.length > 0);
    this.renderStatusBar(selected);
    this.changed();
    this.surface();
    this.schedulePoll(configurations);
    this.renderTesting();
  }

  private setContext(value: boolean): void {
    if (this.context === value) return;
    this.context = value;
    void Promise.resolve(vscode.commands.executeCommand('setContext', RUN_CONFIGURATIONS_CONTEXT, value)).catch(() => undefined);
  }

  private createItems(): StatusItems {
    const make = (id: string, name: string, offset: number): vscode.StatusBarItem => {
      const item = vscode.window.createStatusBarItem(`singularityFlow.run.${id}`, vscode.StatusBarAlignment.Left, PRIORITY - offset);
      item.name = name;
      return item;
    };
    const items = {
      configuration: make('configuration', 'Singularity Flow: Run Configuration', 0),
      primary: make('run', 'Singularity Flow: Run or Rerun', 1),
      debug: make('debug', 'Singularity Flow: Debug', 2),
      stop: make('stop', 'Singularity Flow: Stop', 3)
    };
    this.subscriptions.push(...Object.values(items));
    return items;
  }

  private renderStatusBar(selected: RunConfiguration | null): void {
    if (!selected) {
      for (const item of Object.values(this.items ?? {})) item.hide();
      return;
    }
    this.items ??= this.createItems();
    const spec = widgetSpec(selected);
    const apply = (item: vscode.StatusBarItem, value: StatusItemSpec | null) => {
      if (!value) return item.hide();
      item.text = value.text;
      item.tooltip = value.tooltip;
      item.command = value.command;
      item.show();
    };
    apply(this.items.configuration, spec.configuration);
    apply(this.items.primary, spec.primary);
    apply(this.items.debug, spec.debug);
    apply(this.items.stop, spec.stop);
  }

  private renderTesting(): void {
    const withTests = this.testCapabilities();
    if (!withTests.length) {
      this.testing?.dispose();
      this.testing = null;
      return;
    }
    this.testing ??= RunTesting.create(this.host, this.controller, () => this.testCapabilities(), () => this.refresh());
    this.testing?.update();
  }

  private testCapabilities(): string[] {
    return this.capabilities.filter((capability) => {
      const reading = this.controller.reading(capability);
      return Boolean(reading.tests?.length || reading.lastRun?.commands.length);
    });
  }

  /** A run started here says what happened, even when no capability page is open to show it. */
  private surface(): void {
    for (const capability of this.capabilities) {
      const since = this.acted.get(capability);
      if (!since || Date.now() - since > SURFACE_MS) continue;
      const { error = null, notice = null } = this.controller.reading(capability);
      const last = this.shown.get(capability);
      if (error && error !== last?.error) void showCompactWarningMessage(error);
      else if (notice && notice !== last?.notice) vscode.window.setStatusBarMessage(`$(info) ${notice}`, 5_000);
      this.shown.set(capability, { error, notice });
    }
  }

  /** `app status` every ten seconds while something starts or runs, so a crash or a stop elsewhere shows. */
  private schedulePoll(configurations: RunConfiguration[]): void {
    if (!configurations.some(isRunning)) {
      if (this.poll) clearTimeout(this.poll);
      this.poll = null;
      return;
    }
    if (this.poll) return;
    this.poll = setTimeout(() => void (async () => {
      this.poll = null;
      const running = [...new Set(this.configurations().filter(isRunning).map((item) => item.capability))];
      await Promise.all(running.map((capability) => this.controller.refreshStatus(capability)));
      this.render();
    })(), STATUS_POLL_MS);
    this.poll.unref?.();
  }

  // -------------------------------------------------------------------------------------------
  // The Run view (its provider is registered by the extension, whatever the window holds).

  children(node?: RunTreeNode): RunTreeNode[] {
    const configurations = this.configurations();
    if (!node) {
      return runTreeRoots(configurations, this.capabilities.map((capability) => ({
        id: capability, name: findCapability(this.host.capabilities(), capability)?.name ?? capability,
        note: this.controller.reading(capability).planNote ?? null
      })));
    }
    return node.kind === 'capability' ? capabilityChildren(configurations, node.capability) : [];
  }

  item(node: RunTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === 'capability'
      ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    if (node.kind === 'capability') {
      item.description = node.description;
      item.iconPath = new vscode.ThemeIcon('type-hierarchy');
    } else if (node.kind === 'message') {
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon('warning');
    } else {
      item.description = node.description;
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
      item.contextValue = node.contextValue;
      // A click makes it the widget's configuration, as selecting a row in IntelliJ's Services window does.
      item.command = { command: RUN_WIDGET_COMMANDS.select, title: 'Select', arguments: [{ key: node.key }] };
    }
    return item;
  }

  // -------------------------------------------------------------------------------------------
  // Commands: the palette's act on the selected configuration, the Run view's on their row.

  /** A row, `{ key }`, or `{ capability, configuration }`; nothing means the selected configuration. */
  private target(value: unknown): RunConfiguration | null {
    const object = value && typeof value === 'object' ? value as Record<string, unknown> : null;
    const entry = object?.configuration ?? object?.entry;
    const key = typeof object?.key === 'string' ? object.key
      : typeof object?.capability === 'string' && typeof entry === 'string' ? `${object.capability}/${entry}` : null;
    if (!key) return this.selected();
    return this.configurations().find((item) => item.key === key) ?? null;
  }

  async command(id: string, target?: unknown): Promise<void> {
    // A person asked: read now when nothing was read yet (a map the file check could not see).
    if (!this.capabilities.length || id === RUN_VIEW_COMMANDS.refresh) await this.refresh();
    const given = target !== undefined && target !== null;
    switch (id) {
      case RUN_WIDGET_COMMANDS.select: return given ? this.select(this.target(target)) : this.pick();
      case RUN_WIDGET_COMMANDS.run: return this.run(this.selected(), false);
      case RUN_WIDGET_COMMANDS.debug: return this.run(this.selected(), true);
      case RUN_WIDGET_COMMANDS.rerun: return this.rerun(this.selected());
      case RUN_WIDGET_COMMANDS.stop: return this.stopRunning();
      case RUN_VIEW_COMMANDS.run: return this.run(this.target(target), false);
      case RUN_VIEW_COMMANDS.debug: return this.run(this.target(target), true);
      case RUN_VIEW_COMMANDS.stop: return this.stop(this.target(target));
      case RUN_VIEW_COMMANDS.open: return this.open(this.target(target));
      case RUN_VIEW_COMMANDS.log: return this.showLog(this.target(target));
      case RUN_VIEW_COMMANDS.edit: return this.edit(this.target(target));
      case RUN_VIEW_COMMANDS.copy: return this.copy(this.target(target));
      case RUN_VIEW_COMMANDS.environment: return this.runInEnvironment(this.target(target));
      case RUN_VIEW_COMMANDS.refresh: return undefined;
      default: return undefined;
    }
  }

  private async none(): Promise<void> {
    const edit = 'Edit Configurations…';
    const chosen = await showCompactInformationMessage(
      'There is no run configuration here: no capability this repository runs declares application.start in singularity/capabilities.yml.', edit);
    if (chosen === edit) await this.edit(null);
  }

  private async select(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return;
    await this.host.state.update(SELECTION_KEY, rememberSelection(this.selection(), configuration));
    this.render();
  }

  /** The widget's quick pick: a configuration, an environment of the selected one, or Edit Configurations…. */
  private async pick(): Promise<void> {
    const configurations = this.configurations();
    if (!configurations.length) return this.none();
    const selected = selectedConfiguration(configurations, this.selection());
    const separator = (vscode as { QuickPickItemKind?: typeof vscode.QuickPickItemKind }).QuickPickItemKind?.Separator;
    const items = quickPickEntries(configurations, selected).flatMap((entry): Array<vscode.QuickPickItem & { entry: PickEntry }> => {
      if (entry.kind === 'separator') return separator === undefined ? [] : [{ label: entry.label, kind: separator, entry }];
      return [{ label: entry.label, description: entry.description, ...('detail' in entry && entry.detail ? { detail: entry.detail } : {}), entry }];
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Run Configuration', placeHolder: 'Choose what Run and Debug start, or the environment it runs against', matchOnDescription: true
    });
    const entry = picked?.entry;
    if (!entry) return;
    if (entry.kind === 'configuration') return this.select(configurations.find((item) => item.key === entry.key) ?? null);
    if (entry.kind === 'environment') return this.controller.setEnvironment(entry.capability, entry.name);
    if (entry.kind === 'edit') return this.edit(selected);
  }

  /** Clear the controller's last words first, so its answer to this action is the one shown. */
  private async act(configuration: RunConfiguration, action: () => Promise<unknown>): Promise<void> {
    this.acted.set(configuration.capability, Date.now());
    this.shown.delete(configuration.capability);
    this.controller.clearMessages(configuration.capability);
    await action();
  }

  private async run(configuration: RunConfiguration | null, debug: boolean): Promise<void> {
    if (!configuration) return this.none();
    await this.select(configuration);
    const { capability, id } = configuration;
    await this.act(configuration, () => debug ? this.controller.startDebug(capability, id) : this.controller.start(capability, id));
  }

  private current(configuration: Pick<RunConfiguration, 'key'>): RunConfiguration | null {
    return this.configurations().find((item) => item.key === configuration.key) ?? null;
  }

  /** Stop, wait until it has stopped, then start it again the way it ran (with the debugger or not). */
  private async rerun(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return this.none();
    const debug = configuration.state === 'debugging' || this.controller.reading(configuration.capability).debugging.has(configuration.id);
    if (isRunning(configuration)) {
      await this.stop(configuration);
      for (let read = 1; read <= STOP_WAIT_READS && this.current(configuration) && isRunning(this.current(configuration)!); read += 1) {
        await new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS));
        if (read % 4 === 0) await this.controller.refreshStatus(configuration.capability);
      }
      const still = this.current(configuration);
      if (still && isRunning(still)) {
        void showCompactWarningMessage(`${configurationLabel(still)} has not stopped yet, so it was not started again. Stop it, then run it.`);
        return;
      }
    }
    await this.run(this.current(configuration) ?? configuration, debug);
  }

  private async stop(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return this.none();
    await this.act(configuration, () => this.controller.stop(configuration.capability, configuration.id));
  }

  /** The widget's Stop: the selected configuration when it runs, else the one running, else asks which. */
  private async stopRunning(): Promise<void> {
    const selected = this.selected();
    if (selected && isRunning(selected)) return this.stop(selected);
    const running = this.configurations().filter(isRunning);
    if (!running.length) return void vscode.window.setStatusBarMessage('$(info) No run configuration is running.', 4_000);
    if (running.length === 1) return this.stop(running[0]!);
    const picked = await vscode.window.showQuickPick(running.map((item) => ({ label: configurationLabel(item), description: item.capabilityName, item })),
      { title: 'Stop', placeHolder: 'Which configuration?' });
    if (picked) await this.stop(picked.item);
  }

  private async open(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return this.none();
    await this.act(configuration, () => this.controller.open(configuration.capability, configuration.id));
  }

  /** Its task terminal: each run keeps its own, named by configuration and environment. */
  private async showLog(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return this.none();
    const name = this.controller.taskName(configuration.capability, configuration.id);
    const terminal = name ? (vscode.window.terminals ?? []).find((candidate) => candidate.name === name
      || candidate.name === `Task - ${name}` || candidate.name.endsWith(name)) : undefined;
    if (terminal) return terminal.show();
    if (name && isRunning(configuration)) return void await vscode.commands.executeCommand('workbench.action.tasks.showTasks');
    void showCompactInformationMessage(`${configurationLabel(configuration)} has no log in this window yet: its log is the task terminal it runs in. Run it to open one.`);
  }

  /** The Run/Debug Configurations editor when this build has it; otherwise where the entries are edited. */
  private async edit(configuration: RunConfiguration | null): Promise<void> {
    const capability = configuration?.capability ?? this.capabilities[0] ?? null;
    const available = await Promise.resolve(vscode.commands.getCommands(true)).catch(() => [] as string[]);
    if (available.includes(EDIT_RUN_CONFIGURATIONS)) {
      await vscode.commands.executeCommand(EDIT_RUN_CONFIGURATIONS, {
        ...(capability ? { capability } : {}), ...(configuration ? { configuration: configuration.id } : {})
      });
      return;
    }
    const open = 'Open Capabilities';
    const chosen = await showCompactInformationMessage(
      `This build has no Run/Debug Configurations editor. A run configuration is an application.start entry of ${capability ?? 'its capability'} in singularity/capabilities.yml; change it through a capability proposal from Capabilities.`, open);
    if (chosen === open) await vscode.commands.executeCommand('singularityFlow.openCapabilities');
  }

  /** The engine's resolved command line for the environment it runs against, never the task's wrapper. */
  private async copy(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return this.none();
    await vscode.env.clipboard.writeText(configuration.commandLine);
    void vscode.window.setStatusBarMessage(`$(clippy) Copied the command line of ${configurationLabel(configuration)}.`, 4_000);
  }

  /** Run in environment ▸: pick one of the configuration's environments (remembered), then run it. */
  private async runInEnvironment(configuration: RunConfiguration | null): Promise<void> {
    if (!configuration) return this.none();
    if (configuration.environments.length > 1) {
      const picked = await vscode.window.showQuickPick(configuration.environments.map((choice) => ({
        label: choice.name, description: `${environmentStatusWords(choice.status)}${choice.name === configuration.environment ? ' · current' : ''}`, name: choice.name
      })), { title: `Run ${configuration.name} in environment`, placeHolder: 'Which environment? VS Code never asks for its values.' });
      if (!picked) return;
      await this.controller.setEnvironment(configuration.capability, picked.name);
    }
    await this.run(this.current(configuration) ?? configuration, false);
  }

  dispose(): void {
    this.disposed = true;
    if (this.poll) clearTimeout(this.poll);
    this.testing?.dispose();
    this.testing = null;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (RunWidget.instance === this) RunWidget.instance = null;
  }
}

/** One workspace page, targeted clients per checkout; viewing or running never opens a folder. */
import * as vscode from 'vscode';
import path from 'node:path';
import { opendir, realpath } from 'node:fs/promises';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { registerMessageRouter, stringField, integerField } from './messages.ts';
import { RunAndTest, type RunAndTestHost } from './run-and-test.ts';
import { RUN_AND_TEST_SCRIPT, RUN_AND_TEST_STYLE } from './run-and-test-page.ts';
import { EnvironmentFilesPanel } from './environment-files.ts';
import { unwrapResult } from './run-and-test-model.ts';
import { runtimeInventory, runtimeTargetArgs, safeRuntimeRelative, validRuntimeTarget, type RuntimeInventory, type RuntimeTarget } from './workspace-runtime-model.ts';
import { workspaceRuntimeHtml, WORKSPACE_RUNTIME_SCRIPT, WORKSPACE_RUNTIME_STYLE, type RuntimeFile, type RuntimeLocalFile } from './workspace-runtime-page.ts';

export class WorkspaceRuntimePanel implements vscode.Disposable {
  private static current: WorkspaceRuntimePanel | null = null;
  private inventory: RuntimeInventory | null = null;
  private selected: RuntimeTarget | null = null;
  private controller: RunAndTest | null = null;
  private controllerSubscription: vscode.Disposable | null = null;
  private host: RunAndTestHost | null = null;
  private capabilities: NonNullable<RuntimeTarget['capabilities']> = [];
  private files: RuntimeFile[] = [];
  private localFiles: RuntimeLocalFile[] = [];
  private environmentNames: string[] = [];
  private folder = '';
  private evidence = false;
  private busy: string | null = null;
  private error: string | null = null;
  private notice: string | null = null;
  private filesTruncated = false;
  private generation = 0;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  static show(context: vscode.ExtensionContext, host: RunAndTestHost, workspace?: string): WorkspaceRuntimePanel {
    if (this.current) { this.current.panel.reveal(); void this.current.refresh(workspace); return this.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.workspaceRuntime', 'Workspace Run & Test', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    return this.current = new WorkspaceRuntimePanel(panel, context, host, workspace);
  }
  private constructor(private panel: vscode.WebviewPanel, private context: vscode.ExtensionContext,
    private source: RunAndTestHost, private workspace?: string) {
    const router = registerMessageRouter('WorkspaceRunTest', {
      select: message => this.perform(() => this.select(stringField(message, 'target') ?? '')),
      action: message => this.perform(() => this.action(stringField(message, 'action') ?? '')),
      'run-and-test': message => this.perform(async () => {
        if (!this.host || !this.selected) return;
        await this.verify();
        const capability = stringField(message, 'capability') ?? '';
        if (!this.capabilities.some(item => item.id === capability)) return;
        await this.controller?.handle({ action: stringField(message, 'action') ?? '', capability,
          entry: stringField(message, 'entry') ?? '', command: stringField(message, 'command') ?? '', environment: stringField(message, 'environment') ?? '' });
      }),
      folder: message => this.perform(() => this.readFolder(stringField(message, 'relative') ?? '')),
      diff: message => this.perform(() => this.openDiff(integerField(message, 'index') ?? -1)),
      file: message => this.perform(() => this.openFile(stringField(message, 'relative') ?? '')),
      'local-file': message => this.perform(() => this.localFile(integerField(message, 'index') ?? -1, message.clear === true))
    });
    this.panel.webview.onDidReceiveMessage(raw => router.route(raw), null, this.subscriptions);
    this.panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    void this.refresh(workspace);
  }
  private async perform(operation: () => Promise<unknown>): Promise<void> {
    const epoch = this.generation;
    this.error = null; this.notice = null;
    try { await operation(); } catch (error) { if (epoch === this.generation) this.error = (error as Error).message; }
    finally { this.render(); }
  }
  private async refresh(workspace = this.workspace): Promise<void> {
    const epoch = ++this.generation;
    this.workspace = workspace;
    this.busy = 'Reading local Stories and checkout inventory…'; this.render();
    try {
      const args = workspace ? runtimeTargetArgs(workspace) : ['workspace', 'runtime', '--json'];
      const inventory = runtimeInventory(await this.source.client.run(args));
      if (epoch !== this.generation) return;
      if (!inventory) throw new Error('SFlow returned no readable workspace run inventory.');
      this.inventory = inventory; this.workspace = inventory.workspace.path;
      const previous = this.selected?.id;
      this.busy = null;
      const selected = inventory.targets.find(item => item.id === previous)
        ?? inventory.targets.find(item => item.workId === this.source.workId?.() && item.available)
        ?? inventory.targets.find(item => item.available) ?? inventory.targets[0];
      if (selected) await this.select(selected.id);
    } catch (error) { if (epoch === this.generation) this.error = (error as Error).message; }
    finally { if (epoch === this.generation) this.busy = null; this.render(); }
  }
  private async verify(): Promise<RuntimeTarget> {
    if (!this.workspace || !this.selected) throw new Error('Choose a checkout first.');
    const epoch = this.generation, id = this.selected.id;
    const verified = unwrapResult(await this.source.client.run(runtimeTargetArgs(this.workspace, id)));
    if (epoch !== this.generation || !validRuntimeTarget(verified) || verified.id !== id) throw new Error('The selected checkout changed. Refresh Run & Test.');
    this.selected = { ...verified, changes: this.selected.changes, changesTruncated: this.selected.changesTruncated };
    return this.selected;
  }
  private async select(id: string): Promise<void> {
    const target = this.inventory?.targets.find(item => item.id === id);
    if (!target) return;
    const epoch = ++this.generation;
    this.selected = target; this.evidence = false; this.capabilities = []; this.files = []; this.filesTruncated = false; this.folder = ''; this.localFiles = []; this.environmentNames = []; this.notice = null; this.error = null; this.busy = null;
    this.controllerSubscription?.dispose(); this.controllerSubscription = null; this.controller = null; this.host = null;
    if (!target.available) { this.render(); return; }
    this.busy = 'Loading run configurations for the selected checkout…'; this.render();
    try {
      const verified = await this.verify();
      if (epoch !== this.generation) return;
      this.bind(verified, false);
      await Promise.all([Promise.all(this.capabilities.map(item => this.controller!.load(item.id))), this.readFolder(''), this.readLocalFiles()]);
    } catch (error) { if (epoch === this.generation) this.error = (error as Error).message; } finally { if (epoch === this.generation) { this.busy = null; this.render(); } }
  }
  private bind(target: RuntimeTarget, evidence: boolean): void {
    const client = this.source.client.forkForRepository(target.checkoutPath);
    const prefix = `workspaceRuntime:${target.id}:${evidence ? 'evidence' : 'preview'}:`;
    const state: vscode.Memento = { keys: () => this.source.state.keys().filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length)),
      get: <T>(key: string, fallback?: T): T | undefined => this.source.state.get<T>(prefix + key, fallback as T),
      update: (key, value) => this.source.state.update(prefix + key, value) };
    this.capabilities = target.capabilities ?? [];
    const host: RunAndTestHost = { ...this.source, client, state, localRunConfiguration: true,
      activeRepositoryId: () => target.repositoryId, capabilities: () => target.capabilities ?? [], workId: () => target.workId,
      ...(evidence && target.workId && target.phase ? { testsScope: { workId: target.workId, phase: target.phase } } : { testsScope: undefined }) };
    this.host = host;
    this.controller = RunAndTest.attach(host);
    this.context.subscriptions.push(this.controller);
    this.controllerSubscription?.dispose();
    this.controllerSubscription = this.controller.onDidChange(() => this.render());
    this.evidence = evidence;
  }
  private async action(action: string): Promise<void> {
    if (action === 'refresh') return this.refresh();
    if (!this.selected) return;
    if (['prepare', 'config', 'reset-config', 'environment'].includes(action) && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before preparing a checkout or changing its local run settings.');
    if (action === 'prepare') {
      if (!this.selected.workId || !this.workspace) throw new Error('Prepare this repository from Workspaces first.');
      const workId = this.selected.workId, repositoryId = this.selected.repositoryId;
      this.busy = 'Preparing only the selected Story checkout…'; this.render();
      try { await this.source.client.run(['session', 'attach', workId, '--workspace', this.workspace, '--repository', repositoryId, '--json']); }
      finally { this.busy = null; }
      await this.refresh();
      const target = this.inventory?.targets.find(item => item.workId === workId && item.repositoryId === repositoryId && item.available);
      if (!target) throw new Error('Preparation returned without a readable Story checkout. Its existing work was preserved.');
      await this.select(target.id);
      if (this.capabilities[0]) await this.controller?.startFromPalette(this.capabilities[0].id);
      return;
    }
    const target = await this.verify();
    if (action === 'changes') {
      const epoch = this.generation;
      const result = unwrapResult(await this.source.client.run([...runtimeTargetArgs(this.workspace!, target.id), '--changes'])) as RuntimeTarget;
      if (epoch === this.generation && validRuntimeTarget(result)) this.selected = result;
      return;
    }
    if (action === 'editor') return void await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.checkoutPath), { forceNewWindow: false });
    if (action === 'evidence' || action === 'preview') {
      let runTarget = target;
      if (action === 'evidence' && target.role === 'secondary') {
        const owner = this.inventory?.targets.find(item => item.workId === target.workId && item.role !== 'secondary' && item.role !== 'base');
        if (!owner || !this.workspace) throw new Error('Prepare the Story lifecycle checkout before recording evidence.');
        await this.select(owner.id);
        return this.action('evidence');
      }
      if (action === 'evidence' && (!runTarget.workId || !runTarget.phase)) throw new Error('This checkout has no current Story phase.');
      this.bind(runTarget, action === 'evidence');
      await Promise.all(this.capabilities.map(item => this.controller!.load(item.id)));
      return;
    }
    if (!this.host || !this.capabilities.length) throw new Error('No application capability is available for this checkout.');
    const capability = this.capabilities[0]!.id;
    if (action === 'config') { this.controller?.editConfigurations(capability); return; }
    if (action === 'reset-config') { await this.host.client.run(['app', 'config', 'reset-local', '--capability', capability, '--json']); await this.select(target.id); return; }
    if (action === 'connections') {
      const epoch = this.generation, host = this.host;
      const names = [...new Set([...this.environmentNames, ...(this.controller?.reading(capability).plan?.flatMap(entry => entry.environments.map(item => item.name)) ?? [])])];
      const environment = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { title: 'Check this environment’s API connections' });
      if (!environment || epoch !== this.generation) return;
      this.busy = 'Checking selected API endpoints without sending credentials…'; this.render();
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking API connections', cancellable: true }, async (_progress, token) => {
          const cancellation = new AbortController();
          const subscription = token.onCancellationRequested(() => cancellation.abort());
          try {
            const result = unwrapResult(await host.client.run(['app', 'connections', '--environment', environment, '--json'], cancellation.signal)) as { status?: string; connections?: Array<{ name: string; status: string; httpStatus?: number; authentication?: string }> };
            if (epoch !== this.generation) return;
            const lines = result.connections?.map(item => `${item.name}: ${item.status}${item.httpStatus ? ` (HTTP ${item.httpStatus})` : ''}${item.authentication === 'required-or-refused' ? ' · authentication required or refused' : item.authentication ? ' · authentication not checked' : ''}`) ?? [];
            this.notice = lines.length ? lines.join('\n') : result.status === 'unavailable' ? 'Bind the required environment values before checking connections.' : 'No endpoint values are declared for this environment.';
          } finally { subscription.dispose(); }
        });
      } finally { if (epoch === this.generation) this.busy = null; }
      return;
    }
    if (action === 'environment') { EnvironmentFilesPanel.show(this.host, { capability }); return; }
  }
  private async pathInCheckout(relative: string): Promise<string> {
    const safe = safeRuntimeRelative(relative);
    if (safe == null || !this.selected) throw new Error('Choose a path inside this checkout.');
    const epoch = this.generation;
    const root = await realpath(this.selected.checkoutPath);
    const absolute = await realpath(path.join(root, safe));
    const within = path.relative(root, absolute);
    if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new Error('This link leaves the selected checkout.');
    if (epoch !== this.generation) throw new Error('The selected checkout changed. Choose the file again.');
    return absolute;
  }
  private async readFolder(relative: string): Promise<void> {
    const epoch = this.generation;
    const absolute = await this.pathInCheckout(relative);
    const entries: RuntimeFile[] = [];
    const folder = await opendir(absolute);
    for await (const item of folder) {
      if (['.git', 'node_modules'].includes(item.name)) continue;
      entries.push({ name: item.name, relative: relative ? `${relative}/${item.name}` : item.name, directory: item.isDirectory() });
      if (entries.length >= 500) break;
    }
    if (epoch !== this.generation) return;
    this.filesTruncated = entries.length >= 500;
    this.files = entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    this.folder = relative;
  }
  private async openFile(relative: string): Promise<void> {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(await this.pathInCheckout(relative))), { preview: true });
  }
  private async openDiff(index: number): Promise<void> {
    const target = await this.verify(), change = target.changes?.[index] ?? this.selected?.changes?.[index];
    if (!change?.path || safeRuntimeRelative(change.path) == null) return;
    const file = path.join(target.checkoutPath, change.path);
    // VS Code's Git content provider reads HEAD; no source text is sent to this webview.
    const original = vscode.Uri.from({ scheme: 'git', path: file, query: JSON.stringify({ path: file, ref: 'HEAD' }) });
    if (change.status.includes('D')) return void await vscode.window.showTextDocument(original);
    const working = vscode.Uri.file(await this.pathInCheckout(change.path));
    if (change.status === 'untracked') return void await vscode.window.showTextDocument(working);
    await vscode.commands.executeCommand('vscode.diff', original, working, `${change.path} · HEAD ↔ working tree`);
  }
  private async readLocalFiles(): Promise<void> {
    if (!this.host) return;
    const epoch = this.generation, host = this.host;
    const result = unwrapResult(await host.client.run(['env', 'files', '--json'])) as { files?: RuntimeLocalFile[]; environments?: string[] } | null;
    if (epoch !== this.generation || host !== this.host) return;
    this.environmentNames = Array.isArray(result?.environments) ? result.environments.filter(name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(name)) : [];
    this.localFiles = Array.isArray(result?.files) ? result.files.filter(item => typeof item.environment === 'string' && typeof item.path === 'string' && safeRuntimeRelative(item.path) != null) : [];
  }
  private async localFile(index: number, clear: boolean): Promise<void> {
    if (!vscode.workspace.isTrusted || !this.host) throw new Error('Trust this workspace before changing its local configuration.');
    const epoch = this.generation, host = this.host;
    const file = this.localFiles[index];
    if (!file || !Number.isInteger(index)) return;
    await this.verify();
    const value = unwrapResult(await host.client.run(['env', 'files', 'override', file.environment, file.path, ...(clear ? ['--clear'] : []), '--json'])) as { location?: string } | null;
    if (epoch !== this.generation) return;
    if (!clear && typeof value?.location === 'string') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(value.location)), { preview: false });
    await this.readLocalFiles();
  }
  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const section = this.capabilities.map(capability => this.controller?.sectionHtml(capability) ?? '').join('');
    this.panel.webview.html = page('Workspace Run & Test', workspaceRuntimeHtml({ inventory: this.inventory, selected: this.selected, error: this.error,
      busy: this.busy, notice: this.notice, filesTruncated: this.filesTruncated, section, files: this.files, folder: this.folder, localFiles: this.localFiles, evidence: this.evidence }),
      contentSecurityPolicy(this.panel.webview, token), token, `const vscode=window.__sfVscode;\n${WORKSPACE_RUNTIME_SCRIPT}\n${RUN_AND_TEST_SCRIPT}`,
      { styles: WORKSPACE_RUNTIME_STYLE + RUN_AND_TEST_STYLE });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; ++this.generation; this.controllerSubscription?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    if (WorkspaceRuntimePanel.current === this) WorkspaceRuntimePanel.current = null;
  }
}

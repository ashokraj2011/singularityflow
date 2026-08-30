import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { SgosProcessCard, SgosWorkObject } from '../cli/snapshot.ts';
import type { WorkspaceStore } from '../state.ts';
import {
  buildSgosCommandCenter, sgosEnabledProcessAction, sgosHumanRequestChoices
} from './sgos-command-center-model.ts';
import { SGOS_COMMAND_CENTER_SCRIPT, sgosCommandCenterBody } from './sgos-command-center-page.ts';
import {
  buildSgosProcessGraph, type SgosProcessGraph, type SgosProcessGraphResult
} from './sgos-process-graph-model.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { navigateTo } from './navigate.ts';
import {
  contentSecurityPolicy, navigationTarget, nonce, page
} from './webview.ts';

interface HumanRequestInspection {
  process: { processId: string; processRevision: number; processSha256: string };
  request: {
    requestId: string; requestSha256: string; requestType: string;
    prompt?: { title?: string; detail?: string };
    options?: Array<{ id: string; label?: string }>;
    inputSchema?: unknown; sensitiveMode?: string;
  };
}

function resultOf<T>(value: unknown): T {
  const envelope = value as { data?: { result?: T } };
  return envelope?.data?.result ?? value as T;
}

function objectBinding(object: SgosWorkObject): {
  processId: string; requestId: string; requestSha256: string; expectedRevision: number;
} | null {
  const action = object.view.actions.find((entry) => entry.operation === 'request.respond');
  const properties = action?.inputSchema?.properties as Record<string, { const?: unknown }> | undefined;
  const processId = properties?.processId?.const;
  const requestId = properties?.requestId?.const;
  const requestSha256 = properties?.requestSha256?.const;
  const expectedRevision = properties?.expectedRevision?.const;
  return typeof processId === 'string' && typeof requestId === 'string'
    && typeof requestSha256 === 'string' && typeof expectedRevision === 'number'
    ? { processId, requestId, requestSha256, expectedRevision } : null;
}

export class SgosCommandCenterPanel {
  private static current: SgosCommandCenterPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly client: SingularityFlowClient;
  private readonly disposables: vscode.Disposable[] = [];
  private subscription: { dispose(): void } | null = null;
  private lease: { dispose(): void } | null = null;
  private selectedProcessId: string | null = null;
  private graph: SgosProcessGraph | null = null;
  private error: string | null = null;
  private loading = true;
  private lastSliceRevision: string | null = null;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore, client: SingularityFlowClient) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    const router = registerMessageRouter('singularityFlow.commandCenter', {
      refresh: () => void this.refresh(),
      select: (message) => {
        const processId = stringField(message, 'processId');
        if (!processId || !this.currentProcess(processId)) return;
        this.selectedProcessId = processId;
        this.graph = null;
        this.render();
      },
      graph: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.loadGraph(processId);
      },
      integrity: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.inspectIntegrity(processId);
      },
      recovery: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.inspectRecovery(processId);
      },
      stop: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.stop(processId);
      },
      quarantine: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.planQuarantine(processId);
      },
      respond: (message) => {
        const objectId = stringField(message, 'objectId');
        if (objectId) void this.respond(objectId);
      }
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.subscription = store.onDidChange((state, change) => {
      const revision = state.snapshot?.revision?.slices?.sgos ?? null;
      const error = state.error?.message ?? null;
      if (change.kind === 'loading') {
        this.loading = true;
        return;
      }
      this.loading = state.loading;
      this.error = error;
      // A not-modified snapshot confirms freshness without rebuilding this document.
      if (change.kind === 'snapshot' && revision === this.lastSliceRevision
          && change.revisionChanged === false && !error) return;
      this.lastSliceRevision = revision;
      if (this.graph && !this.currentProcess(this.graph.processId, this.graph.processSha256)) this.graph = null;
      this.render();
    });
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    client: SingularityFlowClient
  ): SgosCommandCenterPanel {
    if (SgosCommandCenterPanel.current) {
      SgosCommandCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return SgosCommandCenterPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.commandCenter', 'Command Center', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    const current = new SgosCommandCenterPanel(panel, store, client);
    SgosCommandCenterPanel.current = current;
    void current.initialize();
    return current;
  }

  private async initialize(): Promise<void> {
    try {
      this.lease = await this.store.acquireSlices(['sgos']);
      this.lastSliceRevision = this.store.current.snapshot?.revision?.slices?.sgos ?? null;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      if (!this.disposed) this.render();
    }
  }

  private currentProcess(processId: string, sha256: string | null = null): SgosProcessCard | null {
    const process = this.store.current.snapshot?.sgos?.processes.find((entry) => entry.processId === processId) ?? null;
    return process && (sha256 == null || process.processSha256 === sha256) ? process : null;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try { await this.store.refresh(); this.error = null; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; this.render(); }
  }

  private async loadGraph(processId: string): Promise<void> {
    const selected = this.currentProcess(processId);
    if (!selected) return;
    this.selectedProcessId = processId;
    this.loading = true;
    this.render();
    try {
      const result = resultOf<SgosProcessGraphResult>(await this.client.run(['process', 'graph', processId, '--json']));
      const current = this.currentProcess(processId);
      const graph = buildSgosProcessGraph(result, current);
      if (!graph) {
        this.graph = null;
        this.error = 'The Process changed while its graph was loading. The stale graph was discarded; refresh to inspect the current revision.';
        await this.store.refresh();
      } else {
        this.graph = graph;
        this.error = null;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async inspectIntegrity(processId: string): Promise<void> {
    if (!this.currentProcess(processId)) return;
    try {
      const result = resultOf<{
        status: string; indexedRecordCount: number; orphans: unknown[];
        pendingReservations: unknown[]; errors: unknown[]; missing: unknown[];
      }>(await this.client.run(['process', 'fsck', processId, '--json']));
      await vscode.window.showInformationMessage(
        `${processId}: ${result.status}. ${result.indexedRecordCount} indexed records, `
        + `${result.orphans.length} orphans, ${result.pendingReservations.length} pending reservations, `
        + `${result.errors.length + result.missing.length} integrity issues.`
      );
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async inspectRecovery(processId: string): Promise<void> {
    if (!this.currentProcess(processId)) return;
    try {
      const result = resultOf<{ interrupted: boolean; actions: unknown[]; taskTemplateId?: string; status?: string }>(
        await this.client.run(['process', 'recover', processId, '--json'])
      );
      await vscode.window.showInformationMessage(result.interrupted
        ? `${processId}: ${result.taskTemplateId ?? 'one task'} has ${result.actions.length} exact recovery choice(s). No recovery was executed.`
        : `${processId}: ${result.status ?? 'stable'}. No interrupted execution requires recovery.`);
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async stop(processId: string): Promise<void> {
    const selected = this.currentProcess(processId);
    const action = selected ? sgosEnabledProcessAction(selected, 'process.stop') : null;
    if (!selected || !action) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Stop ${processId}?`,
      {
        modal: true,
        detail: 'Singularity Flow will record the Process as paused immediately, request cancellation of active execution, and report whether execution is quiescent. Runtime authority is re-checked by the kernel.'
      },
      'Stop Process'
    );
    if (confirmed !== 'Stop Process') return;
    // Do not act on a descriptor that changed while the confirmation dialog was open.
    const current = this.currentProcess(processId);
    const currentAction = current ? sgosEnabledProcessAction(current, 'process.stop') : null;
    if (!current || !currentAction
        || current.processRevision !== action.source.processRevision
        || current.processSha256 !== action.source.processSha256) {
      await vscode.window.showWarningMessage(
        'This Process changed while the stop confirmation was open. Nothing was sent; refresh and review its current state.'
      );
      return;
    }
    try {
      const result = resultOf<{
        process: { processId: string }; quiescent: boolean; activeAttemptIds?: string[];
      }>(await this.client.run([
        'process', 'stop', processId,
        '--expected-revision', String(action.source.processRevision), '--json'
      ]));
      // Exactly one post-mutation refresh. The webview never updates Process authority itself.
      await this.store.refresh();
      const active = result.activeAttemptIds?.length ?? 0;
      await vscode.window.showInformationMessage(result.quiescent
        ? `${result.process.processId} is paused and quiescent; no execution remains active.`
        : `${result.process.processId} stop is recorded; ${active} execution${active === 1 ? '' : 's'} ${active === 1 ? 'is' : 'are'} quiescing.`);
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  private async planQuarantine(processId: string): Promise<void> {
    if (!this.store.current.snapshot?.sgos?.unavailable.some((entry) => entry.processId === processId)) return;
    try {
      const result = resultOf<{ confirmationSha256: string; fileCount: number; reason: string }>(
        await this.client.run(['process', 'quarantine', processId, '--json'])
      );
      await vscode.window.showWarningMessage(
        `${processId} has ${result.fileCount} preserved private file(s). Reason: ${result.reason}. `
        + `No bytes were changed. Exact confirmation: ${result.confirmationSha256}`
      );
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async respond(objectId: string): Promise<void> {
    const object = this.store.current.snapshot?.sgos?.needsYou.find((entry) => entry.objectId === objectId);
    const binding = object ? objectBinding(object) : null;
    if (!object || !binding) return;
    try {
      const found = resultOf<HumanRequestInspection>(await this.client.run([
        'request', 'show', binding.requestId, '--process', binding.processId, '--json'
      ]));
      if (found.request.requestSha256 !== binding.requestSha256
          || found.process.processRevision !== binding.expectedRevision) {
        await vscode.window.showWarningMessage('This Human Request changed after the form was rendered. It was not answered; the current request will be loaded.');
        await this.store.refresh();
        return;
      }
      const choices = sgosHumanRequestChoices(found.request);
      if (!choices.length) {
        await vscode.window.showInformationMessage('This request requires typed or brokered input that this first Command Center release does not collect. Use the exact CLI response flow.');
        return;
      }
      const choice = await vscode.window.showQuickPick(choices, {
        title: found.request.prompt?.title ?? 'Respond to Human Request',
        placeHolder: 'Choose one exact response; nothing runs until you confirm.'
      });
      if (!choice) return;
      const confirmed = await vscode.window.showWarningMessage(
        `${choice.label} for ${found.request.requestId}? The kernel will re-check request ${found.request.requestSha256}.`,
        { modal: true }, 'Confirm response'
      );
      if (confirmed !== 'Confirm response') return;
      await this.client.run([
        'request', 'respond', found.request.requestId, '--process', found.process.processId,
        ...choice.args, '--confirm', found.request.requestSha256, '--json'
      ]);
      // Exactly one post-mutation refresh. The webview never updates authority itself.
      await this.store.refresh();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const model = buildSgosCommandCenter(this.store.current.snapshot, {
      loading: this.loading, stale: this.store.current.stale,
      error: this.error, selectedProcessId: this.selectedProcessId, graph: this.graph
    });
    if (!this.selectedProcessId && model.selected) this.selectedProcessId = model.selected.processId;
    this.panel.webview.html = page(
      'Command Center', sgosCommandCenterBody(model),
      contentSecurityPolicy(this.panel.webview, token), token, SGOS_COMMAND_CENTER_SCRIPT
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    SgosCommandCenterPanel.current = null;
    this.subscription?.dispose();
    this.lease?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

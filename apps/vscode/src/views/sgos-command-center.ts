import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type {
  SgosActionDescriptor, SgosCommandCenterSnapshot, SgosProcessCard, SgosWorkObject
} from '../cli/snapshot.ts';
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

interface RecoveryPlan {
  processId: string; processRevision: number; status: string; interrupted: boolean;
  attemptId?: string; taskTemplateId?: string;
  actions: Array<{ resolution: string; confirmationSha256: string; effect: string }>;
}

interface ReplayPlan {
  replayPlanSha256: string; expectedProcessRevision: number; expectedProcessSha256: string;
  fromCheckpointSha256: string; taskInstanceIds: string[];
}

interface ForkPlan {
  forkPlanSha256: string; expectedParentProcessRevision: number;
  expectedParentProcessSha256: string; fromCheckpointSha256: string;
  childProcessId: string; label: string;
}

interface QuarantinePlan {
  confirmationSha256: string; treeSha256?: string; fileCount: number; reason: string;
}

function resultOf<T>(value: unknown): T {
  const envelope = value as { data?: { result?: T } };
  return envelope?.data?.result ?? value as T;
}

function objectBinding(object: SgosWorkObject): {
  processId: string; processSha256: string; requestId: string; requestSha256: string;
  expectedRevision: number;
} | null {
  const action = object.view.actions.find((entry) => entry.operation === 'request.respond');
  const properties = action?.inputSchema?.properties as Record<string, { const?: unknown }> | undefined;
  const processId = properties?.processId?.const;
  const processSha256 = properties?.processSha256?.const;
  const requestId = properties?.requestId?.const;
  const requestSha256 = properties?.requestSha256?.const;
  const expectedRevision = properties?.expectedRevision?.const;
  return typeof processId === 'string' && typeof processSha256 === 'string'
    && typeof requestId === 'string'
    && typeof requestSha256 === 'string' && typeof expectedRevision === 'number'
    ? { processId, processSha256, requestId, requestSha256, expectedRevision } : null;
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
      pause: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.pause(processId);
      },
      resume: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.resume(processId);
      },
      step: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.step(processId);
      },
      run: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.run(processId);
      },
      replay: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.replay(processId);
      },
      fork: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.fork(processId);
      },
      quarantine: (message) => {
        const processId = stringField(message, 'processId');
        if (processId) void this.planQuarantine(processId);
      },
      evidence: (message) => {
        const processId = stringField(message, 'processId');
        const taskInstanceId = stringField(message, 'taskInstanceId');
        if (processId && taskInstanceId) void this.inspectEvidence(processId, taskInstanceId);
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

  /**
   * Re-load the engine-owned Command Center projection immediately before a mutation.
   * The extension never derives enablement from a status label and never carries an action across
   * a Process revision/digest change.
   */
  private async authoritativeAction(
    processId: string,
    operation: string,
    expected: SgosActionDescriptor
  ): Promise<{ process: SgosProcessCard; action: SgosActionDescriptor } | null> {
    const board = resultOf<SgosCommandCenterSnapshot>(
      await this.client.run(['process', 'list', '--json'])
    );
    const process = board.processes.find((entry) => entry.processId === processId) ?? null;
    const action = process ? sgosEnabledProcessAction(process, operation) : null;
    if (!process || !action
        || action.source.processRevision !== expected.source.processRevision
        || action.source.processSha256 !== expected.source.processSha256) {
      await vscode.window.showWarningMessage(
        'This Process changed after the action was shown. Nothing was sent; Command Center will refresh so you can review the current state.'
      );
      await this.store.refresh();
      return null;
    }
    return { process, action };
  }

  private shownAction(processId: string, operation: string): {
    process: SgosProcessCard; action: SgosActionDescriptor;
  } | null {
    const process = this.currentProcess(processId);
    const action = process ? sgosEnabledProcessAction(process, operation) : null;
    return process && action ? { process, action } : null;
  }

  private async afterMutation(message: string): Promise<void> {
    await this.store.refresh();
    this.error = null;
    await vscode.window.showInformationMessage(message);
  }

  private mutationFailed(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.render();
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
    const shown = this.shownAction(processId, 'process.recover.plan');
    if (!shown) return;
    try {
      const current = await this.authoritativeAction(
        processId, 'process.recover.plan', shown.action
      );
      if (!current) return;
      const result = resultOf<RecoveryPlan>(
        await this.client.run(['process', 'recover', processId, '--json'])
      );
      if (!result.interrupted || !result.attemptId || !result.actions.length) {
        await vscode.window.showInformationMessage(
          `${processId}: ${result.status ?? 'stable'}. No interrupted execution requires recovery.`
        );
        return;
      }
      if (result.processRevision !== current.process.processRevision) {
        await vscode.window.showWarningMessage(
          'The recovery plan does not bind the Process revision that was just inspected. Nothing was executed.'
        );
        await this.store.refresh();
        return;
      }
      const selected = await vscode.window.showQuickPick(result.actions.map((entry) => ({
        label: entry.resolution,
        detail: entry.effect,
        action: entry
      })), {
        title: `Recover ${result.taskTemplateId ?? result.attemptId}`,
        placeHolder: 'Choose one runtime-projected recovery action.'
      });
      if (!selected) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Apply recovery '${selected.action.resolution}' to ${result.attemptId}?`,
        { modal: true, detail: `${selected.action.effect}\n\nThe exact runtime confirmation is ${selected.action.confirmationSha256}.` },
        'Apply exact recovery'
      );
      if (confirmed !== 'Apply exact recovery') return;
      const fresh = await this.authoritativeAction(
        processId, 'process.recover.plan', current.action
      );
      if (!fresh) return;
      const refreshedPlan = resultOf<RecoveryPlan>(
        await this.client.run(['process', 'recover', processId, '--json'])
      );
      const refreshedAction = refreshedPlan.actions.find((entry) =>
        entry.resolution === selected.action.resolution
        && entry.confirmationSha256 === selected.action.confirmationSha256);
      if (!refreshedPlan.interrupted || refreshedPlan.attemptId !== result.attemptId
          || refreshedPlan.processRevision !== result.processRevision || !refreshedAction) {
        await vscode.window.showWarningMessage(
          'The exact recovery choice changed while confirmation was open. Nothing was executed.'
        );
        await this.store.refresh();
        return;
      }
      const applied = resultOf<{ status: string; resolution: string; taskInstanceId: string }>(
        await this.client.run([
          'process', 'recover', processId,
          '--attempt-id', result.attemptId,
          '--resolution', refreshedAction.resolution,
          '--confirm', refreshedAction.confirmationSha256,
          '--json'
        ])
      );
      await this.afterMutation(
        `${applied.taskInstanceId}: ${applied.status}; recovery '${applied.resolution}' was recorded.`
      );
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async pause(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.pause');
    if (!shown) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Pause ${processId}?`,
      { modal: true, detail: 'Pause is available only at a quiescent boundary. The current Process revision and digest will be checked again before anything is sent.' },
      'Pause Process'
    );
    if (confirmed !== 'Pause Process') return;
    try {
      if (!await this.authoritativeAction(processId, 'process.pause', shown.action)) return;
      const process = resultOf<SgosProcessCard>(
        await this.client.run([
          'process', 'pause', processId,
          '--expected-revision', String(shown.action.source.processRevision), '--json'
        ])
      );
      await this.afterMutation(`${process.processId} is paused at revision ${process.processRevision}.`);
    } catch (error) { this.mutationFailed(error); }
  }

  private async resume(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.resume');
    const checkpoint = shown?.process.currentCheckpointSha256 ?? null;
    if (!shown || !checkpoint) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Resume ${processId} from its exact checkpoint?`,
      { modal: true, detail: `Checkpoint: ${checkpoint}\n\nExecution must still be quiescent when the kernel re-checks it.` },
      'Resume Process'
    );
    if (confirmed !== 'Resume Process') return;
    try {
      const fresh = await this.authoritativeAction(processId, 'process.resume', shown.action);
      if (!fresh || fresh.process.currentCheckpointSha256 !== checkpoint) return;
      const process = resultOf<SgosProcessCard>(await this.client.run([
        'process', 'resume', processId, '--confirm', checkpoint,
        '--expected-revision', String(fresh.action.source.processRevision), '--json'
      ]));
      await this.afterMutation(`${process.processId} resumed from ${checkpoint}.`);
    } catch (error) { this.mutationFailed(error); }
  }

  private async step(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.step');
    if (!shown) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Run one deterministic step in ${processId}?`,
      { modal: true, detail: 'The kernel will choose at most one currently ready task from the approved Program.' },
      'Run one step'
    );
    if (confirmed !== 'Run one step') return;
    try {
      if (!await this.authoritativeAction(processId, 'process.step', shown.action)) return;
      const result = resultOf<{ status: string; taskInstanceId?: string; process: SgosProcessCard }>(
        await this.client.run([
          'process', 'step', processId,
          '--expected-revision', String(shown.action.source.processRevision), '--json'
        ])
      );
      await this.afterMutation(result.taskInstanceId
        ? `${result.taskInstanceId}: ${result.status}.`
        : `${processId}: no ready task was dispatched.`);
    } catch (error) { this.mutationFailed(error); }
  }

  private async run(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.run');
    if (!shown) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Run one bounded ready wave in ${processId}?`,
      { modal: true, detail: 'This runs only the deterministic compatible ready set and waits for every launched task to quiesce.' },
      'Run bounded wave'
    );
    if (confirmed !== 'Run bounded wave') return;
    try {
      if (!await this.authoritativeAction(processId, 'process.run', shown.action)) return;
      const result = resultOf<{ launched: number; taskInstanceIds: string[] }>(
        await this.client.run([
          'process', 'run', processId,
          '--expected-revision', String(shown.action.source.processRevision), '--json'
        ])
      );
      await this.afterMutation(result.launched
        ? `${processId}: completed a bounded wave of ${result.launched} task${result.launched === 1 ? '' : 's'} (${result.taskInstanceIds.join(', ')}).`
        : `${processId}: no ready task was dispatched.`);
    } catch (error) { this.mutationFailed(error); }
  }

  private async stop(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.stop');
    if (!shown) return;
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
    try {
      const current = await this.authoritativeAction(processId, 'process.stop', shown.action);
      if (!current) return;
      const result = resultOf<{
        process: { processId: string }; quiescent: boolean; activeAttemptIds?: string[];
      }>(await this.client.run([
        'process', 'stop', processId,
        '--expected-revision', String(current.action.source.processRevision), '--json'
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
      const result = resultOf<QuarantinePlan>(
        await this.client.run(['process', 'quarantine', processId, '--json'])
      );
      const confirmed = await vscode.window.showWarningMessage(
        `Quarantine ${processId}'s preserved private bytes?`,
        {
          modal: true,
          detail: `${result.fileCount} file(s) will be moved intact, not rewritten. Reason: ${result.reason}.\n\nExact tree confirmation: ${result.confirmationSha256}`
        },
        'Quarantine exact tree'
      );
      if (confirmed !== 'Quarantine exact tree') return;
      if (!this.store.current.snapshot?.sgos?.unavailable.some((entry) => entry.processId === processId)) {
        await vscode.window.showWarningMessage('The unavailable Process changed while confirmation was open. Nothing was sent.');
        await this.store.refresh();
        return;
      }
      const refreshed = resultOf<QuarantinePlan>(
        await this.client.run(['process', 'quarantine', processId, '--json'])
      );
      if (refreshed.confirmationSha256 !== result.confirmationSha256
          || refreshed.fileCount !== result.fileCount || refreshed.reason !== result.reason) {
        await vscode.window.showWarningMessage(
          'The preserved Process tree changed while confirmation was open. Nothing was quarantined.'
        );
        await this.store.refresh();
        return;
      }
      const quarantined = resultOf<{ quarantine: string; fileCount: number }>(
        await this.client.run([
          'process', 'quarantine', processId,
          '--confirm', refreshed.confirmationSha256, '--json'
        ])
      );
      await this.afterMutation(
        `${processId}: ${quarantined.fileCount} preserved private file(s) moved intact to ${quarantined.quarantine}.`
      );
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private async replay(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.replay.plan');
    if (!shown) return;
    const checkpoint = await vscode.window.showInputBox({
      title: `Preview replay for ${processId}`,
      prompt: 'Enter an exact checkpoint SHA-256 from this Process lineage.',
      value: shown.process.currentCheckpointSha256 ?? '',
      validateInput: (value) => /^sha256:[a-f0-9]{64}$/.test(value)
        ? null : 'Enter an exact sha256:<64 lowercase hex> checkpoint digest.'
    });
    if (!checkpoint) return;
    const previewConfirmed = await vscode.window.showWarningMessage(
      `Create an exact replay preview for ${processId}?`,
      { modal: true, detail: 'This records an immutable replay plan but does not reopen any task. A second confirmation is required to apply it.' },
      'Create replay preview'
    );
    if (previewConfirmed !== 'Create replay preview') return;
    try {
      const current = await this.authoritativeAction(
        processId, 'process.replay.plan', shown.action
      );
      if (!current) return;
      const plan = resultOf<ReplayPlan>(await this.client.run([
        'process', 'replay', processId, '--from', checkpoint, '--json'
      ]));
      if (plan.expectedProcessRevision !== current.process.processRevision
          || plan.expectedProcessSha256 !== current.process.processSha256
          || plan.fromCheckpointSha256 !== checkpoint) {
        await vscode.window.showWarningMessage('Replay preview did not bind the Process and checkpoint that were reviewed. Nothing was executed.');
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Replay ${plan.taskInstanceIds.length} pure suffix task${plan.taskInstanceIds.length === 1 ? '' : 's'} in ${processId}?`,
        { modal: true, detail: `Checkpoint: ${checkpoint}\nPlan: ${plan.replayPlanSha256}\n\nExisting receipts remain historical; replayed tasks receive new governed attempts.` },
        'Confirm exact replay'
      );
      if (confirmed !== 'Confirm exact replay') return;
      if (!await this.authoritativeAction(processId, 'process.replay.plan', current.action)) return;
      await this.client.run([
        'process', 'replay', processId, '--confirm', plan.replayPlanSha256, '--json'
      ]);
      await this.afterMutation(`${processId}: ${plan.taskInstanceIds.length} pure suffix task(s) reopened from the confirmed checkpoint.`);
    } catch (error) { this.mutationFailed(error); }
  }

  private async fork(processId: string): Promise<void> {
    const shown = this.shownAction(processId, 'process.fork.plan');
    if (!shown) return;
    const checkpoint = await vscode.window.showInputBox({
      title: `Preview fork for ${processId}`,
      prompt: 'Enter the exact genesis checkpoint SHA-256. The installed profile refuses later checkpoints.',
      value: shown.process.currentCheckpointSha256 ?? '',
      validateInput: (value) => /^sha256:[a-f0-9]{64}$/.test(value)
        ? null : 'Enter an exact sha256:<64 lowercase hex> checkpoint digest.'
    });
    if (!checkpoint) return;
    const label = await vscode.window.showInputBox({
      title: `Name the independent fork of ${processId}`,
      prompt: 'Use lower-case kebab case; this label participates in the deterministic child identity.',
      value: 'fork',
      validateInput: (value) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(value)
        ? null : 'Use 2-64 lower-case letters, digits, or hyphens.'
    });
    if (!label) return;
    const previewConfirmed = await vscode.window.showWarningMessage(
      `Create an exact fork preview for ${processId}?`,
      { modal: true, detail: 'This records an immutable fork plan but does not create the child Process. A second confirmation is required to apply it.' },
      'Create fork preview'
    );
    if (previewConfirmed !== 'Create fork preview') return;
    try {
      const current = await this.authoritativeAction(processId, 'process.fork.plan', shown.action);
      if (!current) return;
      const plan = resultOf<ForkPlan>(await this.client.run([
        'process', 'fork', processId, '--from', checkpoint, '--label', label, '--json'
      ]));
      if (plan.expectedParentProcessRevision !== current.process.processRevision
          || plan.expectedParentProcessSha256 !== current.process.processSha256
          || plan.fromCheckpointSha256 !== checkpoint || plan.label !== label) {
        await vscode.window.showWarningMessage('Fork preview did not bind the Process, checkpoint, and label that were reviewed. Nothing was executed.');
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Create independent Process ${plan.childProcessId}?`,
        { modal: true, detail: `Parent: ${processId}\nGenesis checkpoint: ${checkpoint}\nPlan: ${plan.forkPlanSha256}` },
        'Confirm exact fork'
      );
      if (confirmed !== 'Confirm exact fork') return;
      if (!await this.authoritativeAction(processId, 'process.fork.plan', current.action)) return;
      await this.client.run([
        'process', 'fork', processId, '--confirm', plan.forkPlanSha256, '--json'
      ]);
      await this.afterMutation(`Created independent Process ${plan.childProcessId} from the confirmed genesis checkpoint.`);
    } catch (error) { this.mutationFailed(error); }
  }

  private async inspectEvidence(processId: string, taskInstanceId: string): Promise<void> {
    const process = this.currentProcess(processId);
    if (!process || (this.graph && this.graph.processId === processId
      && this.graph.processSha256 !== process.processSha256)) return;
    try {
      const exact = resultOf<{ process: SgosProcessCard }>(
        await this.client.run(['process', 'status', processId, '--json'])
      );
      if (exact.process.processRevision !== process.processRevision
          || exact.process.processSha256 !== process.processSha256) {
        await vscode.window.showWarningMessage('The Process changed after this receipt was rendered. Refresh before opening its evidence.');
        await this.store.refresh();
        return;
      }
      const evidence = resultOf<unknown>(await this.client.run([
        'task', 'evidence', processId, taskInstanceId, '--json'
      ]));
      const document = await vscode.workspace.openTextDocument({
        language: 'json', content: `${JSON.stringify(evidence, null, 2)}\n`
      });
      await vscode.window.showTextDocument(document, { preview: true });
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
          || found.process.processRevision !== binding.expectedRevision
          || found.process.processSha256 !== binding.processSha256) {
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
      const current = resultOf<HumanRequestInspection>(await this.client.run([
        'request', 'show', binding.requestId, '--process', binding.processId, '--json'
      ]));
      if (current.request.requestSha256 !== found.request.requestSha256
          || current.process.processRevision !== found.process.processRevision
          || current.process.processSha256 !== found.process.processSha256) {
        await vscode.window.showWarningMessage(
          'This Human Request or Process changed while confirmation was open. Nothing was sent; review the current request.'
        );
        await this.store.refresh();
        return;
      }
      await this.client.run([
        'request', 'respond', current.request.requestId, '--process', current.process.processId,
        ...choice.args, '--confirm', current.request.requestSha256,
        '--expected-revision', String(current.process.processRevision),
        '--expected-process-sha256', current.process.processSha256, '--json'
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

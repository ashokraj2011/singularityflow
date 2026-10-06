import { showCompactWarningMessage } from "../compact-message.ts";
import * as vscode from 'vscode';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import { workflowMutationPlanDetail, workflowMutationPlanSummary, type WorkflowMutationPreview, type WorkflowImportChoice } from './workflow-transfer-presentation.ts';
import type { StudioChangeOutcome } from './workflow-studio.ts';

type Choices = Record<string, WorkflowImportChoice>;
import { WORKFLOW_TRANSFER_BODY, WORKFLOW_TRANSFER_SCRIPT } from './workflow-transfer-page.ts';

/** The engine, never the webview, validates names and captures the exact mutation plan. */
export class WorkflowTransferPanel {
  static show(title: string, preview: (choices: Choices) => Promise<WorkflowMutationPreview>,
    execute: (plan: WorkflowMutationPreview, choices: Choices) => Promise<StudioChangeOutcome>): Promise<StudioChangeOutcome> {
    const panel = vscode.window.createWebviewPanel('singularityFlow.workflowTransfer', title, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    const token = nonce();
    panel.webview.html = page(title, WORKFLOW_TRANSFER_BODY, contentSecurityPolicy(panel.webview, token), token, WORKFLOW_TRANSFER_SCRIPT);
    return new Promise((resolve) => {
      let current: WorkflowMutationPreview | null = null, choices: Choices = {}, revision = -1, sequence = 0, applying = false, settled = false;
      const finish = (outcome: StudioChangeOutcome) => { if (!settled) { settled = true; resolve(outcome); } };
      panel.onDidDispose(() => finish({ outcome: 'cancelled', error: null }));
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        const request = message as { type?: string; choices?: Choices; revision?: number; planSha256?: string };
        if (!request || applying || settled) return;
        if (request.type === 'transfer.cancel') { panel.dispose(); return; }
        if (!Number.isSafeInteger(request.revision) || request.revision! < 0) return;
        if (request.type === 'transfer.preview') {
          if (request.revision! <= revision) return;
          const ticket = ++sequence; current = null; revision = request.revision!;
          try {
            if (!request.choices || typeof request.choices !== 'object' || Array.isArray(request.choices)
                || JSON.stringify(request.choices).length > 512 * 1024) throw new Error('Invalid identity choices.');
            choices = structuredClone(request.choices);
            const next = await preview(choices);
            if (ticket !== sequence || settled) return;
            current = next;
            await panel.webview.postMessage({ type: 'transfer.plan', plan: next, revision });
          } catch (error) { if (ticket === sequence) await panel.webview.postMessage({ type: 'transfer.failed', message: (error as Error).message, revision }); }
        } else if (request.type === 'transfer.apply') {
          if (!current || revision !== request.revision || current.status !== 'ready' || request.planSha256 !== current.planSha256) return;
          const reviewed = current, selected = structuredClone(choices); applying = true;
          const accepted = await showCompactWarningMessage('Create this exact workflow proposal?',
            { modal: true, detail: workflowMutationPlanDetail(reviewed), compactDetail: workflowMutationPlanSummary(reviewed) }, 'Create proposal');
          if (settled) return;
          if (accepted !== 'Create proposal') { applying = false; await panel.webview.postMessage({ type: 'transfer.plan', plan: current, revision }); return; }
          try {
            const outcome = await execute(reviewed, selected);
            if (outcome.outcome === 'failed') { applying = false; current = null; await panel.webview.postMessage({ type: 'transfer.failed', message: outcome.error, revision }); }
            else { finish(outcome); panel.dispose(); }
          } catch (error) { applying = false; current = null; await panel.webview.postMessage({ type: 'transfer.failed', message: (error as Error).message, revision }); }
        }
      });
    });
  }
}

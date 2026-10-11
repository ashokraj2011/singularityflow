import { showCompactWarningMessage } from "../compact-message.ts";
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
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
      const revisionOf = (message: InboundMessage) => {
        const value = integerField(message, 'revision');
        return value != null && Number.isSafeInteger(value) ? value : null;
      };
      const router = registerMessageRouter('singularityFlow.workflowTransfer', {
        'transfer.cancel': () => { panel.dispose(); },
        'transfer.preview': async (message) => {
          const requested = revisionOf(message);
          if (requested == null || requested <= revision) return;
          const ticket = ++sequence; current = null; revision = requested;
          try {
            const requestedChoices = message.choices;
            if (!requestedChoices || typeof requestedChoices !== 'object' || Array.isArray(requestedChoices)
                || JSON.stringify(requestedChoices).length > 512 * 1024) throw new Error('Invalid identity choices.');
            choices = structuredClone(requestedChoices as Choices);
            const next = await preview(choices);
            if (ticket !== sequence || settled) return;
            current = next;
            await panel.webview.postMessage({ type: 'transfer.plan', plan: next, revision });
          } catch (error) { if (ticket === sequence) await panel.webview.postMessage({ type: 'transfer.failed', message: (error as Error).message, revision }); }
        },
        'transfer.apply': async (message) => {
          const requested = revisionOf(message);
          if (requested == null || !current || revision !== requested || current.status !== 'ready'
              || stringField(message, 'planSha256') !== current.planSha256) return;
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
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const navigation = navigationTarget(raw);
        if (navigation) return void navigateTo(navigation);
        // An apply in progress or a settled panel takes no further input.
        if (applying || settled) return;
        return router.route(raw);
      });
    });
  }
}

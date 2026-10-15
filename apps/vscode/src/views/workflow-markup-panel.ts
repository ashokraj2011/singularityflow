/** A tagged declaration becomes an ordinary bundle, imported only through the existing review. */
import * as vscode from 'vscode';
import path from 'node:path';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter, stringField } from './messages.ts';
import { WORKFLOW_MARKUP_BODY, WORKFLOW_MARKUP_SCRIPT, WORKFLOW_MARKUP_STYLE } from './workflow-markup-page.ts';
import type { StudioChangeOutcome } from './workflow-studio.ts';

interface MarkupResult {
  status: string; sourceSha256: string; bundleSha256: string; outputPath: string | null;
  workflow: { id: string; label: string; phases: unknown[]; decisions: unknown[] };
  sourceMap: unknown[]; meaning: string;
  intent?: { text: string; requirements: unknown[] } | null;
  catalog?: { sourceSha256: string; source: { kind: string } };
}

interface IntentCatalog { resultType: string; sourceSha256: string; source: { kind: string }; entries: unknown[]; counts: Record<string, number>; patterns: unknown[]; families: unknown[] }

export class WorkflowMarkupPanel {
  /** Capture one explicitly selected, bounded local file; never scan the repository or follow links. */
  static async readDraft(file: string): Promise<string> {
    const limit = 256 * 1024;
    const selected = await fs.lstat(file, { bigint: true });
    if (!selected.isFile() || selected.size > BigInt(limit)) throw new Error('Select one regular XML draft of at most 256 KiB, not a link or directory.');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.dev !== selected.dev || before.ino !== selected.ino || before.size !== selected.size) throw new Error('The selected draft changed. Select it again.');
      const bytes = Buffer.alloc(limit + 1); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await handle.stat({ bigint: true });
      if (length > limit || BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('The draft changed or exceeded 256 KiB while loading. Select it again.');
      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
      if (!source.trim()) throw new Error('The selected draft is empty.');
      return source;
    } finally { await handle.close(); }
  }

  static show(client: SingularityFlowClient, importBundle: (file: string) => Promise<StudioChangeOutcome>): void {
    const panel = vscode.window.createWebviewPanel('singularityFlow.workflowMarkup', 'Create workflow with Copilot', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    const token = nonce();
    panel.webview.html = page('Create workflow with Copilot', `<style nonce="${token}">${WORKFLOW_MARKUP_STYLE}</style>${WORKFLOW_MARKUP_BODY}`,
      contentSecurityPolicy(panel.webview, token), token, WORKFLOW_MARKUP_SCRIPT);
    let disposed = false, busy = false, revision = 0;
    let reviewed: { source: string; result: MarkupResult; revision: number; repository: string } | null = null;
    let handoff: { intent: string; selected: string; catalog: IntentCatalog; revision: number; repository: string; attempts: number; failedSource: string | null } | null = null;
    const intentRuntime = require(path.join(__dirname, 'workflow-intent-runtime.cjs')) as typeof import('../workflow-intent-runtime.ts');
    const post = (value: unknown) => { if (!disposed) void panel.webview.postMessage(value); };
    const sourceText = (value: string | null) => {
      if (!value || Buffer.byteLength(value) > 256 * 1024) throw new Error('Enter a markup declaration of at most 256 KiB.');
      return value;
    };
    const catalogKind = (value: string | null) => {
      if (value != null && !['approved', 'installed'].includes(value)) throw new Error('Select the approved repository catalog or installed starters explicitly.');
      return value ?? 'approved';
    };
    const readCatalog = async (selected: string, args: string[] = []) => {
      const result = await client.run<IntentCatalog>(['workflow', 'intent', 'catalog', '--source', selected, ...args, '--json']);
      if (result.resultType !== 'workflow-intent-catalog' || !/^sha256:[a-f0-9]{64}$/.test(result.sourceSha256)) throw new Error('The installed build did not return a bound intent catalog. Update the matching CLI and extension.');
      return result;
    };
    const verifyDraft = (result: MarkupResult, intent: string, selected: string) => {
      if (result.status !== 'portable-ready') throw new Error('The compiler did not return a portable-ready bundle.');
      if (intent && result.intent?.text !== intent) throw new Error('The draft does not preserve the exact current intent. Ask Copilot for a catalog-bound version 2 draft with the original description and requirement-to-node coverage.');
      if (result.catalog && (selected === 'installed') !== (result.catalog.source.kind === 'installed-package')) throw new Error('The draft uses a different catalog source. Review the chosen source and regenerate explicitly.');
    };
    const nativeTool = intentRuntime.attachWorkflowIntentTool(async input => {
      const request = handoff;
      const current = () => !disposed && request === handoff && request?.revision === revision && request.repository === client.repository;
      if (!request || !current() || input.revision !== revision) throw new Error('The intent or repository changed. Request a fresh handoff from this designer.');
      const args = ['--source', request.selected, '--expected-source', request.catalog.sourceSha256];
      if (input.action === 'catalog') {
        const extra = ['--expected-source', request.catalog.sourceSha256, '--limit', '16', '--cursor', String(input.cursor ?? 0)];
        if (input.kind) extra.push('--kind', input.kind); if (input.query) extra.push('--query', input.query);
        return readCatalog(request.selected, extra);
      }
      if (input.action === 'asset') {
        if (!input.kind || !input.id) throw new Error('Select one exact asset kind and ID.');
        return client.run(['workflow', 'intent', 'show', input.kind, input.id, ...args, '--json']);
      }
      if (busy) throw new Error('A designer check or save is already running. Preserve the candidate.');
      const source = sourceText(input.source ?? null);
      if (request.attempts >= 3 || source === request.failedSource) throw new Error('The bounded draft check stopped; do not retry an unchanged failure. Preserve the candidate and request human review.');
      request.attempts++; busy = true; post({ type: 'markup.nativeBusy' });
      try {
        const result = await client.runWithInput<MarkupResult>(['workflow', 'markup', 'compile', '-', '--json'], source);
        verifyDraft(result, request.intent, request.selected);
        if (!current() || result.catalog?.sourceSha256 !== request.catalog.sourceSha256) throw new Error('The source or intent changed. Request a fresh handoff.');
        reviewed = { source, result, revision, repository: request.repository };
        handoff = null;
        post({ type: 'markup.proposed', revision, source, result: { ...result, bundle: undefined, routeSimulation: undefined } });
        return { status: 'portable-ready', workflow: result.workflow, coveredRequirements: result.intent?.requirements.length,
          semanticReview: 'required', repositoryFilesChanged: false, approvalRecorded: false, next: 'Review the open designer, then use Save bundle & review import. No import or activation was performed.' };
      } catch (error) {
        request.failedSource = source;
        if (current()) post({ type: 'markup.error', revision: request.revision, message: (error as Error).message });
        throw error;
      }
      finally { busy = false; post({ type: 'markup.nativeIdle' }); }
    });
    const router = registerMessageRouter('singularityFlow.workflowMarkup', {
      'markup.ready': async () => {
        try { const result = await client.run<{ source: string }>(['workflow', 'markup', 'example', '--json']); post({ type: 'markup.example', source: result.source }); }
        catch (error) { post({ type: 'markup.error', message: (error as Error).message, revision }); }
      },
      'markup.changed': message => {
        const next = integerField(message, 'revision');
        if (next != null && next > revision) { revision = next; reviewed = null; }
      },
      'markup.catalog': async message => {
        try {
          const selected = catalogKind(stringField(message, 'catalogSource'));
          const kind = stringField(message, 'kind'), query = stringField(message, 'query'), expected = stringField(message, 'expectedSource');
          const args = ['--limit', '16', '--cursor', String(integerField(message, 'cursor') ?? 0)];
          if (kind) args.push('--kind', kind); if (query) args.push('--query', query); if (expected) args.push('--expected-source', expected);
          const result = await readCatalog(selected, args);
          post({ type: 'markup.catalogResult', catalogSource: selected, request: integerField(message, 'request'), result });
        } catch (error) { post({ type: 'markup.catalogError', request: integerField(message, 'request'), message: (error as Error).message }); }
      },
      'markup.open': async message => {
        const requested = integerField(message, 'revision');
        if (busy) { post({ type: 'markup.error', revision: requested, message: 'A designer check or save is already running.' }); return; }
        if (requested == null || requested < revision) return;
        revision = requested; busy = true;
        const repository = client.repository;
        try {
          const files = await vscode.window.showOpenDialog({ title: 'Load the XML draft saved by Copilot', canSelectMany: false,
            canSelectFiles: true, canSelectFolders: false, defaultUri: vscode.Uri.file(repository), filters: { 'Workflow XML draft': ['xml'] } });
          if (!files?.length) { post({ type: 'markup.done', revision: requested, message: 'Load cancelled. The current draft is retained.' }); return; }
          const selected = files[0];
          if (files.length !== 1 || !selected || selected.scheme !== 'file') throw new Error('Select one local XML draft.');
          if (disposed || requested !== revision || client.repository !== repository) throw new Error('The description or repository changed. Load the draft again.');
          const source = await WorkflowMarkupPanel.readDraft(selected.fsPath);
          if (disposed || requested !== revision || client.repository !== repository) throw new Error('The description or repository changed. Load the draft again.');
          reviewed = null;
          post({ type: 'markup.loaded', revision: requested, source });
        } catch (error) { post({ type: 'markup.error', revision: requested, message: (error as Error).message }); }
        finally { busy = false; }
      },
      'markup.check': async message => {
        const requested = integerField(message, 'revision');
        if (busy) { post({ type: 'markup.error', revision: requested, message: 'A designer check or save is already running.' }); return; }
        if (requested == null || requested < revision) return;
        revision = requested; reviewed = null; busy = true;
        const repository = client.repository;
        try {
          const source = sourceText(stringField(message, 'source'));
          const result = await client.runWithInput<MarkupResult>(['workflow', 'markup', 'compile', '-', '--json'], source);
          if (disposed || requested !== revision || client.repository !== repository) { post({ type: 'markup.error', message: 'The source or repository changed. Check again.', revision: requested }); return; }
          const intent = stringField(message, 'intent')?.trim() ?? '';
          const selected = catalogKind(stringField(message, 'catalogSource'));
          verifyDraft(result, intent, selected);
          reviewed = { source, result, revision, repository };
          post({ type: 'markup.checked', revision, result: { ...result, bundle: undefined, routeSimulation: undefined } });
        } catch (error) { post({ type: 'markup.error', revision: requested, message: (error as Error).message }); }
        finally { busy = false; }
      },
      'markup.copilot': async message => {
        try {
          if (vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') === 'disabled'
              || vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false)) throw new Error('Model features are disabled. Catalog search, manual drafts and deterministic checking remain available.');
          const intent = stringField(message, 'intent')?.trim() ?? '';
          const source = stringField(message, 'source');
          if (Buffer.byteLength(intent) > 32 * 1024) throw new Error('Describe the workflow in at most 32 KiB.');
          if (source) sourceText(source);
          if (!intent && !source) throw new Error('Describe your workflow first, or load an existing draft.');
          const selected = catalogKind(stringField(message, 'catalogSource'));
          const repository = client.repository;
          const requested = integerField(message, 'revision') ?? revision;
          const catalog = await readCatalog(selected, ['--limit', '8']);
          if (disposed || repository !== client.repository || requested !== revision) throw new Error('The repository or intent changed. Review the current intent before opening Copilot.');
          handoff = { intent, selected, catalog, revision: requested, repository, attempts: 0, failedSource: null };
          const query = intentRuntime.workflowIntentPrompt({ repository, selected, catalog, intent, source, tool: nativeTool, revision: requested });
          await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: true });
        } catch (error) { post({ type: 'markup.error', revision, message: (error as Error).message }); }
      },
      'markup.import': async message => {
        const selected = reviewed;
        if (busy || !selected || selected.revision !== integerField(message, 'revision')
            || selected.result.sourceSha256 !== stringField(message, 'sourceSha256')
            || selected.result.bundleSha256 !== stringField(message, 'bundleSha256') || client.repository !== selected.repository) {
          post({ type: 'markup.error', revision, message: 'Check the exact current source before saving and importing.' }); return;
        }
        busy = true;
        try {
          const uri = await vscode.window.showSaveDialog({ title: 'Save a new portable workflow bundle',
            defaultUri: vscode.Uri.file(path.join(selected.repository, `${selected.result.workflow.id}.sflow-workflows.json`)), filters: { 'SFlow workflow bundle': ['json'] } });
          if (!uri) { post({ type: 'markup.done', revision, message: 'Save cancelled. The checked source is retained.' }); return; }
          if (uri.scheme !== 'file' || disposed || reviewed !== selected || client.repository !== selected.repository) throw new Error('The source or repository changed. Check again before saving.');
          const result = await client.runWithInput<MarkupResult>(['workflow', 'markup', 'compile', '-', '--out', uri.fsPath, '--json'], selected.source);
          if (result.sourceSha256 !== selected.result.sourceSha256 || result.bundleSha256 !== selected.result.bundleSha256) throw new Error('The compiled package changed. Review a fresh check before importing the saved bundle.');
          if (disposed || reviewed !== selected || client.repository !== selected.repository) throw new Error('The bundle was saved, but the source or repository changed. Import it explicitly after review.');
          const outcome = await importBundle(uri.fsPath);
          post({ type: 'markup.done', revision, message: outcome.error ?? `Bundle saved; import ${outcome.outcome}. Approval and activation are separate.` });
        } catch (error) { post({ type: 'markup.error', revision, message: (error as Error).message }); }
        finally { busy = false; }
      }
    });
    const listener = panel.webview.onDidReceiveMessage(raw => {
      const navigation = navigationTarget(raw);
      if (navigation) return navigateTo(navigation);
      return router.route(raw);
    });
    panel.onDidDispose(() => { disposed = true; reviewed = null; handoff = null; nativeTool.dispose(); listener.dispose(); });
  }
}

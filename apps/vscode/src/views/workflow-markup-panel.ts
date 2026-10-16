/** A tagged declaration becomes an ordinary bundle, imported only through the existing review. */
import * as vscode from 'vscode';
import path from 'node:path';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { SingularityFlowClient } from '../cli/client.ts';
import { brandMark, contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter, stringField } from './messages.ts';
import type { StudioChangeOutcome } from './workflow-studio.ts';

interface MarkupResult {
  status: string; sourceSha256: string; bundleSha256: string; outputPath: string | null;
  workflow: { id: string; label: string; phases: unknown[]; decisions: unknown[] };
  sourceMap: unknown[]; meaning: string;
  intent?: { text: string; requirements: unknown[] } | null;
  catalog?: { sourceSha256: string; source: { kind: string } };
  attachmentMappings?: { id: string; sha256: string; kind: string; targets: string[] }[];
  reusedAssets?: { kind: string; id: string; as: string }[];
  designReview?: { phases: { id: string }[]; inspection: { phase: string } | null; notice: string };
  routeSimulation?: { status: string; counts: Record<string, number>; scenarios: { id: string; kind: string; outcome: string; path: string[]; pausedFor?: string[] }[] };
}

interface IntentCatalog { resultType: string; sourceSha256: string; source: { kind: string }; entries: unknown[]; counts: Record<string, number>; patterns: unknown[]; families: unknown[] }
interface IntentPreflight {
  resultType: string; sourceSha256: string; catalog: IntentCatalog;
  capabilities: { protocol: number; engine: { sha256: string }; grammarVersions: number[]; cli: { catalog: boolean; asset: boolean; attachments: boolean; compile: boolean; documentation: boolean } };
  approvalAuthorities: { id: string; label: string }[];
}

export class WorkflowMarkupPanel {
  /** Closed compiler/transport code, not a guess based on a model-facing error message. */
  static refusalCode(error: unknown): string | null {
    const value = error as { code?: unknown; result?: { error?: { code?: unknown } } } | null;
    const code = value?.result?.error?.code ?? value?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : null;
  }

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
    const ui = require(path.join(__dirname, 'workflow-authoring-ui-runtime.cjs')) as typeof import('../workflow-authoring-ui-runtime.ts');
    const attachments = new ui.WorkflowAttachmentStore();
    const { WORKFLOW_MARKUP_BODY, WORKFLOW_MARKUP_SCRIPT, WORKFLOW_MARKUP_STYLE } = ui;
    const panel = vscode.window.createWebviewPanel('singularityFlow.workflowMarkup', 'Create workflow with Copilot', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    const token = nonce();
    panel.webview.html = page('Create workflow with Copilot', `<style nonce="${token}">${WORKFLOW_MARKUP_STYLE}</style>${WORKFLOW_MARKUP_BODY.replace('<!-- brand -->', brandMark(20))}`,
      contentSecurityPolicy(panel.webview, token), token, WORKFLOW_MARKUP_SCRIPT);
    let disposed = false, busy = false, revision = 0;
    let catalogRead: AbortController | null = null;
    let reviewed: { source: string; result: MarkupResult; revision: number; repository: string; inspections: Map<string, Promise<unknown>> } | null = null;
    let handoff: { intent: string; selected: string; catalog: IntentCatalog; assets: { kind: string; id: string }[]; revision: number; repository: string; attempts: number; failedSource: string | null; stopped: string | null } | null = null;
    const intentRuntime = require(path.join(__dirname, 'workflow-intent-runtime.cjs')) as typeof import('../workflow-intent-runtime.ts');
    const post = (value: unknown) => { if (!disposed) void panel.webview.postMessage(value); };
    const reviewPayload = (result: MarkupResult) => ({ ...result, bundle: undefined, routeSimulation: result.routeSimulation ? {
      status: result.routeSimulation.status, counts: result.routeSimulation.counts,
      scenarios: result.routeSimulation.scenarios.map(item => ({ id: item.id, kind: item.kind, outcome: item.outcome, path: item.path.slice(0, 80),
        pathLength: item.path.length, pausedFor: item.pausedFor ?? [] })) } : undefined });
    const sourceText = (value: string | null) => {
      if (!value || Buffer.byteLength(value) > 256 * 1024) throw new Error('Enter a markup declaration of at most 256 KiB.');
      return value;
    };
    const catalogKind = (value: string | null) => {
      if (value != null && !['approved', 'installed'].includes(value)) throw new Error('Select the approved repository catalog or installed starters explicitly.');
      return value ?? 'approved';
    };
    const readCatalog = async (selected: string, args: string[] = [], signal?: AbortSignal) => {
      const result = await client.run<IntentCatalog>(['workflow', 'intent', 'catalog', '--source', selected, ...args, '--json'], signal);
      if (result.resultType !== 'workflow-intent-catalog' || !/^sha256:[a-f0-9]{64}$/.test(result.sourceSha256)) throw new Error('The installed build did not return a bound intent catalog. Update the matching CLI and extension.');
      return result;
    };
    const selectedLibrary = (message: { selectedAssets?: unknown }) => {
      const chosen = message.selectedAssets;
      if (chosen == null) return [];
      if (!Array.isArray(chosen) || chosen.length > 64 || chosen.some(item => !item || typeof item.kind !== 'string' || typeof item.id !== 'string' || item.kind.length > 64 || item.id.length > 256)) throw new Error('Choose up to 64 named library assets.');
      return chosen.map(item => ({ kind: item.kind as string, id: item.id as string }));
    };
    const verifyDraft = (result: MarkupResult, intent: string, selected: string, assets: { kind: string; id: string }[] = []) => {
      if (result.status !== 'portable-ready') throw new Error('The compiler did not return a portable-ready bundle.');
      if (intent && result.intent?.text !== intent) throw new Error('The draft does not preserve the exact current intent. Ask Copilot for a catalog-bound version 2 draft with the original description and requirement-to-node coverage.');
      if (result.catalog && (selected === 'installed') !== (result.catalog.source.kind === 'installed-package')) throw new Error('The draft uses a different catalog source. Review the chosen source and regenerate explicitly.');
      attachments.verify(result.attachmentMappings);
      for (const asset of assets.filter(item => ['agent', 'skill', 'instruction', 'workflow'].includes(item.kind))) if (!result.reusedAssets?.some(item => item.kind === asset.kind && item.id === asset.id)) throw new Error(`The draft does not account for selected ${asset.kind} '${asset.id}'. Use it or review its removal before importing.`);
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
        if (input.kind === 'attachment') return attachments.read(input.id);
        return client.run(['workflow', 'intent', 'show', input.kind, input.id, ...args, '--json']);
      }
      if (busy) throw new Error('A designer check or save is already running. Preserve the candidate.');
      const source = sourceText(input.source ?? null);
      if (request.stopped) throw new Error(request.stopped);
      if (request.attempts >= 3 || source === request.failedSource) throw new Error('The bounded draft check stopped; do not retry an unchanged failure. Preserve the candidate and request human review.');
      reviewed = null; busy = true; post({ type: 'markup.nativeBusy' });
      let compilerResponded = false;
      try {
        const result = await client.runWithInput<MarkupResult>(['workflow', 'markup', 'compile', '-', '--design-review', '--json'], source);
        compilerResponded = true;
        verifyDraft(result, request.intent, request.selected, request.assets);
        if (!current() || result.catalog?.sourceSha256 !== request.catalog.sourceSha256) throw new Error('The source or intent changed. Request a fresh handoff.');
        reviewed = { source, result, revision, repository: request.repository, inspections: new Map() };
        handoff = null;
        post({ type: 'markup.proposed', revision, source, result: reviewPayload(result) });
        return { status: 'portable-ready', workflow: result.workflow, coveredRequirements: result.intent?.requirements.length,
          semanticReview: 'required', repositoryFilesChanged: false, approvalRecorded: false, next: 'Review the open designer, then use Save bundle & review import. No import or activation was performed.' };
      } catch (error) {
        request.failedSource = source;
        const code = WorkflowMarkupPanel.refusalCode(error);
        const unexpected = error instanceof TypeError || error instanceof ReferenceError;
        const correctable = !unexpected && (compilerResponded || ['WORKFLOW_MARKUP_INVALID', 'WORKFLOW_MARKUP_GRAPH_INVALID',
          'WORKFLOW_MARKUP_PHASE_UNKNOWN', 'WORKFLOW_MARKUP_LIMIT', 'WORKFLOW_MARKUP_CATALOG_REQUIRED'].includes(code ?? ''));
        const internal = !correctable && (unexpected || code == null || ['WORKFLOW_MARKUP_COMPILER_FAILED', 'SINGULARITY_FLOW_ERROR', 'SINGULARITY_FLOW_CLI_ERROR'].includes(code));
        if (correctable) request.attempts++;
        else request.stopped = internal
          ? 'Draft checking stopped after an internal compiler or transport failure. Do not spend correction attempts; preserve the draft, repair or align SFlow, then request a fresh designer handoff.'
          : `Draft checking stopped at ${code}. Resolve this prerequisite or human decision, then request a fresh designer handoff; do not spend markup correction attempts.`;
        // This closed engine code is issued only after parsing and credential screening. Never
        // persist a rejected credential-bearing source, or a transport failure's unscreened bytes.
        const retain = code === 'WORKFLOW_MARKUP_COMPILER_FAILED';
        const message = internal && !retain
          ? 'The compiler or its transport did not complete. This is not a markup correction. Stop automatic retries, preserve the candidate and repair or align SFlow before requesting a fresh designer handoff.'
          : (error as Error).message;
        if (current()) post({ type: retain ? 'markup.draftFailed' : 'markup.error', revision: request.revision,
          message, ...(code ? { code } : {}), ...(retain ? { source } : {}) });
        if (internal && !retain) throw new Error(message, { cause: error });
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
      'markup.attach': async message => {
        const requested = integerField(message, 'revision'), mode = stringField(message, 'mode');
        if (busy || requested !== revision || !['files', 'folder'].includes(mode ?? '')) { post({ type: 'markup.error', revision, message: 'Finish the current designer action before attaching files.' }); return; }
        busy = true; const repository = client.repository;
        const current = () => !disposed && revision === requested && client.repository === repository;
        try {
          const selected = await vscode.window.showOpenDialog({ title: mode === 'folder' ? 'Attach a folder of agents, skills and instructions' : 'Attach team guidance from your computer',
            canSelectFiles: mode === 'files', canSelectFolders: mode === 'folder', canSelectMany: mode === 'files',
            ...(mode === 'files' ? { filters: { 'Guidance files': ['md', 'markdown', 'txt', 'mdc', 'json', 'yaml', 'yml'] } } : {}) });
          if (!selected?.length) { post({ type: 'markup.done', revision: requested, message: 'Attachment selection cancelled. Your draft is unchanged.' }); return; }
          if (selected.some(item => item.scheme !== 'file') || !current()) throw new Error('Choose local files for the current designer. Nothing was attached.');
          const notices = await attachments.capture(client, selected.map(item => item.fsPath), mode === 'folder', current);
          reviewed = null; handoff = null; revision++;
          post({ type: 'markup.attachments', previousRevision: requested, revision, items: attachments.list(), notices });
        } catch (error) { post({ type: 'markup.error', revision: requested, message: (error as Error).message }); }
        finally { busy = false; }
      },
      'markup.removeAttachment': message => {
        if (integerField(message, 'revision') !== revision) return;
        try { attachments.remove(stringField(message, 'id') ?? ''); reviewed = null; handoff = null; }
        catch (error) { post({ type: 'markup.error', revision, message: (error as Error).message }); }
      },
      'markup.attachmentKind': message => {
        if (integerField(message, 'revision') !== revision) return;
        try { attachments.setKind(stringField(message, 'id') ?? '', stringField(message, 'kind') ?? ''); reviewed = null; handoff = null; }
        catch (error) { post({ type: 'markup.error', revision, message: (error as Error).message }); }
      },
      'markup.previewAttachment': message => {
        if (integerField(message, 'revision') !== revision) return;
        try { post({ type: 'markup.attachmentPreview', revision, item: attachments.read(stringField(message, 'id') ?? '') }); }
        catch (error) { post({ type: 'markup.error', revision, message: (error as Error).message }); }
      },
      'markup.inspectPhase': async message => {
        const selected = reviewed, phase = stringField(message, 'phase'), request = integerField(message, 'request');
        if (!selected || selected.revision !== integerField(message, 'revision') || client.repository !== selected.repository
            || !selected.result.designReview?.phases.some(item => item.id === phase)) {
          post({ type: 'markup.inspectionError', revision, request, message: 'Check the current draft, then choose one of its phases.' }); return;
        }
        try {
          if (!selected.inspections.has(phase!)) selected.inspections.set(phase!, (async () => {
            const result = await client.runWithInput<MarkupResult>(['workflow', 'markup', 'compile', '-', '--inspect-phase', phase!, '--json'], selected.source);
            if (result.sourceSha256 !== selected.result.sourceSha256 || result.bundleSha256 !== selected.result.bundleSha256
                || result.designReview?.inspection?.phase !== phase) throw new Error('The candidate or library changed. Recheck the preserved draft before inspecting its guidance.');
            return result.designReview.inspection;
          })());
          const inspection = await selected.inspections.get(phase!);
          if (!disposed && selected === reviewed && client.repository === selected.repository) post({ type: 'markup.phaseInspection', revision, request, inspection });
          else if (!disposed) post({ type: 'markup.inspectionError', revision: selected.revision, request, message: 'The draft or repository changed. Recheck before inspecting its guidance.' });
        } catch (error) {
          selected.inspections.delete(phase!);
          if (selected === reviewed) post({ type: 'markup.inspectionError', revision, request, message: (error as Error).message });
        }
      },
      'markup.catalog': async message => {
        catalogRead?.abort();
        const controller = new AbortController(); catalogRead = controller;
        try {
          const selected = catalogKind(stringField(message, 'catalogSource'));
          const kind = stringField(message, 'kind'), query = stringField(message, 'query'), expected = stringField(message, 'expectedSource');
          const args = ['--limit', '16', '--cursor', String(integerField(message, 'cursor') ?? 0)];
          if (kind) args.push('--kind', kind); if (query) args.push('--query', query); if (expected) args.push('--expected-source', expected);
          const result = await readCatalog(selected, args, controller.signal);
          if (controller.signal.aborted || catalogRead !== controller) return;
          post({ type: 'markup.catalogResult', catalogSource: selected, request: integerField(message, 'request'), result });
        } catch (error) { if (!controller.signal.aborted) post({ type: 'markup.catalogError', request: integerField(message, 'request'), message: (error as Error).message }); }
        finally { if (catalogRead === controller) catalogRead = null; }
      },
      'markup.cancelCatalog': async () => { catalogRead?.abort(); catalogRead = null; },
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
          const result = await client.runWithInput<MarkupResult>(['workflow', 'markup', 'compile', '-', '--design-review', '--json'], source);
          if (disposed || requested !== revision || client.repository !== repository) { post({ type: 'markup.error', message: 'The source or repository changed. Check again.', revision: requested }); return; }
          const intent = stringField(message, 'intent')?.trim() ?? '';
          const selected = catalogKind(stringField(message, 'catalogSource'));
          verifyDraft(result, intent, selected, selectedLibrary(message as { selectedAssets?: unknown }));
          reviewed = { source, result, revision, repository, inspections: new Map() };
          post({ type: 'markup.checked', revision, result: reviewPayload(result) });
        } catch (error) { post({ type: 'markup.error', revision: requested, message: (error as Error).message }); }
        finally { busy = false; }
      },
      'markup.copilot': async message => {
        if (busy) { post({ type: 'markup.error', revision, message: 'A designer action is already running. Your draft is retained.' }); return; }
        busy = true;
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
          const preflight = await client.run<IntentPreflight>(['workflow', 'intent', 'preflight', '--source', selected, '--json']);
          if (preflight.resultType !== 'workflow-intent-preflight' || preflight.capabilities?.protocol !== 1
              || !Array.isArray(preflight.capabilities.grammarVersions) || !preflight.capabilities.grammarVersions.includes(2)
              || preflight.capabilities.cli?.compile !== true || preflight.capabilities.cli.catalog !== true
              || preflight.capabilities.cli.asset !== true || preflight.capabilities.cli.attachments !== true
              || preflight.capabilities.cli.documentation !== true
              || !/^sha256:[a-f0-9]{64}$/.test(preflight.capabilities.engine?.sha256 ?? '')
              || !/^sha256:[a-f0-9]{64}$/.test(preflight.sourceSha256 ?? '') || preflight.catalog?.resultType !== 'workflow-intent-catalog'
              || preflight.catalog?.sourceSha256 !== preflight.sourceSha256
              || !Array.isArray(preflight.approvalAuthorities) || preflight.approvalAuthorities.length > 256
              || preflight.approvalAuthorities.some(group => typeof group?.id !== 'string' || !group.id || group.id.length > 256)) {
            throw new Error('The selected CLI cannot verify this designer protocol. Your draft is retained. Open After install and align the CLI, extension and plugin before retrying.');
          }
          const catalog = preflight.catalog;
          if (disposed || repository !== client.repository || requested !== revision) throw new Error('The repository or intent changed. Review the current intent before opening Copilot.');
          const chosen = selectedLibrary(message as { selectedAssets?: unknown });
          const attachmentReads = attachments.prepareHandoff();
          const selectedGroup = !preflight.approvalAuthorities.length ? { group: null } : await vscode.window.showQuickPick([
            ...preflight.approvalAuthorities.map(group => ({ label: group.label || group.id, description: group.id, group })),
            { label: 'Keep draft without choosing a group', description: 'No checkpoint authority is selected; nothing is imported or activated.', group: undefined }
          ], { title: 'Choose the approval group for requested checkpoints', placeHolder: 'This selects a group, not an approval. Preserve the draft if you are not ready.' });
          if (selectedGroup?.group === undefined) {
            post({ type: 'markup.done', revision: requested, message: 'Draft retained locally with unresolved checkpoint authority. Select an existing group before generating an import-ready workflow; no model request was sent.' }); return;
          }
          if (disposed || repository !== client.repository || requested !== revision) throw new Error('The repository or intent changed while selecting authority. Your draft is retained.');
          handoff = { intent, selected, catalog, assets: chosen, revision: requested, repository, attempts: 0, failedSource: null, stopped: null };
          const query = intentRuntime.workflowIntentPrompt({ repository, selected, catalog, intent, source, tool: nativeTool, revision: requested,
            attachments: attachments.prompt(), attachmentReads, selectedAssets: chosen, checkpointGroup: selectedGroup.group ?? undefined,
            cliLocation: client.location, platform: process.platform, capabilities: preflight.capabilities });
          await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: true });
          post({ type: 'markup.done', revision: requested, message: 'Your request is ready in Copilot. Review and send it there; the checked workflow will return to this designer.' });
        } catch (error) { post({ type: 'markup.error', revision, message: (error as Error).message }); }
        finally { busy = false; }
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
          attachments.verify(selected.result.attachmentMappings);
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
    panel.onDidDispose(() => { disposed = true; catalogRead?.abort(); catalogRead = null; reviewed = null; handoff = null; nativeTool.dispose(); listener.dispose(); });
  }
}

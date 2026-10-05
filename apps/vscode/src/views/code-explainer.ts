/**
 * Code Explainer: an interactive explanation of the source code a change touches.
 *
 * The host gathers facts and the page draws them. Facts come from three places only: the Story's
 * captured change (the comprehension slice this panel leases — the XPL2 change view and its bounded
 * patch), the working files, and the editor's own language services (document symbols, call
 * hierarchy, references, hovers), which is what makes the graph method-level and live for any
 * language with a language extension installed. Nothing here asks a model; "Ask Copilot" only opens
 * chat with a prompt the person reviews before sending.
 *
 * Every action from the page names this build's model id and a symbol, module or edge id. The host
 * resolves those against its own model and the locations it recorded while harvesting; it never
 * opens a path, runs a command or follows a URL that came from the page.
 */
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { ComprehensionIdeSnapshot } from '../cli/snapshot.ts';
import { repositoryRelativePath } from '../explain-target.ts';
import { DEFAULT_COMPREHENSION_SLICE_LEASE_MS, type SliceLease, type WorkspaceStore } from '../state.ts';
import { changeExplorerDiffHost } from './change-explorer-diff.ts';
import { containedWorkingPath, readExactSource } from './change-explorer-source.ts';
import {
  buildCodeExplainerModel, changePrompt, convertSymbols, copilotPrompt, CX_LIMITS, diffLines, explanationText, exportDocument, externalLabel, hoverParts,
  isCodeLanguage, isTestPath, languageOf, symbolKey,
  type CxBuildInput, type CxDiffHunk, type CxCallEnd, type CxCallInput, type CxChangeView, type CxFileInput, type CxModel, type CxRawSymbol
} from './code-explainer-model.ts';
import { CODE_EXPLAINER_SCRIPT, codeExplainerBody } from './code-explainer-page.ts';
import { enumField, integerField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { navigateTo } from './navigate.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';

/** A file and, from the editor, the line the person asked about. */
export interface CodeExplainerFocus { path: string; line: number | null }

/** The readiness gate count the status bar already shows for the selected Story. */
export type GateCount = { met: number; total: number; unmet: number; outstanding: number };

export interface CodeExplainerServices {
  /** The status bar's gate count for this repository and Story, or null until it has one. */
  gates?: () => GateCount | null;
}

/** What one harvest recorded about where things are, so actions never trust the page. */
interface Locations {
  root: string;
  /** Absolute file per module id (repository modules and the files behind external ones). */
  modules: Map<string, string>;
  /** Absolute file and line per symbol key, for symbols the call hierarchy found outside harvested files. */
  symbols: Map<string, { file: string; line: number }>;
}

const FIRST_REQUEST_MS = 20_000;
const REQUEST_MS = 8_000;

/** What the language services answered during one build, so a sparse graph can say why. */
interface ServiceStats { asked: number; answered: number; empty: number; failed: number; timedOut: number; errors: string[] }

function serviceStats(): ServiceStats {
  return { asked: 0, answered: 0, empty: 0, failed: 0, timedOut: 0, errors: [] };
}

function withTimeout<T>(work: Thenable<T> | Promise<T>, ms: number, stats?: ServiceStats): Promise<T | undefined> {
  if (stats) stats.asked += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (stats) stats.timedOut += 1; resolve(undefined); }, ms);
    Promise.resolve(work).then((value) => {
      clearTimeout(timer);
      if (stats) {
        if (value === undefined || value === null || (Array.isArray(value) && !value.length)) stats.empty += 1;
        else stats.answered += 1;
      }
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      if (stats) {
        stats.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (stats.errors.length < 3 && !stats.errors.includes(message)) stats.errors.push(message.slice(0, 200));
      }
      resolve(undefined);
    });
  });
}

async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function rangeLines(range: vscode.Range): { start: number; end: number } {
  return { start: range.start.line + 1, end: range.end.line + 1 };
}

export class CodeExplainerPanel {
  private static current: CodeExplainerPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private model: CxModel | null = null;
  private locations: Locations | null = null;
  private slice: ComprehensionIdeSnapshot | null = null;
  private builtRevision: string | null = null;
  private generation = 0;
  private depth = 1;
  private request = 0;
  private lease: SliceLease | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private storeSubscription: { dispose(): void } | null = null;
  private diffController: AbortController | null = null;
  private pageReady = false;
  private building = false;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly client: SingularityFlowClient,
    private readonly extension: vscode.ExtensionContext,
    private focus: CodeExplainerFocus | null,
    private readonly services: CodeExplainerServices
  ) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.renewLease();
      else this.releaseLease();
    }, null, this.subscriptions);
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!this.model || !this.locations) return;
      if ([...this.locations.modules.values()].some((file) => path.resolve(file) === path.resolve(document.uri.fsPath))) {
        this.post({ type: 'cx.stale' });
      }
    }, null, this.subscriptions);
    this.storeSubscription = store.onDidChange((state, change) => {
      if (change.kind !== 'snapshot' || !this.model) return;
      const revision = state.snapshot?.revision?.slices?.comprehension ?? null;
      if (revision && this.builtRevision && revision !== this.builtRevision) this.post({ type: 'cx.stale' });
    });
    const token = nonce();
    panel.webview.html = page('Code Explainer', codeExplainerBody(token), contentSecurityPolicy(panel.webview, token), token, CODE_EXPLAINER_SCRIPT);
  }

  /** Open the explainer, or bring it forward focused on a file and line. */
  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    client: SingularityFlowClient,
    { focus = null, services = {} }: { focus?: CodeExplainerFocus | null; services?: CodeExplainerServices } = {}
  ): CodeExplainerPanel {
    const existing = CodeExplainerPanel.current;
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (focus) existing.applyFocus(focus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.codeExplainer', 'Code Explainer', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    CodeExplainerPanel.current = new CodeExplainerPanel(panel, store, client, context, focus, services);
    return CodeExplainerPanel.current;
  }

  /**
   * The page's closed vocabulary. Each action carries the model id it was rendered from and an
   * increasing request number; a stale or replayed one is refused visibly.
   */
  private router = registerMessageRouter('singularityFlow.codeExplainer', {
    'cx.ready': () => this.pageLoaded(),
    'cx.reindex': (message) => { if (this.accept(message, { allowStale: true })) void this.build(); },
    'cx.depth': (message) => {
      if (!this.accept(message, { allowStale: true })) return;
      const depth = integerField(message, 'depth');
      if (depth === null || depth < 1 || depth > CX_LIMITS.maxDepth) return;
      this.depth = depth;
      void this.build();
    },
    'cx.open': (message) => { if (this.accept(message)) void this.openSymbol(stringField(message, 'symbol')); },
    'cx.openModule': (message) => { if (this.accept(message)) void this.openModule(stringField(message, 'module')); },
    'cx.openTest': (message) => { if (this.accept(message)) void this.openTest(stringField(message, 'symbol'), integerField(message, 'index')); },
    'cx.openSite': (message) => { if (this.accept(message)) void this.openSite(stringField(message, 'edge'), integerField(message, 'line')); },
    'cx.diff': (message) => { if (this.accept(message)) void this.openDiff(stringField(message, 'symbol')); },
    'cx.ask': (message) => { if (this.accept(message, { allowStale: true })) void this.ask(stringField(message, 'symbol')); },
    'cx.copy': (message) => { if (this.accept(message, { allowStale: true })) void this.copy(stringField(message, 'symbol')); },
    'cx.export': (message) => { if (this.accept(message, { allowStale: true })) void this.exportModel(); },
    'cx.changeExplorer': (message) => {
      if (this.accept(message, { allowStale: true })) void this.openChangeExplorer(stringField(message, 'symbol'), stringField(message, 'module'));
    },
    'cx.story': (message) => {
      if (!this.accept(message, { allowStale: true })) return;
      const to = enumField(message, 'to', ['journey', 'approvals'] as const);
      if (to) void vscode.commands.executeCommand(to === 'journey' ? 'singularityFlow.openJourney' : 'singularityFlow.openApprovals');
    }
  });

  private accept(message: InboundMessage, { allowStale = false }: { allowStale?: boolean } = {}): boolean {
    const request = integerField(message, 'request');
    if (!this.model || message.model !== this.model.id) {
      if (!allowStale) this.notice('That selection belongs to an earlier view. It was rebuilt; select it again.', 'warn');
      return allowStale && Boolean(this.model);
    }
    if (request === null || request <= this.request) return false;
    this.request = request;
    return true;
  }

  private post(message: Record<string, unknown>): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private notice(text: string, tone: 'info' | 'warn' | 'bad' = 'info'): void {
    this.post({ type: 'cx.notice', text, tone });
  }

  private pageLoaded(): void {
    this.pageReady = true;
    if (this.model) this.post({ type: 'cx.model', model: this.model, reset: true, progress: this.building ? 'Indexing…' : null });
    else if (!this.building) void this.build();
  }

  private applyFocus(focus: CodeExplainerFocus): void {
    this.focus = focus;
    const model = this.model;
    const symbol = model && focus.line !== null ? model.symbols
      .filter((entry) => entry.moduleId === `m:${focus.path}` && entry.start !== null && entry.end !== null
        && entry.start <= focus.line! && focus.line! <= entry.end!)
      .sort((a, b) => (a.end! - a.start!) - (b.end! - b.start!))[0] : null;
    if (symbol && symbol.callStatus === 'complete') this.post({ type: 'cx.focus', symbol: symbol.id });
    else void this.build();
  }

  private renewLease(): void {
    if (this.lease) {
      try { this.lease.renew(DEFAULT_COMPREHENSION_SLICE_LEASE_MS); return; } catch { this.lease = null; }
    }
    void this.acquireLease().catch(() => undefined);
  }

  private async acquireLease(): Promise<void> {
    if (this.lease) return;
    this.lease = await this.store.acquireSlices('code-explainer', ['comprehension'], { ttlMs: DEFAULT_COMPREHENSION_SLICE_LEASE_MS });
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = setInterval(() => { if (this.panel.visible) this.renewLease(); }, Math.floor(DEFAULT_COMPREHENSION_SLICE_LEASE_MS / 2));
    this.renewal.unref?.();
  }

  private releaseLease(): void {
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = null;
    this.lease?.dispose();
    this.lease = null;
  }

  private progress(text: string | null): void {
    this.post({ type: 'cx.progress', text });
  }

  /** Read the change and ask the language services, posting a model after each stage. */
  private async build(): Promise<void> {
    const generation = ++this.generation;
    this.building = true;
    try {
      await this.harvest(generation);
    } finally {
      if (generation === this.generation) this.building = false;
    }
  }

  private async harvest(generation: number): Promise<void> {
    const started = Date.now();
    const current = () => generation === this.generation && !this.disposed;
    const root = this.store.current.snapshot?.repository?.root ?? this.client.repository;
    if (!root) {
      this.post({ type: 'cx.empty', text: 'Open a governed repository to explain its code.' });
      return;
    }
    this.progress('Reading the captured change…');
    let sliceNote: string | null = null;
    try {
      if (!this.lease) await this.acquireLease();
      else await this.store.refresh();
    } catch (error) {
      sliceNote = `The captured change is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!current()) return;
    const snapshot = this.store.current.snapshot;
    const slice = snapshot?.comprehension ?? null;
    const usable = slice && path.resolve(slice.context.repository) === path.resolve(root) ? slice : null;
    this.slice = usable;
    this.builtRevision = snapshot?.revision?.slices?.comprehension ?? null;
    const view = (usable?.explanationView ?? null) as CxChangeView | null;
    const patch = usable?.diff.status === 'available' ? usable.diff.patch : null;
    const patchFiles = usable?.diff.fileProjectionStatus === 'available' ? usable.diff.files : [];

    const locations: Locations = { root, modules: new Map(), symbols: new Map() };
    const notes: string[] = sliceNote ? [sliceNote] : [];
    const truncated: string[] = [];
    const files = new Map<string, CxFileInput>();
    const changed = view
      ? view.inventory.files.map((file) => ({ path: file.pathAfter ?? file.pathBefore ?? file.path, after: file.pathAfter }))
      : patchFiles.map((file) => ({ path: file.pathAfter ?? file.pathBefore ?? '', after: file.pathAfter }));
    let targets = changed.filter((file) => file.after && isCodeLanguage(languageOf(file.after))).map((file) => file.after!);
    if (targets.length > CX_LIMITS.changedFiles) {
      truncated.push(`${targets.length - CX_LIMITS.changedFiles} more changed code files were not analysed`);
      targets = targets.slice(0, CX_LIMITS.changedFiles);
    }
    const focus = this.focus;
    if (focus && !targets.includes(focus.path)) targets.push(focus.path);
    for (const file of changed) locations.modules.set(`m:${file.path}`, path.join(root, file.path));

    // Stage 1: symbols of every changed code file (and the focused one).
    let firstRequest = true;
    const languageReady = new Map<string, number>();
    let done = 0;
    await mapLimit(targets, 4, async (relative) => {
      const file = path.join(root, relative);
      locations.modules.set(`m:${relative}`, file);
      const uri = vscode.Uri.file(file);
      const document = await withTimeout(vscode.workspace.openTextDocument(uri), REQUEST_MS);
      if (!document) {
        files.set(relative, { path: relative, language: languageOf(relative), lines: null, symbols: null, symbolReason: 'the file could not be opened' });
        return;
      }
      const lines = document.getText().split(/\r?\n/);
      const ms = firstRequest ? FIRST_REQUEST_MS : REQUEST_MS;
      firstRequest = false;
      // A language extension activates when its first document opens, and until it registers its
      // providers the editor answers with nothing. Ask again, briefly, until the language has
      // answered for some file; an empty answer asked after that is genuine.
      const language = document.languageId;
      const substantial = lines.filter((line) => line.trim()).length >= 3;
      const ask = async () => convertSymbols(await withTimeout(vscode.commands.executeCommand<unknown>('vscode.executeDocumentSymbolProvider', uri), ms));
      let askedAt = Date.now();
      let symbols = await ask();
      for (const wait of [300, 700, 1500, 3000]) {
        if (!substantial || (symbols && symbols.length) || !current()) break;
        const readyAt = languageReady.get(language);
        if (readyAt !== undefined && readyAt <= askedAt) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
        askedAt = Date.now();
        symbols = await ask();
      }
      if (symbols?.length && !languageReady.has(language)) languageReady.set(language, Date.now());
      files.set(relative, {
        path: relative, language: document.languageId, lines,
        symbols: symbols && symbols.length ? symbols : symbols ? [] : null,
        symbolReason: symbols ? null : `no symbol provider answered for ${document.languageId}`
      });
      done += 1;
      if (current()) this.progress(`Reading symbols ${done}/${targets.length}…`);
    });
    if (!current()) return;

    // Stage 1b: when the bounded patch does not cover a changed code file (a Story's own records
    // often push it past its preview limit), diff the exact base-revision bytes, read through the
    // comprehension source owner, against the editor's current text.
    const computed: Record<string, CxDiffHunk[]> = {};
    if (usable && view) {
      const covered = new Set(patchFiles.map((file) => file.pathAfter ?? file.pathBefore).filter(Boolean));
      const needing = view.inventory.files.filter((file) => {
        const relative = file.pathAfter ?? file.pathBefore ?? file.path;
        return !covered.has(relative) && isCodeLanguage(files.get(relative)?.language ?? languageOf(relative))
          && (file.pathAfter ? files.has(relative) : true);
      }).slice(0, CX_LIMITS.changedFiles);
      const run = (args: string[], signal?: AbortSignal) => this.client.run(args, signal);
      const context = { base: usable.context.base, workId: usable.context.workId, phase: usable.context.phase };
      const textLines = (text: string) => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []);
      let read = 0;
      await mapLimit(needing, 4, async (file) => {
        const relative = file.pathAfter ?? file.pathBefore ?? file.path;
        const sources = (file as { sources?: { before?: string } }).sources;
        const reference = sources?.before ? usable.sourceReferences.find((entry) => entry.ref === sources.before) ?? null : null;
        const working = files.get(relative)?.lines;
        const after = file.pathAfter && working ? textLines(working.join('\n')) : [];
        try {
          const before = reference ? await readExactSource(run, context, reference) : null;
          if (before?.binary) return;
          computed[relative] = diffLines(before ? textLines(before.text) : [], after);
        } catch (error) {
          notes.push(`${relative}: the base version could not be read (${error instanceof Error ? error.message : String(error)}).`);
        }
        read += 1;
        if (current()) this.progress(`Diffing changed code ${read}/${needing.length}…`);
      });
      if (!current()) return;
    }

    const story = snapshot?.workflow ?? null;
    const input: CxBuildInput = {
      repository: {
        name: path.basename(root),
        branch: snapshot?.repository?.branch ?? snapshot?.revision?.branch ?? null,
        head: snapshot?.revision?.head ?? null
      },
      story: story ? {
        workId: story.workItem.id, title: story.workItem.title ?? null, branch: story.workItem.branch ?? null,
        currentPhase: story.currentPhase, phaseOrder: story.phaseOrder,
        phases: Object.fromEntries(Object.entries(story.phases).map(([id, phase]) => [id, { label: phase.label, status: phase.status, generation: phase.generation }])),
        approval: snapshot?.approval ?? null,
        gates: null
      } : null,
      change: {
        view, unavailableReason: usable ? usable.explanationViewUnavailableReason ?? null : (sliceNote ?? 'No captured change is available.'),
        patch, patchFiles, base: usable?.context.base ?? null, computed
      },
      files: [...files.values()],
      calls: [],
      callStatus: {},
      references: [],
      referenceStatus: {},
      hovers: {},
      focus,
      depth: this.depth,
      modelEnabled: vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') !== 'disabled',
      notes,
      truncated,
      status: 'pending'
    };
    const publish = (reset: boolean, progress: string | null) => {
      if (!current()) return;
      if (input.story) input.story.gates = this.services.gates?.() ?? null;
      this.model = buildCodeExplainerModel({ ...input, durationMs: input.status === 'pending' ? null : Date.now() - started }, `cx-${generation}`);
      this.locations = locations;
      this.request = 0;
      if (this.pageReady) this.post({ type: 'cx.model', model: this.model, reset, progress });
    };
    publish(true, 'Tracing calls…');

    // Stage 2: call hierarchy from each changed (or focused) callable, out to the chosen depth.
    const seedModel = this.model!;
    const seeds = seedModel.symbols.filter((symbol) => (symbol.role === 'changed' || symbol.role === 'focus')
      && symbol.start !== null && ['function', 'method', 'constructor', 'class'].includes(symbol.kind)
      && (symbol.kind !== 'class' || symbol.role === 'focus'));
    const rawByKey = new Map<string, { relative: string; raw: CxRawSymbol }>();
    const visitRaw = (relative: string, entries: CxRawSymbol[]) => {
      for (const entry of entries) {
        rawByKey.set(symbolKey(relative, entry.selection.line, entry.name), { relative, raw: entry });
        if (entry.children?.length) visitRaw(relative, entry.children);
      }
    };
    for (const file of files.values()) if (file.symbols) visitRaw(file.path, file.symbols);
    let requests = 0;
    const budget = () => requests < CX_LIMITS.callRequests;
    const endFor = async (item: vscode.CallHierarchyItem): Promise<CxCallEnd> => {
      const relative = item.uri.scheme === 'file' ? await repositoryRelativePath(root, item.uri.fsPath) : null;
      const external = !relative || relative.split('/').includes('node_modules');
      const label = external ? externalLabel(item.uri.fsPath || item.uri.path) : null;
      const filePath = external ? `external:${label}` : relative!;
      const end: CxCallEnd = {
        path: filePath, name: item.name, kind: item.kind, detail: item.detail ?? null,
        range: rangeLines(item.range),
        selection: { line: item.selectionRange.start.line + 1, character: item.selectionRange.start.character }
      };
      const key = symbolKey(filePath, end.selection.line, end.name);
      locations.symbols.set(key, { file: item.uri.fsPath, line: end.selection.line });
      if (external) {
        if (!files.has(filePath)) files.set(filePath, { path: filePath, language: languageOf(item.uri.fsPath), lines: null, symbols: null, external: true, label });
        if (!locations.modules.has(`m:${filePath}`)) locations.modules.set(`m:${filePath}`, item.uri.fsPath);
      } else if (!files.has(filePath)) {
        locations.modules.set(`m:${filePath}`, item.uri.fsPath);
        const document = files.size < CX_LIMITS.changedFiles + CX_LIMITS.otherFiles
          ? await withTimeout(vscode.workspace.openTextDocument(item.uri), REQUEST_MS) : undefined;
        if (!files.has(filePath)) {
          files.set(filePath, {
            path: filePath, language: document?.languageId ?? languageOf(filePath),
            lines: document ? document.getText().split(/\r?\n/) : null, symbols: null, symbolReason: null
          });
        }
      }
      return end;
    };
    const calls: CxCallInput[] = [];
    const seen = new Set<string>();
    const prepareStats = serviceStats();
    const callStats = serviceStats();
    const itemKey = (item: vscode.CallHierarchyItem) => `${item.uri.toString()}#${item.selectionRange.start.line}:${item.name}`;
    type Frontier = { item: vscode.CallHierarchyItem; direction: 'in' | 'out' | 'both'; depth: number; key: string | null };
    let frontier: Frontier[] = [];
    let traced = 0;
    let bounded = false;
    await mapLimit(seeds, 4, async (symbol) => {
      if (!budget() || !current()) return;
      const located = rawByKey.get(symbol.key);
      if (!located) return;
      const uri = vscode.Uri.file(path.join(root, located.relative));
      requests += 1;
      const prepared = await withTimeout(vscode.commands.executeCommand<vscode.CallHierarchyItem[] | vscode.CallHierarchyItem>(
        'vscode.prepareCallHierarchy', uri, new vscode.Position(located.raw.selection.line - 1, located.raw.selection.character)), REQUEST_MS, prepareStats);
      const item = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!item) { input.callStatus[symbol.key] = 'unavailable'; return; }
      seen.add(itemKey(item));
      frontier.push({ item, direction: 'both', depth: 1, key: symbol.key });
    });
    while (frontier.length && current()) {
      const next: Frontier[] = [];
      await mapLimit(frontier, 4, async (entry) => {
        let answered = false;
        let failed = false;
        const externalCallees: string[] = [];
        if (entry.direction !== 'out' && budget()) {
          requests += 1;
          const incoming = await withTimeout(vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', entry.item), REQUEST_MS, callStats);
          if (Array.isArray(incoming)) {
            answered = true;
            const to = await endFor(entry.item);
            for (const call of incoming.slice(0, 40)) {
              const from = await endFor(call.from);
              calls.push({ from, to, sites: call.fromRanges.map((range) => range.start.line + 1) });
              const key = itemKey(call.from);
              if (entry.depth < this.depth && !seen.has(key) && !from.path.startsWith('external:')) {
                if (seen.size >= CX_LIMITS.symbols) { bounded = true; continue; }
                seen.add(key);
                next.push({ item: call.from, direction: 'in', depth: entry.depth + 1, key: null });
              }
            }
          } else failed = true;
        }
        if (entry.direction !== 'in' && budget()) {
          requests += 1;
          const outgoing = await withTimeout(vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', entry.item), REQUEST_MS, callStats);
          if (Array.isArray(outgoing)) {
            answered = true;
            const from = await endFor(entry.item);
            for (const call of outgoing.slice(0, 40)) {
              const to = await endFor(call.to);
              if (to.path.startsWith('external:')) {
                if (externalCallees.length >= 6) continue;
                externalCallees.push(to.name);
              }
              calls.push({ from, to, sites: call.fromRanges.map((range) => range.start.line + 1) });
              const key = itemKey(call.to);
              if (entry.depth < this.depth && !seen.has(key) && !to.path.startsWith('external:')) {
                if (seen.size >= CX_LIMITS.symbols) { bounded = true; continue; }
                seen.add(key);
                next.push({ item: call.to, direction: 'out', depth: entry.depth + 1, key: null });
              }
            }
          } else failed = true;
        }
        if (entry.key) input.callStatus[entry.key] = answered ? 'complete' : failed ? 'unavailable' : 'not-requested';
        else {
          const end = await endFor(entry.item);
          input.callStatus[symbolKey(end.path, end.selection.line, end.name)] = answered ? 'complete' : 'unavailable';
        }
        traced += 1;
        if (current()) this.progress(`Tracing calls ${traced}…`);
      });
      frontier = next;
    }
    if (bounded) truncated.push(`the call graph stopped growing at ${CX_LIMITS.symbols} functions`);
    if (!budget()) truncated.push(`call tracing stopped after ${CX_LIMITS.callRequests} language-service requests`);
    const described = (label: string, stats: ServiceStats) => `${label}: ${stats.asked} asked, ${stats.answered} answered`
      + (stats.empty ? `, ${stats.empty} empty` : '') + (stats.failed ? `, ${stats.failed} failed` : '')
      + (stats.timedOut ? `, ${stats.timedOut} timed out` : '') + (stats.errors.length ? ` (${stats.errors.join('; ')})` : '');
    if (prepareStats.asked) notes.push(described('call hierarchy', prepareStats), described('callers and callees', callStats));
    if (!current()) return;
    input.calls = calls;
    input.files = [...files.values()];
    publish(false, 'Finding tests and signatures…');

    // Stage 3: test references and signatures for what changed (and the focus).
    const detailed = this.model!.symbols.filter((symbol) => (symbol.role === 'changed' || symbol.role === 'focus')
      && rawByKey.has(symbol.key) && ['function', 'method', 'constructor', 'class'].includes(symbol.kind));
    const referenceTargets = detailed.slice(0, CX_LIMITS.referenceRequests);
    if (detailed.length > referenceTargets.length) truncated.push(`test references were looked up for the first ${referenceTargets.length} changed symbols`);
    await mapLimit(referenceTargets, 3, async (symbol) => {
      const located = rawByKey.get(symbol.key)!;
      const uri = vscode.Uri.file(path.join(root, located.relative));
      const position = new vscode.Position(located.raw.selection.line - 1, located.raw.selection.character);
      const [references, hovers] = await Promise.all([
        withTimeout(vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position), REQUEST_MS),
        withTimeout(vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position), REQUEST_MS)
      ]);
      if (Array.isArray(references)) {
        input.referenceStatus[symbol.key] = 'complete';
        for (const reference of references.slice(0, 400)) {
          if (reference.uri.scheme !== 'file') continue;
          const relative = await repositoryRelativePath(root, reference.uri.fsPath);
          if (!relative || !isTestPath(relative) || relative.split('/').includes('node_modules')) continue;
          input.references.push({ symbol: symbol.key, path: relative, line: reference.range.start.line + 1 });
          locations.modules.set(`m:${relative}`, reference.uri.fsPath);
        }
      } else input.referenceStatus[symbol.key] = 'unavailable';
      const parts = hoverParts(hovers);
      if (parts.signature || parts.doc) input.hovers[symbol.key] = parts;
    });
    if (!current()) return;
    input.status = truncated.length || sliceNote ? 'partial' : 'complete';
    publish(false, null);
    this.progress(null);
  }

  private locate(symbolId: string | null): { file: string; line: number | null } | null {
    const model = this.model;
    const locations = this.locations;
    if (!model || !locations || !symbolId) return null;
    const symbol = model.symbols.find((entry) => entry.id === symbolId);
    if (!symbol) return null;
    const recorded = locations.symbols.get(symbol.key);
    if (recorded) return { file: recorded.file, line: symbol.line ?? recorded.line };
    const file = locations.modules.get(symbol.file ? `m:${symbol.file}` : symbol.moduleId);
    return file ? { file, line: symbol.line ?? symbol.start ?? (symbol.diff.find((line) => line.a !== null)?.a ?? null) } : null;
  }

  private async openAt(file: string, line: number | null): Promise<void> {
    const root = this.locations?.root;
    if (!root) return;
    const relative = await repositoryRelativePath(root, file);
    let target = file;
    if (relative) {
      const contained = await containedWorkingPath(root, relative);
      if (!contained.target) { this.notice(contained.refusal ?? 'The file is outside the repository.', 'bad'); return; }
      target = contained.target;
    }
    try {
      const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0), preview: true } : { preview: true };
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), options);
    } catch (error) {
      this.notice(`The file could not be opened: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  }

  private async openSymbol(symbolId: string | null): Promise<void> {
    const located = this.locate(symbolId);
    if (!located) { this.notice('That code has no location in this view.', 'warn'); return; }
    await this.openAt(located.file, located.line);
  }

  private async openModule(moduleId: string | null): Promise<void> {
    const file = moduleId ? this.locations?.modules.get(moduleId) : undefined;
    if (!file || moduleId?.startsWith('m:external:')) { this.notice('That file cannot be opened from here.', 'warn'); return; }
    await this.openAt(file, null);
  }

  private async openTest(symbolId: string | null, index: number | null): Promise<void> {
    const symbol = this.model?.symbols.find((entry) => entry.id === symbolId);
    const reference = symbol && index !== null ? symbol.tests[index] : undefined;
    const file = reference ? this.locations?.modules.get(`m:${reference.path}`) ?? path.join(this.locations?.root ?? '', reference.path) : undefined;
    if (!reference || !file) { this.notice('That test reference is not in this view.', 'warn'); return; }
    await this.openAt(file, reference.line);
  }

  private async openSite(edgeId: string | null, line: number | null): Promise<void> {
    const edge = this.model?.edges.find((entry) => entry.id === edgeId);
    if (!edge || line === null || !edge.sites.includes(line)) { this.notice('That call site is not in this view.', 'warn'); return; }
    const located = this.locate(edge.from);
    if (!located) return;
    await this.openAt(located.file, line);
  }

  private async openDiff(symbolId: string | null): Promise<void> {
    const model = this.model;
    const slice = this.slice;
    const symbol = model?.symbols.find((entry) => entry.id === symbolId);
    const view = slice?.explanationView as CxChangeView | null | undefined;
    const filePath = symbol?.file ?? null;
    const inventoryFile = filePath ? view?.inventory.files.find((entry) => (entry.pathAfter ?? entry.pathBefore ?? entry.path) === filePath) : undefined;
    const unitId = symbol?.units[0] ?? inventoryFile?.unitIds[0];
    const unit = unitId ? view?.inventory.units.find((entry) => entry.unitId === unitId) : undefined;
    if (!slice || !view || !unit) { this.notice('No captured change covers this code, so there is no exact diff to open.', 'warn'); return; }
    const file = view.inventory.files.find((entry) => entry.fileId === unit.fileId) as { sources?: { before?: string; after?: string } } | undefined;
    const reference = (ref: string | undefined) => ref ? slice.sourceReferences.find((entry) => entry.ref === ref) ?? null : null;
    const before = reference(file?.sources?.before);
    const after = reference(file?.sources?.after);
    if (!before && !after) { this.notice(`${unit.unitId} has no exact before or after source to show.`, 'warn'); return; }
    this.diffController?.abort();
    const controller = new AbortController();
    this.diffController = controller;
    try {
      await changeExplorerDiffHost(this.extension)({
        client: this.client,
        context: { base: slice.context.base, workId: slice.context.workId, phase: slice.context.phase },
        path: unit.path, unitId: unit.unitId, before, after, signal: controller.signal
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.notice(`The exact diff could not be opened: ${error instanceof Error ? error.message : String(error)} If the code moved, Re-index first.`, 'bad');
      }
    } finally {
      if (this.diffController === controller) this.diffController = null;
    }
  }

  private async ask(symbolId: string | null): Promise<void> {
    const model = this.model;
    if (!model) return;
    if (vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') === 'disabled') {
      this.notice('Model features are turned off (singularityFlow.modelMode is "disabled"), so Copilot is not offered.', 'warn');
      return;
    }
    const prompt = (symbolId ? copilotPrompt(model, symbolId) : null) ?? changePrompt(model);
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: true });
    } catch (error) {
      this.notice(`Copilot Chat could not be opened: ${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  }

  private async copy(symbolId: string | null): Promise<void> {
    const model = this.model;
    if (!model || !symbolId) return;
    const text = explanationText(model, symbolId);
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    this.notice('Explanation copied. It is derived from the code and grants no approval.');
  }

  private async exportModel(): Promise<void> {
    const model = this.model;
    if (!model) return;
    const name = `code-explanation-${(model.story?.workId ?? model.repository.name).replace(/[^A-Za-z0-9._-]/g, '-')}.json`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), name)),
      filters: { JSON: ['json'] },
      saveLabel: 'Export explanation'
    });
    if (!target) return;
    const document = exportDocument(model, new Date().toISOString());
    await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'));
    this.notice(`Saved ${path.basename(target.fsPath)}.`);
  }

  private async openChangeExplorer(symbolId: string | null, moduleId: string | null): Promise<void> {
    const model = this.model;
    const symbol = symbolId ? model?.symbols.find((entry) => entry.id === symbolId) : undefined;
    const module = moduleId ?? symbol?.moduleId ?? null;
    const file = module && !module.startsWith('m:external:') ? this.locations?.modules.get(module) : undefined;
    if (file && model?.modules.find((entry) => entry.id === module)?.units.length) {
      await vscode.commands.executeCommand('singularityFlow.explainFileChanges', vscode.Uri.file(file));
    } else {
      await vscode.commands.executeCommand('singularityFlow.openChangeExplorer');
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.diffController?.abort();
    this.releaseLease();
    this.storeSubscription?.dispose();
    for (const disposable of this.subscriptions.splice(0)) disposable.dispose();
    if (CodeExplainerPanel.current === this) CodeExplainerPanel.current = null;
  }
}

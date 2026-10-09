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
import { access } from 'node:fs/promises';
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
  analysisCalls, buildCodeExplainerModel, changePrompt, codeAreas, convertSymbols, copilotPrompt, CX_LIMITS, CX_OUTPUT_FOLDERS, explanationText, exportDocument,
  externalLabel, fairSample, hoverParts, inArea, isCodeLanguage, isExplainableRepositoryPath, isTestPath, languageOf, repositoryPath, symbolKey, workingDiff,
  type CxAnalysisCall, type CxArea, type CxBuildInput, type CxDiffHunk, type CxCallEnd, type CxCallInput, type CxChangeView, type CxFileInput, type CxModel, type CxRawSymbol,
  type CxView
} from './code-explainer-model.ts';
import { buildLenses } from './code-explainer-lenses.ts';

const LANGUAGE_NAMES: Record<string, string> = {
  java: 'Java', kotlin: 'Kotlin', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', csharp: 'C#', go: 'Go', ruby: 'Ruby', php: 'PHP'
};
function languageLabel(language: string): string { return LANGUAGE_NAMES[language] ?? language; }

/**
 * Why Java has no call hierarchy in this editor, and what gives it one: the Red Hat Java extension,
 * in Standard mode (LightWeight mode answers outlines but not callers and callees), with its project
 * imported.
 */
function javaCallHierarchyHint(): string {
  const java = vscode.extensions.getExtension('redhat.java');
  if (!java) return 'For the editor\'s own Java callers and callees, install "Language Support for Java by Red Hat" (redhat.java).';
  const mode = java.isActive ? (java.exports as { serverMode?: string } | undefined)?.serverMode : undefined;
  if (mode === 'LightWeight') return 'Java is running in LightWeight mode, which has no call hierarchy. Run "Java: Switch to Standard Mode" for the editor\'s own callers and callees.';
  return 'The Java language server gave no call hierarchy yet; it may still be importing the project. Refresh when the Java status in the status bar shows it is ready.';
}
import { CODE_EXPLAINER_SCRIPT, codeExplainerBody } from './code-explainer-page.ts';
import { commandData } from './surface-adapters.ts';
import { enumField, integerField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { navigateTo } from './navigate.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';

/** A file and, from the editor, the line the person asked about. */
export interface CodeExplainerFocus { path: string; line: number | null }

/** The parts of an `explain code --repository` result the host resolves page requests against. */
interface RepositoryExplanationView {
  entries?: Array<{ path: string }>;
  files?: Array<{ path: string; test?: boolean; symbols?: Array<{ line: number }> }>;
  budget?: { status?: string };
}

/** An explanation with every entry and file this panel may not show taken out, so page indexes refer to what is drawn. */
function explainableView(view: RepositoryExplanationView | null): RepositoryExplanationView | null {
  if (!view) return view;
  return {
    ...view,
    ...(Array.isArray(view.entries) ? { entries: view.entries.filter((entry) => isExplainableRepositoryPath(entry.path)) } : {}),
    ...(Array.isArray(view.files) ? { files: view.files.filter((file) => isExplainableRepositoryPath(file.path)) } : {})
  };
}

/** Every code extension the explainer knows, for the editor's file search. */
const CODE_FILE_GLOB = '**/*.{java,kt,kts,scala,groovy,py,ts,tsx,js,jsx,mjs,cjs,cs,fs,vb,go,rb,rs,php,swift,c,h,cpp,cc,hpp,m,mm,dart,lua,vue,svelte,sh,bash,zsh,ps1,psm1,r}';
const LISTING_EXCLUDE = `**/{.git,singularity,.singularity-flow,node_modules,.gradle,.idea,.vscode,__pycache__,.venv,.mvn,${CX_OUTPUT_FOLDERS.join(',')}}/**`;

const SCRIPT_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

/** JavaScript and TypeScript answer callers only from the files their language service has loaded. */
function isScriptPath(relative: string): boolean {
  return SCRIPT_LANGUAGES.has(languageOf(relative));
}

/**
 * Whether the repository names its JavaScript or TypeScript project. Without a jsconfig.json or
 * tsconfig.json the language service knows only the files that are open, so a caller in a file
 * nobody opened is invisible to it.
 */
async function hasScriptProject(root: string): Promise<boolean> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try { await access(path.join(root, name)); return true; } catch { /* absent */ }
  }
  return false;
}

/**
 * A repository-relative folder or file the page may ask about: forward slashes, no `..`, no leading
 * slash, no glob or control characters. Null for anything else; the CLI checks it again.
 */
export function repositoryScope(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!text || text.length > 512 || text.startsWith('/') || /[\\*?[\]{}]|[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text.split('/').some((part) => !part || part === '.' || part === '..') ? null : text;
}

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
  /** Chosen on the page; until then a Story that changed code opens on delta, one that has not on full. */
  private view: CxView | null = null;
  /** The folder the full view is limited to, chosen on the page from `areas`; null maps the whole worktree. */
  private scope: CxArea | null = null;
  private areas: CxArea[] = [];
  private request = 0;
  private repositoryRequest = 0;
  /** The repository explanation the page is showing; page requests resolve against it. */
  private repositoryView: { scope: string | null; explanation: RepositoryExplanationView | null } | null = null;
  private lease: SliceLease | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private storeSubscription: { dispose(): void } | null = null;
  private diffController: AbortController | null = null;
  private pageReady = false;
  private building = false;
  /** A person asked about a line; the next build's view selects what is there. */
  private focusPending = false;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly client: SingularityFlowClient,
    private readonly extension: vscode.ExtensionContext,
    private focus: CodeExplainerFocus | null,
    private readonly services: CodeExplainerServices
  ) {
    this.focusPending = Boolean(focus);
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
    'cx.view': (message) => {
      if (!this.accept(message, { allowStale: true })) return;
      const view = enumField(message, 'view', ['delta', 'full'] as const);
      if (!view) return;
      this.view = view;
      void this.build();
    },
    'cx.scope': (message) => {
      if (!this.accept(message, { allowStale: true })) return;
      // An area of the list this host built, never a path the page names; -1 is the whole worktree.
      const index = integerField(message, 'index');
      if (index === null) return;
      const area = index >= 0 ? this.areas[index] ?? null : null;
      if (index >= 0 && !area) return;
      this.scope = area;
      this.view = 'full';
      void this.build();
    },
    'cx.open': (message) => { if (this.accept(message)) void this.openSymbol(stringField(message, 'symbol')); },
    'cx.openModule': (message) => { if (this.accept(message)) void this.openModule(stringField(message, 'module')); },
    'cx.openTest': (message) => { if (this.accept(message)) void this.openTest(stringField(message, 'symbol'), integerField(message, 'index')); },
    'cx.openSite': (message) => { if (this.accept(message)) void this.openSite(stringField(message, 'edge'), integerField(message, 'line')); },
    'cx.openLine': (message) => { if (this.accept(message)) void this.openLine(stringField(message, 'symbol'), integerField(message, 'line')); },
    'cx.diff': (message) => { if (this.accept(message)) void this.openDiff(stringField(message, 'symbol')); },
    'cx.ask': (message) => { if (this.accept(message, { allowStale: true })) void this.ask(stringField(message, 'symbol')); },
    'cx.copy': (message) => { if (this.accept(message, { allowStale: true })) void this.copy(stringField(message, 'symbol')); },
    'cx.export': (message) => { if (this.accept(message, { allowStale: true })) void this.exportModel(); },
    'cx.changeExplorer': (message) => {
      if (this.accept(message, { allowStale: true })) void this.openChangeExplorer(stringField(message, 'symbol'), stringField(message, 'module'));
    },
    'cx.repository': (message) => {
      if (!this.accept(message, { allowStale: true })) return;
      const to = enumField(message, 'to', ['root', 'up', 'refresh', 'entry'] as const);
      const scope = this.repositoryView?.scope ?? null;
      if (to === 'root') void this.loadRepository(null);
      else if (to === 'refresh') void this.loadRepository(scope);
      else if (to === 'up') void this.loadRepository(scope && scope.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : null);
      else if (to === 'entry') {
        // An entry of the explanation this host read, never a path the page names.
        const entry = this.repositoryView?.explanation?.entries?.[integerField(message, 'index') ?? -1];
        const target = repositoryScope(entry?.path ?? null);
        if (target) void this.loadRepository(target);
      }
    },
    'cx.repoOpen': (message) => {
      if (!this.accept(message, { allowStale: true })) return;
      const file = this.repositoryView?.explanation?.files?.[integerField(message, 'index') ?? -1];
      const line = integerField(message, 'line');
      const target = repositoryScope(file?.path ?? null);
      if (target && line !== null && file?.symbols?.some((symbol) => symbol.line === line)) this.applyFocus({ path: target, line });
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
    if (symbol && symbol.callStatus === 'complete') { this.post({ type: 'cx.focus', symbol: symbol.id }); return; }
    this.focusPending = true;
    void this.build();
  }

  /**
   * What the repository holds, from `explain code --repository`: the whole repository when its
   * code fits the AST budget, otherwise one folder or file at a time, as the reader drills in.
   */
  private async loadRepository(scope: string | null): Promise<void> {
    const request = ++this.repositoryRequest;
    this.repositoryView = { scope, explanation: null };
    this.post({ type: 'cx.repository', path: scope, loading: true });
    try {
      const result = await this.client.run<unknown>(['explain', 'code', '--repository', '--json', ...(scope ? ['--path', scope] : [])]);
      if (request !== this.repositoryRequest) return;
      const explanation = explainableView(commandData<{ repository?: RepositoryExplanationView }>(result)?.repository ?? null);
      this.repositoryView = { scope, explanation };
      this.post({ type: 'cx.repository', path: scope, explanation });
    } catch (error) {
      if (request !== this.repositoryRequest) return;
      this.post({ type: 'cx.repository', path: scope, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The worktree's application code files, from `explain code --repository`; empty when it cannot say. */
  private async repositoryCodeFiles(notes: string[]): Promise<Array<{ path: string; test: boolean }>> {
    try {
      const result = await this.client.run<unknown>(['explain', 'code', '--repository', '--json']);
      const repository = commandData<{ repository?: RepositoryExplanationView }>(result)?.repository;
      const files = repository?.files;
      // Over the AST budget the CLI counts the files but lists none; the editor lists them instead.
      if (!Array.isArray(files) || repository?.budget?.status === 'over-budget') return await this.listedCodeFiles(notes);
      return files.filter((entry) => typeof entry?.path === 'string' && isExplainableRepositoryPath(entry.path) && isCodeLanguage(languageOf(entry.path)))
        .map((entry) => ({ path: entry.path, test: entry.test === true || isTestPath(entry.path) }));
    } catch (error) {
      notes.push(`The worktree's code files could not be listed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * A repository too large for the CLI to list every file (over the AST budget) is listed by the
   * editor's own file search instead, so its folders can still be chosen and mapped.
   */
  private async listedCodeFiles(notes: string[]): Promise<Array<{ path: string; test: boolean }>> {
    const root = this.store.current.snapshot?.repository?.root ?? this.client.repository;
    if (!root) return [];
    try {
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, CODE_FILE_GLOB), LISTING_EXCLUDE, CX_LIMITS.listedFiles);
      const files = found.map((uri) => repositoryPath(path.relative(root, uri.fsPath)))
        .filter((relative) => relative && !relative.startsWith('../') && isExplainableRepositoryPath(relative) && isCodeLanguage(languageOf(relative)))
        .sort((left, right) => left.localeCompare(right, 'en'));
      notes.push(`The repository is larger than the AST budget, so its ${files.length}${found.length >= CX_LIMITS.listedFiles ? '+' : ''} code files were listed from the worktree; choose a folder to map it in depth.`);
      return files.map((relative) => ({ path: relative, test: isTestPath(relative) }));
    } catch (error) {
      notes.push(`The worktree's code files could not be listed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
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
    const changed = (view
      ? view.inventory.files.map((file) => ({ path: file.pathAfter ?? file.pathBefore ?? file.path, after: file.pathAfter }))
      : patchFiles.map((file) => ({ path: file.pathAfter ?? file.pathBefore ?? '', after: file.pathAfter }))
    ).filter((file) => isExplainableRepositoryPath(file.path));
    let targets = changed.filter((file) => file.after && isCodeLanguage(languageOf(file.after))).map((file) => file.after!);
    if (targets.length > CX_LIMITS.changedFiles) {
      truncated.push(`${targets.length - CX_LIMITS.changedFiles} more changed code files were not analysed`);
      targets = targets.slice(0, CX_LIMITS.changedFiles);
    }
    const focus = this.focus;
    if (focus && !targets.includes(focus.path)) targets.push(focus.path);
    for (const file of changed) locations.modules.set(`m:${file.path}`, path.join(root, file.path));
    const graphView: CxView = this.view ?? (targets.length ? 'delta' : 'full');
    const scriptProject = await hasScriptProject(root);
    const repositoryFiles = graphView === 'full' || (!scriptProject && targets.some(isScriptPath))
      ? (this.progress('Listing the worktree\'s code files…'), await this.repositoryCodeFiles(notes)) : [];
    if (!current()) return;
    let areas: CxArea[] = [];
    let scopeIndex: number | null = null;
    if (graphView === 'full') {
      const code = repositoryFiles.filter((file) => !file.test).map((file) => file.path);
      areas = codeAreas(code);
      // A folder chosen before a rebuild is kept when it still exists, by path.
      const chosen = this.scope;
      scopeIndex = chosen ? areas.findIndex((area) => area.path === chosen.path && Boolean(area.own) === Boolean(chosen.own)) : -1;
      if (scopeIndex < 0) scopeIndex = null;
      if (chosen && scopeIndex === null) notes.push(`The folder ${chosen.path || '(top level)'} no longer holds code, so the whole worktree is mapped.`);
      const selectedArea = scopeIndex === null ? null : areas[scopeIndex]!;
      this.scope = selectedArea;
      const inScope = selectedArea ? code.filter((relative) => inArea(relative, selectedArea)) : code;
      const limit = selectedArea ? CX_LIMITS.scopedFiles : CX_LIMITS.fullFiles;
      // Every folder keeps a share of a bound, rather than the alphabetically first files keeping all of it.
      const mapped = fairSample(inScope, (relative) => relative, codeAreas(inScope), limit);
      if (inScope.length > mapped.length) {
        truncated.push(selectedArea
          ? `the full view mapped ${mapped.length} of the ${inScope.length} code files in ${selectedArea.path || 'the top level'}, from each of its folders in turn`
          : `the full view mapped ${mapped.length} of ${inScope.length} code files, taken from each folder in turn; choose a folder to map it in depth`);
      }
      for (const relative of mapped) if (!targets.includes(relative)) targets.push(relative);
    }
    this.areas = areas;

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
      let read = 0;
      await mapLimit(needing, 4, async (file) => {
        const relative = file.pathAfter ?? file.pathBefore ?? file.path;
        const sources = (file as { sources?: { before?: string } }).sources;
        const reference = sources?.before ? usable.sourceReferences.find((entry) => entry.ref === sources.before) ?? null : null;
        const working = files.get(relative)?.lines ?? null;
        // An unreadable working file is not an empty one; leave it to the file-level row.
        if (file.pathAfter && !working) return;
        try {
          const before = reference ? await readExactSource(run, context, reference) : null;
          if (before?.binary) return;
          const hunks = workingDiff(before ? before.text : null, working, !file.pathAfter);
          if (hunks) computed[relative] = hunks;
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
      view: graphView,
      areas,
      scope: scopeIndex,
      modelEnabled: vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') !== 'disabled',
      notes,
      truncated,
      status: 'pending'
    };
    const publish = (reset: boolean, progress: string | null) => {
      if (!current()) return;
      if (input.story) input.story.gates = this.services.gates?.() ?? null;
      const built = { ...input, durationMs: input.status === 'pending' ? null : Date.now() - started };
      this.model = buildCodeExplainerModel(built, `cx-${generation}`);
      // The other lenses read the same harvest; one that fails leaves the Code lens as it is.
      try { this.model.lenses = buildLenses(built, this.model); }
      catch (error) { this.model.intelligence.notes.push(`The concept, entity, data-flow and logic lenses could not be built: ${error instanceof Error ? error.message : String(error)}`); }
      this.locations = locations;
      this.request = 0;
      const focusId = this.focusPending ? this.model.requested : null;
      if (this.pageReady) this.post({ type: 'cx.model', model: this.model, reset, progress, focus: focusId });
      if (progress === null) this.focusPending = false;
    };
    publish(true, 'Tracing calls…');

    if (!scriptProject) {
      const others = repositoryFiles.map((file) => file.path).filter((relative) => isScriptPath(relative) && !files.has(relative));
      const loaded = others.slice(0, CX_LIMITS.otherFiles);
      if (loaded.length) {
        this.progress(`Loading ${loaded.length} more code files for the language service…`);
        await mapLimit(loaded, 6, async (relative) => {
          await withTimeout(vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, relative))), REQUEST_MS);
        });
        if (!current()) return;
        notes.push(`This repository has no jsconfig.json or tsconfig.json, so ${loaded.length} more code files were opened in the background for the language service to find callers and tests.`);
        if (others.length > loaded.length) truncated.push(`callers were looked for in ${loaded.length} of ${others.length} other code files`);
      }
    }

    // Stage 2: call hierarchy from each changed, focused or (in the full view) mapped callable, out to the chosen depth.
    const seedModel = this.model!;
    let seeds = seedModel.symbols.filter((symbol) => (symbol.role === 'changed' || symbol.role === 'focus' || symbol.role === 'repository')
      && symbol.start !== null && ['function', 'method', 'constructor', 'class'].includes(symbol.kind)
      && (symbol.kind !== 'class' || symbol.role === 'focus'));
    if (graphView === 'full' && seeds.length > CX_LIMITS.fullSeeds) {
      truncated.push(`calls were traced from ${CX_LIMITS.fullSeeds} of ${seeds.length} functions, taken from each folder in turn`);
      const all = seeds;
      seeds = fairSample(all, (symbol) => symbol.file ?? '', codeAreas(all.map((symbol) => symbol.file ?? '')), CX_LIMITS.fullSeeds);
    }
    const rawByKey = new Map<string, { relative: string; raw: CxRawSymbol }>();
    const visitRaw = (relative: string, entries: CxRawSymbol[]) => {
      for (const entry of entries) {
        rawByKey.set(symbolKey(relative, entry.selection.line, entry.name), { relative, raw: entry });
        if (entry.children?.length) visitRaw(relative, entry.children);
      }
    };
    for (const file of files.values()) if (file.symbols) visitRaw(file.path, file.symbols);
    let requests = 0;
    const requestLimit = graphView === 'full' ? CX_LIMITS.fullCallRequests : CX_LIMITS.callRequests;
    const budget = () => requests < requestLimit;
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
              calls.push({ from, to, sites: call.fromRanges.map((range) => range.start.line + 1), positions: call.fromRanges.map((range) => ({ line: range.start.line + 1, character: range.start.character })) });
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
              calls.push({ from, to, sites: call.fromRanges.map((range) => range.start.line + 1), positions: call.fromRanges.map((range) => ({ line: range.start.line + 1, character: range.start.character })) });
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
    if (!budget()) truncated.push(`call tracing stopped after ${requestLimit} language-service requests`);
    const described = (label: string, stats: ServiceStats) => `${label}: ${stats.asked} asked, ${stats.answered} answered`
      + (stats.empty ? `, ${stats.empty} empty` : '') + (stats.failed ? `, ${stats.failed} failed` : '')
      + (stats.timedOut ? `, ${stats.timedOut} timed out` : '') + (stats.errors.length ? ` (${stats.errors.join('; ')})` : '');
    if (prepareStats.asked) notes.push(described('call hierarchy', prepareStats), described('callers and callees', callStats));
    if (!current()) return;
    // A file none of whose functions got a call hierarchy (Java without its language server in
    // Standard mode, for one) gets the calls Singularity Flow found in the committed code instead.
    const answered = new Set(seeds.filter((symbol) => input.callStatus[symbol.key] === 'complete').map((symbol) => symbol.file));
    const lacking = new Set(seeds.map((symbol) => symbol.file).filter((file): file is string => Boolean(file) && !answered.has(file)));
    if (lacking.size) {
      this.progress('Reading calls from the code…');
      try {
        const reply = await this.client.run<unknown>(['wm', 'knowledge', 'calls', '--json']);
        const data = (reply && typeof reply === 'object' && 'data' in reply ? (reply as { data: unknown }).data : reply) as { edges?: CxAnalysisCall[]; counts?: { resolved?: number; byName?: number } } | null;
        const found = analysisCalls(data?.edges ?? [], files.values(), (file) => lacking.has(file));
        if (current() && found.length) {
          calls.push(...found);
          for (const symbol of seeds) if (symbol.file && lacking.has(symbol.file)) input.callStatus[symbol.key] = 'analysis';
          const languages = [...new Set([...lacking].map((file) => languageLabel(languageOf(file))))].join(', ');
          const resolved = found.length && data?.counts?.resolved ? (data.counts.byName ? 'resolved by the compiler where it could, matched by name elsewhere' : 'resolved by the compiler') : 'matched by name';
          notes.push(`Calls for ${languages} come from Singularity Flow's analysis of the committed code (${resolved}), because the editor gave no call hierarchy for them.`);
        }
      } catch (error) {
        notes.push(`Singularity Flow's own call analysis was not available: ${error instanceof Error ? error.message : String(error)}`);
      }
      if ([...lacking].some((file) => languageOf(file) === 'java')) notes.push(javaCallHierarchyHint());
    }
    input.calls = calls;
    input.files = [...files.values()];
    publish(false, 'Finding tests and signatures…');

    // Stage 3: test references and signatures for what changed (and the focus).
    const detailed = this.model!.symbols.filter((symbol) => (symbol.role === 'changed' || symbol.role === 'focus' || symbol.role === 'repository')
      && rawByKey.has(symbol.key) && ['function', 'method', 'constructor', 'class'].includes(symbol.kind));
    const referenceTargets = detailed.slice(0, CX_LIMITS.referenceRequests);
    if (detailed.length > referenceTargets.length) truncated.push(`test references were looked up for the first ${referenceTargets.length} ${graphView === 'full' ? 'functions' : 'changed symbols'}`);
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

  /** A line inside a symbol the host harvested (a step of its logic, a field, a call it makes). */
  private async openLine(symbolId: string | null, line: number | null): Promise<void> {
    const symbol = this.model?.symbols.find((entry) => entry.id === symbolId);
    if (!symbol || line === null || symbol.start === null || symbol.end === null || line < symbol.start || line > symbol.end) {
      this.notice('That line is not in this view.', 'warn');
      return;
    }
    const located = this.locate(symbol.id);
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

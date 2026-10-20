/**
 * "Singularity Flow: Edit Run Configurations…" (lazy panels runtime). [docs/SPEC-RUN-AND-TEST-v1.md,
 * IntelliJ amendment §2, milestone 12]
 *
 * The page edits a draft of the capability's whole `application` block, read from `app plan --json`
 * (`application`, the block as declared). Every field edit is checked here (run-configurations-model.ts)
 * before the draft keeps it; a refused value, a secret above all, is never kept, and the page is
 * redrawn without it. After each change the draft is written to a private file (0600 in a fresh 0700
 * directory, removed after the call) and `app config preview --application-file FILE --json` says how
 * each configuration runs in each environment, or where it is wrong.
 *
 * Apply and OK show the YAML difference of the whole block on a review page, then write it through
 * the capability page's route, as the Suggest page does: a reviewed `capability edit --lead … --mode
 * set --application-file` proposal, or `capability set --application-file` in this checkout. Every
 * entry the person did not change, and the declared `tests`, are written back exactly as declared.
 * Afterwards the plan is read again and the Run & test section redrawn.
 *
 * Unsaved changes are marked and kept while this window lives: in memory per repository and
 * capability, and in the page's own webview state for a reload of the page. Neither ever holds a
 * secret, and nothing is kept in workspaceState.
 *
 * Other surfaces open it with `singularityFlow.editRunConfigurations`, optionally passing
 * `{ capability: '<capability ID>', configuration: '<start entry ID>' }` (run-and-test.ts).
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import { chooseApplicationRoute, withPrivateApplicationFile, writeApplicationBlock, type ApplicationWriteHost } from './application-block-write.ts';
import { appPlanArgv } from './run-and-test-model.ts';
import { appSuggestArgv } from './run-suggestions-model.ts';
import {
  addConfiguration, addFromTemplate, adoptSavedState, applicationBlockYaml, applyProblem, bindWords, blockFrom, configPreviewArgv,
  configPreviewFrom, configurationsReviewRequest, CONFIGURATION_TYPES, copyConfiguration, declaredFromPlan, draftDirty, draftFrom,
  editEnv, editField, importCandidatesFrom, importedEntry, moveConfiguration, otherIds, previewFromRefusal, rebaseDraft,
  removeConfiguration, resetToBase, savedState, typeOf, TYPE_SPECS, type ConfigPreview, type DeclaredBlock, type EditorDraft, type PlanFacts, type Tab
} from './run-configurations-model.ts';
import {
  listRegionHtml, noteRegionHtml, previewRegionHtml, runConfigurationsHtml, RUN_CONFIGURATIONS_SCRIPT, RUN_CONFIGURATIONS_STYLE,
  statusRegionHtml, tabsRegionHtml, type EditorPageState
} from './run-configurations-page.ts';

export interface RunConfigurationsHost extends ApplicationWriteHost {
  /** Open the review of the proposal the engine created, as the capability page does. */
  openCapabilityProposal?(lead: string, branch: string, capability: string): void;
  /** After a local save: refresh what this window shows of the capability map. */
  afterLocalChange?(capability: string): Promise<void>;
  /** After any save: read `app plan` again and redraw the Run & test section. */
  afterSave?(capability: string): Promise<void>;
}

/** Unsaved drafts of this window, per repository and capability; never persisted. */
const drafts = new Map<string, { draft: EditorDraft; block: DeclaredBlock; selected: string | null; tab: Tab }>();

const ACTIONS = ['copy', 'remove', 'up', 'down', 'import', 'browse', 'reset-field', 'copy-bind', 'copy-environments', 'discard', 'discard-cancel',
  'discard-confirm', 'refresh', 'apply', 'ok', 'env-files'] as const;
/** Edits after which the form itself changes (fields appear, go or are cleared): the page is drawn again. */
const STRUCTURAL = new Set(['environments', 'ready.kind', 'debug.enabled', 'debug.runtime', 'script', 'module']);
const NOTE_FIELDS = ['name', 'id', 'workingDirectory', 'env', 'beforeLaunch', 'url', 'ready.value', 'ready.timeout', 'environments', 'repository',
  'debug.port', 'debug.suspend', 'debug.runtime', 'debug.enabled', 'appended'];
const PREVIEW_DELAY_MS = 350;

const refusalCode = (error: unknown): string => {
  const result = (error as { result?: { error?: { code?: unknown } } } | null)?.result;
  return String(result?.error?.code ?? '');
};

export class RunConfigurationsPanel implements vscode.Disposable {
  private static current: RunConfigurationsPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private block: DeclaredBlock | null = null;
  private facts: PlanFacts[] = [];
  private draft: EditorDraft | null = null;
  private selected: string | null = null;
  private tab: Tab = 'base';
  private refused: EditorPageState['refused'] = null;
  private preview: ConfigPreview | null = null;
  private previewState: EditorPageState['previewState'] = 'idle';
  private previewNote: string | null = null;
  private previewSupported = true;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewRunning = false;
  private revision = 0;
  private loading = false;
  private busy = false;
  private error: string | null = null;
  private notice: string | null = null;
  private confirmDiscard = false;
  private stale = false;
  private environmentsDraft: string | null = null;
  /**
   * The draft the page kept (webview state), as its first message after this panel was created said.
   * Only that one may be adopted, and only before the first change here: a later message carries the
   * page's previous state, which an edit, a save or a discard has replaced on purpose.
   */
  private pageMayRestore = true;
  private keptByPage: unknown = null;
  private patched = false;
  private wanted: string | null = null;
  private generation = 0;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private host: RunConfigurationsHost, private capability: string) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or retarget) the one editor; `configuration` selects that start entry when it exists. */
  static show(host: RunConfigurationsHost, capability: string, { configuration = null }: { configuration?: string | null } = {}): RunConfigurationsPanel {
    const existing = RunConfigurationsPanel.current;
    if (existing && existing.host.client === host.client) {
      existing.host = host;
      existing.wanted = configuration;
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (existing.capability !== capability) {
        existing.capability = capability;
        existing.draft = null; existing.block = null; existing.preview = null;
        void existing.load();
      } else if (configuration) existing.selectWanted(true);
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.runConfigurations', `Run Configurations · ${capability}`,
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    const created = new RunConfigurationsPanel(panel, host, capability);
    RunConfigurationsPanel.current = created;
    created.wanted = configuration;
    void created.load();
    return created;
  }

  private router = registerMessageRouter('singularityFlow.runConfigurations', {
    'config.ready': (message) => this.ready(message.saved),
    'config.select': (message) => this.select(stringField(message, 'key')),
    'config.tab': (message) => this.switchTab(stringField(message, 'tab')),
    'config.field': (message) => this.field(message),
    'config.env': (message) => this.env(message),
    'config.add': (message) => this.add(enumField(message, 'configurationType', CONFIGURATION_TYPES)),
    'config.action': (message) => this.action(enumField(message, 'action', ACTIONS), message)
  });

  private get memoryKey(): string { return `${this.host.client.repository}\u0000${this.capability}`; }

  /** `app plan --json`: the declared block and each entry's environments; an unsaved draft is kept, rebased when the block moved. */
  async load({ keepNotice = false }: { keepNotice?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.loading = true; this.error = null;
    if (!keepNotice) { this.notice = null; this.environmentsDraft = null; }
    this.render();
    const capability = this.capability;
    let answer: unknown;
    try { answer = await this.host.client.run(appPlanArgv(capability)); } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.loading = false;
      this.error = `The run configurations could not be read: ${(error as Error).message}`;
      return this.render();
    }
    if (generation !== this.generation || this.disposed) return;
    this.loading = false;
    const { block, facts } = declaredFromPlan(answer);
    this.block = block; this.facts = facts;
    // An unsaved draft of this window (this page's own, or one left when it closed) is kept; when the
    // declared block moved underneath it, the edits are carried onto the block declared now.
    const fresh = draftFrom(capability, block);
    const kept = drafts.get(this.memoryKey);
    this.stale = false;
    if (!kept) {
      this.draft = fresh;
      this.adoptKeptByPage();
    } else {
      this.draft = kept.draft.base === fresh.base ? kept.draft : rebaseDraft(kept.draft, kept.block, block);
      this.stale = kept.draft.base !== fresh.base && draftDirty(this.draft, block);
      this.selected = kept.selected; this.tab = kept.tab;
    }
    this.selectWanted(false);
    this.remember();
    this.render();
    this.schedulePreview(0);
  }

  /** The configuration another surface asked for, else the one selected, else the first. */
  private selectWanted(draw: boolean): void {
    const draft = this.draft;
    if (!draft) return;
    const wanted = this.wanted ? draft.configurations.find((item) => item.entry.id === this.wanted) : null;
    if (wanted) { this.selected = wanted.key; this.tab = 'base'; this.wanted = null; }
    if (!draft.configurations.some((item) => item.key === this.selected)) { this.selected = draft.configurations[0]?.key ?? null; this.tab = 'base'; }
    if (draw) this.render();
  }

  private remember(): void {
    if (!this.draft || !this.block) return;
    if (draftDirty(this.draft, this.block)) drafts.set(this.memoryKey, { draft: this.draft, block: this.block, selected: this.selected, tab: this.tab });
    else drafts.delete(this.memoryKey);
  }

  /** The page (re)loaded: a patched page is drawn again from the draft; a new panel's kept draft may be adopted. */
  private ready(saved: unknown): void {
    if (this.pageMayRestore) {
      this.pageMayRestore = false;
      this.keptByPage = saved ?? null;
      if (this.adoptKeptByPage()) return this.render();
    }
    if (this.patched) this.render();
  }

  /** Adopt what the page kept, once, when this window kept no draft of its own and the block is the same. */
  private adoptKeptByPage(): boolean {
    const saved = this.keptByPage;
    if (!saved || !this.draft || !this.block || drafts.has(this.memoryKey)) return false;
    this.keptByPage = null;
    const adopted = adoptSavedState(saved, this.capability, this.block);
    if (!adopted || !draftDirty(adopted.draft, this.block)) return false;
    this.draft = adopted.draft; this.selected = adopted.selected; this.tab = adopted.tab;
    this.changed();
    return true;
  }

  private configuration(key: string | null) {
    return key ? this.draft?.configurations.find((item) => item.key === key) ?? null : null;
  }

  private select(key: string | null): void {
    const found = this.configuration(key);
    if (!found) return;
    const environments = Array.isArray(found.entry.environments) ? found.entry.environments : [];
    if (!environments.includes(this.tab)) this.tab = 'base';
    this.selected = found.key; this.refused = null; this.confirmDiscard = false;
    this.remember();
    this.render();
  }

  private switchTab(tab: string | null): void {
    const found = this.configuration(this.selected);
    if (!found || !tab) return;
    const environments = Array.isArray(found.entry.environments) ? found.entry.environments : [];
    if (tab !== 'base' && !environments.includes(tab)) return;
    this.tab = tab; this.refused = null;
    this.remember();
    this.render();
  }

  /** The draft changed: keep it, and ask the engine how it runs now. */
  private changed(): void {
    this.revision += 1;
    this.pageMayRestore = false;
    this.keptByPage = null;
    this.confirmDiscard = false;
    this.remember();
    this.schedulePreview(PREVIEW_DELAY_MS);
  }

  private replace(key: string, entry: Record<string, unknown>): void {
    this.draft = { ...this.draft!, configurations: this.draft!.configurations.map((item) => item.key === key ? { ...item, entry } : item) };
  }

  private field(message: InboundMessage): void {
    const found = this.configuration(stringField(message, 'key'));
    const field = stringField(message, 'field');
    const tab = stringField(message, 'tab') ?? 'base';
    if (!found || !field || typeof message.value !== 'string' || message.value.length > 65_536 || !typeOf(found.entry)) return;
    if (tab !== 'base' && !(Array.isArray(found.entry.environments) && found.entry.environments.includes(tab))) return;
    const result = editField(found.entry, tab, field, message.value, otherIds(this.draft!, found.key));
    this.selected = found.key; this.tab = tab;
    if (result.error) {
      // Drawn again from the draft, so the refused value leaves the page too.
      this.refused = { key: found.key, tab, field, message: result.error };
      return this.render();
    }
    if (this.refused?.key === found.key && this.refused.field === field) this.refused = null;
    this.replace(found.key, result.entry);
    if (result.note) this.notice = result.note;
    this.changed();
    if (STRUCTURAL.has(field) || result.note) return this.render();
    this.patch();
  }

  private env(message: InboundMessage): void {
    const found = this.configuration(stringField(message, 'key'));
    const tab = stringField(message, 'tab') ?? 'base';
    const rows = Array.isArray(message.rows) && message.rows.length <= 200 ? message.rows.flatMap((row: unknown) => {
      const value = row as { name?: unknown; value?: unknown } | null;
      return value && typeof value.name === 'string' && typeof value.value === 'string' && value.name.length <= 256 && value.value.length <= 8_192
        ? [{ name: value.name, value: value.value }] : [];
    }) : null;
    if (!found || !rows || !typeOf(found.entry)) return;
    if (tab !== 'base' && !(Array.isArray(found.entry.environments) && found.entry.environments.includes(tab))) return;
    const result = editEnv(found.entry, tab, rows);
    this.selected = found.key; this.tab = tab;
    if (result.error) {
      this.refused = { key: found.key, tab, field: 'env', message: result.error };
      return this.render();
    }
    if (this.refused?.key === found.key && this.refused.field === 'env') this.refused = null;
    this.replace(found.key, result.entry);
    this.changed();
    this.patch();
  }

  private add(type: typeof CONFIGURATION_TYPES[number] | null): void {
    if (!type || !this.draft) return;
    const { draft, key } = addFromTemplate(this.draft, type);
    this.draft = draft; this.selected = key; this.tab = 'base'; this.refused = null;
    this.notice = null;
    this.changed();
    this.render();
  }

  private async action(action: typeof ACTIONS[number] | null, message: InboundMessage): Promise<void> {
    if (!action || !this.draft || !this.block) return;
    const selected = this.configuration(this.selected);
    switch (action) {
      case 'copy': {
        const copied = selected ? copyConfiguration(this.draft, selected.key) : null;
        if (!copied) return;
        this.draft = copied.draft; this.selected = copied.key; this.tab = 'base';
        this.changed(); return this.render();
      }
      case 'remove': {
        if (!selected) return;
        const removed = removeConfiguration(this.draft, selected.key);
        this.draft = removed.draft; this.selected = removed.key; this.tab = 'base'; this.refused = null;
        this.changed(); return this.render();
      }
      case 'up': case 'down':
        if (!selected) return;
        this.draft = moveConfiguration(this.draft, selected.key, action);
        this.changed(); return this.render();
      case 'reset-field': {
        const field = stringField(message, 'field');
        if (!selected || !field || this.tab === 'base') return;
        this.replace(selected.key, resetToBase(selected.entry, this.tab, field));
        this.changed(); return this.render();
      }
      case 'copy-bind': {
        const environment = stringField(message, 'environment');
        const environments = Array.isArray(selected?.entry.environments) ? selected!.entry.environments : [];
        if (!environment || !environments.includes(environment)) return;
        await vscode.env.clipboard.writeText(bindWords(environment));
        void vscode.window.setStatusBarMessage('$(clippy) Copied. Run it in a terminal with your own secret helper.', 4_000);
        return;
      }
      case 'env-files': {
        // The files this environment's runs read (application-uat.yml, .env.uat): the Environment Files page.
        const environment = stringField(message, 'environment');
        const environments = Array.isArray(selected?.entry.environments) ? selected!.entry.environments : [];
        return void vscode.commands.executeCommand('singularityFlow.openEnvironmentFiles', {
          capability: this.capability, ...(environment && environments.includes(environment) ? { environment } : {})
        });
      }
      case 'copy-environments':
        if (!this.environmentsDraft) return;
        await vscode.env.clipboard.writeText(this.environmentsDraft);
        void vscode.window.setStatusBarMessage('$(clippy) Copied the singularity/environments.yml additions. They hold names, never secret values.', 4_000);
        return;
      case 'discard': this.confirmDiscard = true; return this.patch();
      case 'discard-cancel': this.confirmDiscard = false; return this.patch();
      case 'discard-confirm':
        drafts.delete(this.memoryKey);
        this.draft = draftFrom(this.capability, this.block);
        this.confirmDiscard = false; this.refused = null; this.stale = false;
        this.notice = 'The unsaved changes were discarded.';
        this.selectWanted(false);
        this.changed(); return this.render();
      case 'refresh': return this.load();
      case 'import': return this.importFromIde();
      case 'browse': return this.browse();
      case 'apply': case 'ok': return this.apply(action === 'ok');
      default: return undefined;
    }
  }

  /** The folder picker, inside the repository only; the folder becomes the tab's working directory. */
  private async browse(): Promise<void> {
    const selected = this.configuration(this.selected);
    if (!selected) return;
    const repository = this.host.client.repository;
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(repository),
      openLabel: 'Use as working directory', title: 'Working directory (a folder in this repository)'
    });
    const target = picked?.[0]?.fsPath;
    if (!target) return;
    let relative: string | null = null;
    try {
      const [root, folder] = await Promise.all([realpath(repository), realpath(target)]);
      const inside = path.relative(root, folder);
      relative = inside.startsWith('..') || path.isAbsolute(inside) ? null : inside.split(path.sep).join('/');
    } catch { relative = null; }
    if (relative === null) {
      this.refused = { key: selected.key, tab: this.tab, field: 'workingDirectory', message: 'Choose a folder inside this repository: the working directory is relative to it.' };
      return this.render();
    }
    const result = editField(selected.entry, this.tab, 'workingDirectory', relative, otherIds(this.draft!, selected.key));
    if (result.error) { this.refused = { key: selected.key, tab: this.tab, field: 'workingDirectory', message: result.error }; return this.render(); }
    this.replace(selected.key, result.entry);
    this.refused = null;
    this.changed();
    this.render();
  }

  /** `app suggest --json` (typed), picked in a quick pick; the picked ones are added as configurations. */
  private async importFromIde(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = null; this.notice = null;
    this.render();
    let answer: unknown;
    try { answer = await this.host.client.run(appSuggestArgv(this.capability)); } catch (error) {
      this.busy = false;
      this.error = `The IDE run configurations could not be read: ${(error as Error).message}`;
      return this.render();
    }
    this.busy = false;
    const { candidates, environmentsDraft, environmentsNote } = importCandidatesFrom(answer);
    const usable = candidates.filter((candidate) => candidate.entry);
    if (!usable.length) {
      this.notice = candidates.length
        ? `None of the ${candidates.length} IDE run configurations can be imported as written: ${candidates.map((candidate) => `${candidate.label} (${candidate.refusal})`).join('; ')}`
        : 'No IDE run configuration or project marker in this repository suggests a configuration.';
      return this.render();
    }
    const refused = candidates.length - usable.length;
    const picked = await vscode.window.showQuickPick(usable.map((candidate) => ({
      label: candidate.label, description: candidate.description, detail: candidate.detail || undefined, candidate
    })), {
      title: 'Import from IDE run configurations', canPickMany: true, ignoreFocusOut: true,
      placeHolder: `Pick the configurations to add${refused ? ` (${refused} cannot be imported as written)` : ''}. Nothing is written until Apply.`
    });
    if (!picked?.length || !this.draft) { this.notice = 'Nothing was imported.'; return this.render(); }
    const added: string[] = [];
    const dropped = new Set<string>();
    const secrets = new Set<string>();
    for (const { candidate } of picked) {
      const entry = importedEntry(candidate, otherIds(this.draft));
      const next = addConfiguration(this.draft, entry);
      this.draft = next.draft; this.selected = next.key;
      added.push(String(entry.id));
      candidate.dropped.forEach((name) => dropped.add(name));
      candidate.secrets.forEach((name) => secrets.add(name));
    }
    this.tab = 'base';
    const names = [...new Set([...dropped, ...secrets])];
    this.notice = [`Imported ${added.join(', ')}. Review them, then Apply.`,
      names.length ? `${names.join(', ')} ${names.length === 1 ? 'is a secret' : 'are secrets'}: declare ${names.length === 1 ? 'it' : 'them'} by name in singularity/environments.yml and bind the values privately with ${bindWords(null)}; no value was copied.` : '',
      environmentsNote ?? ''].filter(Boolean).join(' ');
    this.environmentsDraft = environmentsDraft;
    this.changed();
    this.render();
  }

  private schedulePreview(delay: number): void {
    if (!this.previewSupported || !this.draft || !this.block) return;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewState = 'pending';
    this.previewTimer = setTimeout(() => { this.previewTimer = null; void this.runPreview(); }, delay);
  }

  /**
   * `app config preview` of the draft as it is now. An answer for an older draft is dropped (another
   * preview is already scheduled); an engine without the command says so once and is not asked again.
   */
  private async runPreview(): Promise<void> {
    if (!this.draft || !this.block || this.disposed || !this.previewSupported) return;
    if (this.previewRunning) return void this.schedulePreview(PREVIEW_DELAY_MS);
    this.previewRunning = true;
    const revision = this.revision;
    const capability = this.capability;
    const yaml = applicationBlockYaml(blockFrom(this.draft, this.block));
    let preview: ConfigPreview | null = null;
    let note: string | null = null;
    try {
      preview = configPreviewFrom(await withPrivateApplicationFile(yaml, (file) => this.host.client.run(configPreviewArgv(capability, file))));
      if (!preview) note = 'The engine\'s command line preview could not be read.';
    } catch (error) {
      preview = previewFromRefusal((error as { result?: unknown }).result ?? null);
      if (!preview) {
        if (refusalCode(error) === 'UNKNOWN_SUBCOMMAND') {
          this.previewSupported = false;
          note = 'This Singularity Flow has no app config preview, so the command line is resolved only when a configuration runs. The engine still checks the whole block when it is saved.';
        } else note = `The command line preview is not available: ${(error as Error).message}`;
      }
    } finally {
      this.previewRunning = false;
    }
    if (this.disposed || capability !== this.capability) return;
    if (revision !== this.revision) return void (this.previewTimer ? undefined : this.schedulePreview(0));
    this.preview = preview;
    this.previewState = preview ? 'idle' : 'unavailable';
    this.previewNote = note;
    this.patch();
  }

  /** A fresh preview of exactly this draft, before Apply decides. */
  private async previewNow(): Promise<void> {
    if (!this.previewSupported) return;
    if (this.previewTimer) { clearTimeout(this.previewTimer); this.previewTimer = null; }
    for (let attempt = 0; attempt < 200 && this.previewRunning; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    await this.runPreview();
  }

  /** Review the YAML difference of the whole block, then write it by the capability page's route. */
  private async apply(close: boolean): Promise<void> {
    const draft = this.draft;
    const block = this.block;
    if (!draft || !block || this.busy) return;
    this.error = null; this.notice = null;
    if (!draftDirty(draft, block)) { this.notice = 'There are no unsaved changes.'; return this.render(); }
    this.busy = true; this.render();
    await this.previewNow();
    this.busy = false;
    if (this.draft !== draft) return this.render();
    const problem = applyProblem(draft, block, this.previewState === 'idle' ? this.preview : null);
    if (problem) { this.error = problem; return this.render(); }
    let route: Awaited<ReturnType<typeof chooseApplicationRoute>>;
    try { route = await chooseApplicationRoute(this.host); } catch (error) {
      this.error = `The capability map's authority could not be read: ${(error as Error).message}`;
      return this.render();
    }
    if (!route) { this.notice = 'Nothing was saved or proposed.'; return this.render(); }
    const capability = this.capability;
    // What is written is exactly what the review page showed, whatever happens on the page meanwhile.
    const yaml = applicationBlockYaml(blockFrom(draft, block));
    if (!await collectReviewConfirmation(configurationsReviewRequest({ capability, draft, block, route }))) {
      this.notice = 'Nothing was saved or proposed.';
      return this.render();
    }
    this.busy = true; this.render();
    let outcome: Awaited<ReturnType<typeof writeApplicationBlock>>;
    try { outcome = await writeApplicationBlock(this.host, route, capability, yaml); } catch (error) {
      this.busy = false;
      this.error = (error as Error).message;
      return this.render();
    }
    this.busy = false;
    drafts.delete(this.memoryKey);
    this.draft = null;
    if (outcome.kind === 'proposal') {
      this.notice = `Proposal ${outcome.branch} was created on ${outcome.lead}. Nothing changes here until it is approved; this page shows what is declared now.`;
      this.host.openCapabilityProposal?.(outcome.lead, outcome.branch, capability);
    } else if (outcome.kind === 'local') {
      this.notice = `Saved to ${outcome.path ?? 'singularity/capabilities.yml'} in this checkout, as a local authoring change. Commit it, or propose it to the capability map's authority.`;
      await this.host.afterLocalChange?.(capability);
    } else {
      this.notice = 'The capability already declares exactly these run configurations; nothing changed.';
    }
    await this.host.afterSave?.(capability);
    if (this.disposed) return;
    if (close) return void this.panel.dispose();
    await this.load({ keepNotice: true });
  }

  private pageState(): EditorPageState {
    return {
      capability: this.capability, loading: this.loading, busy: this.busy, error: this.error, notice: this.notice,
      draft: this.draft, block: this.block, facts: this.facts, selected: this.selected, tab: this.tab, refused: this.refused,
      preview: this.preview, previewState: this.previewState, previewNote: this.previewNote, confirmDiscard: this.confirmDiscard,
      stale: this.stale, environmentsDraft: this.environmentsDraft,
      saved: this.draft ? savedState(this.draft, this.selected, this.tab) : null
    };
  }

  private title(): string {
    const dirty = this.draft && this.block && draftDirty(this.draft, this.block);
    return `${dirty ? '● ' : ''}Run Configurations · ${this.capability}`;
  }

  /**
   * Replace the list, tabs, footer, preview and every field note in place, so the field being typed in
   * keeps its focus and value. The page keeps the draft sent with it (webview state).
   */
  private patch(): void {
    if (this.disposed) return;
    const state = this.pageState();
    const selected = this.configuration(this.selected);
    const type = selected ? typeOf(selected.entry) : null;
    const fields = [...NOTE_FIELDS, ...(type ? TYPE_SPECS[type].fields.map((field) => field.key) : [])];
    this.panel.title = this.title();
    this.patched = true;
    void this.panel.webview.postMessage({
      type: 'config.patch', state: state.saved,
      regions: [
        { id: 'list', html: listRegionHtml(state) }, { id: 'tabs', html: tabsRegionHtml(state) }, { id: 'status', html: statusRegionHtml(state) },
        { id: 'preview', html: previewRegionHtml(state) },
        ...fields.map((field) => ({ id: `note-${field}`, html: noteRegionHtml(state, field) }))
      ]
    });
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.patched = false;
    this.panel.title = this.title();
    this.panel.webview.html = page(this.title(), runConfigurationsHtml(this.pageState()), contentSecurityPolicy(this.panel.webview, token), token,
      RUN_CONFIGURATIONS_SCRIPT, { styles: RUN_CONFIGURATIONS_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.remember();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (RunConfigurationsPanel.current === this) RunConfigurationsPanel.current = null;
  }
}

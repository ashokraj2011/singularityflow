import { showCompactWarningMessage, showCompactInformationMessage } from "../compact-message.ts";
/**
 * Workflow Studio: create and change workflows, their steps, the agent that drafts each step and
 * the people who sign it off, then check and publish everything as one governed change.
 *
 * The page keeps the draft; this host only reads the model (`workflow studio --json`), asks the
 * engine to check a change set (`--dry-run`), and publishes it after a person confirms. For the
 * Library it also asks the engine to preview an import, browse a trusted marketplace and check
 * imported sources; each is an engine read, and adding is just another change in the set. The engine
 * remains the authority: it validates the whole candidate configuration and writes through a review
 * proposal (or a local authority's working tree). The extension never writes configuration itself.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { formatCliArgsForDisplay } from '../cli/runner.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import { integerField, registerMessageRouter, stringField } from './messages.ts';
import { INTEGRATION_SECRET_NAME, type IntegrationSecretSource } from '../credentials.ts';
import {
  PROPOSAL_BRANCH, STUDIO_FOCUS_VIEWS, STUDIO_MODEL_ARGS, STUDIO_PREVIEW_ARGS, WORKFLOW_STUDIO_SCRIPT, proposalSummaries, studioPublishArgs,
  workflowStudioBody, type StudioAuthority, type StudioFocusView
} from './workflow-studio-page.ts';

export { STUDIO_FOCUS_VIEWS, proposalSummaries, type StudioFocusView };


interface StudioModel { authority?: StudioAuthority; base?: unknown; [key: string]: unknown }
interface StudioPlan { valid: boolean; changed: boolean; summary: string[]; problems: Array<{ message: string }>; warnings: Array<{ message: string }>; files: Array<{ path: string }> }
interface StudioApplyResult extends StudioPlan { reviewRequired?: boolean; branch?: string | null; authorityMode?: string; written?: string[] }

const MAX_CHANGE_SET_BYTES = 1024 * 1024;
const IMPORT_KINDS = new Set(['skill', 'template', 'agent', 'mcp-server']);
const SERVER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REFERENCE_LENGTH = 2048;
const TARGET_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTION_TRIGGERS = new Set(['submitted', 'approved', 'rejected']);
const ACTION_SENDS = new Set(['event', 'summary', 'artifact']);
const MAX_SECRET_NAMES = 64;
const WORKFLOW_SELECTOR = /^(?:story|initiative):[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_EXPORT_WORKFLOWS = 200;

/** Where integration secrets are kept on this machine. The page only ever learns whether each is set. */
export interface IntegrationSecretStore {
  status(names: readonly string[]): Promise<Record<string, IntegrationSecretSource>>;
  store(name: string, value: string): Promise<void>;
  clear(name: string): Promise<void>;
  /** Whether Jira is connected for Singularity Flow on this machine: stored in VS Code, set in the environment, or not. */
  jiraStatus(): Promise<IntegrationSecretSource>;
}


export interface WorkflowStudioActions {
  /** Re-read repository state after a publish, so the rest of the extension sees it. */
  refresh(): Promise<void>;
  /**
   * Review a configuration proposal's exact diff and activate it after the person confirms, with the
   * separate acknowledgement an unprotected configuration branch needs. Returns why it stopped, if it did.
   */
  reviewProposal(branch: string): Promise<string | null | void>;
  /** Export the chosen workflows (`story:<id>`, `initiative:<id>`) and their dependencies as one bundle. */
  exportWorkflows?(selectors: readonly string[]): Promise<string | null>;
  /** Import a workflow bundle: preview the plan, then propose it after the person confirms. */
  importWorkflows?(): Promise<StudioChangeOutcome>;
  duplicateWorkflow?(selector: string): Promise<StudioChangeOutcome>;
  /** Open a repository file in an editor: the governed workflow or portfolio file, or a template. */
  openFile?(relative: string): Promise<void>;
  /** The operating-system keychain, through VS Code, for the secrets integration targets name. */
  integrationSecrets?: IntegrationSecretStore;
  /**
   * Where unpublished changes wait while Workflow Studio is closed (VS Code workspace storage). The
   * page offers them back on reopen, but only against the configuration they were made on.
   */
  draftStore?: { get(): unknown; set(value: StudioSavedDraft | undefined): PromiseLike<void> };
}

/** What a governed change made outside the change set (an import) came to. */
export interface StudioChangeOutcome {
  outcome: 'cancelled' | 'proposed' | 'written' | 'unchanged' | 'failed';
  branch?: string;
  error: string | null;
}

/** Unpublished Studio changes kept across closing the panel. */
export interface StudioSavedDraft { schema: 1; base: string; savedAt: string; draft: string }

export class WorkflowStudioPanel implements vscode.Disposable {
  private static current: WorkflowStudioPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private model: StudioModel | null = null;
  /** MCP servers the person allowed this Studio session to start or contact for imports. */
  private readonly mcpConsent = new Set<string>();

  /** The section to show once the model has loaded, when a screen opened Studio at one. */
  private focus: StudioFocusView | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: SingularityFlowClient,
    private readonly output: vscode.OutputChannel,
    private readonly actions: WorkflowStudioActions
  ) {
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      await this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    const token = nonce();
    panel.webview.html = page('Workflow Studio', workflowStudioBody(token),
      contentSecurityPolicy(panel.webview, token), token, WORKFLOW_STUDIO_SCRIPT);
  }

  static show(client: SingularityFlowClient, output: vscode.OutputChannel, actions: WorkflowStudioActions, focus: StudioFocusView | null = null): WorkflowStudioPanel {
    if (WorkflowStudioPanel.current) {
      WorkflowStudioPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (focus) WorkflowStudioPanel.current.post({ type: 'studio.focus', view: focus });
      return WorkflowStudioPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workflowStudio', 'Workflow Studio', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    WorkflowStudioPanel.current = new WorkflowStudioPanel(panel, client, output, actions);
    WorkflowStudioPanel.current.focus = focus;
    return WorkflowStudioPanel.current;
  }

  /**
   * The messages the page sends. The change set arrives as JSON text and is bounded here; the
   * engine parses and validates its content, so the host never trusts its shape.
   */
  private router = registerMessageRouter('singularityFlow.workflowStudio', {
    'studio.ready': () => this.load(false),
    'studio.draftSave': (message) => this.saveDraft(stringField(message, 'draft')),
    'studio.draftClear': () => this.clearDraft(),
    'studio.confirm': (message) => this.confirm(stringField(message, 'id'), stringField(message, 'text'),
      stringField(message, 'detail'), stringField(message, 'ok')),
    'studio.reload': () => this.load(true),
    'studio.preview': (message) => this.preview(stringField(message, 'changeSet')),
    'studio.publish': (message) => this.publish(stringField(message, 'changeSet'), integerField(message, 'count') ?? 0),
    'studio.importPreview': (message) => this.importPreview(stringField(message, 'reference'), stringField(message, 'as'), (message as { arguments?: unknown }).arguments),
    'studio.mcpSources': (message) => this.mcpSources(stringField(message, 'id')),
    'studio.mcpHostAdd': (message) => this.mcpHostAdd(stringField(message, 'id')),
    'studio.marketplaceBrowse': (message) => this.marketplaceBrowse(stringField(message, 'id')),
    'studio.importsCheck': () => this.importsCheck(),
    'studio.secretStatus': (message) => this.secretStatus((message as { names?: unknown }).names),
    'studio.storeSecret': (message) => this.storeSecret(stringField(message, 'name')),
    'studio.clearSecret': (message) => this.clearSecret(stringField(message, 'name')),
    'studio.connectJira': () => this.connectJira(),
    'studio.proposals': () => this.proposals(),
    'studio.reviewProposal': (message) => this.reviewProposal(stringField(message, 'branch'), integerField(message, 'pending') ?? 0),
    'studio.exportWorkflows': (message) => this.exportWorkflows((message as { workflowIds?: unknown }).workflowIds),
    'studio.importWorkflows': (message) => this.importWorkflows(integerField(message, 'pending') ?? 0),
    'studio.duplicateWorkflow': (message) => this.duplicateWorkflow(stringField(message, 'selector'), integerField(message, 'pending') ?? 0),
    'studio.openFile': (message) => this.openFile(stringField(message, 'path')),
    'studio.integrationTest': (message) => this.integrationTest(stringField(message, 'target'), stringField(message, 'trigger'),
      stringField(message, 'send'), (message as { sendTest?: unknown }).sendTest === true)
  });

  /** The workflow configuration proposals waiting for review. A working-tree authority has none. */
  private async proposals(): Promise<void> {
    if (this.model?.authority?.kind === 'working-tree') { this.post({ type: 'studio.proposals', proposals: [], local: true }); return; }
    try {
      const listed = await this.client.run<unknown>(['workflow', 'proposals', '--json']);
      this.post({ type: 'studio.proposals', proposals: proposalSummaries(listed) });
    } catch (error) {
      this.post({ type: 'studio.proposals', proposals: [], error: (error as Error).message });
    }
  }

  /**
   * The approved configuration changed under the page (a proposal activated, a bundle imported). With
   * nothing unpublished the page reloads; otherwise its changes stay, and the engine's base check
   * refuses them until the person reloads, rather than replaying them over the newer configuration.
   */
  private async configurationChanged(pending: number, reason: string): Promise<void> {
    if (pending > 0) this.post({ type: 'studio.configurationChanged', reason });
    else await this.load(true);
    await this.actions.refresh();
  }

  private async reviewProposal(branch: string | null, pending: number): Promise<void> {
    if (!branch || !PROPOSAL_BRANCH.test(branch)) { this.post({ type: 'studio.failed', message: 'That is not a configuration proposal.' }); return; }
    const before = this.modelBase();
    const stopped = await this.actions.reviewProposal(branch);
    if (typeof stopped === 'string' && stopped) this.post({ type: 'studio.failed', message: stopped });
    const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
    if (fresh && JSON.stringify(fresh.base ?? null) !== before) {
      if (pending > 0) this.post({ type: 'studio.configurationChanged', reason: `${branch} was activated` });
      else { this.model = fresh; this.post({ type: 'studio.model', model: fresh, reset: true }); }
    }
    await this.proposals();
  }

  private async exportWorkflows(raw: unknown): Promise<void> {
    const selectors = Array.isArray(raw)
      ? [...new Set(raw.filter((value): value is string => typeof value === 'string' && WORKFLOW_SELECTOR.test(value)))].slice(0, MAX_EXPORT_WORKFLOWS)
      : [];
    if (!selectors.length) { this.post({ type: 'studio.failed', message: 'Choose at least one workflow to export.' }); return; }
    if (!this.actions.exportWorkflows) { this.post({ type: 'studio.failed', message: 'Exporting workflows is not available here.' }); return; }
    const stopped = await this.actions.exportWorkflows(selectors);
    this.post(stopped ? { type: 'studio.failed', message: stopped } : { type: 'studio.exported' });
  }

  private async importWorkflows(pending: number): Promise<void> {
    if (!this.actions.importWorkflows) { this.post({ type: 'studio.failed', message: 'Importing workflows is not available here.' }); return; }
    const before = this.modelBase();
    const result = await this.actions.importWorkflows();
    if (result.outcome === 'failed') { this.post({ type: 'studio.failed', message: result.error ?? 'The import did not complete.' }); return; }
    if (result.outcome !== 'cancelled') {
      const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
      if (fresh && JSON.stringify(fresh.base ?? null) !== before) await this.configurationChanged(pending, 'workflows were imported');
    }
    this.post({ type: 'studio.importDone', outcome: result.outcome, branch: result.branch ?? null, error: result.error });
    if (result.outcome !== 'cancelled') await this.proposals();
  }

  private async duplicateWorkflow(selector: string | null, pending: number): Promise<void> {
    if (!selector || !WORKFLOW_SELECTOR.test(selector) || !this.actions.duplicateWorkflow) {
      this.post({ type: 'studio.failed', message: 'Choose a published workflow to duplicate.' }); return;
    }
    const before = this.modelBase();
    const result = await this.actions.duplicateWorkflow(selector);
    if (result.outcome === 'failed') { this.post({ type: 'studio.failed', message: result.error ?? 'Duplication failed.' }); return; }
    if (result.outcome !== 'cancelled') {
      const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
      if (fresh && JSON.stringify(fresh.base ?? null) !== before) await this.configurationChanged(pending, 'a workflow was duplicated');
      await this.proposals();
    }
    this.post({ type: 'studio.importDone', outcome: result.outcome, branch: result.branch ?? null, error: result.error });
  }

  /** Repository files the page may open: the governed workflow and portfolio files, and templates. */
  private openableFile(relative: string): boolean {
    if (relative.split('/').some((part) => part === '..' || part === '' || part === '.')) return false;
    if (relative === 'singularity/workflow.yml' || relative === 'singularity/portfolio.yml') return true;
    const root = typeof this.model?.templatesRoot === 'string' && this.model.templatesRoot ? this.model.templatesRoot : 'singularity/templates';
    return relative.startsWith(`${root}/`) && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(relative.slice(root.length + 1));
  }

  private async openFile(relative: string | null): Promise<void> {
    if (!relative || relative.length > 512 || !this.openableFile(relative) || !this.actions.openFile) return;
    await this.actions.openFile(relative);
  }

  /** Whether each secret is stored through VS Code, inherited from the environment, or missing. Never a value. */
  private async secretStatus(rawNames: unknown): Promise<void> {
    const names = Array.isArray(rawNames)
      ? [...new Set(rawNames.filter((name): name is string => typeof name === 'string' && INTEGRATION_SECRET_NAME.test(name)))].slice(0, MAX_SECRET_NAMES)
      : [];
    const store = this.actions.integrationSecrets;
    const status = store ? await store.status(names) : {};
    const jira = store ? await store.jiraStatus() : null;
    this.post({ type: 'studio.secretStatus', status, jira, canStore: Boolean(store) });
  }

  /**
   * Review removing, replacing or discarding work without a screen-sized native modal.
   * The page runs its action only on an explicit human confirmation.
   */
  private async confirm(id: string | null, text: string | null, detail: string | null, ok: string | null): Promise<void> {
    if (this.disposed || !id || !/^confirm-\d{1,9}$/.test(id) || !text || !ok) return;
    const reviewedRepository = this.client.repository;
    const bounded = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    const accepted = await collectReviewConfirmation({
      title: 'Review Workflow Studio change', summary: text,
      detail: detail ?? 'Review the exact change before continuing.', confirmLabel: bounded(ok, 60)
    });
    if (this.disposed) return;
    this.post({ type: 'studio.confirmed', id, ok: accepted && this.client.repository === reviewedRepository });
  }

  /** Jira targets use the Jira connection VS Code keeps; connecting is VS Code's own flow. */
  private async connectJira(): Promise<void> {
    await vscode.commands.executeCommand('singularityFlow.connectJira');
    await this.secretStatus([]);
  }

  /** The value is typed into VS Code's own password box, so it never passes through the page. */
  private async storeSecret(name: string | null): Promise<void> {
    const store = this.actions.integrationSecrets;
    if (!store || !name || !INTEGRATION_SECRET_NAME.test(name)) return;
    const value = await vscode.window.showInputBox({
      title: `Store ${name}`,
      prompt: 'Kept in the operating-system keychain and passed only to Singularity Flow commands on this machine. It is never written to Git or shown again.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => text.trim() ? null : 'Enter the secret value.'
    });
    if (!value) return;
    try {
      await store.store(name, value);
      this.post({ type: 'studio.secretStored', name });
      await this.secretStatus([name]);
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  private async clearSecret(name: string | null): Promise<void> {
    const store = this.actions.integrationSecrets;
    if (!store || !name || !INTEGRATION_SECRET_NAME.test(name)) return;
    const confirmed = await showCompactWarningMessage(`Remove ${name} from this machine's keychain?`, {
      modal: true,
      detail: 'Deliveries that need it wait and retry until it is stored again or set in the environment.'
    }, 'Remove');
    if (confirmed !== 'Remove') return;
    await store.clear(name);
    await this.secretStatus([name]);
  }

  /**
   * The exact request a published target would receive, secrets redacted; on request, one delivery
   * marked as a test. The engine reads targets from approved configuration, so the page offers this
   * only for targets that are published and unchanged in the draft.
   */
  private async integrationTest(target: string | null, trigger: string | null, send: string | null, sendTest: boolean): Promise<void> {
    if (!target || !TARGET_ID.test(target) || !trigger || !ACTION_TRIGGERS.has(trigger) || !send || !ACTION_SENDS.has(send)) {
      this.post({ type: 'studio.integrationTested', target, failed: 'Choose a published target, when it fires and what it sends.' });
      return;
    }
    // The kind comes from the model this host read, never from the page: a Jira or Git "test" only
    // signs in and reads, so it needs no consent; every other test sends a request somewhere.
    const targets = ((this.model as { integrations?: { targets?: Array<{ id?: string; kind?: string }> } } | null)?.integrations?.targets) ?? [];
    const readOnly = ['jira', 'git', 'confluence', 'onedrive'].includes(targets.find((entry) => entry.id === target)?.kind ?? '');
    if (sendTest && !readOnly) {
      const confirmed = await showCompactWarningMessage(`Send a test delivery to '${target}'?`, {
        modal: true,
        detail: 'One request marked as a test goes to the address the target names, signed or authenticated with its secret. Nothing in the repository changes.'
      }, 'Send test');
      if (confirmed !== 'Send test') { this.post({ type: 'studio.integrationTested', target, cancelled: true }); return; }
    }
    try {
      const result = await this.client.run<{ data?: Record<string, unknown> }>([
        'integrations', 'test', target, '--trigger', trigger, '--send', send, ...(sendTest ? ['--send-test'] : []), '--json'
      ]);
      this.post({ type: 'studio.integrationTested', target, result: result.data ?? null });
    } catch (error) {
      this.post({ type: 'studio.integrationTested', target, failed: (error as Error).message });
    }
  }

  /**
   * The engine fetches, checks and stages what a person wants to import; the page shows the exact
   * text and hash it returns. Nothing in the repository changes until the import is published.
   */
  private async importPreview(reference: string | null, as: string | null, rawArguments?: unknown): Promise<void> {
    if (!reference || reference.length > MAX_REFERENCE_LENGTH
        || !(reference.startsWith('https://') || reference.startsWith('market:') || reference.startsWith('mcp:'))
        || !as || !IMPORT_KINDS.has(as)) {
      this.post({ type: 'studio.importFailed', message: 'Paste a public https:// link, or choose a marketplace entry or an MCP server item.' });
      return;
    }
    const mcpFlags: string[] = [];
    if (reference.startsWith('mcp:')) {
      const serverId = reference.slice(4).split('/')[0] ?? '';
      if (!(await this.mcpConsentFor(serverId))) return;
      mcpFlags.push('--launch');
      for (const [name, value] of Object.entries(rawArguments && typeof rawArguments === 'object' ? rawArguments as Record<string, unknown> : {}).slice(0, 32)) {
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(name) && typeof value === 'string' && value.length <= 4096) mcpFlags.push('--arg', `${name}=${value}`);
      }
    }
    try {
      const preview = await this.client.run<Record<string, unknown>>(['import', 'preview', reference, '--as', as, ...mcpFlags, '--json']);
      this.post({ type: 'studio.importPreviewed', preview });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  private async marketplaceBrowse(id: string | null): Promise<void> {
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      this.post({ type: 'studio.importFailed', message: 'Choose a marketplace this repository trusts.' });
      return;
    }
    try {
      const result = await this.client.run<Record<string, unknown>>(['marketplace', 'browse', id, '--json']);
      this.post({ type: 'studio.marketplaceEntries', result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /**
   * Starting or contacting an MCP server is the person's decision. The engine refuses without
   * consent and says exactly what it would run or where it would connect; that is what is shown.
   */
  private async mcpConsentFor(serverId: string): Promise<boolean> {
    if (!SERVER_ID.test(serverId)) {
      this.post({ type: 'studio.importFailed', message: 'Choose an MCP server this repository allows imports from.' });
      return false;
    }
    if (this.mcpConsent.has(serverId)) return true;
    let described = '';
    try {
      await this.client.run<Record<string, unknown>>(['mcp', 'sources', serverId, '--json']);
      return true;
    } catch (error) {
      const message = (error as Error).message;
      if (!/Repeat with --launch/.test(message)) { this.post({ type: 'studio.importFailed', message }); return false; }
      described = (message.split(' Nothing was started.')[0] ?? message).replace(/\.$/, '');
    }
    const allowed = await showCompactWarningMessage(`Allow MCP server '${serverId}' for imports?`, {
      modal: true,
      detail: `${described}.\n\nWorkflow Studio stops it as soon as each import is read. Your choice lasts until this Studio closes.`
    }, 'Allow');
    if (allowed !== 'Allow') { this.post({ type: 'studio.importFailed', message: `MCP server '${serverId}' was not started.` }); return false; }
    this.mcpConsent.add(serverId);
    return true;
  }

  private async mcpSources(id: string | null): Promise<void> {
    if (!id || !(await this.mcpConsentFor(id))) return;
    try {
      const result = await this.client.run<Record<string, unknown>>(['mcp', 'sources', id, '--launch', '--json']);
      this.post({ type: 'studio.mcpSourcesListed', result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /** The host entry of an installed MCP server goes to this workspace's VS Code file, on request. */
  private async mcpHostAdd(id: string | null): Promise<void> {
    if (!id || !SERVER_ID.test(id)) return;
    const confirmed = await showCompactWarningMessage(`Add MCP server '${id}' to this workspace's .vscode/mcp.json?`, {
      modal: true,
      detail: 'The entry comes from the reviewed import. VS Code asks before it starts the server; review and commit the file like any other change.'
    }, 'Add host entry');
    if (confirmed !== 'Add host entry') return;
    try {
      const result = await this.client.run<{ path?: string; host?: { type?: string; command?: string; args?: string[]; url?: string } }>(['mcp', 'host', 'add', id, '--json']);
      const what = result.host?.type === 'stdio' ? `It runs: ${[result.host.command ?? '', ...(result.host.args ?? [])].join(' ')}` : `It connects to: ${result.host?.url ?? ''}`;
      this.post({ type: 'studio.mcpHostAdded', summary: `Added '${id}' to ${result.path ?? '.vscode/mcp.json'}. ${what}` });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  private async importsCheck(): Promise<void> {
    try {
      const result = await this.client.run<Record<string, unknown>>(['imports', 'check', '--json']);
      this.post({ type: 'studio.importsChecked', result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  private async load(reset: boolean): Promise<void> {
    try {
      this.model = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]);
      this.post({ type: 'studio.model', model: this.model, reset });
      if (this.focus) { this.post({ type: 'studio.focus', view: this.focus }); this.focus = null; }
      await this.offerSavedDraft();
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  /** The configuration revision a draft is made on, as text, or null when the model names none. */
  private modelBase(): string | null {
    const base = this.model?.base;
    return base == null ? null : JSON.stringify(base);
  }

  /** Offer kept changes back, but only against the configuration they were made on; others are dropped. */
  private async offerSavedDraft(): Promise<void> {
    const store = this.actions.draftStore;
    if (!store) return;
    const saved = store.get() as Partial<StudioSavedDraft> | undefined;
    if (!saved || saved.schema !== 1 || typeof saved.draft !== 'string') return;
    if (saved.base !== this.modelBase()) { await store.set(undefined); return; }
    this.post({ type: 'studio.savedDraft', draft: saved.draft, savedAt: saved.savedAt ?? null });
  }

  private async saveDraft(text: string | null): Promise<void> {
    const store = this.actions.draftStore;
    const base = this.modelBase();
    if (!store || !text || !base || Buffer.byteLength(text, 'utf8') > MAX_CHANGE_SET_BYTES) return;
    await store.set({ schema: 1, base, savedAt: new Date().toISOString(), draft: text });
  }

  private async clearDraft(): Promise<void> {
    await this.actions.draftStore?.set(undefined);
  }

  private changeSet(text: string | null): string | null {
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_CHANGE_SET_BYTES) {
      this.post({ type: 'studio.failed', message: 'That change set is empty or too large to check.' });
      return null;
    }
    return text;
  }

  private async preview(text: string | null): Promise<void> {
    const changeSet = this.changeSet(text);
    if (!changeSet) return;
    try {
      const plan = await this.client.runWithInput<StudioPlan>([...STUDIO_PREVIEW_ARGS], changeSet);
      this.post({ type: 'studio.plan', plan, changeSet });
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  private async publish(text: string | null, count: number): Promise<void> {
    const changeSet = this.changeSet(text);
    if (!changeSet) return;
    let args: string[];
    try { args = studioPublishArgs(this.model?.authority); }
    catch (error) { this.post({ type: 'studio.failed', message: (error as Error).message }); return; }
    const proposal = args.includes('--propose');
    const confirmed = await showCompactWarningMessage(
      `Publish ${count} ${count === 1 ? 'change' : 'changes'} from Workflow Studio?`,
      {
        modal: true,
        detail: proposal
          ? 'They become one review proposal on the approved configuration. Approved configuration and running Stories do not change until it is merged.'
          : 'The files are written to this repository. Review the diff and commit it through your usual review. Running Stories keep the workflow they started with.'
      },
      proposal ? 'Publish for review' : 'Write files'
    );
    if (!confirmed) { this.post({ type: 'studio.cancelled' }); return; }
    this.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Publishing Workflow Studio changes', cancellable: false },
        () => this.client.runWithInput<StudioApplyResult>(args, changeSet)
      );
      for (const line of result.summary ?? []) this.output.appendLine(`  ${line}`);
      const summary = result.reviewRequired && result.branch
        ? `Published for review as ${result.branch}.`
        : `Wrote ${(result.written ?? []).length} file(s) to this repository.`;
      this.post({ type: 'studio.published', summary });
      await this.clearDraft();
      await this.load(true);
      await this.actions.refresh();
      if (result.reviewRequired && result.branch) {
        const choice = await showCompactInformationMessage(
          `Workflow Studio changes are ready for review: ${result.branch}.`, 'Review and activate', 'Later');
        if (choice === 'Review and activate') await this.actions.reviewProposal(result.branch);
      } else {
        const choice = await showCompactInformationMessage(
          'Workflow Studio wrote the configuration files. Review the diff and commit it.', 'Open Source Control');
        if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      }
    } catch (error) {
      this.output.appendLine(`  refused: ${(error as Error).message}`);
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (WorkflowStudioPanel.current === this) WorkflowStudioPanel.current = null;
  }
}

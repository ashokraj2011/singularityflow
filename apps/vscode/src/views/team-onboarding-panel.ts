/** Host boundary for the bounded TON-v1 team-onboarding journey. */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  beginTeamRepositoryInspection,
  changeRepositoryFriendlyName,
  changeRepositoryCapabilityId,
  changeTeamId,
  changeTeamName,
  changeTeamRepositoryDecision,
  changeTeamRepositorySelection,
  classifyTeamRepositoryInspection,
  emptyTeamOnboardingView,
  finishTeamRepositoryInspection,
  mapTeamRequest,
  markTeamRepositoryInspecting,
  recordTeamRepositoryOutcome,
  selectedTeamRepositories,
  teamOnboardingCatalogKey,
  teamOnboardingProblems,
  teamOnboardingRepository,
  teamOnboardingProposalPreview,
  type TeamOnboardingAuthority,
  type TeamOnboardingRawInspection,
  type TeamOnboardingRepositoryDecision,
  type TeamOnboardingRepositoryRow,
  type TeamOnboardingView
} from './team-onboarding-model.ts';
import { withTeamOnboardingRequestFile } from './team-onboarding-request.ts';
import { TEAM_ONBOARDING_SCRIPT, teamOnboardingHtml } from './team-onboarding-page.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  booleanField, enumField, registerMessageRouter, stringField, type InboundMessage
} from './messages.ts';
import { gitRemoteProblem } from './map-capability-form.ts';

type Run = (
  argv: string[], signal?: AbortSignal
) => Promise<{ result: unknown; error: string | null }>;

interface LeadRecord { url?: string; name?: string; }

interface RepositoryCatalogRecord {
  selectionRef?: string;
  display?: { nameWithOwner?: string };
  repositoryIdentity?: { providerInstanceId?: string | null };
  locators?: { https?: string | null; ssh?: string | null };
  providerFacts?: { visibility?: string | null; permission?: string | null } | null;
  knownAssociations?: unknown[];
}

interface RepositoryCatalogPage {
  repositories?: RepositoryCatalogRecord[];
  enumeration?: string;
  reasons?: string[];
  nextCursor?: string | null;
  request?: { accountBinding?: string | null };
  usage?: { providerQueries?: number; providerDurationMs?: number; cache?: string };
}

interface RepositorySelectionPreparation { status?: string; locator?: string; }

interface TeamMapResult {
  lead?: string;
  teamId?: string;
  capabilityId?: string;
  branch?: string | null;
  commit?: string | null;
  alreadyMapped?: boolean;
  reviewRequired?: boolean;
}

interface CatalogSecret {
  source: 'catalog' | 'paste';
  selectionRef: string | null;
  locator: string | null;
}

interface CatalogContinuation {
  scope: 'known' | 'provider';
  host: string | null;
  query: string;
  account: string | null;
  cursor: string;
}

export type TeamProposalReview = (
  lead: string,
  branch: string,
  onActivated: () => Promise<void>
) => void;

export type TeamWorkspaceOpen = (teamId: string, lead: string) => Promise<void>;

function opaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}

function remoteHost(remote: string): string | null {
  const value = remote.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return new URL(value).hostname || null;
  } catch { return null; }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):[^\s]+$/u.exec(value);
  return scp?.[1] ?? null;
}

function displayNameForUrl(remote: string): string {
  const normalized = remote.replace(/[?#].*$/u, '').replace(/\/+$/u, '');
  const tail = normalized.split(/[/:]/u).filter(Boolean).slice(-2).join('/');
  return tail.replace(/\.git$/iu, '') || 'pasted/repository';
}

function catalogRepositoryKey(record: RepositoryCatalogRecord, nameWithOwner: string): string {
  const observedLocator = record.locators?.https?.trim() || record.locators?.ssh?.trim() || '';
  return teamOnboardingCatalogKey({
    providerInstanceId: record.repositoryIdentity?.providerInstanceId,
    host: remoteHost(observedLocator),
    nameWithOwner
  });
}

/**
 * One retained panel owns every RDS cursor, selection reference and Git locator.
 *
 * The document receives only opaque row/authority IDs and cannot substitute its own URL into an
 * inspection or proposal command. A stale or unknown ID is ignored and the current host state is
 * rendered again.
 */
export class TeamOnboardingPanel {
  private static current: TeamOnboardingPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly catalogSecrets = new Map<string, CatalogSecret>();
  private readonly rowByCatalogName = new Map<string, string>();
  private catalogController: AbortController | null = null;
  private catalogRevision = 0;
  private authorityController: AbortController | null = null;
  private inspectionController: AbortController | null = null;
  private continuation: CatalogContinuation | null = null;
  private providerHost: string | null = null;
  private view: TeamOnboardingView = emptyTeamOnboardingView();
  private disposed = false;

  private readonly router = registerMessageRouter('singularityFlow.teamOnboarding', {
    'team-field': (message: InboundMessage) => this.teamField(message),
    authority: (message: InboundMessage) => this.authority(message),
    'authority-from-selection': () => void this.authorityFromSelection(),
    'catalog-search': (message: InboundMessage) => void this.catalogSearch(message),
    'catalog-provider': () => void this.loadProvider('', false, this.beginCatalogRead()),
    'catalog-refresh': () => void this.refreshCatalog(),
    'catalog-more': () => void this.loadMore(),
    'repository-paste': () => void this.pasteRepository(),
    'repository-selection': (message: InboundMessage) => this.repositorySelection(message),
    'repository-field': (message: InboundMessage) => this.repositoryField(message),
    'inspect-selected': () => void this.inspectSelected(),
    'inspection-cancel': () => this.cancelInspection(),
    'repository-decision': (message: InboundMessage) => this.repositoryDecision(message),
    'repository-retry': (message: InboundMessage) => void this.retryRepository(message),
    'repository-resolve': (message: InboundMessage) => void this.resolveRepository(message),
    'proposal-submit': () => void this.submitProposal(),
    'proposal-review': () => this.reviewProposal(),
    'navigate-step': (message: InboundMessage) => this.navigateStep(message),
    'workspace-capability': (message: InboundMessage) => this.workspaceCapability(message),
    'workspace-refresh': () => this.refreshWorkspacePreview(),
    'workspace-open': () => void this.openWorkspace()
  });

  private constructor(
    context: vscode.ExtensionContext,
    private readonly run: Run,
    private readonly review: TeamProposalReview,
    private readonly workspaceOpen: TeamWorkspaceOpen
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'singularityFlow.teamOnboarding', 'Onboard a team', vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.initialize();
  }

  static show(
    context: vscode.ExtensionContext,
    run: Run,
    review: TeamProposalReview,
    workspaceOpen: TeamWorkspaceOpen
  ): TeamOnboardingPanel {
    if (this.current) {
      this.current.panel.reveal(vscode.ViewColumn.Active);
      return this.current;
    }
    this.current = new TeamOnboardingPanel(context, run, review, workspaceOpen);
    return this.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Onboard a team', teamOnboardingHtml(this.view),
      contentSecurityPolicy(this.panel.webview, token), token, TEAM_ONBOARDING_SCRIPT
    );
  }

  private async initialize(): Promise<void> {
    this.view = { ...this.view, catalog: { ...this.view.catalog, loading: true }, error: null };
    this.render();
    const leadsRead = await this.run(['capability', 'leads', '--json']);
    if (!leadsRead.error) {
      const leads = Array.isArray(leadsRead.result) ? leadsRead.result as LeadRecord[] : [];
      const authorities: TeamOnboardingAuthority[] = leads
        .map((lead, index) => ({
          id: `authority-${index}`,
          label: lead.name?.trim() || remoteHost(lead.url ?? '') || `Capability authority ${index + 1}`,
          leadUrl: lead.url?.trim() ?? '',
          detail: 'Registered authority'
        }))
        .filter((lead) => lead.leadUrl && !gitRemoteProblem(lead.leadUrl, 'Capability authority'));
      this.view = {
        ...this.view,
        authorities,
        selectedAuthorityId: authorities.length === 1 ? authorities[0]!.id : null
      };
      this.providerHost = authorities.length === 1 ? remoteHost(authorities[0]!.leadUrl) : null;
    }
    await this.refreshCatalog();
  }

  private beginCatalogRead(): number {
    this.catalogController?.abort();
    this.catalogController = null;
    this.catalogRevision += 1;
    return this.catalogRevision;
  }

  private catalogReadIsCurrent(revision: number): boolean {
    return !this.disposed && revision === this.catalogRevision;
  }

  private async catalogRun(
    argv: string[], notice: string, revision: number
  ): Promise<RepositoryCatalogPage | null> {
    if (!this.catalogReadIsCurrent(revision)) return null;
    this.view = {
      ...this.view,
      catalog: { ...this.view.catalog, loading: true, notice },
      error: null
    };
    this.render();
    const controller = new AbortController();
    this.catalogController = controller;
    const read = await this.run(argv, controller.signal);
    if (this.catalogController === controller) this.catalogController = null;
    if (controller.signal.aborted || !this.catalogReadIsCurrent(revision)) return null;
    if (read.error) {
      this.view = {
        ...this.view,
        catalog: { ...this.view.catalog, loading: false, notice: null },
        error: read.error
      };
      this.render();
      return null;
    }
    return read.result as RepositoryCatalogPage;
  }

  private mergeCatalog(pageValue: RepositoryCatalogPage, append: boolean): void {
    const pageRows: TeamOnboardingRepositoryRow[] = [];
    for (const record of pageValue.repositories ?? []) {
      const name = record.display?.nameWithOwner?.trim();
      if (!name) continue;
      const key = catalogRepositoryKey(record, name);
      const existingId = this.rowByCatalogName.get(key);
      const existing = existingId
        ? this.view.repositories.find((row) => row.id === existingId) ?? null
        : null;
      const selectionRef = record.selectionRef?.trim() || null;
      if (existing) {
        const secret = this.catalogSecrets.get(existing.id);
        // Catalog URLs are observations only. An opaque selection must be revalidated immediately
        // before inspection; only a URL entered through the explicit native paste form may bypass
        // that RDS selection step.
        if (selectionRef) {
          this.catalogSecrets.set(existing.id, {
            source: 'catalog', selectionRef, locator: null
          });
        } else if (!secret) {
          this.catalogSecrets.set(existing.id, {
            source: 'catalog', selectionRef: null, locator: null
          });
        }
        pageRows.push(existing);
        continue;
      }
      const row = teamOnboardingRepository({
        id: opaqueId('repository'),
        nameWithOwner: name,
        visibility: record.providerFacts?.visibility ?? null,
        access: record.providerFacts?.permission
          ?? (record.knownAssociations?.length ? 'Known to SFlow' : null),
        // A locator is admitted only after `repositories select`, or by the native paste form.
        locator: null
      });
      this.rowByCatalogName.set(key, row.id);
      this.catalogSecrets.set(row.id, {
        source: 'catalog', selectionRef, locator: null
      });
      pageRows.push(row);
    }
    const retained = append
      ? this.view.repositories
      : this.view.repositories.filter((row) => row.selected);
    const merged = new Map(retained.map((row) => [row.id, row]));
    for (const row of pageRows) merged.set(row.id, row);
    const source = this.providerHost ? `GitHub · ${this.providerHost}` : 'Repositories known to SFlow';
    this.view = {
      ...this.view,
      repositories: [...merged.values()],
      catalog: {
        ...this.view.catalog,
        loading: false,
        hasMore: Boolean(pageValue.nextCursor),
        providerConnected: this.providerHost != null,
        sourceLabel: source,
        notice: (pageValue.reasons ?? []).join(' ') || `${pageRows.length} repositories available.`
      },
      error: null
    };
    this.render();
  }

  private async refreshCatalog(): Promise<void> {
    const revision = this.beginCatalogRead();
    this.continuation = null;
    const known = await this.catalogRun([
      'repositories', 'list', '--scope', 'known', '--audience', 'native', '--surface', 'vscode',
      '--limit', '100', '--json'
    ], 'Reading repositories already known to Singularity Flow…', revision);
    if (!this.catalogReadIsCurrent(revision)) return;
    if (known) this.mergeCatalog(known, false);
    if (this.providerHost) await this.loadProvider('', false, revision);
  }

  private async ensureProviderHost(): Promise<string | null> {
    if (this.providerHost) return this.providerHost;
    const entered = await vscode.window.showInputBox({
      title: 'Git provider host',
      prompt: 'GitHub or GitHub Enterprise host used by the active stored gh identity.',
      value: 'github.com',
      ignoreFocusOut: true,
      validateInput: (value) => /^[A-Za-z0-9.-]+$/u.test(value.trim())
        ? null : 'Enter a host name such as github.com or ghe.company.com.'
    });
    this.providerHost = entered?.trim() || null;
    return this.providerHost;
  }

  private async loadProvider(
    query: string, append: boolean, revision = this.beginCatalogRead()
  ): Promise<void> {
    const host = await this.ensureProviderHost();
    if (!host || !this.catalogReadIsCurrent(revision)) return;
    const argv = query
      ? ['repositories', 'search', query, '--scope', 'provider']
      : ['repositories', 'list', '--scope', 'provider'];
    argv.push('--provider', 'github', '--host', host, '--audience', 'native', '--surface', 'vscode',
      '--limit', '100', '--json');
    const provider = await this.catalogRun(argv, `Reading repositories from ${host}…`, revision);
    if (!this.catalogReadIsCurrent(revision)) return;
    if (!provider) return;
    this.continuation = provider.nextCursor ? {
      scope: 'provider', host, query,
      account: provider.request?.accountBinding ?? null,
      cursor: provider.nextCursor
    } : null;
    this.mergeCatalog(provider, append);
  }

  private async loadMore(): Promise<void> {
    const continuation = this.continuation;
    if (!continuation) return;
    const revision = this.beginCatalogRead();
    if (continuation.scope === 'provider' && !continuation.account) {
      this.view = { ...this.view, error: 'The provider continuation lost its exact account binding. Refresh the catalog.' };
      return this.render();
    }
    const argv = continuation.query
      ? ['repositories', 'search', continuation.query, '--scope', continuation.scope]
      : ['repositories', 'list', '--scope', continuation.scope];
    if (continuation.host) argv.push('--provider', 'github', '--host', continuation.host);
    if (continuation.account) argv.push('--account', continuation.account);
    argv.push('--cursor', continuation.cursor, '--audience', 'native', '--surface', 'vscode',
      '--limit', '100', '--json');
    const pageValue = await this.catalogRun(argv, 'Reading the next repository page…', revision);
    if (!this.catalogReadIsCurrent(revision)) return;
    if (!pageValue) return;
    this.continuation = pageValue.nextCursor ? {
      ...continuation,
      account: pageValue.request?.accountBinding ?? continuation.account,
      cursor: pageValue.nextCursor
    } : null;
    this.mergeCatalog(pageValue, true);
  }

  private async catalogSearch(message: InboundMessage): Promise<void> {
    const raw = typeof message.query === 'string' ? message.query.trim() : '';
    if (Buffer.byteLength(raw, 'utf8') > 512) {
      this.view = { ...this.view, error: 'Repository search text is limited to 512 bytes.' };
      return this.render();
    }
    this.view = { ...this.view, catalog: { ...this.view.catalog, query: raw } };
    await this.loadProvider(raw, false, this.beginCatalogRead());
  }

  private async pasteRepository(): Promise<void> {
    const entered = await vscode.window.showInputBox({
      title: 'Paste a credential-free Git clone URL',
      prompt: 'HTTPS or SSH is accepted. User-info, passwords, and tokens in URLs are refused.',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim()
        ? gitRemoteProblem(value.trim(), 'Repository') : 'Enter a Git clone URL.'
    });
    if (!entered) return;
    const locator = entered.trim();
    const row = teamOnboardingRepository({
      id: opaqueId('repository'),
      nameWithOwner: displayNameForUrl(locator),
      locator
    });
    row.selected = true;
    this.catalogSecrets.set(row.id, { source: 'paste', selectionRef: null, locator });
    this.rowByCatalogName.set(
      teamOnboardingCatalogKey({ host: remoteHost(locator), nameWithOwner: row.nameWithOwner }),
      row.id
    );
    this.view = {
      ...this.view,
      repositories: [...this.view.repositories, row],
      error: this.view.authorities.length
        ? null
        : 'Repository selected. Explicitly choose which selected repository will own the first capability-map authority.'
    };
    this.render();
  }

  private teamField(message: InboundMessage): void {
    const field = enumField(message, 'field', ['name', 'id', 'jiraProject'] as const);
    const value = typeof message.value === 'string' ? message.value.slice(0, 512) : null;
    if (!field || value == null) return;
    if (field === 'name') this.view = changeTeamName(this.view, value);
    else if (field === 'id') this.view = changeTeamId(this.view, value);
    else this.view = { ...this.view, jiraProject: value.toLocaleUpperCase(), error: null };
    this.render();
  }

  private authority(message: InboundMessage): void {
    const authorityId = stringField(message, 'authorityId');
    if (!authorityId || !this.view.authorities.some((entry) => entry.id === authorityId)) return;
    this.view = { ...this.view, selectedAuthorityId: authorityId, error: null };
    const authority = this.view.authorities.find((entry) => entry.id === authorityId);
    this.providerHost = authority ? remoteHost(authority.leadUrl) : this.providerHost;
    this.render();
    if (this.providerHost) {
      void this.loadProvider(this.view.catalog.query, false, this.beginCatalogRead());
    }
  }

  private async authorityFromSelection(): Promise<void> {
    if (this.view.authorities.length) return;
    const selected = selectedTeamRepositories(this.view);
    if (!selected.length) {
      this.view = {
        ...this.view,
        error: 'Select at least one repository before choosing the first capability-map authority.'
      };
      return this.render();
    }
    const picked = await vscode.window.showQuickPick(
      selected.map((row) => ({
        label: row.nameWithOwner,
        description: row.friendlyName,
        rowId: row.id
      })),
      {
        title: 'Choose the first capability-map authority',
        placeHolder: 'This repository will own the reviewed sflow/config capability map.',
        ignoreFocusOut: true
      }
    );
    if (!picked) return;
    const row = selected.find((entry) => entry.id === picked.rowId);
    if (!row) return;
    this.authorityController?.abort();
    const controller = new AbortController();
    this.authorityController = controller;
    try {
      const locator = await this.preparedLocator(row, controller.signal);
      if (controller.signal.aborted || this.disposed
          || this.authorityController !== controller) return;
      const authority: TeamOnboardingAuthority = {
        id: opaqueId('authority'),
        label: row.nameWithOwner,
        leadUrl: locator,
        detail: 'Will become the first capability-map authority after review'
      };
      this.view = {
        ...this.view,
        authorities: [authority],
        selectedAuthorityId: authority.id,
        repositories: this.view.repositories.map((entry) => entry.id === row.id
          ? { ...entry, locator } : entry),
        error: null
      };
      this.providerHost = remoteHost(locator);
      this.render();
    } catch (error) {
      if (controller.signal.aborted || this.disposed) return;
      this.view = {
        ...this.view,
        error: error instanceof Error ? error.message : String(error)
      };
      this.render();
    } finally {
      if (this.authorityController === controller) this.authorityController = null;
    }
  }

  private repositorySelection(message: InboundMessage): void {
    const rowId = stringField(message, 'rowId');
    if (!rowId) return;
    const changed = changeTeamRepositorySelection(this.view, rowId, booleanField(message, 'selected'));
    this.view = changed.problem ? { ...changed.view, error: changed.problem } : changed.view;
    this.render();
  }

  private repositoryField(message: InboundMessage): void {
    const rowId = stringField(message, 'rowId');
    const field = enumField(message, 'field', ['name', 'id'] as const);
    const value = typeof message.value === 'string' ? message.value.slice(0, 512) : null;
    if (!rowId || !field || value == null || !this.catalogSecrets.has(rowId)) return;
    this.view = field === 'name'
      ? changeRepositoryFriendlyName(this.view, rowId, value)
      : changeRepositoryCapabilityId(this.view, rowId, value);
    this.render();
  }

  private repositoryDecision(message: InboundMessage): void {
    const rowId = stringField(message, 'rowId');
    const decision = enumField(
      message, 'decision', ['include', 'set-aside'] as const
    ) as TeamOnboardingRepositoryDecision | null;
    if (!rowId || !decision || !this.catalogSecrets.has(rowId)) return;
    this.view = changeTeamRepositoryDecision(this.view, rowId, decision);
    this.render();
  }

  private selectedAuthority(): TeamOnboardingAuthority | null {
    return this.view.authorities.find((entry) => entry.id === this.view.selectedAuthorityId) ?? null;
  }

  private async preparedLocator(
    row: TeamOnboardingRepositoryRow,
    signal: AbortSignal | undefined = this.inspectionController?.signal
  ): Promise<string> {
    const secret = this.catalogSecrets.get(row.id);
    if (!secret) throw new Error('The repository catalog selection is no longer available. Refresh it.');
    if (secret.source === 'catalog') {
      if (!secret.selectionRef) {
        throw new Error(
          'The repository catalog selection is incomplete or expired. Refresh the catalog and choose it again.'
        );
      }
      const selected = await this.run([
        'repositories', 'select', secret.selectionRef, '--action', 'inspect',
        '--surface', 'vscode', '--json'
      ], signal);
      if (selected.error) throw new Error(selected.error);
      const locator = (selected.result as RepositorySelectionPreparation)?.locator?.trim() ?? '';
      const problem = gitRemoteProblem(locator, row.nameWithOwner);
      if (!locator || problem) throw new Error(problem ?? 'The repository has no safe Git locator.');
      this.catalogSecrets.set(row.id, { ...secret, locator });
      return locator;
    }
    const locator = secret.locator?.trim() ?? '';
    const problem = gitRemoteProblem(locator, row.nameWithOwner);
    if (!locator || problem) throw new Error(problem ?? 'The repository has no safe Git locator.');
    return locator;
  }

  private async inspectOne(rowId: string): Promise<void> {
    const row = this.view.repositories.find((entry) => entry.id === rowId && entry.selected);
    const authority = this.selectedAuthority();
    if (!row || !authority) return;
    this.view = markTeamRepositoryInspecting(this.view, row.id);
    this.render();
    try {
      const locator = await this.preparedLocator(row);
      this.view = {
        ...this.view,
        repositories: this.view.repositories.map((entry) => entry.id === row.id
          ? { ...entry, locator } : entry)
      };
      const inspected = await this.run([
        'capability', 'inspect-repository', locator,
        '--lead', authority.leadUrl, '--include-proposals', '--json'
      ], this.inspectionController?.signal);
      if (inspected.error) throw new Error(inspected.error);
      const outcome = classifyTeamRepositoryInspection(inspected.result as TeamOnboardingRawInspection, {
        authorityLeadUrl: authority.leadUrl,
        teamId: this.view.teamId
      });
      this.view = recordTeamRepositoryOutcome(this.view, row.id, outcome);
    } catch (error) {
      if (this.inspectionController?.signal.aborted) return;
      this.view = recordTeamRepositoryOutcome(this.view, row.id, {
        status: 'left-out', detail: error instanceof Error ? error.message : String(error)
      });
    }
    this.render();
  }

  private async inspectSelected(): Promise<void> {
    const problems = teamOnboardingProblems(this.view, 'team-and-repositories');
    if (problems.length) {
      this.view = { ...this.view, error: problems.join(' ') };
      return this.render();
    }
    this.inspectionController?.abort();
    this.inspectionController = new AbortController();
    this.view = beginTeamRepositoryInspection(this.view);
    this.render();
    const selected = selectedTeamRepositories(this.view).map((row) => row.id);
    for (const rowId of selected) {
      if (this.inspectionController.signal.aborted) break;
      await this.inspectOne(rowId);
    }
    const cancelled = this.inspectionController.signal.aborted;
    this.inspectionController = null;
    this.view = finishTeamRepositoryInspection(this.view, { cancelled });
    this.render();
  }

  private cancelInspection(): void {
    this.inspectionController?.abort();
    this.view = finishTeamRepositoryInspection(this.view, { cancelled: true });
    this.render();
  }

  private async retryRepository(message: InboundMessage): Promise<void> {
    const rowId = stringField(message, 'rowId');
    if (!rowId || this.inspectionController || !this.catalogSecrets.has(rowId)) return;
    this.inspectionController = new AbortController();
    this.view = { ...this.view, inspection: { ...this.view.inspection, running: true, cancelled: false } };
    await this.inspectOne(rowId);
    this.inspectionController = null;
    this.view = finishTeamRepositoryInspection(this.view);
    this.render();
  }

  private async resolveRepository(message: InboundMessage): Promise<void> {
    const rowId = stringField(message, 'rowId');
    const row = this.view.repositories.find((entry) => entry.id === rowId);
    if (!row) return;
    const retry = 'Check again';
    const setAside = 'Set aside';
    const chosen = await vscode.window.showWarningMessage(
      row.detail ?? 'This repository needs a choice before it can enter the proposal.',
      { modal: true, detail: 'Checking again refreshes its exact repository and authority evidence. Setting it aside preserves the result and lets other eligible repositories proceed.' },
      retry, setAside
    );
    if (chosen === retry) await this.retryRepository({ type: 'repository-retry', rowId });
    if (chosen === setAside) {
      this.view = changeTeamRepositoryDecision(this.view, row.id, 'set-aside');
      this.render();
    }
  }

  private async submitProposal(): Promise<void> {
    if (this.view.proposal.status === 'running') return;
    let request: ReturnType<typeof mapTeamRequest>;
    try { request = mapTeamRequest(this.view); }
    catch (error) {
      this.view = { ...this.view, error: error instanceof Error ? error.message : String(error) };
      return this.render();
    }
    this.view = {
      ...this.view,
      proposal: { status: 'running', message: 'Creating one atomic review proposal…' },
      error: null
    };
    this.render();
    let proposed: { result: unknown; error: string | null };
    try {
      proposed = await withTeamOnboardingRequestFile(request, async (requestFile) => {
        const argv = ['capability', 'map-team', '--request', requestFile, '--json'];
        return this.run(argv);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view = {
        ...this.view,
        proposal: { status: 'failed', message },
        error: message
      };
      return this.render();
    }
    if (proposed.error) {
      this.view = {
        ...this.view,
        proposal: { status: 'failed', message: proposed.error },
        error: proposed.error
      };
      return this.render();
    }
    const result = proposed.result as TeamMapResult;
    if (result.alreadyMapped) {
      this.view = {
        ...this.view,
        proposal: {
          status: 'active', message: 'This exact team mapping is already approved.',
          branch: null, commit: null
        }
      };
      this.populateWorkspacePreview();
      return this.render();
    }
    if (!result.branch) {
      this.view = {
        ...this.view,
        proposal: { status: 'failed', message: 'The engine returned no review branch.' },
        error: 'The team proposal has no review branch and was not treated as active.'
      };
      return this.render();
    }
    this.view = {
      ...this.view,
      proposal: {
        status: 'review-required',
        message: 'One proposal contains the team and every eligible repository. Review its exact diff.',
        branch: result.branch,
        commit: result.commit ?? null
      }
    };
    this.render();
  }

  private reviewProposal(): void {
    const authority = this.selectedAuthority();
    const branch = this.view.proposal.branch;
    if (!authority || !branch) return;
    this.review(authority.leadUrl, branch, async () => {
      this.view = {
        ...this.view,
        step: 'workspaces',
        proposal: {
          ...this.view.proposal,
          status: 'active',
          message: 'The team capability proposal is approved and active.'
        },
        error: null
      };
      this.populateWorkspacePreview();
      this.render();
    });
  }

  private populateWorkspacePreview(): void {
    const preview = teamOnboardingProposalPreview(this.view);
    this.view = {
      ...this.view,
      workspace: {
        ready: this.view.proposal.status === 'active',
        busy: false,
        capabilities: [{
          id: 'new-team', capabilityId: preview.team.id,
          name: preview.team.name, authorityLabel: preview.authority?.label ?? 'Capability authority',
          selected: true
        }],
        repositories: preview.members.map((member) => ({
          id: member.rowId, name: member.capabilityId, origin: member.locator,
          action: 'pending' as const,
          evidence: 'The workspace target preflight will prove clone or reuse after its folder is chosen.'
        })),
        message: `${preview.links.length} linked existing ${preview.links.length === 1 ? 'capability is' : 'capabilities are'} intentionally resolved from the approved map in workspace setup. Continue there to name the workspace, choose its folder, add capabilities from other teams, and prove the exact clone/reuse plan.`
      }
    };
  }

  private navigateStep(message: InboundMessage): void {
    const direction = enumField(message, 'direction', ['back', 'next'] as const);
    if (!direction) return;
    if (direction === 'back') {
      this.view = {
        ...this.view,
        step: this.view.step === 'workspaces' ? 'check-and-onboard' : 'team-and-repositories',
        error: null
      };
    } else if (this.view.proposal.status === 'active') {
      this.view = { ...this.view, step: 'workspaces', error: null };
      this.populateWorkspacePreview();
    }
    this.render();
  }

  private workspaceCapability(message: InboundMessage): void {
    const id = stringField(message, 'capabilityKey');
    if (!id) return;
    this.view = {
      ...this.view,
      workspace: {
        ...this.view.workspace,
        capabilities: this.view.workspace.capabilities.map((entry) => entry.id === id
          ? { ...entry, selected: booleanField(message, 'selected') } : entry)
      }
    };
    this.render();
  }

  private refreshWorkspacePreview(): void {
    if (this.view.proposal.status !== 'active') return;
    this.populateWorkspacePreview();
    this.render();
  }

  private async openWorkspace(): Promise<void> {
    const authority = this.selectedAuthority();
    if (this.view.proposal.status !== 'active' || !authority || !this.view.workspace.ready) return;
    await this.workspaceOpen(this.view.teamId, authority.leadUrl);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.catalogController?.abort();
    this.catalogController = null;
    this.authorityController?.abort();
    this.authorityController = null;
    this.inspectionController?.abort();
    this.inspectionController = null;
    if (TeamOnboardingPanel.current === this) TeamOnboardingPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

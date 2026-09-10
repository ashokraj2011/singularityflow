/**
 * The panel behind "map a capability".
 *
 * Registered and usable before any repository is open, which is the point: describing what an
 * organisation builds is not work done inside a checkout, and requiring one was the circular
 * dependency this whole screen exists to break.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  EMPTY_MAP_FORM, gitRemoteProblem, mapCapabilityHtml, mapCommand, mapProblems,
  MAP_CAPABILITY_SCRIPT, type MapCapabilityForm, type ParentChoice
} from './map-capability-form.ts';
import type { StartWizardProgress } from './start-wizard.ts';
import { formatCliArgsForDisplay } from '../cli/runner.ts';

/** The map as `capability organisation --json` reports it. */
export interface Organisation {
  governed: boolean;
  capabilities: Array<{ id: string; name: string; kind?: string; repository?: string | null; children: unknown[] }>;
}

interface RepositoryInspection {
  status?: string;
  repositoryUrl?: string;
  matches?: Array<{
    lead?: string; repositoryId?: string; repositoryUrl?: string; capabilities?: string[];
    defaultBranch?: string; stateBranch?: string;
    governed?: boolean; sourceBranch?: string | null; sourceCommit?: string | null;
    cached?: boolean; stale?: boolean;
  }>;
  pendingMatches?: Array<{
    lead?: string; repositoryId?: string; repositoryUrl?: string; capabilities?: string[];
    capabilityMetadataComplete?: boolean; proposalBranch?: string; proposalCommit?: string;
    proposalStatus?: string; proposalValid?: boolean;
  }>;
  checkedLeads?: string[];
  failures?: Array<string | {
    lead?: string; code?: string; classification?: string; retryable?: boolean; message?: string;
    diagnosticAction?: { command?: string; skill?: string } | null;
  }>;
  authorityScope?: string;
  completeness?: string;
  proposalCoverage?: string;
  proposalInspection?: { total?: number; inspected?: number; limitPerAuthority?: number };
  organisations?: Array<{ lead?: string; stale?: boolean; organisation?: Organisation }>;
}

interface RepositoryCatalogRecord {
  selectionRef?: string;
  display?: { nameWithOwner?: string };
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
  usage?: { providerQueries?: number; providerDurationMs?: number };
}

interface RepositorySelectionPreparation {
  status?: string;
  locator?: string;
}

export interface Mapped {
  capabilityId: string;
  repositoryId: string | null;
  lead: string;
  branch: string | null;
  baseBranch: string;
  commit: string | null;
  reviewRequired: boolean;
}

export interface MapCapabilityLaunch {
  parent?: string;
  journey?: StartWizardProgress | null;
  chooseRepository?: boolean;
}

type Run = (argv: string[], signal?: AbortSignal) => Promise<{ result: unknown; error: string | null }>;

/** Flatten the map into the parents a new capability may sit under. */
function parentChoices(nodes: Organisation['capabilities'], depth = 0): ParentChoice[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth, ships: Boolean(node.repository) },
    ...parentChoices((node.children ?? []) as Organisation['capabilities'], depth + 1)
  ]);
}

export class BootstrapPanel {
  private static current: BootstrapPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly run: Run;
  private onMapped: (result: Mapped) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private form: MapCapabilityForm = { ...EMPTY_MAP_FORM };
  private requestedParent = '';
  private journey: StartWizardProgress | null = null;
  private mapLoadRevision = 0;
  private inspectionRevision = 0;
  private readonly inspectedOrganisations = new Map<string, Organisation>();

  private constructor(
    panel: vscode.WebviewPanel, leads: string[], run: Run,
    onMapped: (result: Mapped) => Promise<void>,
    initial: MapCapabilityLaunch = {}
  ) {
    this.panel = panel;
    this.run = run;
    this.onMapped = onMapped;
    this.requestedParent = initial.parent?.trim() ?? '';
    this.journey = initial.journey ?? null;
    // A legacy or corrupt machine registry may predate credential-free URL enforcement. Drop an
    // unsafe entry before it can reach webview HTML or the command runner; repository inspection
    // will still report the registry problem through a non-secret fingerprint.
    const uniqueLeads = [...new Set(leads
      .map((lead) => lead.trim())
      .filter((lead) => lead && !gitRemoteProblem(lead, 'Capability-map repository')))];
    this.form = {
      ...EMPTY_MAP_FORM,
      metadata: [],
      leads: uniqueLeads,
      // Repository inspection comes first. Even one known authority is not read until that check
      // establishes which onboarding path applies.
      lead: ''
    };
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
 void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext, leads: string[], run: Run,
    onMapped: (result: Mapped) => Promise<void>,
    initial: MapCapabilityLaunch = {}
  ): BootstrapPanel {
    if (BootstrapPanel.current) {
      // The retained form may have been opened from workspace creation and then reached from the
      // capability editor (or vice versa). Completion returns to the surface that most recently
      // asked for it, not the callback captured when the singleton was first created.
      BootstrapPanel.current.onMapped = onMapped;
      BootstrapPanel.current.prefill(initial);
      BootstrapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (initial.chooseRepository) void BootstrapPanel.current.chooseRepository();
      return BootstrapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.mapCapability', initial.journey ? 'Guided start' : 'Map a capability', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    BootstrapPanel.current = new BootstrapPanel(panel, leads, run, onMapped, initial);
    if (initial.chooseRepository) void BootstrapPanel.current.chooseRepository();
    return BootstrapPanel.current;
  }

  private prefill(initial: MapCapabilityLaunch): void {
    if (initial.journey !== undefined) this.journey = initial.journey;
    if (initial.parent !== undefined) {
      this.requestedParent = initial.parent.trim();
      if (this.form.parents.some((parent) => parent.id === this.requestedParent)) {
        this.form.parent = this.requestedParent;
      }
    }
    this.panel.title = this.journey ? 'Guided start' : 'Map a capability';
    this.render();
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      this.journey ? 'Guided start' : 'Map a capability',
      mapCapabilityHtml(this.form, this.journey),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      MAP_CAPABILITY_SCRIPT
    );
  }

  private update(changes: Partial<MapCapabilityForm>): void {
    this.form = { ...this.form, ...changes };
    this.render();
  }

  /** Revoke every result whose repository/authority pair may no longer match the form. */
  private invalidateInspection(): void {
    this.inspectionRevision++;
    this.inspectedOrganisations.clear();
    this.form.inspectionStatus = 'idle';
    this.form.inspectionComplete = false;
    this.form.inspectionMatches = [];
    this.form.inspectionPendingMatches = [];
    this.form.inspectionMessage = null;
    this.form.inspectionRecoveryCommand = null;
    this.form.inspectionFailures = [];
    this.form.inspectionCompleteness = null;
    this.form.inspectionAuthorityScope = null;
    this.form.inspectionProposalCoverage = null;
    this.form.inspectionProposalTotal = 0;
    this.form.inspectionProposalInspected = 0;
    this.form.inspectionCheckedLeadCount = 0;
    this.form.inspectionBoundRepositoryUrl = null;
    this.form.inspectionBoundLeadUrl = null;
  }

  private inspectionIsBound(repositoryUrl: string, leadUrl: string): boolean {
    return this.form.inspectionBoundRepositoryUrl === repositoryUrl.trim()
      && this.form.inspectionBoundLeadUrl === leadUrl.trim();
  }

  /**
   * Load the map as a consequence of selecting its repository. There is deliberately no separate
   * "read" action in the UI: repository selection is the decision; reading is just what the form
   * has to do to offer valid parent capabilities.
   */
  private async loadSelectedMap(): Promise<void> {
    if (!this.form.lead.trim() || (this.form.busy && this.form.loaded)) return;
    const selectedLead = this.form.lead.trim();
    const unsafe = gitRemoteProblem(selectedLead, 'Capability-map repository');
    if (unsafe) return void this.update({ busy: false, loaded: false, error: unsafe });
    if (!this.form.collectionWithoutRepository && this.form.repositoryUrl.trim()
      && !this.inspectionIsBound(this.form.repositoryUrl, selectedLead)) {
      this.invalidateInspection();
      return void this.update({ loaded: false, parents: [], parent: '',
        error: 'The selected capability-map repository changed. Check it for this Git repository before its map is loaded.' });
    }
    const revision = ++this.mapLoadRevision;
    this.update({ busy: true, loaded: false, parents: [], parent: '', notice: null, error: null });
    const retained = this.inspectionIsBound(this.form.repositoryUrl, selectedLead)
      ? this.inspectedOrganisations.get(selectedLead) ?? null : null;
    const loaded = retained
      ? { result: retained, error: null }
      : await this.run(['capability', 'organisation', selectedLead, '--json']);
    const { result, error } = loaded;
    // A quick second selection must not put the first repository's parents under the second one.
    if (revision !== this.mapLoadRevision || selectedLead !== this.form.lead.trim()) return;
    if (error) return void this.update({ busy: false, error });
    const organisation = result as Organisation;
    const parents = parentChoices(organisation.capabilities ?? []);
    const parent = parents.some((choice) => choice.id === this.requestedParent)
      ? this.requestedParent
      : '';
    this.update({
      busy: false,
      loaded: true,
      parents,
      parent,
      notice: organisation.governed
        ? null
        : `${selectedLead} has no capability map yet. Mapping the first capability will create it.`,
      error: null
    });
  }

  private async selectLead(value: string): Promise<void> {
    const lead = value.trim();
    const unsafe = gitRemoteProblem(lead, 'Capability-map repository');
    if (unsafe) return void this.update({ lead: '', loaded: false, parents: [], parent: '', error: unsafe });
    if (lead !== this.form.lead.trim()) {
      this.form = { ...this.form, lead, loaded: false, parents: [], parent: '', notice: null, error: null };
    }
    if (!lead) return void this.render();
    await this.loadSelectedMap();
  }

  private async chooseRepository(): Promise<void> {
    const readCatalog = async (argv: string[], title: string) => {
      let cancelled = false;
      const response = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true
      }, async (_progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          cancelled = true;
          controller.abort();
        });
        try { return await this.run(argv, controller.signal); }
        finally { subscription.dispose(); }
      });
      return cancelled ? null : response;
    };
    const knownRead = await readCatalog([
      'repositories', 'list', '--scope', 'known', '--audience', 'native', '--surface', 'vscode', '--limit', '100', '--json'
    ], 'Reading repositories already known to Singularity Flow…');
    if (!knownRead) return;
    if (knownRead.error) {
      void vscode.window.showErrorMessage(`Singularity Flow could not read known repositories: ${knownRead.error}`);
      return;
    }
    const known = knownRead.result as RepositoryCatalogPage;
    type CatalogPick = vscode.QuickPickItem & {
      selectionRef?: string;
      activateProvider?: boolean;
      loadMore?: boolean;
      information?: boolean;
      pasteUrl?: boolean;
    };
    const repositoryItems = (page: RepositoryCatalogPage, source: 'known' | 'provider'): CatalogPick[] =>
      (page.repositories ?? []).map((record) => ({
        label: `$(repo) ${record.display?.nameWithOwner ?? 'Repository'}`,
        description: source === 'known'
          ? record.knownAssociations?.length
            ? `known to SFlow · ${record.knownAssociations.length} association(s)` : 'known to SFlow'
          : [record.providerFacts?.visibility, record.providerFacts?.permission]
            .filter(Boolean).join(' · '),
        detail: source === 'known'
          ? record.locators?.https ?? record.locators?.ssh ?? undefined
          : 'Selection is revalidated before onboarding inspection.',
        selectionRef: record.selectionRef
      }));
    const informationItem: CatalogPick = {
      label: '$(info) How repository discovery works',
      description: 'Provider access, privacy, caching, and what selection does'
    };
    informationItem.information = true;
    const pasteItem: CatalogPick = {
      label: '$(link) Paste clone URL instead',
      description: 'Keep using the clone URL field; no provider request is required',
      pasteUrl: true
    };
    const showInformation = async () => {
      await vscode.window.showInformationMessage(
        'Known results come only from bounded local Singularity Flow records. Git-provider search is an explicit, cancellable read using the active stored gh identity for the host you enter. SFlow never reads or stores the token. Results may be cached privately for 15 minutes. Choosing one repository only revalidates it and opens the existing inspection flow—it does not clone, map, create a workspace, or grant authority.',
        { modal: true }
      );
    };

    let knownPage = known;
    const knownItems: CatalogPick[] = repositoryItems(knownPage, 'known');
    let picked: CatalogPick | undefined;
    while (!picked) {
      const choice = await vscode.window.showQuickPick<CatalogPick>([
        ...knownItems,
        ...(knownPage.nextCursor ? [{
          label: '$(chevron-down) Load more known repositories',
          description: 'Continue the exact bounded local catalog read', loadMore: true
        } satisfies CatalogPick] : []),
        { label: '$(github) Search Git provider…',
          description: 'Explicit network read using the active stored gh identity',
          detail: 'No repository is cloned, inspected, mapped, or added by this search.',
          activateProvider: true },
        informationItem,
        pasteItem
      ], {
        title: 'Choose repository',
        placeHolder: knownPage.enumeration === 'exhausted'
          ? 'Choose one known to SFlow, or explicitly search a Git provider'
          : 'Known results are bounded; load more or explicitly search a Git provider',
        matchOnDescription: true,
        matchOnDetail: true
      });
      if (!choice || choice.pasteUrl) return;
      if (choice.information) { await showInformation(); continue; }
      if (choice.loadMore && knownPage.nextCursor) {
        const more = await readCatalog([
          'repositories', 'list', '--scope', 'known', '--audience', 'native', '--surface', 'vscode', '--limit', '100',
          '--cursor', knownPage.nextCursor, '--json'
        ], 'Reading the next known-repository page…');
        if (!more) return;
        if (more.error) {
          void vscode.window.showErrorMessage(`The known-repository continuation failed safely: ${more.error}`);
          continue;
        }
        knownPage = more.result as RepositoryCatalogPage;
        knownItems.push(...repositoryItems(knownPage, 'known'));
        continue;
      }
      picked = choice;
    }

    let selected = picked;
    if (picked.activateProvider) {
      const host = await vscode.window.showInputBox({
        title: 'Git provider host',
        prompt: 'The exact GitHub or GitHub Enterprise host to query with the active stored gh identity.',
        value: '',
        validateInput: (value) => value.trim() ? null : 'Enter the Git provider host.'
      });
      if (!host) return;
      const query = await vscode.window.showInputBox({
        title: `Search repositories on ${host.trim()}`,
        prompt: 'Optional literal owner/name text. Leave empty to show the first bounded page.',
        placeHolder: 'payments'
      });
      if (query === undefined) return;
      const baseArgv = query.trim()
        ? ['repositories', 'search', query.trim(), '--scope', 'provider']
        : ['repositories', 'list', '--scope', 'provider'];
      baseArgv.push('--provider', 'github', '--host', host.trim(),
        '--audience', 'native', '--surface', 'vscode', '--limit', '100', '--json');
      let providerPage: RepositoryCatalogPage | null = null;
      const providerItems: CatalogPick[] = [];
      let loadProviderPage = true;
      while (!selected.selectionRef) {
        if (loadProviderPage) {
          const argv = [...baseArgv];
          if (providerPage?.nextCursor) {
            const accountBinding = providerPage.request?.accountBinding;
            if (!accountBinding) {
              void vscode.window.showErrorMessage('The provider continuation omitted its account binding and was refused. Start a fresh search.');
              return;
            }
            argv.splice(argv.length - 1, 0,
              '--account', accountBinding, '--cursor', providerPage.nextCursor);
          }
          const providerRead = await readCatalog(argv,
            providerPage ? 'Reading the next Git-provider page…' : `Reading repositories from ${host.trim()}…`);
          if (!providerRead) return;
          if (providerRead.error) {
            void vscode.window.showErrorMessage(
              `Git provider repository discovery did not complete: ${providerRead.error}`,
              'Paste clone URL instead'
            );
            return;
          }
          providerPage = providerRead.result as RepositoryCatalogPage;
          providerItems.push(...repositoryItems(providerPage, 'provider'));
          loadProviderPage = false;
        }
        const visiblePage = providerPage;
        if (!visiblePage) return;
        const choice = await vscode.window.showQuickPick<CatalogPick>([
          ...providerItems,
          ...(visiblePage.nextCursor ? [{
            label: '$(chevron-down) Load more provider repositories',
            description: 'Continue the exact host, account-bound provider traversal', loadMore: true
          } satisfies CatalogPick] : []),
          informationItem,
          pasteItem
        ], {
          title: `Repositories on ${host.trim()}`,
          placeHolder: visiblePage.enumeration === 'more'
            ? 'Choose a repository or load the next bounded page'
            : 'Choose a repository',
          matchOnDescription: true,
          matchOnDetail: true
        });
        if (!choice || choice.pasteUrl) return;
        if (choice.information) { await showInformation(); continue; }
        if (choice.loadMore && visiblePage.nextCursor) {
          loadProviderPage = true;
          continue;
        }
        selected = choice;
      }
    }

    if (!selected.selectionRef) return;
    const prepared = await this.run([
      'repositories', 'select', selected.selectionRef, '--action', 'inspect', '--surface', 'vscode', '--json'
    ]);
    if (prepared.error) {
      void vscode.window.showWarningMessage(
        `Repository selection changed or expired: ${prepared.error}`,
        'Choose again'
      );
      return;
    }
    const selection = prepared.result as RepositorySelectionPreparation;
    const repositoryUrl = selection.locator?.trim() ?? '';
    const problem = gitRemoteProblem(repositoryUrl, 'Repository');
    if (!repositoryUrl || problem) {
      void vscode.window.showErrorMessage(problem ?? 'The selected repository has no safe clone URL.');
      return;
    }
    this.invalidateInspection();
    this.form.repositoryUrl = repositoryUrl;
    this.form.lead = this.form.leads.length ? '' : repositoryUrl;
    this.render();
    await this.inspectRepository();
  }

  private async inspectRepository(
    explicitLeadUrl: string | null = null,
    options: { includeKnownAuthorities?: boolean } = {}
  ): Promise<void> {
    const repositoryUrl = this.form.repositoryUrl.trim();
    if (!repositoryUrl) return;
    const explicitLead = explicitLeadUrl?.trim() || null;
    const repositoryProblem = gitRemoteProblem(repositoryUrl, 'Repository');
    const inspectionLeads = explicitLead
      ? options.includeKnownAuthorities
        ? [...new Set([...this.form.leads, explicitLead])]
        : [explicitLead]
      : [];
    const leadProblem = inspectionLeads
      .map((lead) => gitRemoteProblem(lead, 'Capability-map repository'))
      .find((problem) => problem != null) ?? null;
    if (repositoryProblem || leadProblem) {
      this.invalidateInspection();
      // Do not retain or re-render credential material after refusal. The safe diagnostic above
      // names the host/path without user-info, queries, or fragments.
      if (repositoryProblem) {
        this.form.repositoryUrl = '';
        this.form.lead = '';
      }
      if (leadProblem) {
        if (explicitLead) this.form.inspectionLeadUrl = '';
        this.form.leads = this.form.leads.filter((lead) => !gitRemoteProblem(lead, 'Capability-map repository'));
        this.form.lead = '';
      }
      return void this.update({ inspectionStatus: 'inconclusive', inspectionComplete: false,
        inspectionMessage: repositoryProblem ?? leadProblem, error: repositoryProblem ?? leadProblem });
    }
    const revision = ++this.inspectionRevision;
    this.update({ inspectionStatus: 'checking', inspectionComplete: false,
      inspectionMatches: [], inspectionPendingMatches: [], inspectionMessage: null, inspectionFailures: [],
      inspectionCompleteness: null, inspectionAuthorityScope: null, inspectionCheckedLeadCount: 0,
      inspectionProposalCoverage: null, inspectionProposalTotal: 0, inspectionProposalInspected: 0,
      inspectionBoundRepositoryUrl: null,
      inspectionBoundLeadUrl: null,
      error: null });
    const argv = ['capability', 'inspect-repository', repositoryUrl, '--json'];
    for (const lead of inspectionLeads) argv.push('--lead', lead);
    // Resolve the portable state link first. Reading the machine-local authority registry can fan
    // out to several remotes, so it is a separate, explicit action offered after this bounded
    // inspection reports that no portable authority was found.
    if (options.includeKnownAuthorities) argv.push('--search-known');
    if (explicitLead) argv.push('--include-proposals');
    if (options.includeKnownAuthorities) argv.push('--include-proposals');
    const terminalCommand = `singularity-flow ${formatCliArgsForDisplay(argv)}`;
    const { result, error } = await this.run(argv);
    if (revision !== this.inspectionRevision || repositoryUrl !== this.form.repositoryUrl.trim()) return;
    if (error) return void this.update({ inspectionStatus: 'inconclusive', inspectionComplete: false,
      inspectionMessage: error, inspectionRecoveryCommand: terminalCommand,
      inspectionFailures: [], inspectionCompleteness: null,
      inspectionAuthorityScope: null, inspectionProposalCoverage: null,
      inspectionCheckedLeadCount: 0 });
    const inspected = (result ?? {}) as RepositoryInspection;
    this.inspectedOrganisations.clear();
    for (const entry of inspected.organisations ?? []) {
      if (entry.lead && !entry.stale && entry.organisation) {
        this.inspectedOrganisations.set(entry.lead, entry.organisation);
      }
    }
    const matches = inspected.matches ?? [];
    const pendingMatches = inspected.pendingMatches ?? [];
    const raw = inspected.status ?? 'inconclusive';
    const status = raw === 'already-mapped' || raw === 'known-repository-unassigned'
      || raw === 'ambiguous' || raw === 'not-onboarded' || raw === 'unreachable'
      || raw === 'inconclusive' ? raw : 'inconclusive';
    const selectedLead = matches.length === 1 && matches[0]?.lead ? matches[0].lead : null;
    const failures = (inspected.failures ?? []).map((failure) => {
      if (typeof failure === 'string') return failure;
      const message = failure?.message ?? failure?.code ?? 'Capability-map authority could not be inspected.';
      const action = failure?.diagnosticAction?.command
        ? ` Diagnostic: ${failure.diagnosticAction.command}` : '';
      return `${failure?.lead ? `${failure.lead}: ` : ''}${message}${action}`;
    });
    const recoveryCommand = (inspected.failures ?? [])
      .flatMap((failure) => typeof failure === 'string'
        ? [] : [failure?.diagnosticAction?.command])
      .find((command): command is string => Boolean(command));
    const availableLeads = explicitLead
      ? [...new Set([...this.form.leads, explicitLead])]
      : this.form.leads;
    const completeAuthority = inspected.completeness === 'complete'
      && inspected.proposalCoverage === 'complete';
    const boundLead = completeAuthority && selectedLead
      && (status === 'known-repository-unassigned' || status === 'already-mapped')
      ? selectedLead
      : status === 'not-onboarded' && completeAuthority
        ? (explicitLead ?? (this.form.leads.length === 0
          ? repositoryUrl
          : this.form.leads.length === 1 ? (this.form.leads[0] ?? null) : null))
        : null;
    this.form = { ...this.form, leads: availableLeads,
      inspectionStatus: status, inspectionMatches: matches, inspectionPendingMatches: pendingMatches,
      inspectionMessage: null, inspectionFailures: failures,
      inspectionRecoveryCommand: recoveryCommand ?? (failures.length ? terminalCommand : null),
      inspectionCompleteness: inspected.completeness ?? null,
      inspectionAuthorityScope: inspected.authorityScope ?? null,
      inspectionProposalCoverage: inspected.proposalCoverage ?? null,
      inspectionProposalTotal: inspected.proposalInspection?.total ?? 0,
      inspectionProposalInspected: inspected.proposalInspection?.inspected ?? 0,
      inspectionCheckedLeadCount: inspected.checkedLeads?.length ?? 0,
      inspectionBoundRepositoryUrl: boundLead ? repositoryUrl : null,
      inspectionBoundLeadUrl: boundLead,
      inspectionComplete: (status === 'not-onboarded'
        || status === 'known-repository-unassigned') && completeAuthority };
    if (boundLead && selectedLead
      && (status === 'known-repository-unassigned' || status === 'already-mapped')) {
      await this.selectLead(selectedLead);
    } else if (boundLead && status === 'not-onboarded' && explicitLead) {
      await this.selectLead(explicitLead);
    } else if (status === 'not-onboarded' && !this.form.leads.length) {
      await this.selectLead(repositoryUrl);
    } else if (status === 'not-onboarded' && this.form.leads.length === 1) {
      await this.selectLead(this.form.leads[0] ?? '');
    } else this.render();
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as {
      type?: unknown; field?: unknown; value?: unknown; checked?: unknown; index?: unknown
    };

    if (message?.type === 'metadataAdd') {
      this.update({ metadata: [...this.form.metadata, { key: '', value: '' }] });
      return;
    }
    if (message?.type === 'metadataRemove' && Number.isInteger(message.index)) {
      const index = message.index as number;
      this.update({ metadata: this.form.metadata.filter((_, at) => at !== index) });
      return;
    }
    if (message?.type === 'metadataField' && Number.isInteger(message.index)
      && (message.field === 'key' || message.field === 'value') && typeof message.value === 'string') {
      const index = message.index as number;
      this.form.metadata = this.form.metadata.map((entry, at) => at === index
        ? { ...entry, [message.field as 'key' | 'value']: message.value as string }
        : entry);
      return;
    }

    // Recorded without re-rendering: replacing the document on every keystroke would take the caret.
    if (message?.type === 'field' && typeof message.value === 'string') {
      const field = message.field;
      if (field === 'lead' || field === 'capabilityId' || field === 'name' || field === 'kind'
        || field === 'parent' || field === 'repositoryUrl' || field === 'jiraProject'
        || field === 'teams' || field === 'sourceRoots' || field === 'sharedRoots'
        || field === 'sparseCone' || field === 'cloneMode' || field === 'cloneFallback'
        || field === 'inspectionLeadUrl') {
        const previousRepository = this.form.repositoryUrl;
        const previousLead = this.form.lead;
        const previousInspectionLead = this.form.inspectionLeadUrl;
        // Changing which map is being edited invalidates the parents read from the last one.
        if (field === 'lead' && message.value !== this.form.lead) {
          this.form = { ...this.form, loaded: false, parents: [], parent: '' };
        }
        if (field === 'cloneMode') {
          if (message.value === 'full' || message.value === 'blobless' || message.value === 'blobless-sparse') {
            this.form.cloneMode = message.value;
          }
        } else if (field === 'cloneFallback') {
          if (message.value === 'refuse' || message.value === 'full') this.form.cloneFallback = message.value;
        } else {
          this.form[field] = message.value;
        }
        if (field === 'repositoryUrl' && message.value !== previousRepository) {
          this.invalidateInspection();
          this.mapLoadRevision++;
          this.form.loaded = false;
          this.form.parents = [];
          this.form.parent = '';
          // A lead chosen for another URL is not consent for this repository. With no registered
          // authority the URL remains the candidate first authority; otherwise inspection selects
          // an exact match or the contributor chooses after the result.
          this.form.lead = this.form.leads.length ? '' : message.value;
        }
        if (field === 'lead' && message.value !== previousLead
          && !this.form.collectionWithoutRepository && this.form.repositoryUrl.trim()) {
          this.invalidateInspection();
        }
        // The explicit authority field can be edited by a queued webview message while its prior
        // check is still running. Advancing the revision prevents that stale result from binding.
        if (field === 'inspectionLeadUrl' && message.value !== previousInspectionLead) {
          this.inspectionRevision++;
          if (this.form.inspectionStatus === 'checking') {
            this.form.inspectionStatus = 'idle';
            this.form.inspectionComplete = false;
            this.form.inspectionBoundRepositoryUrl = null;
            this.form.inspectionBoundLeadUrl = null;
          }
        }
        // When no map is registered, the first repository entered is the only possible home for
        // it. Defaulting here makes the checkbox truthful without inventing another prompt.
        if (field === 'kind' && message.value === 'collection') {
          // Choosing Collection is the explicit decision that the checked repository will not be
          // attached. Keep the chosen authority, but move the form onto the repository-free path.
          this.inspectionRevision++;
          this.form.collectionWithoutRepository = true;
          this.form.repositoryUrl = '';
          this.form.inspectionStatus = 'idle';
          this.form.inspectionComplete = true;
          this.form.inspectionMatches = [];
          this.form.inspectionPendingMatches = [];
          this.form.inspectionMessage = null;
          this.form.inspectionFailures = [];
          this.form.inspectionCompleteness = null;
          this.form.inspectionAuthorityScope = null;
          this.form.inspectionProposalCoverage = null;
          this.form.inspectionProposalTotal = 0;
          this.form.inspectionProposalInspected = 0;
          this.form.inspectionCheckedLeadCount = 0;
          this.form.inspectionBoundRepositoryUrl = null;
          this.form.inspectionBoundLeadUrl = null;
        } else if (field === 'kind' && message.value === 'delivery'
          && this.form.collectionWithoutRepository) {
          // Returning to Delivery requires a fresh repository URL and inspection.
          this.form.collectionWithoutRepository = false;
          this.form.inspectionComplete = false;
        }
      }
      return;
    }

    if (message?.type === 'redraw') return this.render();

    if (message?.type === 'chooseRepository') return void await this.chooseRepository();

    if (message?.type === 'inspectRepository') return void await this.inspectRepository();

    if (message?.type === 'searchKnownAuthorities') {
      await this.inspectRepository(null, { includeKnownAuthorities: true });
      return;
    }

    if (message?.type === 'copyCommand' && typeof message.value === 'string'
      && message.value === this.form.inspectionRecoveryCommand) {
      await vscode.env.clipboard.writeText(message.value);
      void vscode.window.showInformationMessage('Singularity Flow terminal continuation copied.');
      return;
    }

    if (message?.type === 'inspectSelectedLead') {
      const lead = this.form.inspectionLeadUrl.trim();
      if (lead) await this.inspectRepository(lead);
      return;
    }

    if (message?.type === 'inspectAuthority' && typeof message.value === 'string') {
      const lead = message.value.trim();
      const offered = this.form.inspectionStatus === 'ambiguous'
        && this.form.inspectionMatches.some((match) => match.lead?.trim() === lead);
      if (offered) await this.inspectRepository(lead);
      return;
    }

    if (message?.type === 'reuseRepository') {
      if (this.form.inspectionStatus !== 'already-mapped'
        || this.form.inspectionCompleteness !== 'complete'
        || this.form.inspectionProposalCoverage !== 'complete'
        || !this.inspectionIsBound(this.form.repositoryUrl, this.form.lead)) return;
      this.update({ inspectionComplete: true });
      return;
    }

    if (message?.type === 'attachExisting') {
      if (this.form.inspectionStatus !== 'already-mapped'
        || this.form.inspectionCompleteness !== 'complete'
        || this.form.inspectionProposalCoverage !== 'complete'
        || !this.inspectionIsBound(this.form.repositoryUrl, this.form.lead)) return;
      // Repository inspection proved this is an existing approved mapping. Workspace attachment is
      // a separate local action with its own preview and confirmation; do not turn this click into
      // another capability proposal or pass a webview-supplied URL into a mutation.
      const boundLead = this.form.inspectionBoundLeadUrl?.trim() ?? '';
      const authorityMatches = this.form.inspectionMatches.filter((match) =>
        match.lead?.trim() === boundLead
        && match.repositoryUrl?.trim() === this.form.inspectionBoundRepositoryUrl?.trim()
        && match.governed === true && match.cached !== true && match.stale !== true
        && Boolean(match.sourceBranch?.trim())
        && /^[0-9a-f]{40,64}$/i.test(match.sourceCommit?.trim() ?? ''));
      const authorityIdentities = [...new Set(authorityMatches.map((match) =>
        `${match.lead?.trim()}\n${match.sourceBranch?.trim()}\n${match.sourceCommit?.trim().toLowerCase()}`))];
      if (authorityIdentities.length !== 1 || !authorityMatches[0]) {
        this.update({
          error: 'The existing mapping is not bound to one exact, current capability authority revision. Check the repository again before attaching it to a workspace.'
        });
        return;
      }
      const authorityMatch = authorityMatches[0];
      const capabilityIds = [...new Set(authorityMatches
        .flatMap((match) => match.capabilities ?? [])
        .filter((id): id is string =>
          typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)))];
      if (!capabilityIds.length) {
        this.update({
          error: 'The approved repository mapping names no capability that can be attached. Review the capability map before opening Workspaces.'
        });
        return;
      }
      await vscode.commands.executeCommand('singularityFlow.openWorkspaces', {
        capabilityIds,
        authority: {
          leadUrl: boundLead,
          sourceBranch: authorityMatch.sourceBranch!.trim(),
          sourceCommit: authorityMatch.sourceCommit!.trim().toLowerCase()
        }
      });
      return;
    }

    if (message?.type === 'useFirstAuthority') {
      if (this.form.inspectionStatus !== 'inconclusive'
        || this.form.inspectionCompleteness !== 'no-authorities'
        || !this.form.repositoryUrl.trim()) return;
      // Confirm absence of a duplicate pending proposal on the selected first authority before the
      // form becomes writable. The URL-only discovery pass deliberately skipped proposal refs.
      await this.inspectRepository(this.form.repositoryUrl);
      return;
    }

    if (message?.type === 'toggleCollectionWithoutRepository') {
      this.inspectionRevision++;
      const enabled = !this.form.collectionWithoutRepository;
      this.update({ collectionWithoutRepository: enabled, kind: enabled ? 'collection' : 'delivery',
        repositoryUrl: enabled ? '' : this.form.repositoryUrl,
        inspectionStatus: 'idle', inspectionComplete: enabled, inspectionMatches: [], inspectionPendingMatches: [],
        inspectionMessage: null, inspectionFailures: [], inspectionCompleteness: null,
        inspectionAuthorityScope: null, inspectionProposalCoverage: null,
        inspectionProposalTotal: 0, inspectionProposalInspected: 0,
        inspectionCheckedLeadCount: 0, inspectionBoundRepositoryUrl: null,
        inspectionBoundLeadUrl: null });
      return;
    }

    if (message?.type === 'selectLead' && typeof message.value === 'string') {
      const lead = message.value.trim();
      if (!lead) {
        this.invalidateInspection();
        return void await this.selectLead('');
      }
      if (!this.form.collectionWithoutRepository && this.form.repositoryUrl.trim()
        && !this.inspectionIsBound(this.form.repositoryUrl, lead)) {
        await this.inspectRepository(lead, { includeKnownAuthorities: true });
      } else await this.selectLead(lead);
      return;
    }

    if (message?.type === 'repositoryCommitted' && typeof message.value === 'string') {
      this.render();
      return;
    }

    if (message?.type === 'useShippingRepository' && typeof message.checked === 'boolean') {
      this.invalidateInspection();
      if (message.checked) {
        if (this.form.repositoryUrl.trim()) {
          await this.inspectRepository(this.form.repositoryUrl, { includeKnownAuthorities: true });
        }
      } else {
        const fallback = this.form.leads.length === 1 ? (this.form.leads[0] ?? '') : '';
        if (fallback) await this.inspectRepository(fallback, { includeKnownAuthorities: true });
        else await this.selectLead('');
      }
      return;
    }

    // Kept as a compatibility alias for a webview that was already open when the extension was
    // updated. New renders never expose a separate Read button.
    if (message?.type === 'read') return void await this.loadSelectedMap();

    if (message?.type === 'map') {
      if (mapProblems(this.form).length || this.form.busy) return;
      this.update({ busy: true, error: null });
      const { result, error } = await this.run(mapCommand(this.form));
      if (error) return void this.update({ busy: false, error });
      // dispose() rather than panel.dispose(): closing the panel has to clear the singleton in
      // the same tick, or opening the screen again reveals the panel that was just closed.
      this.dispose();
      await this.onMapped(result as Mapped);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (BootstrapPanel.current === this) BootstrapPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

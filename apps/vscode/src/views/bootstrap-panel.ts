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
    governed?: boolean; sourceBranch?: string | null; sourceCommit?: string | null;
    cached?: boolean; stale?: boolean;
  }>;
  pendingMatches?: Array<{
    lead?: string; repositoryId?: string; repositoryUrl?: string; capabilities?: string[];
    capabilityMetadataComplete?: boolean; proposalBranch?: string; proposalCommit?: string;
    proposalStatus?: string; proposalValid?: boolean;
  }>;
  checkedLeads?: string[];
  failures?: Array<string | { lead?: string; code?: string; message?: string }>;
  authorityScope?: string;
  completeness?: string;
  proposalCoverage?: string;
  proposalInspection?: { total?: number; inspected?: number; limitPerAuthority?: number };
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
}

type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null }>;

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
  private form: MapCapabilityForm = { ...EMPTY_MAP_FORM };
  private requestedParent = '';
  private journey: StartWizardProgress | null = null;
  private mapLoadRevision = 0;
  private inspectionRevision = 0;

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
      return BootstrapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.mapCapability', initial.journey ? 'Guided start' : 'Map a capability', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    BootstrapPanel.current = new BootstrapPanel(panel, leads, run, onMapped, initial);
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
    this.form.inspectionStatus = 'idle';
    this.form.inspectionComplete = false;
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
    const { result, error } = await this.run(['capability', 'organisation', selectedLead, '--json']);
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
    const { result, error } = await this.run(argv);
    if (revision !== this.inspectionRevision || repositoryUrl !== this.form.repositoryUrl.trim()) return;
    if (error) return void this.update({ inspectionStatus: 'inconclusive', inspectionComplete: false,
      inspectionMessage: error, inspectionFailures: [], inspectionCompleteness: null,
      inspectionAuthorityScope: null, inspectionProposalCoverage: null,
      inspectionCheckedLeadCount: 0 });
    const inspected = (result ?? {}) as RepositoryInspection;
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
      return failure?.lead ? `${failure.lead}: ${message}` : message;
    });
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

    if (message?.type === 'inspectRepository') return void await this.inspectRepository();

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

    if (message?.type === 'useFirstAuthority') {
      if (this.form.inspectionStatus !== 'inconclusive'
        || this.form.inspectionCompleteness !== 'no-authorities'
        || this.form.inspectionProposalCoverage !== 'complete'
        || !this.form.repositoryUrl.trim()) return;
      this.form.inspectionComplete = true;
      this.form.inspectionBoundRepositoryUrl = this.form.repositoryUrl.trim();
      this.form.inspectionBoundLeadUrl = this.form.repositoryUrl.trim();
      await this.selectLead(this.form.repositoryUrl);
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
    BootstrapPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

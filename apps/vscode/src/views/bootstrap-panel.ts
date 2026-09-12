/**
 * The panel behind "map a capability".
 *
 * Registered and usable before any repository is open, which is the point: describing what an
 * organisation builds is not work done inside a checkout, and requiring one was the circular
 * dependency this whole screen exists to break.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  CAPABILITY_KINDS, EMPTY_MAP_FORM, gitRemoteProblem, mapCapabilityHtml, mapCommand, mapProblems,
  MAP_CAPABILITY_SCRIPT, type MapCapabilityForm, type MapCapabilityOperation, type ParentChoice
} from './map-capability-form.ts';
import type { StartWizardProgress } from './start-wizard.ts';
import { formatCliArgsForDisplay } from '../cli/runner.ts';
import {
  clearMapCapabilityOperation, LEGACY_MAP_CAPABILITY_OPERATION_KEY,
  migrateLegacyMapCapabilityOperation, readMapCapabilityOperations,
  writeMapCapabilityOperation
} from './map-capability-operation-store.ts';

interface OrganisationCapability {
  id: string;
  name: string;
  kind?: string;
  repository?: string | null;
  repositories?: string[];
  sourceRoots?: string[];
  sharedRoots?: string[];
  metadata?: Record<string, unknown>;
  jira?: { projectKey?: string | null } | null;
  teams?: string[];
  children: OrganisationCapability[];
}

interface OrganisationRepository {
  url?: string;
  clone?: {
    mode?: string;
    filter?: string | null;
    sparseCone?: string[];
    fallback?: string;
  };
}

/** The map as `capability organisation --json` reports it. */
export interface Organisation {
  governed: boolean;
  capabilities: OrganisationCapability[];
  repositories?: Record<string, OrganisationRepository>;
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

export const MAP_CAPABILITY_OPERATION_KEY = LEGACY_MAP_CAPABILITY_OPERATION_KEY;

interface CapabilityProposalSummary {
  branch?: string;
  proposalCommit?: string;
  merged?: boolean;
}

interface SavedMapRequest {
  kind: string;
  name: string | null;
  parent: string | null;
  repositoryUrl: string | null;
  sourceRoots: string[] | null;
  sharedRoots: string[] | null;
  metadata: Record<string, string>;
  jiraProject: string | null;
  teams: string[] | null;
  clone: {
    mode: string;
    filter: string | null;
    sparseCone: string[];
    fallback: string;
  } | null;
}

const MAP_SINGLE_VALUE_OPTIONS = new Set([
  '--lead', '--kind', '--name', '--parent', '--repository', '--source-roots', '--shared-roots',
  '--clone-mode', '--clone-fallback', '--sparse-cone', '--jira-project', '--teams'
]);

function normalizedList(values: string[]): string[] {
  return [...[...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()];
}

function csv(value: string | undefined): string[] {
  return normalizedList((value ?? '').split(','));
}

/** Parse only the exact option vocabulary the webview itself can persist. */
function savedMapRequest(operation: Pick<MapCapabilityOperation, 'argv' | 'capabilityId' | 'lead' | 'repositoryUrl'>): SavedMapRequest | null {
  const argv = operation.argv;
  if (argv[0] !== 'capability' || argv[1] !== 'map' || argv[2] !== operation.capabilityId) return null;
  const values = new Map<string, string[]>();
  let jsonCount = 0;
  for (let index = 3; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (option === '--json') {
      jsonCount += 1;
      continue;
    }
    if (!MAP_SINGLE_VALUE_OPTIONS.has(option) && option !== '--metadata') return null;
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) return null;
    const current = values.get(option) ?? [];
    current.push(value);
    values.set(option, current);
    index += 1;
  }
  if (jsonCount !== 1 || values.get('--lead')?.length !== 1
    || values.get('--lead')?.[0] !== operation.lead || values.get('--kind')?.length !== 1
    || !CAPABILITY_KINDS.includes(values.get('--kind')?.[0] as typeof CAPABILITY_KINDS[number])) return null;
  for (const [option, optionValues] of values) {
    if (option !== '--metadata' && optionValues.length !== 1) return null;
  }
  const repositoryValues = values.get('--repository') ?? [];
  if ((operation.repositoryUrl && (repositoryValues.length !== 1 || repositoryValues[0] !== operation.repositoryUrl))
    || (!operation.repositoryUrl && repositoryValues.length)) return null;
  const kind = values.get('--kind')![0]!;
  if ((kind === 'delivery') !== Boolean(operation.repositoryUrl)) return null;

  const cloneMode = values.get('--clone-mode')?.[0] ?? null;
  const cloneFallback = values.get('--clone-fallback')?.[0] ?? null;
  const sparseConeValue = values.get('--sparse-cone')?.[0] ?? null;
  if (cloneMode != null && !['blobless', 'blobless-sparse'].includes(cloneMode)) return null;
  if ((cloneMode == null) !== (cloneFallback == null)
    || (cloneFallback != null && !['refuse', 'full'].includes(cloneFallback))
    || (cloneMode === 'blobless-sparse') !== (sparseConeValue != null)
    || (sparseConeValue != null && csv(sparseConeValue).length === 0)) return null;

  const metadata: Record<string, string> = {};
  for (const encoded of values.get('--metadata') ?? []) {
    const separator = encoded.indexOf('=');
    if (separator < 1 || separator === encoded.length - 1) return null;
    const key = encoded.slice(0, separator).trim();
    const value = encoded.slice(separator + 1).trim();
    if (!key || !value) return null;
    metadata[key] = value;
  }
  const clone = cloneMode == null ? null : {
    mode: cloneMode,
    filter: 'blob:none',
    sparseCone: cloneMode === 'blobless-sparse'
      ? normalizedList([...csv(sparseConeValue ?? ''), '.github/agents', 'singularity']) : [],
    fallback: cloneFallback!
  };
  return {
    kind,
    name: values.get('--name')?.[0] ?? null,
    parent: values.get('--parent')?.[0] ?? null,
    repositoryUrl: repositoryValues[0] ?? null,
    sourceRoots: values.has('--source-roots') ? csv(values.get('--source-roots')?.[0]) : null,
    sharedRoots: values.has('--shared-roots') ? csv(values.get('--shared-roots')?.[0]) : null,
    metadata,
    jiraProject: values.get('--jira-project')?.[0] ?? null,
    teams: values.has('--teams') ? csv(values.get('--teams')?.[0]) : null,
    clone
  };
}

function findCapability(nodes: OrganisationCapability[], id: string, parent: string | null = null): {
  capability: OrganisationCapability;
  parent: string | null;
} | null {
  for (const capability of nodes) {
    if (capability.id === id) return { capability, parent };
    const child = findCapability(capability.children ?? [], id, capability.id);
    if (child) return child;
  }
  return null;
}

function sameRecordSubset(approved: Record<string, unknown>, requested: Record<string, string>): boolean {
  return Object.entries(requested).every(([key, value]) => approved[key] === value);
}

function normalizedApprovedClone(value: OrganisationRepository['clone']): SavedMapRequest['clone'] {
  const mode = value?.mode ?? 'full';
  return {
    mode,
    filter: value?.filter ?? (mode === 'full' ? null : 'blob:none'),
    sparseCone: normalizedList(value?.sparseCone ?? []),
    fallback: value?.fallback ?? 'refuse'
  };
}

/**
 * Prove that an approved same-ID capability is the exact logical result of the saved request.
 * Merely finding the ID is insufficient: another user may have approved a competing repository,
 * parent, kind, ownership, or clone policy while this editor was disconnected.
 */
export function compareApprovedCapability(operation: MapCapabilityOperation, organisation: Organisation): {
  status: 'absent' | 'match' | 'conflict' | 'unverifiable';
  differences: string[];
} {
  const request = savedMapRequest(operation);
  if (!request) return { status: 'unverifiable', differences: ['saved-request'] };
  const found = findCapability(organisation.capabilities, operation.capabilityId);
  if (!found) return { status: 'absent', differences: [] };
  const { capability, parent } = found;
  const differences: string[] = [];
  if (capability.kind !== request.kind) differences.push('kind');
  if (request.name != null && capability.name !== request.name) differences.push('name');
  if (request.parent != null && parent !== request.parent) differences.push('parent');
  if (request.sourceRoots != null
    && JSON.stringify(normalizedList(capability.sourceRoots ?? [])) !== JSON.stringify(request.sourceRoots)) {
    differences.push('source roots');
  }
  if (request.sharedRoots != null
    && JSON.stringify(normalizedList(capability.sharedRoots ?? [])) !== JSON.stringify(request.sharedRoots)) {
    differences.push('shared roots');
  }
  if (!sameRecordSubset(capability.metadata ?? {}, request.metadata)) differences.push('metadata');
  if (request.jiraProject != null && capability.jira?.projectKey !== request.jiraProject) {
    differences.push('Jira project');
  }
  if (request.teams != null
    && JSON.stringify(normalizedList(capability.teams ?? [])) !== JSON.stringify(request.teams)) {
    differences.push('teams');
  }

  if (request.repositoryUrl != null) {
    const repositoryIds = capability.repositories ?? (capability.repository ? [capability.repository] : []);
    if (repositoryIds.length !== 1) differences.push('repositories');
    const approvedRepository = repositoryIds.length === 1
      ? organisation.repositories?.[repositoryIds[0]!] : null;
    if (!approvedRepository?.url) {
      return { status: 'unverifiable', differences: [...new Set([...differences, 'repository'])] };
    }
    if (approvedRepository.url !== request.repositoryUrl) differences.push('repository');
    if (request.clone != null
      && JSON.stringify(normalizedApprovedClone(approvedRepository.clone)) !== JSON.stringify(request.clone)) {
      differences.push('clone policy');
    }
  }
  return differences.length
    ? { status: 'conflict', differences: [...new Set(differences)] }
    : { status: 'match', differences: [] };
}

/** Refuse malformed/tampered extension state before it can become a replayable mutation. */
export function restoreMapCapabilityOperation(value: unknown): MapCapabilityOperation | null {
  const candidate = value as Partial<MapCapabilityOperation> | null;
  const statuses = new Set([
    'running', 'cancelling', 'needs-inspection', 'inspecting',
    'retry-ready', 'proposal-ready', 'already-active'
  ]);
  if (!candidate || candidate.schemaVersion !== 1 || typeof candidate.id !== 'string'
    || !/^map_(?:[0-9a-f]{16}|[0-9a-f]{32})$/i.test(candidate.id)
    || !statuses.has(candidate.status ?? '') || typeof candidate.capabilityId !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.capabilityId)
    || typeof candidate.lead !== 'string' || gitRemoteProblem(candidate.lead, 'Capability-map repository')
    || typeof candidate.repositoryUrl !== 'string'
    || (candidate.repositoryUrl && gitRemoteProblem(candidate.repositoryUrl, 'Repository'))
    || !Array.isArray(candidate.argv) || candidate.argv.length < 6 || candidate.argv.length > 128
    || candidate.argv.some((entry) => typeof entry !== 'string' || entry.length > 8 * 1024
      || /[\u0000-\u001f\u007f-\u009f]/.test(entry))
    || candidate.argv[0] !== 'capability' || candidate.argv[1] !== 'map'
    || candidate.argv[2] !== candidate.capabilityId
    || candidate.argv[candidate.argv.indexOf('--lead') + 1] !== candidate.lead
    || !Number.isSafeInteger(candidate.attempt) || (candidate.attempt ?? 0) < 1
    || typeof candidate.startedAt !== 'string' || !Number.isFinite(Date.parse(candidate.startedAt))
    || typeof candidate.updatedAt !== 'string' || !Number.isFinite(Date.parse(candidate.updatedAt))
    || typeof candidate.message !== 'string' || candidate.message.length > 2_000) return null;
  const restored = candidate as MapCapabilityOperation;
  const leadOptions = restored.argv.flatMap((entry, index) => entry === '--lead' ? [index] : []);
  const repositoryOptions = restored.argv.flatMap((entry, index) => entry === '--repository' ? [index] : []);
  if (leadOptions.length !== 1 || restored.argv.filter((entry) => entry === '--json').length !== 1
    || (restored.repositoryUrl
      ? repositoryOptions.length !== 1
        || restored.argv[repositoryOptions[0]! + 1] !== restored.repositoryUrl
      : repositoryOptions.length !== 0)
    || !savedMapRequest(restored)) return null;
  const proposalPrefix = `sflow/config-change/capability/map-${restored.capabilityId}-`;
  const proposalBranchValid = restored.proposalBranch == null
    || (restored.proposalBranch.startsWith(proposalPrefix)
      && /^[0-9a-f]{8}$/i.test(restored.proposalBranch.slice(proposalPrefix.length)));
  const proposalCommitValid = restored.proposalCommit == null
    || /^[0-9a-f]{40,64}$/i.test(restored.proposalCommit);
  if (!proposalBranchValid || !proposalCommitValid
    || Boolean(restored.proposalBranch) !== Boolean(restored.proposalCommit)
    || (restored.status !== 'proposal-ready'
      && (restored.proposalBranch != null || restored.proposalCommit != null))
    || (restored.status === 'proposal-ready'
      && (!restored.proposalBranch || !restored.proposalCommit))) return null;
  return restored;
}

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
  private readonly context: vscode.ExtensionContext;
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
  private activeMapController: AbortController | null = null;
  private operationStorageQueue: Promise<void> = Promise.resolve();

  private constructor(
    context: vscode.ExtensionContext, panel: vscode.WebviewPanel, leads: string[], run: Run,
    onMapped: (result: Mapped) => Promise<void>,
    initial: MapCapabilityLaunch = {}
  ) {
    this.context = context;
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
    const storedOperations = readMapCapabilityOperations(context.globalState, restoreMapCapabilityOperation);
    const selected = storedOperations[0] ?? null;
    const restored = selected?.operation ?? null;
    const operation = restored && ['running', 'cancelling', 'inspecting'].includes(restored.status)
      ? {
          ...restored,
          status: 'needs-inspection' as const,
          updatedAt: new Date().toISOString(),
          message: 'The editor stopped before the remote outcome was observed. Inspect the approved map and proposal refs before retrying.'
        }
      : restored;
    if (operation && selected?.key === MAP_CAPABILITY_OPERATION_KEY) {
      // Migrate the final recovered shape in one ordered operation. Writing the legacy shape and
      // then its interrupted-state conversion as independent promises could restore stale status.
      void this.queueOperationStorage(() => migrateLegacyMapCapabilityOperation(
        context.globalState, operation, restoreMapCapabilityOperation
      )).then(undefined, () => undefined);
    } else if (operation !== restored && operation) {
      void this.queueOperationStorage(() => writeMapCapabilityOperation(
        context.globalState, operation, restoreMapCapabilityOperation
      ))
        .then(undefined, () => undefined);
    }
    this.form = {
      ...EMPTY_MAP_FORM,
      metadata: [],
      operation,
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
    BootstrapPanel.current = new BootstrapPanel(context, panel, leads, run, onMapped, initial);
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
    if (this.disposed) return;
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

  /** Preserve this panel's status order even when cancellation settles the CLI concurrently. */
  private queueOperationStorage(action: () => Promise<void>): Promise<void> {
    const result = this.operationStorageQueue.then(action, action);
    this.operationStorageQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async storeOperation(operation: MapCapabilityOperation | null): Promise<void> {
    const previous = this.form.operation;
    this.form = { ...this.form, operation };
    this.render();
    if (operation) {
      await this.queueOperationStorage(() => writeMapCapabilityOperation(
        this.context.globalState, operation, restoreMapCapabilityOperation
      ));
    } else if (previous) {
      await this.queueOperationStorage(async () => {
        await clearMapCapabilityOperation(
          this.context.globalState, previous.id, restoreMapCapabilityOperation
        );
      });
    }
  }

  private newOperation(argv: string[]): MapCapabilityOperation {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      // Random identity, rather than argv + millisecond time, prevents two extension-host
      // processes starting the same request in the same millisecond from sharing a receipt key.
      id: `map_${randomBytes(16).toString('hex')}`,
      status: 'running',
      capabilityId: this.form.capabilityId.trim(),
      lead: this.form.lead.trim(),
      repositoryUrl: this.form.repositoryUrl.trim(),
      argv: [...argv],
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      message: 'Preparing and publishing one exact capability review proposal.'
    };
  }

  private async finishOperation(operation: MapCapabilityOperation, mapped: Mapped): Promise<void> {
    await this.storeOperation({
      ...operation,
      status: mapped.reviewRequired && mapped.branch ? 'proposal-ready' : 'already-active',
      updatedAt: new Date().toISOString(),
      message: mapped.reviewRequired && mapped.branch
        ? 'The proposal was published. Opening its exact review now.'
        : 'The exact capability mapping is already present in approved configuration.',
      proposalBranch: mapped.reviewRequired ? mapped.branch : null,
      proposalCommit: mapped.reviewRequired ? mapped.commit : null
    });
    this.dispose();
    await this.onMapped(mapped);
    await this.queueOperationStorage(async () => {
      await clearMapCapabilityOperation(
        this.context.globalState, operation.id, restoreMapCapabilityOperation
      );
    });
  }

  private async runMapOperation(operation: MapCapabilityOperation): Promise<void> {
    const controller = new AbortController();
    this.activeMapController = controller;
    await this.storeOperation({
      ...operation,
      status: 'running',
      updatedAt: new Date().toISOString(),
      message: 'Preparing and publishing one exact capability review proposal.'
    });
    this.update({ busy: true, error: null });
    const { result, error } = await this.run(operation.argv, controller.signal);
    if (this.activeMapController === controller) this.activeMapController = null;
    if (error) {
      const cancelled = controller.signal.aborted;
      await this.storeOperation({
        ...(this.form.operation ?? operation),
        status: 'needs-inspection',
        updatedAt: new Date().toISOString(),
        message: cancelled
          ? 'Cancelled after the CLI process tree stopped. The remote outcome is intentionally unknown until inspected.'
          : `The command did not return a confirmed outcome: ${error}`
      });
      this.update({ busy: false, error: null });
      return;
    }
    await this.finishOperation(this.form.operation ?? operation, result as Mapped);
  }

  private async inspectMapOperation(retryWhenAbsent = false): Promise<void> {
    const operation = this.form.operation;
    if (!operation || !['needs-inspection', 'retry-ready'].includes(operation.status)) return;
    const controller = new AbortController();
    this.activeMapController = controller;
    await this.storeOperation({ ...operation, status: 'inspecting', updatedAt: new Date().toISOString(),
      message: 'Reading the approved capability map and pending proposal refs. No mutation is running.' });
    this.update({ busy: true, error: null });
    const proposalsRead = await this.run([
      'capability', 'proposals', '--lead', operation.lead, '--json'
    ], controller.signal);
    if (proposalsRead.error || controller.signal.aborted) {
      if (this.activeMapController === controller) this.activeMapController = null;
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'needs-inspection',
        updatedAt: new Date().toISOString(),
        message: controller.signal.aborted
          ? 'Inspection was cancelled. Inspect the remote outcome before retrying.'
          : `The pending proposal namespace could not be inspected: ${proposalsRead.error}` });
      this.update({ busy: false });
      return;
    }
    const proposalsPayload = (proposalsRead.result as { proposals?: unknown } | null)?.proposals;
    if (!Array.isArray(proposalsPayload)) {
      if (this.activeMapController === controller) this.activeMapController = null;
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'needs-inspection',
        updatedAt: new Date().toISOString(),
        message: 'The CLI returned an incompatible proposal-list result. Update or repair the bundled CLI before retrying.' });
      this.update({ busy: false });
      return;
    }
    const proposals = proposalsPayload as CapabilityProposalSummary[];
    const prefix = `sflow/config-change/capability/map-${operation.capabilityId}-`;
    const existing = proposals.find((proposal) => proposal.merged !== true
      && proposal.branch?.startsWith(prefix)
      && /^[0-9a-f]{8}$/i.test(proposal.branch.slice(prefix.length))
      && Boolean(proposal.proposalCommit));
    if (existing?.branch && existing.proposalCommit) {
      if (this.activeMapController === controller) this.activeMapController = null;
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'proposal-ready',
        updatedAt: new Date().toISOString(),
        message: 'The existing remote proposal was found. Open that exact review; no duplicate was created.',
        proposalBranch: existing.branch, proposalCommit: existing.proposalCommit });
      this.update({ busy: false });
      return;
    }
    const approvedRead = await this.run([
      'capability', 'organisation', operation.lead, '--refresh', '--json'
    ], controller.signal);
    if (this.activeMapController === controller) this.activeMapController = null;
    if (approvedRead.error || controller.signal.aborted) {
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'needs-inspection',
        updatedAt: new Date().toISOString(),
        message: controller.signal.aborted
          ? 'Inspection was cancelled. Inspect the remote outcome before retrying.'
          : `Pending proposals were readable, but approved configuration was not: ${approvedRead.error}` });
      this.update({ busy: false });
      return;
    }
    const organisation = approvedRead.result as Organisation | null;
    if (!organisation || !Array.isArray(organisation.capabilities)) {
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'needs-inspection',
        updatedAt: new Date().toISOString(),
        message: 'The CLI returned an incompatible approved-map result. Update or repair the bundled CLI before retrying.' });
      this.update({ busy: false });
      return;
    }
    const approved = compareApprovedCapability(this.form.operation ?? operation, organisation);
    if (approved.status === 'match') {
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'already-active',
        updatedAt: new Date().toISOString(),
        message: 'The approved capability matches the exact saved request. No retry is needed.' });
      this.update({ busy: false });
      return;
    }
    if (approved.status === 'conflict' || approved.status === 'unverifiable') {
      const fields = approved.differences.join(', ');
      await this.storeOperation({ ...(this.form.operation ?? operation), status: 'needs-inspection',
        updatedAt: new Date().toISOString(),
        message: approved.status === 'conflict'
          ? `The approved capability uses different saved-request attributes (${fields}). Review the approved map; this request will not be retried or cleared automatically.`
          : `The approved same-ID capability could not be tied to the saved request (${fields}). Review the approved map; this request will not be retried or cleared automatically.` });
      this.update({ busy: false });
      return;
    }
    const retryReady = { ...(this.form.operation ?? operation), status: 'retry-ready' as const,
      updatedAt: new Date().toISOString(),
      message: 'No approved capability or pending same-ID proposal exists. The exact saved request is safe to retry.' };
    await this.storeOperation(retryReady);
    this.update({ busy: false });
    if (retryWhenAbsent) {
      await this.runMapOperation({ ...retryReady, attempt: retryReady.attempt + 1 });
    }
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
    // A sole known authority at this exact repository URL is already an unambiguous, bounded
    // choice supplied by the workspace bootstrap. Inspect it immediately so a first capability
    // map does not stall behind a second button press. A different or one of several authorities
    // still requires an explicit selection or the separately consented --search-known traversal.
    const soleKnownLead = this.form.leads.length === 1 ? this.form.leads[0]?.trim() : null;
    const explicitLead = explicitLeadUrl?.trim()
      || (soleKnownLead === repositoryUrl ? soleKnownLead : null)
      || null;
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
    // Resolve the portable state link first. Reading several machine-local authorities can fan out
    // to several remotes, so it remains a separate, explicit action. A sole known authority above
    // is safe to inspect directly and avoids a circular first-map onboarding flow.
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

    if (message?.type === 'cancelMapOperation') {
      const operation = this.form.operation;
      if (!operation || !this.activeMapController
        || !['running', 'inspecting'].includes(operation.status)) return;
      const cancelling: MapCapabilityOperation = {
        ...operation, status: 'cancelling', updatedAt: new Date().toISOString(),
        message: 'Stopping the CLI process tree before reporting the outcome…' };
      this.form.operation = cancelling;
      this.render();
      this.activeMapController.abort();
      void this.queueOperationStorage(() => writeMapCapabilityOperation(
        this.context.globalState, cancelling, restoreMapCapabilityOperation
      ))
        .then(undefined, () => undefined);
      return;
    }

    if (message?.type === 'inspectMapOperation') {
      await this.inspectMapOperation(false);
      return;
    }

    if (message?.type === 'retryMapOperation') {
      // Re-inspect immediately before replay. The engine also re-observes at its mutation boundary,
      // so a proposal created in the remaining race is reported rather than duplicated.
      await this.inspectMapOperation(true);
      return;
    }

    if (message?.type === 'reviewMapOperation') {
      const operation = this.form.operation;
      if (!operation || operation.status !== 'proposal-ready' || !operation.proposalBranch
        || !operation.proposalCommit || !/^[0-9a-f]{40,64}$/i.test(operation.proposalCommit)) return;
      const mapped: Mapped = {
        capabilityId: operation.capabilityId,
        repositoryId: null,
        lead: operation.lead,
        branch: operation.proposalBranch,
        baseBranch: 'sflow/config',
        commit: operation.proposalCommit,
        reviewRequired: true
      };
      this.dispose();
      await this.onMapped(mapped);
      await this.queueOperationStorage(async () => {
        await clearMapCapabilityOperation(
          this.context.globalState, operation.id, restoreMapCapabilityOperation
        );
      });
      return;
    }

    if (message?.type === 'clearMapOperation') {
      if (this.form.operation?.status !== 'already-active') return;
      await this.storeOperation(null);
      return;
    }

    if (message?.type === 'map') {
      if (mapProblems(this.form).length || this.form.busy) return;
      const operation = this.newOperation(mapCommand(this.form));
      try {
        // Refuse to begin the remote mutation unless its recovery identity is durable first.
        await this.storeOperation(operation);
      } catch (error) {
        this.form.operation = null;
        this.update({ busy: false,
          error: `The mapping operation could not be saved before it started: ${(error as Error).message}` });
        return;
      }
      await this.runMapOperation(operation);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.activeMapController && !this.activeMapController.signal.aborted) {
      const operation = this.form.operation;
      if (operation && (operation.status === 'running' || operation.status === 'inspecting')) {
        const cancelling: MapCapabilityOperation = {
          ...operation,
          status: 'cancelling',
          updatedAt: new Date().toISOString(),
          message: 'The panel closed while this operation was active. Stopping it before remote outcome inspection.',
        };
        this.form = { ...this.form, operation: cancelling };
        void this.queueOperationStorage(() => writeMapCapabilityOperation(
          this.context.globalState, cancelling, restoreMapCapabilityOperation
        ))
          .then(undefined, () => undefined);
      }
      this.activeMapController.abort();
    }
    if (BootstrapPanel.current === this) BootstrapPanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

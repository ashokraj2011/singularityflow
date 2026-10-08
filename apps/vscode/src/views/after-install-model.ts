/** A scoped, plan-first post-install journey. No Story, checkout or capability is recreated. */
import type { ProductSurfaceStatus } from '../product-alignment.ts';
import {
  isSafeWorkspaceReinitializationPreview,
  type WorkspaceConfigurationRefreshResult, type WorkspaceEntry, type WorkspaceStatus
} from './workspaces-model.ts';
import type { ReviewConfirmationRequest } from './review-confirmation-page.ts';

export interface AfterInstallHost {
  run<T>(argv: string[]): Promise<T>;
  confirm(request: ReviewConfirmationRequest): Promise<boolean>;
  extensionPath: string;
  configurationChanged(): Promise<void>;
}

export interface AfterInstallReference {
  id: string;
  path: string;
  status: 'refreshed' | 'already-attached' | 'deferred' | 'attention';
  reason?: string;
}

export interface AfterInstallView {
  workspaces: WorkspaceEntry[];
  product: ProductSurfaceStatus | null;
  productError: string | null;
  selected: string | null;
  workspace: WorkspaceStatus | null;
  upgrade: WorkspaceConfigurationRefreshResult | null;
  references: AfterInstallReference[] | null;
  verified: WorkspaceStatus | null;
  busy: string | null;
  error: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const envelope = value as { data?: unknown };
  return envelope.data ?? value;
}

export function productStatus(value: unknown): ProductSurfaceStatus {
  const status = payload(value) as ProductSurfaceStatus | null;
  if (!status || !['aligned', 'repairable', 'split', 'no-receipt', 'receipt-invalid'].includes(status.verdict)
    || !Array.isArray(status.surfaces) || status.surfaces.some(surface =>
      !surface || !['cli', 'vscode', 'copilot'].includes(surface.id) || typeof surface.state !== 'string')
    || (['aligned', 'repairable', 'split'].includes(status.verdict)
      && (status.surfaces.length !== 3 || new Set(status.surfaces.map(surface => surface.id)).size !== 3))
    || !Array.isArray(status.next) || status.next.some(next =>
      !next || typeof next.command !== 'string' || typeof next.reason !== 'string')) {
    throw new Error('The installed build check returned no verifiable product status. Reinstall the matching package and reload VS Code.');
  }
  return status;
}

function workspaceStatus(value: WorkspaceStatus, selected: string): WorkspaceStatus {
  if (!value || value.workspace?.path !== selected || !Array.isArray(value.repositories)
    || typeof value.workspace.id !== 'string' || !value.workspace.id
    || typeof value.workspace.name !== 'string' || typeof value.healthy !== 'boolean'
    || !value.repositories.length || value.repositories.some(repository =>
      !repository || typeof repository.id !== 'string' || !repository.id
      || typeof repository.state !== 'string')
    || new Set(value.repositories.map(repository => repository.id)).size !== value.repositories.length) {
    throw new Error('The workspace check did not return the exact selected workspace and its repositories.');
  }
  return value;
}

/** Older/malformed CLI output is a visible recovery condition, never a broken webview. */
function upgradeStatus(value: WorkspaceConfigurationRefreshResult): WorkspaceConfigurationRefreshResult {
  const stringList = (items: unknown): boolean => Array.isArray(items)
    && items.every(item => typeof item === 'string');
  const cutover = value?.storyCutover;
  const invalidCutover = cutover !== undefined && (!cutover || cutover.requested !== true
    || cutover.mode !== 'hard' || cutover.historicalBytes !== 'preserved'
    || !['planned', 'retired', 'incomplete'].includes(cutover.status)
    || typeof cutover.statement !== 'string' || !Array.isArray(cutover.repositories)
    || cutover.repositories.some(item => !item || typeof item.repository !== 'string'
      || (item.retiredIds !== undefined && !stringList(item.retiredIds))));
  if (!value || value.resultType !== 'workspace-reinitialization' || typeof value.dryRun !== 'boolean'
    || !['preview', 'complete', 'partial', 'blocked'].includes(value.status)
    || !Number.isSafeInteger(value.total) || value.total < 0
    || !Number.isSafeInteger(value.updated) || value.updated < 0
    || invalidCutover || !Array.isArray(value.results) || value.results.some(repository =>
      !repository || typeof repository.repository !== 'string' || typeof repository.status !== 'string'
      || (repository.files !== undefined && (!Array.isArray(repository.files)
        || repository.files.some(file => typeof file !== 'string')))
      || (repository.conflicts !== undefined && (!Array.isArray(repository.conflicts)
        || repository.conflicts.some(conflict => !conflict || typeof conflict.path !== 'string')))
      || (repository.memberships !== undefined && (!Array.isArray(repository.memberships)
        || repository.memberships.some(member => !member || typeof member.workspaceId !== 'string'
          || typeof member.repositoryId !== 'string'))))) {
    throw new Error('The CLI returned an unverifiable upgrade result. Recheck the installed build and preview again; no completion was recorded.');
  }
  return value;
}

function topology(status: WorkspaceStatus): string {
  return JSON.stringify(status.repositories.map(repository => ({
    id: repository.id, path: repository.absolutePath ?? repository.path,
    url: repository.url, state: repository.state
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

export function safeUpgradeComplete(result: WorkspaceConfigurationRefreshResult | null): boolean {
  return Boolean(result && result.resultType === 'workspace-reinitialization'
    && result.dryRun === false && result.status === 'complete' && result.total > 0
    && Array.isArray(result.results) && result.results.length === result.total && !result.failed
    && result.results.every(repository => ['current', 'updated'].includes(repository.status))
    && (!result.storyCutover || verifiedStoryCutover(result, 'retired'))
    && !result.topologyIssues?.length
    && !result.schemaCensuses?.some(census => census.healthy === false || census.truncated)
    && result.capabilityPortability?.changed === false);
}

export function verifiedStoryCutover(result: WorkspaceConfigurationRefreshResult, status: 'planned' | 'retired'): boolean {
  const cutover = result.storyCutover;
  return Boolean(cutover?.requested === true && cutover.mode === 'hard' && cutover.status === status
    && cutover.historicalBytes === 'preserved' && Array.isArray(cutover.repositories)
    && cutover.repositories.length === result.total && new Set(cutover.repositories.map(item => item.repository)).size === result.total
    && cutover.repositories.every(item => item.requested === true && item.mode === 'hard'
      && Array.isArray(item.retiredIds) && item.retiredIds.every(id => typeof id === 'string')
      && result.results.some(entry => entry.repository === item.repository)));
}

export function afterInstallComplete(view: AfterInstallView): boolean {
  return view.product?.verdict === 'aligned' && safeUpgradeComplete(view.upgrade)
    && view.verified?.workspace.path === view.selected && view.verified.healthy === true
    && Boolean(view.references?.length) && view.references!.every(reference =>
      reference.status === 'refreshed' || reference.status === 'already-attached');
}

const UPGRADE_REVIEW = 'Review the exact upgrade plan…';
const CUTOVER_REVIEW = 'Review the hard cutover…';

/** Host-owned revision leases expire on scope/build changes, disposal and overlapping requests. */
export class AfterInstallJourney {
  view: AfterInstallView = {
    workspaces: [], product: null, productError: null, selected: null, workspace: null,
    upgrade: null, references: null, verified: null, busy: null, error: null
  };
  private revision = 0;
  private disposed = false;
  private readonly host: AfterInstallHost;
  private readonly render: () => void;

  constructor(host: AfterInstallHost, render: () => void) {
    this.host = host;
    this.render = render;
  }

  dispose(): void { this.disposed = true; this.revision++; }

  private current(revision: number): boolean { return !this.disposed && revision === this.revision; }

  private begin(busy: string): number {
    this.view.busy = busy;
    this.view.error = null;
    this.render();
    return ++this.revision;
  }

  private finish(revision: number): void {
    if (!this.current(revision)) return;
    this.view.busy = null;
    this.render();
  }

  private args(tail: string[]): string[] {
    if (!this.view.selected) throw new Error('Choose an existing workspace first.');
    return ['workspace', 'reinitialize', this.view.selected, ...tail, '--json'];
  }

  async load(): Promise<void> {
    if (this.view.busy) return;
    const revision = this.begin('Checking installed build and saved workspaces…');
    this.view.upgrade = null;
    this.view.references = null;
    this.view.verified = null;
    this.view.product = null;
    this.view.productError = null;
    const [product, workspaces] = await Promise.allSettled([
      this.host.run<unknown>(['product', 'status', '--extension-path', this.host.extensionPath, '--json']),
      this.host.run<WorkspaceEntry[]>(['workspace', 'list', '--json'])
    ]);
    if (!this.current(revision)) return;
    try {
      if (product.status === 'rejected') throw product.reason;
      this.view.product = productStatus(product.value);
    } catch (error) { this.view.productError = message(error); }
    if (workspaces.status === 'rejected') {
      this.view.error = message(workspaces.reason);
      this.view.workspaces = [];
      this.view.selected = null;
      this.view.workspace = null;
    } else if (!Array.isArray(workspaces.value) || workspaces.value.some(entry =>
      !entry || typeof entry.path !== 'string' || !entry.path || typeof entry.id !== 'string')) {
      this.view.error = 'The workspace registry could not be verified. Open workspace diagnostics; do not recreate it.';
      this.view.workspaces = [];
      this.view.selected = null;
      this.view.workspace = null;
    } else {
      this.view.workspaces = workspaces.value.filter(entry => !entry.archivedAt);
      if (!this.view.workspaces.some(entry => entry.path === this.view.selected)) {
        this.view.selected = null;
        this.view.workspace = null;
      }
    }
    this.finish(revision);
  }

  async select(selected: string): Promise<void> {
    // Scope changes invalidate an open confirmation, but cannot start beside an executing write.
    if (this.view.busy && ![UPGRADE_REVIEW, CUTOVER_REVIEW].includes(this.view.busy)) return;
    if (!this.view.workspaces.some(entry => entry.path === selected && !entry.archivedAt)) return;
    const revision = this.begin('Reading this workspace…');
    this.view.selected = selected;
    this.view.workspace = null;
    this.view.upgrade = null;
    this.view.references = null;
    this.view.verified = null;
    try {
      const status = await this.host.run<WorkspaceStatus>(['workspace', 'status', selected, '--level', 'readiness', '--json']);
      if (this.current(revision)) this.view.workspace = workspaceStatus(status, selected);
    } catch (error) { if (this.current(revision)) this.view.error = message(error); }
    this.finish(revision);
  }

  async align(): Promise<void> {
    if (this.view.busy || this.view.product?.verdict !== 'repairable') return;
    const revision = this.begin('Review installed-build alignment…');
    const reviewed = JSON.stringify(this.view.product);
    try {
      const accepted = await this.host.confirm({
        title: 'Align SFlow to the installed build',
        summary: 'Use only the verified build retained by this machine’s installer.',
        detail: 'This can replace lagging CLI, extension and Copilot surfaces. It does not upgrade repositories or Stories. Reload VS Code afterward.\n\n'
          + this.view.product.surfaces.map(surface => `${surface.id}: ${surface.state}`).join('\n'),
        confirmLabel: 'Align installed surfaces', expected: 'ALIGN'
      });
      if (!accepted || !this.current(revision) || JSON.stringify(this.view.product) !== reviewed) return;
      await this.host.run(['product', 'align', '--extension-path', this.host.extensionPath, '--json']);
      if (this.current(revision)) {
        this.view.product = null;
        this.view.upgrade = null;
        this.view.references = null;
        this.view.verified = null;
        this.view.productError = 'Alignment was requested. Reload VS Code, then reopen After install to verify the loaded build.';
      }
    } catch (error) { if (this.current(revision)) this.view.productError = message(error); }
    finally { this.finish(revision); }
  }

  async preview(): Promise<void> {
    if (this.view.busy || !this.view.workspace || this.view.product?.verdict !== 'aligned') return;
    const revision = this.begin('Previewing the safe repository upgrade…');
    this.view.upgrade = null;
    this.view.references = null;
    this.view.verified = null;
    try {
      const result = upgradeStatus(await this.host.run<WorkspaceConfigurationRefreshResult>(this.args(['--dry-run'])));
      if (this.current(revision)) this.view.upgrade = result;
    } catch (error) { if (this.current(revision)) this.view.error = message(error); }
    this.finish(revision);
  }

  async apply(): Promise<void> {
    const reviewed = this.view.upgrade;
    if (this.view.busy || this.view.product?.verdict !== 'aligned'
      || !this.view.workspace || !isSafeWorkspaceReinitializationPreview(reviewed)
      || reviewed.total < 1 || reviewed.results.length !== reviewed.total) return;
    const selected = this.view.selected!;
    const planId = reviewed.planId;
    const binding = JSON.stringify(reviewed);
    const argv = this.args([
      ...(reviewed.storyCutover?.requested ? ['--hard-cutover'] : []),
      '--confirm-plan', planId
    ]);
    const revision = this.begin(UPGRADE_REVIEW);
    try {
      const accepted = await this.host.confirm({
        title: reviewed.storyCutover?.requested ? 'Hard cutover: discontinue existing Stories' : 'Apply the safe after-install upgrade',
        summary: `${reviewed.total} repositories in ${this.view.workspace.workspace.name}.`,
        detail: 'Update framework-owned assets on sflow/config and its state mirror. Preserve custom content, workspace mappings, application code and Story history.\n\n'
          + (reviewed.storyCutover?.requested ? 'These Stories will become read-only and cannot continue; use new IDs:\n'
            + reviewed.storyCutover.repositories.map(item => `${item.repository}: ${(item.retiredIds ?? []).join(', ') || 'none'}`).join('\n') + '\n\n' : '')
          + reviewed.results.map(repository => `${repository.repository}: ${repository.status}\n`
            + (repository.files ?? []).join('\n')).join('\n\n'),
        confirmLabel: 'Apply reviewed upgrade', expected: planId
      });
      if (!accepted || !this.current(revision) || this.view.selected !== selected
        || this.view.upgrade !== reviewed || JSON.stringify(reviewed) !== binding
        || !isSafeWorkspaceReinitializationPreview(reviewed)) return;
      this.view.busy = 'Applying the reviewed repository upgrade…';
      // Consume this UI authorization before the write. An ambiguous failure needs a new preview,
      // never a second click on an old exact-plan authorization.
      this.view.upgrade = null;
      this.render();
      // The engine re-observes config/state refs, schema compatibility and workspace topology.
      const result = upgradeStatus(await this.host.run<WorkspaceConfigurationRefreshResult>(argv));
      if (!this.current(revision)) return;
      this.view.upgrade = result;
      this.view.references = null;
      this.view.verified = null;
      if (result.updated > 0 || safeUpgradeComplete(result)) await this.host.configurationChanged();
    } catch (error) { if (this.current(revision)) this.view.error = message(error); }
    finally { this.finish(revision); }
  }

  /**
   * One launch, one exact confirmation: retire the listed pilot Stories, upgrade approved
   * configuration, refresh each checkout to its exact published commit, then verify.
   */
  async cutover(): Promise<void> {
    if (this.view.busy || !this.view.workspace || this.view.product?.verdict !== 'aligned') return;
    const selected = this.view.selected!;
    const reviewedTopology = topology(this.view.workspace);
    const revision = this.begin('Previewing the hard cutover…');
    this.view.upgrade = null;
    this.view.references = null;
    this.view.verified = null;
    try {
      const reviewed = upgradeStatus(await this.host.run<WorkspaceConfigurationRefreshResult>(
        this.args(['--hard-cutover', '--dry-run'])
      ));
      if (!this.current(revision)) return;
      this.view.upgrade = reviewed;
      if (!isSafeWorkspaceReinitializationPreview(reviewed) || reviewed.total < 1
        || reviewed.results.length !== reviewed.total || !verifiedStoryCutover(reviewed, 'planned')) {
        throw new Error('Hard cutover preview needs attention. Resolve the reported configuration or schema issue, then run the cutover again. An older CLI may need the matching installed build.');
      }
      const binding = JSON.stringify(reviewed);
      const argv = this.args(['--hard-cutover', '--confirm-plan', reviewed.planId]);
      this.view.busy = CUTOVER_REVIEW;
      this.render();
      const accepted = await this.host.confirm({
        title: 'Hard cutover: discontinue existing Stories',
        summary: `${this.view.workspace!.workspace.name} · ${reviewed.total} repositories`,
        detail: 'Existing Stories listed below will become read-only and cannot continue. Their files, approvals and branches are preserved. Start new Stories with new IDs.\n\nStories to discontinue:\n'
          + reviewed.storyCutover!.repositories.map(item => `${item.repository}: ${(item.retiredIds ?? []).join(', ') || 'none'}`).join('\n') + '\n\n'
          + 'Upgrade framework seeds on sflow/config, mirror them to state, and refresh existing checkout authority pins. Custom code, capability routing, historical artifacts and Story files are preserved. No tests, source pull, clone or model call.\n\n'
          + reviewed.results.map(repository => `${repository.repository}: ${repository.status}\n`
            + (repository.files ?? []).join('\n')).join('\n\n')
          + '\n\nLocal references:\n' + this.view.workspace!.repositories.map(repository =>
            `${repository.id}: ${repository.absolutePath ?? repository.path ?? 'path unavailable'}`
          ).join('\n'),
        confirmLabel: 'Discontinue Stories and upgrade', expected: reviewed.planId
      });
      if (!accepted || !this.current(revision) || this.view.selected !== selected
        || this.view.upgrade !== reviewed || JSON.stringify(reviewed) !== binding) return;
      const currentWorkspace = workspaceStatus(await this.host.run<WorkspaceStatus>([
        'workspace', 'status', selected, '--level', 'readiness', '--json'
      ]), selected);
      if (!this.current(revision)) return;
      if (topology(currentWorkspace) !== reviewedTopology) throw new Error('Workspace membership changed after review. Run the cutover again for a fresh preview.');
      this.view.upgrade = null; // consume authorization before any publication
      this.view.busy = 'Applying the reviewed hard cutover…';
      this.render();
      const result = upgradeStatus(await this.host.run<WorkspaceConfigurationRefreshResult>(argv));
      if (!this.current(revision)) return;
      this.view.upgrade = result;
      if (result.updated > 0 || safeUpgradeComplete(result)) await this.host.configurationChanged();
      if (!this.current(revision)) return;
      if (!safeUpgradeComplete(result) || !verifiedStoryCutover(result, 'retired')) {
        throw new Error('Hard cutover is not fully verified. Completed publications are preserved; resolve the reported issue and run the cutover again to resume.');
      }
      await this.refreshVerifiedReferences(selected, reviewedTopology, revision, result);
    } catch (error) { if (this.current(revision)) this.view.error = message(error); }
    finally { this.finish(revision); }
  }

  async refreshReferences(): Promise<void> {
    if (this.view.busy || this.view.product?.verdict !== 'aligned'
      || !safeUpgradeComplete(this.view.upgrade) || !this.view.workspace) return;
    const selected = this.view.selected!;
    // A hard cutover published an exact configuration commit per checkout. A retried refresh stays
    // bound to it instead of following whatever authority happens to be current.
    const bound = this.view.upgrade!.storyCutover?.requested ? this.view.upgrade : null;
    const reviewedTopology = topology(this.view.workspace);
    const revision = this.begin('Review workspace reference refresh…');
    this.view.references = null;
    this.view.verified = null;
    try {
      const accepted = await this.host.confirm({
        title: 'Refresh this workspace’s configuration references',
        summary: this.view.workspace.workspace.name,
        detail: (bound ? 'Refresh only to each checkout’s exact cutover configuration commit. If authority moved, run the cutover again for a fresh preview. '
          : 'Update only each existing checkout’s previously selected authority pin. ')
          + 'No pull, checkout, clone, source scan, tests or Story changes. Missing/deferred checkouts remain untouched.\n\n'
          + this.view.workspace.repositories.map(repository => `${repository.id}: ${repository.absolutePath ?? repository.path ?? 'path unavailable'}`).join('\n'),
        confirmLabel: 'Refresh and verify workspace', expected: this.view.workspace.workspace.id
      });
      if (!accepted || !this.current(revision)) return;
      await this.refreshVerifiedReferences(selected, reviewedTopology, revision, bound);
    } catch (error) { if (this.current(revision)) this.view.error = message(error); }
    finally { this.finish(revision); }
  }

  private async refreshVerifiedReferences(selected: string, reviewedTopology: string, revision: number,
    bound: WorkspaceConfigurationRefreshResult | null = null): Promise<void> {
      const status = workspaceStatus(await this.host.run<WorkspaceStatus>([
        'workspace', 'status', selected, '--level', 'readiness', '--json'
      ]), selected);
      if (!this.current(revision)) return;
      if (topology(status) !== reviewedTopology) throw new Error('Workspace repositories changed during review. Select it again and create a fresh upgrade preview.');
      const references: AfterInstallReference[] = [];
      this.view.busy = 'Refreshing local references and verifying the workspace…';
      this.render();
      for (const repository of status.repositories) {
        if (!this.current(revision)) return;
        const root = repository.absolutePath ?? repository.path ?? '';
        if (['missing', 'empty', 'planned', 'deferred'].includes(repository.state ?? '')) {
          references.push({ id: repository.id, path: root, status: 'deferred', reason: 'No local checkout; not cloned or changed.' });
          continue;
        }
        if (repository.state !== 'ready' || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(root)) {
          references.push({ id: repository.id, path: root, status: 'attention', reason: 'Checkout or absolute repository path needs workspace repair.' });
          continue;
        }
        try {
          const published = bound?.results.filter(entry => entry.memberships
            ? entry.memberships.some(member => member.workspaceId === status.workspace.id && member.repositoryId === repository.id)
            : entry.repository === repository.id) ?? [];
          const expected = published.length === 1 ? published[0]?.configurationCommit : null;
          if (bound && (!expected || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expected))) {
            throw new Error('No exact cutover configuration commit is bound to this checkout. Run the cutover again for a fresh verified result.');
          }
          const raw = payload(await this.host.run<unknown>([
            'authority', 'refresh', root,
            ...(expected ? ['--expected-config-commit', expected, '--attach-if-missing'] : []), '--json'
          ])) as { result?: { status?: string; descriptor?: { authority?: { sourceCommit?: string } } } };
          const result = raw?.result ?? raw as { status?: string; descriptor?: { authority?: { sourceCommit?: string } } };
          if (!['refreshed', 'already-attached'].includes(result?.status ?? '')) throw new Error('Authority refresh did not verify a current pin. Open workspace maintenance to verify and attach this checkout.');
          if (expected && result.descriptor?.authority?.sourceCommit !== expected) {
            throw new Error('The refreshed checkout pin does not match its cutover configuration. Run the cutover again; completion is not verified.');
          }
          references.push({ id: repository.id, path: root, status: result.status as AfterInstallReference['status'] });
        } catch (error) { references.push({ id: repository.id, path: root, status: 'attention', reason: message(error) }); }
      }
      if (!this.current(revision)) return;
      this.view.references = references;
      const verified = workspaceStatus(await this.host.run<WorkspaceStatus>([
        'workspace', 'status', selected, '--level', 'readiness', '--json'
      ]), selected);
      const product = productStatus(await this.host.run<unknown>([
        'product', 'status', '--extension-path', this.host.extensionPath, '--json'
      ]));
      if (!this.current(revision)) return;
      if (topology(verified) !== topology(status)) throw new Error('Workspace membership moved during refresh. Recheck the selected workspace; completion has not been verified.');
      this.view.verified = verified;
      this.view.product = product;
      await this.host.configurationChanged();
  }
}

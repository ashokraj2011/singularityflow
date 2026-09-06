/** Read-only CMP review surface over one explicitly leased comprehension snapshot slice. */
import path from 'node:path';
import * as vscode from 'vscode';
import type { ComprehensionIdeSnapshot, ComprehensionRegion } from '../cli/snapshot.ts';
import {
  DEFAULT_COMPREHENSION_SLICE_LEASE_MS, type SliceLease, type WorkspaceStore
} from '../state.ts';
import { enumField, registerMessageRouter, stringField } from './messages.ts';
import { contentSecurityPolicy, escape, icon, nonce, page } from './webview.ts';

type Tab = 'regions' | 'causes' | 'walkthrough' | 'replay' | 'unknowns';

function shortDigest(value: unknown): string {
  const digest = String(value ?? '');
  return /^sha256:[a-f0-9]{64}$/u.test(digest) ? `${digest.slice(0, 19)}…` : 'unavailable';
}

function regionPath(region: ComprehensionRegion): string {
  return region.location.pathAfter ?? region.location.pathBefore ?? 'unknown';
}

function regions(snapshot: ComprehensionIdeSnapshot): string {
  if (!snapshot.manifest.regions.length) {
    return '<div class="empty"><p>No repository changes exist in the selected interval.</p></div>';
  }
  return `<section><h2>Exact change regions</h2><p class="meta">One conservative resource region per changed path. Symbol boundaries remain unavailable until an authoritative structural source is registered.</p>
    <div class="table-wrap"><table><thead><tr><th>Path</th><th>Operation</th><th>Material</th><th>Assurance</th><th>Identity</th></tr></thead><tbody>${snapshot.manifest.regions.map((region) => {
      const file = regionPath(region);
      return `<tr><td><button class="link" type="button" data-open-file="${escape(file)}">${escape(file)}</button></td><td>${escape(region.operation ?? 'changed')}</td><td>${region.classification?.material === false ? 'No' : 'Yes'}</td><td>${escape(region.classification?.assurance ?? 'diff-derived')}</td><td><code>${escape(shortDigest(region.regionSha256))}</code></td></tr>`;
    }).join('')}</tbody></table></div></section>`;
}

function causeMap(snapshot: ComprehensionIdeSnapshot): string {
  const causes = snapshot.graph.nodes.filter((node) => node.type === 'cause');
  const changed = snapshot.graph.nodes.filter((node) => node.type === 'change-region');
  return `<section><h2>Cause-grouped review</h2><p class="meta">Only exact, validated links are shown. Absence is displayed as unavailable—not inferred from filenames or prose.</p>
    ${causes.length ? causes.map((cause) => {
      const edges = snapshot.graph.edges.filter((edge) => edge.from === cause.id);
      const targets = edges.map((edge) => changed.find((node) => node.id === edge.to)).filter(Boolean);
      return `<article class="card"><h3>${escape(cause.causeId ?? cause.id)} <span class="badge">${escape(cause.causeKind ?? 'cause')}</span></h3><p>${escape(cause.statement ?? 'No statement text is exposed.')}</p>${targets.length ? `<ul>${targets.map((target) => `<li><button class="link" type="button" data-open-file="${escape(target?.pathAfter ?? target?.pathBefore ?? '')}">${escape(target?.pathAfter ?? target?.pathBefore ?? target?.id ?? 'change')}</button></li>`).join('')}</ul>` : '<p class="muted">No exact changed resource is linked.</p>'}</article>`;
    }).join('') : '<div class="empty"><p>No governed cause bindings are available for this Candidate. The changed paths remain visible under Regions.</p></div>'}
    <p class="callout"><strong>Authority boundary:</strong> this graph is observe-only and cannot approve, publish, gate, or change lifecycle state.</p></section>`;
}

function walkthrough(snapshot: ComprehensionIdeSnapshot): string {
  const draft = snapshot.walkthrough.draft;
  if (!draft) return `<div class="empty"><p>No deterministic walkthrough draft is available: <code>${escape(snapshot.walkthrough.unavailableReason ?? 'CMP_WALKTHROUGH_UNAVAILABLE')}</code>.</p></div>`;
  return `<section><h2>${escape(draft.walkthroughId)}</h2><p>${escape(draft.narrative.content)}</p><p class="meta">Untrusted deterministic draft · <code>${escape(shortDigest(draft.draftSha256))}</code></p>
    <div class="check-list">${draft.claims.map((claim) => `<article class="card"><h3>${escape(claim.claimId)} <span class="badge">${escape(claim.assurance)}</span></h3><p>${escape(claim.text)}</p><p class="meta">${escape(claim.assertionType)} · ${claim.subjectRefs.map((reference) => `<code>${escape(reference)}</code>`).join(' ')}</p></article>`).join('')}</div>
    <p class="callout"><strong>Deliberately narrow:</strong> this draft states only that exact files changed. It makes no semantic, causal, correctness, or human-judgment claim.</p></section>`;
}

function replay(snapshot: ComprehensionIdeSnapshot): string {
  const value = snapshot.replay;
  if (!value) return '<div class="empty"><p>No active Story is bound to this repository view, so there is no Story timeline to replay.</p></div>';
  return `<section><h2>${escape(value.workId)} replay</h2><p class="meta">Existing normalized history only. Prompts, transcripts, actors, operational detail, and model summaries are excluded.</p>
    ${value.events.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Phase</th><th>Generation</th><th>Provenance</th></tr></thead><tbody>${value.events.map((event) => `<tr><td>${escape(event.at ?? 'unknown')}</td><td>${escape(event.kind)}</td><td>${escape(event.phase ?? '—')}</td><td>${escape(event.generation ?? '—')}</td><td>${escape(event.provenance ?? event.source?.stream ?? 'unavailable')}</td></tr>`).join('')}</tbody></table></div>` : '<p>No normalized events matched this Story.</p>'}
    ${value.truncated ? '<p class="warning">The replay reached its deterministic event ceiling; refine it from the CLI for a narrower focus.</p>' : ''}</section>`;
}

function unknowns(snapshot: ComprehensionIdeSnapshot): string {
  const unresolved = snapshot.coverage.unresolved;
  const diagnostics = snapshot.coverage.diagnostics;
  const availability = Object.entries(snapshot.availability).filter(([, status]) => status !== 'available');
  return `<section><h2>Explicit unknowns</h2><p class="meta">These gaps are preserved so missing evidence cannot quietly become a positive claim.</p>
    <div class="summary-grid">${availability.map(([name, status]) => `<div class="summary-card important"><strong>${escape(status)}</strong><span>${escape(name)}</span></div>`).join('')}</div>
    <h3>Unresolved regions</h3>${unresolved.length ? `<ul>${unresolved.map((entry) => `<li><code>${escape(entry.code ?? 'CMP_UNRESOLVED')}</code> · ${escape(entry.path ?? entry.regionId ?? 'region')} · ${escape(entry.reason ?? 'No exact evidence is registered.')}</li>`).join('')}</ul>` : '<p>No unresolved region was reported.</p>'}
    <h3>Diagnostics</h3>${diagnostics.length ? `<ul>${diagnostics.map((entry) => `<li><code>${escape(entry.code ?? 'CMP_DIAGNOSTIC')}</code> · ${escape(entry.message ?? '')}</li>`).join('')}</ul>` : '<p>No additional diagnostic was reported.</p>'}</section>`;
}

export function comprehensionCenterBody(
  snapshot: ComprehensionIdeSnapshot | null,
  tab: Tab,
  loading: boolean,
  error: string | null
): string {
  const tabs: Array<[Tab, string]> = [
    ['regions', 'Regions'], ['causes', 'Cause map'], ['walkthrough', 'Walkthrough'],
    ['replay', 'Replay'], ['unknowns', 'Unknowns']
  ];
  const content = !snapshot
    ? '<div class="empty"><p>The comprehension projection is not available yet.</p></div>'
    : tab === 'regions' ? regions(snapshot)
      : tab === 'causes' ? causeMap(snapshot)
        : tab === 'walkthrough' ? walkthrough(snapshot)
          : tab === 'replay' ? replay(snapshot) : unknowns(snapshot);
  return `<header><p class="eyebrow">Comprehension</p><h1>${icon('code', { size: 24 })} Comprehension Center</h1><p class="meta">Trace the exact repository interval, what is known, and what remains unavailable. This surface is read-only and model-free.</p></header>
    ${snapshot ? `<section class="plain"><div class="context-banner"><div><span>Subject</span><strong>${escape(snapshot.context.workId ?? 'Repository changes')}</strong></div><div><span>Phase</span><strong>${escape(snapshot.context.phase ?? 'No active Story')}</strong></div><div><span>Baseline</span><code>${escape(snapshot.context.base)}</code></div><div><span>Source</span><strong>${escape(snapshot.context.source)}</strong></div></div><div class="summary-grid"><div class="summary-card"><strong>${snapshot.summary.regions}</strong><span>change regions</span></div><div class="summary-card"><strong>${snapshot.summary.explained}</strong><span>exactly explained</span></div><div class="summary-card ${snapshot.summary.unresolved ? 'important' : ''}"><strong>${snapshot.summary.unresolved}</strong><span>unresolved</span></div><div class="summary-card"><strong>${snapshot.summary.replayEvents}</strong><span>replay events</span></div></div></section>` : ''}
    <nav class="tabs" aria-label="Comprehension views">${tabs.map(([id, label]) => `<button class="${id === tab ? 'active' : ''}" type="button" data-message="tab" data-tab="${id}" aria-pressed="${id === tab}">${label}</button>`).join('')}</nav>
    <p class="card-foot"><button class="secondary" type="button" data-message="refresh">Refresh exact snapshot</button>${loading ? ' <span role="status">Reading repository…</span>' : ''}</p>
    ${error ? `<section class="warning"><strong>Comprehension unavailable</strong><p>${escape(error)}</p></section>` : ''}${content}`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-message="tab"]');
    if (tab) return vscode.postMessage({ type:'tab', tab:tab.dataset.tab });
    const refresh = event.target.closest('[data-message="refresh"]');
    if (refresh) return vscode.postMessage({ type:'refresh' });
    const file = event.target.closest('[data-open-file]');
    if (file) vscode.postMessage({ type:'open-file', path:file.dataset.openFile });
  });
`;

export class ComprehensionCenterPanel {
  private static current: ComprehensionCenterPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscriptions: vscode.Disposable[] = [];
  private subscription: { dispose(): void } | null = null;
  private lease: SliceLease | null = null;
  private leaseAcquisition: Promise<void> | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private tab: Tab = 'regions';
  private loading = true;
  private error: string | null = null;
  private lastSliceRevision: string | null = null;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore) {
    this.panel = panel;
    this.store = store;
    const router = registerMessageRouter('singularityFlow.comprehensionCenter', {
      tab: (message) => {
        const tab = enumField(message, 'tab', ['regions', 'causes', 'walkthrough', 'replay', 'unknowns'] as const);
        if (tab) { this.tab = tab; this.render(); }
      },
      refresh: () => void this.refresh(),
      'open-file': (message) => {
        const file = stringField(message, 'path');
        if (file) void this.openFile(file);
      }
    });
    panel.webview.onDidReceiveMessage((message) => router.route(message), null, this.subscriptions);
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.renewLease();
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    this.subscription = store.onDidChange((state, change) => {
      const revision = state.snapshot?.revision?.slices?.comprehension ?? null;
      if (change.kind === 'loading') { this.loading = true; this.render(); return; }
      this.loading = state.loading;
      this.error = state.error?.message ?? null;
      if (change.kind === 'snapshot' && revision === this.lastSliceRevision
          && change.revisionChanged === false && !this.error) return;
      this.lastSliceRevision = revision;
      this.render();
    });
    this.render();
  }

  static show(context: vscode.ExtensionContext, store: WorkspaceStore): ComprehensionCenterPanel {
    if (ComprehensionCenterPanel.current) {
      ComprehensionCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ComprehensionCenterPanel.current.renewLease();
      return ComprehensionCenterPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.comprehensionCenter', 'Comprehension Center', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    const current = new ComprehensionCenterPanel(panel, store);
    ComprehensionCenterPanel.current = current;
    void current.ensureLease();
    return current;
  }

  private ensureLease(): Promise<void> {
    if (this.leaseAcquisition) return this.leaseAcquisition;
    let flight: Promise<void>;
    flight = this.acquireLease().finally(() => {
      if (this.leaseAcquisition === flight) this.leaseAcquisition = null;
    });
    this.leaseAcquisition = flight;
    return flight;
  }

  private async acquireLease(): Promise<void> {
    try {
      this.lease = await this.store.acquireSlices(
        'comprehension-center', ['comprehension'], { ttlMs: DEFAULT_COMPREHENSION_SLICE_LEASE_MS }
      );
      this.lastSliceRevision = this.store.current.snapshot?.revision?.slices?.comprehension ?? null;
      if (this.renewal) clearInterval(this.renewal);
      this.renewal = setInterval(() => {
        if (this.panel.visible) this.renewLease();
      }, Math.floor(DEFAULT_COMPREHENSION_SLICE_LEASE_MS / 2));
      this.renewal.unref?.();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      if (!this.disposed) this.render();
    }
  }

  private renewLease(): void {
    try { this.lease?.renew(DEFAULT_COMPREHENSION_SLICE_LEASE_MS); }
    catch { this.lease = null; void this.ensureLease(); }
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try { await this.store.refresh(); this.error = null; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; if (!this.disposed) this.render(); }
  }

  private allowedPath(file: string): boolean {
    const snapshot = this.store.current.snapshot?.comprehension;
    return Boolean(snapshot?.manifest.regions.some((region) =>
      region.location.pathAfter === file || region.location.pathBefore === file));
  }

  private async openFile(file: string): Promise<void> {
    if (!this.allowedPath(file)) {
      this.error = 'That path is not present in the current comprehension snapshot. Refresh and try again.';
      this.render();
      return;
    }
    const repositoryRoot = this.store.current.snapshot?.repository?.root;
    if (!repositoryRoot) {
      this.error = 'The current snapshot has no verified repository root, so the file was not opened.';
      this.render();
      return;
    }
    const repository = path.resolve(repositoryRoot);
    const target = path.resolve(repository, file);
    if (target !== repository && !target.startsWith(`${repository}${path.sep}`)) {
      this.error = 'The selected path resolves outside the governed repository and was not opened.';
      this.render();
      return;
    }
    try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target)); }
    catch (error) {
      this.error = `The file could not be opened: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page(
      'Comprehension Center',
      comprehensionCenterBody(
        this.store.current.snapshot?.comprehension ?? null, this.tab, this.loading, this.error
      ),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT, { nav: 'help' }
    );
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = null;
    this.lease?.dispose();
    this.lease = null;
    this.subscription?.dispose();
    this.subscription = null;
    for (const disposable of this.subscriptions.splice(0)) disposable.dispose();
    ComprehensionCenterPanel.current = null;
  }
}

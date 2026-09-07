/** Read-only CMP review surface over one explicitly leased comprehension snapshot slice. */
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import type {
  ComprehensionIdeSnapshot, ComprehensionRegion, ComprehensionSourceExpansion
} from '../cli/snapshot.ts';
import {
  DEFAULT_COMPREHENSION_SLICE_LEASE_MS, type SliceLease, type WorkspaceStore
} from '../state.ts';
import { enumField, integerField, registerMessageRouter, stringField } from './messages.ts';
import { navigateTo } from './navigate.ts';
import { commandData } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';

type Tab = 'regions' | 'source' | 'brownfield' | 'diff' | 'evidence' | 'causes' | 'walkthrough' | 'replay' | 'unknowns';

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
  return `<section><h2>Exact change regions</h2><p class="meta">One conservative resource region per changed path. Existing cached symbols are optional navigation aids at their stated assurance; they are never rebuilt here or treated as authoritative boundaries. Exact before/after source is loaded only when selected and is never retained after this panel is hidden.</p>
    <div class="table-wrap"><table><thead><tr><th>Path</th><th>Operation</th><th>Available cached symbols</th><th>Exact source</th><th>Material</th><th>Assurance</th><th>Identity</th></tr></thead><tbody>${snapshot.manifest.regions.map((region) => {
      const file = regionPath(region);
      const symbols = snapshot.structure.symbols.filter((symbol) => symbol.path === file);
      const symbolLinks = symbols.length
        ? symbols.map((symbol) => `<button class="link" type="button" data-open-file="${escape(file)}" data-open-line="${symbol.line}" title="${escape(`${symbol.declarationKind} · ${symbol.assurance} · ${symbol.extractor}`)}">${escape(symbol.name)}:${symbol.line}</button>`).join(' ')
        : '—';
      const sourceLinks = snapshot.sourceReferences.filter((reference) =>
        reference.regionSha256 === region.regionSha256).map((reference) =>
        `<button class="link" type="button" data-source-ref="${escape(reference.ref)}">${escape(reference.side)}</button>`).join(' ') || '—';
      return `<tr><td><button class="link" type="button" data-open-file="${escape(file)}">${escape(file)}</button></td><td>${escape(region.operation ?? 'changed')}</td><td>${symbolLinks}</td><td>${sourceLinks}</td><td>${region.classification?.material === false ? 'No' : 'Yes'}</td><td>${escape(region.classification?.assurance ?? 'diff-derived')}</td><td><code>${escape(shortDigest(region.regionSha256))}</code></td></tr>`;
    }).join('')}</tbody></table></div></section>`;
}

function sourceView(value: ComprehensionSourceExpansion | null): string {
  if (!value) {
    return '<section><h2>Exact source</h2><div class="empty"><p>Select a before or after source from Regions. Source bytes are fetched only for that explicit selection.</p></div></section>';
  }
  const bytes = Buffer.from(value.content, 'base64');
  const decoded = bytes.toString('utf8');
  const text = !bytes.includes(0) && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : null;
  const body = text == null
    ? '<p class="callout"><strong>Binary source page.</strong> It is digest-checked but is not rendered as text. Use the CLI JSON result when exact binary bytes are required.</p>'
    : `<pre class="source-preview" tabindex="0">${escape(decoded)}</pre>`;
  return `<section><h2>Exact ${escape(value.side)} source</h2><p class="meta">${escape(value.path)} · ${value.offset}-${value.offset + value.bytes} of ${value.totalBytes} bytes · <code>${escape(shortDigest(value.contentSha256))}</code></p>${body}
    ${value.nextOffset == null ? '<p class="meta">Complete exact source loaded.</p>' : `<p><button class="secondary" type="button" data-source-next="${value.nextOffset}">Load next bounded page</button></p>`}
    <p class="callout"><strong>Authority boundary:</strong> before bytes come from the immutable Git blob; after bytes must still match the selected Candidate. This read cannot approve, publish, or block work and is discarded when the panel is hidden.</p></section>`;
}

function brownfield(snapshot: ComprehensionIdeSnapshot): string {
  const assessment = snapshot.brownfield;
  const labels: Record<string, string> = {
    'new-region': 'New region',
    'legacy-touched': 'Legacy touched',
    'mechanical-move-candidate': 'Move candidate'
  };
  const rows = assessment.regions.map((region) => {
    const file = region.pathAfter ?? region.pathBefore ?? 'unknown';
    const prior = region.priorLegacyLabel ?? 'not applicable';
    return `<tr><td><button class="link" type="button" data-open-file="${escape(file)}">${escape(file)}</button></td><td><span class="badge">${escape(labels[region.touchClass] ?? region.touchClass)}</span></td><td>${escape(region.operation)}</td><td>${escape(prior)}</td><td>${escape(region.requirement)}</td></tr>`;
  }).join('');
  return `<section><h2>Incremental brownfield adoption</h2><p class="meta">Only the exact current change regions are assessed. Unchanged legacy files are not scanned and keep the explicit label <code>${escape(assessment.policy.untouchedLegacyLabel)}</code>.</p>
    <div class="summary-grid"><div class="summary-card"><strong>${assessment.counts['new-region']}</strong><span>new regions</span></div><div class="summary-card"><strong>${assessment.counts['legacy-touched']}</strong><span>legacy touched</span></div><div class="summary-card"><strong>${assessment.counts['mechanical-move-candidate']}</strong><span>move candidates</span></div><div class="summary-card"><strong>No</strong><span>full backfill required</span></div></div>
    ${rows ? `<div class="table-wrap"><table><thead><tr><th>Path</th><th>Touch class</th><th>Git operation</th><th>Prior label</th><th>Required next evidence</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty"><p>No repository changes exist in the selected interval. No legacy files were scanned.</p></div>'}
    <p class="callout"><strong>Safety boundary:</strong> an exact object-preserving rename is only a move candidate. This view never retains a legacy label, creates history, approves a proposal, or blocks lifecycle work.</p><p class="meta">Assessment <code>${escape(shortDigest(assessment.assessmentSha256))}</code></p></section>`;
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

function diff(snapshot: ComprehensionIdeSnapshot): string {
  const preview = snapshot.diff;
  const omitted = preview.omittedUntrackedRegions
    ? `<p class="callout"><strong>${preview.omittedUntrackedRegions} untracked file(s) omitted:</strong> newly created file bodies are not copied into the snapshot. Open them explicitly from Regions.</p>`
    : '';
  if (preview.status !== 'available' || !preview.patch) {
    return `<section><h2>Exact bounded diff</h2><div class="empty"><p>The patch preview is ${escape(preview.status)}: <code>${escape(preview.reason ?? 'CMP_DIFF_UNAVAILABLE')}</code>.</p><p>Changed paths remain available under Regions. This optional view never blocks lifecycle work.</p></div>${omitted}</section>`;
  }
  const sections = preview.fileProjectionStatus === 'available'
    ? preview.files.map((file, index) => {
      const name = file.pathAfter ?? file.pathBefore ?? `changed file ${index + 1}`;
      const exact = preview.patch!.slice(file.patchStart, file.patchEnd);
      const ranges = file.hunks.length
        ? file.hunks.map((hunk) => `<code>-${hunk.beforeStart},${hunk.beforeLines} +${hunk.afterStart},${hunk.afterLines}</code>`).join(' ')
        : '<span class="muted">metadata or binary change; no textual hunk</span>';
      return `<details class="card" ${index === 0 ? 'open' : ''}><summary>${escape(name)} <span class="badge">${escape(file.operation)}</span></summary><p class="meta">${file.bytes} bytes · ${file.hunks.length} hunk(s) · <code>${escape(shortDigest(file.patchSha256))}</code></p><p>${ranges}</p><pre class="source-preview" tabindex="0">${escape(exact)}</pre></details>`;
    }).join('')
    : `<p class="warning">Per-region sections are unavailable: <code>${escape(preview.fileProjectionReason ?? 'CMP_DIFF_FILE_PROJECTION_UNAVAILABLE')}</code>. The exact aggregate patch remains below.</p><pre class="source-preview" tabindex="0">${escape(preview.patch)}</pre>`;
  return `<section><h2>Exact bounded diff</h2><p class="meta">Git patch · ${preview.bytes} bytes · ${preview.files.length} tracked file section(s) · <code>${escape(shortDigest(preview.patchSha256))}</code>. The section index references the single patch; it does not duplicate source bytes. This transient payload is evicted when the panel is hidden or closed and is never restored from the snapshot cache.</p>${sections}${omitted}<p class="callout"><strong>Authority boundary:</strong> this is the exact local Git patch for inspection, not semantic evidence or approval.</p></section>`;
}

function evidence(snapshot: ComprehensionIdeSnapshot): string {
  const value = snapshot.evidence;
  if (value.status !== 'available') {
    return `<section><h2>Recorded delivery evidence</h2><div class="empty"><p>Delivery evidence is ${escape(value.status)}: <code>${escape(value.reason ?? 'CMP_EVIDENCE_UNAVAILABLE')}</code>.</p><p>This view never creates evidence or blocks ordinary work.</p></div></section>`;
  }
  const linked = new Map(value.regions.map((entry) => [entry.regionSha256, entry]));
  const rows = snapshot.manifest.regions.filter((region) => linked.has(region.regionSha256))
    .map((region) => {
      const record = linked.get(region.regionSha256)!;
      const file = regionPath(region);
      return `<tr><td><button class="link" type="button" data-open-file="${escape(file)}">${escape(file)}</button></td><td>${record.roles.map((role) => `<span class="badge">${escape(role)}</span>`).join(' ')}</td><td>${record.testCommandIds.length ? record.testCommandIds.map((id) => `<code>${escape(id)}</code>`).join(' ') : '—'}</td></tr>`;
    }).join('');
  const receipts = value.testExecutions.length
    ? `<div class="table-wrap"><table><thead><tr><th>Test command</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${value.testExecutions.map((entry) => `<tr><td><code>${escape(entry.commandId)}</code></td><td>${escape(entry.status)}</td><td><code>${escape(shortDigest(entry.receiptSha256))}</code></td></tr>`).join('')}</tbody></table></div>`
    : '<p>No test-execution receipt is recorded for this phase generation.</p>';
  return `<section><h2>Recorded delivery evidence</h2><p class="meta">Phase ${escape(value.phase ?? 'unknown')} · generation ${escape(value.generation ?? 'unknown')} · delivery ${escape(value.deliveryStatus ?? 'unavailable')} · projection <code>${escape(shortDigest(value.evidenceProjectionSha256))}</code></p>
    <div class="summary-grid"><div class="summary-card"><strong>${value.counts.acceptanceTagged}/${value.counts.acceptanceRequired}</strong><span>acceptance clauses tagged</span></div><div class="summary-card ${value.counts.acceptanceMissing ? 'important' : ''}"><strong>${value.counts.acceptanceMissing}</strong><span>acceptance gaps</span></div><div class="summary-card"><strong>${value.counts.testExecutions}</strong><span>test receipts</span></div><div class="summary-card"><strong>${value.counts.linkedRegions}</strong><span>evidence-linked regions</span></div></div>
    <h3>Region roles and test coverage</h3>${rows ? `<div class="table-wrap"><table><thead><tr><th>Exact region path</th><th>Recorded role</th><th>Covering command</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No current change region is named by the phase delivery record.</p>'}
    <h3>Test receipts</h3>${receipts}
    ${value.truncated ? '<p class="warning">The bounded evidence projection omitted records beyond its reviewed ceiling.</p>' : ''}
    <p class="callout"><strong>Authority boundary:</strong> these are references already recorded in workflow state. This read-only view does not reopen receipts, upgrade assurance, or authorize lifecycle progress.</p></section>`;
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
  error: string | null,
  source: ComprehensionSourceExpansion | null = null
): string {
  const tabs: Array<[Tab, string]> = [
    ['regions', 'Regions'], ['source', 'Source'], ['brownfield', 'Brownfield'], ['diff', 'Diff'], ['evidence', 'Evidence'], ['causes', 'Cause map'], ['walkthrough', 'Walkthrough'],
    ['replay', 'Replay'], ['unknowns', 'Unknowns']
  ];
  const content = !snapshot
    ? '<div class="empty"><p>The comprehension projection is not available yet.</p></div>'
    : tab === 'regions' ? regions(snapshot)
      : tab === 'source' ? sourceView(source)
        : tab === 'brownfield' ? brownfield(snapshot)
          : tab === 'diff' ? diff(snapshot)
            : tab === 'evidence' ? evidence(snapshot)
              : tab === 'causes' ? causeMap(snapshot)
                : tab === 'walkthrough' ? walkthrough(snapshot)
                  : tab === 'replay' ? replay(snapshot) : unknowns(snapshot);
  return `<header><p class="eyebrow">Comprehension</p><h1>${icon('code', { size: 24 })} Comprehension Center</h1><p class="meta">Trace the exact repository interval, what is known, and what remains unavailable. This surface is read-only and model-free.</p></header>
    ${snapshot ? `<section class="plain"><div class="context-banner"><div><span>Subject</span><strong>${escape(snapshot.context.workId ?? 'Repository changes')}</strong></div><div><span>Phase</span><strong>${escape(snapshot.context.phase ?? 'No active Story')}</strong></div><div><span>Baseline</span><code>${escape(snapshot.context.base)}</code></div><div><span>Source</span><strong>${escape(snapshot.context.source)}</strong></div></div><div class="summary-grid"><div class="summary-card"><strong>${snapshot.summary.regions}</strong><span>change regions</span></div><div class="summary-card"><strong>${snapshot.summary.explained}</strong><span>exactly explained</span></div><div class="summary-card ${snapshot.summary.unresolved ? 'important' : ''}"><strong>${snapshot.summary.unresolved}</strong><span>unresolved</span></div><div class="summary-card"><strong>${snapshot.summary.replayEvents}</strong><span>replay events</span></div></div></section>` : ''}
    <nav class="tabs" role="tablist" aria-label="Comprehension views">${tabs.map(([id, label]) => `<button id="cmp-tab-${id}" class="${id === tab ? 'active' : ''}" type="button" role="tab" data-message="tab" data-tab="${id}" aria-selected="${id === tab}" aria-controls="cmp-panel-${id}" tabindex="${id === tab ? '0' : '-1'}">${label}</button>`).join('')}</nav>
    <p class="card-foot"><button class="secondary" type="button" data-message="refresh">Refresh exact snapshot</button>${loading ? ' <span role="status">Reading repository…</span>' : ''}</p>
    ${error ? `<section class="warning" role="alert"><strong>Comprehension unavailable</strong><p>${escape(error)}</p></section>` : ''}<div id="cmp-panel-${tab}" role="tabpanel" aria-labelledby="cmp-tab-${tab}" tabindex="0">${content}</div>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  const tabs = () => Array.from(document.querySelectorAll('[role="tab"]'));
  const remembered = sessionStorage.getItem('sf-comprehension-focus-tab');
  if (remembered) {
    sessionStorage.removeItem('sf-comprehension-focus-tab');
    document.querySelector('[data-tab="' + CSS.escape(remembered) + '"]')?.focus();
  }
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-message="tab"]');
    if (tab) return vscode.postMessage({ type:'tab', tab:tab.dataset.tab });
    const refresh = event.target.closest('[data-message="refresh"]');
    if (refresh) return vscode.postMessage({ type:'refresh' });
    const source = event.target.closest('[data-source-ref]');
    if (source) return vscode.postMessage({ type:'source', reference:source.dataset.sourceRef });
    const next = event.target.closest('[data-source-next]');
    if (next) return vscode.postMessage({ type:'source-next', offset:Number(next.dataset.sourceNext) });
    const file = event.target.closest('[data-open-file]');
    if (file) vscode.postMessage({ type:'open-file', path:file.dataset.openFile, line:Number(file.dataset.openLine || 0) });
  });
  document.addEventListener('keydown', (event) => {
    const current = event.target.closest('[role="tab"]');
    if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = tabs();
    const index = items.indexOf(current);
    const next = event.key === 'Home' ? items[0]
      : event.key === 'End' ? items[items.length - 1]
        : items[(index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
    event.preventDefault();
    sessionStorage.setItem('sf-comprehension-focus-tab', next.dataset.tab);
    next.click();
  });
`;

export class ComprehensionCenterPanel {
  private static current: ComprehensionCenterPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly client: SingularityFlowClient;
  private readonly subscriptions: vscode.Disposable[] = [];
  private subscription: { dispose(): void } | null = null;
  private lease: SliceLease | null = null;
  private leaseAcquisition: Promise<void> | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private tab: Tab = 'regions';
  private loading = true;
  private error: string | null = null;
  private source: ComprehensionSourceExpansion | null = null;
  private sourceController: AbortController | null = null;
  private sourceVersion = 0;
  private lastSliceRevision: string | null = null;
  private disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    client: SingularityFlowClient
  ) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    const router = registerMessageRouter('singularityFlow.comprehensionCenter', {
      tab: (message) => {
        const tab = enumField(message, 'tab', ['regions', 'source', 'brownfield', 'diff', 'evidence', 'causes', 'walkthrough', 'replay', 'unknowns'] as const);
        if (tab) { this.tab = tab; this.render(); }
      },
      refresh: () => void this.refresh(),
      source: (message) => {
        const reference = stringField(message, 'reference');
        if (reference) void this.loadSource(reference, 0);
      },
      'source-next': (message) => {
        const offset = integerField(message, 'offset');
        if (this.source && offset !== null && offset === this.source.nextOffset) {
          void this.loadSource(this.source.reference, offset);
        }
      },
      'open-file': (message) => {
        const file = stringField(message, 'path');
        const line = integerField(message, 'line');
        if (file) void this.openFile(file, line && line > 0 ? line : null);
      }
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return router.route(raw);
    }, null, this.subscriptions);
    panel.onDidChangeViewState(() => {
      if (panel.visible) void this.ensureLease();
      else this.releaseLease();
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    this.subscription = store.onDidChange((state, change) => {
      const revision = state.snapshot?.revision?.slices?.comprehension ?? null;
      if (change.kind === 'loading') { this.loading = true; this.render(); return; }
      this.loading = state.loading;
      this.error = state.error?.message ?? null;
      if (change.kind === 'snapshot' && revision === this.lastSliceRevision
          && change.revisionChanged === false && !this.error) return;
      if (change.kind === 'snapshot' && revision !== this.lastSliceRevision) this.cancelSourceLoad();
      this.lastSliceRevision = revision;
      this.render();
    });
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    client: SingularityFlowClient
  ): ComprehensionCenterPanel {
    if (ComprehensionCenterPanel.current) {
      ComprehensionCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ComprehensionCenterPanel.current.renewLease();
      return ComprehensionCenterPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.comprehensionCenter', 'Comprehension Center', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    const current = new ComprehensionCenterPanel(panel, store, client);
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
    if (!this.lease) { void this.ensureLease(); return; }
    try { this.lease.renew(DEFAULT_COMPREHENSION_SLICE_LEASE_MS); }
    catch { this.lease = null; void this.ensureLease(); }
  }

  private releaseLease(): void {
    if (this.renewal) clearInterval(this.renewal);
    this.renewal = null;
    this.lease?.dispose();
    this.lease = null;
    this.cancelSourceLoad();
  }

  private async refresh(): Promise<void> {
    this.cancelSourceLoad();
    this.loading = true;
    this.render();
    try { await this.store.refresh(); this.error = null; }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.loading = false; if (!this.disposed) this.render(); }
  }

  private cancelSourceLoad(): void {
    this.sourceVersion += 1;
    this.sourceController?.abort();
    this.sourceController = null;
    this.source = null;
    this.loading = false;
  }

  private async loadSource(reference: string, offset: number): Promise<void> {
    const snapshot = this.store.current.snapshot?.comprehension;
    const selected = snapshot?.sourceReferences.find((entry) => entry.ref === reference);
    if (!snapshot || !selected) {
      this.error = 'That exact source reference is not present in the current comprehension snapshot. Refresh and select it again.';
      this.render();
      return;
    }
    if (path.resolve(this.client.repository) !== path.resolve(snapshot.context.repository)) {
      this.error = 'The selected repository changed. Refresh the Comprehension Center before reading source.';
      this.render();
      return;
    }
    const sliceRevision = this.store.current.snapshot?.revision?.slices?.comprehension ?? null;
    this.sourceController?.abort();
    const controller = new AbortController();
    const version = ++this.sourceVersion;
    this.sourceController = controller;
    this.loading = true;
    this.render();
    const args = [
      'comprehension', 'source', reference,
      '--base', snapshot.context.base,
      '--offset', String(offset), '--max-bytes', String(32 * 1024), '--json'
    ];
    if (snapshot.context.workId) args.push('--work-id', snapshot.context.workId);
    if (snapshot.context.phase) args.push('--phase', snapshot.context.phase);
    try {
      const result = commandData<{ expansion: ComprehensionSourceExpansion }>(
        await this.client.run(args, controller.signal)
      );
      const current = this.store.current.snapshot?.comprehension;
      const currentRevision = this.store.current.snapshot?.revision?.slices?.comprehension ?? null;
      if (version !== this.sourceVersion || this.disposed || !this.panel.visible || !this.lease
          || currentRevision !== sliceRevision
          || !current?.sourceReferences.some((entry) => entry.ref === reference)) return;
      const expansion = result?.expansion;
      const page = expansion ? Buffer.from(expansion.content, 'base64') : null;
      if (!expansion || expansion.reference !== reference || expansion.offset !== offset
          || expansion.regionSha256 !== selected.regionSha256
          || expansion.referenceSha256 !== selected.referenceSha256
          || expansion.encoding !== 'base64' || page?.length !== expansion.bytes) {
        throw new Error('The exact source response did not match the selected bounded reference.');
      }
      this.source = expansion;
      this.tab = 'source';
      this.error = null;
    } catch (error) {
      if (version !== this.sourceVersion || controller.signal.aborted) return;
      this.source = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.sourceController === controller) this.sourceController = null;
      if (version === this.sourceVersion) {
        this.loading = false;
        if (!this.disposed) this.render();
      }
    }
  }

  private allowedPath(file: string): boolean {
    const snapshot = this.store.current.snapshot?.comprehension;
    return Boolean(snapshot?.manifest.regions.some((region) =>
      region.location.pathAfter === file || region.location.pathBefore === file));
  }

  private async openFile(file: string, line: number | null = null): Promise<void> {
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
    try {
      const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : undefined;
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), options);
    }
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
        this.store.current.snapshot?.comprehension ?? null, this.tab, this.loading, this.error,
        this.source
      ),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT, { nav: 'help' }
    );
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseLease();
    this.subscription?.dispose();
    this.subscription = null;
    for (const disposable of this.subscriptions.splice(0)) disposable.dispose();
    ComprehensionCenterPanel.current = null;
  }
}

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
import {
  acceptExplorerRequest, changeExplorerBody, EXPLORER_SCRIPT, explorerSummary, resolveExplorerFocus,
  resolveExplorerUnit, type ExplorerAudience, type ExplorerFocus, type ExplorerFocusRequest,
  type ExplorerRenderInput, type Xpl2Explanation
} from './change-explorer.ts';
import { changeExplorerDiffHost } from './change-explorer-diff.ts';
import { containedWorkingPath } from './change-explorer-source.ts';

type Tab = 'explorer' | 'explanation' | 'regions' | 'source' | 'brownfield' | 'diff' | 'evidence' | 'causes' | 'walkthrough' | 'replay' | 'unknowns';
const TABS = ['explorer', 'explanation', 'regions', 'source', 'brownfield', 'diff', 'evidence', 'causes', 'walkthrough', 'replay', 'unknowns'] as const;

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

function codeExplanation(snapshot: ComprehensionIdeSnapshot): string {
  const value = snapshot.codeExplanation;
  if (!value) {
    return '<section><h2>Code explanation</h2><div class="empty"><p>The computed explanation is unavailable in this snapshot. Refresh after the Singularity Flow runtime has been upgraded.</p></div><p class="callout"><strong>Authority boundary:</strong> absence is preserved; this surface does not infer an explanation from source text.</p></section>';
  }
  const why = value.whyEachChange.length ? value.whyEachChange.map((unit) => {
    const file = unit.location.pathAfter ?? unit.location.pathBefore ?? 'unknown';
    const range = unit.hunk
      ? `${unit.hunk.hunkId} · +${unit.hunk.after.start},${unit.hunk.after.lines}`
      : `${unit.unitId} · ${unit.opacity?.reason ?? 'opaque change'}`;
    const declarations = unit.declarations.length
      ? `<ul>${unit.declarations.map((entry) => `<li><button class="link" type="button" data-open-file="${escape(entry.path)}" data-open-line="${entry.line}">${escape(entry.qualifiedName ?? entry.name)}:${entry.line}</button> <span class="badge">${escape(entry.assurance)}</span> <span class="muted">navigation hint only</span></li>`).join('')}</ul>`
      : `<p class="muted">Declaration unavailable: <code>${escape(unit.structure.reason ?? 'no exact semantic boundary')}</code>.</p>`;
    const causeReferences = unit.cause.references.length
      ? `<ul>${unit.cause.references.map((entry) => `<li><code>${escape(entry.causeId)}</code> · ${escape(entry.causeKind)} · region-level reference, not hunk-bound</li>`).join('')}</ul>`
      : '<p class="muted">No recorded cause reference is available for this change region.</p>';
    return `<details class="card"><summary><strong>${escape(range)}</strong> <span class="badge">${escape(unit.explanationStatus)}</span> · ${escape(file)}</summary><p><button class="link" type="button" data-open-file="${escape(file)}">Open ${escape(file)}</button> · ${escape(unit.operation)}</p><h4>Declaration navigation</h4>${declarations}<h4>Cause boundary</h4><p class="meta">${escape(unit.cause.reason)}</p>${causeReferences}<p class="meta">Unit <code>${escape(shortDigest(unit.explanationUnitSha256))}</code></p></details>`;
  }).join('') : '<div class="empty"><p>No observable changes exist in this interval.</p></div>';
  return `<section><h2>Why each change is there</h2><p class="meta">Every observable tracked hunk is listed once. Metadata, binary, and untracked changes remain visible as opaque units. Missing cause authority stays unexplained.</p><p><button class="secondary" type="button" data-message="narrate">Prepare advisory narrative in Copilot</button></p>${why}</section>
    <section><h2>What it touches</h2><div class="empty"><p>Repository impact is ${escape(value.availability.impact.status)}: <code>${escape(value.availability.impact.reason)}</code>. Cached declaration overlaps above are navigation aids; they do not prove ownership, callers, or contract impact.</p></div></section>
    <section><h2>What is proven, what is not</h2><div class="empty"><p>Candidate-bound proof is ${escape(value.availability.proof.status)}: <code>${escape(value.availability.proof.reason)}</code>. This view never promotes a claim or path-level test reference into passed proof.</p></div>
    <p class="callout"><strong>Authority boundary:</strong> observe-only · authority none · lifecycle gate false. Explanation <code>${escape(shortDigest(value.explanationSha256))}</code>.</p></section>`;
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
  source: ComprehensionSourceExpansion | null = null,
  explorer: ExplorerRenderInput | null = null
): string {
  const tabs: Array<[Tab, string]> = [
    ['explorer', 'Change Explorer'], ['explanation', 'Code explanation'], ['regions', 'Regions'], ['source', 'Source'], ['brownfield', 'Brownfield'], ['diff', 'Diff'], ['evidence', 'Evidence'], ['causes', 'Cause map'], ['walkthrough', 'Walkthrough'],
    ['replay', 'Replay'], ['unknowns', 'Unknowns']
  ];
  const content = !snapshot
    ? '<div class="empty"><p>The comprehension projection is not available yet.</p></div>'
    : tab === 'explorer' ? (explorer ? changeExplorerBody(explorer) : '<div class="empty"><p>The Change Explorer view is not available yet.</p></div>')
    : tab === 'explanation' ? codeExplanation(snapshot)
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
    const narrate = event.target.closest('[data-message="narrate"]');
    if (narrate) return vscode.postMessage({ type:'narrate' });
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
  private readonly extension: vscode.ExtensionContext;
  private readonly subscriptions: vscode.Disposable[] = [];
  /**
   * The exact comprehension slice the Change Explorer is showing. A newer snapshot does not
   * replace it silently: the page offers a refresh, and every diff, preview and message is
   * resolved against this pinned slice [XPL2-REQ-004, XPL2 5.1].
   */
  private pinned: ComprehensionIdeSnapshot | null = null;
  private newerSnapshot = false;
  private audience: ExplorerAudience = 'reviewer';
  private diffController: AbortController | null = null;
  /** The explorer render on screen and the highest request number accepted from it. */
  private explorerSession: string | null = null;
  private explorerRequest = 0;
  /** A menu's file or line, held until a computed view exists to resolve it against. */
  private focusRequest: ExplorerFocusRequest | null = null;
  /** The resolved request, sent with every render of the explanation set it was resolved against. */
  private focus: (ExplorerFocus & { id: string; set: string }) | null = null;
  private subscription: { dispose(): void } | null = null;
  private lease: SliceLease | null = null;
  private leaseAcquisition: Promise<void> | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private tab: Tab = 'explanation';
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
    client: SingularityFlowClient,
    extension: vscode.ExtensionContext,
    tab: Tab = 'explanation',
    focus: ExplorerFocusRequest | null = null
  ) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    this.extension = extension;
    this.tab = focus ? 'explorer' : tab;
    this.focusRequest = focus;
    const router = registerMessageRouter('singularityFlow.comprehensionCenter', {
      tab: (message) => {
        const tab = enumField(message, 'tab', TABS);
        // Choosing another view abandons a focus request still waiting for its snapshot.
        if (tab) { this.tab = tab; this.focusRequest = null; this.render(); }
      },
      // Change Explorer actions are closed names; each carries the explanation-set digest and,
      // where relevant, one exact unit digest that is resolved against the pinned view [XPL2-AC-048].
      'explorer-open-diff': (message) => {
        if (!this.acceptExplorer(message)) return this.staleExplorerSelection();
        return void this.openExplorerDiff(message);
      },
      'explorer-open-file': (message) => {
        if (!this.acceptExplorer(message)) return this.staleExplorerSelection();
        const unit = resolveExplorerUnit(this.pinnedView(), message.set, message.unit);
        if (!unit) return this.staleExplorerSelection();
        return void this.openFile(unit.pathAfter ?? unit.pathBefore ?? '', unit.hunk?.after.start ?? null);
      },
      'explorer-copy': (message) => {
        if (!this.acceptExplorer(message)) return this.staleExplorerSelection();
        const view = this.pinnedView();
        if (!view || message.set !== view.explanationSetSha256) return this.staleExplorerSelection();
        return void vscode.env.clipboard.writeText(explorerSummary(view)).then(
          () => vscode.window.showInformationMessage('Change summary copied. It is record-derived and grants no approval.'),
          () => undefined
        );
      },
      'explorer-audience': (message) => {
        if (!this.acceptExplorer(message)) return;
        const audience = enumField(message, 'audience', ['reviewer', 'auditor', 'developer'] as const);
        const view = this.pinnedView();
        if (!audience || !view || message.set !== view.explanationSetSha256) return;
        this.audience = audience;
        this.render();
      },
      refresh: () => void this.refresh(),
      narrate: () => void this.prefillNarration(),
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
      this.updatePinned(state.snapshot?.comprehension ?? null);
      this.render();
    });
    this.updatePinned(store.current.snapshot?.comprehension ?? null);
    this.render();
  }

  private pinnedView(): Xpl2Explanation | null {
    return (this.pinned?.explanationView as Xpl2Explanation | null | undefined) ?? null;
  }

  /** Pin the first slice; later different ones only raise "Snapshot changed" until refresh. */
  private updatePinned(latest: ComprehensionIdeSnapshot | null, { replace = false } = {}): void {
    if (!latest) return;
    const current = this.pinnedView();
    const next = (latest.explanationView as Xpl2Explanation | null | undefined) ?? null;
    if (replace || !this.pinned || !current || !next
        || path.resolve(latest.context.repository) !== path.resolve(this.pinned.context.repository)) {
      this.pinned = latest;
      this.newerSnapshot = false;
      return;
    }
    if (next.explanationSetSha256 === current.explanationSetSha256) {
      this.pinned = latest;
      this.newerSnapshot = false;
    } else {
      this.newerSnapshot = true;
    }
  }

  /** Only the render on screen may act, and each request number only once, in order. */
  private acceptExplorer(message: Record<string, unknown>): boolean {
    const accepted = acceptExplorerRequest(this.explorerSession, this.explorerRequest, message);
    if (accepted === null) return false;
    this.explorerRequest = accepted;
    return true;
  }

  private staleExplorerSelection(): void {
    this.error = 'That selection belongs to a different snapshot or change unit. Refresh the Change Explorer and select it again.';
    this.render();
  }

  private async openExplorerDiff(message: Record<string, unknown>): Promise<void> {
    const slice = this.pinned;
    const unit = resolveExplorerUnit(this.pinnedView(), message.set, message.unit);
    if (!slice || !unit) return this.staleExplorerSelection();
    if (path.resolve(this.client.repository) !== path.resolve(slice.context.repository)) {
      this.error = 'The selected repository changed. Refresh the Change Explorer before opening a diff.';
      this.render();
      return;
    }
    const file = this.pinnedView()?.inventory.files.find((entry) => entry.fileId === unit.fileId);
    const reference = (ref: string | undefined) => ref ? slice.sourceReferences.find((entry) => entry.ref === ref) ?? null : null;
    const before = reference(file?.sources.before);
    const after = reference(file?.sources.after);
    if (!before && !after) {
      this.error = `${unit.unitId} has no exact before or after source that can be shown as a document.`;
      this.render();
      return;
    }
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
      if (controller.signal.aborted) return;
      this.error = `The exact diff could not be opened: ${error instanceof Error ? error.message : String(error)} `
        + 'If the repository moved, refresh the snapshot; the captured bytes are never replaced by the live file.';
      this.render();
    } finally {
      if (this.diffController === controller) this.diffController = null;
    }
  }

  private async prefillNarration(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: '/sf-explain-code --narrate ',
      isPartialQuery: true
    });
  }

  /**
   * Open the Center, optionally on one view or focused on one file or line. A focused open is an
   * explicit request about the file as it is now, so it moves to the newest slice the Store holds,
   * as Refresh does; without one, a newer slice still only raises "Snapshot changed".
   */
  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    client: SingularityFlowClient,
    { tab = null, focus = null }: { tab?: Tab | null; focus?: ExplorerFocusRequest | null } = {}
  ): ComprehensionCenterPanel {
    if (ComprehensionCenterPanel.current) {
      const current = ComprehensionCenterPanel.current;
      if (focus) {
        current.tab = 'explorer';
        current.focusRequest = focus;
        current.updatePinned(store.current.snapshot?.comprehension ?? null, { replace: true });
        current.render();
      } else if (tab && current.tab !== tab) { current.tab = tab; current.render(); }
      current.panel.reveal(vscode.ViewColumn.Active);
      current.renewLease();
      return current;
    }
    // The hidden webview is not retained: leased source, diff and explorer payloads are released
    // with the lease and rebuilt from the Store when the panel is shown again [XPL2-REQ-029].
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.comprehensionCenter', 'Comprehension Center', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    const current = new ComprehensionCenterPanel(panel, store, client, context, tab ?? 'explanation', focus);
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
    // Hidden means released: the pinned explorer slice and any in-flight exact reads go with it.
    this.diffController?.abort();
    this.diffController = null;
    this.pinned = null;
    this.newerSnapshot = false;
  }

  private async refresh(): Promise<void> {
    this.cancelSourceLoad();
    this.loading = true;
    this.render();
    try {
      await this.store.refresh();
      this.error = null;
      // An explicit refresh is the only way the Change Explorer moves to a newer snapshot.
      this.updatePinned(this.store.current.snapshot?.comprehension ?? null, { replace: true });
    }
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
    return [this.store.current.snapshot?.comprehension, this.pinned].some((snapshot) =>
      Boolean(snapshot?.manifest.regions.some((region) =>
        region.location.pathAfter === file || region.location.pathBefore === file)));
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
    const { target, refusal } = await containedWorkingPath(repositoryRoot, file);
    if (!target) {
      this.error = refusal;
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

  private explorerInput(token: string): ExplorerRenderInput | null {
    // The view on screen is always the pinned one, so every message resolves against exactly what
    // the reader saw; after a hide released the pin, the next render pins the current slice again.
    if (!this.pinned) this.updatePinned(this.store.current.snapshot?.comprehension ?? null);
    const slice = this.pinned;
    if (!slice) return null;
    const view = (slice.explanationView as Xpl2Explanation | null | undefined) ?? null;
    // A waiting menu request is resolved against the first computed view on screen. It then rides
    // on every render of that explanation set under one id, which the page applies once; another
    // snapshot drops it, since it was resolved against this one.
    if (this.focusRequest && view) {
      this.focus = { ...resolveExplorerFocus(view, this.focusRequest), id: nonce(), set: view.explanationSetSha256 };
      this.focusRequest = null;
    }
    const focus = this.focus && view && this.focus.set === view.explanationSetSha256 ? this.focus : null;
    return {
      view,
      unavailableReason: slice.explanationViewUnavailableReason ?? null,
      patch: slice.diff.status === 'available' ? slice.diff.patch : null,
      patchFiles: slice.diff.fileProjectionStatus === 'available' ? slice.diff.files : [],
      timeline: slice.replay?.events ?? null,
      audience: this.audience,
      newerSnapshot: this.newerSnapshot,
      token,
      focus
    };
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    // A new page is a new explorer session: requests from the page it replaces are refused.
    this.explorerSession = this.tab === 'explorer' ? token : null;
    this.explorerRequest = 0;
    this.panel.webview.html = page(
      'Comprehension Center',
      comprehensionCenterBody(
        this.store.current.snapshot?.comprehension ?? null, this.tab, this.loading, this.error,
        this.source, this.tab === 'explorer' ? this.explorerInput(token) : null
      ),
      contentSecurityPolicy(this.panel.webview, token), token, `${SCRIPT}\n${EXPLORER_SCRIPT}`, { nav: 'help' }
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

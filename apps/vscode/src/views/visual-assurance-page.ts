/** Enterprise, read-first rendering for governed design evidence and visual comparison. */
import { escape, icon } from './webview.ts';
import type { IconName } from './webview.ts';
import type { VisualEvidenceRecord } from '../cli/snapshot.ts';
import type { VisualAssuranceView } from './visual-assurance-model.ts';

export type VisualMediaResolver = (path: string | undefined) => string | null;

function statusClass(status: string): string {
  if (['ready', 'covered', 'pass'].includes(status)) return 'ok';
  if (['blocked', 'fail', 'missing'].includes(status)) return 'bad';
  return 'wait';
}

function shortHash(value?: string | null): string { return value ? value.slice(0, 12) : '—'; }
function percent(value?: number): string { return Number.isFinite(value) ? `${((value ?? 0) * 100).toFixed(2)}%` : '—'; }

function notices(view: VisualAssuranceView): string {
  const groups: Array<[IconName, string, string[]]> = [
    ['blocked', 'error', view.errors], ['warning', 'warning', view.warnings], ['ok', 'ok', view.passes]
  ];
  return groups.filter(([, , rows]) => rows.length).map(([glyph, kind, rows]) =>
    `<details class="notice ${kind}"${kind === 'error' ? ' open' : ''}><summary>${icon(glyph)}${rows.length} ${kind === 'ok' ? 'verified checks' : `${kind}${rows.length === 1 ? '' : 's'}`}</summary><ul>${rows.map((row) => `<li>${escape(row)}</li>`).join('')}</ul></details>`
  ).join('');
}

function openButton(path?: string, label = 'Open'): string {
  return path ? `<button class="secondary compact-action" data-open="${escape(path)}">${icon('document')}${escape(label)}</button>` : '';
}

function evidenceRows(rows: VisualEvidenceRecord[]): string {
  if (!rows.length) return '<tr><td colspan="6" class="muted">No governed evidence records in this category.</td></tr>';
  return rows.map((row) => `<tr>
    <td><strong>${escape(row.id)}</strong><small>${escape(row.kind)}</small></td>
    <td>${escape(row.server ?? '—')}<small>${escape(row.tool ?? '—')}</small></td>
    <td>${escape(row.phase ?? '—')}<small>generation ${escape(row.targetGeneration ?? '—')}</small></td>
    <td>${escape(row.fileVersion ?? row.profileId ?? '—')}<small>${escape(row.nodes?.join(', ') ?? row.screenId ?? '')}</small></td>
    <td><code>${escape(shortHash(row.outputSha256 ?? row.output?.sha256))}</code><small>${escape(row.agent ?? '—')}</small></td>
    <td>${openButton(row.output?.path)}</td>
  </tr>`).join('');
}

function sourceSection(view: VisualAssuranceView): string {
  const approved = view.approvedSet;
  const inventory = view.inventory;
  return `<section class="plain assurance-section">
    <div class="section-heading"><div><p class="eyebrow">Pinned inputs</p><h2>${icon('visual')}Design sources</h2></div>
      ${approved ? '<span class="pill ok">Approved source set</span>' : '<span class="pill wait">No approved source set</span>'}</div>
    ${approved ? `<div class="assurance-facts">
      <div><span>Set hash</span><strong><code>${escape(shortHash(approved.setSha256))}</code></strong></div>
      <div><span>Approved at</span><strong>${escape(approved.phase ?? '—')} · generation ${escape(approved.generation ?? '—')}</strong></div>
      <div><span>Bound records</span><strong>${approved.records?.length ?? 0}</strong></div>
      <div><span>Inventory</span><strong>${inventory ? shortHash(inventory.digest.digestSha256) : 'Not generated'}</strong></div>
    </div>` : `<div class="empty-state"><strong>No approved design-source set yet.</strong><p>Record the versioned design output during the configured capture phase, publish it, and approve that exact generation. The dashboard never substitutes a live design for the pinned source.</p></div>`}
    <div class="section-heading subheading"><h3>${icon('document')}Recorded design evidence</h3><button class="secondary" data-action="show-record">Record evidence</button></div>
    <div class="table-wrap"><table><thead><tr><th>Record</th><th>MCP source</th><th>Phase</th><th>Version / nodes</th><th>Hash / agent</th><th>Artifact</th></tr></thead><tbody>${evidenceRows(view.designSources)}</tbody></table></div>
    ${view.candidates.length ? `<div class="notice warning"><strong>${view.candidates.length} newer candidate version${view.candidates.length === 1 ? '' : 's'} detected.</strong><p>A candidate becomes governed only through a new capture-phase generation and approval; this page does not silently replace the pin.</p>
      <div class="table-wrap candidate-table"><table><thead><tr><th>Design file</th><th>Approved version</th><th>Candidate version</th><th>Classification</th><th>Decision</th></tr></thead><tbody>${view.candidates.map((candidate) => `<tr><td><code>${escape(candidate.fileKey ?? '—')}</code></td><td>${escape(candidate.approvedVersion ?? '—')}</td><td>${escape(candidate.candidateVersion ?? '—')}</td><td>${escape(candidate.classification ?? 'candidate')}</td><td>${candidate.candidateRecordId ? `<button type="button" class="secondary compact-action" data-promote-candidate="${escape(candidate.candidateRecordId)}">Promote candidate</button>` : '—'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="card-foot"><button data-action="inventory"${approved ? '' : ' disabled'}>${icon('worldModel')}Generate deterministic inventory</button>${inventory ? openButton(inventory.path, 'Open inventory') : ''}</div>
  </section>`;
}

function coverageSection(view: VisualAssuranceView): string {
  return `<section class="plain assurance-section"><div class="section-heading"><div><p class="eyebrow">Expected surfaces</p><h2>${icon('compare')}Viewport coverage</h2></div>
    <span class="pill ${view.summary.profilesTotal && view.summary.profilesCovered === view.summary.profilesTotal ? 'ok' : 'wait'}">${view.summary.profilesCovered}/${view.summary.profilesTotal} covered</span></div>
    ${view.profiles.length ? `<div class="profile-grid">${view.profiles.map((profile) => `<article class="profile-card ${statusClass(profile.status)}">
      <div>${icon(profile.status === 'covered' ? 'ok' : profile.status === 'stale' ? 'stale' : 'warning')}<strong>${escape(profile.label)}</strong></div>
      <span>${escape(profile.dimensions)}</span><small>${escape(profile.recordId ?? 'No matching visual artifact')}</small>
    </article>`).join('')}</div>` : '<div class="empty-state">No visual verification profiles are configured for this Story workflow.</div>'}
    <div class="section-heading subheading"><h3>${icon('artifact')}Captured implementation visuals</h3></div>
    <div class="table-wrap"><table><thead><tr><th>Record</th><th>MCP source</th><th>Phase</th><th>Profile / screen</th><th>Hash / agent</th><th>Artifact</th></tr></thead><tbody>${evidenceRows(view.visualArtifacts)}</tbody></table></div>
  </section>`;
}

function image(path: string | undefined, resolver: VisualMediaResolver, alt: string): string {
  const source = resolver(path);
  return source ? `<img src="${escape(source)}" alt="${escape(alt)}" loading="lazy">` : `<div class="visual-unavailable">${icon('visual')}<span>Preview unavailable</span></div>`;
}

function comparisonSection(view: VisualAssuranceView, media: VisualMediaResolver): string {
  const profiles = view.profiles.map((profile) => `<option value="${escape(profile.id)}">${escape(profile.label)}</option>`).join('');
  return `<section class="plain assurance-section"><div class="section-heading"><div><p class="eyebrow">Spec to screen</p><h2>${icon('compare')}Visual comparisons</h2></div><span class="pill">${view.comparisons.length} recorded</span></div>
    <form id="compare-form" class="editor-card compact-form"><div class="form-grid">
      <label class="field"><span>Expected record or path</span><input name="expected" type="text" placeholder="design record ID or pinned image path" required></label>
      <label class="field"><span>Actual record or path</span><input name="actual" type="text" placeholder="implementation screenshot record ID or path" required></label>
      <label class="field"><span>Verification profile</span><select name="profile"><option value="">Infer from evidence</option>${profiles}</select></label>
    </div><div class="card-foot"><button type="submit">${icon('compare')}Run deterministic comparison</button></div></form>
    ${view.comparisons.length ? `<div class="comparison-grid">${view.comparisons.map((row) => `<article class="comparison-card ${statusClass(row.status)}" data-comparison="${escape(row.id)}">
      <div class="section-heading"><strong>${escape(row.profileId ?? row.id)}</strong><span class="pill ${statusClass(row.status)}">${escape(row.status)}</span></div>
      <div class="comparison-metric"><strong>${escape(percent(row.differingPixelRatio))}</strong><span>pixel difference</span></div>
      <p class="muted">${escape(row.differingPixels ?? 0)} differing pixels · ${escape(row.disposition ?? 'comparison recorded')}</p>
      <div class="visual-mode-tabs" role="tablist" aria-label="Comparison view">
        <button type="button" class="secondary visual-mode active" data-mode="side" role="tab" aria-selected="true">Side by side</button>
        <button type="button" class="secondary visual-mode" data-mode="overlay" role="tab" aria-selected="false">Overlay</button>
        <button type="button" class="secondary visual-mode" data-mode="diff" role="tab" aria-selected="false">Diff</button>
      </div>
      <div class="visual-stage side" data-visual-stage>
        <figure class="visual-pane expected">${image(row.expected?.path, media, `Approved design for ${row.profileId ?? row.id}`)}<figcaption>Approved design <code>${escape(shortHash(row.expected?.sha256))}</code></figcaption></figure>
        <figure class="visual-pane actual">${image(row.actual?.path, media, `Implementation capture for ${row.profileId ?? row.id}`)}<figcaption>Implementation <code>${escape(shortHash(row.actual?.sha256))}</code></figcaption></figure>
        <figure class="visual-pane diff">${image(row.diffImage?.path, media, `Difference highlight for ${row.profileId ?? row.id}`)}<figcaption>Deterministic diff <code>${escape(shortHash(row.diffImage?.sha256))}</code></figcaption></figure>
        <label class="overlay-control"><span>Reveal implementation</span><input type="range" min="0" max="100" value="50" aria-label="Reveal implementation image"></label>
      </div>
      <div class="card-foot">${openButton(row.expected?.path, 'Expected')}${openButton(row.actual?.path, 'Actual')}${openButton(row.diffImage?.path, 'Diff')}${openButton(row.path, 'Report')}</div>
    </article>`).join('')}</div>` : '<div class="empty-state">No comparisons have been recorded. Capture an implementation visual, then compare it with the approved design source.</div>'}
  </section>`;
}

function mcpSection(view: VisualAssuranceView): string {
  const options = view.servers.map((server) => `<option value="${escape(server.id)}">${escape(server.label)} · ${escape(server.readiness)}</option>`).join('');
  return `<section class="plain assurance-section"><div class="section-heading"><div><p class="eyebrow">Explicit network boundary</p><h2>${icon('mcp')}MCP readiness & evidence</h2></div><button class="secondary" data-action="network-doctor">Run network doctor</button></div>
    <p class="muted">Opening or refreshing this dashboard performs local checks only. Network doctor and warm-up contact the selected host only after confirmation.</p>
    ${view.servers.length ? `<div class="server-grid">${view.servers.map((server) => `<article class="server-card"><div>${icon('mcp')}<strong>${escape(server.label)}</strong><span class="pill ${server.readiness === 'ready' ? 'ok' : 'wait'}">${escape(server.readiness)}</span></div><small>${escape(server.id)} · ${server.tools.length || 'all'} allowed tool${server.tools.length === 1 ? '' : 's'}</small>${server.reasons.length ? `<ul>${server.reasons.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul>` : ''}<div class="card-foot"><button type="button" class="secondary compact-action" data-attest="${escape(server.id)}">${icon('approval')}Attest host readiness</button></div></article>`).join('')}</div>
      <form id="warm-form" class="inline-form"><label class="field"><span>Server to warm</span><select name="server">${options}</select></label><button type="submit" class="secondary">Warm selected server</button></form>` : '<div class="empty-state">No governed MCP servers are configured. Add one in Configuration Center → MCP tools.</div>'}
    <details id="record-evidence"><summary>Record an existing MCP output</summary><form id="record-form" class="editor-card compact-form"><div class="form-grid">
      <label class="field"><span>Server</span><select name="server" required>${options}</select></label>
      <label class="field"><span>Tool</span><input name="tool" type="text" placeholder="get_file" required></label>
      <label class="field"><span>Evidence kind</span><select name="kind"><option value="design-source">Design source</option><option value="visual-artifact">Visual artifact</option><option value="tool-call">Tool call</option></select></label>
      <label class="field"><span>Output path</span><input name="output" type="text" placeholder="path inside this repository"></label>
      <label class="field"><span>Public output URL</span><input name="outputUrl" type="url" placeholder="https://…"></label>
      <label class="field"><span>File key / version</span><input name="fileKey" type="text" placeholder="file-key"><input name="fileVersion" type="text" placeholder="immutable version"></label>
      <label class="field"><span>Profile / screen / state</span><input name="profileId" type="text" placeholder="mobile-portrait"><input name="screenId" type="text" placeholder="login"><input name="stateId" type="text" placeholder="signed-out"></label>
      <label class="field"><span>Nodes</span><input name="nodes" type="text" placeholder="node-1, node-2"></label>
    </div><div class="card-foot"><button type="submit">Record governed provenance</button></div></form></details>
    <div class="section-heading subheading"><h3>${icon('commit')}Other MCP evidence</h3></div>
    <div class="table-wrap"><table><thead><tr><th>Record</th><th>MCP source</th><th>Phase</th><th>Version</th><th>Hash / agent</th><th>Artifact</th></tr></thead><tbody>${evidenceRows(view.otherEvidence)}</tbody></table></div>
  </section>`;
}

export function visualAssuranceHtml(view: VisualAssuranceView, notice: string | null, operationError: string | null, media: VisualMediaResolver = () => null): string {
  if (!view.available) return `<header class="inbox-header"><div class="brand-lockup">SINGULARITY <span>FLOW</span></div><p class="eyebrow">Governed review</p><h1>${icon('visual', { size: 24 })}Visual Assurance</h1></header><div class="empty"><p>Start or resume a Story to inspect its pinned design and visual evidence.</p></div>`;
  return `<header class="inbox-header assurance-header"><div><div class="brand-lockup">SINGULARITY <span>FLOW</span></div><p class="eyebrow">Governed design review</p><h1>${icon('visual', { size: 24 })}Visual Assurance · ${escape(view.workId)}</h1><p class="meta">Pinned design evidence, implementation captures, deterministic comparisons, and MCP provenance in one review surface.</p></div>
    <div class="header-actions"><span class="pill ${statusClass(view.status)}">${escape(view.statusLabel)}</span><button class="secondary" data-action="refresh">${icon('refresh')}Refresh</button></div></header>
    ${notice ? `<div class="notice ok">${icon('ok')}${escape(notice)}</div>` : ''}${operationError ? `<div class="notice error">${icon('blocked')}${escape(operationError)}</div>` : ''}${notices(view)}
    <section class="plain"><div class="summary-grid assurance-summary">
      <div class="summary-card"><strong>${view.summary.designSources}</strong><span>Design sources</span></div>
      <div class="summary-card"><strong>${view.summary.profilesCovered}/${view.summary.profilesTotal}</strong><span>Profiles covered</span></div>
      <div class="summary-card"><strong>${view.summary.comparisonsPassed}/${view.comparisons.length}</strong><span>Comparisons passed</span></div>
      <div class="summary-card"><strong>${view.summary.evidence}</strong><span>Evidence records</span></div>
    </div><p class="muted">Current phase: <strong>${escape(view.phase ?? '—')}</strong> · Evidence root: <code>${escape(view.itemDirectory ?? '—')}</code></p></section>
    ${sourceSection(view)}${coverageSection(view)}${comparisonSection(view, media)}${mcpSection(view)}`;
}

export const VISUAL_ASSURANCE_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const value = (data, name) => String(data.get(name) || '').trim();
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) { if (action.dataset.action === 'show-record') document.querySelector('#record-evidence')?.setAttribute('open', ''); else vscode.postMessage({ type: action.dataset.action }); }
    const open = event.target.closest('[data-open]'); if (open) vscode.postMessage({ type: 'open', path: open.dataset.open });
    const attest = event.target.closest('[data-attest]'); if (attest) vscode.postMessage({ type: 'attest', server: attest.dataset.attest });
    const promote = event.target.closest('[data-promote-candidate]'); if (promote) vscode.postMessage({ type: 'promote-candidate', candidateRecordId: promote.dataset.promoteCandidate });
    const mode = event.target.closest('[data-mode]');
    if (mode) {
      const card = mode.closest('[data-comparison]'); const stage = card?.querySelector('[data-visual-stage]');
      if (stage) { stage.className = 'visual-stage ' + mode.dataset.mode; card.querySelectorAll('[data-mode]').forEach((button) => { const active = button === mode; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }); }
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.matches('.overlay-control input')) event.target.closest('[data-visual-stage]')?.style.setProperty('--reveal', event.target.value + '%');
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (form.id === 'warm-form') vscode.postMessage({ type: 'warm', server: value(data, 'server') });
    if (form.id === 'compare-form') vscode.postMessage({ type: 'compare', expected: value(data, 'expected'), actual: value(data, 'actual'), profile: value(data, 'profile') });
    if (form.id === 'record-form') vscode.postMessage({ type: 'record', server: value(data, 'server'), tool: value(data, 'tool'), kind: value(data, 'kind'), output: value(data, 'output'), outputUrl: value(data, 'outputUrl'), fileKey: value(data, 'fileKey'), fileVersion: value(data, 'fileVersion'), profileId: value(data, 'profileId'), screenId: value(data, 'screenId'), stateId: value(data, 'stateId'), nodes: value(data, 'nodes').split(',').map((entry) => entry.trim()).filter(Boolean) });
  });`;

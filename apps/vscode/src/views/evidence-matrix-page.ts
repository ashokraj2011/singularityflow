/**
 * The Evidence Matrix panel's page body and script, kept free of the `vscode` module so tests can
 * render it directly. Every word that says how complete the Story is comes from the engine.
 */
import { escape, icon } from './webview.ts';
import { evidenceCell, evidenceTone, type EvidenceApplicability, type EvidenceRow, type EvidenceView } from './evidence-matrix-model.ts';

const RESPONSIBILITIES = ['scope', 'plan', 'implement', 'verify', 'review'] as const;

function style(token: string): string {
  return `<style nonce="${escape(token)}">
      /* The table keeps every responsibility column visible; the drawer opens beneath it. */
      .evidence-layout { display:grid; grid-template-columns:minmax(0, 1fr); gap:var(--sf-space-4); }
      tr.entry { cursor:pointer; }
      tr.entry.selected { outline:2px solid var(--sf-accent); outline-offset:-2px; }
      tr.entry td small { display:block; color:var(--sf-dim); }
      .details { border:var(--sf-border); border-radius:var(--sf-radius); padding:var(--sf-space-3); background:var(--sf-surface); }
      .details dl { display:grid; grid-template-columns:max-content 1fr; gap:var(--sf-space-1) var(--sf-space-3); }
      .details code { overflow-wrap:anywhere; }
      .details .analytics-table td { white-space:normal; }
      .details .analytics-table td[class^="cell-"] { white-space:nowrap; }
      .details .analytics-table td small { white-space:normal; overflow-wrap:anywhere; }
      .cell-missing, .cell-failed { color:var(--sf-bad); }
      .cell-pending, .cell-partial, .cell-inconclusive { color:var(--sf-wait); }
      .cell-met, .cell-not-applicable, .cell-excepted { color:var(--sf-ok); }
    </style>`;
}

function rowHtml(row: EvidenceRow, selected: string | null): string {
  const cells = RESPONSIBILITIES.map((responsibility) => {
    const status = evidenceCell(row, responsibility);
    return `<td class="cell-${escape(status)}">${escape(status)}</td>`;
  }).join('');
  return `<tr class="entry${row.id === selected ? ' selected' : ''}" tabindex="0" data-entry="${escape(row.id)}">
      <td><strong>${escape(row.id)}</strong><small>${escape(row.type)}</small></td>${cells}
      <td><span class="pill ${evidenceTone(row.result)}">${escape(row.result)}</span><small>${escape(row.assurance ?? '—')}</small></td>
    </tr>`;
}

/** Whether the engine accepted the decision is its own verdict (`satisfied`); this only shows it. */
function applicabilityHtml(applicability: EvidenceApplicability | null): string {
  if (!applicability) return '';
  const decided = applicability.satisfied && applicability.decision;
  const decision = decided
    ? `<dt>Decided by</dt><dd>${escape([applicability.decision!.actor ?? 'unknown', applicability.authority, applicability.decision!.at ?? ''].filter(Boolean).join(' · '))}</dd>
        <dt>Reason</dt><dd>${escape(applicability.decision!.reason)}</dd>`
    : `<dt>Decision</dt><dd>Waiting for ${escape(applicability.authority || 'the approval group')} to record why it does not apply.</dd>`;
  return `<h3>Why this does not apply</h3>
      <dl><dt>Workflow says</dt><dd>${escape(applicability.declaredReason ?? '—')}</dd>
        ${decision}</dl>`;
}

function drawerHtml(row: EvidenceRow | null): string {
  if (!row) return '<aside class="details empty"><p>Select a row to see its obligations, what needs attention and how to act on it.</p></aside>';
  const obligations = row.obligations.map((obligation) => `
      <tr><td>${escape(obligation.responsibility)}</td><td class="cell-${escape(obligation.status)}">${escape(obligation.status)}</td>
        <td>${escape(obligation.owningSteps.join(', ') || '—')}</td>
        <td><small>${escape(Object.entries(obligation.facets).map(([name, value]) => `${name}: ${value}`).join(' · '))}</small></td></tr>`).join('');
  const findings = row.findings.length
    ? `<h3>Needs attention</h3><ul>${row.findings.map((finding) => `<li>${escape(finding)}</li>`).join('')}</ul>` : '';
  const actions = row.actions.length
    ? `<h3>Next</h3><ul>${row.actions.map((command) => `<li><code>${escape(command)}</code></li>`).join('')}</ul>` : '';
  return `<aside class="details">
      <h2>${icon('document', { size: 20 })}${escape(row.id)}</h2>
      <dl><dt>Type</dt><dd>${escape(row.type)}</dd>
        <dt>Defined in</dt><dd>${escape(row.source ?? '—')}</dd>
        <dt>Result</dt><dd><span class="pill ${evidenceTone(row.result)}">${escape(row.result)}</span></dd>
        <dt>Assurance</dt><dd>${escape(row.assurance ?? '—')}</dd>
        ${row.statement ? `<dt>Statement</dt><dd>${escape(row.statement.text)}</dd>
        <dt>Disposition</dt><dd>${escape(row.statement.disposition)}${row.statement.coveredBy ? ` (covered by: ${escape(row.statement.coveredBy)})` : ''}</dd>` : ''}</dl>
      <h3>Obligations</h3>
      <table class="analytics-table"><thead><tr><th>Owes</th><th>Status</th><th>Steps</th><th>Facets</th></tr></thead><tbody>${obligations}</tbody></table>
      ${applicabilityHtml(row.applicability)}${findings}${actions}
    </aside>`;
}

/** The page body; `selected` is a row ID the panel looked up in the rows it loaded. */
/** Structural completeness and the completeness review side by side; correctness is never claimed. */
function scopeCard(view: EvidenceView): string {
  const revision = view.scopeRevision ? `<small>${escape(view.scopeRevision)}</small>` : '';
  if (!view.scope) return revision ? `<div class="summary-card"><span class="eyebrow">Scope</span>${revision}</div>` : '';
  return `<div class="summary-card${view.scope.structurallyComplete ? '' : ' important'}"><span class="eyebrow">Scope</span><strong>${escape(view.scope.structure)}</strong>
        <small>${escape(view.scope.review)}; ${escape(view.scope.correctness)}</small>${revision}</div>`;
}

export function evidenceMatrixHtml(view: EvidenceView | null, selected: string | null, error: string | null, token: string): string {
  const header = `<header class="inbox-header">
      <h1>${icon('gate', { size: 20 })}Evidence matrix</h1>
      <button class="secondary" data-action="refresh">Refresh</button>
    </header>`;
  if (error) return `${style(token)}${header}<div class="empty"><p>${escape(error)}</p></div>`;
  if (!view) return `${style(token)}${header}<div class="empty"><p>Loading the evidence for this Story…</p></div>`;
  const counts = view.counts.map((entry) => `${entry.count} ${entry.result}`).join(' · ') || 'no rows';
  const current = view.rows.find((row) => row.id === selected) ?? null;
  const table = view.rows.length
    ? `<div class="table-wrap"><table class="analytics-table">
        <thead><tr><th>Row</th>${RESPONSIBILITIES.map((name) => `<th>${escape(name)}</th>`).join('')}<th>Result</th></tr></thead>
        <tbody>${view.rows.map((row) => rowHtml(row, selected)).join('')}</tbody></table></div>`
    : '<div class="empty"><p>No requirement or acceptance criterion is indexed for this Story yet.</p></div>';
  const unreadable = view.unreadable.length
    ? `<section><h3>Evidence that could not be read</h3><ul>${view.unreadable.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul></section>` : '';
  return `${style(token)}${header}
    <p class="meta">${escape(view.workId)}${view.title ? ` · ${escape(view.title)}` : ''}</p>
    <p class="meta">Evaluated Story revision: <code>${escape(view.revision)}</code></p>
    ${view.candidateRevisions.map((revision) => `<p class="meta">Published candidate: <code>${escape(revision)}</code></p>`).join('')}
    ${view.driftWarnings.map((warning) => `<p class="callout warning">${escape(warning)}</p>`).join('')}
    <div class="summary-grid">
      <div class="summary-card important"><span class="eyebrow">Completion</span><strong>${escape(view.completion)}</strong>
        <small>${escape(view.reasons.join('; '))}</small></div>
      <div class="summary-card"><span class="eyebrow">Lifecycle</span><strong>${escape(view.lifecycle)}</strong></div>
      <div class="summary-card"><span class="eyebrow">Assurance floor</span><strong>${escape(view.assuranceFloor ?? 'none')}</strong>
        <small>required: ${escape(view.requiredAssurance ?? '—')}</small></div>
      <div class="summary-card"><span class="eyebrow">Rows</span><strong>${escape(String(view.total))}</strong><small>${escape(counts)}</small></div>
      ${scopeCard(view)}
    </div>
    <div class="evidence-layout">${table}${drawerHtml(current)}</div>
    ${unreadable}
    <p class="muted">"module-observed" means the test command covering a criterion's tagged test file passed; "exact-local-observed" means the criterion's own test was found passing in the local run of the published candidate.</p>`;
}

export const EVIDENCE_MATRIX_SCRIPT = `
  const vscode = window.__sfVscode;
  function select(row) { if (row && row.dataset.entry) vscode.postMessage({ type: 'select', id: row.dataset.entry }); }
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-action="refresh"]')) { vscode.postMessage({ type: 'refresh' }); return; }
    select(target.closest('tr.entry'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target instanceof Element ? event.target.closest('tr.entry') : null;
    if (row) { event.preventDefault(); select(row); }
  });
`;

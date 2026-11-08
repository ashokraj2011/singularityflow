/**
 * The Findings view's page [CQF:REQ-070]: a Security tab and a TLM tab, each item with its due date,
 * state and the Story that addresses it. Markup only; the extension decides what a click does. Every
 * label is the security team's or the TLM owners' own text, escaped and shown as data.
 */
import { escape, icon } from './webview.ts';
import { overdue, type FindingRow, type FindingsList, type FindingsTab } from './findings-model.ts';

export interface FindingsPageView {
  list: FindingsList | null;
  tab: FindingsTab;
  all: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  today: string;
}

const WHERE = Object.freeze({
  'state-branch': 'from the state branch', local: 'kept on this computer only', 'state-branch and local': 'from the state branch and this computer', none: 'nothing imported yet'
}) as Record<string, string>;

function securityRow(item: FindingRow, today: string): string {
  const where = item.file ? `<code>${escape(item.file)}${item.line ? `:${item.line}` : ''}</code>` : item.package ? `<code>${escape(item.package)}</code>` : '';
  return `<tr data-finding="${escape(item.id)}" class="${item.state === 'closed' ? 'muted' : ''}">
    <td><code>${escape(item.id)}</code></td><td><span class="sf-tag fnd-${escape(item.severity ?? 'info')}">${escape(item.severity ?? 'info')}</span></td>
    <td>${escape(item.label)}${where ? `<br>${where}` : ''}</td>
    <td${overdue(item.dueAt, today) && !['closed', 'accepted-risk'].includes(item.state) ? ' class="fnd-overdue" title="Past its due date"' : ''}>${escape(item.dueAt ?? '—')}</td>
    <td>${escape(item.stateLabel)}</td><td>${item.story ? `<code>${escape(item.story)}</code>` : '—'}</td></tr>`;
}

function tlmRow(item: FindingRow, today: string): string {
  return `<tr data-finding="${escape(item.id)}" class="${item.state === 'closed' ? 'muted' : ''}">
    <td><code>${escape(item.id)}</code></td><td>${escape(item.component ?? '')}</td>
    <td>${escape(item.currentVersion ?? '?')} → ${escape(item.targetVersion ?? '?')}</td><td>${escape(item.endOfLifeAt ?? '—')}</td>
    <td${overdue(item.dueAt, today) && !['closed', 'waiver'].includes(item.state) ? ' class="fnd-overdue" title="Past its due date"' : ''}>${escape(item.dueAt ?? '—')}</td>
    <td>${escape(item.stateLabel)}</td><td>${item.story ? `<code>${escape(item.story)}</code>` : '—'}</td></tr>`;
}

export function findingsPageHtml(view: FindingsPageView): string {
  const items = view.list?.items ?? [];
  const security = items.filter((item) => item.feed === 'security');
  const tlm = items.filter((item) => item.feed === 'tlm');
  const tab = (id: FindingsTab, label: string, count: number) => `<button type="button" role="tab" data-tab="${id}"
    aria-selected="${view.tab === id}" class="${view.tab === id ? '' : 'secondary'}">${label} <span class="sf-tag">${count}</span></button>`;
  const table = view.tab === 'security'
    ? `<table class="fnd-table" data-findings-table="security"><thead><tr><th>ID</th><th>Severity</th><th>Finding</th><th>Due</th><th>State</th><th>Story</th></tr></thead>
       <tbody>${security.map((item) => securityRow(item, view.today)).join('')}</tbody></table>`
    : `<table class="fnd-table" data-findings-table="tlm"><thead><tr><th>ID</th><th>Component</th><th>Version</th><th>End of life</th><th>Due</th><th>State</th><th>Story</th></tr></thead>
       <tbody>${tlm.map((item) => tlmRow(item, view.today)).join('')}</tbody></table>`;
  const shown = view.tab === 'security' ? security.length : tlm.length;
  const last = view.list?.lastImport;
  return `<main class="fnd-page">
    <header class="fnd-header"><h1>${icon('policy')}Findings</h1>
      <p class="muted">Security findings and TLM items for ${escape(view.list?.repository ?? 'this repository')}, ${escape(WHERE[view.list?.location ?? 'none'] ?? '')}.
        ${last ? `Last import ${escape(last.importId)} from ${escape(last.source)}${last.file ? ` (${escape(last.file)})` : ''}.` : ''}</p>
      <p class="fnd-actions">
        <button type="button" data-upload${view.busy ? ' disabled' : ''}>Upload security or TLM findings…</button>
        <button type="button" class="secondary" data-template${view.busy ? ' disabled' : ''}>Save the workbook template…</button>
        <button type="button" class="secondary" data-refresh${view.busy ? ' disabled' : ''}>Refresh</button>
        <label><input type="checkbox" data-all${view.all ? ' checked' : ''}${view.busy ? ' disabled' : ''}> Include closed, accepted and waived</label>
      </p></header>
    ${view.error ? `<p class="blockers" role="alert">${escape(view.error)}</p>` : ''}
    ${view.notice ? `<p class="notice" role="status" data-findings-notice>${escape(view.notice)}</p>` : ''}
    ${view.busy && !view.list ? '<p class="muted" role="status">Reading the register…</p>' : ''}
    <div role="tablist" class="fnd-tabs">${tab('security', 'Security', security.length)}${tab('tlm', 'TLM', tlm.length)}</div>
    ${shown ? table : `<p class="muted" data-findings-empty>${view.list?.location === 'none' ? 'Nothing has been imported. Upload the security team\'s or the TLM owners\' workbook.' : 'Nothing to show on this tab.'}</p>`}
    ${view.list?.notShown ? `<p class="muted">${view.list.notShown} more are not shown.</p>` : ''}
    <p class="muted">A new Story picks open items in its form. Remediation Stories: <code>singularity-flow findings plan</code>.</p>
  </main>`;
}

export const FINDINGS_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-tab],[data-upload],[data-template],[data-refresh]');
    if (!target || target.disabled) return;
    if (target.dataset.tab) api.postMessage({ type: 'findings.tab', tab: target.dataset.tab });
    else if (target.hasAttribute('data-upload')) api.postMessage({ type: 'findings.upload' });
    else if (target.hasAttribute('data-template')) api.postMessage({ type: 'findings.template' });
    else if (target.hasAttribute('data-refresh')) api.postMessage({ type: 'findings.refresh' });
  });
  document.addEventListener('change', (event) => {
    if (event.target.hasAttribute('data-all')) api.postMessage({ type: 'findings.all', value: event.target.checked });
  });
})();
`;

export const FINDINGS_STYLE = `
.fnd-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.fnd-tabs { display: flex; gap: 6px; margin: 12px 0; }
.fnd-table { width: 100%; border-collapse: collapse; }
.fnd-table th, .fnd-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8884); vertical-align: top; }
.fnd-overdue { color: var(--vscode-errorForeground); font-weight: 600; }
.fnd-critical, .fnd-high { background: var(--vscode-inputValidation-errorBackground, #f003); }
.fnd-medium { background: var(--vscode-inputValidation-warningBackground, #fa03); }
`;

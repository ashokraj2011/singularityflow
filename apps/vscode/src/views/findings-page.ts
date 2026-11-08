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

/**
 * The workbook format in a person's words, beside the upload [CQF:REQ-060]. The column lists are the
 * engine's own (format.mjs COLUMNS, held equal by test/vscode-findings.test.mjs), written here so the
 * page does not load the import code.
 */
export const FINDINGS_FORMAT = Object.freeze({
  security: Object.freeze({
    required: Object.freeze(['ID', 'Title', 'Severity', 'Repository']),
    optional: Object.freeze(['Type', 'File', 'Line', 'Package', 'Installed version', 'Fixed version', 'CVE', 'CWE', 'Rule', 'Tool',
      'Description', 'Due date', 'Status', 'Exception expiry', 'Owner'])
  }),
  tlm: Object.freeze({
    required: Object.freeze(['ID', 'Component', 'Repository', 'Target version']),
    optional: Object.freeze(['Ecosystem', 'Current version', 'End of life date', 'Due date', 'Status', 'Waiver expiry', 'Owner', 'Notes'])
  })
});

function formatHtml(open: boolean): string {
  const names = (list: readonly string[]) => list.map((name) => `<code>${escape(name)}</code>`).join(', ');
  return `<details class="fnd-format" data-findings-format${open ? ' open' : ''}><summary>What to upload: the file format</summary>
    <p>An Excel workbook (<code>.xlsx</code>) with a sheet named <strong>Security</strong>, a sheet named <strong>TLM</strong>, or both.
      A CSV file holds one of the two lists; you are asked which. The first row holds the column headings.</p>
    <table class="fnd-table"><thead><tr><th>Sheet</th><th>Required columns</th><th>Optional columns</th></tr></thead><tbody>
      <tr><td>Security</td><td>${names(FINDINGS_FORMAT.security.required)}</td><td>${names(FINDINGS_FORMAT.security.optional)}</td></tr>
      <tr><td>TLM</td><td>${names(FINDINGS_FORMAT.tlm.required)}</td><td>${names(FINDINGS_FORMAT.tlm.optional)}</td></tr></tbody></table>
    <ul>
      <li><strong>Repository</strong>: <code>owner/name</code> or the Git URL. Only this repository's rows are listed here.</li>
      <li><strong>Severity</strong>: Critical, High, Medium, Low or Info. <strong>Dates</strong>: <code>YYYY-MM-DD</code> or an Excel date.</li>
      <li><strong>Status</strong> (empty is Open): Security takes Open, In progress, Accepted risk, False positive or Fixed; TLM takes Open, In progress, Waiver or Done.</li>
      <li>Headings match ignoring case, spaces and punctuation, and common other names are read (Risk for Severity, Ticket for ID, Repo for Repository).
        A team with its own headings maps them under <code>columns:</code> in <code>singularity/findings.yml</code>.</li>
      <li>A row that cannot be read is skipped, and the output names its sheet, row and reason; the other rows import. Each upload is the
        team's latest list: an item with the same ID is updated, and an open item the new file no longer lists is marked not in the latest import.</li>
      <li>The file itself is never committed. Its rows go to the state branch, or stay on this computer for a public repository.</li>
    </ul>
    <p><strong>Save an example workbook…</strong> writes an <code>.xlsx</code> in this format: both sheets, every heading, and one made-up row on each.
      Replace the example rows with the team's own, then upload it.</p></details>`;
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
        <button type="button" class="secondary" data-template${view.busy ? ' disabled' : ''} title="An .xlsx in the upload format, with one example row on each sheet, to fill in">Save an example workbook…</button>
        <button type="button" class="secondary" data-refresh${view.busy ? ' disabled' : ''}>Refresh</button>
        <label><input type="checkbox" data-all${view.all ? ' checked' : ''}${view.busy ? ' disabled' : ''}> Include closed, accepted and waived</label>
      </p></header>
    ${view.error ? `<p class="blockers" role="alert">${escape(view.error)}</p>` : ''}
    ${view.notice ? `<p class="notice" role="status" data-findings-notice>${escape(view.notice)}</p>` : ''}
    ${view.busy && !view.list ? '<p class="muted" role="status">Reading the register…</p>' : ''}
    ${formatHtml(!items.length && !last)}
    <div role="tablist" class="fnd-tabs">${tab('security', 'Security', security.length)}${tab('tlm', 'TLM', tlm.length)}</div>
    ${shown ? table : `<p class="muted" data-findings-empty>${view.list?.location === 'none' || (!items.length && !last)
      ? 'Nothing has been imported for this repository. Upload the security team\'s or the TLM owners\' workbook.'
      : `No ${view.all ? '' : 'open '}${view.tab === 'security' ? 'security findings' : 'TLM items'} for this repository.`}</p>`}
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
.fnd-format { margin: 12px 0; }
.fnd-format summary { cursor: pointer; font-weight: 600; }
.fnd-format ul { padding-left: 20px; }
.fnd-table { width: 100%; border-collapse: collapse; }
.fnd-table th, .fnd-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8884); vertical-align: top; }
.fnd-overdue { color: var(--vscode-errorForeground); font-weight: 600; }
.fnd-critical, .fnd-high { background: var(--vscode-inputValidation-errorBackground, #f003); }
.fnd-medium { background: var(--vscode-inputValidation-warningBackground, #fa03); }
`;

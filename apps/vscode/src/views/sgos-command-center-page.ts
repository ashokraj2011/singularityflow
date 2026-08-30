import { brandLockup, escape, icon } from './webview.ts';
import { publicFaultText } from './surface-adapters.ts';
import {
  sgosEnabledProcessAction, type SgosCommandCenterView
} from './sgos-command-center-model.ts';
import { renderSgosProcessGraph } from './sgos-process-graph-svg.ts';

function shortHash(value: string | null): string {
  if (!value) return 'not available';
  return value.length > 22 ? `${value.slice(0, 18)}…` : value;
}

function processCard(process: SgosCommandCenterView['selected'], selectedId: string | null): string {
  if (!process) return '';
  const current = process.currentTask
    ? `${process.currentTask.taskTemplateId} · ${process.currentTask.state}` : 'No current task';
  return `<button type="button" class="sgos-process${process.processId === selectedId ? ' selected' : ''}"
    data-select-process="${escape(process.processId)}" aria-pressed="${process.processId === selectedId}">
    <strong>${escape(process.processId)}</strong>
    <span>${escape(process.statusLabel)}</span>
    <small>${escape(current)} · evidence ${process.evidenceReady}/${process.taskCount}</small>
  </button>`;
}

function needsYou(view: SgosCommandCenterView): string {
  if (!view.needsYou.length) return '<p class="muted">No Human Request is waiting for this repository.</p>';
  return `<div class="decision-cards">${view.needsYou.map((object) => {
    const schema = object.view.schema ?? {};
    const extension = (schema['x-sgos'] && typeof schema['x-sgos'] === 'object')
      ? schema['x-sgos'] as Record<string, unknown> : {};
    const title = typeof schema.title === 'string' ? schema.title : 'Human decision required';
    const description = typeof schema.description === 'string' ? schema.description : '';
    const authority = extension.authorityRequired && typeof extension.authorityRequired === 'object'
      ? extension.authorityRequired as Record<string, unknown> : {};
    const options = Array.isArray(extension.options) ? extension.options : [];
    const expires = typeof extension.expiresAt === 'string' ? extension.expiresAt : null;
    return `<article class="decision-card sgos-request">
      <span class="eyebrow">${escape(extension.requestType ?? 'Human Request')}</span>
      <h3>${escape(title)}</h3>
      <p>${escape(description || 'The runtime did not declare a longer explanation.')}</p>
      <dl class="sgos-facts">
        <dt>Process</dt><dd>${escape(object.processId)}</dd>
        <dt>Authority</dt><dd>${escape(authority.kind ?? 'not declared')}${authority.id ? ` · ${escape(authority.id)}` : ''}</dd>
        <dt>Options</dt><dd>${escape(options.length ? options.map((entry) => {
          const option = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
          return option.label ?? option.id ?? 'declared option';
        }).join(', ') : 'decision only')}</dd>
        <dt>Expires</dt><dd>${escape(expires ?? 'no expiry declared')}</dd>
        <dt>After response</dt><dd>The kernel re-checks this exact request and resumes only work the Program permits.</dd>
      </dl>
      <div class="card-foot"><button type="button" data-respond="${escape(object.objectId)}">Review response</button></div>
    </article>`;
  }).join('')}</div>`;
}

function selectedDetail(view: SgosCommandCenterView): string {
  const process = view.selected;
  if (!process) return '<p class="muted">No readable SGOS Process exists yet.</p>';
  const graph = view.graph;
  const stop = sgosEnabledProcessAction(process, 'process.stop');
  const table = graph ? `<div class="table-wrap"><table aria-label="Exact Process tasks">
    <thead><tr><th>Task</th><th>State</th><th>Revision</th><th>Evidence receipt</th><th>Depends on</th></tr></thead>
    <tbody>${graph.nodes.map((task) => {
      const parents = graph.edges.filter((edge) => edge.to === task.taskTemplateId).map((edge) => edge.from);
      return `<tr><td>${escape(task.taskTemplateId)}</td><td>${escape(task.state)}</td><td>${task.revision}</td>
        <td><code>${escape(shortHash(task.receiptSha256))}</code></td><td>${escape(parents.join(', ') || 'none')}</td></tr>`;
    }).join('')}</tbody></table></div>` : '';
  return `<div class="card">
    <div class="card-head"><h3>${escape(process.processId)}</h3><span class="pill">${escape(process.statusLabel)}</span></div>
    <dl class="sgos-facts">
      <dt>Subject</dt><dd>${escape(process.subject.kind ?? 'unknown')} · ${escape(process.subject.id ?? 'unknown')}</dd>
      <dt>Process revision</dt><dd>${process.processRevision}</dd>
      <dt>Process digest</dt><dd><code title="${escape(process.processSha256)}">${escape(shortHash(process.processSha256))}</code></dd>
      <dt>Checkpoint</dt><dd><code title="${escape(process.currentCheckpointSha256 ?? '')}">${escape(shortHash(process.currentCheckpointSha256))}</code></dd>
      <dt>Evidence ready</dt><dd>${process.evidenceReady} of ${process.taskCount} tasks</dd>
    </dl>
    <div class="card-foot">
      <button type="button" data-graph="${escape(process.processId)}">${graph ? 'Reload exact graph' : 'Load exact graph'}</button>
      <button type="button" class="secondary" data-integrity="${escape(process.processId)}">Check integrity</button>
      <button type="button" class="secondary" data-recovery="${escape(process.processId)}">Inspect recovery</button>
      ${stop ? `<button type="button" class="danger secondary" data-stop="${escape(process.processId)}">Stop…</button>` : ''}
    </div>
  </div>${renderSgosProcessGraph(graph)}${table}`;
}

export function sgosCommandCenterBody(view: SgosCommandCenterView): string {
  const selectedId = view.selected?.processId ?? null;
  const summary = Object.values(view.counts).reduce((sum, count) => sum + count, 0);
  const error = view.error
    ? `<div class="callout bad" role="alert"><strong>Command Center could not refresh.</strong><p>${escape(publicFaultText(view.error))}</p></div>` : '';
  const stale = view.stale ? '<p class="warning-text" role="status">Showing cached data while the current repository is checked.</p>' : '';
  const lanes = view.lanes.length ? `<div class="sgos-lanes">${view.lanes.map((lane) =>
    `<section class="sgos-lane" aria-labelledby="sgos-lane-${escape(lane.id)}"><h2 id="sgos-lane-${escape(lane.id)}">${escape(lane.label)} <span class="count-badge">${lane.processes.length}</span></h2>
      ${lane.processes.map((process) => processCard(process, selectedId)).join('')}</section>`).join('')}</div>`
    : '<p class="muted">No SGOS Process has been created in this repository.</p>';
  const unavailable = view.unavailable.length ? `<section><h2>Integrity attention</h2>${view.unavailable.map((process) =>
    `<article class="card sgos-unavailable"><div class="card-head"><h3>${escape(process.processId)}</h3><span>Unavailable</span></div>
      <p>${escape(publicFaultText(process.error.message))}</p><p class="muted">No success or resumability is claimed. Preserved bytes were not changed.</p>
      <div class="card-foot"><button type="button" data-quarantine="${escape(process.processId)}">Plan safe quarantine</button></div></article>`).join('')}</section>` : '';
  const capabilities = `<div class="sgos-capabilities">${Object.entries(view.capabilities).map(([id, capability]) =>
    `<article class="sgos-capability" data-status="${escape(capability.status)}"><strong>${escape(id.replace(/([A-Z])/g, ' $1'))}</strong>
      <small>${escape(capability.status)} · ${escape(capability.reason)}</small>
      ${capability.status === 'available' ? '' : '<button type="button" disabled aria-disabled="true">Not installed</button>'}</article>`).join('')}</div>`;
  return `${brandLockup()}<header><span class="eyebrow">Governed execution</span><h1>${icon('workflow')}Command Center</h1>
    <p class="meta">Projection-only view of exact SGOS Process state. The UI cannot bypass runtime authority.</p></header>
    <div class="sgos-toolbar"><p class="meta">${summary} Process record${summary === 1 ? '' : 's'} · ${escape(view.profileId ?? 'loading runtime profile')}</p>
      <button type="button" class="secondary" data-refresh>${icon('refresh')}Refresh</button></div>
    <div aria-live="polite">${view.loading ? '<p>Refreshing Command Center…</p>' : ''}</div>${stale}${error}
    <section><h2>Processes</h2>${lanes}</section>
    <section><h2>Needs you <span class="count-badge">${view.needsYou.length}</span></h2>${needsYou(view)}</section>
    <section><h2>Selected Process</h2>${selectedDetail(view)}</section>
    ${unavailable}<section><h2>Runtime capabilities</h2><p class="muted">Staged capabilities are visible for planning but cannot be executed from this build.</p>${capabilities}</section>`;
}

export const SGOS_COMMAND_CENTER_SCRIPT = `
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-refresh')) window.__sfVscode.postMessage({ type:'refresh' });
    else if (target.dataset.selectProcess) window.__sfVscode.postMessage({ type:'select', processId:target.dataset.selectProcess });
    else if (target.dataset.graph) window.__sfVscode.postMessage({ type:'graph', processId:target.dataset.graph });
    else if (target.dataset.integrity) window.__sfVscode.postMessage({ type:'integrity', processId:target.dataset.integrity });
    else if (target.dataset.recovery) window.__sfVscode.postMessage({ type:'recovery', processId:target.dataset.recovery });
    else if (target.dataset.stop) window.__sfVscode.postMessage({ type:'stop', processId:target.dataset.stop });
    else if (target.dataset.respond) window.__sfVscode.postMessage({ type:'respond', objectId:target.dataset.respond });
    else if (target.dataset.quarantine) window.__sfVscode.postMessage({ type:'quarantine', processId:target.dataset.quarantine });
  });
`;

import { brandLockup, escape, icon } from './webview.ts';
import { publicFaultText } from './surface-adapters.ts';
import {
  sgosEnabledProcessAction, type SgosCommandCenterView
} from './sgos-command-center-model.ts';
import type {
  SgosRenderDescriptor, SgosRenderScalar, SgosWorkObject
} from '../cli/snapshot.ts';
import { renderSgosProcessGraph } from './sgos-process-graph-svg.ts';

function shortHash(value: string | null): string {
  if (!value) return 'not available';
  return value.length > 22 ? `${value.slice(0, 18)}…` : value;
}

const RENDER_DESCRIPTOR_KEYS = [
  'descriptorVersion', 'viewType', 'title', 'summary', 'accessibility', 'delivery',
  'fields', 'rows', 'edges', 'notes', 'truncated'
] as const;
const VIEW_TYPES = new Set([
  'overview', 'graph', 'board', 'timeline', 'table', 'document', 'form', 'evidence',
  'diff', 'matrix', 'chart', 'log', 'metrics', 'simulation', 'approval'
]);
const ROLES = new Set(['region', 'form', 'document', 'log']);

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function scalar(value: unknown): value is SgosRenderScalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Refuse open-ended schema extensions; only this inert render descriptor is interpreted. */
export function sgosRenderDescriptor(object: SgosWorkObject): SgosRenderDescriptor | null {
  const candidate = record(object.view.schema?.['x-sgos-render']);
  if (!candidate || !exactKeys(candidate, RENDER_DESCRIPTOR_KEYS)
      || candidate.descriptorVersion !== 1 || candidate.viewType !== object.view.type
      || !VIEW_TYPES.has(String(candidate.viewType)) || typeof candidate.title !== 'string'
      || typeof candidate.summary !== 'string' || typeof candidate.truncated !== 'boolean') return null;
  const accessibility = record(candidate.accessibility);
  const delivery = record(candidate.delivery);
  if (!accessibility || !exactKeys(accessibility, ['role', 'label', 'keyboard'])
      || !ROLES.has(String(accessibility.role)) || typeof accessibility.label !== 'string'
      || typeof accessibility.keyboard !== 'string'
      || !delivery || !exactKeys(delivery, ['mode', 'slice', 'release'])
      || !['inline', 'lazy'].includes(String(delivery.mode))
      || delivery.slice !== 'sgos' || delivery.release !== 'panel-dispose') return null;
  if (!Array.isArray(candidate.fields) || candidate.fields.length > 64) return null;
  const fieldCount = candidate.fields.length;
  if (!candidate.fields.every((field) => {
        const item = record(field);
        return item && exactKeys(item, ['id', 'label'])
          && typeof item.id === 'string' && typeof item.label === 'string';
      }) || !Array.isArray(candidate.rows) || candidate.rows.length > 200
      || !candidate.rows.every((row) => {
        const item = record(row);
        return item && exactKeys(item, ['id', 'cells']) && typeof item.id === 'string'
          && Array.isArray(item.cells) && item.cells.length === fieldCount
          && item.cells.every(scalar);
      })) return null;
  if (!Array.isArray(candidate.edges) || candidate.edges.length > 400
      || !candidate.edges.every((edge) => {
        const item = record(edge);
        return item && exactKeys(item, ['id', 'from', 'to', 'label'])
          && [item.id, item.from, item.to, item.label].every((value) => typeof value === 'string');
      }) || !Array.isArray(candidate.notes) || candidate.notes.length > 32
      || !candidate.notes.every((note) => typeof note === 'string')) return null;
  return candidate as unknown as SgosRenderDescriptor;
}

export function renderSgosWorkObject(object: SgosWorkObject): string {
  const descriptor = sgosRenderDescriptor(object);
  if (!descriptor) {
    return `<section class="sgos-work-object" role="status" aria-label="Unavailable Work Object">
      <p class="muted">This Work Object has an unsupported render descriptor and was not interpreted.</p></section>`;
  }
  const table = descriptor.fields.length
    ? `<div class="table-wrap"><table aria-label="${escape(descriptor.accessibility.label)}">
      <thead><tr>${descriptor.fields.map((field) => `<th scope="col">${escape(field.label)}</th>`).join('')}</tr></thead>
      <tbody>${descriptor.rows.map((row) => `<tr>${row.cells.map((cell) =>
        `<td>${escape(cell == null ? '' : String(cell))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '';
  const edges = descriptor.edges.length
    ? `<details><summary>Relationships (${descriptor.edges.length})</summary><ul>${descriptor.edges.map((edge) =>
      `<li>${escape(edge.from)} ${escape(edge.label)} ${escape(edge.to)}</li>`).join('')}</ul></details>` : '';
  const notes = descriptor.notes.length
    ? `<ul class="muted">${descriptor.notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>` : '';
  const lazy = descriptor.delivery.mode === 'lazy'
    ? '<p class="muted">Bounded heavy view · loaded only while the Command Center SGOS lease is open.</p>' : '';
  return `<section class="sgos-work-object" role="${descriptor.accessibility.role}"
    aria-label="${escape(descriptor.accessibility.label)}" tabindex="0"
    data-view-type="${escape(descriptor.viewType)}">
    <h4>${escape(descriptor.title)}</h4><p>${escape(descriptor.summary)}</p>${lazy}${table}${edges}${notes}
  </section>`;
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
    const extension = record(schema['x-sgos']) ?? {};
    const title = typeof schema.title === 'string' ? schema.title : 'Human decision required';
    const why = typeof extension.why === 'string'
      ? extension.why : typeof schema.description === 'string' ? schema.description : '';
    const authority = record(extension.authorityRequired) ?? {};
    const subject = record(extension.exactSubject) ?? {};
    const choices = Array.isArray(extension.choices) ? extension.choices : [];
    const evidence = Array.isArray(subject.evidenceRefs)
      ? subject.evidenceRefs.filter((entry) => typeof entry === 'string') : [];
    const expires = typeof extension.expiresAt === 'string' ? extension.expiresAt : null;
    const remains = typeof extension.whatRemainsRunning === 'string'
      ? extension.whatRemainsRunning : 'The runtime did not declare concurrent-work behavior.';
    const resumes = typeof extension.resumeBehavior === 'string'
      ? extension.resumeBehavior : 'The runtime will re-check the exact request before continuing.';
    const response = object.view.actions.find((entry) => entry.operation === 'request.respond');
    const responseProperties = record(response?.inputSchema?.properties);
    const exactResponse = responseProperties?.processId && responseProperties?.processSha256
      && responseProperties?.requestId && responseProperties?.requestSha256
      && responseProperties?.expectedRevision;
    const choiceList = choices.length ? `<ul>${choices.map((entry) => {
      const choice = record(entry) ?? {};
      return `<li><strong>${escape(choice.label ?? choice.id ?? 'Declared choice')}</strong>
        <span> — ${escape(choice.consequence ?? 'No consequence was declared by the Program.')}</span></li>`;
    }).join('')}</ul>` : '<span>Decision only; no named choice was declared.</span>';
    return `<article class="decision-card sgos-request">
      <span class="eyebrow">${escape(extension.requestType ?? 'Human Request')}</span>
      <h3>${escape(title)}</h3>
      <p><strong>Why this needs you:</strong> ${escape(why || 'The Program requires an explicit Human Response.')}</p>
      <dl class="sgos-facts">
        <dt>Request type</dt><dd>${escape(extension.requestType ?? 'not declared')}</dd>
        <dt>Exact subject</dt><dd>Process <code>${escape(subject.processId ?? object.processId)}</code>
          at <code>${escape(shortHash(typeof subject.processSha256 === 'string' ? subject.processSha256 : null))}</code> ·
          task <code>${escape(subject.taskInstanceId ?? object.taskInstanceId ?? 'not declared')}</code><br>
          request <code>${escape(shortHash(typeof subject.requestSha256 === 'string' ? subject.requestSha256 : null))}</code> ·
          subject <code>${escape(shortHash(typeof subject.subjectSha256 === 'string' ? subject.subjectSha256 : null))}</code> ·
          checkpoint <code>${escape(shortHash(typeof subject.checkpointSha256 === 'string' ? subject.checkpointSha256 : null))}</code> ·
          policy <code>${escape(shortHash(typeof subject.policySnapshotSha256 === 'string' ? subject.policySnapshotSha256 : null))}</code></dd>
        <dt>Evidence</dt><dd>${evidence.length
          ? evidence.map((entry) => `<code title="${escape(entry)}">${escape(shortHash(entry))}</code>`).join(', ')
          : 'No evidence receipt is attached to this request.'}</dd>
        <dt>Authority</dt><dd>${escape(authority.kind ?? 'not declared')}${authority.id ? ` · ${escape(authority.id)}` : ''}${authority.minimumAssurance ? ` · ${escape(authority.minimumAssurance)}` : ''}</dd>
        <dt>Choices and consequences</dt><dd>${choiceList}</dd>
        <dt>What remains running</dt><dd>${escape(remains)}</dd>
        <dt>Resume behavior</dt><dd>${escape(resumes)}</dd>
        <dt>Expires</dt><dd>${escape(expires ?? 'no expiry declared')}</dd>
      </dl>
      ${exactResponse ? `<div class="card-foot"><button type="button" data-respond="${escape(object.objectId)}">Review response</button></div>`
        : '<p class="muted">The response action is not exactly bound to this Process revision and digest; refresh before responding.</p>'}
    </article>`;
  }).join('')}</div>`;
}

function selectedViews(view: SgosCommandCenterView): string {
  if (!view.views.length) return '<p class="muted">No schema-driven views were projected.</p>';
  return `<div class="sgos-work-objects">${view.views.map((object) => {
    const descriptor = sgosRenderDescriptor(object);
    const title = descriptor?.title ?? object.view.type;
    return `<details${object.view.type === 'overview' ? ' open' : ''}>
      <summary>${escape(title)}</summary>${renderSgosWorkObject(object)}</details>`;
  }).join('')}</div>`;
}

function selectedDetail(view: SgosCommandCenterView): string {
  const process = view.selected;
  if (!process) return '<p class="muted">No readable SGOS Process exists yet.</p>';
  const graph = view.graph;
  const pause = sgosEnabledProcessAction(process, 'process.pause');
  const stop = sgosEnabledProcessAction(process, 'process.stop');
  const resume = sgosEnabledProcessAction(process, 'process.resume');
  const step = sgosEnabledProcessAction(process, 'process.step');
  const run = sgosEnabledProcessAction(process, 'process.run');
  const recovery = sgosEnabledProcessAction(process, 'process.recover.plan');
  const replay = sgosEnabledProcessAction(process, 'process.replay.plan');
  const fork = sgosEnabledProcessAction(process, 'process.fork.plan');
  const table = graph ? `<div class="table-wrap"><table aria-label="Exact Process tasks">
    <thead><tr><th>Task</th><th>State</th><th>Revision</th><th>Evidence receipt</th><th>Depends on</th></tr></thead>
    <tbody>${graph.nodes.map((task) => {
      const parents = graph.edges.filter((edge) => edge.to === task.taskTemplateId).map((edge) => edge.from);
      const receipt = task.receiptSha256
        ? `<button type="button" class="link-button" data-evidence-process="${escape(process.processId)}"
            data-evidence-task="${escape(task.taskInstanceId)}" title="Open exact receipt and evidence"><code>${escape(shortHash(task.receiptSha256))}</code></button>`
        : '<span class="muted">not available</span>';
      return `<tr><td>${escape(task.taskTemplateId)}</td><td>${escape(task.state)}</td><td>${task.revision}</td>
        <td>${receipt}</td><td>${escape(parents.join(', ') || 'none')}</td></tr>`;
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
      ${recovery ? `<button type="button" class="secondary" data-recovery="${escape(process.processId)}">Recover…</button>` : ''}
      ${step ? `<button type="button" data-step="${escape(process.processId)}">Step…</button>` : ''}
      ${run ? `<button type="button" data-run="${escape(process.processId)}">Run wave…</button>` : ''}
      ${pause ? `<button type="button" class="secondary" data-pause="${escape(process.processId)}">Pause…</button>` : ''}
      ${resume ? `<button type="button" data-resume="${escape(process.processId)}">Resume…</button>` : ''}
      ${stop ? `<button type="button" class="danger secondary" data-stop="${escape(process.processId)}">Stop…</button>` : ''}
      ${replay ? `<button type="button" class="secondary" data-replay="${escape(process.processId)}">Replay…</button>` : ''}
      ${fork ? `<button type="button" class="secondary" data-fork="${escape(process.processId)}">Fork…</button>` : ''}
    </div>
  </div>${renderSgosProcessGraph(graph)}${table}
  <section aria-labelledby="sgos-projected-views"><h3 id="sgos-projected-views">Schema-driven views</h3>
    <p class="muted">These are inert projections. Controls are resolved separately through exact kernel operation IDs.</p>
    ${selectedViews(view)}</section>`;
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
    <p class="meta">Exact SGOS Process projection with proposal-only Workflow authoring. The UI cannot bypass runtime authority.</p></header>
    <div class="sgos-toolbar"><p class="meta">${summary} Process record${summary === 1 ? '' : 's'} · ${escape(view.profileId ?? 'loading runtime profile')}</p>
      <div class="card-foot"><button type="button" data-create-workflow>${icon('add')}Create Workflow…</button>
      <button type="button" class="secondary" data-refresh>${icon('refresh')}Refresh</button></div></div>
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
    else if (target.hasAttribute('data-create-workflow')) window.__sfVscode.postMessage({ type:'createWorkflow' });
    else if (target.dataset.selectProcess) window.__sfVscode.postMessage({ type:'select', processId:target.dataset.selectProcess });
    else if (target.dataset.graph) window.__sfVscode.postMessage({ type:'graph', processId:target.dataset.graph });
    else if (target.dataset.integrity) window.__sfVscode.postMessage({ type:'integrity', processId:target.dataset.integrity });
    else if (target.dataset.recovery) window.__sfVscode.postMessage({ type:'recovery', processId:target.dataset.recovery });
    else if (target.dataset.pause) window.__sfVscode.postMessage({ type:'pause', processId:target.dataset.pause });
    else if (target.dataset.resume) window.__sfVscode.postMessage({ type:'resume', processId:target.dataset.resume });
    else if (target.dataset.step) window.__sfVscode.postMessage({ type:'step', processId:target.dataset.step });
    else if (target.dataset.run) window.__sfVscode.postMessage({ type:'run', processId:target.dataset.run });
    else if (target.dataset.stop) window.__sfVscode.postMessage({ type:'stop', processId:target.dataset.stop });
    else if (target.dataset.replay) window.__sfVscode.postMessage({ type:'replay', processId:target.dataset.replay });
    else if (target.dataset.fork) window.__sfVscode.postMessage({ type:'fork', processId:target.dataset.fork });
    else if (target.dataset.evidenceProcess && target.dataset.evidenceTask) window.__sfVscode.postMessage({ type:'evidence', processId:target.dataset.evidenceProcess, taskInstanceId:target.dataset.evidenceTask });
    else if (target.dataset.respond) window.__sfVscode.postMessage({ type:'respond', objectId:target.dataset.respond });
    else if (target.dataset.quarantine) window.__sfVscode.postMessage({ type:'quarantine', processId:target.dataset.quarantine });
  });
`;

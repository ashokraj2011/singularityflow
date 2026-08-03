/**
 * The capability screen's markup, kept apart from the panel that hosts it.
 *
 * Rendering is where this feature can silently fail — a policy fold computed correctly and then not
 * shown is the same to a reader as one computed wrong — so it lives in a module with no `vscode`
 * import and is tested directly against the tree the engine emits.
 */
import {
  CAPABILITY_KINDS, capabilityDetail, flattenCapabilities, formatPolicyValue, parentChoices
} from './capability-model.ts';
import { escape, icon } from './webview.ts';
import type { CapabilityNode } from '../cli/snapshot.ts';
import type { CapabilityDashboard } from './capability-dashboard-model.ts';

/** Editable fields, named once. The page cannot introduce a key that is not on this list. */
const FIELDS = ['name', 'kind', 'parent', 'repository', 'jira.projectKey', 'jira.board', 'teams'] as const;

function treeHtml(tree: CapabilityNode[], selected: string | null): string {
  const rows = flattenCapabilities(tree);
  if (!rows.length) {
    return `<p class="muted">Nothing describes what this organisation builds yet. The lead repository
        holds the map; every other repository is something a capability delivers.</p>
      <p><button data-add="">Describe the first capability</button></p>`;
  }
  return `
    <table>
      <thead><tr><th>Capability</th><th>Kind</th><th>Delivers from</th><th>Jira</th><th>Teams</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr${row.id === selected ? ' class="drift"' : ''}>
          <td style="padding-left:${row.depth * 1.2}rem">
            <a href="#" data-select="${escape(row.id)}">${escape(row.name)}</a>
          </td>
          <td class="muted">${escape(row.kind)}</td>
          <td>${row.repository ? `${icon('repository')}<code>${escape(row.repository)}</code>` : '<span class="muted">—</span>'}</td>
          <td class="muted">${row.jira?.projectKey ? `${icon('tracker')}${escape(row.jira.projectKey)}` : '—'}</td>
          <td class="muted">${escape((row.teams ?? []).join(', ') || '—')}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function dashboardHtml(dashboard: CapabilityDashboard): string {
  const diagnosticClass = dashboard.diagnostics === 'healthy' ? 'ok'
    : dashboard.diagnostics === 'needs-attention' ? 'bad' : '';
  return `<section class="plain capability-dashboard">
    <div class="card-head">
      <div><p class="eyebrow">Capability portfolio</p><h3>Organisation at a glance</h3></div>
      <span class="grow"></span>
      <span class="pill ${diagnosticClass}">${dashboard.diagnostics.replace('-', ' ')}</span>
    </div>
    <div class="summary-grid">
      <div class="summary-card important"><strong>${escape(dashboard.capabilities)}</strong><span>capabilities</span></div>
      <div class="summary-card"><strong>${escape(dashboard.deliveryCapabilities)}</strong><span>delivery capabilities</span></div>
      <div class="summary-card"><strong>${escape(dashboard.repositories)}</strong><span>repositories</span></div>
      <div class="summary-card"><strong>${escape(dashboard.jiraRoutes)}</strong><span>Jira routes</span></div>
      <div class="summary-card"><strong>${escape(dashboard.openWork)}</strong><span>open governed work</span></div>
      <div class="summary-card${dashboard.approvals ? ' important' : ''}"><strong>${escape(dashboard.approvals)}</strong><span>awaiting approvals</span></div>
    </div>
    <p class="meta">Repository grounding: <strong>${dashboard.worldModel}</strong>. Open work and
      approvals are portfolio signals from the active lead repository; capability cards below show
      only ownership declared by the capability map.</p>
    ${dashboard.roots.length ? `<div class="capability-root-grid">${dashboard.roots.map((root) => `
      <button class="capability-root-card" data-select="${escape(root.id)}">
        <span class="eyebrow">${escape(root.kind)}</span>
        <strong>${escape(root.name)}</strong>
        <span>${escape(root.capabilities)} capabilities · ${escape(root.deliveryCapabilities)} deliver</span>
        <span>${escape(root.repositories.length)} repositories · ${escape(root.jiraProjects.length)} Jira routes</span>
        <span>${root.teams.length ? escape(root.teams.join(', ')) : 'No teams recorded'}</span>
      </button>`).join('')}</div>` : ''}
  </section>`;
}

function kindSelect(current = 'business'): string {
  const values = CAPABILITY_KINDS.includes(current as typeof CAPABILITY_KINDS[number])
    ? [...CAPABILITY_KINDS]
    : [current, ...CAPABILITY_KINDS];
  return `<select data-field="kind" aria-label="Capability kind">
    ${values.map((kind) => `<option value="${escape(kind)}"${kind === current ? ' selected' : ''}>${escape(
    kind === 'business' ? 'Business' : kind === 'collection' ? 'Collection' : `${kind} (existing)`
  )}</option>`).join('')}
  </select>`;
}

function parentSelect(
  tree: CapabilityNode[],
  capabilityId: string | null,
  current: string | null,
  { creating = false }: { creating?: boolean } = {}
): string {
  const choices = parentChoices(tree, capabilityId);
  const canBeRoot = tree.length === 0 || (!creating && current == null);
  return `<select data-field="parent">
    <option value=""${current ? '' : ' selected'}${canBeRoot ? '' : ' disabled'}>${canBeRoot
    ? 'Top of the capability tree'
    : 'Choose a capability…'}</option>
    ${choices.map((choice) => `<option value="${escape(choice.id)}"${choice.id === current ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(choice.depth)}${escape(choice.name)}</option>`).join('')}
  </select>`;
}

/** The form for a capability that does not exist yet; its identifier is the one field that is fixed. */
function newHtml(tree: CapabilityNode[], parent: string | null): string {
  return `
  <div class="card-head editor-title">
    <div><p class="eyebrow">Capability configuration</p><h3>New capability</h3></div>
  </div>
  <div class="form-grid">
    <label class="field"><span>Identifier</span>
      <input type="text" data-field="id" placeholder="payments-ledger">
      <small>Permanent, lower-case kebab-case.</small>
    </label>
    <label class="field"><span>Display name</span>
      <input type="text" data-field="name" placeholder="Payments Ledger">
    </label>
    <label class="field"><span>Kind</span>
      ${kindSelect()}
      <small>Business delivers value. Collection groups related capabilities.</small>
    </label>
    <label class="field"><span>Linked under</span>
      ${parentSelect(tree, null, parent, { creating: true })}
      <small>Every available capability is offered. You can change this link later.</small>
    </label>
    <label class="field span-2"><span>Repository</span>
      <input type="text" data-field="repository" placeholder="Repository ID (optional)">
      <small>Leave empty when this capability does not directly ship from a repository.</small>
    </label>
  </div>
  <p class="card-foot">
    <button data-create="1">Create capability</button>
    <button class="link" data-cancel="1">Cancel</button>
  </p>`;
}

function detailHtml(tree: CapabilityNode[], selected: string): string {
  const detail = capabilityDetail(tree, selected);
  if (!detail) return '<p class="muted">That capability is no longer in the map.</p>';
  const overridden = detail.policy.filter((field) => field.overridden);

  return `
  <div class="card-head">
    <div><p class="eyebrow">Capability details</p><h3>${escape(detail.name)}</h3></div>
    <span class="pill ${detail.delivery ? 'ok' : ''}">${icon(detail.delivery ? 'repository' : 'capability')}${detail.delivery ? 'delivers' : 'groups'}</span>
    <span class="grow"></span>
    <span class="muted">${escape([...detail.ancestors, detail.id].join(' / '))}</span>
  </div>

  <div class="form-grid">
    <label class="field"><span>Display name</span>
      <input type="text" value="${escape(detail.name)}" data-field="name">
    </label>
    <label class="field"><span>Kind</span>
      ${kindSelect(detail.kind)}
      <small>Business delivers value. Collection groups related capabilities.</small>
    </label>
    <label class="field span-2 relationship-field"><span>Linked under</span>
      ${parentSelect(tree, detail.id, detail.ancestors.at(-1) ?? null)}
      <small>Relink this capability at any time. Self-links and cycles are removed from the list.</small>
    </label>
    <label class="field span-2"><span>Repository</span>
      <input type="text" value="${escape(detail.repository ?? '')}" data-field="repository"
        placeholder="Repository ID (optional)">
      <small>A capability can own a repository and still contain other capabilities.</small>
    </label>
  </div>

  <div class="subsection">
    <h2>${icon('tracker')}Tracking and ownership</h2>
    <div class="form-grid">
      <label class="field"><span>Jira project</span>
        <input type="text" value="${escape(detail.jira?.projectKey ?? '')}" data-field="jira.projectKey" placeholder="PAY">
      </label>
      <label class="field"><span>Jira board</span>
        <input type="text" value="${escape(detail.jira?.board ?? '')}" data-field="jira.board" placeholder="Payments board">
      </label>
      <label class="field span-2"><span>Teams</span>
        <input type="text" value="${escape(detail.teams.join(', '))}" data-field="teams" placeholder="Payments squad, Platform">
        <small>Separate multiple teams with commas.</small>
      </label>
    </div>
  </div>

  <p class="card-foot">
    <button data-save="${escape(detail.id)}">Save changes</button>
    ${detail.delivery ? '' : `<button class="secondary" data-add="${escape(detail.id)}">Add one inside</button>`}
    <button class="link" data-remove="${escape(detail.id)}">Remove</button>
  </p>

  <h2>${icon('policy')}Policy</h2>
  ${overridden.length ? `
    <p class="blockers">${overridden.length === 1
    ? 'One value declared here is'
    : `${overridden.length} values declared here are`} overridden by an ancestor and will not apply as written.</p>` : ''}
  ${detail.policy.length ? `
  <table>
    <thead><tr><th>Rule</th><th>Declared here</th><th>Applies</th><th>How it folds</th></tr></thead>
    <tbody>${detail.policy.map((field) => `
      <tr${field.overridden ? ' class="drift"' : ''}>
        <td>${escape(field.label)}</td>
        <td class="muted">${escape(formatPolicyValue(field.declared))}</td>
        <td>${field.overridden ? '<strong>' : ''}${escape(formatPolicyValue(field.effective))}${field.overridden ? '</strong>' : ''}</td>
        <td class="muted">${escape(field.rule)}</td>
      </tr>`).join('')}</tbody>
  </table>
  <p class="remedy">Policy is written in <code>singularity/capabilities.yml</code>. It is not editable
    here on purpose: every field folds differently, so a form would make the value that applies harder
    to see rather than easier.</p>`
    : `<p class="muted">Nothing tightens governance at this capability, and no ancestor tightens it either.</p>
       <p class="remedy">Policy is written in <code>singularity/capabilities.yml</code>.</p>`}

  ${detail.ships.length ? `
  <h2>${icon('repository')}Ships from</h2>
  <table>
    <thead><tr><th>Capability</th><th>Repository</th></tr></thead>
    <tbody>${detail.ships.map((ship) => `
      <tr><td>${escape(ship.id)}</td><td><code>${escape(ship.repository)}</code></td></tr>`).join('')}</tbody>
  </table>`
    : '<p class="muted">Nothing beneath this capability names a repository yet, so it ships nothing.</p>'}`;
}

export function bodyHtml(
  tree: CapabilityNode[],
  selected: string | null,
  adding: { parent: string | null } | null,
  error: string | null,
  dashboard?: CapabilityDashboard
): string {
  return `
  <header>
    <h1>${icon('capability', { size: 20 })}Capabilities</h1>
    <p class="meta">What this organisation builds, as a tree of any depth. Jira and teams belong to a
      capability rather than to a workspace: they stay true regardless of who has cloned what.</p>
  </header>
  ${error ? `<section class="plain"><p class="blockers">${escape(error)}</p></section>` : ''}
  ${dashboard ? dashboardHtml(dashboard) : ''}
  <section class="plain">
    ${treeHtml(tree, selected)}
    ${flattenCapabilities(tree).length && !adding
    ? `<p><button class="secondary" data-add="${escape(selected ?? '')}">Add a capability${selected ? ' inside this one' : ''}</button></p>`
    : ''}
  </section>
  <section class="editor-card">${adding
    ? newHtml(tree, adding.parent)
    : selected
      ? detailHtml(tree, selected)
      : '<p class="muted">Choose a capability to see what it delivers, who works on it, and the policy it is held to.</p>'}
  </section>`;
}

export const SCRIPT = `
  const vscode = acquireVsCodeApi();
  const read = () => {
    const edits = {};
    for (const field of document.querySelectorAll('[data-field]')) edits[field.dataset.field] = field.value;
    return edits;
  };
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-select],[data-add],[data-save],[data-create],[data-remove],[data-cancel]');
    if (!target) return;
    event.preventDefault();
    const data = target.dataset;
    if (data.select !== undefined) vscode.postMessage({ type: 'select', id: data.select });
    else if (data.add !== undefined) vscode.postMessage({ type: 'add', parent: data.add });
    else if (data.cancel !== undefined) vscode.postMessage({ type: 'cancel' });
    else if (data.create !== undefined) vscode.postMessage({ type: 'create', edits: read() });
    else if (data.remove !== undefined) vscode.postMessage({ type: 'remove', id: data.remove });
    else if (data.save !== undefined) vscode.postMessage({ type: 'save', id: data.save, edits: read() });
  });
`;


/** Keep only the fields the model knows, so a page cannot widen what gets written. */
export function readEdits(raw: unknown): Record<string, string> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const edits: Record<string, string> = {};
  for (const field of FIELDS) {
    if (typeof source[field] === 'string') edits[field] = source[field];
  }
  return edits;
}

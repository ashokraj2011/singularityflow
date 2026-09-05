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
import type { CapabilityDetail } from './capability-model.ts';
import { escape, icon } from './webview.ts';
import type { CapabilityNode } from '../cli/snapshot.ts';
import type { CapabilityDashboard } from './capability-dashboard-model.ts';

/** Editable fields, named once. The page cannot introduce a key that is not on this list. */
const FIELDS = [
  'name', 'kind', 'parent', 'repository', 'sourceRoots', 'sharedRoots', 'metadata',
  'jira.projectKey', 'jira.board', 'teams', 'autoEligibility', 'autoProtectedScope',
  'autoMaximumTouchedPaths', 'autoMaximumConcurrentFlights'
] as const;

function metadataRow(key = '', value = ''): string {
  return `<div class="metadata-row" data-metadata-row data-original-key="${escape(key)}">
    <label class="field"><span>Key</span><input type="text" data-metadata-key value="${escape(key)}"
      placeholder="applicationId"></label>
    <label class="field"><span>Value</span><input type="text" data-metadata-value value="${escape(value)}"
      placeholder="APP-1001"></label>
    <button type="button" class="icon-button danger" data-metadata-remove title="Remove metadata"
      aria-label="Remove metadata pair">${icon('remove')}</button>
  </div>`;
}

function metadataEditor(metadata: Record<string, string> = {}): string {
  const rows = Object.entries(metadata);
  return `<div class="subsection metadata-editor">
    <div class="card-head">
      <div><h2>${icon('configuration')}Additional metadata</h2>
        <p class="muted">Organisation-specific attributes such as application ID, cost centre, owner code, or service tier.</p></div>
      <span class="grow"></span>
      <button type="button" class="secondary" data-metadata-add>Add key/value pair</button>
    </div>
    <div class="metadata-list" data-metadata-list>${rows.length
      ? rows.map(([key, value]) => metadataRow(key, value)).join('')
      : metadataRow()}</div>
    <p class="remedy">Stored in <code>singularity/capabilities.yml</code>. In a governed organisation,
      the authoritative copy is the lead repository's <code>sflow/config</code> branch.</p>
  </div>`;
}

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
            <a href="#" data-select="${escape(row.id)}">${icon(row.kind === 'delivery' ? 'delivery' : 'collection')}${escape(row.name)}</a>
          </td>
          <td class="muted">${escape(row.kind)}</td>
          <td>${row.repository ? `${icon('repository')}<code>${escape(row.repository)}</code>` : '<span class="muted">—</span>'}</td>
          <td class="muted">${row.jira?.projectKey ? `${icon('jira')}${escape(row.jira.projectKey)}` : '—'}</td>
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

function implicitCapabilityHtml(tree: CapabilityNode[], error: string | null): string {
  const detail = capabilityDetail(tree, tree[0]?.id ?? 'repository-root');
  return `<header>
    <h1>${icon('capability', { size: 20 })}Capability</h1>
    <p class="meta">Start with the repository as one capability. Add detail only when ownership or approval rules differ.</p>
  </header>
  ${error ? `<section class="plain"><p class="blockers">${escape(error)}</p></section>` : ''}
  <section class="plain">
    <div class="card-head">
      <div><p class="eyebrow">Ready with no setup</p><h2>This repository</h2></div>
      <span class="grow"></span><span class="pill ok">ready</span>
    </div>
    <p>All application files currently belong to this repository. The approved team profile and repository rules apply.</p>
    <p class="remedy">No capability setup is required. New Stories keep an exact copy of these rules.</p>
  </section>
  <section class="plain">
    <h2>Make governance more specific</h2>
    <p class="muted">These actions create a review proposal. Existing Stories keep their pinned rules and nothing is activated automatically.</p>
    <div class="action-grid">
      <button type="button" data-progressive-start>${icon('start')}Start Story</button>
      <button type="button" class="secondary" data-progressive-why>${icon('search')}Show ownership</button>
      <button type="button" class="secondary" data-progressive-add>${icon('add')}Add a team-owned area</button>
      <button type="button" class="secondary" data-progressive-protect>${icon('approval')}Protect a path</button>
    </div>
  </section>
  ${detail ? `<section class="editor-card">
    <div class="card-head"><div><p class="eyebrow">Optional capability policy</p><h3>${escape(detail.name)}</h3></div></div>
    ${autoPolicyEditor(detail, true)}
  </section>` : ''}`;
}

function managedCapabilityHtml(
  tree: CapabilityNode[], selected: string | null, error: string | null,
  dashboard?: CapabilityDashboard
): string {
  const detail = selected ? capabilityDetail(tree, selected) : null;
  return `<header>
    <h1>${icon('capability', { size: 20 })}Capabilities</h1>
    <p class="meta">Approved ownership at a glance. Add detail only when a boundary or approval differs.</p>
  </header>
  ${error ? `<section class="plain"><p class="blockers">${escape(error)}</p></section>` : ''}
  ${dashboard ? dashboardHtml(dashboard) : ''}
  <section class="plain">
    ${treeHtml(tree, selected)}
    <p class="remedy">This map is receipt-managed. Changes are proposed for review; direct form edits are disabled.</p>
    <div class="action-grid">
      <button type="button" data-progressive-add>${icon('add')}Add a narrower capability</button>
      <button type="button" class="secondary" data-progressive-protect>${icon('approval')}Protect a path</button>
      <button type="button" class="secondary" data-progressive-why>${icon('search')}Explain current ownership</button>
    </div>
  </section>
  <section class="editor-card">${detail
    ? `<div class="card-head"><div><p class="eyebrow">Capability policy</p><h3>${escape(detail.name)}</h3></div>
         <span class="grow"></span><span class="muted">${escape([...detail.ancestors, detail.id].join(' / '))}</span></div>
       ${autoPolicyEditor(detail, true)}`
    : '<p class="muted">Choose a capability to view or change its Auto eligibility and safety limits.</p>'}
  </section>`;
}

function autoPolicyEditor(detail: CapabilityDetail, managed = false): string {
  const auto = detail.auto;
  return `<div class="subsection">
    <div class="card-head"><div><h2>${icon('start')}Auto policy</h2>
      <p class="muted">Control whether this capability may use reviewed Auto plans. Capability policy can only tighten repository and workflow policy; it cannot turn Auto on above this level.</p></div>
      <span class="pill ${auto.effective.eligibility === 'disabled' ? '' : 'ok'}">applies: ${escape(auto.effective.eligibility)}</span>
    </div>
    <p><button type="button" class="secondary" data-open-auto-settings>Repository &amp; work-type settings</button></p>
    ${auto.overridden ? '<p class="notice warning">An ancestor applies a stricter Auto policy. A wider value here will not weaken it.</p>' : ''}
    <div class="form-grid">
      <label class="field"><span>Capability eligibility</span>
        <select data-field="autoEligibility">
          ${[
            ['inherit', 'Inherit — do not restrict'],
            ['disabled', 'Disabled'],
            ['plan-only', 'Plan only'],
            ['bounded', 'Bounded execution']
          ].map(([value, label]) => `<option value="${value}"${auto.declared.eligibility === value ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <small>Repository Auto must also be enabled and the selected work type must be plan-only or bounded.</small>
      </label>
      <label class="field"><span>Protected-scope prediction</span>
        <select data-field="autoProtectedScope">
          <option value="block"${auto.declared.forbiddenWhenProtectedScopePredicted ? ' selected' : ''}>Block Auto</option>
          <option value="allow"${auto.declared.forbiddenWhenProtectedScopePredicted ? '' : ' selected'}>Allow policy evaluation</option>
        </select>
        <small>Protected-path gates still apply. Allowing evaluation never bypasses them.</small>
      </label>
      <label class="field"><span>Maximum touched paths</span>
        <input type="number" min="1" step="1" data-field="autoMaximumTouchedPaths"
          value="${escape(auto.declared.maximumTouchedPaths ?? '')}" placeholder="inherit">
      </label>
      <label class="field"><span>Maximum concurrent flights</span>
        <input type="number" min="1" step="1" data-field="autoMaximumConcurrentFlights"
          value="${escape(auto.declared.maximumConcurrentFlights ?? '')}" placeholder="inherit">
      </label>
    </div>
    ${managed
    ? `<p><button type="button" data-managed-auto-save="${escape(detail.id)}">Propose Auto policy</button></p>
       <p class="remedy">This creates a receipt-backed review proposal. Nothing is activated until it is reviewed into <code>sflow/config</code> and projected to the state branch.</p>`
    : '<p class="remedy">Save changes to create a reviewed capability proposal. Nothing is activated until the proposal is reviewed and merged into <code>sflow/config</code>, then projected to the state branch.</p>'}
  </div>`;
}

function kindSelect(current = 'collection'): string {
  return `<select data-field="kind" aria-label="Capability kind">
    ${CAPABILITY_KINDS.map((kind) => `<option value="${escape(kind)}"${kind === current ? ' selected' : ''}>${kind === 'collection' ? 'Collection' : 'Delivery'}</option>`).join('')}
  </select>`;
}

function parentSelect(
  tree: CapabilityNode[],
  capabilityId: string | null,
  current: string | null
): string {
  const choices = parentChoices(tree, capabilityId);
  return `<select data-field="parent" aria-label="Parent capability">
    <option value=""${current ? '' : ' selected'}>Top level (no parent)</option>
    ${choices.map((choice) => `<option value="${escape(choice.id)}"${choice.id === current ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(choice.depth)}${escape(choice.name)}</option>`).join('')}
  </select>`;
}

function detailHtml(tree: CapabilityNode[], selected: string): string {
  const detail = capabilityDetail(tree, selected);
  if (!detail) return '<p class="muted">That capability is no longer in the map.</p>';
  const overridden = detail.policy.filter((field) => field.overridden);
  const removalChoices = parentChoices(tree, detail.id);
  const replacementParent = detail.parent?.id ?? '';

  return `
  <div class="card-head">
    <div><p class="eyebrow">Capability details</p><h3>${escape(detail.name)}</h3></div>
    <span class="pill ${detail.delivery ? 'ok' : ''}">${icon(detail.delivery ? 'delivery' : 'collection')}${detail.delivery ? 'delivery' : 'collection'}</span>
    <span class="grow"></span>
    <span class="muted">${escape([...detail.ancestors, detail.id].join(' / '))}</span>
  </div>

  <div class="subsection">
    <div class="card-head">
      <div><h2>${icon('capability')}Relationships</h2>
        <p class="muted">The child stores one parent link. Parent and child views are derived from that same link, so they update together.</p></div>
      <span class="grow"></span>
      <button type="button" class="secondary" data-add="${escape(detail.id)}">Add child</button>
    </div>
    <table>
      <thead><tr><th>Relationship</th><th>Capability</th><th>Kind</th><th>Repository</th></tr></thead>
      <tbody>
        <tr><td>Parent</td><td>${detail.parent
    ? `<button type="button" class="link" data-select="${escape(detail.parent.id)}">${escape(detail.parent.name)}</button>`
    : '<span class="muted">Top level</span>'}</td><td class="muted">—</td><td class="muted">—</td></tr>
        ${detail.children.length ? detail.children.map((child) => `
        <tr><td>Child</td><td><button type="button" class="link" data-select="${escape(child.id)}">${escape(child.name)}</button></td>
          <td class="muted">${escape(child.kind)}</td>
          <td>${child.repository ? `<code>${escape(child.repository)}</code>` : '<span class="muted">—</span>'}</td></tr>`).join('')
    : '<tr><td>Children</td><td colspan="3" class="muted">No direct children.</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="form-grid">
    <label class="field"><span>Display name</span>
      <input type="text" value="${escape(detail.name)}" data-field="name">
    </label>
    <label class="field"><span>Kind</span>
      ${kindSelect(detail.kind)}
      <small>Collection groups related capabilities. Delivery ships from repositories.</small>
    </label>
    <label class="field span-2 relationship-field"><span>Linked under</span>
      ${parentSelect(tree, detail.id, detail.ancestors.at(-1) ?? null)}
      <small>Relink this capability at any time. Self-links and cycles are removed from the list.</small>
    </label>
    <label class="field span-2"><span>Repository</span>
      <input type="text" value="${escape(detail.repository ?? '')}" data-field="repository"
        placeholder="Repository ID">
      <small>Required for Delivery and unavailable to Collection. A Delivery may still contain children.</small>
    </label>
    <label class="field span-2"><span>Application source roots</span>
      <input type="text" value="${escape(detail.sourceRoots.join(', '))}" data-field="sourceRoots"
        placeholder="apps/payments, services/checkout">
      <small>Comma-separated directories used for this capability's lead-repository world model. A child's explicit roots replace inherited application roots.</small>
    </label>
    <label class="field span-2"><span>Shared source roots</span>
      <input type="text" value="${escape(detail.sharedRoots.join(', '))}" data-field="sharedRoots"
        placeholder="libs/contracts, libs/platform">
      <small>Shared directories accumulate down the capability tree and remain in grounding.</small>
    </label>
  </div>

  ${metadataEditor(detail.metadata)}

  <div class="subsection">
    <h2>${icon('jira')}Tracking and ownership</h2>
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
    <button class="secondary" data-add="${escape(detail.id)}">Add one inside</button>
  </p>

  <div class="subsection">
    <div class="card-head">
      <div><h2>${icon('git')}Governed history and removal</h2>
        <p class="muted">Every save or removal is a review proposal. Older approved map revisions remain auditable in Git.</p></div>
      <span class="grow"></span>
      <button type="button" class="secondary" data-review-proposals>Review proposals</button>
    </div>
    ${detail.children.length ? `<label class="field"><span>Move ${detail.children.length === 1 ? 'its child' : `its ${detail.children.length} children`} to</span>
      <select data-remove-target aria-label="Replacement parent for direct children">
        <option value=""${replacementParent ? '' : ' selected'}>Top level (no parent)</option>
        ${removalChoices.map((choice) => `<option value="${escape(choice.id)}"${choice.id === replacementParent ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(choice.depth)}${escape(choice.name)}</option>`).join('')}
      </select>
      <small>Children move atomically in the same reviewed proposal. Descendants are excluded to prevent cycles.</small>
    </label>` : '<p class="muted">This capability has no direct children to move.</p>'}
    <p><button type="button" class="link" data-remove="${escape(detail.id)}" data-child-count="${detail.children.length}">Remove from current map</button></p>
    <p class="remedy">Removal changes the current approved map; it does not erase repository history or previous reviewed versions.</p>
  </div>

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

  ${autoPolicyEditor(detail)}

  ${detail.ships.length ? `
  <h2>${icon('repository')}Ships from</h2>
  <table>
    <thead><tr><th>Capability</th><th>Repository</th></tr></thead>
    <tbody>${detail.ships.map((ship) => `
      <tr><td>${escape(ship.id)}</td><td><code>${escape(ship.repository)}</code></td></tr>`).join('')}</tbody>
  </table>`
    : '<p class="muted">No delivery capability in this subtree names a repository yet.</p>'}`;
}

export function bodyHtml(
  tree: CapabilityNode[],
  selected: string | null,
  error: string | null,
  dashboard?: CapabilityDashboard,
  mode: 'implicit' | 'explicit-legacy' | 'explicit-managed' = 'explicit-legacy'
): string {
  if (mode === 'implicit') return implicitCapabilityHtml(tree, error);
  if (mode === 'explicit-managed') return managedCapabilityHtml(tree, selected, error, dashboard);
  return `
  <header>
    <h1>${icon('capability', { size: 20 })}Capabilities</h1>
    <p class="meta">What this organisation builds, as one or more capability trees of any depth. Jira and teams belong to a
      capability rather than to a workspace: they stay true regardless of who has cloned what.</p>
  </header>
  ${error ? `<section class="plain"><p class="blockers">${escape(error)}</p></section>` : ''}
  ${dashboard ? dashboardHtml(dashboard) : ''}
  <section class="plain">
    ${treeHtml(tree, selected)}
    ${flattenCapabilities(tree).length
    ? `<p><button class="secondary" data-add="${escape(selected ?? '')}">Add a capability${selected ? ' inside this one' : ''}</button></p>`
    : ''}
  </section>
  <section class="editor-card">${selected
    ? detailHtml(tree, selected)
    : '<p class="muted">Choose a capability to see what it delivers, who works on it, and the policy it is held to. Use Add a capability to map a new capability and its Git repository.</p>'}
  </section>`;
}

/**
 * One metadata row, for the script to append when someone adds a pair.
 *
 * Kept out here and embedded with `JSON.stringify` rather than written as a quoted string inside
 * the script, because the icons are multi-line SVG and a raw newline inside a single-quoted
 * JavaScript string is a syntax error. That error is not local to the line that causes it: it stops
 * the whole script parsing, so *every* control on the page goes dead — selecting a capability and
 * adding one included — and the page still renders perfectly, which is why it read as "the buttons
 * do nothing" rather than as a broken build. `JSON.stringify` escapes whatever the icon contains.
 */
const METADATA_ROW_HTML = `<div class="metadata-row" data-metadata-row data-original-key=""><label class="field"><span>Key</span><input type="text" data-metadata-key placeholder="applicationId"></label><label class="field"><span>Value</span><input type="text" data-metadata-value placeholder="APP-1001"></label><button type="button" class="icon-button danger" data-metadata-remove title="Remove metadata" aria-label="Remove metadata pair">${icon('remove')}</button></div>`;

export const SCRIPT = `
  const vscode = window.__sfVscode;
  const read = () => {
    const edits = {};
    for (const field of document.querySelectorAll('[data-field]')) edits[field.dataset.field] = field.value;
    const metadata = [];
    for (const row of document.querySelectorAll('[data-metadata-row]')) {
      const original = row.dataset.originalKey || '';
      const key = row.querySelector('[data-metadata-key]')?.value?.trim() || '';
      const value = row.querySelector('[data-metadata-value]')?.value?.trim() || '';
      const removed = row.dataset.removed === 'true';
      if (original && (removed || key !== original)) metadata.push([original, '']);
      if (!removed && key) metadata.push([key, value]);
    }
    edits.metadata = JSON.stringify(metadata);
    return edits;
  };
  const synchronizeKind = () => {
    const kind = document.querySelector('[data-field="kind"]');
    const repository = document.querySelector('[data-field="repository"]');
    if (!kind || !repository) return;
    repository.disabled = kind.value === 'collection';
    if (repository.disabled) repository.value = '';
  };
  const synchronizeAuto = () => {
    const eligibility = document.querySelector('[data-field="autoEligibility"]');
    if (!eligibility) return;
    const inherited = eligibility.value === 'inherit';
    for (const name of ['autoProtectedScope', 'autoMaximumTouchedPaths', 'autoMaximumConcurrentFlights']) {
      const field = document.querySelector('[data-field="' + name + '"]');
      if (field) field.disabled = inherited;
    }
  };
  synchronizeKind();
  synchronizeAuto();
  document.addEventListener('change', (event) => {
    if (event.target.dataset?.field === 'kind') synchronizeKind();
    if (event.target.dataset?.field === 'autoEligibility') synchronizeAuto();
  });
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-select],[data-add],[data-save],[data-managed-auto-save],[data-remove],[data-review-proposals],[data-metadata-add],[data-metadata-remove],[data-progressive-start],[data-progressive-add],[data-progressive-protect],[data-progressive-why],[data-open-auto-settings]');
    if (!target) return;
    event.preventDefault();
    const data = target.dataset;
    if (data.openAutoSettings !== undefined) vscode.postMessage({ type: 'open-auto-settings' });
    else if (data.progressiveStart !== undefined) vscode.postMessage({ type: 'progressive-start' });
    else if (data.progressiveAdd !== undefined) vscode.postMessage({ type: 'progressive-add' });
    else if (data.progressiveProtect !== undefined) vscode.postMessage({ type: 'progressive-protect' });
    else if (data.progressiveWhy !== undefined) vscode.postMessage({ type: 'progressive-why' });
    else if (data.managedAutoSave !== undefined) vscode.postMessage({ type: 'managed-auto', id: data.managedAutoSave, edits: read() });
    else if (data.metadataAdd !== undefined) {
      document.querySelector('[data-metadata-list]')?.insertAdjacentHTML('beforeend', ${JSON.stringify(METADATA_ROW_HTML)});
    } else if (data.metadataRemove !== undefined) {
      const row = target.closest('[data-metadata-row]');
      if (!row) return;
      if (row.dataset.originalKey) { row.dataset.removed = 'true'; row.hidden = true; }
      else row.remove();
    } else if (data.select !== undefined) vscode.postMessage({ type: 'select', id: data.select });
    else if (data.add !== undefined) vscode.postMessage({ type: 'add', parent: data.add });
    else if (data.remove !== undefined) {
      const replacement = document.querySelector('[data-remove-target]');
      vscode.postMessage({
        type: 'remove',
        id: data.remove,
        childCount: Number(data.childCount || 0),
        reparentChildrenTo: replacement ? (replacement.value || null) : undefined
      });
    }
    else if (data.reviewProposals !== undefined) vscode.postMessage({ type: 'review-proposals' });
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

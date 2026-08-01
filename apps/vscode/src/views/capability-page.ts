/**
 * The capability screen's markup, kept apart from the panel that hosts it.
 *
 * Rendering is where this feature can silently fail — a policy fold computed correctly and then not
 * shown is the same to a reader as one computed wrong — so it lives in a module with no `vscode`
 * import and is tested directly against the tree the engine emits.
 */
import {
  capabilityDetail, flattenCapabilities, formatPolicyValue, parentChoices
} from './capability-model.ts';
import { escape } from './webview.ts';
import type { CapabilityNode } from '../cli/snapshot.ts';

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
          <td>${row.repository ? `<code>${escape(row.repository)}</code>` : '<span class="muted">—</span>'}</td>
          <td class="muted">${escape(row.jira?.projectKey ?? '—')}</td>
          <td class="muted">${escape((row.teams ?? []).join(', ') || '—')}</td>
        </tr>`).join('')}</tbody>
    </table>`;
}

function parentSelect(tree: CapabilityNode[], capabilityId: string | null, current: string | null): string {
  const choices = parentChoices(tree, capabilityId);
  return `<select data-field="parent">
    <option value=""${current ? '' : ' selected'}>— top of the tree —</option>
    ${choices.map((choice) => `<option value="${escape(choice.id)}"${choice.id === current ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(choice.depth)}${escape(choice.name)}</option>`).join('')}
  </select>`;
}

/** The form for a capability that does not exist yet; its identifier is the one field that is fixed. */
function newHtml(tree: CapabilityNode[], parent: string | null): string {
  return `
  <div class="card-head"><h3>New capability</h3></div>
  <p>
    <label>Identifier <input type="text" data-field="id" placeholder="payments-ledger" size="24"></label>
    <label>Name <input type="text" data-field="name" placeholder="Payments Ledger"></label>
  </p>
  <p class="muted">The identifier is permanent and lower-case kebab-case; it is what the ledger,
    the policy fold, and every Story record refer to.</p>
  <p>
    <label>Kind <input type="text" data-field="kind" value="business" size="12"></label>
    <label>Within ${parentSelect(tree, null, parent)}</label>
  </p>
  <p>
    <label>Delivers from <input type="text" data-field="repository"
      placeholder="repository id — leave empty to make this a grouping"></label>
  </p>
  <p class="card-foot">
    <button data-create="1">Add this capability</button>
    <button class="link" data-cancel="1">Cancel</button>
  </p>`;
}

function detailHtml(tree: CapabilityNode[], selected: string): string {
  const detail = capabilityDetail(tree, selected);
  if (!detail) return '<p class="muted">That capability is no longer in the map.</p>';
  const overridden = detail.policy.filter((field) => field.overridden);

  return `
  <div class="card-head">
    <h3>${escape(detail.name)}</h3>
    <span class="pill ${detail.delivery ? 'ok' : ''}">${detail.delivery ? 'delivers' : 'groups'}</span>
    <span class="grow"></span>
    <span class="muted">${escape([...detail.ancestors, detail.id].join(' / '))}</span>
  </div>

  <p>
    <label>Name <input type="text" value="${escape(detail.name)}" data-field="name"></label>
    <label>Kind <input type="text" value="${escape(detail.kind)}" data-field="kind" size="12"></label>
  </p>
  <p>
    <label>Within ${parentSelect(tree, detail.id, detail.ancestors.at(-1) ?? null)}</label>
  </p>
  <p>
    <label>Delivers from <input type="text" value="${escape(detail.repository ?? '')}" data-field="repository"
      placeholder="leave empty to make this a grouping"></label>
  </p>
  <p class="muted">A capability that names a repository is a leaf that ships; one that does not is a
    grouping. Naming a repository is refused while this capability still contains others, and the
    repository has to be one the portfolio declares.</p>

  <h2>Jira</h2>
  <p>
    <label>Project <input type="text" value="${escape(detail.jira?.projectKey ?? '')}" data-field="jira.projectKey" size="14"></label>
    <label>Board <input type="text" value="${escape(detail.jira?.board ?? '')}" data-field="jira.board"></label>
  </p>

  <h2>Teams</h2>
  <p><input type="text" value="${escape(detail.teams.join(', '))}" data-field="teams"
      placeholder="comma separated" size="42"></p>

  <p class="card-foot">
    <button data-save="${escape(detail.id)}">Save changes</button>
    ${detail.delivery ? '' : `<button class="secondary" data-add="${escape(detail.id)}">Add one inside</button>`}
    <button class="link" data-remove="${escape(detail.id)}">Remove</button>
  </p>

  <h2>Policy</h2>
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
  <h2>Ships from</h2>
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
  error: string | null
): string {
  return `
  <header>
    <h1>Capabilities</h1>
    <p class="meta">What this organisation builds, as a tree of any depth. Jira and teams belong to a
      capability rather than to a workspace: they stay true regardless of who has cloned what.</p>
  </header>
  ${error ? `<section class="plain"><p class="blockers">${escape(error)}</p></section>` : ''}
  <section class="plain">
    ${treeHtml(tree, selected)}
    ${flattenCapabilities(tree).length && !adding
    ? `<p><button class="secondary" data-add="${escape(selected ?? '')}">Add a capability${selected ? ' inside this one' : ''}</button></p>`
    : ''}
  </section>
  <section>${adding
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


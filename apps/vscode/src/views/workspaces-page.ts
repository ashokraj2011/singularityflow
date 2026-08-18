/**
 * The Workspaces screen's markup, kept apart from the panel that hosts it.
 *
 * Rendering is where this can silently fail — a collision detected and then not shown is the same to
 * a reader as one not detected — so it lives in a module with no `vscode` import and is tested
 * directly against the rows the registry produces.
 */
import {
  duplicateDirectory, duplicateProblems, type WorkspaceRow, type WorkspaceStatus,
  type WorkspaceRepositoryStatus, type WorkspaceCapabilityChoice
} from './workspaces-model.ts';
import { escape, icon } from './webview.ts';

function rowHtml(row: WorkspaceRow, selected: string | null): string {
  return `
  <tr${row.path === selected ? ' class="drift"' : ''}>
    <td>${row.active ? `<span class="pill ok">${icon('ok')}active</span>` : ''}</td>
    <td><a href="#" data-select="${escape(row.path)}">${escape(row.name)}</a>
      ${row.archived ? '<span class="pill">archived</span>' : ''}</td>
    <td>${icon('directory')}<code>${escape(row.directory)}</code>
      ${row.collides ? `<span class="pill bad">${icon('bad')}shared directory</span>` : ''}</td>
    <td>${row.lead ? `${icon('repository')}<code>${escape(row.lead)}</code>` : '<span class="muted">—</span>'}</td>
    <td>${row.archived
      ? `<button class="secondary" data-restore="${escape(row.path)}">Restore</button>`
      : `<button class="${row.active ? 'secondary' : ''}" data-switch="${escape(row.path)}">
        ${row.active ? 'Reload' : 'Switch'}</button>`}</td>
  </tr>`;
}

function valuePairs(value: Record<string, unknown> | undefined): string {
  const pairs = Object.entries(value ?? {}).filter(([, item]) =>
    ['string', 'number', 'boolean'].includes(typeof item) && String(item).trim());
  if (!pairs.length) return '<span class="muted">Not configured</span>';
  return pairs.map(([key, item]) =>
    `<span class="pill"><strong>${escape(key)}</strong>&nbsp;${escape(item)}</span>`).join(' ');
}

function repositoryDetails(repository: WorkspaceRepositoryStatus, leadId: string): string {
  const worldModel = repository.worldModel?.state ?? 'not available';
  const stateClass = repository.state === 'ready' ? 'ok' : 'bad';
  return `
  <tr>
    <td><strong>${escape(repository.metadata?.name ?? repository.id)}</strong><br>
      <span class="muted">${escape(repository.id)}</span></td>
    <td>${repository.id === leadId || repository.role === 'lead'
      ? '<span class="pill ok">lead</span>' : '<span class="pill">participant</span>'}</td>
    <td><code>${escape(repository.absolutePath ?? repository.path ?? '')}</code></td>
    <td>${repository.branch ? `${icon('branch')}<code>${escape(repository.branch)}</code>` : '<span class="muted">—</span>'}
      ${repository.dirty ? '<br><span class="pill wait">local changes</span>' : ''}</td>
    <td><span class="pill ${stateClass}">${escape(repository.state ?? 'unknown')}</span></td>
    <td><span class="pill ${worldModel === 'available' ? 'ok' : ''}">${escape(worldModel)}</span></td>
  </tr>`;
}

function workspaceDetails(status: WorkspaceStatus | null, loading: boolean, detailError: string | null): string {
  if (loading) return `<div class="card"><p>${icon('wait')} Reading workspace configuration and repository state…</p></div>`;
  if (detailError) return `<div class="card blocked"><p class="blockers">${escape(detailError)}</p></div>`;
  if (!status) return '<p class="muted">Workspace details are unavailable.</p>';

  const capabilities = status.workspace.capabilities ?? [];
  const anchor = status.workspace.anchor;
  const warnings = status.warnings ?? [];
  const repositoryContext = status.repositories.filter((repository) =>
    Object.keys(repository.metadata ?? {}).length || Object.keys(repository.jira ?? {}).length);
  return `
  <div class="card-head">
    <h2>${icon('workspace')}Workspace details</h2>
    <span class="pill ${status.healthy ? 'ok' : 'bad'}">${status.healthy ? 'healthy' : 'needs attention'}</span>
  </div>
  <div class="card">
    <p><strong>Working directory</strong><br><code>${escape(status.workspace.path)}</code></p>
    <p><strong>Lead repository</strong><br><code>${escape(status.leadRepositoryPath)}</code></p>
    <p><strong>Capabilities</strong><br>${capabilities.length
      ? capabilities.map((capability) => `<span class="pill ok">${icon('capability')}${escape(capability)}</span>`).join(' ')
      : '<span class="muted">No capabilities mapped</span>'}</p>
    <p><strong>Work / Jira anchor</strong><br>${anchor
      ? `${valuePairs({ provider: anchor.provider, key: anchor.key, title: anchor.title,
        issueType: anchor.issueTypeName, level: anchor.hierarchyLevel })}`
      : '<span class="muted">No tracker anchor configured</span>'}</p>
  </div>

  <h2>${icon('repository')}Repositories</h2>
  <p class="meta">${escape(status.counts?.ready ?? 0)} of ${escape(status.counts?.repositories ?? status.repositories.length)} ready
    · ${escape(status.counts?.dirty ?? 0)} with local changes · ${escape(status.counts?.worldModels ?? 0)} world models</p>
  <table>
    <thead><tr><th>Repository</th><th>Role</th><th>Working copy</th><th>Branch</th><th>State</th><th>World model</th></tr></thead>
    <tbody>${status.repositories.map((repository) => repositoryDetails(repository, status.workspace.leadRepository)).join('')}</tbody>
  </table>

  ${repositoryContext.length ? `
  <h2>${icon('tracker')}Repository metadata and Jira routing</h2>
  ${repositoryContext.map((repository) => `<div class="card">
    <p><strong>${escape(repository.metadata?.name ?? repository.id)}</strong></p>
    <p><span class="muted">Metadata</span><br>${valuePairs(repository.metadata)}</p>
    <p><span class="muted">Jira</span><br>${valuePairs(repository.jira)}</p>
  </div>`).join('')}` : ''}

  ${warnings.length ? `<h2>${icon('bad')}Warnings</h2>${warnings.map((warning) =>
    `<p class="blockers">${escape(warning.message)}</p>`).join('')}` : ''}`;
}

function detailHtml(
  row: WorkspaceRow,
  rows: WorkspaceRow[],
  draft: DuplicateDraft,
  edit: WorkspaceEditDraft,
  status: WorkspaceStatus | null,
  loading: boolean,
  detailError: string | null
): string {
  const problems = duplicateProblems(row, draft.id, draft.base, rows);
  const target = duplicateDirectory(row, draft.id || '<identifier>', draft.base);
  return `
  <div class="card-head">
    <h3>${icon('workspace')}${escape(row.name)}</h3>
    ${row.active ? `<span class="pill ok">${icon('ok')}active</span>` : ''}
    <span class="grow"></span>
  </div>
  <p class="muted">${icon('directory')}<code>${escape(row.directory)}</code></p>

  ${workspaceDetails(status, loading, detailError)}

  ${archiveWorkspaceHtml(row, status, loading)}

  <h2>${icon('document')}Manage local workspace</h2>
  ${edit.open
    ? workspaceEditHtml(row, status, edit)
    : `<div class="card">
      <div class="card-head"><strong>${escape(row.name)}</strong><span class="grow"></span>
        <button data-edit="${escape(row.path)}">Edit workspace</button></div>
      <p class="muted">Change its name or the capabilities this local working directory is for.
        Repository origins and the directory itself stay fixed after materialization.</p>
    </div>`}

  <h2>${icon('git')}Copy this workspace</h2>
  <p class="question">The same capabilities, repositories and lead, in a different working
    directory. Nothing governed lives in a workspace that a second copy would fork.</p>
  <p>
    <label>Identifier <input type="text" value="${escape(draft.id)}" data-field="copy-id" size="22"
      placeholder="${escape(row.anchorKey)}-spike"></label>
  </p>
  <p>
    <label>Into <input type="text" value="${escape(draft.base)}" data-field="copy-base" size="42"
      placeholder="${escape(row.directory.split('/').slice(0, -1).join('/'))}"></label>
  </p>
  <p class="muted">Leave the directory empty to copy alongside the original.
    <span data-preview="target">${draft.id.trim() ? `The copy would be created at ${escape(target)}.` : ''}</span></p>
  <p class="blockers" data-preview="problems">${problems.map((problem) => escape(problem)).join(' ')}</p>
  <p class="card-foot">
    <button data-duplicate="${escape(row.path)}" ${problems.length || draft.busy ? 'disabled' : ''}>
      ${draft.busy ? 'Copying…' : 'Copy workspace'}
    </button>
    <button class="link" data-forget="${escape(row.path)}">Forget</button>
  </p>
  <p class="muted">Forgetting removes it from this list and leaves the directory alone.</p>`;
}

function archiveWorkspaceHtml(
  row: WorkspaceRow,
  status: WorkspaceStatus | null,
  loading: boolean
): string {
  if (row.archived) {
    return `<h2>${icon('archive')}Archived workspace</h2>
    <div class="card">
      <div class="card-head"><strong>Preserved locally</strong><span class="grow"></span>
        <span class="pill">archived</span></div>
      <p class="muted">Its checkout, branches and generated artifacts were not deleted. Restore it
        before selecting it for governed work.</p>
      <p class="card-foot"><button data-restore="${escape(row.path)}">Restore workspace</button></p>
    </div>`;
  }

  const readiness = status?.archiveReadiness;
  const activeStories = readiness?.activeStories ?? [];
  const blockers = readiness?.blockers ?? [];
  const eligible = Boolean(readiness?.eligible);
  return `<h2>${icon('archive')}Archive workspace</h2>
  <div class="card">
    <div class="card-head"><strong>${eligible ? 'Ready to archive' : 'Active work is protected'}</strong>
      <span class="grow"></span><span class="pill ${eligible ? 'ok' : activeStories.length || blockers.length ? 'wait' : ''}">
      ${loading ? 'checking' : eligible ? 'no active Stories' : `${activeStories.length} active`}</span></div>
    <p class="muted">Archiving removes this workspace from the active list. Its directory, Git
      branches and generated artifacts remain exactly where they are.</p>
    ${activeStories.length ? `<table>
      <thead><tr><th>Story</th><th>Repository</th><th>Status</th><th>Phase</th></tr></thead>
      <tbody>${activeStories.map((story) => `<tr><td><strong>${escape(story.id)}</strong><br><span class="muted">${escape(story.title)}</span></td>
        <td><code>${escape(story.repository)}</code></td><td>${escape(story.status)}</td>
        <td>${story.phase ? escape(story.phase) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody>
    </table>` : ''}
    ${blockers.map((blocker) => `<p class="blockers">${escape(blocker)}</p>`).join('')}
    <p class="card-foot"><button class="secondary" data-archive="${escape(row.path)}"${eligible ? '' : ' disabled'}>
      Archive workspace</button></p>
    ${eligible ? '<p class="muted">The final archive action refreshes every remote and checks again before changing the local registry.</p>' : ''}
  </div>`;
}

export interface DuplicateDraft { id: string; base: string; busy: boolean }

export interface WorkspaceEditDraft {
  open: boolean;
  name: string;
  capabilities: string[];
  busy: boolean;
}

export const EMPTY_DRAFT: DuplicateDraft = { id: '', base: '', busy: false };
export const EMPTY_EDIT_DRAFT: WorkspaceEditDraft = {
  open: false, name: '', capabilities: [], busy: false
};

function capabilityLabel(choice: WorkspaceCapabilityChoice | undefined, id: string): string {
  return choice?.name ?? id;
}

/** The editable part of a workspace: its label and which governed capabilities it covers. */
function workspaceEditHtml(
  row: WorkspaceRow,
  status: WorkspaceStatus | null,
  edit: WorkspaceEditDraft
): string {
  const choices = status?.availableCapabilities ?? [];
  const selected = new Set(edit.capabilities);
  const materializedRepositories = new Set((status?.repositories ?? []).map((repository) => repository.id));
  const covered = (choice: WorkspaceCapabilityChoice): boolean =>
    selected.has(choice.id) || choice.ancestors.some((ancestor) => selected.has(ancestor));
  const withinBoundary = (choice: WorkspaceCapabilityChoice): boolean => choices
    .filter((entry) => entry.id === choice.id || entry.ancestors.includes(choice.id))
    .every((entry) => !entry.repository || materializedRepositories.has(entry.repository));
  const offered = choices.filter((choice) => !covered(choice) && withinBoundary(choice));
  const outsideBoundary = choices.filter((choice) => !covered(choice) && !withinBoundary(choice));
  const problems = [
    ...(!edit.name.trim() ? ['Give the workspace a name.'] : []),
    ...(!edit.capabilities.length ? ['Choose at least one capability.'] : [])
  ];

  return `<div class="card yours">
    <div class="card-head"><strong>Edit workspace</strong><span class="grow"></span>
      <span class="pill">local configuration</span></div>
    <div class="form-grid">
      <label class="field span-2"><span>Name</span>
        <input type="text" value="${escape(edit.name)}" data-field="edit-name">
      </label>
      <label class="field span-2"><span>Add capability</span>
        <span class="card-foot"><select data-edit-capability-pick>
          <option value="">Choose a capability…</option>
          ${offered.map((choice) => `<option value="${escape(choice.id)}">${'&nbsp;&nbsp;'.repeat(choice.depth)}${escape(choice.name)}${choice.repository ? ` (${escape(choice.repository)})` : ''}</option>`).join('')}
        </select><button class="secondary" data-edit-add="1"${offered.length ? '' : ' disabled'}>Add</button></span>
      </label>
    </div>
    ${edit.capabilities.length ? `<table>
      <thead><tr><th>Capability</th><th>Coverage</th><th></th></tr></thead>
      <tbody>${edit.capabilities.map((id) => {
        const choice = choices.find((entry) => entry.id === id);
        const beneath = choices.filter((entry) => entry.ancestors.includes(id));
        return `<tr><td>${icon('capability')}<strong>${escape(capabilityLabel(choice, id))}</strong></td>
          <td class="muted">${beneath.length ? `Includes ${beneath.length} beneath it` : (choice?.repository ? `Ships from ${escape(choice.repository)}` : 'Grouping')}</td>
          <td><button class="link" data-edit-remove="${escape(id)}">Remove</button></td></tr>`;
      }).join('')}</tbody>
    </table>` : '<p class="blockers">Choose at least one capability.</p>'}
    ${!choices.length ? `<p class="muted">The full capability map is not available right now.
      Existing selections can still be preserved while the workspace name is changed.</p>` : ''}
    ${outsideBoundary.length ? `<p class="muted">${escape(outsideBoundary.length)} additional ${outsideBoundary.length === 1 ? 'capability needs' : 'capabilities need'} repositories this workspace has not materialized. Copy or replace the workspace to change that boundary.</p>` : ''}
    ${problems.length ? `<p class="blockers">${problems.map(escape).join(' ')}</p>` : ''}
    <p class="card-foot">
      <button data-edit-save="${escape(row.path)}"${problems.length || edit.busy ? ' disabled' : ''}>${edit.busy ? 'Saving…' : 'Save workspace'}</button>
      <button class="secondary" data-edit-cancel="1"${edit.busy ? ' disabled' : ''}>Cancel</button>
    </p>
    <p class="muted">The working directory and existing repository checkouts cannot be changed in
      place. Use Copy workspace when those boundaries need to move.</p>
  </div>`;
}

export function workspacesHtml(
  rows: WorkspaceRow[],
  selected: string | null,
  draft: DuplicateDraft,
  error: string | null,
  status: WorkspaceStatus | null = null,
  loading = false,
  detailError: string | null = null,
  edit: WorkspaceEditDraft = EMPTY_EDIT_DRAFT
): string {
  const row = rows.find((entry) => entry.path === selected) ?? null;
  const collisions = rows.filter((entry) => entry.collides);
  return `
  <header>
    <h1>${icon('workspace', { size: 20 })}Workspaces</h1>
    <p class="meta">A working directory and the capabilities worked on in it. Local, editable and
      copyable — no two may share a directory.</p>
  </header>

  ${error ? `<section class="plain"><p class="blockers">${escape(error)}</p></section>` : ''}
  ${collisions.length ? `
  <section class="plain">
    <p class="blockers">${collisions.length} workspaces share a working directory. Two sets of
      governed state writing into one tree is not a conflict to resolve later — forget one, or copy
      it somewhere of its own.</p>
  </section>` : ''}

  <section class="plain">
    ${rows.length ? `
    <table>
      <thead><tr><th></th><th>Workspace</th><th>Working directory</th><th>Lead</th><th></th></tr></thead>
      <tbody>${rows.map((entry) => rowHtml(entry, selected)).join('')}</tbody>
    </table>` : '<p class="muted">No workspaces yet.</p>'}
    <p><button class="secondary" data-create="new">Create a workspace</button>
      <button class="secondary" data-adopt="existing">Use an existing clone</button></p>
  </section>

  <section>${row
    ? detailHtml(row, rows, draft, edit, status, loading, detailError)
    : '<p class="muted">Choose a workspace name to see its working directory, repositories, capabilities and Jira context.</p>'}</section>
  <div hidden data-context="${escape(JSON.stringify({
    parent: row ? row.directory.split('/').slice(0, -1).join('/') : '',
    taken: rows.map((entry) => entry.directory)
  }))}"></div>`;
}

export const WORKSPACES_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-select],[data-switch],[data-rename],[data-duplicate],[data-forget],[data-create],[data-adopt],[data-edit],[data-edit-add],[data-edit-remove],[data-edit-save],[data-edit-cancel],[data-archive],[data-restore]');
    if (!target) return;
    event.preventDefault();
    const data = target.dataset;
    const value = (field) => document.querySelector('[data-field="' + field + '"]')?.value ?? '';
    if (data.select !== undefined) vscode.postMessage({ type: 'select', path: data.select });
    else if (data.switch !== undefined) vscode.postMessage({ type: 'switch', path: data.switch });
    else if (data.create !== undefined) vscode.postMessage({ type: 'create' });
    else if (data.adopt !== undefined) vscode.postMessage({ type: 'adopt' });
    else if (data.forget !== undefined) vscode.postMessage({ type: 'forget', path: data.forget });
    else if (data.archive !== undefined) vscode.postMessage({ type: 'archive', path: data.archive });
    else if (data.restore !== undefined) vscode.postMessage({ type: 'restore', path: data.restore });
    else if (data.rename !== undefined) vscode.postMessage({ type: 'rename', path: data.rename, name: value('name') });
    else if (data.edit !== undefined) vscode.postMessage({ type: 'edit', path: data.edit });
    else if (data.editCancel !== undefined) vscode.postMessage({ type: 'edit-cancel' });
    else if (data.editAdd !== undefined) {
      const pick = document.querySelector('[data-edit-capability-pick]');
      if (pick && pick.value) vscode.postMessage({ type: 'edit-capability', id: pick.value, selected: true });
    }
    else if (data.editRemove !== undefined) vscode.postMessage({ type: 'edit-capability', id: data.editRemove, selected: false });
    else if (data.editSave !== undefined) vscode.postMessage({
      type: 'edit-save', path: data.editSave, name: value('edit-name')
    });
    else if (data.duplicate !== undefined) {
      vscode.postMessage({ type: 'duplicate', path: data.duplicate, id: value('copy-id'), base: value('copy-base') });
    }
  });
  /**
   * The draft is reported so the copy never has to trust what the page sends with it — but the
   * panel does NOT re-render in response, because that would replace the field being typed into.
   * Where the copy would land, and whether that directory is taken, are answered here instead. The
   * panel re-checks both before running anything, and the engine refuses regardless.
   */
  const context = JSON.parse(document.querySelector('[data-context]')?.dataset.context ?? '{}');
  const affordances = () => {
    const id = (document.querySelector('[data-field="copy-id"]')?.value ?? '').trim();
    const base = (document.querySelector('[data-field="copy-base"]')?.value ?? '').trim();
    const target = (base || context.parent || '') + '/' + id;
    const taken = (context.taken ?? []).find((entry) => entry.toLowerCase() === target.toLowerCase());
    const preview = document.querySelector('[data-preview="target"]');
    const problems = document.querySelector('[data-preview="problems"]');
    const button = document.querySelector('[data-duplicate]');
    const named = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
    if (preview) preview.textContent = id ? 'The copy would be created at ' + target + '.' : '';
    if (problems) {
      problems.textContent = !id ? 'Give the copy an identifier.'
        : !named ? 'The identifier may contain letters, numbers, dots, underscores and hyphens.'
          : taken ? target + ' is already a workspace. No two workspaces may share a working directory.'
            : '';
    }
    if (button) button.disabled = !id || !named || Boolean(taken);
  };
  document.addEventListener('input', (event) => {
    const field = event.target.dataset?.field;
    if (field === 'edit-name') {
      vscode.postMessage({ type: 'edit-draft', field, value: event.target.value });
      return;
    }
    if (field !== 'copy-id' && field !== 'copy-base') return;
    vscode.postMessage({ type: 'draft', field, value: event.target.value });
    affordances();
  });
`;

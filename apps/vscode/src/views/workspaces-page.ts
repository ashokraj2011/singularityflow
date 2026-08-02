/**
 * The Workspaces screen's markup, kept apart from the panel that hosts it.
 *
 * Rendering is where this can silently fail — a collision detected and then not shown is the same to
 * a reader as one not detected — so it lives in a module with no `vscode` import and is tested
 * directly against the rows the registry produces.
 */
import {
  duplicateDirectory, duplicateProblems, type WorkspaceRow
} from './workspaces-model.ts';
import { escape, icon } from './webview.ts';

function rowHtml(row: WorkspaceRow, selected: string | null): string {
  return `
  <tr${row.id === selected ? ' class="drift"' : ''}>
    <td>${row.active ? `<span class="pill ok">${icon('ok')}active</span>` : ''}</td>
    <td><a href="#" data-select="${escape(row.path)}">${escape(row.name)}</a>
      ${row.archived ? '<span class="pill">archived</span>' : ''}</td>
    <td>${icon('directory')}<code>${escape(row.directory)}</code>
      ${row.collides ? `<span class="pill bad">${icon('bad')}shared directory</span>` : ''}</td>
    <td>${row.lead ? `${icon('repository')}<code>${escape(row.lead)}</code>` : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function detailHtml(row: WorkspaceRow, rows: WorkspaceRow[], draft: DuplicateDraft): string {
  const problems = duplicateProblems(row, draft.id, draft.base, rows);
  const target = duplicateDirectory(row, draft.id || '<identifier>', draft.base);
  return `
  <div class="card-head">
    <h3>${icon('workspace')}${escape(row.name)}</h3>
    ${row.active ? `<span class="pill ok">${icon('ok')}active</span>` : ''}
    <span class="grow"></span>
    <button class="link" data-open="${escape(row.path)}">Open</button>
  </div>
  <p class="muted">${icon('directory')}<code>${escape(row.directory)}</code></p>

  <h2>${icon('document')}Rename</h2>
  <p>
    <label>Name <input type="text" value="${escape(row.name)}" data-field="name" size="34"></label>
    <button class="secondary" data-rename="${escape(row.path)}">Rename</button>
  </p>
  <p class="muted">A workspace is a local convenience, so its name is editable. The working
    directory is not: it was fixed when the workspace was created, and moving it is a copy.</p>

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

export interface DuplicateDraft { id: string; base: string; busy: boolean }

export const EMPTY_DRAFT: DuplicateDraft = { id: '', base: '', busy: false };

export function workspacesHtml(
  rows: WorkspaceRow[],
  selected: string | null,
  draft: DuplicateDraft,
  error: string | null
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
      <thead><tr><th></th><th>Workspace</th><th>Working directory</th><th>Lead</th></tr></thead>
      <tbody>${rows.map((entry) => rowHtml(entry, selected)).join('')}</tbody>
    </table>` : '<p class="muted">No workspaces yet.</p>'}
    <p><button class="secondary" data-create="new">Create a workspace</button></p>
  </section>

  <section>${row
    ? detailHtml(row, rows, draft)
    : '<p class="muted">Choose a workspace to rename it, copy it, or open it.</p>'}</section>
  <div hidden data-context="${escape(JSON.stringify({
    parent: row ? row.directory.split('/').slice(0, -1).join('/') : '',
    taken: rows.map((entry) => entry.directory)
  }))}"></div>`;
}

export const WORKSPACES_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-select],[data-open],[data-rename],[data-duplicate],[data-forget],[data-create]');
    if (!target) return;
    event.preventDefault();
    const data = target.dataset;
    const value = (field) => document.querySelector('[data-field="' + field + '"]')?.value ?? '';
    if (data.select !== undefined) vscode.postMessage({ type: 'select', path: data.select });
    else if (data.open !== undefined) vscode.postMessage({ type: 'open', path: data.open });
    else if (data.create !== undefined) vscode.postMessage({ type: 'create' });
    else if (data.forget !== undefined) vscode.postMessage({ type: 'forget', path: data.forget });
    else if (data.rename !== undefined) vscode.postMessage({ type: 'rename', path: data.rename, name: value('name') });
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
    if (field !== 'copy-id' && field !== 'copy-base') return;
    vscode.postMessage({ type: 'draft', field, value: event.target.value });
    affordances();
  });
`;

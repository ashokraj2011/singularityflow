/**
 * The workspace form.
 *
 * A workspace is the root concept: the set of repositories a team governs together, one of them
 * nominated lead. Collecting that through a chain of input boxes was wrong for it — you cannot see
 * what you have added, cannot correct a row, and cannot compare two repositories before choosing
 * which leads. This is a form, because that is what the thing is.
 *
 * Repositories are added by choosing checkouts you already have, and every field is read from the
 * checkout: the origin URL, the default branch from origin/HEAD, and an identifier from the folder
 * name. Typing a clone URL is how a workspace ends up pointing at the wrong fork.
 */
import { escape } from './webview.ts';

export interface FormRepository {
  id: string;
  url: string;
  defaultBranch: string;
  localPath: string;
}

export interface WorkspaceForm {
  base: string | null;
  id: string;
  name: string;
  repositories: FormRepository[];
  lead: string | null;
  /** Set while the CLI is running, so the form can say so and refuse a second submit. */
  busy: boolean;
  error: string | null;
}

export const EMPTY_FORM: WorkspaceForm = {
  base: null, id: '', name: '', repositories: [], lead: null, busy: false, error: null
};

/**
 * What still stands between this form and a workspace.
 *
 * Returned as a list rather than a boolean so the form can show every outstanding requirement at
 * once; revealing them one at a time is how a five-field form takes five attempts.
 */
export function formProblems(form: WorkspaceForm): string[] {
  const problems: string[] = [];
  if (!form.base) problems.push('Choose where the workspace directory should be created.');
  if (!form.id.trim()) problems.push('Give the workspace an identifier.');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.id.trim())) {
    problems.push('The identifier may contain letters, numbers, dots, underscores and hyphens.');
  }
  if (!form.repositories.length) problems.push('Add at least one repository.');
  if (form.repositories.length && !form.lead) problems.push('Choose which repository leads.');

  const ids = form.repositories.map((repository) => repository.id);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicated)) problems.push(`More than one repository is called '${id}'.`);
  return problems;
}

/** The argv this form describes, once it has no problems. */
export function formCommand(form: WorkspaceForm): string[] {
  const args = ['workspace', 'create', '--local', '--json',
    '--id', form.id.trim(), '--base', form.base ?? '',
    '--lead', form.lead ?? '', '--confirm', form.id.trim()];
  if (form.name.trim()) args.push('--name', form.name.trim());
  for (const repository of form.repositories) args.push('--repository', `${repository.id}=${repository.url}`);
  return args;
}

function repositoryRows(form: WorkspaceForm): string {
  if (!form.repositories.length) {
    return `<tr><td colspan="5" class="muted">No repositories yet. Add the checkouts this workspace governs.</td></tr>`;
  }
  return form.repositories.map((repository) => `
    <tr>
      <td><input type="radio" name="lead" value="${escape(repository.id)}" data-lead="${escape(repository.id)}"
        ${form.lead === repository.id ? 'checked' : ''} title="Lead repository"></td>
      <td><input type="text" value="${escape(repository.id)}" data-id="${escape(repository.id)}" size="18"></td>
      <td><code>${escape(repository.url)}</code></td>
      <td>${escape(repository.defaultBranch)}</td>
      <td><button class="link" data-remove="${escape(repository.id)}" title="Remove">Remove</button></td>
    </tr>`).join('');
}

export function workspaceFormHtml(form: WorkspaceForm): string {
  const problems = formProblems(form);
  return `
  <header>
    <h1>New workspace</h1>
    <p class="meta">The repositories a team governs together, and the one that holds the governed state.</p>
  </header>

  <section class="plain">
    <h2>Location</h2>
    <p>
      <button data-choose="base">Choose folder…</button>
      ${form.base ? `<code>${escape(form.base)}</code>` : '<span class="muted">Not chosen</span>'}
    </p>
  </section>

  <section>
    <h2>Identity</h2>
    <p>
      <label>Identifier <input type="text" value="${escape(form.id)}" data-field="id" placeholder="checkout-platform"></label>
    </p>
    <p>
      <label>Name <input type="text" value="${escape(form.name)}" data-field="name" placeholder="Checkout platform" size="32"></label>
    </p>
  </section>

  <section>
    <h2>Repositories</h2>
    <p class="question">Added from checkouts you already have. The origin URL and default branch are read from each one.</p>
    <table>
      <thead><tr><th>Lead</th><th>Identifier</th><th>Origin</th><th>Branch</th><th></th></tr></thead>
      <tbody>${repositoryRows(form)}</tbody>
    </table>
    <p><button data-choose="repositories">Add repositories…</button></p>
  </section>

  <section>
    ${problems.length
    ? `<h2>Before this can be created</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>Ready</h2><p class="ok-text">${form.repositories.length} ${form.repositories.length === 1 ? 'repository' : 'repositories'} will be cloned into <code>${escape(form.base ?? '')}/${escape(form.id.trim())}</code>, with <code>${escape(form.lead ?? '')}</code> as lead.</p>`}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-submit="create" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy ? 'Creating…' : 'Create workspace'}
      </button>
    </p>
  </section>`;
}

/** The page reports intent; every value is re-validated here before it reaches the CLI. */
export const WORKSPACE_FORM_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-choose],[data-remove],[data-submit],[data-lead]');
    if (!target) return;
    if (target.dataset.choose) vscode.postMessage({ type: 'choose', what: target.dataset.choose });
    else if (target.dataset.remove) vscode.postMessage({ type: 'remove', id: target.dataset.remove });
    else if (target.dataset.lead) vscode.postMessage({ type: 'lead', id: target.dataset.lead });
    else if (target.dataset.submit) vscode.postMessage({ type: 'create' });
  });
  document.addEventListener('change', (event) => {
    const field = event.target.dataset?.field;
    if (field) return vscode.postMessage({ type: 'field', field, value: event.target.value });
    const id = event.target.dataset?.id;
    if (id) vscode.postMessage({ type: 'rename', id, value: event.target.value });
  });
`;

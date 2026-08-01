/**
 * The workspace form.
 *
 * A workspace is the root concept: the set of repositories a team governs together, one of them
 * nominated lead. Collecting that through a chain of input boxes was wrong for it — you cannot see
 * what you have added, cannot correct a row, and cannot compare two repositories before choosing
 * which leads. This is a form, because that is what the thing is.
 *
 * Repositories are added by clone URL, because nothing needs to be checked out first — the platform
 * clones. Only the URL is asked for: the identifier, the default branch and whether the state branch
 * already exists are read from the remote with ls-remote, so a wrong URL is caught while somebody is
 * still looking at it rather than when a clone fails minutes later.
 */
import { escape } from './webview.ts';

export interface FormRepository {
  id: string;
  url: string;
  defaultBranch: string;
  /** Whether this repository already carries the workflow state branch. */
  hasStateBranch: boolean;
  /** Which branch that was looked for, so the column can say what it checked. */
  stateBranch: string;
}

/** The repository being described but not yet added. */
export interface RepositoryDraft {
  url: string;
  /** Optional: read from the URL when left empty. */
  id: string;
  lead: boolean;
}

export interface WorkspaceForm {
  base: string | null;
  id: string;
  name: string;
  repositories: FormRepository[];
  lead: string | null;
  draft: RepositoryDraft;
  /** Set while a remote is being read, so the form can say which one and refuse a second add. */
  adding: boolean;
  /** Set while the CLI is running, so the form can say so and refuse a second submit. */
  busy: boolean;
  error: string | null;
}

export const EMPTY_DRAFT: RepositoryDraft = { url: '', id: '', lead: false };

export const EMPTY_FORM: WorkspaceForm = {
  base: null, id: '', name: '', repositories: [], lead: null,
  draft: { ...EMPTY_DRAFT }, adding: false, busy: false, error: null
};

/** The URLs a draft names. Several may be pasted at once; whitespace and commas separate them. */
export function draftUrls(draft: RepositoryDraft): string[] {
  return draft.url.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean);
}

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
    return `<tr><td colspan="6" class="muted">No repositories yet. Add the repositories this workspace governs, by URL.</td></tr>`;
  }
  return form.repositories.map((repository) => `
    <tr>
      <td><input type="radio" name="lead" value="${escape(repository.id)}" data-lead="${escape(repository.id)}"
        ${form.lead === repository.id ? 'checked' : ''} title="Lead repository"></td>
      <td><input type="text" value="${escape(repository.id)}" data-id="${escape(repository.id)}" size="18"></td>
      <td><code>${escape(repository.url)}</code></td>
      <td>${escape(repository.defaultBranch)}</td>
      <td>${repository.hasStateBranch
        ? `<span class="pill ok">${escape(repository.stateBranch)}</span>`
        : '<span class="muted">none yet</span>'}</td>
      <td><button class="link" data-remove="${escape(repository.id)}" title="Remove">Remove</button></td>
    </tr>`).join('');
}

/**
 * The form for the repository being added.
 *
 * Inline rather than a prompt, for the same reason the rest of this is a form: a prompt shows one
 * field, cannot be corrected without starting over, and hides the rows you already have while you
 * type. Only the URL is required — the identifier, the default branch and whether the state branch
 * exists are all read from the remote, and the first two are shown here so a mistyped URL is caught
 * before anything is cloned.
 */
function addRepositoryHtml(form: WorkspaceForm): string {
  const urls = draftUrls(form.draft);
  const several = urls.length > 1;
  const disabled = form.adding ? ' disabled' : '';
  return `
  <div class="card">
    <div class="card-head"><h3>Add a repository</h3></div>
    <p>
      <label>Clone URL <input type="text" value="${escape(form.draft.url)}" data-draft="url" size="46"
        placeholder="https://github.com/org/service.git"${disabled}></label>
    </p>
    <p>
      <label>Identifier <input type="text" value="${escape(form.draft.id)}" data-draft="id" size="20"
        placeholder="read from the URL"${form.adding || several ? ' disabled' : ''}></label>
      <label><input type="checkbox" data-draft="lead"${form.draft.lead ? ' checked' : ''}${disabled}> Leads this workspace</label>
    </p>
    <p class="muted">Nothing is cloned yet: the default branch and whether the <code>state</code>
      branch already exists are read from the remote.
      <span data-hint="urls">${several
    ? `<strong>${urls.length} URLs given</strong> — each is added under the identifier read from its own URL.`
    : 'Paste several URLs separated by spaces to add them at once.'}</span></p>
    <p class="card-foot">
      <button data-add="repository"${form.adding || !urls.length ? ' disabled' : ''}>
        ${form.adding ? 'Reading the remote…' : several ? `Add ${urls.length} repositories` : 'Add repository'}
      </button>
    </p>
  </div>`;
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
      <button class="secondary" data-choose="base">Choose folder…</button>
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
    <p class="question">Added by clone URL — nothing needs to be checked out first. The default branch and
      whether the workflow state branch already exists are read from each remote.</p>
    <table>
      <thead><tr><th>Lead</th><th>Identifier</th><th>Origin</th><th>Branch</th><th>State</th><th></th></tr></thead>
      <tbody>${repositoryRows(form)}</tbody>
    </table>
    ${addRepositoryHtml(form)}
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
    const target = event.target.closest('[data-choose],[data-remove],[data-submit],[data-lead],[data-add]');
    if (!target) return;
    if (target.dataset.choose) vscode.postMessage({ type: 'choose', what: target.dataset.choose });
    else if (target.dataset.remove) vscode.postMessage({ type: 'remove', id: target.dataset.remove });
    else if (target.dataset.lead) vscode.postMessage({ type: 'lead', id: target.dataset.lead });
    else if (target.dataset.add) vscode.postMessage({ type: 'add' });
    else if (target.dataset.submit) vscode.postMessage({ type: 'create' });
  });
  /**
   * The draft is reported as it is typed so 'add' never has to trust what the page sends with it —
   * but the panel does NOT re-render in response, because replacing the document on every keystroke
   * would take the caret with it. The affordances that depend on what is typed are therefore updated
   * here, in the page, where they are presentation and nothing else.
   */
  const affordances = () => {
    const url = document.querySelector('[data-draft="url"]');
    const identifier = document.querySelector('[data-draft="id"]');
    const button = document.querySelector('[data-add]');
    const hint = document.querySelector('[data-hint="urls"]');
    if (!url || !button) return;
    const urls = url.value.split(/[\\s,]+/).map((value) => value.trim()).filter(Boolean);
    button.disabled = urls.length === 0;
    button.textContent = urls.length > 1 ? 'Add ' + urls.length + ' repositories' : 'Add repository';
    if (identifier) identifier.disabled = urls.length > 1;
    if (hint) {
      hint.textContent = urls.length > 1
        ? urls.length + ' URLs given — each is added under the identifier read from its own URL.'
        : 'Paste several URLs separated by spaces to add them at once.';
    }
  };
  const draft = (event) => {
    const field = event.target.dataset?.draft;
    if (!field) return false;
    vscode.postMessage({
      type: 'draft', field,
      value: event.target.type === 'checkbox' ? event.target.checked : event.target.value
    });
    return true;
  };
  document.addEventListener('input', (event) => { if (draft(event)) affordances(); });
  document.addEventListener('change', (event) => {
    if (draft(event)) return;
    const field = event.target.dataset?.field;
    if (field) return vscode.postMessage({ type: 'field', field, value: event.target.value });
    const id = event.target.dataset?.id;
    if (id) vscode.postMessage({ type: 'rename', id, value: event.target.value });
  });
  // Enter in the URL field adds, because that is what Enter in a one-field form means.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.target.dataset?.draft !== 'url') return;
    event.preventDefault();
    vscode.postMessage({ type: 'add' });
  });
`;

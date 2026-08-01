/**
 * The workspace form.
 *
 * A workspace is a set of capabilities and a working directory. That is the whole concept: the
 * repositories are not the thing being chosen, they are what the chosen capabilities deliver from.
 * So the form asks in those terms and derives the rest.
 *
 * The order is forced by where the map lives. `singularity/capabilities.yml` is held by the lead
 * repository, so the lead has to be named — by URL, since nothing is cloned yet — before there is
 * anything to choose from. Once it is read, the capability tree is the form, and the repositories
 * below it are a consequence shown for confirmation rather than a list to curate.
 *
 * A lead that does not describe what it builds is a normal state for a new organisation, not a
 * failure. In that case the form falls back to naming repositories by URL, and says that describing
 * capabilities is the thing to do next.
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

/** One capability from the lead repository's map. */
export interface CapabilityChoice {
  id: string;
  name: string;
  depth: number;
  ancestors: string[];
  /** The repository this capability delivers from; null for a grouping. */
  repository: string | null;
  /** Where that repository is cloned from, or null when the portfolio does not declare it. */
  url: string | null;
  defaultBranch: string;
}

/** The repository being described but not yet added, in the no-map fallback. */
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
  /** The repository holding the capability map. Named first; everything else follows from it. */
  lead: FormRepository | null;
  /** What is typed into the lead field before it has been read. */
  leadDraft: string;
  /** The lead's capability map; null until it has been read, or when it has none. */
  capabilities: CapabilityChoice[] | null;
  /** Why there is no map, when there is none. */
  capabilitiesReason: string | null;
  /** The capabilities this workspace is for. */
  selected: string[];
  /** Only used when the lead has no map: repositories named directly. */
  repositories: FormRepository[];
  draft: RepositoryDraft;
  /** Set while a remote is being read, so the form can say so and refuse a second add. */
  adding: boolean;
  /** Set while the CLI is running, so the form can say so and refuse a second submit. */
  busy: boolean;
  error: string | null;
}

export const EMPTY_DRAFT: RepositoryDraft = { url: '', id: '', lead: false };

export const EMPTY_FORM: WorkspaceForm = {
  base: null, id: '', name: '', lead: null, leadDraft: '',
  capabilities: null, capabilitiesReason: null, selected: [],
  repositories: [], draft: { ...EMPTY_DRAFT }, adding: false, busy: false, error: null
};

/** The URLs a draft names. Several may be pasted at once; whitespace and commas separate them. */
export function draftUrls(draft: RepositoryDraft): string[] {
  return draft.url.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean);
}

/** The nested tree and the flat delivery list, as `workspace capabilities --json` returns them. */
export interface RemoteCapability {
  id: string;
  name: string;
  repository?: string | null;
  children?: RemoteCapability[];
}
export interface RemoteDelivery { id: string; url: string | null; defaultBranch?: string }

/**
 * Flatten the lead's map into rows the form can list, carrying each delivery's clone URL across.
 *
 * The engine returns the tree and the deliveries separately because they answer different questions;
 * the form asks both at once — what this is, and whether it can be cloned — so they are joined here.
 */
export function flattenChoices(
  tree: RemoteCapability[],
  deliveries: RemoteDelivery[],
  ancestors: string[] = []
): CapabilityChoice[] {
  const byId = new Map(deliveries.map((delivery) => [delivery.id, delivery]));
  const walk = (nodes: RemoteCapability[], chain: string[]): CapabilityChoice[] =>
    nodes.flatMap((node) => [
      {
        id: node.id,
        name: node.name,
        depth: chain.length,
        ancestors: chain,
        repository: node.repository ?? null,
        url: byId.get(node.id)?.url ?? null,
        defaultBranch: byId.get(node.id)?.defaultBranch ?? 'main'
      },
      ...walk(node.children ?? [], [...chain, node.id])
    ]);
  return walk(tree, ancestors);
}

/** Whether the lead described what it builds. Decides which half of the form applies. */
export function hasCapabilityMap(form: WorkspaceForm): boolean {
  return Boolean(form.capabilities?.length);
}

/**
 * Which capabilities a selection actually covers.
 *
 * Selecting a grouping means the things beneath it, the way selecting a directory means its
 * contents. Recorded as the selection made rather than the expansion of it, so a capability added to
 * the map later is picked up by a workspace that asked for its parent.
 */
export function coveredCapabilities(form: WorkspaceForm): CapabilityChoice[] {
  const chosen = new Set(form.selected);
  return (form.capabilities ?? []).filter((capability) =>
    chosen.has(capability.id) || capability.ancestors.some((ancestor) => chosen.has(ancestor)));
}

/**
 * The repositories a selection implies: what the covered capabilities deliver from, plus the lead.
 *
 * The lead is always present — it holds the map and the governed state, so a workspace without it
 * could not read its own configuration.
 */
export function derivedRepositories(form: WorkspaceForm): FormRepository[] {
  // The fallback path names its repositories directly, but the lead is one of them either way: it is
  // a repository like any other, and a workspace of nothing but a lead is a perfectly good
  // workspace. Concatenated rather than keyed, because two repositories sharing an identifier is a
  // conflict formProblems has to be able to see — collapsing them here would resolve it silently.
  if (!hasCapabilityMap(form)) {
    const named = form.repositories.filter((entry) => entry.url !== form.lead?.url);
    return form.lead ? [form.lead, ...named] : named;
  }
  // The derived path cannot produce a duplicate: it is keyed by the repository each capability
  // names, and two capabilities naming the same repository means one clone, not two.
  const byId = new Map<string, FormRepository>();
  if (form.lead) byId.set(form.lead.id, form.lead);
  for (const capability of coveredCapabilities(form)) {
    if (!capability.repository || !capability.url || byId.has(capability.repository)) continue;
    byId.set(capability.repository, {
      id: capability.repository,
      url: capability.url,
      defaultBranch: capability.defaultBranch,
      hasStateBranch: false,
      stateBranch: 'state'
    });
  }
  return [...byId.values()];
}

/** Covered capabilities that name a repository the portfolio does not declare. */
export function uncloneable(form: WorkspaceForm): CapabilityChoice[] {
  return coveredCapabilities(form).filter((capability) => capability.repository && !capability.url);
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
  if (!form.lead) problems.push('Name the lead repository, which holds the capability map.');
  else if (hasCapabilityMap(form) && !form.selected.length) {
    problems.push('Choose the capabilities this workspace is for.');
  }

  const repositories = derivedRepositories(form);
  if (!repositories.length) problems.push('Add at least one repository.');
  const ids = repositories.map((repository) => repository.id);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicated)) problems.push(`More than one repository is called '${id}'.`);
  return problems;
}

/** The argv this form describes, once it has no problems. */
export function formCommand(form: WorkspaceForm): string[] {
  const args = ['workspace', 'create', '--local', '--json',
    '--id', form.id.trim(), '--base', form.base ?? '',
    '--lead', form.lead?.id ?? '', '--confirm', form.id.trim()];
  if (form.name.trim()) args.push('--name', form.name.trim());
  for (const repository of derivedRepositories(form)) {
    args.push('--repository', `${repository.id}=${repository.url}`);
    args.push('--default-branch', `${repository.id}=${repository.defaultBranch}`);
  }
  // Recorded on the workspace, because it is what the workspace is for — not merely how its
  // repository list happened to be arrived at.
  for (const id of form.selected) args.push('--capability', id);
  return args;
}

function leadHtml(form: WorkspaceForm): string {
  if (form.lead) {
    return `
    <p>
      <code>${escape(form.lead.url)}</code>
      <span class="muted">→ ${escape(form.lead.id)} · ${escape(form.lead.defaultBranch)}</span>
      ${form.lead.hasStateBranch
    ? `<span class="pill ok">${escape(form.lead.stateBranch)}</span>`
    : `<span class="muted">no ${escape(form.lead.stateBranch)} branch yet</span>`}
      <button class="link" data-clear="lead">Change</button>
    </p>
    ${form.lead.hasStateBranch
    ? ''
    : `<p class="muted">The orphan <code>${escape(form.lead.stateBranch)}</code> branch that records
         workflow progress does not exist yet; it is created when this workspace is.</p>`}`;
  }
  return `
    <p>
      <label>Clone URL <input type="text" value="${escape(form.leadDraft)}" data-draft="lead" size="46"
        placeholder="https://github.com/org/platform.git"${form.adding ? ' disabled' : ''}></label>
      <button data-read="lead"${form.adding || !form.leadDraft.trim() ? ' disabled' : ''}>
        ${form.adding ? 'Reading…' : 'Read its capability map'}
      </button>
    </p>
    <p class="muted">Nothing is cloned. The map and the repository URLs it refers to are read from
      this remote so the capabilities below can be chosen.</p>`;
}

function capabilityHtml(form: WorkspaceForm): string {
  if (!form.lead) {
    return '<p class="muted">Name the lead repository first; it holds the map of what this organisation builds.</p>';
  }
  if (!hasCapabilityMap(form)) {
    return `<p class="muted">${escape(form.capabilitiesReason ?? 'This lead repository does not describe what it builds.')}
      Add the repositories directly for now, and describe capabilities from the Capabilities screen once
      the workspace exists.</p>`;
  }

  const chosen = new Set(form.selected);
  const covered = new Set(coveredCapabilities(form).map((capability) => capability.id));
  return `
    <table>
      <thead><tr><th>Include</th><th>Capability</th><th>Delivers from</th></tr></thead>
      <tbody>${(form.capabilities ?? []).map((capability) => {
    const inherited = !chosen.has(capability.id) && covered.has(capability.id);
    return `
        <tr${covered.has(capability.id) ? '' : ' class="others"'}>
          <td><input type="checkbox" data-capability="${escape(capability.id)}"
            ${chosen.has(capability.id) ? 'checked' : ''}></td>
          <td style="padding-left:${capability.depth * 1.2}rem">${escape(capability.name)}
            ${inherited ? '<span class="muted">included by its parent</span>' : ''}</td>
          <td>${capability.repository
      ? `<code>${escape(capability.repository)}</code>${capability.url ? '' : ' <span class="pill bad">no clone URL</span>'}`
      : '<span class="muted">—</span>'}</td>
        </tr>`;
  }).join('')}</tbody>
    </table>
    <p class="muted">Choosing a capability includes everything beneath it, the way choosing a
      directory includes its contents. The selection is recorded on the workspace, so a capability
      added to the map later is picked up by a workspace that asked for its parent.</p>`;
}

function repositoryRows(form: WorkspaceForm): string {
  const repositories = derivedRepositories(form);
  if (!repositories.length) {
    return `<tr><td colspan="5" class="muted">No repositories yet.</td></tr>`;
  }
  const derived = hasCapabilityMap(form);
  return repositories.map((repository) => `
    <tr>
      <td>${repository.id === form.lead?.id ? '<span class="pill ok">lead</span>' : ''}</td>
      <td>${derived
    ? escape(repository.id)
    : `<input type="text" value="${escape(repository.id)}" data-id="${escape(repository.id)}" size="18">`}</td>
      <td><code>${escape(repository.url)}</code></td>
      <td>${escape(repository.defaultBranch)}</td>
      <td>${derived || repository.id === form.lead?.id
    ? ''
    : `<button class="link" data-remove="${escape(repository.id)}" title="Remove">Remove</button>`}</td>
    </tr>`).join('');
}

/** The fallback for a lead with no map: repositories named directly, by URL. */
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
  const repositories = derivedRepositories(form);
  const blocked = uncloneable(form);
  return `
  <header>
    <h1>New workspace</h1>
    <p class="meta">The capabilities a team works on together, and the directory they work in. The
      repositories follow: a capability that ships is the thing that names one.</p>
  </header>

  <section class="plain">
    <h2>Working directory</h2>
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
    <h2>Lead repository</h2>
    <p class="question">It holds the capability map and the governed state branch, so it is named
      first and everything else is read from it.</p>
    ${leadHtml(form)}
  </section>

  <section>
    <h2>Capabilities</h2>
    ${capabilityHtml(form)}
  </section>

  <section>
    <h2>Repositories</h2>
    <p class="question">${hasCapabilityMap(form)
    ? 'What the chosen capabilities deliver from. Cloned when the workspace is created.'
    : 'Named directly, because this lead repository has no capability map yet.'}</p>
    <table>
      <thead><tr><th></th><th>Identifier</th><th>Origin</th><th>Branch</th><th></th></tr></thead>
      <tbody>${repositoryRows(form)}</tbody>
    </table>
    ${blocked.length ? `
      <p class="blockers">${blocked.map((capability) =>
    `${escape(capability.name)} delivers from <code>${escape(capability.repository ?? '')}</code>, which the lead repository's portfolio does not declare, so there is nowhere to clone it from.`).join(' ')}</p>` : ''}
    ${hasCapabilityMap(form) ? '' : addRepositoryHtml(form)}
  </section>

  <section>
    ${problems.length
    ? `<h2>Before this can be created</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>Ready</h2><p class="ok-text">${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} will be cloned into <code>${escape(form.base ?? '')}/${escape(form.id.trim())}</code>, with <code>${escape(form.lead?.id ?? '')}</code> as lead.</p>`}
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
    const target = event.target.closest('[data-choose],[data-remove],[data-submit],[data-add],[data-read],[data-clear]');
    if (!target) return;
    if (target.dataset.choose) vscode.postMessage({ type: 'choose', what: target.dataset.choose });
    else if (target.dataset.remove) vscode.postMessage({ type: 'remove', id: target.dataset.remove });
    else if (target.dataset.read) vscode.postMessage({ type: 'read-lead' });
    else if (target.dataset.clear) vscode.postMessage({ type: 'clear-lead' });
    else if (target.dataset.add) vscode.postMessage({ type: 'add' });
    else if (target.dataset.submit) vscode.postMessage({ type: 'create' });
  });
  /**
   * The draft is reported as it is typed so the actions never have to trust what the page sends with
   * them — but the panel does NOT re-render in response, because replacing the document on every
   * keystroke would take the caret with it. The affordances that depend on what is typed are
   * therefore updated here, in the page, where they are presentation and nothing else.
   */
  const affordances = () => {
    const lead = document.querySelector('[data-draft="lead"]');
    const read = document.querySelector('[data-read]');
    if (lead && read) read.disabled = !lead.value.trim();
    const url = document.querySelector('[data-draft="url"]');
    const button = document.querySelector('[data-add]');
    if (!url || !button) return;
    const identifier = document.querySelector('[data-draft="id"]');
    const hint = document.querySelector('[data-hint="urls"]');
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
    vscode.postMessage({ type: 'draft', field, value: event.target.value });
    return true;
  };
  document.addEventListener('input', (event) => { if (draft(event)) affordances(); });
  document.addEventListener('change', (event) => {
    if (draft(event)) return;
    const capability = event.target.dataset?.capability;
    if (capability) {
      return vscode.postMessage({ type: 'capability', id: capability, selected: event.target.checked });
    }
    const field = event.target.dataset?.field;
    if (field) return vscode.postMessage({ type: 'field', field, value: event.target.value });
    const id = event.target.dataset?.id;
    if (id) vscode.postMessage({ type: 'rename', id, value: event.target.value });
  });
  // Enter in a URL field does what the button beside it does.
  document.addEventListener('keydown', (event) => {
    const field = event.target.dataset?.draft;
    if (event.key !== 'Enter' || (field !== 'url' && field !== 'lead')) return;
    event.preventDefault();
    vscode.postMessage({ type: field === 'lead' ? 'read-lead' : 'add' });
  });
`;

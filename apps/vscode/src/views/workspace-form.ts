/**
 * The workspace form.
 *
 * A workspace is a set of capabilities and a working directory. That is the whole concept. The
 * repositories are not chosen here and cannot be added here: a capability that ships names the
 * repository it ships from, so the clone list is derived from the selection rather than restated
 * beside it. Two places to say which repositories are involved is one place for them to disagree.
 *
 * One of the chosen capabilities is the lead. It is the workspace's centre of gravity — the
 * repository it ships from is where the orphan `state` branch is created and checked in when the
 * workspace is initialised.
 *
 * The capability map is not fetched from a URL typed here. It is read from an organisation already
 * mapped on the Capabilities screen, because a workspace over capabilities that do not exist yet is
 * not a form to fill in, it is a step taken out of order.
 */
import { escape, icon } from './webview.ts';

/** A repository the selection implies. Derived, never entered. */
export interface FormRepository {
  id: string;
  url: string;
  defaultBranch: string;
}

/** One capability from the organisation's map. */
export interface CapabilityChoice {
  id: string;
  name: string;
  depth: number;
  ancestors: string[];
  /** The repository this capability ships from; null for a grouping. */
  repository: string | null;
  /** Where that repository is cloned from, or null when the portfolio does not declare it. */
  url: string | null;
  defaultBranch: string;
}

export interface WorkspaceForm {
  base: string | null;
  id: string;
  name: string;
  /** Organisations already mapped, by lead clone URL. The source of every capability offered. */
  organisations: string[];
  /** The one being drawn from; auto-selected when there is only one. */
  organisation: string | null;
  /** Its capability map; null until read. */
  capabilities: CapabilityChoice[] | null;
  /** Why there is no map to choose from, when there is none. */
  capabilitiesReason: string | null;
  /** The capabilities this workspace is for. */
  selected: string[];
  /** Which of them leads. Its repository carries the state branch. */
  leadCapability: string | null;
  /** True while the map is being read. */
  reading: boolean;
  busy: boolean;
  error: string | null;
}

export const EMPTY_WORKSPACE_FORM: WorkspaceForm = {
  base: null, id: '', name: '', organisations: [], organisation: null,
  capabilities: null, capabilitiesReason: null, selected: [], leadCapability: null,
  reading: false, busy: false, error: null
};

/** The nested tree and the flat delivery list, as `capability organisation --json` returns them. */
export interface RemoteCapability {
  id: string;
  name?: string;
  repository?: string | null;
  children?: RemoteCapability[];
}

/** Flatten the organisation's map into rows the form can list, carrying each clone URL across. */
export function capabilityChoices(
  tree: RemoteCapability[],
  repositories: Record<string, { url?: string; defaultBranch?: string } | undefined> = {}
): CapabilityChoice[] {
  const walk = (nodes: RemoteCapability[], chain: string[]): CapabilityChoice[] =>
    nodes.flatMap((node) => {
      const declared = node.repository ? repositories[node.repository] : undefined;
      return [
        {
          id: node.id,
          name: node.name ?? node.id,
          depth: chain.length,
          ancestors: chain,
          repository: node.repository ?? null,
          url: declared?.url ?? null,
          defaultBranch: declared?.defaultBranch ?? 'main'
        },
        ...walk(node.children ?? [], [...chain, node.id])
      ];
    });
  return walk(tree, []);
}

/** Whether there is a map to choose from at all. */
export function hasCapabilityMap(form: WorkspaceForm): boolean {
  return Boolean(form.capabilities?.length);
}

/**
 * Which capabilities a selection actually covers.
 *
 * Choosing a capability means the things beneath it, the way choosing a directory means its
 * contents. Recorded as the selection made rather than the expansion of it, so a capability added to
 * the map later is picked up by a workspace that asked for its parent.
 */
export function coveredCapabilities(form: WorkspaceForm): CapabilityChoice[] {
  const chosen = new Set(form.selected);
  return (form.capabilities ?? []).filter((capability) =>
    chosen.has(capability.id) || capability.ancestors.some((ancestor) => chosen.has(ancestor)));
}

/** The covered capabilities that ship — the ones that can lead, and the ones that clone. */
export function shippingCapabilities(form: WorkspaceForm): CapabilityChoice[] {
  return coveredCapabilities(form).filter((capability) => capability.repository);
}

/**
 * The repositories a selection implies: what the covered capabilities ship from.
 *
 * Keyed by the repository each capability names, so two capabilities shipping from the same
 * repository mean one clone rather than a duplicate.
 */
export function derivedRepositories(form: WorkspaceForm): FormRepository[] {
  const byId = new Map<string, FormRepository>();
  for (const capability of shippingCapabilities(form)) {
    const id = capability.repository ?? '';
    if (!capability.url || byId.has(id)) continue;
    byId.set(id, { id, url: capability.url, defaultBranch: capability.defaultBranch });
  }
  return [...byId.values()];
}

/** Covered capabilities that name a repository the portfolio does not declare. */
export function uncloneable(form: WorkspaceForm): CapabilityChoice[] {
  return shippingCapabilities(form).filter((capability) => !capability.url);
}

/**
 * The lead the form would use: the explicit pick, or the first shipping capability when the pick is
 * absent or no longer covered by the selection.
 */
export function effectiveLead(form: WorkspaceForm): CapabilityChoice | null {
  const shipping = shippingCapabilities(form);
  return shipping.find((capability) => capability.id === form.leadCapability) ?? shipping[0] ?? null;
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
  if (!form.organisation) problems.push('Choose the organisation whose capabilities this is for.');
  else if (form.reading) problems.push('Wait for the capability map to be read.');
  else if (!hasCapabilityMap(form)) {
    problems.push('Create the first capability for this organisation.');
  } else if (!form.selected.length) {
    problems.push('Choose the capabilities this workspace is for.');
  } else if (!shippingCapabilities(form).length) {
    problems.push('None of the chosen capabilities ships from a repository, so there would be nothing to work in.');
  }
  for (const capability of uncloneable(form)) {
    problems.push(`${capability.name} ships from '${capability.repository}', which the portfolio does not declare, so there is nowhere to clone it from.`);
  }
  return problems;
}

/** The argv this form describes, once it has no problems. */
export function formCommand(form: WorkspaceForm): string[] {
  const args = ['workspace', 'create', '--local', '--json',
    '--id', form.id.trim(), '--base', form.base ?? '',
    '--organisation', form.organisation ?? '', '--confirm', form.id.trim()];
  if (form.name.trim()) args.push('--name', form.name.trim());
  for (const id of form.selected) args.push('--capability', id);
  const lead = effectiveLead(form);
  if (lead) args.push('--lead-capability', lead.id);
  return args;
}

/**
 * Which organisation the capabilities come from.
 *
 * Not a URL field: every organisation offered is one already mapped from the Capabilities screen.
 * With only one there is nothing to decide, so it is stated rather than asked.
 */
function organisationHtml(form: WorkspaceForm): string {
  if (!form.organisations.length) {
    return `<p class="muted">No organisation has been mapped yet. Map a capability to a Git
      repository from the Capabilities screen — that is what creates the map this form reads.</p>
      <p><button class="secondary" data-open="capabilities">Open Capabilities</button></p>`;
  }
  if (form.organisations.length === 1 && form.organisation === form.organisations[0]) {
    return `<p><code>${escape(form.organisation)}</code>
      ${form.reading ? '<span class="muted">reading its map…</span>' : ''}</p>`;
  }
  return `
    <p>
      <label>Organisation <select data-field="organisation">
        <option value=""${form.organisation ? '' : ' selected'}>— choose —</option>
        ${form.organisations.map((url) => `<option value="${escape(url)}"${url === form.organisation ? ' selected' : ''}>${escape(url)}</option>`).join('')}
      </select></label>
      ${form.reading ? '<span class="muted">reading its map…</span>' : ''}
    </p>`;
}

/**
 * Choosing what the workspace is for.
 *
 * A dropdown rather than a row of checkboxes: a real map runs to dozens of capabilities, and a
 * checkbox table asks a reader to scan all of them to find the two they want. The options are
 * indented so the hierarchy stays legible, and each pick is listed below with what it drags in —
 * choosing a grouping means everything beneath it, and that consequence should be visible rather
 * than inferred.
 */
function capabilityHtml(form: WorkspaceForm): string {
  if (!form.organisation) return '<p class="muted">Choose an organisation first.</p>';
  if (form.reading) return '<p class="muted">Reading the capability map…</p>';
  if (!hasCapabilityMap(form)) {
    return `<p class="muted">${escape(form.capabilitiesReason ?? 'This organisation does not describe what it builds yet.')}
      Create its first capability here; this form will refresh when it has been mapped.</p>
      <p><button class="secondary" data-open="capabilities">${icon('capability')}Create first capability</button></p>`;
  }

  const covered = coveredCapabilities(form);
  const coveredIds = new Set(covered.map((capability) => capability.id));
  // Anything already covered is not offered: picking a child of something chosen adds nothing, and
  // picking the same one twice is not a thing.
  const offered = (form.capabilities ?? []).filter((capability) => !coveredIds.has(capability.id));

  return `
    <p>
      <label>Include <select data-capability-pick>
        <option value="">— choose a capability —</option>
        ${offered.map((capability) => `<option value="${escape(capability.id)}">${'&nbsp;&nbsp;'.repeat(capability.depth)}${escape(capability.name)}${capability.repository ? ` (${escape(capability.repository)})` : ''}</option>`).join('')}
      </select></label>
      <button class="secondary" data-capability-add="1"${offered.length ? '' : ' disabled'}>Add</button>
    </p>

    ${form.selected.length ? `
    <table>
      <thead><tr><th>Capability</th><th>Brings in</th><th></th></tr></thead>
      <tbody>${form.selected.map((id) => {
    const capability = (form.capabilities ?? []).find((entry) => entry.id === id);
    const beneath = covered.filter((entry) => entry.id !== id && entry.ancestors.includes(id));
    const ships = covered
      .filter((entry) => entry.id === id || entry.ancestors.includes(id))
      .filter((entry) => entry.repository);
    return `
        <tr>
          <td>${icon('capability')}${escape(capability?.name ?? id)}</td>
          <td class="muted">${beneath.length ? `${beneath.length} beneath it · ` : ''}${ships.length
      ? ships.map((entry) => `${icon('repository')}<code>${escape(entry.repository ?? '')}</code>${entry.url ? '' : ` <span class="pill bad">${icon('bad')}no clone URL</span>`}`).join(' ')
      : 'ships nothing yet'}</td>
          <td><button class="link" data-capability-remove="${escape(id)}">Remove</button></td>
        </tr>`;
  }).join('')}</tbody>
    </table>` : '<p class="muted">Nothing chosen yet.</p>'}

    ${leadHtml(form)}

    <p class="muted">Choosing a capability includes everything beneath it, the way choosing a
      directory includes its contents. The selection is recorded on the workspace, so a capability
      added to the map later is picked up by a workspace that asked for its parent.</p>`;
}

/**
 * The lead capability, and what naming it decides.
 *
 * Offered only among the capabilities that ship, because leading means carrying the state branch
 * and a grouping has no repository to carry it in. Defaulted rather than demanded — one shipping
 * capability makes the choice unambiguous, and a form that insists on being told what it already
 * knows is just a longer form.
 */
function leadHtml(form: WorkspaceForm): string {
  const shipping = shippingCapabilities(form);
  if (!shipping.length) return '';
  const lead = effectiveLead(form);
  return `
    <p>
      <label>Lead capability <select data-field="lead-capability">
        ${shipping.map((capability) => `<option value="${escape(capability.id)}"${capability.id === lead?.id ? ' selected' : ''}>${escape(capability.name)} (${escape(capability.repository ?? '')})</option>`).join('')}
      </select></label>
    </p>
    <p class="muted">The workspace's centre of gravity. When the workspace is initialised, the orphan
      <code>state</code> branch is created
      ${lead ? `in <code>${escape(lead.repository ?? '')}</code>` : 'in its repository'} and pushed,
      if it is not there already. It shares no ancestry with any code branch and is never merged into
      one, so a rebase of the work cannot rewrite the record of it.</p>`;
}

function repositoryRows(form: WorkspaceForm): string {
  const repositories = derivedRepositories(form);
  if (!repositories.length) {
    return '<tr><td colspan="4" class="muted">Nothing to clone yet — choose a capability that ships.</td></tr>';
  }
  const lead = effectiveLead(form);
  return repositories.map((repository) => `
    <tr>
      <td>${repository.id === lead?.repository ? `<span class="pill ok">${icon('repository')}lead</span>` : ''}</td>
      <td>${escape(repository.id)}</td>
      <td><code>${escape(repository.url)}</code></td>
      <td>${escape(repository.defaultBranch)}</td>
    </tr>`).join('');
}

export function workspaceFormHtml(form: WorkspaceForm): string {
  const problems = formProblems(form);
  const repositories = derivedRepositories(form);
  const lead = effectiveLead(form);
  return `
  <header>
    <h1>${icon('workspace', { size: 20 })}New workspace</h1>
    <p class="meta">The capabilities a team works on together, and the directory they work in. The
      repositories follow: a capability that ships is the thing that names one.</p>
  </header>

  <section class="plain">
    <h2>${icon('directory')}Working directory</h2>
    <p>
      <button class="secondary" data-choose="base">Choose folder…</button>
      ${form.base ? `<code>${escape(form.base)}</code>` : '<span class="muted">Not chosen</span>'}
    </p>
  </section>

  <section>
    <h2>${icon('workspace')}Identity</h2>
    <p>
      <label>Identifier <input type="text" value="${escape(form.id)}" data-field="id" placeholder="checkout-platform"></label>
    </p>
    <p>
      <label>Name <input type="text" value="${escape(form.name)}" data-field="name" placeholder="Checkout platform" size="32"></label>
    </p>
  </section>

  <section>
    <h2>${icon('organisation')}Organisation</h2>
    <p class="question">Whose capability map this workspace draws from.</p>
    ${organisationHtml(form)}
  </section>

  <section>
    <h2>${icon('capability')}Capabilities</h2>
    ${capabilityHtml(form)}
  </section>

  <section>
    <h2>${icon('git')}Repositories</h2>
    <p class="question">What the chosen capabilities ship from. Cloned when the workspace is created.</p>
    <table>
      <thead><tr><th></th><th>Identifier</th><th>Origin</th><th>Branch</th></tr></thead>
      <tbody>${repositoryRows(form)}</tbody>
    </table>
  </section>

  <section>
    ${problems.length
    ? `<h2>${icon('bad')}Before this can be created</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>${icon('ok')}Ready</h2><p class="ok-text">${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} will be cloned into <code>${escape(form.base ?? '')}/${escape(form.id.trim())}</code>, led by <code>${escape(lead?.name ?? '')}</code>.</p>`}
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
    const target = event.target.closest('[data-choose],[data-submit],[data-open],[data-capability-add],[data-capability-remove]');
    if (!target) return;
    if (target.dataset.choose) vscode.postMessage({ type: 'choose', what: target.dataset.choose });
    else if (target.dataset.open) vscode.postMessage({ type: 'open', what: target.dataset.open });
    else if (target.dataset.capabilityAdd) {
      const pick = document.querySelector('[data-capability-pick]');
      if (pick && pick.value) vscode.postMessage({ type: 'capability', id: pick.value, selected: true });
    }
    else if (target.dataset.capabilityRemove) {
      vscode.postMessage({ type: 'capability', id: target.dataset.capabilityRemove, selected: false });
    }
    else if (target.dataset.submit) vscode.postMessage({ type: 'create' });
  });
  /**
   * Typed values are reported as they are typed so the actions never have to trust what the page
   * sends with them — as a draft, because the panel does not re-render for a draft and replacing the
   * document on every keystroke would take the caret with it. The same value is reported again as a
   * field when it is committed — on blur, or the moment a dropdown is picked — and that one redraws,
   * because by then the summary below it is out of date.
   */
  document.addEventListener('input', (event) => {
    const field = event.target.dataset?.field;
    if (field) vscode.postMessage({ type: 'draft', field, value: event.target.value });
  });
  document.addEventListener('change', (event) => {
    const field = event.target.dataset?.field;
    if (field) vscode.postMessage({ type: 'field', field, value: event.target.value });
  });
`;

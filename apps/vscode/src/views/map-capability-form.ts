/**
 * Mapping a git repository to a capability.
 *
 * This screen was "Govern a repository", which had the relationship backwards. What a person is
 * doing here is describing what their organisation builds and saying which repository each part
 * ships from — a capability is the subject, and a repository is one of its properties. Governing a
 * repository is what the platform does about it, not what the person is doing.
 *
 * So there is no folder to choose: nothing is checked out here. The map lives in the lead
 * repository, and the platform borrows it for the length of the edit. Cloning is a workspace's job,
 * and a workspace is made for doing work rather than for describing what exists. There is no state
 * branch either — it is `state`, and it is created when a workspace is initialised.
 */
import { escape, icon } from './webview.ts';

/** A capability already in the map, offered as a parent. */
export interface ParentChoice { id: string; name: string; depth: number; ships: boolean }

/**
 * The vocabulary a capability's kind is drawn from.
 *
 * A dropdown rather than free text: kind is a classification, and an organisation that spells it
 * four ways has four classifications. Any value the map already uses is added to this list, so a
 * repository that chose its own words keeps them.
 */
export const CAPABILITY_KINDS = ['portfolio', 'domain', 'product', 'service', 'platform', 'component'];

export interface MapCapabilityForm {
  lead: string;
  leads: string[];
  capabilityId: string;
  name: string;
  kind: string;
  kinds: string[];
  parent: string;
  parents: ParentChoice[];
  repositoryUrl: string;
  jiraProject: string;
  teams: string;
  /** Null until the lead has been read; the map is what the parent list is made of. */
  loaded: boolean;
  busy: boolean;
  error: string | null;
}

export const EMPTY_MAP_FORM: MapCapabilityForm = {
  lead: '', leads: [], capabilityId: '', name: '', kind: 'service', kinds: CAPABILITY_KINDS,
  parent: '', parents: [], repositoryUrl: '', jiraProject: '', teams: '',
  loaded: false, busy: false, error: null
};

export function mapProblems(form: MapCapabilityForm): string[] {
  const problems: string[] = [];
  if (!form.lead.trim()) problems.push('Name the repository that holds the capability map.');
  else if (!form.loaded) problems.push('Read the map, so this capability can be placed in it.');
  if (!form.capabilityId.trim()) problems.push('Give the capability an identifier.');
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.capabilityId.trim())) {
    problems.push('The identifier must be lower-case kebab-case, like payments-api.');
  } else if (form.parents.some((parent) => parent.id === form.capabilityId.trim())) {
    problems.push(`'${form.capabilityId.trim()}' is already in this map.`);
  }
  return problems;
}

export function mapCommand(form: MapCapabilityForm): string[] {
  const args = ['capability', 'map', form.capabilityId.trim(),
    '--lead', form.lead.trim(), '--kind', form.kind, '--json'];
  if (form.name.trim()) args.push('--name', form.name.trim());
  if (form.parent) args.push('--parent', form.parent);
  if (form.repositoryUrl.trim()) args.push('--repository', form.repositoryUrl.trim());
  if (form.jiraProject.trim()) args.push('--jira-project', form.jiraProject.trim());
  if (form.teams.trim()) args.push('--teams', form.teams.trim());
  return args;
}

export function mapCapabilityHtml(form: MapCapabilityForm): string {
  const problems = mapProblems(form);
  // A capability that ships cannot contain anything, so it cannot be a parent.
  const parents = form.parents.filter((parent) => !parent.ships);
  return `
  <header>
    <h1>${icon('capability', { size: 20 })}Map a capability</h1>
    <p class="meta">What this organisation builds, and which repository each part ships from.
      Nothing is checked out: the map lives in the lead repository, and the platform borrows it for
      the length of the edit.</p>
  </header>

  <section class="plain">
    <h2>${icon('repository')}Where the map lives</h2>
    <p>
      <label>Lead repository
        ${form.leads.length ? `<select data-map="lead">
          ${form.leads.map((lead) => `<option value="${escape(lead)}"${lead === form.lead ? ' selected' : ''}>${escape(lead)}</option>`).join('')}
          <option value=""${form.lead && form.leads.includes(form.lead) ? '' : ' selected'}>— another —</option>
        </select>`
    : `<input type="text" value="${escape(form.lead)}" data-map="lead" size="46"
            placeholder="https://github.com/acme/platform.git">`}
      </label>
      <button class="secondary" data-read="1"${form.busy || !form.lead.trim() ? ' disabled' : ''}>
        ${form.busy && !form.loaded ? 'Reading…' : 'Read the map'}
      </button>
    </p>
    ${form.leads.length ? `<p><label>Or another <input type="text" value="" data-map="leadOther" size="46"
      placeholder="https://github.com/acme/platform.git"></label></p>` : ''}
    ${form.loaded
    ? `<p class="ok-text">${icon('ok')}${form.parents.length} ${form.parents.length === 1 ? 'capability' : 'capabilities'} in this map.</p>`
    : '<p class="muted">The map is read to offer the parents this capability can sit under.</p>'}
  </section>

  <section>
    <h2>${icon('capability')}The capability</h2>
    <p>
      <label>Identifier <input type="text" value="${escape(form.capabilityId)}" data-map="capabilityId"
        size="24" placeholder="payments-api"></label>
      <label>Name <input type="text" value="${escape(form.name)}" data-map="name" size="28"
        placeholder="Payments API"></label>
    </p>
    <p>
      <label>Kind <select data-map="kind">
        ${form.kinds.map((kind) => `<option value="${escape(kind)}"${kind === form.kind ? ' selected' : ''}>${escape(kind)}</option>`).join('')}
      </select></label>
      <label>Within <select data-map="parent"${form.loaded ? '' : ' disabled'}>
        <option value=""${form.parent ? '' : ' selected'}>— top of the tree —</option>
        ${parents.map((parent) => `<option value="${escape(parent.id)}"${parent.id === form.parent ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(parent.depth)}${escape(parent.name)}</option>`).join('')}
      </select></label>
    </p>
  </section>

  <section>
    <h2>${icon('git')}Repository it ships from</h2>
    <p>
      <label>Clone URL <input type="text" value="${escape(form.repositoryUrl)}" data-map="repositoryUrl"
        size="46" placeholder="https://github.com/acme/payments-api.git"></label>
    </p>
    <p class="muted">Leave this empty for a grouping — a capability that organises the ones beneath
      it rather than shipping anything itself. Naming a repository makes this a leaf, and the
      repository is declared in the portfolio at the same time so a workspace can clone it.</p>
  </section>

  <section>
    <h2>${icon('tracker')}Tracking</h2>
    <p>
      <label>Jira <input type="text" value="${escape(form.jiraProject)}" data-map="jiraProject" size="12"
        placeholder="PAY"></label>
      <label>Teams <input type="text" value="${escape(form.teams)}" data-map="teams" size="36"
        placeholder="comma separated"></label>
    </p>
    <p class="muted">Both belong to the capability rather than to a workspace: they stay true
      regardless of who has cloned what.</p>
  </section>

  <section>
    ${problems.length
    ? `<h2>${icon('bad')}Before this can be mapped</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>${icon('ok')}Ready</h2><p class="ok-text">Commits the map to ${escape(form.lead)} and pushes.</p>`}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-map-submit="1" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy && form.loaded ? 'Mapping…' : 'Map this capability'}
      </button>
    </p>
  </section>`;
}

export const MAP_CAPABILITY_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-read],[data-map-submit]');
    if (!target) return;
    if (target.dataset.read !== undefined) vscode.postMessage({ type: 'read' });
    else vscode.postMessage({ type: 'map' });
  });
  const report = (event) => {
    const field = event.target.dataset?.map;
    if (!field) return;
    vscode.postMessage({ type: 'field', field, value: event.target.value });
  };
  // Typed values are reported without re-rendering, so the caret stays put; selecting a lead or a
  // parent is a data change the panel does redraw for.
  document.addEventListener('input', report);
  document.addEventListener('change', (event) => {
    report(event);
    const field = event.target.dataset?.map;
    if (field === 'lead' || field === 'parent' || field === 'kind') {
      vscode.postMessage({ type: 'redraw' });
    }
  });
`;

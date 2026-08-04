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
import { CAPABILITY_KINDS } from './capability-model.ts';
import { escape, icon } from './webview.ts';

/** A capability already in the map, offered as a parent. */
export interface ParentChoice { id: string; name: string; depth: number; ships: boolean }

/** The same closed structural vocabulary used by the engine and schema. */
export { CAPABILITY_KINDS };

export interface MapCapabilityForm {
  lead: string;
  leads: string[];
  capabilityId: string;
  name: string;
  kind: string;
  parent: string;
  parents: ParentChoice[];
  repositoryUrl: string;
  jiraProject: string;
  teams: string;
  /** Null until the lead has been read; the map is what the parent list is made of. */
  loaded: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
}

export const EMPTY_MAP_FORM: MapCapabilityForm = {
  lead: '', leads: [], capabilityId: '', name: '', kind: 'collection',
  parent: '', parents: [], repositoryUrl: '', jiraProject: '', teams: '',
  loaded: false, busy: false, notice: null, error: null
};

export function capabilityIdentifierProblem(form: MapCapabilityForm): string | null {
  const id = form.capabilityId.trim();
  if (!id) return 'Give the capability an identifier.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return 'The identifier must be lower-case kebab-case, like payments-api.';
  }
  if (form.parents.some((parent) => parent.id === id)) return `'${id}' is already in this map.`;
  return null;
}

export function mapProblems(form: MapCapabilityForm): string[] {
  const problems: string[] = [];
  if (!form.lead.trim()) problems.push('Choose which repository stores the capability map.');
  else if (!form.loaded) problems.push(form.busy
    ? 'The selected capability map is loading.'
    : 'Select the capability-map repository again so its current map can be loaded.');
  const identifierProblem = capabilityIdentifierProblem(form);
  if (identifierProblem) problems.push(identifierProblem);
  if (form.loaded && form.parents.length && !form.parent) {
    problems.push('Choose the capability this belongs under.');
  }
  if (!CAPABILITY_KINDS.includes(form.kind as typeof CAPABILITY_KINDS[number])) {
    problems.push('Kind must be Collection or Delivery.');
  }
  if (form.kind === 'delivery' && !form.repositoryUrl.trim()) {
    problems.push('Select or enter the repository this Delivery capability ships from.');
  }
  if (form.kind === 'collection' && form.repositoryUrl.trim()) {
    problems.push('A Collection cannot name a repository. Choose Delivery or clear the clone URL.');
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
  const identifierProblem = capabilityIdentifierProblem(form);
  const staticProblems = problems.filter((problem) => problem !== identifierProblem);
  const parents = form.parents;
  const repository = form.repositoryUrl.trim();
  const lead = form.lead.trim();
  const usesShippingRepository = Boolean(repository && repository === lead);
  const knownLeadSelected = form.leads.includes(lead);
  const mapStatus = form.busy && !form.loaded
    ? `<p class="muted">${icon('waiting')}Loading the selected capability map…</p>`
    : form.loaded
      ? `<p class="ok-text">${icon('ok')}${form.parents.length} ${form.parents.length === 1 ? 'capability' : 'capabilities'} available as parents.</p>`
      : '<p class="muted">Choose a repository below. Its current map is loaded automatically.</p>';
  return `
  <header>
    <h1>${icon('capability', { size: 20 })}Map a capability</h1>
    <p class="meta">What this organisation builds, and which repository each part ships from.
      Repository choices are made together below; no separate setup step is required.</p>
  </header>

  <section>
    <h2>${icon('capability')}The capability</h2>
    <div class="form-grid">
      <label class="field"><span>Identifier</span><input type="text" value="${escape(form.capabilityId)}" data-map="capabilityId"
        data-existing-capability-ids="${escape(form.parents.map((parent) => parent.id).join(','))}"
        placeholder="payments-api"><small>Permanent, lower-case kebab-case.</small></label>
      <label class="field"><span>Display name</span><input type="text" value="${escape(form.name)}" data-map="name"
        placeholder="Payments API"></label>
      <label class="field"><span>Kind</span><select data-map="kind">
        ${CAPABILITY_KINDS.map((kind) => `<option value="${escape(kind)}"${kind === form.kind ? ' selected' : ''}>${kind === 'collection' ? 'Collection' : 'Delivery'}</option>`).join('')}
      </select><small>Collection groups related capabilities; Delivery ships from repositories.</small></label>
      <label class="field"><span>Linked under</span><select data-map="parent"${form.loaded ? '' : ' disabled'}>
        <option value=""${form.parent ? '' : ' selected'}>${parents.length ? 'Choose a capability…' : 'Top of the tree'}</option>
        ${parents.map((parent) => `<option value="${escape(parent.id)}"${parent.id === form.parent ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(parent.depth)}${escape(parent.name)}</option>`).join('')}
      </select><small>You can change this relationship later.</small></label>
    </div>
  </section>

  <section>
    <h2>${icon('git')}Repository it ships from</h2>
    ${form.kind === 'delivery' ? `<div class="form-grid">
      <label class="field full"><span>Clone URL</span><input type="text" value="${escape(form.repositoryUrl)}" data-map="repositoryUrl"
        placeholder="https://github.com/acme/payments-api.git"><small>The repository is declared in the portfolio so workspaces can clone it.</small></label>
    </div>` : '<p class="muted">A Collection groups capabilities and does not ship from a repository.</p>'}

    <div class="editor-card">
      <p class="eyebrow">Capability map</p>
      <h3>${icon('repository')}Where this capability is recorded</h3>
      ${form.leads.length > 1 ? `<label class="field"><span>Repository</span><select data-map="lead">
        <option value=""${knownLeadSelected || usesShippingRepository ? '' : ' selected'}>Choose a repository…</option>
        ${form.leads.map((choice) => `<option value="${escape(choice)}"${choice === lead ? ' selected' : ''}>${escape(choice)}</option>`).join('')}
        ${usesShippingRepository && !knownLeadSelected
    ? `<option value="${escape(lead)}" selected>${escape(lead)} (shipping repository)</option>` : ''}
      </select><small>More than one capability map is available, so choose the one this belongs to.</small></label>` : ''}
      ${form.leads.length === 1 ? `<label class="choice${knownLeadSelected ? ' chosen' : ''}">
        <input type="radio" name="capability-map-repository" value="${escape(form.leads[0])}" data-map="lead"${knownLeadSelected ? ' checked' : ''}
          aria-label="Only available capability-map repository">
        <span class="choice-label">${icon('repository')}${escape(form.leads[0])}</span>
        <span class="choice-detail">${knownLeadSelected
    ? 'Selected automatically because it is the only available capability map.'
    : 'Use the existing capability map instead of the shipping repository.'}</span>
      </label>` : ''}
      ${!form.leads.length && form.kind === 'collection' ? `<label class="field full"><span>Repository</span>
        <input type="text" value="${escape(form.lead)}" data-map="lead" placeholder="https://github.com/acme/platform.git">
        <small>No capability-map repository is registered yet. Enter the repository that should hold it.</small></label>` : ''}
      ${form.kind === 'delivery' ? `<label class="choice${usesShippingRepository ? ' chosen' : ''}">
        <input type="checkbox" data-use-shipping-repository${usesShippingRepository ? ' checked' : ''}${repository ? '' : ' disabled'}>
        <span class="choice-label">Use this repository for the capability map</span>
        <span class="choice-detail">${repository
    ? 'Record the capability map in the same repository entered above.'
    : 'Enter the shipping repository first to make this option available.'}</span>
      </label>` : ''}
      ${!lead && form.leads.length > 1
    ? `<p class="warning-text">${icon('warning')}Choose one of the available capability-map repositories.</p>`
    : !lead && form.kind === 'delivery'
      ? `<p class="warning-text">${icon('warning')}No capability-map repository is selected. Enter the shipping repository and keep the checkbox selected, or choose an existing map.</p>`
      : ''}
      ${mapStatus}
    </div>
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
    <div data-map-blocked${problems.length ? '' : ' hidden'}>
      <h2>${icon('bad')}Before this can be mapped</h2>
      <ul class="blockers">
        <li data-map-identifier-problem${identifierProblem ? '' : ' hidden'}>${escape(identifierProblem ?? '')}</li>
        ${staticProblems.map((problem) => `<li data-map-static-problem>${escape(problem)}</li>`).join('')}
      </ul>
    </div>
    <div data-map-ready${problems.length ? ' hidden' : ''}>
      <h2>${icon('ok')}Ready</h2><p class="ok-text">Commits the map to ${escape(form.lead)} and pushes.</p>
    </div>
    ${form.notice ? `<p class="warning-text">${icon('warning')}${escape(form.notice)}</p>` : ''}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-map-submit="1" data-map-busy="${form.busy ? 'true' : 'false'}" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy && form.loaded ? 'Mapping…' : 'Map this capability'}
      </button>
    </p>
  </section>`;
}

export const MAP_CAPABILITY_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-map-submit]');
    if (!target) return;
    vscode.postMessage({ type: 'map' });
  });
  const report = (event) => {
    const field = event.target.dataset?.map;
    if (!field) return;
    vscode.postMessage({ type: 'field', field, value: event.target.value });
  };
  // Typed values are reported without re-rendering, so the caret stays put; selecting a lead or a
  // parent is a data change the panel does redraw for.
  const syncIdentifierValidation = (input) => {
    const value = input.value.trim();
    const existing = (input.dataset.existingCapabilityIds || '').split(',').filter(Boolean);
    const problem = !value
      ? 'Give the capability an identifier.'
      : !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        ? 'The identifier must be lower-case kebab-case, like payments-api.'
        : existing.includes(value)
          ? "'" + value + "' is already in this map."
          : '';
    const identifierProblem = document.querySelector('[data-map-identifier-problem]');
    const blocked = document.querySelector('[data-map-blocked]');
    const ready = document.querySelector('[data-map-ready]');
    const submit = document.querySelector('[data-map-submit]');
    if (!identifierProblem || !blocked || !ready || !submit) return;
    identifierProblem.textContent = problem;
    identifierProblem.hidden = !problem;
    const hasStaticProblems = Boolean(document.querySelector('[data-map-static-problem]'));
    const hasProblems = Boolean(problem) || hasStaticProblems;
    blocked.hidden = !hasProblems;
    ready.hidden = hasProblems;
    submit.disabled = hasProblems || submit.dataset.mapBusy === 'true';
  };
  document.addEventListener('input', (event) => {
    report(event);
    if (event.target.dataset?.map === 'capabilityId') syncIdentifierValidation(event.target);
  });
  document.addEventListener('change', (event) => {
    report(event);
    const field = event.target.dataset?.map;
    if (field === 'lead') {
      vscode.postMessage({ type: 'selectLead', value: event.target.value });
    } else if (field === 'repositoryUrl') {
      vscode.postMessage({ type: 'repositoryCommitted', value: event.target.value });
    } else if (field === 'parent' || field === 'kind') {
      vscode.postMessage({ type: 'redraw' });
    }
    if (event.target.matches('[data-use-shipping-repository]')) {
      vscode.postMessage({ type: 'useShippingRepository', checked: event.target.checked });
    }
  });
`;

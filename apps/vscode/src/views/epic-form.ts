/**
 * Starting an Epic.
 *
 * This was five prompts in a row — title, description, goal, profile, lens — each one covering the
 * answer before it. You could not see what you had written, could not go back, and could not
 * compare two profiles before choosing one. The last of the five decided which phases the Epic would
 * run for the rest of its life, and it was asked as a dropdown with the other four already gone.
 *
 * So it is a form. The profile in particular is shown with what each one costs: the phases it runs,
 * which is the whole difference between them and is invisible in a picker that shows only names.
 */
import { escape, icon } from './webview.ts';

export interface ProfileChoice {
  id: string;
  label: string;
  description: string;
  /** The phases this profile runs, which is what actually differs between them. */
  phases: string[];
}

export interface LensChoice { id: string; label: string }

export interface EpicForm {
  title: string;
  description: string;
  goal: string;
  profile: string | null;
  lens: string | null;
  profiles: ProfileChoice[];
  lenses: LensChoice[];
  /** Set while the CLI is running, so the form can say so and refuse a second submit. */
  busy: boolean;
  error: string | null;
}

export const EMPTY_EPIC_FORM: EpicForm = {
  title: '', description: '', goal: '', profile: null, lens: null,
  profiles: [], lenses: [], busy: false, error: null
};

/**
 * What still stands between this form and an Epic.
 *
 * Shown all at once. A chain of prompts reveals these one at a time, which is how a five-field form
 * takes five attempts.
 */
export function epicProblems(form: EpicForm): string[] {
  const problems: string[] = [];
  if (!form.title.trim()) problems.push('Give the Epic a title.');
  if (!form.description.trim()) problems.push('Say what is being asked for.');
  if (!form.goal.trim()) problems.push('Say what outcome would make this a success.');
  if (!form.profile) problems.push('Choose the delivery profile, which decides the phases this Epic runs.');
  if (form.lenses.length && !form.lens) problems.push('Choose the working lens this Epic starts under.');
  return problems;
}

/** The argv this form describes, once it has no problems. */
export function epicCommand(form: EpicForm): string[] {
  const args = ['epic', 'start', '--local',
    '--title', form.title.trim(),
    '--description', form.description.trim(),
    '--goal', form.goal.trim(),
    '--profile', form.profile ?? ''];
  if (form.lens) args.push('--persona', form.lens);
  return args;
}

function profileHtml(form: EpicForm): string {
  if (!form.profiles.length) {
    return '<p class="muted">This repository declares no delivery profiles.</p>';
  }
  return form.profiles.map((profile) => `
    <article class="card ${form.profile === profile.id ? 'yours' : 'others'}">
      <div class="card-head">
        <label>
          <input type="radio" name="profile" data-choose-profile="${escape(profile.id)}"
            ${form.profile === profile.id ? 'checked' : ''}>
          <strong>${escape(profile.label)}</strong>
        </label>
        <span class="grow"></span>
        <span class="muted">${profile.phases.length} ${profile.phases.length === 1 ? 'phase' : 'phases'}</span>
      </div>
      ${profile.description && !/^\d+ governed phases$/.test(profile.description)
    ? `<p class="muted">${escape(profile.description)}</p>` : ''}
      ${profile.phases.length
    ? `<ul class="chain">${profile.phases.map((phase) => `<li>${escape(phase)}</li>`).join('')}</ul>`
    : ''}
    </article>`).join('');
}

export function epicFormHtml(form: EpicForm): string {
  const problems = epicProblems(form);
  return `
  <header>
    <h1>${icon('epic', { size: 20 })}Start an Epic</h1>
    <p class="meta">What is being asked for, what would make it a success, and the lifecycle it will
      run. The profile is pinned when the Epic starts and cannot be changed afterwards.</p>
  </header>

  <section class="plain">
    <h2>${icon('document')}What this is</h2>
    <p><label>Title <input type="text" value="${escape(form.title)}" data-epic="title" size="46"
      placeholder="One-tap checkout"></label></p>
    <p><label>What is being asked for
      <input type="text" value="${escape(form.description)}" data-epic="description" size="60"></label></p>
    <p><label>What outcome would make this a success
      <input type="text" value="${escape(form.goal)}" data-epic="goal" size="60"></label></p>
    <p class="muted">The goal is what the measurement plan is written against later, so it is worth
      stating as something that could be shown false.</p>
  </section>

  <section>
    <h2>${icon('gate')}Delivery profile</h2>
    <p class="question">Which phases this Epic runs, and therefore which artifacts and approvals it
      will need. Pinned at start: a profile chosen here is the one it is governed by throughout.</p>
    ${profileHtml(form)}
  </section>

  <section>
    <h2>${icon('capability')}Working lens</h2>
    ${form.lenses.length ? `
    <p>
      <label>Lens <select data-epic="lens">
        <option value=""${form.lens ? '' : ' selected'}>— choose —</option>
        ${form.lenses.map((lens) => `<option value="${escape(lens.id)}"${lens.id === form.lens ? ' selected' : ''}>${escape(lens.label)}</option>`).join('')}
      </select></label>
    </p>
    <p class="muted">The lens this Epic starts under. It shapes the prompts each phase composes, and
      is recorded with every decision made under it.</p>`
    : '<p class="muted">This repository declares no working lenses.</p>'}
  </section>

  <section>
    ${problems.length
    ? `<h2>${icon('bad')}Before this can start</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>${icon('ok')}Ready</h2><p class="ok-text">Starts on the ${escape(form.profiles.find((profile) => profile.id === form.profile)?.label ?? '')} lifecycle.</p>`}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-epic-submit="start" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy ? 'Starting…' : 'Start Epic'}
      </button>
    </p>
  </section>`;
}

/** The page reports intent; every value is re-validated before it reaches the CLI. */
export const EPIC_FORM_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-choose-profile],[data-epic-submit]');
    if (!target) return;
    if (target.dataset.chooseProfile) {
      vscode.postMessage({ type: 'profile', id: target.dataset.chooseProfile });
    } else {
      vscode.postMessage({ type: 'start' });
    }
  });
  /**
   * Typed values are reported without the panel re-rendering — replacing the document on every
   * keystroke would take the caret with it — so the submit button's own state is kept here.
   */
  const affordances = () => {
    const filled = ['title', 'description', 'goal']
      .every((field) => (document.querySelector('[data-epic="' + field + '"]')?.value ?? '').trim());
    const profile = document.querySelector('[data-choose-profile]:checked');
    const lensField = document.querySelector('[data-epic="lens"]');
    const lens = !lensField || lensField.value;
    const button = document.querySelector('[data-epic-submit]');
    if (button) button.disabled = !(filled && profile && lens);
  };
  const report = (event) => {
    const field = event.target.dataset?.epic;
    if (!field) return false;
    vscode.postMessage({ type: 'field', field, value: event.target.value });
    return true;
  };
  document.addEventListener('input', (event) => { if (report(event)) affordances(); });
  document.addEventListener('change', (event) => { report(event); affordances(); });
`;

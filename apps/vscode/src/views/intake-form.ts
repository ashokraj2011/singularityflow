/**
 * Work intake: the one screen that starts anything.
 *
 * Work does not arrive in one shape. Some of it starts as an Initiative and is broken down into
 * Epics and then Stories; some arrives already an Epic; some is a single Story somebody just needs
 * to do. And any of the three may or may not have a tracker behind it. Six paths, and until now the
 * only way to tell them apart was knowing which of six commands to type.
 *
 * So the shape is the first question, asked plainly, with what each one leads to — because the
 * difference between them is what happens afterwards, not what you fill in now. The tracker is the
 * second, and it is a real choice rather than a requirement: nothing here needs Jira.
 *
 * The fields then follow from those two answers. A form that shows all six sets at once is a form
 * nobody reads.
 */
import { escape, icon } from './webview.ts';

/** What is being started. The order is the order they nest in. */
export type Shape = 'initiative' | 'epic' | 'story';

/** Where the work is tracked. `none` is a first-class answer, not a degraded one. */
export type Tracker = 'jira' | 'none';

export interface ProfileChoice {
  id: string;
  label: string;
  description: string;
  /** The phases this profile runs, which is what actually differs between them. */
  phases: string[];
}

/** Something already started, so nobody starts it twice. */
export interface InFlight {
  shape: Shape;
  id: string;
  title: string;
  status: string;
  /** Completed work stays visible but must not be described as under way. */
  completed?: boolean;
}

export interface IntakeForm {
  shape: Shape;
  tracker: Tracker;
  /** The tracker key, when there is a tracker: an Initiative, Epic or Story key. */
  key: string;
  /** The identifier to use when there is no tracker to supply one. */
  id: string;
  title: string;
  description: string;
  /** What outcome would make this a success. An Epic asks for it; the others do not. */
  goal: string;
  /** How it will be judged done. A Story asks for it. */
  acceptanceCriteria: string;
  profile: string | null;
  profiles: ProfileChoice[];
  /** Story workflow selected from workflow.yml. Passed explicitly because VS Code has no TTY. */
  workType: string | null;
  storyWorkflows: ProfileChoice[];
  /** Why Story workflows could not be loaded, when the repository could not provide them. */
  workflowReason: string | null;
  /** Whether a tracker is actually configured. Offering Jira when it is not is a dead end. */
  jiraConfigured: boolean;
  /** Why Jira is unavailable, when it is. */
  jiraReason: string | null;
  inFlight: InFlight[];
  busy: boolean;
  error: string | null;
}

export const EMPTY_INTAKE_FORM: IntakeForm = {
  shape: 'epic', tracker: 'none', key: '', id: '', title: '', description: '', goal: '',
  acceptanceCriteria: '', profile: null, profiles: [], workType: null, storyWorkflows: [],
  workflowReason: null,
  jiraConfigured: false, jiraReason: null, inFlight: [], busy: false, error: null
};

/** What each shape is, and — the part that matters — what it leads to. */
export const SHAPES: { id: Shape; label: string; leads: string }[] = [
  {
    id: 'initiative',
    label: 'Initiative',
    leads: 'The full lifecycle, from discovery through an approved business case, broken down into '
      + 'Epics and then Stories. Start here when what to build is still a question.'
  },
  {
    id: 'epic',
    label: 'Epic',
    leads: 'Requirements, impact analysis and planning, broken down into Stories. Start here when '
      + 'what to build is agreed and how to build it is not.'
  },
  {
    id: 'story',
    label: 'Story',
    leads: 'One governed branch through its phases to a reviewed change. Start here when the work '
      + 'is already understood.'
  }
];

/** Whether this shape runs phases chosen from a profile. A Story takes its phases from its work type. */
export function needsProfile(shape: Shape): boolean {
  return shape === 'initiative' || shape === 'epic';
}

/**
 * Whether this form supplies an identifier at all.
 *
 * An untracked Epic does not: its identifier is minted by the branch reservation that starts it, so
 * asking for one would be asking for a value that is about to be overwritten.
 */
export function mintsIdentifier(form: IntakeForm): boolean {
  return form.shape === 'epic' && form.tracker === 'none';
}

/** The identifier this form will use, whichever way it was supplied. Empty when it is minted. */
export function intakeIdentifier(form: IntakeForm): string {
  if (mintsIdentifier(form)) return '';
  return (form.tracker === 'jira' ? form.key : form.id).trim();
}

/**
 * What still stands between this form and started work.
 *
 * Shown all at once. Revealing them one at a time is how a five-field form takes five attempts.
 */
export function intakeProblems(form: IntakeForm): string[] {
  const problems: string[] = [];
  const identifier = intakeIdentifier(form);

  if (form.tracker === 'jira') {
    if (!form.jiraConfigured) {
      problems.push(form.jiraReason ?? 'No Jira is configured, so there is no key to fetch.');
    }
    if (!identifier) problems.push(`Give the ${form.shape}'s Jira key.`);
  } else {
    if (!mintsIdentifier(form)) {
      if (!identifier) problems.push(`Give the ${form.shape} an identifier.`);
      else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)) {
        problems.push('The identifier may contain letters, numbers, dots, underscores and hyphens.');
      }
    }
    // With a tracker, the title and the rest are fetched. Without one, they are the whole input.
    if (!form.title.trim()) problems.push(`Give the ${form.shape} a title.`);
    if (!form.description.trim()) problems.push('Say what is being asked for.');
    if (form.shape === 'epic' && !form.goal.trim()) {
      problems.push('Say what outcome would make this a success.');
    }
  }

  if (needsProfile(form.shape) && form.profiles.length && !form.profile) {
    problems.push('Choose the delivery profile, which decides the phases this runs.');
  }
  if (form.shape === 'story') {
    if (form.storyWorkflows.length && !form.workType) {
      problems.push('Choose the Story workflow, which decides the phases this runs.');
    } else if (!form.storyWorkflows.length) {
      problems.push(form.workflowReason ?? 'No Story workflow is configured in singularity/workflow.yml.');
    }
  }
  if (identifier && form.inFlight.some((entry) => entry.id === identifier)) {
    problems.push(`'${identifier}' has already been started. Open it rather than starting it again.`);
  }
  return problems;
}

/**
 * The argv this form describes, once it has no problems.
 *
 * Six paths, and each one is a different command — which is precisely why the screen exists. A
 * person starting work should not have to know which of six to type.
 */
export function intakeCommand(form: IntakeForm): string[] {
  const identifier = intakeIdentifier(form);
  const tracked = form.tracker === 'jira';

  if (form.shape === 'initiative') {
    const args = ['initiative', 'start', identifier, '--json'];
    if (tracked) args.push('--jira');
    else {
      args.push('--title', form.title.trim(), '--description', form.description.trim());
    }
    if (form.profile) args.push('--profile', form.profile);
    return args;
  }

  if (form.shape === 'epic') {
    if (tracked) {
      return ['epic', 'start', identifier, '--json'];
    }
    // No identifier: the branch reservation mints it, and passing one would be passing a value the
    // engine is about to replace.
    const args = ['epic', 'start', '--local', '--json',
      '--title', form.title.trim(),
      '--description', form.description.trim(),
      '--goal', form.goal.trim()];
    if (form.profile) args.push('--profile', form.profile);
    return args;
  }

  // A Story with a tracker is fetched by key; without one, its content is what was typed here.
  if (tracked) return ['story', 'start', identifier, '--json', '--fetch', '--work-type', form.workType!];
  const args = ['start', identifier, '--json', '--fetch',
    '--title', form.title.trim(), '--description', form.description.trim(),
    '--work-type', form.workType!];
  if (form.acceptanceCriteria.trim()) {
    args.push('--acceptance-criteria', form.acceptanceCriteria.trim());
  }
  return args;
}

function shapeHtml(form: IntakeForm): string {
  return `
    <div class="choices">
      ${SHAPES.map((shape) => `
      <label class="choice${shape.id === form.shape ? ' chosen' : ''}">
        <input type="radio" name="shape" value="${shape.id}" data-shape="${shape.id}"${shape.id === form.shape ? ' checked' : ''}>
        <span class="choice-label">${icon(shape.id === 'story' ? 'story' : shape.id === 'epic' ? 'epic' : 'impact')}${escape(shape.label)}</span>
        <span class="choice-detail">${escape(shape.leads)}</span>
      </label>`).join('')}
    </div>`;
}

/**
 * Where the work is tracked.
 *
 * A tracker is not a requirement, and saying so plainly matters: teams without Jira were reading a
 * key field and concluding the product was not for them. When Jira is not configured the option is
 * still shown, with the reason, rather than hidden — hiding it makes a missing integration look like
 * a missing feature.
 */
function trackerHtml(form: IntakeForm): string {
  return `
    <div class="choices">
      <label class="choice${form.tracker === 'none' ? ' chosen' : ''}">
        <input type="radio" name="tracker" value="none" data-tracker="none"${form.tracker === 'none' ? ' checked' : ''}>
        <span class="choice-label">${icon('document')}No tracker</span>
        <span class="choice-detail">Described here and governed in Git. Nothing else is needed.</span>
      </label>
      <label class="choice${form.tracker === 'jira' ? ' chosen' : ''}">
        <input type="radio" name="tracker" value="jira" data-tracker="jira"${form.tracker === 'jira' ? ' checked' : ''}>
        <span class="choice-label">${icon('tracker')}Jira</span>
        <span class="choice-detail">${form.jiraConfigured
    ? 'Fetched by key: the title, description and acceptance criteria come from the issue.'
    : escape(form.jiraReason ?? 'Not configured on this machine.')}</span>
      </label>
    </div>`;
}

/** The fields the chosen shape and tracker actually need. */
function fieldsHtml(form: IntakeForm): string {
  const noun = form.shape === 'initiative' ? 'Initiative' : form.shape === 'epic' ? 'Epic' : 'Story';

  if (form.tracker === 'jira') {
    return `
    <p>
      <label>${escape(noun)} key <input type="text" value="${escape(form.key)}" data-field="key"
        placeholder="${form.shape === 'story' ? 'ENG-142' : 'PAY-17'}" size="16"></label>
    </p>
    <p class="muted">Everything else is read from the issue, so it stays the tracker's to change.</p>`;
  }

  return `
    ${mintsIdentifier(form) ? `
    <p class="muted">${icon('branch')}The identifier is minted when the Epic reserves its branch, so
      there is nothing to choose here.</p>` : `
    <p>
      <label>Identifier <input type="text" value="${escape(form.id)}" data-field="id"
        placeholder="${form.shape === 'story' ? 'checkout-retry' : 'faster-checkout'}" size="24"></label>
    </p>`}
    <p>
      <label>Title <input type="text" value="${escape(form.title)}" data-field="title"
        placeholder="What this is called" size="42"></label>
    </p>
    <p>
      <label>What is being asked for<br>
        <textarea data-field="description" rows="3" cols="64">${escape(form.description)}</textarea></label>
    </p>
    ${form.shape === 'epic' ? `
    <p>
      <label>What would make this a success<br>
        <textarea data-field="goal" rows="2" cols="64">${escape(form.goal)}</textarea></label>
    </p>` : ''}
    ${form.shape === 'story' ? `
    <p>
      <label>How it will be judged done<br>
        <textarea data-field="acceptanceCriteria" rows="3" cols="64" placeholder="One per line">${escape(form.acceptanceCriteria)}</textarea></label>
    </p>
    <p class="muted">Each line becomes an acceptance criterion, and each one is what a test is tagged
      against later.</p>` : ''}`;
}

/**
 * The profile, shown with the phases it runs.
 *
 * That is the whole difference between profiles and it is invisible in a picker that shows names.
 * The choice is also permanent for the life of the work — it decides the phases — so it is the one
 * field on this screen that deserves the room.
 */
function profileHtml(form: IntakeForm): string {
  if (!needsProfile(form.shape) || !form.profiles.length) return '';
  return `
  <section>
    <h2>${icon('gate')}Delivery profile</h2>
    <p class="question">Which phases this runs. Pinned when it starts, so a later edit to the
      configuration cannot change work already under way.</p>
    <div class="choices">
      ${form.profiles.map((profile) => `
      <label class="choice workflow-choice${profile.id === form.profile ? ' chosen' : ''}">
        <input type="radio" name="profile" value="${escape(profile.id)}" data-profile="${escape(profile.id)}"${profile.id === form.profile ? ' checked' : ''}>
        <span class="workflow-copy">
          <span class="choice-label">${escape(profile.label)}</span>
          <span class="workflow-description">${escape(profile.description)}</span>
        </span>
        ${phaseRailHtml(profile.phases)}
      </label>`).join('')}
    </div>
  </section>`;
}

/**
 * Story workflow selection is deliberately part of intake.
 *
 * The CLI can ask this question in a terminal; a VS Code webview cannot. Showing the repository's
 * configured workflows here keeps the decision visible and means every Story start carries an
 * explicit `--work-type` instead of falling into the non-interactive guard.
 */
function storyWorkflowHtml(form: IntakeForm): string {
  if (form.shape !== 'story') return '';
  if (!form.storyWorkflows.length) {
    return `<section><h2>${icon('workflow')}Story workflow</h2>
      <p class="blockers">${escape(form.workflowReason ?? 'No Story workflow is configured in singularity/workflow.yml.')}</p></section>`;
  }
  return `
  <section>
    <h2>${icon('workflow')}Story workflow</h2>
    <p class="question">Choose the workflow template for this Story. Its ordered phases are pinned
      when work starts and cannot change underneath the Story.</p>
    <div class="choices">
      ${form.storyWorkflows.map((workflow) => `
      <label class="choice workflow-choice${workflow.id === form.workType ? ' chosen' : ''}">
        <input type="radio" name="workType" value="${escape(workflow.id)}" data-work-type="${escape(workflow.id)}"${workflow.id === form.workType ? ' checked' : ''}>
        <span class="workflow-copy">
          <span class="choice-label">${escape(workflow.label)}</span>
          <span class="workflow-description">${escape(workflow.description)}</span>
        </span>
        ${phaseRailHtml(workflow.phases)}
      </label>`).join('')}
    </div>
  </section>`;
}

/** A workflow reads left-to-right, while wrapping whole steps together on narrow editor columns. */
function phaseRailHtml(phases: string[]): string {
  const label = `Ordered phases: ${phases.join(', ')}`;
  return `<span class="workflow-phases" aria-label="${escape(label)}">
    ${phases.map((phase, index) => `<span class="workflow-step">
      ${index > 0 ? `<span class="workflow-connector">${icon('next', { size: 14 })}</span>` : ''}
      <code>${escape(phase)}</code>
    </span>`).join('')}
  </span>`;
}

/** Started work, separated by lifecycle outcome so completed work is never called active. */
function inFlightHtml(form: IntakeForm): string {
  if (!form.inFlight.length) return '';
  const table = (entries: InFlight[]): string => `
    <table>
      <tbody>${entries.map((entry) => `
        <tr>
          <td>${icon(entry.shape === 'story' ? 'story' : entry.shape === 'epic' ? 'epic' : 'impact')}<code>${escape(entry.id)}</code></td>
          <td>${escape(entry.title)}</td>
          <td class="muted">${escape(entry.status)}</td>
        </tr>`).join('')}</tbody>
    </table>`;
  const active = form.inFlight.filter((entry) => !entry.completed);
  const completed = form.inFlight.filter((entry) => entry.completed);
  return `${active.length ? `
  <section class="plain">
    <h2>${icon('wait')}Already under way</h2>
    ${table(active)}
  </section>` : ''}${completed.length ? `
  <section class="plain">
    <h2>${icon('ok')}Completed</h2>
    ${table(completed)}
  </section>` : ''}`;
}

export function intakeHtml(form: IntakeForm): string {
  const problems = intakeProblems(form);
  const noun = form.shape === 'initiative' ? 'Initiative' : form.shape === 'epic' ? 'Epic' : 'Story';
  return `
  <header>
    <h1>${icon('epic', { size: 20 })}Start work</h1>
    <p class="meta">Work arrives in three shapes and with or without a tracker. Both are answered
      here, and the rest of the form follows from the answers.</p>
  </header>

  <section>
    <h2>${icon('capability')}What are you starting?</h2>
    ${shapeHtml(form)}
  </section>

  <section>
    <h2>${icon('tracker')}Where is it tracked?</h2>
    ${trackerHtml(form)}
  </section>

  <section>
    <h2>${icon('document')}The ${escape(noun.toLowerCase())}</h2>
    ${fieldsHtml(form)}
  </section>

  ${profileHtml(form)}
  ${storyWorkflowHtml(form)}
  ${inFlightHtml(form)}

  <section>
    ${problems.length
    ? `<h2>${icon('bad')}Before this can start</h2><ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul>`
    : `<h2>${icon('ok')}Ready</h2><p class="ok-text">${mintsIdentifier(form)
      ? `Reserves a branch for this ${escape(noun.toLowerCase())}, which is what mints its identifier, and commits its first governed state.`
      : `Starts ${escape(noun.toLowerCase())} <code>${escape(intakeIdentifier(form))}</code> and commits its first governed state.`}</p>`}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-submit="start" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy ? 'Starting…' : `Start this ${escape(noun.toLowerCase())}`}
      </button>
    </p>
  </section>`;
}

/** The page reports intent; every value is re-validated before it reaches the CLI. */
export const INTAKE_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-submit]');
    if (target) vscode.postMessage({ type: 'start' });
  });
  /**
   * A shape or tracker change redraws, because it changes which fields exist. A keystroke does not,
   * because replacing the document under whoever is typing would take the caret with it — it is
   * reported as a draft and read back when the form is submitted.
   */
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (el.dataset?.shape) return vscode.postMessage({ type: 'shape', value: el.dataset.shape });
    if (el.dataset?.tracker) return vscode.postMessage({ type: 'tracker', value: el.dataset.tracker });
    if (el.dataset?.profile) return vscode.postMessage({ type: 'profile', value: el.dataset.profile });
    if (el.dataset?.workType) return vscode.postMessage({ type: 'workType', value: el.dataset.workType });
    if (el.dataset?.field) vscode.postMessage({ type: 'field', field: el.dataset.field, value: el.value });
  });
  document.addEventListener('input', (event) => {
    const field = event.target.dataset?.field;
    if (field) vscode.postMessage({ type: 'draft', field, value: event.target.value });
  });
`;

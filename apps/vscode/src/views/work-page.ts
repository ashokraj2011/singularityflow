/**
 * The Work place [FPL:REQ-004 to REQ-007, REQ-037]: the sidebar tab's box, its likely plan, In progress and Done this week,
 * and the one reused task page, built from the engine's `work list --json`, `work "<words>" --plan-only --json` and
 * `work status <ID> --json`. Pure: no VS Code API, so the host tests read every string.
 *
 * Start sends exactly `/sf-task <words>` (the extension's singularityFlow.startTask); the box never waits for the likely
 * plan, which is only a preview: the plan the chat says is the plan. Off until M5 switches singularityFlow.navigation.layout.
 */
import { escape } from './webview.ts';

export type WorkChip = { id: string; label: string; state: 'done' | 'now' | 'waits-for-you' | 'to-do' | 'added'; added?: boolean; words: string };
export type WorkRoute = { checkout: string | null; clone: string | null; here: boolean; elsewhere: string[] };
export type WorkRow = {
  key: string; id: string; title: string; task: boolean; kind: string | null; repository: { id: string; name: string };
  startedWhen: string | null; startedBy: string | null; status: string; chips: WorkChip[]; statusLine: string; standing: string;
  waiting: { key: string; question: string } | null; ended: { when: string | null; where: string } | null; route: WorkRoute;
};
export type WorkList = {
  inProgress: WorkRow[]; doneThisWeek: WorkRow[]; here: { id: string; name: string } | null; otherRepositories: number;
  workspace: { id: string; name: string } | null; checked: string | null; lines: string[];
};
export type WorkTask = {
  id: string; title: string; kind: string | null; base: string | null; task: boolean; done: boolean; status: string;
  startedBy: string | null; startedAt: string | null; planFrom: string | null; planNote: string | null; chips: WorkChip[];
  events: Array<{ when: string | null; words: string }>; now: string | null; next: string | null;
  documents: Array<{ label: string; path: string }>; rules: string[]; addable: Array<{ step: string; label: string }>;
  changed: { base: string; files: Array<{ path: string; added: number | null; removed: number | null; binary: boolean }>; total: number } | null;
};
/** What a person's Needs-you item says about a Story, from the live list. */
export type WaitingItem = { key: string; question: string; story?: { id: string } | null; repository?: { id: string } | null; step?: { id: string } | null };

const object = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const text = (value: unknown, limit = 600): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, limit) : null);
const KEY = /^[A-Za-z0-9._/@:-]{1,300}$/u;
const ID = /^[A-Za-z0-9._/-]{1,128}$/u;
const STATES = new Set(['done', 'now', 'waits-for-you', 'to-do', 'added']);
const STATE_WORDS: Record<WorkChip['state'], string> = { done: 'done', now: 'now', 'waits-for-you': 'waits for you', 'to-do': 'to do', added: 'added' };
const KIND_WORDS: Record<string, string> = { fix: 'Fix', feature: 'Feature', change: 'Change', refactor: 'Refactor', tests: 'Tests',
  docs: 'Document', investigate: 'Investigation', review: 'Review', chore: 'Chore' };

function chipsFrom(value: unknown): WorkChip[] {
  return (Array.isArray(value) ? value : []).slice(0, 30).flatMap((entry) => {
    const chip = object(entry);
    const id = text(chip?.id, 128);
    const label = text(chip?.label, 120);
    const state = String(chip?.state ?? '');
    if (!id || !label || !STATES.has(state)) return [];
    return [{ id, label, state: state as WorkChip['state'], ...(chip?.added === true ? { added: true } : {}), words: text(chip?.words, 200) ?? `${label}, ${STATE_WORDS[state as WorkChip['state']]}` }];
  });
}

/** One row from untrusted CLI output, bounded; null when it is not a row. */
export function workRowFrom(value: unknown): WorkRow | null {
  const row = object(value);
  const id = text(row?.id, 128);
  const repository = object(row?.repository);
  const repositoryId = text(repository?.id, 128);
  if (!row || !id || !ID.test(id) || !repositoryId) return null;
  const route = object(row.route);
  const elsewhere = object(route?.elsewhere);
  const waiting = object(row.waiting);
  const ended = object(row.ended);
  const statusLine = text(row.statusLine, 400) ?? '';
  return {
    key: `${repositoryId}:${id}`, id, title: text(row.title, 300) ?? id, task: row.task === true, kind: text(row.kind, 40),
    repository: { id: repositoryId, name: text(repository?.name, 128) ?? repositoryId },
    startedWhen: text(row.startedWhen, 40), startedBy: text(row.startedBy, 120), status: text(row.status, 40) ?? 'in_progress',
    chips: chipsFrom(row.chips), statusLine, standing: text(row.standing, 400) ?? statusLine,
    waiting: waiting && text(waiting.key, 300) && KEY.test(String(waiting.key)) ? { key: String(waiting.key), question: text(waiting.question, 400) ?? '' } : null,
    ended: ended && text(ended.where, 80) ? { when: text(ended.when, 40), where: String(ended.where) } : null,
    route: { checkout: text(route?.checkout, 2000), clone: text(route?.clone, 2000), here: route?.here === true,
      elsewhere: (Array.isArray(elsewhere?.commands) ? elsewhere.commands : []).map((entry) => text(entry, 1000)).filter((entry): entry is string => Boolean(entry)).slice(0, 4) }
  };
}

/** The list from untrusted CLI output (`sflow-work-list`), or null. */
export function workListFrom(value: unknown): WorkList | null {
  const result = object(value);
  if (result?.resultType !== 'sflow-work-list' || !Array.isArray(result.inProgress)) return null;
  const rows = (entries: unknown) => (Array.isArray(entries) ? entries : []).slice(0, 200).map(workRowFrom).filter((row): row is WorkRow => Boolean(row));
  const here = object(result.here);
  const workspace = object(result.workspace);
  return {
    inProgress: rows(result.inProgress), doneThisWeek: rows(result.doneThisWeek),
    here: here && text(here.id, 128) ? { id: String(here.id), name: text(here.name, 128) ?? String(here.id) } : null,
    otherRepositories: Math.max(0, Number(result.otherRepositories) || 0),
    workspace: workspace && text(workspace.id, 128) ? { id: String(workspace.id), name: text(workspace.name, 200) ?? String(workspace.id) } : null,
    checked: text(object(result.checked)?.words, 200),
    lines: (Array.isArray(result.lines) ? result.lines : []).map((line) => text(line, 300)).filter((line): line is string => Boolean(line)).slice(0, 30)
  };
}

/**
 * The likely plan's line for the box [FPL:REQ-004], from `work "<words>" --plan-only --json`: "Likely plan: code → tests.
 * You approve …". Null when SFlow cannot tell the kind: then there is no line.
 */
export function likelyPlanFrom(value: unknown): string | null {
  const plan = text(object(value)?.plan, 600);
  if (object(value)?.resultType !== 'sflow-task-likely-plan' || !plan) return null;
  return plan.replace(/^Plan\b/u, 'Likely plan').replace(/\s*Say "add a design step" to change it\.$/u, '');
}

/** The task page's read from untrusted CLI output (`sflow-task-status`), or null. */
export function workTaskFrom(value: unknown): WorkTask | null {
  const result = object(value);
  const id = text(result?.id, 128);
  if (result?.resultType !== 'sflow-task-status' || !id) return null;
  const steps = (Array.isArray(result.steps) ? result.steps : []).map(object).filter(Boolean);
  const changed = object(result.changed);
  return {
    id, title: text(result.title, 300) ?? id, kind: text(result.kind, 40), base: text(result.base, 200), task: result.task === true,
    done: result.done === true, status: text(result.status, 40) ?? 'in_progress', startedBy: text(result.startedBy, 120), startedAt: text(result.startedAt, 40),
    planFrom: text(result.planFrom, 300), planNote: text(result.planNote, 1200), chips: chipsFrom(result.chips),
    events: (Array.isArray(result.events) ? result.events : []).map(object).filter(Boolean).slice(-40)
      .map((event) => ({ when: text(event?.when, 40), words: text(event?.words, 300) ?? '' })).filter((event) => event.words),
    now: text(result.now, 200), next: text(result.next, 200),
    documents: steps.flatMap((step) => (text(step?.document, 1000) ? [{ label: text(step?.label, 200) ?? 'Document', path: String(step?.document) }] : [])),
    rules: (Array.isArray(result.rulesApplied) ? result.rulesApplied : []).map((entry) => text(object(entry)?.because, 400)).filter((entry): entry is string => Boolean(entry)).slice(0, 20),
    addable: (Array.isArray(result.addable) ? result.addable : []).map(object).flatMap((entry) => {
      const step = text(entry?.step, 40);
      return step && ['requirements', 'design', 'plan', 'review'].includes(step) ? [{ step, label: text(entry?.label, 80) ?? step }] : [];
    }),
    changed: changed && text(changed.base, 200) ? {
      base: String(changed.base), total: Math.max(0, Number(changed.total) || 0),
      files: (Array.isArray(changed.files) ? changed.files : []).map(object).filter(Boolean).slice(0, 200).flatMap((file) => (text(file?.path, 1000)
        ? [{ path: String(file?.path), added: typeof file?.added === 'number' ? file.added : null, removed: typeof file?.removed === 'number' ? file.removed : null, binary: file?.binary === true }] : []))
    } : null
  };
}

/**
 * The row as the live Needs-you list says it [FPL:REQ-005, REQ-015]: "Waiting for you: <the card's question>" while an item
 * of this person's belongs to its Story, else its own line; an item acted on leaves at once.
 */
export function withLiveWaiting(row: WorkRow, items: readonly WaitingItem[] | null): WorkRow {
  if (!items) return row;
  const item = items.find((entry) => entry.story?.id === row.id && entry.repository?.id === row.repository.id) ?? null;
  if (!item) {
    if (!row.waiting) return row;
    return { ...row, waiting: null, statusLine: row.standing, chips: row.chips.map((chip) => (chip.state === 'waits-for-you' ? { ...chip, state: 'now', words: `${chip.label}, now` } : chip)) };
  }
  const step = item.step?.id ?? null;
  return { ...row, waiting: { key: item.key, question: item.question }, statusLine: `Waiting for you: ${item.question}`,
    chips: row.chips.map((chip) => (chip.id === step && chip.state !== 'done' ? { ...chip, state: 'waits-for-you', words: `${chip.label}, waits for you` } : chip)) };
}

/**
 * The plan as one line of chips [FPL:REQ-005, REQ-037]: an ordered list, each state in words as well as colour; the
 * arrows between them are hidden from screen readers.
 */
export function chipsHtml(chips: readonly WorkChip[], label: string): string {
  if (!chips.length) return '';
  const stateOf = (chip: WorkChip) => (chip.words.startsWith(`${chip.label}, `) ? chip.words.slice(chip.label.length + 2) : STATE_WORDS[chip.state]);
  return `<ol class="work-chips" aria-label="${escape(label)}">${chips.map((chip, index) => `<li class="work-chip" data-state="${escape(chip.state)}">${index ? '<span class="work-arrow" aria-hidden="true">→</span> ' : ''}<span class="work-chip-label">${escape(chip.label)}</span><span class="work-chip-state">, ${escape(stateOf(chip))}</span></li>`).join('')}</ol>`;
}

function rowHtml(row: WorkRow): string {
  const meta = [row.id, row.repository.name, row.startedWhen ? `started ${row.startedWhen}` : null].filter(Boolean).join(' · ');
  const line = row.waiting
    ? `<button type="button" class="work-waiting" data-key="${escape(row.waiting.key)}">${escape(row.statusLine)}</button>`
    : `<p class="work-status">${escape(row.statusLine)}</p>`;
  return `<li class="work-item"><button type="button" class="work-open" data-task="${escape(row.key)}"><span class="work-title">${escape(row.title)}</span>
    <span class="work-meta">${escape(meta)}</span></button>${chipsHtml(row.chips, `Plan of ${row.id}`)}${line}</li>`;
}

/** The box [FPL:REQ-004]: the words, Start, the likely plan's line, the window's repository and Start with a workflow. */
export function workBoxHtml(list: WorkList | null, { draft = '', likely = null as string | null } = {}): string {
  const where = list?.here && list.otherRepositories > 0
    ? `<p class="work-where">In ${escape(list.here.name)}. <button type="button" class="link" data-act="repository">Another repository…</button></p>` : '';
  return `<form class="work-box" data-box="1">
  <label for="work-words" class="work-box-label">What do you want done?</label>
  <div class="work-box-row"><input id="work-words" type="text" autocomplete="off" spellcheck="true" value="${escape(draft)}" placeholder="fix the login timeout on slow networks" aria-describedby="work-likely">
  <button type="submit" class="work-start">Start</button></div>
  <p id="work-likely" class="work-likely" aria-live="polite">${escape(likely ?? '')}</p>
  ${where}<button type="button" class="link" data-act="workflow">Start with a workflow…</button>
</form>`;
}

/** The Work tab's panel [FPL:REQ-004, REQ-005, REQ-007]: the box, In progress, Done this week and All Stories. */
export function workPanelHtml(list: WorkList | null, { draft = '', likely = null as string | null, reading = false, error = null as string | null,
  waiting = null as readonly WaitingItem[] | null } = {}): string {
  const box = workBoxHtml(list, { draft, likely });
  if (!list) return `${box}<p class="work-empty" role="status">${escape(error ?? (reading ? 'Reading your tasks…' : 'Nothing read yet.'))}</p>`;
  const inProgress = list.inProgress.map((row) => withLiveWaiting(row, waiting));
  const progress = inProgress.length ? `<ul class="work-rows">${inProgress.map(rowHtml).join('')}</ul>` : '<p class="work-empty">Nothing of yours is in flight.</p>';
  const done = list.doneThisWeek.length ? `<h2 class="work-group">Done this week</h2><ul class="work-rows">${list.doneThisWeek.map((row) => `<li class="work-item"><button type="button" class="work-open" data-task="${escape(row.key)}"><span class="work-title">${escape(row.title)}</span>
    <span class="work-meta">${escape([row.id, row.repository.name, row.ended ? `${row.ended.where}${row.ended.when ? `, ${row.ended.when}` : ''}` : null].filter(Boolean).join(' · '))}</span></button></li>`).join('')}</ul>` : '';
  const head = `<p class="work-checked">${escape(list.checked ?? (reading ? 'Reading…' : 'Not read yet'))}${reading ? ' · reading' : ''}</p>`;
  return `${box}<h2 class="work-group">In progress</h2>${head}${error ? `<p class="work-line" role="status">${escape(error)}</p>` : ''}${progress}${done}
  <p><button type="button" class="link" data-act="stories">All Stories in this workspace</button></p>${list.lines.map((line) => `<p class="work-line">${escape(line)}</p>`).join('')}`;
}

export const WORK_STYLE = `
.work-box { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 10px; }
.work-box-label { font-weight: 600; }
.work-box-row { display: flex; gap: 4px; }
.work-box-row input { flex: 1; min-width: 0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 3px 6px; font: inherit; }
.work-box-row input:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.work-start { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 3px 10px; cursor: pointer; font: inherit; }
.work-start:hover { background: var(--vscode-button-hoverBackground); }
.work-likely, .work-where, .work-meta, .work-status, .work-checked, .work-line, .work-empty { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0; overflow-wrap: anywhere; }
.link { background: none; border: 0; color: var(--vscode-textLink-foreground); padding: 2px 0; cursor: pointer; font: inherit; text-align: left; }
.work-group { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 12px 0 4px; color: var(--vscode-descriptionForeground); }
.work-rows { list-style: none; margin: 0; padding: 0; }
.work-item { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.work-open { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; background: none; border: 0; border-radius: 3px;
  padding: 2px 4px; color: var(--vscode-foreground); cursor: pointer; font: inherit; overflow-wrap: anywhere; }
.work-open:hover { background: var(--vscode-list-hoverBackground); }
.work-title { font-weight: 600; }
.work-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 2px 4px; margin: 4px 0; padding: 0 4px; font-size: 12px; }
.work-chip { display: inline-flex; align-items: baseline; gap: 3px; }
.work-chip-label { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 6px; }
.work-chip[data-state="done"] .work-chip-label { border-color: var(--vscode-testing-iconPassed, var(--vscode-panel-border)); }
.work-chip[data-state="now"] .work-chip-label { border-color: var(--vscode-focusBorder); font-weight: 600; }
.work-chip[data-state="waits-for-you"] .work-chip-label { border-color: var(--vscode-editorWarning-foreground); font-weight: 600; }
.work-chip-state { color: var(--vscode-descriptionForeground); }
.work-waiting { background: none; border: 0; padding: 2px 4px; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; text-align: left; overflow-wrap: anywhere; }
.work-open:focus-visible, .work-waiting:focus-visible, .link:focus-visible, .work-start:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;

/**
 * The Work tab's script, after the places' `vscode` handle and tab keys: the box (its draft kept across repaints, the likely
 * plan asked for after typing pauses for 600 ms, Start sent at once), each row, its card, and the links.
 */
export const WORK_SCRIPT = `
(() => {
  const input = document.getElementById('work-words');
  const likely = document.getElementById('work-likely');
  const saved = vscode.getState() || {};
  const keep = (change) => vscode.setState({ ...(vscode.getState() || {}), ...change });
  let timer = null;
  if (input) {
    if (typeof saved.draft === 'string') input.value = saved.draft;
    if (saved.focused) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    input.addEventListener('input', () => {
      keep({ draft: input.value });
      if (likely) likely.textContent = '';
      clearTimeout(timer);
      timer = setTimeout(() => vscode.postMessage({ type: 'places', action: 'work-plan', words: input.value }), 600);
    });
    input.addEventListener('focus', () => keep({ focused: true }));
    input.addEventListener('blur', () => keep({ focused: false }));
  }
  document.querySelector('[data-box]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const words = (input?.value || '').trim();
    if (!words) { input?.focus(); return; }
    clearTimeout(timer);
    vscode.postMessage({ type: 'places', action: 'work-start', words });
    input.value = '';
    if (likely) likely.textContent = '';
    keep({ draft: '' });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'work-likely' && input && likely && message.words === input.value) likely.textContent = message.text || '';
  });
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-task],[data-key],[data-act]');
    if (!target) return;
    if (target.dataset.task) vscode.postMessage({ type: 'places', action: 'work-open', key: target.dataset.task });
    else if (target.dataset.key) vscode.postMessage({ type: 'places', action: 'open', key: target.dataset.key });
    else if (target.dataset.act) vscode.postMessage({ type: 'places', action: 'work-act', act: target.dataset.act });
  });
})();
`;

/** What "Open in Copilot chat" does for this Story [FPL:REQ-006, A10]: `/sf-task` for a task, the Journey's route otherwise. */
export function chatRouteOf(row: Pick<WorkRow, 'task' | 'route'>): { kind: 'task' | 'journey' | 'elsewhere'; text: string } {
  if (!row.route.here) return { kind: 'elsewhere', text: row.route.elsewhere.join(' then ') };
  return row.task ? { kind: 'task', text: '/sf-task' } : { kind: 'journey', text: 'singularityFlow.prefillNextCommand' };
}

const lineCount = (file: { added: number | null; removed: number | null; binary: boolean }) => (file.binary ? 'binary'
  : `+${file.added ?? 0} −${file.removed ?? 0}`);

/** The one task page [FPL:REQ-006]: the header and its buttons, the plan, what is happening, documents, changes and rules. */
export function workTaskHtml(row: WorkRow, task: WorkTask | null, { result = null as string | null, lessons = 0, error = null as string | null } = {}): string {
  const kind = task?.kind ?? row.kind;
  const header = [row.id, kind ? KIND_WORDS[kind] ?? kind : row.task ? 'Task' : 'Story', task?.base ? `from ${task.base}` : null,
    row.repository.name, row.startedBy || task?.startedBy ? `started by ${row.startedBy ?? task?.startedBy}${row.startedWhen ? ` ${row.startedWhen}` : ''}` : null]
    .filter(Boolean).join(' · ');
  const inFlight = (task?.status ?? row.status) === 'in_progress';
  const route = chatRouteOf(row);
  const buttons = [
    row.route.here ? '<button type="button" class="secondary" data-act="intake">Intake</button>' : '',
    `<button type="button" class="primary" data-act="chat">Open in Copilot chat</button>`,
    inFlight && (row.route.checkout || row.route.clone) ? '<button type="button" class="secondary" data-act="stop">Stop the task</button>' : ''
  ].filter(Boolean).join(' ');
  const chips = task?.chips.length ? task.chips : row.chips;
  const add = inFlight && task?.addable.length ? `<div class="task-add"><label for="task-add-step">Add a step</label>
    <select id="task-add-step">${task.addable.map((entry) => `<option value="${escape(entry.step)}">${escape(entry.label)}</option>`).join('')}</select>
    <button type="button" class="secondary" data-act="add">Add the step</button></div>` : '';
  const events = task?.events.length ? `<ol class="task-events">${task.events.map((event) => `<li>${event.when ? `<span class="muted">${escape(event.when)}</span> ` : ''}${escape(event.words)}</li>`).join('')}</ol>` : '';
  const nowNext = task && !task.done ? `<p>Now: ${escape(task.now ?? '—')}</p>${task.next ? `<p>Next: ${escape(task.next)}</p>` : ''}` : '';
  const documents = task?.documents.length ? `<section aria-labelledby="documents-title"><h2 id="documents-title">Documents</h2><ul>${task.documents.map((document) => (row.route.checkout
    ? `<li><button type="button" class="link" data-document="${escape(document.path)}">${escape(document.label)}</button></li>` : `<li>${escape(document.label)}</li>`)).join('')}</ul></section>` : '';
  const changed = task?.changed ? `<section aria-labelledby="changed-title"><h2 id="changed-title">Changed files</h2>${task.changed.files.length
    ? `<ul class="task-files">${task.changed.files.map((file) => `<li><span>${escape(file.path)}</span> <span class="muted">${escape(lineCount(file))}</span></li>`).join('')}</ul>${task.changed.total > task.changed.files.length ? `<p class="muted">${task.changed.total - task.changed.files.length} more</p>` : ''}`
    : `<p class="muted">No files changed against ${escape(task.changed.base)} yet.</p>`}${row.route.here ? '<p><button type="button" class="secondary" data-act="explain">Explain the change</button></p>' : ''}</section>` : '';
  const rules = task?.rules.length ? `<section aria-labelledby="rules-title"><h2 id="rules-title">Rules applied</h2><ul>${task.rules.map((because) => `<li>${escape(because)}</li>`).join('')}</ul></section>` : '';
  const away = !row.route.here && row.route.elsewhere.length
    ? `<p class="muted">${escape(row.id)} is not open in this window. Open it with: ${row.route.elsewhere.map((command) => `<code>${escape(command)}</code>`).join(' then ')}</p>` : '';
  return `<main class="work-task">
<h1 id="task-title" tabindex="-1">${escape(row.title)}</h1>
<p class="muted">${escape(header)}</p>
<p>${escape(row.statusLine)}${row.waiting ? ` <button type="button" class="link" data-key="${escape(row.waiting.key)}">Open its card</button>` : ''}</p>
<div class="choices">${buttons}</div>
${away}
<section aria-labelledby="plan-title"><h2 id="plan-title">The plan</h2>${chipsHtml(chips, `Plan of ${row.id}`)}${add}
${task?.planFrom ? `<p class="muted">Its steps are from ${escape(task.planFrom)}.</p>` : ''}${task?.planNote ? `<p>${escape(task.planNote)}</p>` : ''}</section>
${events || nowNext ? `<section aria-labelledby="happening-title"><h2 id="happening-title">What is happening</h2>${events}${nowNext}</section>` : ''}
${documents}${changed}${rules}
${lessons > 0 ? `<p><button type="button" class="link" data-act="lessons">Lessons from this Story (${lessons})</button></p>` : ''}
${error ? `<p class="warning">${escape(error)}</p>` : ''}
<div id="task-result" role="status" aria-live="polite">${result ? escape(result) : ''}</div>
</main>`;
}

export const WORK_TASK_STYLE = `
.work-task { max-width: 820px; padding: 12px 16px; overflow-wrap: anywhere; }
.work-task h1 { font-size: 1.4em; margin: 0 0 6px; }
.work-task h2 { font-size: 1.05em; margin: 16px 0 4px; }
.work-task .muted { color: var(--vscode-descriptionForeground); }
.work-task .warning { color: var(--vscode-editorWarning-foreground); }
.work-task .choices { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.work-task .link { background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; text-align: left; }
.work-task .task-add { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0; }
.work-task .task-events, .work-task .task-files { padding-left: 18px; }
.work-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 6px; margin: 6px 0; padding: 0; }
.work-chip { display: inline-flex; align-items: baseline; gap: 3px; }
.work-chip-label { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 6px; }
.work-chip[data-state="now"] .work-chip-label { border-color: var(--vscode-focusBorder); font-weight: 600; }
.work-chip[data-state="waits-for-you"] .work-chip-label { border-color: var(--vscode-editorWarning-foreground); font-weight: 600; }
.work-chip-state { color: var(--vscode-descriptionForeground); }
#task-result { margin-top: 12px; }
`;

export const WORK_TASK_SCRIPT = `
const vscode = window.__sfVscode;
document.getElementById('task-title')?.focus();
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act],[data-document],[data-key]');
  if (!target) return;
  if (target.dataset.act === 'add') vscode.postMessage({ type: 'act', act: 'add', step: document.getElementById('task-add-step')?.value || '' });
  else if (target.dataset.act) vscode.postMessage({ type: 'act', act: target.dataset.act });
  else if (target.dataset.document) vscode.postMessage({ type: 'document', path: target.dataset.document });
  else if (target.dataset.key) vscode.postMessage({ type: 'card', key: target.dataset.key });
});
`;

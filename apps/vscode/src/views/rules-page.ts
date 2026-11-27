/**
 * The Rules place [FPL:REQ-019 to REQ-026, REQ-037]: the sidebar tab's list and the one reused Rules page with its form and
 * preview, built from the engine's `rules --json` and `rules preview --change-set - --json`. Pure: no VS Code API, so the
 * host tests read every string.
 *
 * Rules only add a step or a person's approval; workflows run as they are. The page proposes a change through Workflow
 * Studio's reviewed path (views/rules.ts); it writes nothing itself. Off until M5 switches singularityFlow.navigation.layout.
 */
import { escape } from './webview.ts';

export type RuleFields = { kinds: string[]; paths: string[]; steps: string[]; personApproves: string[]; workflow: string | null };
export type RuleProblem = { field: string; message: string };
export type RuleRow = {
  id: string; section: 'always' | 'paths' | 'use'; when: string; then: string; because: string; words: string; fields: RuleFields;
  problems: RuleProblem[];
};
export type BuiltInRule = { id: string; when: string; then: string; because: string; words: string };
export type WaitingRule = { branch: string; proposer: string | null; words: string; lines: string[] };
export type FormChoice = { id: string; words: string };
export type RulesList = {
  authority: { kind: string; ref: string | null; commit: string | null; remoteFingerprint: string | null; sourceCommit: string | null };
  base: { workflowSha256: string } | null;
  builtIn: BuiltInRule[]; rules: RuleRow[]; waiting: WaitingRule[]; idPrefix: { value: string; words: string };
  compose: Array<{ kind: string; words: string }>; workflowsWords: string; guidance: { count: number; words: string } | null;
  inFlight: { count: number; words: string | null } | null; problems: RuleProblem[];
  form: { kinds: FormChoice[]; steps: FormChoice[]; approves: FormChoice[]; workflows: Array<{ id: string; label: string }> };
  lines: string[];
};
export type RulesPreview = {
  valid: boolean; problems: RuleProblem[]; warnings: RuleProblem[]; summary: string[]; others: string | null;
  lines: Array<{ kind: string; touching: string | null; words: string; added: string[]; removed: string[] }>;
};
/** What the form sends: the rule as the `tasks.*` operations take it. */
export type RuleInput = { kinds: string[]; paths: string[]; steps: string[]; personApproves: string[]; workflow: string | null; because: string };

const object = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const text = (value: unknown, limit = 600): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, limit) : null);
const strings = (value: unknown, limit = 40, size = 300): string[] => (Array.isArray(value) ? value : []).slice(0, limit)
  .map((entry) => text(entry, size)).filter((entry): entry is string => Boolean(entry));
const RULE_REF = /^[A-Za-z0-9._[\]-]{1,128}$/u;
const WORD = /^[a-z][a-z-]{0,39}$/u;
const SECTIONS = new Set(['always', 'paths', 'use']);

function problemsOf(value: unknown): RuleProblem[] {
  return (Array.isArray(value) ? value : []).slice(0, 40).map(object).flatMap((entry) => {
    const field = text(entry?.field, 200);
    const message = text(entry?.message, 600);
    return field && message ? [{ field, message }] : [];
  });
}

function choicesOf(value: unknown): FormChoice[] {
  return (Array.isArray(value) ? value : []).slice(0, 30).map(object).flatMap((entry) => {
    const id = text(entry?.id, 40);
    const words = text(entry?.words, 120);
    return id && WORD.test(id) && words ? [{ id, words }] : [];
  });
}

/** One rule from untrusted CLI output, bounded; null when it is not a rule. */
export function ruleRowFrom(value: unknown): RuleRow | null {
  const row = object(value);
  const id = text(row?.id, 128);
  const section = String(row?.section ?? '');
  if (!row || !id || !RULE_REF.test(id) || !SECTIONS.has(section)) return null;
  const fields = object(row.fields);
  const words = (key: string) => strings(fields?.[key], 20, 200).filter((entry) => WORD.test(entry) || entry === 'all');
  return {
    id, section: section as RuleRow['section'], when: text(row.when, 400) ?? '', then: text(row.then, 400) ?? '', because: text(row.because, 600) ?? '',
    words: text(row.words, 800) ?? '', problems: problemsOf(row.problems),
    fields: { kinds: words('kinds'), paths: strings(fields?.paths, 20, 300), steps: words('steps'), personApproves: words('personApproves'),
      workflow: text(fields?.workflow, 128) }
  };
}

/** The rules from untrusted CLI output (`sflow-rules`), or null. */
export function rulesListFrom(value: unknown): RulesList | null {
  const result = object(value);
  if (result?.resultType !== 'sflow-rules' || !Array.isArray(result.rules)) return null;
  const authority = object(result.authority);
  const form = object(result.form);
  const prefix = object(result.idPrefix);
  const guidance = object(result.guidance);
  const inFlight = object(result.inFlight);
  return {
    authority: { kind: text(authority?.kind, 40) ?? 'working-tree', ref: text(authority?.ref, 300), commit: text(authority?.commit, 80),
      remoteFingerprint: text(authority?.remoteFingerprint, 200), sourceCommit: text(authority?.sourceCommit, 80) },
    base: text(object(result.base)?.workflowSha256, 80) ? { workflowSha256: String(object(result.base)?.workflowSha256) } : null,
    builtIn: (Array.isArray(result.builtIn) ? result.builtIn : []).slice(0, 10).map(object).flatMap((entry) => {
      const id = text(entry?.id, 80);
      return id ? [{ id, when: text(entry?.when, 200) ?? '', then: text(entry?.then, 200) ?? '', because: text(entry?.because, 400) ?? '', words: text(entry?.words, 400) ?? '' }] : [];
    }),
    rules: result.rules.slice(0, 200).map(ruleRowFrom).filter((row): row is RuleRow => Boolean(row)),
    waiting: (Array.isArray(result.waiting) ? result.waiting : []).slice(0, 50).map(object).flatMap((entry) => {
      const branch = text(entry?.branch, 300);
      return branch ? [{ branch, proposer: text(entry?.proposer, 120), words: text(entry?.words, 300) ?? 'Waiting for review.', lines: strings(entry?.lines, 20, 600) }] : [];
    }),
    idPrefix: { value: text(prefix?.value, 20) ?? 'TASK', words: text(prefix?.words, 120) ?? 'Tasks are named TASK-<n>.' },
    compose: (Array.isArray(result.compose) ? result.compose : []).slice(0, 12).map(object).flatMap((entry) => (text(entry?.words, 300)
      ? [{ kind: text(entry?.kind, 40) ?? '', words: String(entry?.words) }] : [])),
    workflowsWords: text(object(result.workflows)?.words, 300) ?? 'For work a team must always do one way, use a workflow: Workflow Studio, under Advanced.',
    guidance: guidance && text(guidance.words, 200) ? { count: Math.max(0, Number(guidance.count) || 0), words: String(guidance.words) } : null,
    inFlight: inFlight ? { count: Math.max(0, Number(inFlight.count) || 0), words: text(inFlight.words, 300) } : null,
    problems: problemsOf(result.problems),
    form: { kinds: choicesOf(form?.kinds), steps: choicesOf(form?.steps), approves: choicesOf(form?.approves),
      workflows: (Array.isArray(form?.workflows) ? form.workflows : []).slice(0, 200).map(object).flatMap((entry) => {
        const id = text(entry?.id, 128);
        return id && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(id) ? [{ id, label: text(entry?.label, 200) ?? id }] : [];
      }) },
    lines: strings(result.lines, 20, 300)
  };
}

/** A preview from untrusted CLI output (`sflow-rules-preview`), or null. */
export function rulesPreviewFrom(value: unknown): RulesPreview | null {
  const result = object(value);
  if (result?.resultType !== 'sflow-rules-preview') return null;
  return {
    valid: result.valid === true, problems: problemsOf(result.problems), warnings: problemsOf(result.warnings), summary: strings(result.summary, 20, 600),
    others: text(result.others, 200),
    lines: (Array.isArray(result.lines) ? result.lines : []).slice(0, 60).map(object).flatMap((entry) => (text(entry?.words, 800)
      ? [{ kind: text(entry?.kind, 40) ?? '', touching: text(entry?.touching, 300), words: String(entry?.words), added: strings(entry?.added, 10, 120),
        removed: strings(entry?.removed, 10, 120) }] : []))
  };
}

/** The form's rule from the page's fields, bounded: only what the form offers. */
export function ruleInputFrom(value: unknown, list: RulesList | null): RuleInput | null {
  const raw = object(value);
  if (!raw || !list) return null;
  const known = (entries: unknown, choices: FormChoice[]) => strings(entries, 20, 40).filter((entry) => choices.some((choice) => choice.id === entry));
  const when = String(raw.when ?? 'any');
  const then = String(raw.then ?? 'step');
  const kinds = when === 'any' ? ['all'] : known(raw.kinds, list.form.kinds);
  const paths = when === 'paths' ? String(raw.paths ?? '').split(/\r?\n|,/u).map((entry) => entry.trim()).filter(Boolean).slice(0, 20) : [];
  const workflow = then === 'workflow' && list.form.workflows.some((entry) => entry.id === raw.workflow) ? String(raw.workflow) : null;
  return {
    // "These kinds" with none ticked stays empty, so the preview names the field; files alone are about every kind.
    kinds: kinds.length || when === 'kinds' ? kinds : ['all'], paths,
    steps: then === 'step' ? known([raw.step], list.form.steps) : [],
    personApproves: then === 'approves' ? known([raw.approves], list.form.approves) : [],
    workflow, because: String(raw.because ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400)
  };
}

/** One change set for the reviewed path [FPL:REQ-022]: add, change or remove one rule, or set the prefix. */
export function ruleChangeSet(list: RulesList, change: { op: 'add'; rule: RuleInput } | { op: 'change'; id: string; rule: RuleInput }
  | { op: 'remove'; id: string } | { op: 'prefix'; idPrefix: string }): string {
  const op = change.op === 'add' ? { op: 'tasks.rule.add', rule: change.rule }
    : change.op === 'change' ? { op: 'tasks.rule.change', id: change.id, rule: change.rule }
      : change.op === 'remove' ? { op: 'tasks.rule.remove', id: change.id } : { op: 'tasks.idPrefix.set', idPrefix: change.idPrefix };
  return JSON.stringify({ schema: 'sflow-studio-change-set@1', ...(list.base ? { base: list.base } : {}), changes: [op] });
}

// ---------------------------------------------------------------------------------------------------- the sidebar tab

function ruleLine(rule: { when: string; then: string; because: string }): string {
  return `<span class="rules-when"><span class="rules-word">When</span> ${escape(rule.when)}</span>
    <span class="rules-then"><span class="rules-word">Then</span> ${escape(rule.then)}</span>
    ${rule.because ? `<span class="rules-because">${escape(rule.because)}</span>` : ''}`;
}

/** The Rules tab's panel [FPL:REQ-019]: built in, the team's rules, those waiting for review, the prefix, and Add a rule. */
export function rulesPanelHtml(list: RulesList | null, { reading = false, error = null as string | null } = {}): string {
  if (!list) return `<p class="rules-empty" role="status">${escape(error ?? (reading ? 'Reading the team\'s rules…' : 'Nothing read yet.'))}</p>`;
  const builtIn = list.builtIn.map((rule) => `<li class="rules-item"><div class="rules-row">${ruleLine(rule)}<span class="rules-badge">Built in</span></div></li>`).join('');
  const own = list.rules.length ? `<ul class="rules-list">${list.rules.map((rule) => `<li class="rules-item"><button type="button" class="rules-row rules-open" data-rule="${escape(rule.id)}">${ruleLine(rule)}${rule.problems.length
    ? `<span class="rules-problem">${rule.problems.length === 1 ? 'One problem: open it to fix it' : `${rule.problems.length} problems: open it to fix them`}</span>` : ''}</button></li>`).join('')}</ul>`
    : '<p class="rules-empty">None yet. Add one: it is proposed for review.</p>';
  const waiting = list.waiting.length ? `<h2 class="rules-group">Waiting for review</h2><ul class="rules-list">${list.waiting.map((entry) => `<li class="rules-item"><div class="rules-row">
    ${entry.lines.map((line) => `<span>${escape(line)}</span>`).join('')}<span class="rules-badge">${escape(entry.words)}</span></div></li>`).join('')}</ul>` : '';
  return `<p><button type="button" class="rules-add" data-rules-act="add">Add a rule</button> <button type="button" class="link" data-rules-act="page">Open the rules</button></p>
<h2 class="rules-group">Built in</h2><ul class="rules-list">${builtIn}</ul>
<h2 class="rules-group">Your team's rules</h2>${own}${waiting}
<p class="rules-line">${escape(list.idPrefix.words)}</p>
${list.guidance ? `<p class="rules-line"><button type="button" class="link" data-rules-act="lessons">${escape(list.guidance.words)}</button></p>` : ''}
<p class="rules-line"><button type="button" class="link" data-rules-act="studio">${escape(list.workflowsWords)}</button></p>
${error ? `<p class="rules-line" role="status">${escape(error)}</p>` : ''}${list.lines.map((line) => `<p class="rules-line">${escape(line)}</p>`).join('')}`;
}

export const RULES_STYLE = `
.rules-group { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 12px 0 4px; color: var(--vscode-descriptionForeground); }
.rules-list { list-style: none; margin: 0; padding: 0; }
.rules-item { border-bottom: 1px solid var(--vscode-panel-border); }
.rules-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; background: none; border: 0; border-radius: 3px;
  padding: 6px 4px; color: var(--vscode-foreground); font: inherit; overflow-wrap: anywhere; }
button.rules-row { cursor: pointer; }
button.rules-row:hover { background: var(--vscode-list-hoverBackground); }
.rules-word { font-weight: 600; }
.rules-because, .rules-line, .rules-empty { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0; overflow-wrap: anywhere; }
.rules-badge { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 6px; color: var(--vscode-descriptionForeground); }
.rules-problem { font-size: 12px; color: var(--vscode-editorWarning-foreground); }
.rules-add { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 3px 10px; cursor: pointer; font: inherit; }
.rules-add:hover { background: var(--vscode-button-hoverBackground); }
.rules-row:focus-visible, .rules-add:focus-visible, .link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.link { background: none; border: 0; color: var(--vscode-textLink-foreground); padding: 2px 0; cursor: pointer; font: inherit; text-align: left; }
`;

/** The Rules tab's script, after the places' `vscode` handle and tab keys: each rule, Add a rule and the links as messages. */
export const RULES_SCRIPT = `
(() => {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-rule],[data-rules-act]');
    if (!target) return;
    if (target.dataset.rule) vscode.postMessage({ type: 'places', action: 'rules-open', rule: target.dataset.rule });
    else vscode.postMessage({ type: 'places', action: 'rules-act', act: target.dataset.rulesAct });
  });
})();
`;

// ---------------------------------------------------------------------------------------------------- the page

/** Where a problem's field is on the form: its `aria-describedby` target [FPL:REQ-037]. */
export function formFieldOf(field: string): 'kinds' | 'paths' | 'then' | 'workflow' | 'why' | 'form' {
  if (/\.because$/u.test(field)) return 'why';
  if (/\.(?:steps|personApproves)$/u.test(field)) return 'then';
  if (/\.kinds$/u.test(field)) return 'kinds';
  if (/\.paths$/u.test(field)) return 'paths';
  if (/^tasks\.use\./u.test(field)) return 'workflow';
  return 'form';
}

/** The preview beside the form [FPL:REQ-021], announced politely: each kind that changes, or every problem with its field. */
export function rulesPreviewHtml(preview: RulesPreview | null, { reading = false } = {}): string {
  if (!preview) return `<p class="muted">${reading ? 'Working out what this rule adds…' : 'Fill in When, Then and Why to see what this rule adds to each kind of task.'}</p>`;
  if (!preview.valid) {
    return `<p>This rule cannot be proposed yet:</p><ul id="rules-problems">${preview.problems.map((problem) => `<li data-field="${escape(formFieldOf(problem.field))}">${escape(problem.message)} <span class="muted">(${escape(problem.field)})</span></li>`).join('')}</ul>`;
  }
  const lines = preview.lines.length ? `<ul class="rules-preview-lines">${preview.lines.map((line) => `<li>${escape(line.words)}</li>`).join('')}</ul>` : '';
  const warnings = preview.warnings.length ? `<p class="muted">Already there, and not changed by this:</p><ul>${preview.warnings.map((problem) => `<li class="muted">${escape(problem.message)} (${escape(problem.field)})</li>`).join('')}</ul>` : '';
  return `${lines}${preview.others ? `<p>${escape(preview.others)}</p>` : ''}${warnings}`;
}

function checks(name: string, choices: FormChoice[], chosen: string[], describedBy: string): string {
  return choices.map((choice) => `<label class="rules-check"><input type="checkbox" name="${escape(name)}" value="${escape(choice.id)}"${chosen.includes(choice.id) ? ' checked' : ''} aria-describedby="${escape(describedBy)}"> ${escape(choice.words)}</label>`).join('');
}

function select(id: string, choices: Array<{ id: string; words?: string; label?: string }>, chosen: string | null): string {
  return `<select id="${escape(id)}" aria-describedby="rules-problems">${choices.map((choice) => `<option value="${escape(choice.id)}"${choice.id === chosen ? ' selected' : ''}>${escape(choice.words ?? choice.label ?? choice.id)}</option>`).join('')}</select>`;
}

/**
 * The form [FPL:REQ-020]: When (any code changes, a task is of these kinds, a task touches these files), Then (add a step, a
 * person approves a step, follow a workflow) and Why, which is required. Every field has a label; problems are linked to it.
 */
export function ruleFormHtml(list: RulesList, editing: RuleRow | null = null): string {
  const fields = editing?.fields ?? { kinds: [], paths: [], steps: [], personApproves: [], workflow: null };
  const when = editing ? (editing.section === 'paths' ? 'paths' : fields.kinds.length && !fields.kinds.includes('all') ? 'kinds' : 'any') : 'any';
  const then = fields.workflow ? 'workflow' : fields.personApproves.length && !fields.steps.length ? 'approves' : 'step';
  const radio = (name: string, value: string, label: string, chosen: string) => `<label class="rules-radio"><input type="radio" name="${name}" value="${value}"${value === chosen ? ' checked' : ''}> ${escape(label)}</label>`;
  return `<form id="rules-form" class="rules-form" novalidate data-editing="${escape(editing?.id ?? '')}" aria-describedby="rules-problems">
<h2 id="form-title">${editing ? 'Change the rule' : 'Add a rule'}</h2>
<fieldset><legend>When</legend>
  ${radio('when', 'any', 'any code changes', when)}
  ${radio('when', 'kinds', 'a task is of these kinds', when)}
  ${radio('when', 'paths', 'a task touches these files', when)}
  <div id="rule-kinds" class="rules-kinds" role="group" aria-label="The kinds of task">${checks('kind', list.form.kinds, fields.kinds, 'rules-problems')}</div>
  <label for="rule-paths">Files (one glob a line, like src/auth/**)</label>
  <textarea id="rule-paths" rows="2" aria-describedby="rules-problems">${escape(fields.paths.join('\n'))}</textarea>
</fieldset>
<fieldset id="rule-then"><legend>Then</legend>
  ${radio('then', 'step', 'add a step', then)} <label class="rules-inline" for="rule-step">Step</label>${select('rule-step', list.form.steps, fields.steps[0] ?? null)}
  ${radio('then', 'approves', 'a person approves a step', then)} <label class="rules-inline" for="rule-approves">Step</label>${select('rule-approves', list.form.approves, fields.personApproves[0] ?? 'code')}
  ${radio('then', 'workflow', 'follow a workflow (one kind of task only)', then)} <label class="rules-inline" for="rule-workflow">Workflow</label>${select('rule-workflow', list.form.workflows, fields.workflow)}
</fieldset>
<label for="rule-why">Why (required: it is what a refused "skip the tests" says)</label>
<input id="rule-why" type="text" required value="${escape(editing?.because ?? '')}" aria-describedby="rules-problems">
<div class="choices"><button type="submit" class="primary">${editing ? 'Propose this change' : 'Propose this rule'}</button>${editing ? ' <button type="button" class="secondary" data-act="clear">Add a new rule instead</button>' : ''}</div>
</form>`;
}

/** The one Rules page [FPL:REQ-019 to REQ-026]: the list, the form with its preview, how a task is composed, and the links. */
export function rulesPageHtml(list: RulesList, { editing = null as RuleRow | null, preview = null as RulesPreview | null, result = null as string | null } = {}): string {
  const rule = (row: RuleRow) => `<li class="rules-card"><p><strong>When</strong> ${escape(row.when)}</p><p><strong>Then</strong> ${escape(row.then)}</p>
    <p class="muted">${escape(row.because || 'No reason given')}</p>${row.problems.length ? `<ul class="warning">${row.problems.map((problem) => `<li>${escape(problem.message)} (${escape(problem.field)})</li>`).join('')}</ul>` : ''}
    <div class="choices"><button type="button" class="secondary" data-change="${escape(row.id)}">Change</button> <button type="button" class="secondary" data-remove="${escape(row.id)}">Remove</button>
    ${row.fields.personApproves.length ? ' <button type="button" class="link" data-act="people">Who approves</button>' : ''}</div></li>`;
  const waiting = list.waiting.length ? `<section aria-labelledby="waiting-title"><h2 id="waiting-title">Waiting for review</h2><ul>${list.waiting.map((entry) => `<li><p>${escape(entry.words)}</p>${entry.lines.length ? `<ul>${entry.lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul></section>` : '';
  return `<main class="rules-page">
<h1 id="rules-title" tabindex="-1">The team's rules</h1>
<p class="muted">Rules only add a step or a person's approval. Workflows run as they are.</p>
${list.inFlight?.words ? `<p>${escape(list.inFlight.words)}</p>` : ''}
<div id="rules-result" role="status" aria-live="polite">${result ? escape(result) : ''}</div>
<section aria-labelledby="built-title"><h2 id="built-title">Built in</h2><ul>${list.builtIn.map((entry) => `<li><strong>When</strong> ${escape(entry.when)}: ${escape(entry.then)}. <span class="badge">Built in</span></li>`).join('')}</ul></section>
<section aria-labelledby="own-title"><h2 id="own-title">Your team's rules</h2>${list.rules.length ? `<ul class="rules-cards">${list.rules.map(rule).join('')}</ul>` : '<p class="muted">None yet.</p>'}</section>
${waiting}
<section aria-labelledby="prefix-title"><h2 id="prefix-title">Task names</h2><p>${escape(list.idPrefix.words)} <button type="button" class="secondary" data-act="prefix">Change</button></p></section>
<div class="rules-columns">${ruleFormHtml(list, editing)}
<section class="rules-preview" aria-labelledby="preview-title"><h2 id="preview-title">What this rule adds</h2><div id="rules-preview" aria-live="polite">${rulesPreviewHtml(preview)}</div></section></div>
<section aria-labelledby="compose-title"><h2 id="compose-title">How SFlow composes a task</h2><ul>${list.compose.map((entry) => `<li>${escape(entry.words)}</li>`).join('')}</ul></section>
<section aria-labelledby="more-title"><h2 id="more-title">More</h2><ul class="rules-links">
<li><button type="button" class="link" data-act="studio">${escape(list.workflowsWords)}</button></li>
${list.guidance ? `<li><button type="button" class="link" data-act="lessons">${escape(list.guidance.words)}</button> They are not rules: they add no step.</li>` : ''}
<li><button type="button" class="link" data-act="people">People and approval groups</button></li>
<li><button type="button" class="link" data-act="constitution">The Constitution</button></li></ul></section>
${list.lines.map((line) => `<p class="muted">${escape(line)}</p>`).join('')}
</main>`;
}

export const RULES_PAGE_STYLE = `
.rules-page { max-width: 980px; padding: 12px 16px; overflow-wrap: anywhere; }
.rules-page h1 { font-size: 1.4em; margin: 0 0 6px; }
.rules-page h2 { font-size: 1.05em; margin: 16px 0 4px; }
.rules-page .muted { color: var(--vscode-descriptionForeground); }
.rules-page .warning { color: var(--vscode-editorWarning-foreground); }
.rules-page .badge { font-size: 11px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 0 6px; }
.rules-page .choices { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.rules-page .link { background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; text-align: left; }
.rules-cards { list-style: none; padding: 0; }
.rules-card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; margin: 6px 0; }
.rules-card p { margin: 2px 0; }
.rules-columns { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.rules-form { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.rules-preview { flex: 1 1 280px; min-width: 0; }
.rules-form fieldset { border: 1px solid var(--vscode-panel-border); padding: 6px 10px; display: flex; flex-direction: column; gap: 4px; }
.rules-form input[type="text"], .rules-form textarea, .rules-form select { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 3px 6px; font: inherit; max-width: 100%; }
.rules-form [aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-editorWarning-foreground)); }
.rules-kinds { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.rules-inline { margin-left: 18px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/**
 * The page's script: the form's rule sent for a preview after typing pauses (600 ms) and on Propose; Change, Remove and the
 * links as messages. A preview result fills the polite region and links each problem to its field.
 */
export const RULES_PAGE_SCRIPT = `
const vscode = window.__sfVscode;
document.getElementById('rules-title')?.focus();
const form = document.getElementById('rules-form');
const value = (id) => document.getElementById(id)?.value ?? '';
const rule = () => ({
  when: form.querySelector('input[name="when"]:checked')?.value || 'any',
  kinds: [...form.querySelectorAll('input[name="kind"]:checked')].map((input) => input.value),
  paths: value('rule-paths'),
  then: form.querySelector('input[name="then"]:checked')?.value || 'step',
  step: value('rule-step'), approves: value('rule-approves'), workflow: value('rule-workflow'), because: value('rule-why')
});
let timer = null;
const ask = () => { clearTimeout(timer); timer = setTimeout(() => vscode.postMessage({ type: 'preview', rule: rule(), editing: form.dataset.editing || null }), 600); };
form?.addEventListener('input', ask);
form?.addEventListener('change', ask);
form?.addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(timer);
  vscode.postMessage({ type: 'propose', rule: rule(), editing: form.dataset.editing || null });
});
const FIELDS = { kinds: 'rule-kinds', paths: 'rule-paths', then: 'rule-then', workflow: 'rule-workflow', why: 'rule-why' };
window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'rules-preview') return;
  const region = document.getElementById('rules-preview');
  if (region) region.innerHTML = message.html;
  for (const id of Object.values(FIELDS)) document.getElementById(id)?.removeAttribute('aria-invalid');
  for (const field of message.fields || []) if (FIELDS[field]) document.getElementById(FIELDS[field])?.setAttribute('aria-invalid', 'true');
});
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-change],[data-remove],[data-act]');
  if (!target) return;
  if (target.dataset.change) vscode.postMessage({ type: 'edit', id: target.dataset.change });
  else if (target.dataset.remove) vscode.postMessage({ type: 'remove', id: target.dataset.remove });
  else vscode.postMessage({ type: 'act', act: target.dataset.act });
});
`;

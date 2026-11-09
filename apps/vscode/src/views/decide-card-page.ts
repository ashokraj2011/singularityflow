/**
 * Everything a step waits on, as one table on one page: each thing, its choices, and each answer's own
 * reason, or one answer for all that offer it. Pure, so a test can read every word. The engine's list
 * and record own every rule; a page never preselects a choice or fills in a reason.
 */
import { escape } from './webview.ts';
import type { InboundMessage } from './messages.ts';
import { optionRow, type DecisionArticleAnswer, type DecisionChoice, type DecisionItemPacket, type DecisionOptionPacket, type DecisionPacket } from './decision-list-model.ts';

/** What the person has entered, by the item's title: IDs are renumbered when the list changes. A render never loses it. */
export type DecideDraft = ReadonlyMap<string, { option: string; reason: string; cause: string; expires: string; clause: string; article: DecisionArticleAnswer[] }>;

const decidable = (option: DecisionOptionPacket) => optionRow(option).choosable;
const ownSteps = (item: DecisionItemPacket) => item.options.filter((option) => option.action?.command && !option.action.humanReview && option.decidedBy?.allowed && option.available !== false);
const witnesses = (item: DecisionItemPacket) => item.options.filter((option) => option.action?.humanReview && option.decidedBy?.allowed && option.available !== false);

/** Every open decision: the approval itself is reviewed on its own page, last. */
export const openRows = (packet: DecisionPacket): DecisionItemPacket[] => packet.items.filter((item) => item.kind !== 'approval');
/** What this page shows: the open decisions, then anything offered that nothing waits on. */
export const decideRows = (packet: DecisionPacket): DecisionItemPacket[] => [...openRows(packet), ...(packet.offered ?? [])];

/**
 * The answers one reason may cover: offered by two or more rows this person decides, needing nothing but a
 * reason. A departure's plan row, test or clause-touching wording is decided one by one (`oneByOne`), never
 * here. `others` counts the rows offering the same answer that other approvers decide: Apply to all leaves them.
 */
export function sharedAnswers(packet: DecisionPacket): Array<{ id: string; label: string; rows: number; others: number }> {
  const seen = new Map<string, { id: string; label: string; rows: number; others: number }>();
  for (const item of decideRows(packet)) {
    if (!item.decidedBy?.allowed) continue;
    for (const option of item.options.filter(decidable)) {
      const needs = option.needs ?? {};
      if (option.oneByOne || needs.cause || needs.expires || needs.clause || needs.article) continue;
      const known = seen.get(option.id);
      // One word for every row it covers, as the Copilot CLI says it: a row's own label may name its step ("Code still holds").
      if (known) known.rows += 1; else seen.set(option.id, { id: option.id, label: option.sharedLabel ?? option.label, rows: 1, others: 0 });
    }
  }
  for (const entry of seen.values()) {
    entry.others = decideRows(packet).filter((item) => item.options.some((option) => option.id === entry.id
      && (!item.decidedBy?.allowed || !decidable(option)))).length;
  }
  return [...seen.values()].filter((entry) => entry.rows > 1);
}

function fieldsHtml(item: DecisionItemPacket, entered: DecideDraft extends ReadonlyMap<string, infer V> ? V | undefined : never): string {
  const name = escape(item.title);
  const needed = (flag: 'reason' | 'cause' | 'expires' | 'clause' | 'article') => item.options.filter(decidable).find((option) => option.needs?.[flag])?.needs?.[flag];
  // The rule a choice here needs most: a convergence item may be sent back unexplained, and its other answers may not.
  const reason = item.options.filter(decidable).map((option) => option.needs?.reason as { default: string; minimum: number; maximum: number } | undefined)
    .filter((need) => need !== undefined).sort((left, right) => right.minimum - left.minimum)[0];
  const cause = needed('cause') as { default: string; minimum: number; maximum: number } | undefined;
  const expires = needed('expires') as { latest: string } | undefined;
  const clause = needed('clause') as { known?: string[]; words?: string } | undefined;
  const article = needed('article') as { articles: Array<{ id: string; title: string; question: string }>; decisions: string[] } | undefined;
  return [
    clause ? `<input data-field="clause" aria-label="${escape(clause.words ?? 'The clauses that carry')}${clause.words ? ', for' : ''} ${name}" placeholder="Clauses: ${escape((clause.known ?? []).slice(0, 4).join(', ') || 'their IDs, separated by commas')}" value="${escape(entered?.clause ?? '')}">` : '',
    article ? `<div data-field="article" class="dc-articles">${article.articles.map(({ id, title, question }) => {
      const given = entered?.article?.find((entry) => entry.article === id);
      return `<label class="dc-article"><span title="${escape(question)}">${escape(title)}</span><select data-article="${escape(id)}" aria-label="${escape(question)}"><option value="">Choose…</option>${article.decisions.map((decision) => `<option value="${escape(decision)}"${given?.decision === decision ? ' selected' : ''}>${escape(decision)}</option>`).join('')}</select>
        <input data-article-reason="${escape(id)}" aria-label="Why, for ${escape(title)}" placeholder="Why, if not satisfied" maxlength="500" value="${escape(given?.reason ?? '')}"></label>`;
    }).join('')}</div>` : '',
    // The rule beside the field, before it is refused: a limit met only as an error ended in typed filler on a real Story.
    reason ? `<label class="dc-field"><small class="muted">Reason (${reason.minimum} to ${reason.maximum} characters)</small><input data-field="reason" aria-label="Reason for ${name}" placeholder="${escape(reason.default || 'Your reason')}" minlength="${reason.minimum}" maxlength="${reason.maximum}" value="${escape(entered?.reason ?? '')}"></label>` : '',
    cause ? `<label class="dc-field"><small class="muted">What stops the tests (${cause.minimum} to ${cause.maximum} characters)</small><input data-field="cause" aria-label="What stops the tests, ${name}" placeholder="${escape(cause.default || 'What stops the tests')}" minlength="${cause.minimum}" maxlength="${cause.maximum}" value="${escape(entered?.cause ?? '')}"></label>` : '',
    expires ? `<label class="dc-date">Until, at most ${escape(expires.latest)} <input type="date" data-field="expires" aria-label="Until when, ${name}" max="${escape(expires.latest)}" value="${escape(entered?.expires ?? '')}"></label>` : ''
  ].join('');
}

function rowHtml(item: DecisionItemPacket, draft?: DecideDraft): string {
  const entered = draft?.get(item.title);
  const file = typeof item.details?.path === 'string' ? item.details.path : null;
  // A departure from an earlier document shows the change itself; its file departures open the file.
  const diff = item.kind === 'departure' && typeof item.details?.diff === 'string' ? item.details.diff : null;
  const what = `${file ? `<button type="button" class="dc-link" data-open="${escape(file)}">${escape(file)}</button>` : `<strong>${escape(item.title)}</strong>`}
    <div class="muted dc-why">${escape(item.why)}</div>${diff ? `<details class="dc-diff"><summary>The change</summary><pre>${escape(diff)}</pre></details>` : ''}`;
  if (!item.decidedBy?.allowed) {
    return `<tr data-other="${escape(item.id)}"><td>${what}</td><td colspan="2"><span class="muted">${escape(item.decidedBy?.words ?? '')}</span>${item.decidedBy?.share ? ` Share this with them: <code>${escape(item.decidedBy.share)}</code>` : ''}</td></tr>`;
  }
  const choices = item.options.filter(decidable);
  const select = choices.length ? `<select data-choice aria-label="Decision for ${escape(item.title)}"><option value="">Choose…</option>${choices.map((option) => {
    const needs = Object.keys(option.needs ?? {}).join(' ');
    return `<option value="${escape(option.id)}" data-needs="${escape(needs)}"${option.oneByOne ? ' data-one="1"' : ''}${entered?.option === option.id ? ' selected' : ''}>${escape(option.label)}</option>`;
  }).join('')}</select>` : '';
  const reviews = witnesses(item).map((option) => `<button type="button" class="secondary" data-witness="${escape(option.id)}">${escape(option.label)}</button>`).join('');
  // A label that already ends a sentence (a hold's route often does) gets no second full stop.
  // A drafted amendment is written in the editor before its command runs [SCS:REQ-021]: the page opens the engine's own file.
  const own = ownSteps(item).map((option) => `<div class="dc-own"><span>${escape(option.label.replace(/[.!?]+$/u, ''))}.</span> <span class="muted">This one stays in your terminal.</span>
      ${option.action?.file ? `<span class="muted">${escape(option.words ?? '')}</span><button type="button" data-draft="${escape(option.id)}">Open the draft</button>` : ''}
      <code>${escape(option.action!.command!)}</code>
      <button type="button" class="secondary" data-terminal="${escape(option.id)}">Put it in a terminal</button>
      <button type="button" class="secondary" data-copy="${escape(option.id)}">Copy</button></div>`).join('');
  return `<tr data-item="${escape(item.id)}" data-title="${escape(item.title)}">
    <td>${what}</td><td>${select}${reviews}${own}</td><td class="dc-fields">${choices.length ? fieldsHtml(item, entered) : ''}</td></tr>`;
}

/** Files the evidence names: the page opens these beside it, as it opens a row's file. */
export function evidencePaths(packet: DecisionPacket): string[] {
  const evidence = packet.approvalEvidence;
  return [...new Set([...(evidence?.coverage?.files ?? []).map((file) => file.path), ...(evidence?.proof?.assertionCheck?.tests ?? []).map((entry) => entry.path),
    ...(evidence?.findings?.letThrough ?? []).map((finding) => finding.file)].filter((file): file is string => typeof file === 'string' && file.length > 0))];
}

const fileLink = (file: string) => `<button type="button" class="dc-link" data-open="${escape(file)}">${escape(file)}</button>`;
/** The engine's words for a line, with the file it names as a link to open: the words stay the engine's. */
const linked = (words: string, file: string | null | undefined) => (file && words.includes(file) ? escape(words).replace(escape(file), fileLink(file)) : escape(words));

/**
 * What the step's records say beside its decisions [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]: the
 * changed lines its tests ran, each criterion's tests, the findings the loop let through, the vulnerable new
 * package that holds the approval and the command a person who may accept it runs, the required checks, and what
 * the person asked for with each instruction's account [SCS:REQ-043]. Evidence only: no choice here, and a held
 * package's command is the person's own, typed into their terminal. What was typed is shown as text, never markup.
 */
export function evidenceHtml(packet: DecisionPacket): string {
  const evidence = packet.approvalEvidence;
  if (!evidence) return '';
  const part = (title: string, body: string, warn: boolean) => `<section class="dc-ev${warn ? ' dc-ev-warn' : ''}"><h3>${escape(title)}</h3>${body}</section>`;
  const list = (items: string[]) => (items.length ? `<ul class="dc-ev-list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '');
  const more = (count?: number) => (count ? `<p class="muted">And ${count} more.</p>` : '');
  const { coverage, proof, findings, hold, requiredChecks, askedFor, carried } = evidence;
  // A held package whose command a row above already offers is not offered twice.
  const offered = new Set(decideRows(packet).filter((item) => item.decidedBy?.allowed).flatMap((item) => ownSteps(item).map((option) => option.action?.command)));
  const holdStep = (entry: NonNullable<typeof hold>['entries'][number], index: number) => (!entry.allowed
    ? `<span class="muted">Share this with them: <code>/sf-decide ${escape(packet.workId)}</code></span>`
    : offered.has(entry.command) ? '<span class="muted">Its command is on the hold\'s row above.</span>'
      : `<div class="dc-own"><span>Accept it with your reason and an expiry of at most 90 days.</span> <span class="muted">This one stays in your terminal.</span>
      <code>${escape(entry.command)}</code>
      <button type="button" class="secondary" data-hold-terminal="${index}">Put it in a terminal</button>
      <button type="button" class="secondary" data-hold-copy="${index}">Copy</button></div>`);
  const parts = [
    // Never silent: what counts on a person's word instead of a run, with whose word and for which amendment.
    carried ? part('Carried by "still holds"', `<p class="muted">${escape(carried.words)}</p>${list(carried.entries.map((entry) => escape(entry.words)))}${more(carried.more)}`, true) : '',
    askedFor ? part('Asked for', `<p class="muted">${escape(askedFor.words)}</p>${list(askedFor.instructions.map((entry) => `<q class="dc-asked">${escape(entry.text)}</q>${entry.plainChat ? ' <span class="muted">(plain chat)</span>' : ''}${entry.accountWords
      ? ` <span class="muted">${escape(entry.accountWords)}</span>` : ''}`))}${more(askedFor.more)}`, askedFor.unaccounted > 0) : '',
    coverage ? part('Changed-line coverage', `<p>${escape(coverage.words)}</p>${list((coverage.files ?? []).map((file) => linked(file.words, file.path)))}${more(coverage.more)}`,
      coverage.status !== 'measured' || coverage.below === true) : '',
    proof ? part('Criteria and the tests that prove them', `${list(proof.criteria.map((entry) => escape(entry.words)))}${more(proof.more)}${proof.assertionCheck
      ? `<p>${escape(proof.assertionCheck.words)}</p>${list(proof.assertionCheck.tests.map((entry) => `'${escape(entry.name)}' at ${fileLink(entry.path)}${entry.line ? `:${entry.line}` : ''} asserts nothing`))}` : ''}`,
    proof.criteria.some((entry) => entry.silent > 0 || entry.tests === 0) || proof.assertionCheck?.status === 'incomplete') : '',
    findings ? part('Findings the loop let through', `<p>${escape(findings.words)}</p>${list(findings.letThrough.map((finding) =>
      `<span class="dc-sev">${escape(finding.severity)}</span> ${linked(finding.words.replace(new RegExp(`^${finding.severity} `, 'u'), ''), finding.file)}`))}${more(findings.more)}`,
    findings.letThrough.some((finding) => !finding.accepted)) : '',
    hold ? part('Vulnerable dependency hold', `<p>${escape(hold.words)}</p>${hold.entries.map((entry, index) => `<div class="dc-hold"><strong>${escape(entry.words)}</strong>
      <span class="muted">${escape(entry.who)}</span>${holdStep(entry, index)}</div>`).join('')}${more(hold.more)}`, true) : '',
    requiredChecks ? part('GitHub required checks', `${requiredChecks.words ? `<p>${escape(requiredChecks.words)}</p>` : ''}${list(requiredChecks.checks.map((check) =>
      `${escape(check.name)}: <span class="dc-check dc-check-${escape(check.status)}">${escape(check.status)}</span>`))}`,
    requiredChecks.status !== 'read' || requiredChecks.checks.some((check) => check.status !== 'passed')) : ''
  ].join('');
  return `<section class="dc-evidence" aria-label="Evidence for this approval"><h2>Evidence for this approval</h2>
    <p class="muted">${escape(evidence.words)}</p>${parts}</section>`;
}

export function decideHtml(packet: DecisionPacket, { error = null as string | null, notice = null as string | null, busy = false, draft = undefined as DecideDraft | undefined, route = null as string | null } = {}): string {
  const rows = decideRows(packet);
  const shared = sharedAnswers(packet);
  const yours = rows.some((item) => item.decidedBy?.allowed && item.options.some(decidable));
  return `<main class="dc" data-digest="${escape(packet.packetSha256)}">
    <header><h1>Decide · ${escape(packet.workId)} · ${escape(packet.phaseLabel)}</h1>
      <p class="muted">${escape(packet.headline)} Nothing is recorded until you review the list and confirm it.</p></header>
    ${error ? `<p class="dc-error" role="alert">${escape(error)}</p>` : ''}
    ${notice ? `<p class="dc-notice" role="status">${escape(notice)}</p>` : ''}
    ${route ? `<div class="dc-own"><code>${escape(route)}</code><button type="button" data-route>Put it in a terminal</button></div>` : ''}
    ${shared.length ? `<section class="dc-all"><label for="dc-all-choice">One answer for all that offer it</label>
      <select id="dc-all-choice"><option value="">Choose…</option>${shared.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.label)} (${entry.rows} rows)</option>`).join('')}</select>
      <input id="dc-all-reason" aria-label="One reason for all of them" placeholder="One reason" maxlength="1000"><button type="button" data-apply-all>Apply to all</button>
      ${shared.filter((entry) => entry.others).map((entry) => `<p class="muted">"${escape(entry.label)}" covers only the rows you decide; ${entry.others === 1 ? '1 more stays' : `${entry.others} more stay`} listed for their own approvers.</p>`).join('')}</section>` : ''}
    <div class="dc-table"><table>
      <thead><tr><th>What it is</th><th>Your decision</th><th>Your reason</th></tr></thead>
      <tbody>${rows.map((item) => rowHtml(item, draft)).join('')}</tbody>
    </table></div>
    ${evidenceHtml(packet)}
    <footer><button type="button" class="secondary" data-cancel>Not now</button>
      <button type="button" data-review${yours && !busy ? '' : ' disabled'}>Review and record</button></footer>
  </main>`;
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const pageRows = (message: InboundMessage) => (Array.isArray(message.rows) ? message.rows as Array<Record<string, unknown>> : []);

export function decideDraftFrom(message: InboundMessage): DecideDraft {
  return new Map(pageRows(message).filter((row) => typeof row?.title === 'string')
    .map((row) => [row.title as string, { option: text(row.option), reason: text(row.reason), cause: text(row.cause), expires: text(row.expires), clause: text(row.clause),
      article: (Array.isArray(row.article) ? row.article as DecisionArticleAnswer[] : []) }]));
}

/** The rows the person answered, as the list's choices, or what is wrong: a reason with no decision is never taken for one. */
export function decideChoicesFrom(packet: DecisionPacket, message: InboundMessage): { choices: unknown[]; problem: string | null } {
  const choices: unknown[] = [];
  for (const row of pageRows(message)) {
    const item = decideRows(packet).find((entry) => entry.id === row?.item);
    if (!item) return { choices: [], problem: 'The page named an item that is not on this list. Nothing was recorded.' };
    if (!text(row.option)) {
      if (text(row.reason).trim()) return { choices: [], problem: `Choose a decision for "${item.title}", or clear its reason.` };
      continue;
    }
    const option = item.options.find((entry) => entry.id === row.option);
    choices.push({ item: item.id, option: row.option, ...(option?.needs?.reason ? { reason: text(row.reason) } : {}),
      ...(option?.needs?.cause ? { cause: text(row.cause) } : {}), ...(option?.needs?.expires ? { expires: text(row.expires) } : {}),
      ...(option?.needs?.clause ? { clause: text(row.clause) } : {}), ...(option?.needs?.article ? { article: row.article } : {}) });
  }
  return choices.length ? { choices, problem: null } : { choices, problem: 'Choose a decision for at least one row.' };
}

/** The exact words a person confirms: one line per answer with its own reason, and what stays undecided. */
export function decideSummary(packet: DecisionPacket, choices: readonly DecisionChoice[]): string {
  const rows = decideRows(packet);
  const lines = choices.map((choice) => {
    const item = rows.find((entry) => entry.id === choice.item);
    const option = item?.options.find((entry) => entry.id === choice.option);
    const articles = choice.article?.map((entry) => `${entry.article}: ${entry.decision}${entry.reason ? ` (${entry.reason})` : ''}`).join('; ');
    return `${item?.title ?? choice.item}: ${option?.label ?? choice.option}.${choice.clause ? ` ${option?.needs?.clause?.label ? `${option.needs.clause.label}:` : 'Carried by'} ${choice.clause}.` : ''}${articles ? ` ${articles}.` : ''}${choice.expires ? ` Until ${choice.expires}.` : ''}${choice.cause ? ` What stops the tests: ${choice.cause.replace(/\.+$/u, '')}.` : ''}${choice.reason ? ` Reason: ${choice.reason}` : ''}`;
  });
  const left = openRows(packet).filter((item) => item.decidedBy?.allowed && !choices.some((choice) => choice.item === item.id));
  return [...lines, ...(left.length ? ['', `Still undecided: ${left.map((item) => item.title).join('; ')}`] : [])].join('\n');
}

/** Whether every chosen answer only drafts an amendment: a file written, never a record or a decision [SCS:REQ-020]. */
export function draftsOnly(packet: DecisionPacket, choices: readonly DecisionChoice[]): boolean {
  return choices.length > 0 && choices.every((choice) => {
    const effects = decideRows(packet).find((entry) => entry.id === choice.item)?.options.find((entry) => entry.id === choice.option)?.effects ?? [];
    return effects.length > 0 && effects.every((effect) => effect.kind === 'intent-amendment-draft');
  });
}

/** The engine's own draft file a row's step names, from the list as read; null when none does. */
export function draftFileOf(packet: DecisionPacket, itemId: string | null = null): string | null {
  const file = decideRows(packet).filter((item) => !itemId || item.id === itemId).flatMap((item) => item.options).map((option) => option.action?.file).find((entry) => typeof entry === 'string' && entry);
  return file ?? null;
}

/** With SF Guard the signature is taken in the person's own terminal: the one command with nothing to fill in, which asks the same questions there. */
export const guardRoute = (workId: string) => `singularity-flow decisions record ${workId}`;
export const GUARD_WORDS = 'This Story signs each decision with SF Guard, and Touch ID is taken in your own terminal, so nothing was written here. Put this in a terminal and press Enter; it asks the same questions and shows the card to sign.';

export const DECIDE_STYLE = `
.dc { display:grid; gap:1rem; padding:1rem 0; max-width:80rem; }
.dc h1 { margin:0 0 .25rem; }
.dc-all { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.dc input, .dc select { padding:.35rem .5rem; box-sizing:border-box; max-width:100%; }
.dc-all input { flex:1 1 18rem; min-width:0; }
.dc-table { overflow-x:auto; }
.dc table { width:100%; border-collapse:collapse; }
.dc th, .dc td { text-align:left; vertical-align:top; padding:.5rem; border-bottom:var(--sf-border); }
.dc td select { width:100%; min-width:12rem; }
.dc-fields input { display:block; width:100%; min-width:12rem; box-sizing:border-box; margin-bottom:.35rem; }
.dc-fields [hidden], .dc-date[hidden], .dc-field[hidden] { display:none; }
.dc-field { display:block; }
.dc-field small { display:block; margin-bottom:.15rem; }
.dc-date { display:block; }
.dc-articles { display:grid; gap:.35rem; margin-bottom:.35rem; }
.dc-articles[hidden] { display:none; }
.dc-article { display:grid; grid-template-columns:minmax(8rem,1fr) minmax(8rem,1fr); gap:.25rem .5rem; align-items:center; }
.dc-article input { grid-column:1 / -1; margin:0; }
.dc-article input[hidden] { display:none; }
.dc-why { font-size:.9em; margin-top:.25rem; overflow-wrap:anywhere; }
.dc-diff pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:16rem; overflow:auto; font-size:.85em; }
.dc-own { display:grid; gap:.3rem; margin-top:.35rem; justify-items:start; }
.dc-own code { overflow-wrap:anywhere; white-space:pre-wrap; }
.dc-link { all:unset; cursor:pointer; color:var(--vscode-textLink-foreground); overflow-wrap:anywhere; font-weight:600; }
.dc-link:hover, .dc-link:focus-visible { text-decoration:underline; }
.dc footer { display:flex; gap:.5rem; justify-content:flex-end; position:sticky; bottom:0; padding:.5rem 0; background:var(--vscode-editor-background); }
.dc-evidence { display:grid; gap:.75rem; min-width:0; }
.dc-evidence h2 { margin:0; font-size:1.1em; }
.dc-evidence > p { margin:0; }
.dc-ev { border-left:3px solid var(--sf-border-color, var(--vscode-panel-border)); padding:.1rem 0 .1rem .75rem; min-width:0; }
.dc-ev-warn { border-left-color:var(--sf-wait, var(--vscode-editorWarning-foreground)); }
.dc-ev h3 { margin:0 0 .25rem; font-size:1em; }
.dc-ev p { margin:.2rem 0; overflow-wrap:anywhere; }
.dc-ev-list { margin:.25rem 0; padding-left:1.25rem; }
.dc-ev-list li { margin:.15rem 0; overflow-wrap:anywhere; }
.dc-sev { display:inline-block; padding:0 .35rem; border-radius:3px; font-size:.85em; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
.dc-hold { display:grid; gap:.3rem; margin:.4rem 0; justify-items:start; min-width:0; }
.dc-hold strong { overflow-wrap:anywhere; }
.dc-check { font-weight:600; }
.dc-asked { font-style:italic; overflow-wrap:anywhere; }
.dc-check-passed { color:var(--sf-ok, var(--vscode-testing-iconPassed)); }
.dc-check-failed { color:var(--sf-bad, var(--vscode-errorForeground)); }
.dc-error { color:var(--vscode-errorForeground); margin:0; }
.dc-notice { margin:0; }
`;

export const DECIDE_SCRIPT = `
const vscode = window.__sfVscode;
const rows = () => [...document.querySelectorAll('tr[data-item]')];
const field = (row, name) => row.querySelector('[data-field="' + name + '"]');
const sync = (row) => {
  const choice = row.querySelector('[data-choice]');
  if (!choice) return;
  const needs = (choice.selectedOptions[0]?.dataset.needs ?? '').split(' ');
  for (const name of ['reason', 'cause', 'expires', 'clause', 'article']) {
    const input = field(row, name);
    if (!input) continue;
    (input.closest('.dc-date, .dc-field') ?? input).hidden = !needs.includes(name);
  }
  for (const pick of row.querySelectorAll('[data-article]')) {
    const why = row.querySelector('[data-article-reason="' + pick.dataset.article + '"]');
    if (why) why.hidden = !pick.value || pick.value === 'satisfied';
  }
};
const value = (row, name) => field(row, name)?.value ?? '';
const answers = () => rows().map((row) => ({ item: row.dataset.item, title: row.dataset.title, option: row.querySelector('[data-choice]')?.value ?? '',
  reason: value(row, 'reason'), cause: value(row, 'cause'), expires: value(row, 'expires'), clause: value(row, 'clause'),
  article: [...row.querySelectorAll('[data-article]')].map((pick) => ({ article: pick.dataset.article, decision: pick.value,
    reason: row.querySelector('[data-article-reason="' + pick.dataset.article + '"]')?.value ?? '' })) }));
rows().forEach(sync);
document.addEventListener('change', (event) => { const row = event.target.closest('tr[data-item]'); if (row) sync(row); });
document.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  if (open) return vscode.postMessage({ type: 'decide.open', path: open.dataset.open });
  // A held package's own command, by its place in the evidence: the extension reads the command from the list itself.
  const held = event.target.closest('[data-hold-terminal],[data-hold-copy]');
  if (held) return vscode.postMessage({ type: held.dataset.holdTerminal !== undefined ? 'decide.terminal' : 'decide.copy', hold: held.dataset.holdTerminal ?? held.dataset.holdCopy });
  const drafted = event.target.closest('[data-draft]');
  if (drafted) return vscode.postMessage({ type: 'decide.draft', item: drafted.closest('tr[data-item]').dataset.item, option: drafted.dataset.draft });
  const step = event.target.closest('[data-terminal],[data-copy],[data-witness]');
  if (step) {
    const row = step.closest('tr[data-item]');
    const type = step.dataset.terminal ? 'decide.terminal' : step.dataset.copy ? 'decide.copy' : 'decide.witness';
    return vscode.postMessage({ type, item: row.dataset.item, option: step.dataset.terminal ?? step.dataset.copy ?? step.dataset.witness, rows: answers() });
  }
  if (event.target.closest('[data-route]')) return vscode.postMessage({ type: 'decide.route' });
  if (event.target.closest('[data-cancel]')) return vscode.postMessage({ type: 'decide.cancel' });
  if (event.target.closest('[data-apply-all]')) {
    const chosen = document.getElementById('dc-all-choice');
    const reason = document.getElementById('dc-all-reason');
    if (!chosen.value) return chosen.focus();
    if (!reason.value.trim()) return reason.focus();
    for (const row of rows()) {
      const choice = row.querySelector('[data-choice]');
      // A row decided one by one keeps its own answer and reason.
      if (!choice || ![...choice.options].some((entry) => entry.value === chosen.value && !entry.dataset.one)) continue;
      choice.value = chosen.value;
      if (field(row, 'reason')) field(row, 'reason').value = reason.value.trim();
      sync(row);
    }
    return;
  }
  if (event.target.closest('[data-review]')) vscode.postMessage({ type: 'decide.review', rows: answers() });
});
`;

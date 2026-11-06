/**
 * The convergence decisions on one page: every changed thing, what the plan already says about it, and
 * one reason for all of them or a different answer for each. Pure, so a test can read every word.
 */
import { escape } from './webview.ts';
import type { InboundMessage } from './messages.ts';

export interface AdjudicationItem {
  id: string; kind: string; paths: string[]; clauseIds: string[]; detail: string | null; acceptAll: boolean;
  plan: PlanEntry | null;
  decision: AdjudicationDecision | null;
  /** Files that are one change: one row here, one record each. */
  group?: string;
}
export interface PlanEntry { kind: string; id?: string; clause?: string | null; class?: string | null; text?: string | null; askedBecause?: string }
export interface ReplacedAnswer { disposition: string; reason: string | null; actor: string; at: string }
export interface AdjudicationDecision { disposition: string; reason: string | null; clauseIds: string[]; actor: string | null; at: string | null; replaced?: ReplacedAnswer[] }
/** A changed file the approved plan already accounts for: no question, and still on the page. */
export interface SettledItem { id: string; paths: string[]; clauseIds: string[]; settledBy: PlanEntry; decision: AdjudicationDecision | null }
export interface AdjudicationList {
  status: string; workId: string; phase: string | null; repositoryPath: string; items: AdjudicationItem[]; settled?: SettledItem[]; open: number; message?: string;
  groupWords?: Record<string, string>;
  decidedBy?: { groups: string[]; labels: string[]; allowed: boolean; words: string };
  dispositions?: Array<{ id: string; label: string }>; digest?: string;
}
export interface AdjudicationAnswer { itemId: string; disposition: string; reason: string; clauseIds: string[] }
/** What the person has entered so far. A render must never lose it: not after a refusal, a cancelled review or a re-read. */
export type AdjudicationDraft = ReadonlyMap<string, { disposition: string; reason: string; clauses: string }>;

export function adjudicationListFrom(value: unknown): AdjudicationList | null {
  const list = value as AdjudicationList | null;
  return list && typeof list === 'object' && (list as { resultType?: unknown } & AdjudicationList).status && Array.isArray(list.items) ? list : null;
}

function planWords(plan: AdjudicationItem['plan']): string {
  if (!plan) return 'Not in the plan';
  const source = plan.kind === 'amendment' ? `${plan.id ?? 'Amendment'}${plan.clause ? ` under ${plan.clause}` : ''}` : 'Supporting file';
  return `${source}${plan.text ? `: ${plan.text}` : ''}${plan.askedBecause ? ` · Still asked: ${plan.askedBecause}.` : ''}`;
}

const itemName = (item: AdjudicationItem | SettledItem) => item.paths.join(', ') || item.clauseIds.join(', ') || ('detail' in item ? item.detail : null) || item.id;

/** A person may change an answer; the one it replaced stays in sight, with whose it was. */
function changedHtml(decision: AdjudicationDecision | null, list: AdjudicationList): string {
  const label = (id: string) => (list.dispositions ?? []).find((entry) => entry.id === id)?.label ?? id;
  return (decision?.replaced ?? []).map((answer) => `<div class="muted adj-id adj-changed">Changed from ${escape(label(answer.disposition))} by ${escape(answer.actor)} on ${escape(answer.at.slice(0, 10))}${answer.reason ? `: ${escape(answer.reason)}` : ''}</div>`).join('');
}

/** The table's rows: a group's items read as one, at the place of its first. */
function tableRows(list: AdjudicationList): Array<AdjudicationItem & { ids?: string[] }> {
  const seen = new Set<string>();
  return list.items.flatMap((item) => {
    if (!item.group) return [item];
    if (seen.has(item.group)) return [];
    seen.add(item.group);
    const members = list.items.filter((entry) => entry.group === item.group);
    return [{ ...item, ids: members.map((entry) => entry.id), paths: members.flatMap((entry) => entry.paths) }];
  });
}

function rowHtml(item: AdjudicationItem & { ids?: string[] }, list: AdjudicationList, draft?: AdjudicationDraft): string {
  const entered = draft?.get(item.id);
  const chosen = entered?.disposition ?? item.decision?.disposition ?? '';
  const options = (list.dispositions ?? []).map(({ id, label }) => `<option value="${escape(id)}"${id === chosen ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const files = item.paths.length
    ? item.paths.map((file) => `<button type="button" class="adj-link" data-open="${escape(file)}">${escape(file)}</button>`).join(' ')
    : `<span>${escape(item.detail ?? item.kind)}</span>`;
  const group = item.group ? list.groupWords?.[item.group] : null;
  return `<tr data-item="${escape(item.id)}" data-accept-all="${item.acceptAll}"${item.ids ? ` data-group-items="${escape(item.ids.join(','))}"` : ''}>
    <td>${item.ids ? '<strong class="adj-group">Test setup</strong> ' : ''}${files}${group ? `<div class="muted adj-group-words">${escape(group)}</div>` : ''}<div class="muted adj-id">${escape((item.ids ?? [item.id]).join(', '))}${item.decision?.actor ? ` · decided by ${escape(item.decision.actor)}` : ''}</div>${changedHtml(item.decision, list)}</td>
    <td>${escape(planWords(item.plan))}</td>
    <td><select data-disposition aria-label="Decision for ${escape(itemName(item))}"><option value="">Choose…</option>${options}</select>
      <input data-clauses class="adj-clauses" hidden aria-label="Clauses for ${escape(itemName(item))}" placeholder="Clause IDs, separated by commas" value="${escape(entered?.clauses ?? item.decision?.clauseIds.join(', ') ?? item.clauseIds.join(', '))}"></td>
    <td><input data-reason aria-label="Reason for ${escape(itemName(item))}" value="${escape(entered?.reason ?? item.decision?.reason ?? '')}" maxlength="1000"></td>
  </tr>`;
}

/** Not a question, and a person may still disagree: the same answer as any row, through the same write. */
function settledRowHtml(item: SettledItem, list: AdjudicationList, draft?: AdjudicationDraft): string {
  const entered = draft?.get(item.id);
  const chosen = entered?.disposition ?? item.decision?.disposition ?? '';
  const name = item.paths.join(', ') || item.id;
  const control = list.decidedBy?.allowed === true ? `<select data-disposition aria-label="Overrule the plan on ${escape(name)}"><option value="">Keep what the plan says</option>${(list.dispositions ?? [])
    .map(({ id, label }) => `<option value="${escape(id)}"${id === chosen ? ' selected' : ''}>${escape(label)}</option>`).join('')}</select>
      <input data-clauses class="adj-clauses" hidden aria-label="Clauses for ${escape(name)}" placeholder="Clause IDs, separated by commas" value="${escape(entered?.clauses ?? item.decision?.clauseIds.join(', ') ?? '')}">`
    : escape(item.decision ? (list.dispositions ?? []).find((entry) => entry.id === item.decision!.disposition)?.label ?? item.decision.disposition : 'No question');
  return `<tr data-item="${escape(item.id)}" data-settled="${escape(item.id)}" data-accept-all="false">
    <td>${item.paths.map((file) => `<button type="button" class="adj-link" data-open="${escape(file)}">${escape(file)}</button>`).join(' ')}<div class="muted adj-id">${escape(item.id)}</div></td>
    <td>${escape(planWords(item.settledBy))}</td>
    <td>${control}</td>
    <td>${list.decidedBy?.allowed === true ? `<input data-reason aria-label="Reason for overruling the plan on ${escape(name)}" value="${escape(entered?.reason ?? item.decision?.reason ?? '')}" maxlength="1000">` : ''}</td></tr>`;
}

function settledHtml(list: AdjudicationList, draft?: AdjudicationDraft): string {
  const settled = list.settled ?? [];
  if (!settled.length) return '';
  return `<section class="adj-settled"><h2>Settled by the plan</h2>
    <p class="muted">The approved plan already accounts for ${settled.length === 1 ? 'this changed file' : `these ${settled.length} changed files`}, so nobody is asked again. If you disagree, choose what it should be instead, with your reason.</p>
    <div class="adj-table"><table>
      <thead><tr><th>What changed</th><th>What settled it</th><th>Decision</th><th>Reason</th></tr></thead>
      <tbody>${settled.map((item) => settledRowHtml(item, list, draft)).join('')}</tbody>
    </table></div></section>`;
}

export function adjudicationHtml(list: AdjudicationList, { error = null as string | null, busy = false, draft = undefined as AdjudicationDraft | undefined } = {}): string {
  if (list.status !== 'open') return `<main class="adj"><h1>Decide · ${escape(list.workId)}</h1><p>${escape(list.message ?? 'There is nothing to decide here.')}</p></main>`;
  const allowed = list.decidedBy?.allowed === true;
  const acceptable = list.items.filter((item) => item.acceptAll).length;
  return `<main class="adj">
    <header><h1>Decide · ${escape(list.workId)} · ${escape(list.phase ?? 'Convergence')}</h1>
      <p class="muted">${list.items.length ? `${escape(list.decidedBy?.words ?? '')} ${list.open} of ${list.items.length} still need a decision.` : 'Nothing here needs a decision.'}</p></header>
    ${error ? `<p class="adj-error" role="alert">${escape(error)}</p>` : ''}
    ${allowed && acceptable ? `<section class="adj-all"><label for="adj-all-reason">Accept all ${acceptable} changed file${acceptable === 1 ? '' : 's'} with one reason</label>
      <input id="adj-all-reason" maxlength="1000"><button type="button" data-accept-all>Accept all</button></section>` : ''}
    ${list.items.length ? `<div class="adj-table"><table>
      <thead><tr><th>What changed</th><th>What the plan already says</th><th>Your decision</th><th>Reason</th></tr></thead>
      <tbody>${tableRows(list).map((item) => rowHtml(item, list, draft)).join('')}</tbody>
    </table></div>` : ''}
    ${settledHtml(list, draft)}
    <footer>${list.items.length || (allowed && list.settled?.length) ? `<button type="button" class="secondary" data-cancel>Not now</button>
      <button type="button" data-review${allowed && !busy ? '' : ' disabled'}>Review and record</button>` : '<button type="button" class="secondary" data-cancel>Close</button>'}</footer>
  </main>`;
}

export function adjudicationDraftFrom(message: InboundMessage): AdjudicationDraft {
  const rows = Array.isArray(message.rows) ? message.rows as Array<Record<string, unknown>> : [];
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  return new Map(rows.filter((row) => typeof row?.id === 'string')
    .map((row) => [row.id as string, { disposition: text(row.disposition), reason: text(row.reason), clauses: text(row.clauses) }]));
}

/** What the page sent, checked against the list it was read from. Only rows the person chose are answers. */
export function adjudicationAnswersFrom(list: AdjudicationList, message: InboundMessage): { answers: AdjudicationAnswer[]; problem: string | null } {
  const rows = Array.isArray(message.rows) ? message.rows as Array<Record<string, unknown>> : [];
  const known = new Map<string, AdjudicationItem | SettledItem>([...list.items, ...(list.settled ?? [])].map((item) => [item.id, item]));
  const dispositions = new Set((list.dispositions ?? []).map((entry) => entry.id));
  const answers: AdjudicationAnswer[] = [];
  for (const row of rows) {
    const item = typeof row?.id === 'string' ? known.get(row.id) : undefined;
    const disposition = typeof row?.disposition === 'string' ? row.disposition : '';
    if (!item) return { answers: [], problem: 'The page named an item that is not on this list. Nothing was recorded.' };
    if (!disposition) {
      if (typeof row.reason === 'string' && row.reason.trim()) return { answers: [], problem: `Choose a decision for ${itemName(item)}, or clear its reason.` };
      continue;
    }
    if (!dispositions.has(disposition)) return { answers: [], problem: `That is not a decision SFlow knows for ${itemName(item)}.` };
    const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
    const clauseIds = typeof row.clauses === 'string' ? row.clauses.split(/[\s,]+/u).filter(Boolean) : [];
    if (!reason && disposition !== 'rework') return { answers: [], problem: `Give a reason for ${itemName(item)}.` };
    if (disposition === 'update-intent' && !clauseIds.length) return { answers: [], problem: `Name the clauses that should change for ${itemName(item)}.` };
    // One row of a group answers for each of its files, and only for files of that same group on this list.
    const ids = typeof row.ids === 'string' && row.ids ? row.ids.split(',') : [item.id];
    const groupOf = (entry?: AdjudicationItem | SettledItem) => (entry && 'group' in entry ? entry.group : undefined);
    if (ids.some((id) => id !== item.id && (!known.has(id) || !groupOf(item) || groupOf(known.get(id)) !== groupOf(item)))) return { answers: [], problem: 'The page named an item that is not on this list. Nothing was recorded.' };
    for (const id of ids) answers.push({ itemId: id, disposition, reason, clauseIds: disposition === 'update-intent' ? clauseIds : [] });
  }
  return answers.length ? { answers, problem: null } : { answers, problem: 'Choose a decision for at least one row.' };
}

/** The exact words a person confirms: one line per answer, and what stays undecided. */
export function adjudicationSummary(list: AdjudicationList, answers: readonly AdjudicationAnswer[]): string {
  const labels = new Map((list.dispositions ?? []).map((entry) => [entry.id, entry.label]));
  const named = new Map([...list.items, ...(list.settled ?? [])].map((item) => [item.id, itemName(item)]));
  const left = list.items.filter((item) => !item.decision && !answers.some((answer) => answer.itemId === item.id));
  return [...answers.map((answer) => `${named.get(answer.itemId)}: ${labels.get(answer.disposition) ?? answer.disposition}${answer.clauseIds.length ? ` (${answer.clauseIds.join(', ')})` : ''}${answer.reason ? `. Reason: ${answer.reason}` : ''}`),
    ...(left.length ? ['', `Still undecided: ${left.map(itemName).join(', ')}`] : [])].join('\n');
}

export const ADJUDICATION_STYLE = `
.adj { display:grid; gap:1rem; padding:1rem 0; max-width:72rem; }
.adj h1 { margin:0 0 .25rem; }
.adj h2 { margin:0 0 .25rem; font-size:1.1em; }
.adj-all { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.adj input { padding:.35rem .5rem; box-sizing:border-box; }
.adj-all input { flex:1 1 18rem; min-width:0; }
.adj-table { overflow-x:auto; }
.adj table { width:100%; border-collapse:collapse; }
.adj th, .adj td { text-align:left; vertical-align:top; padding:.5rem; border-bottom:var(--sf-border); }
.adj td input[data-reason] { width:100%; min-width:12rem; box-sizing:border-box; }
.adj-clauses { display:block; margin-top:.35rem; width:100%; box-sizing:border-box; }
.adj-clauses[hidden] { display:none; }
.adj-id { font-size:.85em; }
.adj-group { display:block; margin-bottom:.2rem; }
.adj-group-words { margin-top:.25rem; }
.adj-link { all:unset; cursor:pointer; color:var(--vscode-textLink-foreground); overflow-wrap:anywhere; }
.adj-link:hover, .adj-link:focus-visible { text-decoration:underline; }
.adj footer { display:flex; gap:.5rem; justify-content:flex-end; }
.adj-error { color:var(--vscode-errorForeground); margin:0; }
`;

export const ADJUDICATION_SCRIPT = `
const vscode = window.__sfVscode;
const rows = () => [...document.querySelectorAll('tr[data-item]')];
const sync = (row) => { const clauses = row.querySelector('[data-clauses]'); clauses.hidden = row.querySelector('[data-disposition]').value !== 'update-intent'; };
rows().forEach(sync);
document.addEventListener('change', (event) => { const row = event.target.closest('tr[data-item]'); if (row) sync(row); });
document.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  if (open) return vscode.postMessage({ type: 'adjudicate.open', path: open.dataset.open });
  if (event.target.closest('[data-cancel]')) return vscode.postMessage({ type: 'adjudicate.cancel' });
  if (event.target.closest('[data-accept-all]')) {
    const reason = document.getElementById('adj-all-reason');
    if (!reason.value.trim()) return reason.focus();
    for (const row of rows()) {
      if (row.dataset.acceptAll !== 'true') continue;
      row.querySelector('[data-disposition]').value = 'accepted-deviation';
      row.querySelector('[data-reason]').value = reason.value.trim();
      sync(row);
    }
    return;
  }
  if (event.target.closest('[data-review]')) {
    vscode.postMessage({ type: 'adjudicate.review', rows: rows().map((row) => ({ id: row.dataset.item, ids: row.dataset.groupItems || '',
      disposition: row.querySelector('[data-disposition]').value, reason: row.querySelector('[data-reason]').value,
      clauses: row.querySelector('[data-clauses]').value })) });
  }
});
`;

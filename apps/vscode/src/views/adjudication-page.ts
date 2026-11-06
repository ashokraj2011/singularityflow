/**
 * The convergence decisions on one page: every changed thing, what the plan already says about it, and
 * one reason for all of them or a different answer for each. Pure, so a test can read every word.
 */
import { escape } from './webview.ts';
import type { InboundMessage } from './messages.ts';

export interface AdjudicationItem {
  id: string; kind: string; paths: string[]; clauseIds: string[]; detail: string | null; acceptAll: boolean;
  plan: { kind: string; id?: string; clause?: string | null; class?: string | null; text?: string | null } | null;
  decision: { disposition: string; reason: string | null; clauseIds: string[]; actor: string | null; at: string | null } | null;
}
export interface AdjudicationList {
  status: string; workId: string; phase: string | null; repositoryPath: string; items: AdjudicationItem[]; open: number; message?: string;
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
  return `${source}${plan.text ? `: ${plan.text}` : ''}`;
}

const itemName = (item: AdjudicationItem) => item.paths.join(', ') || item.clauseIds.join(', ') || item.detail || item.id;

function rowHtml(item: AdjudicationItem, list: AdjudicationList, draft?: AdjudicationDraft): string {
  const entered = draft?.get(item.id);
  const chosen = entered?.disposition ?? item.decision?.disposition ?? '';
  const options = (list.dispositions ?? []).map(({ id, label }) => `<option value="${escape(id)}"${id === chosen ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const files = item.paths.length
    ? item.paths.map((file) => `<button type="button" class="adj-link" data-open="${escape(file)}">${escape(file)}</button>`).join(' ')
    : `<span>${escape(item.detail ?? item.kind)}</span>`;
  return `<tr data-item="${escape(item.id)}" data-accept-all="${item.acceptAll}">
    <td>${files}<div class="muted adj-id">${escape(item.id)}${item.decision?.actor ? ` · decided by ${escape(item.decision.actor)}` : ''}</div></td>
    <td>${escape(planWords(item.plan))}</td>
    <td><select data-disposition aria-label="Decision for ${escape(itemName(item))}"><option value="">Choose…</option>${options}</select>
      <input data-clauses class="adj-clauses" hidden aria-label="Clauses for ${escape(itemName(item))}" placeholder="Clause IDs, separated by commas" value="${escape(entered?.clauses ?? item.decision?.clauseIds.join(', ') ?? item.clauseIds.join(', '))}"></td>
    <td><input data-reason aria-label="Reason for ${escape(itemName(item))}" value="${escape(entered?.reason ?? item.decision?.reason ?? '')}" maxlength="1000"></td>
  </tr>`;
}

export function adjudicationHtml(list: AdjudicationList, { error = null as string | null, busy = false, draft = undefined as AdjudicationDraft | undefined } = {}): string {
  if (list.status !== 'open') return `<main class="adj"><h1>Decide · ${escape(list.workId)}</h1><p>${escape(list.message ?? 'There is nothing to decide here.')}</p></main>`;
  const allowed = list.decidedBy?.allowed === true;
  const acceptable = list.items.filter((item) => item.acceptAll).length;
  return `<main class="adj">
    <header><h1>Decide · ${escape(list.workId)} · ${escape(list.phase ?? 'Convergence')}</h1>
      <p class="muted">${escape(list.decidedBy?.words ?? '')} ${list.open} of ${list.items.length} still need a decision.</p></header>
    ${error ? `<p class="adj-error" role="alert">${escape(error)}</p>` : ''}
    ${allowed && acceptable ? `<section class="adj-all"><label for="adj-all-reason">Accept all ${acceptable} changed file${acceptable === 1 ? '' : 's'} with one reason</label>
      <input id="adj-all-reason" maxlength="1000"><button type="button" data-accept-all>Accept all</button></section>` : ''}
    <div class="adj-table"><table>
      <thead><tr><th>What changed</th><th>What the plan already says</th><th>Your decision</th><th>Reason</th></tr></thead>
      <tbody>${list.items.map((item) => rowHtml(item, list, draft)).join('')}</tbody>
    </table></div>
    <footer><button type="button" class="secondary" data-cancel>Not now</button>
      <button type="button" data-review${allowed && !busy ? '' : ' disabled'}>Review and record</button></footer>
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
  const known = new Map(list.items.map((item) => [item.id, item]));
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
    answers.push({ itemId: item.id, disposition, reason, clauseIds: disposition === 'update-intent' ? clauseIds : [] });
  }
  return answers.length ? { answers, problem: null } : { answers, problem: 'Choose a decision for at least one row.' };
}

/** The exact words a person confirms: one line per answer, and what stays undecided. */
export function adjudicationSummary(list: AdjudicationList, answers: readonly AdjudicationAnswer[]): string {
  const labels = new Map((list.dispositions ?? []).map((entry) => [entry.id, entry.label]));
  const named = new Map(list.items.map((item) => [item.id, itemName(item)]));
  const left = list.items.filter((item) => !item.decision && !answers.some((answer) => answer.itemId === item.id));
  return [...answers.map((answer) => `${named.get(answer.itemId)}: ${labels.get(answer.disposition) ?? answer.disposition}${answer.clauseIds.length ? ` (${answer.clauseIds.join(', ')})` : ''}${answer.reason ? `. Reason: ${answer.reason}` : ''}`),
    ...(left.length ? ['', `Still undecided: ${left.map(itemName).join(', ')}`] : [])].join('\n');
}

export const ADJUDICATION_STYLE = `
.adj { display:grid; gap:1rem; padding:1rem 0; max-width:72rem; }
.adj h1 { margin:0 0 .25rem; }
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
    vscode.postMessage({ type: 'adjudicate.review', rows: rows().map((row) => ({ id: row.dataset.item,
      disposition: row.querySelector('[data-disposition]').value, reason: row.querySelector('[data-reason]').value,
      clauses: row.querySelector('[data-clauses]').value })) });
  }
});
`;

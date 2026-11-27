/**
 * The Needs-you place [FPL:REQ-008 to REQ-018, REQ-037]: the sidebar's tab and its one card page, built from the engine's
 * `needs-you --json` and `needs-you show <KEY> --json`. Pure: no VS Code API, so the host tests read every string.
 *
 * The sidebar's four places are one webview with tabs (§9 probe 2 confirms one view against four). The tab strip holds
 * Work (M2, views/work-page.ts), Needs you, Rules (M3, views/rules-page.ts) and Advanced (today's Navigator, unchanged);
 * Library joins it in M4. The places are off until M5 switches `singularityFlow.navigation.layout`.
 */
import { escape } from './webview.ts';
import { CALM_PALETTE_STYLE } from './theme.ts';

export type NeedsYouChoice = { id: string; label: string; command?: string | null; copilotCommand?: string | null; recommended?: boolean };
export type NeedsYouItem = {
  key: string; kind: string; group: 'holds-work' | 'reviews' | 'later'; question: string; why?: string;
  repository?: { id: string; name: string } | null;
  story?: { id: string; title?: string | null; kind?: string | null; task?: boolean } | null;
  step?: { id: string; label: string; version: number } | null;
  recommended?: { choice: string; words: string } | null; recommendation?: string;
  couldNotTell?: boolean; choices: NeedsYouChoice[];
  route?: { checkout?: string | null; clone?: string | null; here?: boolean; checksOut?: boolean; words?: string;
    elsewhere?: { commands: string[]; copilotCommand?: string | null } } | null;
  proposal?: { branch: string } | null; expected?: string; initiative?: { id: string; subject: string; expected: string } | null;
};
export type NeedsYouList = {
  items: NeedsYouItem[]; shown: number; more: number; lines: string[];
  counts: { badge: number; later: number; total: number; badgeTooltip: string; badgeLabel: string };
  checked: { at: string; words: string } | null; workspace: { id: string; name: string } | null;
};
export type NeedsYouCard = {
  key: string; item: NeedsYouItem; next: { key: string; question: string } | null;
  card: { question: string; asked: string; why?: string; about?: { title?: string; lines: string[] }; checked: string[];
    recommendation: { choice: string | null; words: string }; choices: NeedsYouChoice[];
    place?: { checkout?: string | null; clone?: string | null; here?: boolean; checksOut?: boolean; words?: string };
    read?: { path: string } | null; before?: Array<{ key: string; question: string }>; couldNotTell?: boolean };
};

const object = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const text = (value: unknown, limit = 600): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, limit) : null);
const KEY = /^[A-Za-z0-9._/@:-]{1,300}$/u;

function choicesOf(value: unknown): NeedsYouChoice[] {
  return (Array.isArray(value) ? value : []).slice(0, 12).flatMap((entry) => {
    const choice = object(entry);
    const id = text(choice?.id, 80);
    const label = text(choice?.label, 200);
    return id && label ? [{ id, label, command: text(choice?.command, 2000), copilotCommand: text(choice?.copilotCommand, 400),
      ...(choice?.recommended === true ? { recommended: true } : {}) }] : [];
  });
}

/** One item from untrusted CLI output, bounded; null when it is not an item. */
export function needsYouItemFrom(value: unknown): NeedsYouItem | null {
  const item = object(value);
  const key = text(item?.key, 300);
  const question = text(item?.question, 400);
  const group = item?.group;
  if (!item || !key || !KEY.test(key) || !question || !['holds-work', 'reviews', 'later'].includes(String(group))) return null;
  const repository = object(item.repository);
  const story = object(item.story);
  const step = object(item.step);
  const route = object(item.route);
  const elsewhere = object(route?.elsewhere);
  const recommended = object(item.recommended);
  return {
    key, kind: text(item.kind, 40) ?? 'decision', group: group as NeedsYouItem['group'], question, why: text(item.why) ?? '',
    repository: repository && text(repository.id, 128) ? { id: String(repository.id), name: text(repository.name, 128) ?? String(repository.id) } : null,
    story: story && text(story.id, 128) ? { id: String(story.id), title: text(story.title, 300), kind: text(story.kind, 60), task: story.task === true } : null,
    step: step && text(step.id, 128) ? { id: String(step.id), label: text(step.label, 200) ?? String(step.id), version: Number(step.version) || 0 } : null,
    recommended: recommended && text(recommended.words) ? { choice: text(recommended.choice, 80) ?? '', words: String(recommended.words) } : null,
    recommendation: text(item.recommendation) ?? '',
    ...(item.couldNotTell === true ? { couldNotTell: true } : {}),
    choices: choicesOf(item.choices),
    route: route ? { checkout: text(route.checkout, 2000), clone: text(route.clone, 2000), here: route.here === true, checksOut: route.checksOut === true,
      words: text(route.words) ?? undefined,
      elsewhere: elsewhere ? { commands: (Array.isArray(elsewhere.commands) ? elsewhere.commands : []).map((entry) => text(entry, 1000)).filter((entry): entry is string => Boolean(entry)),
        copilotCommand: text(elsewhere.copilotCommand, 300) } : undefined } : null,
    proposal: object(item.proposal) && text(object(item.proposal)?.branch, 300) ? { branch: String(object(item.proposal)?.branch) } : null,
    expected: text(item.expected, 200) ?? undefined,
    initiative: object(item.initiative) ? { id: String(object(item.initiative)?.id ?? ''), subject: String(object(item.initiative)?.subject ?? ''),
      expected: String(object(item.initiative)?.expected ?? '') } : null
  };
}

/** The list from untrusted CLI output (`sflow-needs-you`), or null. */
export function needsYouListFrom(value: unknown): NeedsYouList | null {
  const result = object(value);
  if (result?.resultType !== 'sflow-needs-you' || !Array.isArray(result.items)) return null;
  const items = result.items.map(needsYouItemFrom).filter((item): item is NeedsYouItem => Boolean(item));
  const counts = object(result.counts);
  const badge = items.filter((item) => item.group !== 'later').length;
  const checked = object(result.checked);
  const workspace = object(result.workspace);
  return {
    items, shown: Math.min(items.length, Number(result.shown) || 50), more: Math.max(0, items.length - (Number(result.shown) || 50)),
    lines: (Array.isArray(result.lines) ? result.lines : []).map((line) => text(line, 300)).filter((line): line is string => Boolean(line)).slice(0, 30),
    counts: { badge, later: items.length - badge, total: items.length,
      badgeTooltip: text(counts?.badgeTooltip, 80) ?? (badge === 1 ? '1 thing needs you' : `${badge} things need you`),
      badgeLabel: `Needs you: ${badge} waiting` },
    checked: checked && text(checked.words, 200) ? { at: String(checked.at ?? ''), words: String(checked.words) } : null,
    workspace: workspace && text(workspace.id, 128) ? { id: String(workspace.id), name: text(workspace.name, 200) ?? String(workspace.id) } : null
  };
}

/** One card from untrusted CLI output (`sflow-needs-you-card`), or null. */
export function needsYouCardFrom(value: unknown): NeedsYouCard | null {
  const result = object(value);
  const item = needsYouItemFrom(result?.item);
  const card = object(result?.card);
  if (result?.resultType !== 'sflow-needs-you-card' || !item || !card) return null;
  const lines = (entry: unknown, limit = 40) => (Array.isArray(entry) ? entry : []).map((line) => text(line, 600)).filter((line): line is string => Boolean(line)).slice(0, limit);
  const about = object(card.about);
  const recommendation = object(card.recommendation);
  const place = object(card.place);
  const next = object(result?.next);
  return {
    key: item.key, item,
    next: next && text(next.key, 300) && KEY.test(String(next.key)) ? { key: String(next.key), question: text(next.question, 400) ?? '' } : null,
    card: {
      question: text(card.question, 400) ?? item.question, asked: text(card.asked) ?? '', why: text(card.why) ?? item.why,
      about: { title: text(about?.title, 120) ?? 'What it is about', lines: lines(about?.lines) },
      checked: lines(card.checked, 16),
      recommendation: { choice: text(recommendation?.choice, 80), words: text(recommendation?.words) ?? item.recommendation ?? '' },
      choices: choicesOf(card.choices),
      place: place ? { checkout: text(place.checkout, 2000), clone: text(place.clone, 2000), here: place.here === true, checksOut: place.checksOut === true,
        words: text(place.words) ?? undefined } : undefined,
      read: object(card.read) && text(object(card.read)?.path, 1000) ? { path: String(object(card.read)?.path) } : null,
      before: (Array.isArray(card.before) ? card.before : []).map(object).filter(Boolean).map((entry) => ({ key: String(entry?.key ?? ''), question: String(entry?.question ?? '') }))
        .filter((entry) => KEY.test(entry.key)).slice(0, 10),
      ...(card.couldNotTell === true ? { couldNotTell: true } : {})
    }
  };
}

/** The activity-bar badge [FPL:REQ-018]: Holds work plus Reviews, read as "Needs you: 3 waiting". */
export function needsYouBadge(list: NeedsYouList | null): { value: number; tooltip: string } | undefined {
  if (!list || list.counts.badge < 1) return undefined;
  return { value: list.counts.badge, tooltip: list.counts.badgeTooltip };
}

export type PlaceTab = 'work' | 'needs-you' | 'rules' | 'advanced';
export const PLACE_TABS: readonly PlaceTab[] = Object.freeze(['work', 'needs-you', 'rules', 'advanced']);

/** The places' tab strip: an ARIA tablist, arrow keys move, Home and End jump [FPL:REQ-037]. */
export function placesTabsHtml(active: PlaceTab, list: NeedsYouList | null): string {
  const badge = list?.counts.badge ?? 0;
  const tab = (id: PlaceTab, label: string, extra = '') => `<button type="button" role="tab" id="place-tab-${id}" class="place-tab"
    aria-selected="${active === id}" aria-controls="place-panel" tabindex="${active === id ? '0' : '-1'}" data-tab="${id}">${escape(label)}${extra}</button>`;
  return `<div class="places-tabs" role="tablist" aria-label="SFlow places">${tab('work', 'Work')}${tab('needs-you', 'Needs you',
    badge ? ` <span class="place-count" aria-label="Needs you: ${badge} waiting">(${badge})</span>` : '')}${tab('rules', 'Rules')}${tab('advanced', 'Advanced')}</div>`;
}

const GROUP_TITLES: Record<NeedsYouItem['group'], string> = { 'holds-work': 'Holds work', reviews: 'Reviews', later: 'Later' };

function recommendationLine(item: NeedsYouItem): string {
  return item.recommended?.words ?? item.recommendation ?? '';
}

/** The Needs-you list in the sidebar [FPL:REQ-012]: one row per item, in the engine's order, the first `shown`. */
export function needsYouListHtml(list: NeedsYouList | null, { reading = false, error = null as string | null, all = false } = {}): string {
  if (!list) {
    return `<div class="needs-you-empty" role="status">${escape(error ?? (reading ? 'Reading what waits on you…' : 'Nothing read yet.'))}</div>`;
  }
  const shown = all ? list.items : list.items.slice(0, list.shown);
  const rows: string[] = [];
  let group: string | null = null;
  for (const item of shown) {
    if (item.group !== group) {
      if (group !== null) rows.push('</ul>');
      group = item.group;
      rows.push(`<h2 class="needs-you-group">${escape(GROUP_TITLES[item.group])}</h2><ul class="needs-you-items">`);
    }
    const story = item.story ? `${item.story.title ?? item.story.id} · ${item.story.id}` : 'Configuration';
    rows.push(`<li><button type="button" class="needs-you-row" data-key="${escape(item.key)}">
      <span class="needs-you-question">${escape(item.question)}</span>
      <span class="needs-you-story">${escape(story)}${item.repository ? ` · ${escape(item.repository.name)}` : ''}</span>
      ${item.couldNotTell ? '<span class="needs-you-unsure">SFlow could not tell whether this one is yours</span>' : ''}
      <span class="needs-you-advice">${escape(recommendationLine(item))}</span></button></li>`);
  }
  if (group !== null) rows.push('</ul>');
  const more = !all && list.more ? `<button type="button" class="needs-you-more" data-more="1">Show ${list.more} more</button>` : '';
  const empty = list.items.length ? '' : '<p class="needs-you-empty">Nothing waits on you now.</p>';
  const head = `<p class="needs-you-checked">${escape(list.checked?.words ?? (reading ? 'Reading…' : 'Not read yet'))}${reading ? ' · reading' : ''}</p>`;
  const lines = list.lines.map((line) => `<p class="needs-you-line">${escape(line)}</p>`).join('');
  return `${head}${error ? `<p class="needs-you-line" role="status">${escape(error)}</p>` : ''}${empty}${rows.join('')}${more}${lines}`;
}

export const NEEDS_YOU_STYLE = `${CALM_PALETTE_STYLE}
body { padding: 0 8px 8px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.places-tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); margin: 6px 0 8px; }
.place-tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--vscode-foreground); padding: 4px 6px; cursor: pointer; font: inherit; }
.place-tab[aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.place-tab:focus-visible, .needs-you-row:focus-visible, .needs-you-more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.needs-you-group { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 10px 0 4px; color: var(--vscode-descriptionForeground); }
.needs-you-items { list-style: none; margin: 0; padding: 0; }
.needs-you-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; background: none; border: 0;
  border-radius: 3px; padding: 6px 4px; color: var(--vscode-foreground); cursor: pointer; font: inherit; overflow-wrap: anywhere; }
.needs-you-row:hover { background: var(--vscode-list-hoverBackground); }
.needs-you-question { font-weight: 600; }
.needs-you-story, .needs-you-advice, .needs-you-checked, .needs-you-line, .needs-you-unsure { color: var(--vscode-descriptionForeground); font-size: 12px; }
.needs-you-unsure { font-style: italic; }
.needs-you-more { margin-top: 6px; background: none; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); color: var(--vscode-foreground); padding: 3px 8px; cursor: pointer; font: inherit; }
.needs-you-back { background: none; border: 0; color: var(--vscode-textLink-foreground); padding: 4px 0; cursor: pointer; font: inherit; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/**
 * The tab strip's keys and clicks, with the page's `vscode` handle: under Advanced it runs beside today's Navigator script,
 * which already holds the one handle a webview may acquire.
 */
export const PLACES_TABS_SCRIPT = `
(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) tab.addEventListener('click', () => vscode.postMessage({ type: 'places', action: 'tab', tab: tab.dataset.tab }));
  document.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const move = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (move !== undefined) { event.preventDefault(); tabs[(move + tabs.length) % tabs.length].focus(); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); document.activeElement.click(); }
  });
})();
`;

/** The Needs-you tab's script: the tabs, and each row and "Show more" as a message; nothing here records anything. */
export const NEEDS_YOU_SCRIPT = `
const vscode = acquireVsCodeApi();
${PLACES_TABS_SCRIPT}
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-key],[data-more]');
  if (!target) return;
  if (target.dataset.key) vscode.postMessage({ type: 'places', action: 'open', key: target.dataset.key });
  else if (target.dataset.more) vscode.postMessage({ type: 'places', action: 'more' });
});
`;

/** The places' sidebar body for the Needs-you tab. */
export function needsYouPlaceBody(list: NeedsYouList | null, options: { reading?: boolean; error?: string | null; all?: boolean } = {}): string {
  return `${placesTabsHtml('needs-you', list)}<div id="place-panel" role="tabpanel" aria-labelledby="place-tab-needs-you">${needsYouListHtml(list, options)}</div>`;
}

/** Another place's panel (Work, Rules) under the tab strip, as its tab's panel. */
export function placePanelBody(tab: PlaceTab, list: NeedsYouList | null, panel: string): string {
  return `${placesTabsHtml(tab, list)}<div id="place-panel" role="tabpanel" aria-labelledby="place-tab-${tab}">${panel}</div>`;
}

/** The row above today's Navigator under Advanced, back to the places [FPL:REQ-032]. */
export function advancedBackHtml(list: NeedsYouList | null): string {
  return placesTabsHtml('advanced', list);
}

/** The card's choice buttons: only the engine's choices, the recommended one first [FPL:REQ-013, REQ-014]. */
function choiceButtons(card: NeedsYouCard): string {
  const choices = [...card.card.choices].sort((left, right) => Number(right.id === card.card.recommendation.choice) - Number(left.id === card.card.recommendation.choice));
  return choices.map((choice, index) => `<button type="button" class="${index === 0 ? 'primary' : 'secondary'}" data-choice="${escape(choice.id)}">${escape(choice.label)}</button>`).join(' ');
}

/** One card in the one Needs-you page [FPL:REQ-013]: question, what it is about, what SFlow checked, the advice, the choices. */
export function needsYouCardHtml(card: NeedsYouCard, { result = null as string | null } = {}): string {
  const { item } = card;
  const story = item.story ? `${item.story.title ?? item.story.id} · ${item.story.id}${item.story.kind ? ` · ${item.story.kind}` : ''}` : 'Configuration';
  const list = (lines: string[]) => (lines.length ? `<ul>${lines.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : '');
  const before = card.card.before?.length ? `<section aria-labelledby="before-title"><h2 id="before-title">Decide these first</h2><ul>${card.card.before
    .map((entry) => `<li><button type="button" class="link" data-open="${escape(entry.key)}">${escape(entry.question)}</button></li>`).join('')}</ul></section>` : '';
  const elsewhere = !card.card.place?.here && item.route?.elsewhere?.commands?.length
    ? `<p class="muted">${escape(item.repository?.name ?? 'Its repository')} is not this window's folder. SFlow runs each choice there.</p>` : '';
  return `<main class="needs-you-card">
<h1 id="card-question" tabindex="-1">${escape(card.card.question)}</h1>
<p class="muted">${escape(story)}${item.repository ? ` · ${escape(item.repository.name)}` : ''}</p>
${card.card.couldNotTell ? '<p class="warning">SFlow could not tell whether this one is yours: acting on it checks it.</p>' : ''}
${card.card.why ? `<p>${escape(card.card.why)}</p>` : ''}
${card.card.about?.lines.length ? `<section aria-labelledby="about-title"><h2 id="about-title">${escape(card.card.about.title ?? 'What it is about')}</h2>${list(card.card.about.lines)}</section>` : ''}
${card.card.checked.length ? `<section aria-labelledby="checked-title"><h2 id="checked-title">What SFlow checked</h2>${list(card.card.checked)}</section>` : ''}
<section aria-labelledby="advice-title"><h2 id="advice-title">SFlow's recommendation</h2><p>${escape(card.card.recommendation.words)}</p></section>
${before}
${card.card.place?.words ? `<p class="muted">${escape(card.card.place.words)}</p>` : ''}${elsewhere}
<div class="choices">${choiceButtons(card)}${card.card.read ? ' <button type="button" class="secondary" data-read="1">Read the whole document</button>' : ''}</div>
<div id="card-result" role="status" aria-live="polite">${result ? escape(result) : ''}</div>
${result && card.next ? `<p><button type="button" class="primary" data-open="${escape(card.next.key)}">Next: ${escape(card.next.question)}</button></p>` : ''}
</main>`;
}

export const NEEDS_YOU_CARD_STYLE = `
.needs-you-card { max-width: 760px; padding: 12px 16px; overflow-wrap: anywhere; }
.needs-you-card h1 { font-size: 1.4em; margin: 0 0 6px; }
.needs-you-card h2 { font-size: 1.05em; margin: 14px 0 4px; }
.needs-you-card .muted { color: var(--vscode-descriptionForeground); }
.needs-you-card .warning { color: var(--vscode-editorWarning-foreground); }
.needs-you-card .choices { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.needs-you-card button.link { background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; }
#card-result { margin-top: 12px; }
`;

export const NEEDS_YOU_CARD_SCRIPT = `
const vscode = window.__sfVscode;
document.getElementById('card-question')?.focus();
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-choice],[data-open],[data-read]');
  if (!target) return;
  if (target.dataset.choice) vscode.postMessage({ type: 'choose', choice: target.dataset.choice });
  else if (target.dataset.open) vscode.postMessage({ type: 'open', key: target.dataset.open });
  else if (target.dataset.read) vscode.postMessage({ type: 'read' });
});
`;

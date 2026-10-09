/**
 * The Repository Brief page: its tabs, statements and sources as HTML. Pure (no editor APIs), so it
 * is tested directly; repository-brief.ts is the panel that fetches the brief and shows this page.
 */
import { escape } from './webview.ts';

export type BriefSource = { path: string; line: number | null; label: string };
export type BriefStatement = { text: string; cites: string[]; sources: BriefSource[]; origin?: 'model' | 'template' };
export type RepositoryBrief = {
  repository: string;
  commit: string;
  phase: string | null;
  order: string[];
  mode: 'model' | 'template';
  model: string | null;
  createdAt: string | null;
  cached: boolean;
  reason: string | null;
  views: Record<string, BriefStatement[]>;
  rejected: number;
  rejections: Array<{ view: string; text: string; reason: string }>;
  evidence: { count: number; documents: string[]; documentStatements: number };
  documented: Array<{ text: string; path: string; line: number | null; heading: string | null }>;
  notKnown: string[];
};

export const BRIEF_TABS = ['overview', 'rules', 'contracts', 'flows', 'impact', 'risks', 'questions', 'sources'] as const;
export type BriefTab = typeof BRIEF_TABS[number];
export const BRIEF_PHASES = ['all', 'intake', 'design', 'implementation', 'verification', 'release'] as const;
export type BriefPhase = typeof BRIEF_PHASES[number];

const TAB_TITLES: Record<BriefTab, string> = {
  overview: 'Overview', rules: 'Business rules', contracts: 'Contracts', flows: 'Flows',
  impact: 'Change impact', risks: 'Risks', questions: 'Questions', sources: 'Sources'
};
const TAB_VIEWS: Partial<Record<BriefTab, string>> = {
  rules: 'biz.rules', contracts: 'arch.contracts', flows: 'biz.flows', impact: 'dev.impact', risks: 'dev.hotspots'
};
const TAB_PURPOSE: Record<BriefTab, string> = {
  overview: 'What this repository is and how it is built.',
  rules: 'What the product decides, refuses, calculates and limits, from the code, the docs and approved requirements.',
  contracts: 'What the system exposes and what it uses: endpoints, data shapes, outside services and configuration.',
  flows: 'What happens, step by step, when someone uses a feature.',
  impact: 'What depends on what, which tests cover it, and what changes together.',
  risks: 'Where a change is risky, and why.',
  questions: 'What a product owner should decide: conflicts between docs and code, and rules no test reaches.',
  sources: 'The documents that were read, the statements taken from them, and anything the checks dropped.'
};
const PHASE_LABELS: Record<BriefPhase, string> = {
  all: 'All views', intake: 'Intake and specification', design: 'Design and planning',
  implementation: 'Implementation', verification: 'Verification and testing', release: 'Release'
};

/** Escaped text with `code` spans and a leading "Conflict:" shown as a badge. */
function statementHtml(text: string): string {
  const conflict = /^Conflict:\s*/iu.test(text);
  const body = escape(conflict ? text.replace(/^Conflict:\s*/iu, '') : text).replace(/`([^`]+)`/gu, '<code>$1</code>');
  return `${conflict ? '<span class="badge conflict">Conflict</span> ' : ''}${body}`;
}

function sourceButtons(sources: BriefSource[]): string {
  if (!sources.length) return '';
  return `<div class="brief-sources">${sources.slice(0, 4).map((source) =>
    `<button class="link" type="button" data-open-file="${escape(source.path)}" data-open-line="${source.line ?? 0}" title="Open ${escape(source.label || source.path)}">${escape(source.label || source.path)}</button>`
  ).join('')}</div>`;
}

function statements(list: BriefStatement[], mode: RepositoryBrief['mode']): string {
  if (!list.length) return '<div class="empty"><p>Nothing to show here for this repository.</p></div>';
  return `<ul class="brief-list">${list.map((statement) => `<li>
    <p>${statementHtml(statement.text)}${mode === 'model' && statement.origin === 'template' ? ' <span class="badge muted-badge" title="The model wrote nothing for this view; this is the evidence itself.">from the evidence</span>' : ''}</p>
    ${sourceButtons(statement.sources)}
  </li>`).join('')}</ul>`;
}

function sourcesTab(brief: RepositoryBrief): string {
  const documents = brief.evidence.documents.length
    ? `<ul class="brief-list compact">${brief.evidence.documents.map((document) => `<li><button class="link" type="button" data-open-file="${escape(document)}" data-open-line="0">${escape(document)}</button></li>`).join('')}</ul>`
    : '<p class="muted">No README or docs were found in this commit.</p>';
  const documented = brief.documented.length
    ? `<ul class="brief-list">${brief.documented.map((entry) => `<li><p>${statementHtml(entry.text)}</p>${sourceButtons([{ path: entry.path, line: entry.line, label: entry.heading ? `${entry.path} › ${entry.heading}` : entry.path }])}</li>`).join('')}</ul>`
    : '<p class="muted">No rule-like statements were found in the docs.</p>';
  const rejected = brief.rejections.length
    ? `<details class="card"><summary>${brief.rejected} model statement${brief.rejected === 1 ? ' was' : 's were'} dropped by the checks</summary><ul class="brief-list compact">${brief.rejections.map((entry) => `<li><p>${escape(entry.text)}</p><p class="meta">${escape(TAB_TITLES[entry.view as BriefTab] ?? entry.view)} · ${escape(entry.reason)}</p></li>`).join('')}</ul></details>`
    : '';
  return `<h3>Documents read</h3>${documents}<h3>Statements taken from the docs</h3>${documented}${rejected}`;
}

export type BriefPageState = {
  tab: BriefTab;
  phase: BriefPhase;
  loading: 'read' | 'generate' | null;
  error: string | null;
};

/** The page body for one brief and the panel's state. Pure, so it can be tested without VS Code. */
export function repositoryBriefBody(brief: RepositoryBrief | null, state: BriefPageState): string {
  const phaseOptions = BRIEF_PHASES.map((phase) => `<option value="${phase}"${phase === state.phase ? ' selected' : ''}>${escape(PHASE_LABELS[phase])}</option>`).join('');
  const busy = state.loading === 'generate'
    ? '<p class="callout" role="status">Writing the brief with the model. This can take a few minutes; the checks run as soon as it answers.</p>'
    : state.loading === 'read' ? '<p class="meta" role="status">Reading the repository…</p>' : '';
  const error = state.error ? `<p class="warning" role="alert">${escape(state.error)}</p>` : '';
  const header = `<header class="brief-header">
    <div><h1>Repository Brief</h1>
      ${brief ? `<p class="meta">${escape(brief.repository)} at <code>${escape(String(brief.commit).slice(0, 12))}</code> · ${brief.evidence.count} pieces of evidence · ${brief.evidence.documents.length} document${brief.evidence.documents.length === 1 ? '' : 's'}</p>` : ''}
    </div>
    <div class="brief-actions">
      <label class="meta" for="brief-phase">Phase</label>
      <select id="brief-phase" data-message="phase">${phaseOptions}</select>
      <button type="button" data-message="generate"${state.loading ? ' disabled' : ''}>Write with model</button>
      <button type="button" class="secondary" data-message="refresh"${state.loading ? ' disabled' : ''}>Refresh</button>
    </div>
  </header>`;
  if (!brief) return `${header}${busy}${error}`;
  const mode = brief.mode === 'model'
    ? `<p class="brief-mode model"><strong>Written by ${escape(brief.model ?? 'the model')}</strong> from the evidence${brief.createdAt ? ` on ${escape(new Date(brief.createdAt).toLocaleString())}` : ''}. Every statement was checked against what it cites${brief.rejected ? `; ${brief.rejected} ${brief.rejected === 1 ? 'was' : 'were'} dropped (see Sources)` : ''}.</p>`
    : `<p class="brief-mode"><strong>Built from the code, tests, history and docs</strong> without a model.${brief.reason ? ` ${escape(brief.reason)}` : ''}</p>`;
  const order = brief.order.filter((id): id is BriefTab => (BRIEF_TABS as readonly string[]).includes(id));
  const phaseTabs = new Set(state.phase === 'all' ? [] : order.slice(0, 5));
  const tabOrder: BriefTab[] = [...order, ...BRIEF_TABS.filter((tab) => !order.includes(tab))];
  const count = (tab: BriefTab): number => tab === 'sources' ? brief.documented.length : (brief.views[tab] ?? []).length;
  const tabs = `<nav class="tabs" role="tablist" aria-label="Brief views">${tabOrder.map((tab) => `<button type="button" role="tab" data-message="tab" data-tab="${tab}" aria-selected="${tab === state.tab}" class="${tab === state.tab ? 'active' : ''}${phaseTabs.has(tab) ? ' phase' : ''}">${escape(TAB_TITLES[tab])} <span class="count">${count(tab)}</span></button>`).join('')}</nav>`;
  const phaseNote = state.phase === 'all' ? '' : `<p class="meta">For ${escape(PHASE_LABELS[state.phase].toLowerCase())}, the highlighted views come first: ${order.slice(0, 5).map((tab) => escape(TAB_TITLES[tab])).join(', ')}.</p>`;
  const view = TAB_VIEWS[state.tab];
  const content = state.tab === 'sources' ? sourcesTab(brief) : statements(brief.views[state.tab] ?? [], brief.mode);
  const notKnown = brief.notKnown.length ? `<p class="meta brief-not-known">Not known: ${escape(brief.notKnown.join('; '))}.</p>` : '';
  return `${header}${busy}${error}${mode}${phaseNote}${tabs}
    <section class="brief-view" role="tabpanel"><h2>${escape(TAB_TITLES[state.tab])}${view ? ` <span class="badge">${escape(view)}</span>` : ''}</h2>
      <p class="meta">${escape(TAB_PURPOSE[state.tab])}</p>${content}</section>${notKnown}`;
}

export const REPOSITORY_BRIEF_STYLES = `
  .brief-header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; justify-content: space-between; margin-bottom: .75rem; }
  .brief-header h1 { margin: 0 0 .25rem; }
  .brief-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .brief-mode { padding: .6rem .8rem; border-radius: 6px; border: var(--sf-border); background: var(--sf-surface); }
  .brief-mode.model { border-left: 4px solid var(--sf-ok); }
  .tabs { display: flex; flex-wrap: wrap; gap: .35rem; margin: .9rem 0 .4rem; }
  .tabs button { background: transparent; color: var(--vscode-foreground); border: var(--sf-border); border-radius: 999px; padding: .3rem .8rem; }
  .tabs button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .tabs button.phase:not(.active) { border-color: var(--sf-ok); }
  .tabs .count { opacity: .75; font-variant-numeric: tabular-nums; margin-left: .2rem; }
  .brief-view h2 { display: flex; align-items: center; gap: .5rem; margin-top: .6rem; }
  .brief-list { list-style: none; padding: 0; margin: .5rem 0 1rem; display: grid; gap: .55rem; }
  .brief-list > li { padding: .6rem .8rem; border: var(--sf-border); border-radius: 6px; background: var(--sf-surface); }
  .brief-list.compact > li { padding: .35rem .6rem; }
  .brief-list p { margin: 0; }
  .brief-sources { display: flex; flex-wrap: wrap; gap: .25rem .8rem; margin-top: .35rem; font-size: .9em; }
  .badge.conflict { background: var(--sf-bad); color: var(--vscode-editor-background); }
  .muted-badge { opacity: .7; }
  .brief-not-known { margin-top: 1rem; }
`;

export const REPOSITORY_BRIEF_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-message="tab"]');
    if (tab) return vscode.postMessage({ type: 'tab', tab: tab.dataset.tab });
    if (event.target.closest('[data-message="generate"]')) return vscode.postMessage({ type: 'generate' });
    if (event.target.closest('[data-message="refresh"]')) return vscode.postMessage({ type: 'refresh' });
    const file = event.target.closest('[data-open-file]');
    if (file) vscode.postMessage({ type: 'open-file', path: file.dataset.openFile, line: Number(file.dataset.openLine || 0) });
  });
  document.addEventListener('change', (event) => {
    const select = event.target.closest('[data-message="phase"]');
    if (select) vscode.postMessage({ type: 'phase', phase: select.value });
  });
`;

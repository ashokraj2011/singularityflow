/** Searchable, offline rendering of the canonical Singularity Flow manual. */
import {
  brandLockup, escape, icon } from './webview.ts';

export interface HelpTopic {
  id: string;
  title: string;
  content: string;
}

export interface HelpDocument {
  schemaVersion: number;
  title: string;
  content: string;
  topics: HelpTopic[];
  selectedTopic?: string;
}

export interface HelpAnswerView {
  status: 'resolved' | 'ambiguous' | 'not-found' | 'unavailable';
  question: string;
  intent: string;
  matchedBy: string;
  topic: { id: string; title: string; file: string } | null;
  content: string | null;
  citation: string | null;
  candidates: Array<{ id: string; title: string }>;
  related: Array<{ id: string; title: string }>;
  handoff: { skill: string; command: string } | null;
}

export interface HelpMetricsView {
  enabled: boolean;
  count: number;
  outcomes: Record<string, number>;
  intents: Record<string, number>;
  topics: Record<string, number>;
  unresolvedIntents: Record<string, number>;
  ambiguousIntents: Record<string, number>;
  noMatchIntents: Record<string, number>;
}

const QUESTION_EXAMPLES = [
  'Why can’t I submit?',
  'How do I recover an interrupted phase?',
  'How do capability onboarding and workspace creation connect?',
  'What is project binding?',
  'When is the world model reused?',
  'How do prompt logging and token economy work?'
];

const START_TOPICS = [
  'quick-start',
  'low-friction-cockpit-diagnostics-and-guided-execution',
  'workspaces-and-capabilities',
  'workspace-configuration',
  'governed-agents-and-approval-authority',
  'world-model',
  'jira-intake',
  'multi-repository-initiatives',
  'troubleshooting'
];

function inline(value: string): string {
  return escape(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="help-link" data-link="$2" role="link" tabindex="0">$1</span>');
}

/**
 * Deliberately small Markdown renderer for the bundled manual.
 *
 * It escapes first and supports only the structures the manual uses. That gives the Help Center
 * readable headings, lists, tables and copyable commands without admitting arbitrary HTML from a
 * repository or adding a second Markdown dependency to the extension.
 */
export function renderHelpMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const rendered: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let code: string[] | null = null;
  let table: string[][] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length) rendered.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) rendered.push(`</${list}>`);
    list = null;
  };
  const flushTable = (): void => {
    if (!table?.length) { table = null; return; }
    const rows = table.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
    const [head, ...body] = rows;
    if (head) rendered.push(`<div class="help-table-wrap"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    table = null;
  };

  for (const line of lines) {
    if (code) {
      if (line.startsWith('```')) {
        const value = code.join('\n');
        rendered.push(`<div class="help-code"><button class="secondary copy-code" data-copy="${escape(value)}" title="Copy command">Copy</button><pre><code>${escape(value)}</code></pre></div>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith('```')) {
      flushParagraph(); flushList(); flushTable(); code = [];
      continue;
    }
    const cells = line.trim().startsWith('|') && line.trim().endsWith('|')
      ? line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
      : null;
    if (cells) {
      flushParagraph(); flushList(); (table ??= []).push(cells); continue;
    }
    flushTable();
    const heading = /^(#{2,5})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(5, heading[1]?.length ?? 2);
      rendered.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(); flushList();
      rendered.push(`<blockquote>${inline(quote[1] ?? '')}</blockquote>`);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const next = bullet ? 'ul' : 'ol';
      if (list !== next) { flushList(); list = next; rendered.push(`<${next}>`); }
      rendered.push(`<li>${inline((bullet ?? numbered)?.[1] ?? '')}</li>`);
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    paragraph.push(line.trim());
  }
  if (code) rendered.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  flushParagraph(); flushList(); flushTable();
  return rendered.join('\n');
}

function topicButton(topic: HelpTopic, selected: string | null): string {
  return `<button class="help-topic${topic.id === selected ? ' selected' : ''}" data-topic="${escape(topic.id)}" data-search-text="${escape(`${topic.title} ${topic.content}`.toLowerCase())}">
    <strong>${escape(topic.title)}</strong><small>${escape(topic.id)}</small></button>`;
}

function answerHtml(answer: HelpAnswerView | null): string {
  if (!answer) return '<section class="help-answer empty-answer"><p>Ask in ordinary language. Answers come only from reviewed offline topics.</p></section>';
  const candidates = answer.candidates.length
    ? `<div class="help-answer-choices">${answer.candidates.map((topic) => `<button class="secondary" data-question="${escape(topic.id)}" data-question-origin="followup">${escape(topic.title)}</button>`).join('')}</div>` : '';
  if (answer.status !== 'resolved' || !answer.topic || !answer.content) {
    return `<section class="help-answer ${answer.status === 'ambiguous' ? 'wait' : 'bad'}">
      <p class="eyebrow">${escape(answer.intent)} · ${escape(answer.matchedBy)}</p>
      <h2>${answer.status === 'ambiguous' ? 'Choose the intended topic' : 'No reviewed answer matched'}</h2>
      <p>${answer.status === 'ambiguous'
        ? 'The question overlaps more than one reviewed topic, so Singularity Flow did not guess.'
        : 'Try one of the nearest reviewed topics or filter the complete manual below.'}</p>${candidates}</section>`;
  }
  const actions = `<div class="form-actions">
    <button data-open-help-topic="${escape(answer.topic.id)}">Open topic</button>
    ${answer.handoff ? `<button class="secondary" data-copy="${escape(answer.handoff.command)}" data-help-copy-topic="${escape(answer.topic.id)}">Copy command</button>
      <button class="secondary" data-prefill-help="${escape(answer.handoff.skill)}" data-prefill-topic="${escape(answer.topic.id)}">Prepare ${escape(answer.handoff.skill)}</button>` : ''}
  </div>`;
  const related = answer.related.length
    ? `<h3>Related questions</h3><div class="help-answer-choices">${answer.related.map((topic) => `<button class="secondary" data-question="${escape(topic.id)}" data-question-origin="followup">${escape(topic.title)}</button>`).join('')}</div>` : '';
  return `<section class="help-answer ok">
    <p class="eyebrow">${escape(answer.intent)} · matched by ${escape(answer.matchedBy)}</p>
    <h2>${escape(answer.topic.title)}</h2>
    <div class="help-answer-body">${renderHelpMarkdown(answer.content)}</div>
    <p class="help-citation">Source: docs/topics/${escape(answer.topic.file)}<br>${escape(answer.citation ?? '')}</p>${actions}${related}</section>`;
}

function metricsHtml(metrics: HelpMetricsView | null): string {
  if (!metrics) return '';
  const top = Object.entries(metrics.topics).sort((left, right) => right[1] - left[1]).slice(0, 3);
  const ambiguous = Object.entries(metrics.ambiguousIntents).sort((left, right) => right[1] - left[1]).slice(0, 3);
  const noMatch = Object.entries(metrics.noMatchIntents).sort((left, right) => right[1] - left[1]).slice(0, 3);
  return `<section class="help-metrics"><h2>Help routing</h2>
    <p class="meta">${metrics.enabled ? 'Local aggregates on' : 'Local aggregates off'} · ${metrics.count} request(s)</p>
    <p class="meta">Resolved ${metrics.outcomes.resolved ?? 0} · ambiguous ${metrics.outcomes.ambiguous ?? 0} · no match ${metrics.outcomes['no-match'] ?? 0}</p>
    ${ambiguous.length ? `<p class="meta">Frequent ambiguous categories: ${ambiguous.map(([id, count]) => `${escape(id)} (${count})`).join(', ')}</p>` : ''}
    ${noMatch.length ? `<p class="meta">Frequent no-match categories: ${noMatch.map(([id, count]) => `${escape(id)} (${count})`).join(', ')}</p>` : ''}
    ${top.length ? `<p class="meta">Frequent topics: ${top.map(([id, count]) => `${escape(id)} (${count})`).join(', ')}</p>` : ''}</section>`;
}

export function helpCenterHtml(
  document: HelpDocument,
  requested: string | null = null,
  answer: HelpAnswerView | null = null,
  metrics: HelpMetricsView | null = null
): string {
  const selected = document.topics.find((topic) => topic.id === requested)
    ?? document.topics.find((topic) => topic.id === 'quick-start')
    ?? document.topics[0] ?? null;
  const shortcuts = START_TOPICS.map((id) => document.topics.find((topic) => topic.id === id)).filter((topic): topic is HelpTopic => Boolean(topic));
  return `<header class="help-header">
    ${brandLockup()}
    <p class="eyebrow">Product guide and command reference</p>
    <h1>${icon('book', { size: 24 })}Help Center</h1>
    <p class="meta">Search the complete offline manual for My Work, workspaces, configuration, agents, world model, Jira, Initiatives, commands, and recovery. Ask a natural-language question against reviewed topics; no model is called.</p>
    <form class="help-question-form" data-help-question-form>
      <input class="help-search" type="search" data-help-question maxlength="300" placeholder="Why can’t I submit?" aria-label="Ask Singularity Flow help">
      <button type="submit">Ask SFlow</button>
    </form>
    <div class="help-question-examples">${QUESTION_EXAMPLES.map((question) => `<button class="link" data-question="${escape(question)}" data-question-origin="example">${escape(question)}</button>`).join('')}</div>
  </header>
  ${answerHtml(answer)}
  <div class="help-layout">
    <aside class="help-nav" aria-label="Help topics">
      <h2>Start here</h2>
      <div class="help-shortcuts">${shortcuts.map((topic) => topicButton(topic, selected?.id ?? null)).join('')}</div>
      <details><summary>All ${document.topics.length} topics</summary>
        <div class="help-all-topics">${document.topics.map((topic) => topicButton(topic, selected?.id ?? null)).join('')}</div>
      </details>
      ${metricsHtml(metrics)}
    </aside>
    <main class="help-content">
      <label class="help-filter-label">Filter text in the complete manual
        <input class="help-search" type="search" data-help-search placeholder="Workspace, agent, Jira, world model…" aria-label="Filter manual text">
      </label>
      <div class="help-no-results" hidden><h2>No matching help</h2><p>Try a command name, workflow concept, file name, or Jira term.</p></div>
      ${document.topics.map((topic) => `<article id="help-${escape(topic.id)}" class="help-article${topic.id === selected?.id ? ' selected' : ''}" data-topic-id="${escape(topic.id)}" data-search-text="${escape(`${topic.title} ${topic.content}`.toLowerCase())}">
        <p class="eyebrow">${escape(topic.id)}</p><h1>${escape(topic.title)}</h1>${renderHelpMarkdown(topic.content)}</article>`).join('')}
    </main>
  </div>`;
}

export const HELP_CENTER_SCRIPT = `
(() => {
  const vscode = window.__sfVscode;
  const articles = [...document.querySelectorAll('.help-article')];
  const topicButtons = [...document.querySelectorAll('[data-topic]')];
  const search = document.querySelector('[data-help-search]');
  const question = document.querySelector('[data-help-question]');
  const empty = document.querySelector('.help-no-results');
  let selectedId = articles.find((article) => article.classList.contains('selected'))?.dataset.topicId;
  const select = (id) => {
    selectedId = id;
    if (search) search.value = '';
    articles.forEach((article) => article.classList.remove('search-match'));
    topicButtons.forEach((button) => { button.hidden = false; });
    articles.forEach((article) => article.classList.toggle('selected', article.dataset.topicId === id));
    topicButtons.forEach((button) => button.classList.toggle('selected', button.dataset.topic === id));
    if (empty) empty.hidden = true;
    const article = articles.find((candidate) => candidate.dataset.topicId === id);
    article?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  topicButtons.forEach((button) => button.addEventListener('click', () => select(button.dataset.topic)));
  document.querySelector('[data-help-question-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = question?.value?.trim();
    if (value) vscode.postMessage({ type: 'ask-question', question: value, origin: 'typed' });
  });
  document.querySelectorAll('[data-question]').forEach((button) => button.addEventListener('click', () => {
    vscode.postMessage({ type: 'ask-question', question: button.dataset.question, origin: button.dataset.questionOrigin || 'followup' });
  }));
  document.querySelectorAll('[data-open-help-topic]').forEach((button) => button.addEventListener('click', () => {
    vscode.postMessage({ type: 'open-topic', topic: button.dataset.openHelpTopic });
  }));
  document.querySelectorAll('[data-prefill-help]').forEach((button) => button.addEventListener('click', () => {
    vscode.postMessage({ type: 'prefill-action', skill: button.dataset.prefillHelp, topic: button.dataset.prefillTopic });
  }));
  document.querySelectorAll('[data-link]').forEach((link) => {
    const open = () => vscode.postMessage({ type: 'open-link', target: link.dataset.link });
    link.addEventListener('click', open);
    link.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
  });
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    let matches = 0;
    articles.forEach((article) => {
      const visible = !query || article.dataset.searchText.includes(query);
      article.classList.toggle('search-match', visible && Boolean(query));
      article.classList.toggle('selected', !query && article.dataset.topicId === selectedId);
      if (visible) matches += 1;
    });
    topicButtons.forEach((button) => { button.hidden = Boolean(query) && !button.dataset.searchText.includes(query); });
    if (empty) empty.hidden = matches > 0;
  });
  document.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-copy]');
    if (!target) return;
    await navigator.clipboard.writeText(target.dataset.copy || '');
    if (target.dataset.helpCopyTopic) vscode.postMessage({ type: 'copy-command', topic: target.dataset.helpCopyTopic });
    const previous = target.textContent; target.textContent = 'Copied';
    setTimeout(() => { target.textContent = previous; }, 1200);
  });
})();`;

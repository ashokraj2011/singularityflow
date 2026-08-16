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
    const heading = /^(#{3,5})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(5, heading[1]?.length ?? 3);
      rendered.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
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

export function helpCenterHtml(document: HelpDocument, requested: string | null = null): string {
  const selected = document.topics.find((topic) => topic.id === requested)
    ?? document.topics.find((topic) => topic.id === 'quick-start')
    ?? document.topics[0] ?? null;
  const shortcuts = START_TOPICS.map((id) => document.topics.find((topic) => topic.id === id)).filter((topic): topic is HelpTopic => Boolean(topic));
  return `<header class="help-header">
    ${brandLockup()}
    <p class="eyebrow">Product guide and command reference</p>
    <h1>${icon('book', { size: 24 })}Help Center</h1>
    <p class="meta">Search the complete offline manual for My Work, workspaces, configuration, agents, world model, Jira, Initiatives, commands, and recovery. The same <code>HELP.md</code> ships with the CLI.</p>
    <input class="help-search" type="search" data-help-search placeholder="Search My Work, workspace, agent, Jira, world model…" aria-label="Search help">
  </header>
  <div class="help-layout">
    <aside class="help-nav" aria-label="Help topics">
      <h2>Start here</h2>
      <div class="help-shortcuts">${shortcuts.map((topic) => topicButton(topic, selected?.id ?? null)).join('')}</div>
      <details><summary>All ${document.topics.length} topics</summary>
        <div class="help-all-topics">${document.topics.map((topic) => topicButton(topic, selected?.id ?? null)).join('')}</div>
      </details>
    </aside>
    <main class="help-content">
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
    const previous = target.textContent; target.textContent = 'Copied';
    setTimeout(() => { target.textContent = previous; }, 1200);
  });
})();`;

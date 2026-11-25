/** Browser presentation for canonical workspace data. All dynamic text is escaped at the boundary. */
export const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

// Use the same semantic line icons as the VS Code workspace, drawn locally.
const icons = {
  home: '<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>',
  specs: '<path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/>',
  stories: '<path d="M4 5a2 2 0 0 1 2-2h5a3 3 0 0 1 1 2 3 3 0 0 1 1-2h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5a2 2 0 0 0-1 1 2 2 0 0 0-1-1H6a2 2 0 0 1-2-2zM12 5v17"/>',
  workflows: '<circle cx="4" cy="12" r="2.25"/><circle cx="12" cy="12" r="2.25"/><circle cx="20" cy="12" r="2.25"/><path d="M6.25 12h3.5M14.25 12h3.5"/>',
  agents: '<circle cx="10" cy="9" r="3"/><path d="M4 20c.4-4 2.4-6 6-6s5.6 2 6 6m2-16 .7 1.6 1.8.4-1.8.5L18 8l-.7-1.5-1.8-.5 1.8-.4z"/>',
  skills: '<path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.5 6.3-.9z"/>',
  instructions: '<path d="M4 5h16M4 12h16M4 19h11"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-2-15-4 18"/>',
  run: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  decisions: '<path d="m12 2 8 3.5v6c0 5-3.2 8.5-8 10.5-4.8-2-8-5.5-8-10.5v-6zM8.5 12l2.2 2.2 4.8-5"/>',
  ask: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M12 10v7M12 7h.01"/>',
  checkout: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  right: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  left: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  external: '<path d="M13 5h6v6m0-6-8 8m6 0v6H5V7h6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  collapse: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m8-11-3 3 3 3"/>',
  expand: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m5-11 3 3-3 3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.5 7M3 5v6h6m3-4v6l4 2"/>',
  attach: '<path d="m8 13 6.5-6.5a2 2 0 1 1 3 3L9 18a4 4 0 1 1-5.5-5.5l9-9"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name]}</svg>`;
}

const groups = [
  ['Workspace', [['home', 'Overview'], ['ask', 'Ask SFlow'], ['specs', 'Spec Studio'], ['stories', 'Stories']]],
  ['Toolkit', [['workflows', 'Workflows'], ['agents', 'Agents'], ['skills', 'Skills'], ['instructions', 'Instructions']]],
  ['Tools', [['code', 'Code Explainer'], ['decisions', 'Decisions'], ['run', 'Run & Test']]]
];
const pageLabels = Object.fromEntries([...groups.flatMap(([, pages]) => pages), ['spec', 'Spec Studio'], ['about', 'About']]);
export const pageLabel = page => pageLabels[page] ?? 'Overview';

export function navigation() {
  return groups.map(([group, pages]) => `<div class="nav-group"><p class="nav-group-label">${group}</p>
    ${pages.map(([id, label]) => `<a class="nav-link" href="#${id}" title="${label}" aria-label="${label}">${icon(id)}<span class="nav-label">${label}</span></a>`).join('')}</div>`).join('');
}

export function words(value, fallback = 'Not reported') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const display = value.trim();
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(display)
    ? display[0].toUpperCase() + display.slice(1).replaceAll(/[-_]/gu, ' ')
    : display;
}

export function date(value) {
  const when = value ? new Date(value) : null;
  return when && Number.isFinite(when.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(when) : 'Not recorded';
}

export function dataOf(value) {
  return value?.resultType === 'command-result' ? value.data : value;
}

export function details(value, label = 'Technical details') {
  return `<details class="diagnostics"><summary>${escape(label)}</summary><pre class="section-output">${escape(JSON.stringify(value, null, 2))}</pre></details>`;
}

export function tile(name, color = '') {
  return `<span class="tile-icon ${color}" aria-hidden="true">${icon(name)}</span>`;
}

export function pill(label, tone = '') {
  return `<span class="pill ${tone}">${escape(label)}</span>`;
}

export function empty(title, description, action = '', symbol = 'specs') {
  return `<section class="card empty">${tile(symbol)}<h2>${escape(title)}</h2><p>${escape(description)}</p>${action}</section>`;
}

export function heading(title, description = '', actions = '') {
  return `<header class="page-heading"><div><h1>${escape(title)}</h1>${description ? `<p>${escape(description)}</p>` : ''}</div>
    ${actions ? `<div class="heading-actions">${actions}</div>` : ''}</header>`;
}

export function loading(message) {
  return `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${escape(message)}</div>`;
}

export function errorView(error, { retry = true, title = 'Couldn’t load this view' } = {}) {
  return `<section class="error" role="alert"><h2>${escape(title)}</h2><p>${escape(error.message)}</p>
    ${error.code ? `<small>${escape(error.code)}</small>` : ''}
    ${error.details ? details(error.details, 'Original SFlow details') : ''}
    ${retry ? '<button data-action="retry">Try again</button>' : ''}</section>`;
}

export const newButton = () => `<button class="primary" data-action="create">${icon('add')} New specification</button>`;
export const backToSpecs = () => `<a class="back-link" href="#specs">${icon('left')} Spec Studio</a>`;
export function specHref(specId, published = false) {
  return `#spec/${encodeURIComponent(specId)}${published ? '/published' : ''}`;
}

function quickLink(href, name, title, description, color = '') {
  return `<a class="quick-link" href="${escape(href)}">${tile(name, color)}<span><strong>${escape(title)}</strong><small>${escape(description)}</small></span>${icon('right')}</a>`;
}

export function overviewView(context, recent) {
  return heading('Workspace overview', 'Specifications, Stories and checks for your selected checkout.')
    + `<section class="hero" aria-labelledby="workspace-hero">
      <div class="hero-copy">
        <h2 id="workspace-hero">Start with an idea</h2>
        <p>Draft a business need or technical solution. Add sources and check the draft as you go.</p>
        <div class="actions">${newButton()}<a class="text-link" href="#specs">Browse Spec Studio ${icon('right')}</a></div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="hero-sheet back"><span></span><span></span><span></span><span></span></div>
        <div class="hero-sheet front"><span></span><span></span><span></span><span></span></div>
        <div class="hero-node one"></div><div class="hero-node two"></div>
      </div>
    </section>
    <div class="home-grid">
      <section class="card home-panel">
        <h2>Quick access</h2>
        <div class="quick-list">
          ${quickLink('#stories', 'stories', 'Browse Stories', 'Find work by title, creator or repository.', 'blue')}
          ${quickLink('#code', 'code', 'Explore code', 'Follow calls, changes and their Story requirements.', 'blue')}
          ${quickLink('#decisions', 'decisions', 'Review decisions', 'See what needs a decision in this checkout.', 'gold')}
          ${quickLink('#run', 'run', 'Run & Test', 'See application plans and the latest test results.', 'mint')}
        </div>
      </section>
      <section class="card home-panel">
        <h2>Selected checkout</h2>
        <div class="checkout-info">${tile('checkout', 'mint')}<div><h3>${escape(context.label)}</h3><span class="checkout-path">${escape(context.root)}</span></div></div>
        <button data-action="choose-checkout">Switch checkout ${icon('down')}</button>
        ${recent ? `<div class="home-recent">${quickLink(specHref(recent.specId, recent.published), 'history', 'Continue in Spec Studio', recent.title ?? recent.specId)}</div>`
          : '<p class="feature-note">Switching checkout changes this tab.</p>'}
      </section>
    </div>`;
}

export function searchField(id, label, placeholder) {
  return `<div class="search-field">${icon('search')}<input type="search" class="search" id="${id}" aria-label="${escape(label)}" placeholder="${escape(placeholder)}"></div>`;
}

export const searchText = value => value.trim().toLocaleLowerCase();

export function table(label, className, columns, rows) {
  return `<div class="table-wrap ${className}" role="region" aria-label="${escape(label)}" tabindex="0"><table aria-label="${escape(label)}">
    <thead><tr>${columns.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

export function catalogCard(page, entry) {
  const id = entry.id ?? entry.workflowId;
  const name = entry.label ?? entry.title ?? entry.name ?? id ?? 'Catalog entry';
  const source = typeof entry.source === 'string' ? entry.source : entry.scope;
  const description = entry.description ?? entry.purpose ?? entry.summary;
  return `<article class="card catalog-card">
    <div class="section-heading catalog-card-head">${tile(page)}${typeof source === 'string' ? pill(words(source)) : ''}</div>
    <h3>${escape(name)}</h3>${description ? `<p>${escape(description)}</p>` : ''}
    ${id && id !== name ? `<small class="identifier">${escape(id)}</small>` : ''}
  </article>`;
}

export function historyView(value) {
  if (!value.versions?.length) return '<p>No saved versions are available.</p>';
  return value.versions.map(version => `<div class="history-entry"><strong>Version ${escape(version.sequence)}</strong>
    <small>${escape(date(version.savedAt))}</small>${escape(version.title ?? '')}</div>`).join('');
}

export const runPanels = [
  ['app.plan', 'Application plan'], ['app.status', 'Application status'],
  ['tests.plan', 'Test plan'], ['tests.summary', 'Latest test results']
];

function argvDisplay(argv) {
  if (!Array.isArray(argv) || !argv.length) return '';
  return `<code class="command-view">${escape(argv.map(item => /\s/u.test(item) ? JSON.stringify(item) : item).join(' '))}</code>`;
}

function runEntries(entries, message, render) {
  if (!Array.isArray(entries)) return '<p>SFlow returned a result without a list of entries.</p>';
  return entries.length ? entries.map(render).join('') : `<p>${escape(message)}</p>`;
}

function plannedEntry(entry) {
  const location = [entry.repository, entry.workingDirectory].filter(Boolean).join(' / ');
  return `<div class="run-item"><h3>${escape(entry.name ?? entry.label ?? entry.id ?? 'Command')}</h3>
    ${location ? `<small>${escape(location)}</small>` : ''}${argvDisplay(entry.argv)}</div>`;
}

function testSummary(value) {
  if (!value.run) return '<p>No retained test run has been reported for this checkout.</p>';
  const totals = ['passed', 'failed', 'skipped'].filter(key => Number.isFinite(value.totals?.[key]));
  return `<p>${escape(value.run.label ?? value.run.id ?? 'Retained test run')}</p>
    ${totals.length ? `<div class="test-counts" aria-label="Reported test counts">${totals.map(key => `<span><strong>${value.totals[key]}</strong> ${key}</span>`).join('')}</div>` : ''}
    ${Array.isArray(value.commands) ? value.commands.map(command => `<div class="run-item section-heading"><h3>${escape(command.label ?? command.id ?? 'Test command')}</h3>
      ${pill(words(command.status), command.status === 'passed' ? 'success' : command.status === 'failed' ? 'failure' : '')}</div>`).join('') : ''}`;
}

export function runView(name, raw) {
  const value = dataOf(raw) ?? {};
  let body;
  if (name === 'app.plan') body = runEntries(value.entries, 'No application start command is configured for this checkout.', plannedEntry);
  if (name === 'app.status') body = runEntries(value.entries, 'No configured applications to check.', entry => {
    const status = entry.ready === true ? 'Ready' : entry.started === true ? 'Started · not ready' : entry.started === false ? 'Not started' : 'Not reported';
    return `<div class="run-item"><div class="section-heading"><h3>${escape(entry.name ?? entry.id ?? 'Application')}</h3>
      ${pill(status, entry.ready === true ? 'success' : entry.started === true ? 'attention' : '')}</div>
      ${entry.url ? `<small>${escape(entry.url)}</small>` : ''}</div>`;
  });
  if (name === 'tests.plan') body = (value.stopped?.words ? `<p class="subtle-note">${escape(value.stopped.words)}</p>` : '')
    + runEntries(value.commands, 'No test commands were reported for this checkout.', plannedEntry);
  if (name === 'tests.summary') body = testSummary(value);
  return body + details(raw);
}

function decisionCard(item) {
  const title = item.plain?.question ?? item.title ?? 'Decision';
  const reason = item.plain?.why ?? item.why;
  const option = item.plain?.recommended;
  return `<article class="card decision-card">
    <h3>${escape(title)}</h3>${reason ? `<p>${escape(reason)}</p>` : ''}
    ${option ? `<p class="answer-detail">${escape(option)}</p>` : ''}
    ${item.decidedBy?.words ? `<small>${escape(item.decidedBy.words)}</small>` : ''}
    ${item.plain?.settled ? `<small>${escape(item.plain.settled)}</small>` : ''}
  </article>`;
}

function decisionGroup(title, items) {
  return items?.length ? `<section class="decision-group"><h2>${title}</h2><div class="decision-list">${items.map(decisionCard).join('')}</div></section>` : '';
}

export function decisionView(raw) {
  const value = dataOf(raw);
  if (!Array.isArray(value?.items)) {
    return empty('Decision list unavailable', 'SFlow returned an unexpected result for this checkout.', '', 'decisions') + details(raw);
  }
  const headline = value.plain?.headline ?? value.headline;
  const context = [value.workId, value.phaseLabel ?? (value.phase ? words(value.phase) : null)].filter(Boolean).join(' · ');
  const next = value.next ?? value.storyNext;
  return `<section class="card decision-summary"><h2>${escape(headline ?? (value.items.length ? 'Decisions to review' : 'Nothing to decide'))}</h2>
    ${context ? `<p class="muted">${escape(context)}</p>` : ''}</section>
    ${decisionGroup('Needs a decision', value.items)}${decisionGroup('Other options', value.offered)}${decisionGroup('Settled', value.settled)}
    ${value.plain?.later?.length ? `<div class="feature-note"><h2>Waiting</h2><ul>${value.plain.later.map(item => `<li>${escape(item)}</li>`).join('')}</ul></div>` : ''}
    ${next?.command || next?.copilotCommand || next?.modelFreeCommand ? `<details class="diagnostics"><summary>Next action</summary>
      <dl class="properties">${[['Copilot', next.copilotCommand], ['Shell', next.command], ['VS Code (model-free)', next.modelFreeCommand]]
        .filter(([, command]) => command).map(([label, command]) => `<dt>${label}</dt><dd><code>${escape(command)}</code></dd>`).join('')}</dl></details>` : ''}
    ${details(raw)}`;
}

export function markdown(source) {
  // A deliberately small, escaped renderer: source HTML, remote images and scripts never execute.
  let list = false, code = false;
  const inline = line => escape(line).replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>').replace(/`([^`]+)`/gu, '<code>$1</code>');
  const out = [];
  for (const line of source.split('\n')) {
    if (line.startsWith('```')) { if (list) { out.push('</ul>'); list = false; } out.push(code ? '</code></pre>' : '<pre><code>'); code = !code; continue; }
    if (code) { out.push(`${escape(line)}\n`); continue; }
    const bullet = /^\s*[-*]\s+(.*)$/u.exec(line);
    if (bullet) { if (!list) out.push('<ul>'); list = true; out.push(`<li>${inline(bullet[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const header = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (header) out.push(`<h${header[1].length}>${inline(header[2])}</h${header[1].length}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>'); if (code) out.push('</code></pre>');
  return `<div class="prose">${out.join('')}</div>`;
}

export function draftView(specId, title, value, capabilities) {
  return backToSpecs() + `
    <header class="page-heading editor-heading">
      <div>
        <h1 class="sr-only">Specification draft</h1>
        <input class="editor-name" id="draft-title" maxlength="240" aria-label="Specification name" value="${escape(title)}">
        <div class="editor-meta">${pill('Local draft', 'attention')}${value.kind ? pill(words(value.kind)) : ''}
          <span class="identifier">${escape(specId)}</span></div>
      </div>
      <div class="heading-actions">
        <span class="save-state" id="save-state" role="status">All changes saved · version ${escape(value.sequence)}</span>
        <button class="primary" id="save-draft">Save changes</button>
      </div>
    </header>
    <section class="card read-compare" id="compare-result" aria-label="Latest saved version" hidden></section>
    <div class="editor-layout">
      <section class="card editor-paper" aria-label="Specification editor">
        <div class="editor-toolbar">
          <div class="editor-format" role="group" aria-label="Formatting">
            <button data-insert="heading">Heading</button>
            <button data-insert="bold"><strong>Bold</strong></button>
            <button data-insert="bullet">List</button>
          </div>
          <div class="segmented" role="group" aria-label="Editor view">
            <button id="write-mode" aria-controls="draft-content" aria-pressed="true">Write</button>
            <button id="preview-mode" aria-controls="draft-preview" aria-pressed="false">Preview</button>
          </div>
        </div>
        <textarea id="draft-content" aria-label="Specification content" spellcheck="true">${escape(value.spec)}</textarea>
        <article class="draft-preview" id="draft-preview" hidden></article>
        <footer class="editor-footer"><span>Markdown · Save with ⌘/Ctrl+S</span><span id="word-count"></span></footer>
      </section>
      <aside class="editor-side" aria-label="Draft tools">
        <section class="card support-card">
          <h2>Draft tools</h2>
          <div class="segmented" role="group" aria-label="Draft tools view">
            <button data-inspector="sources" aria-pressed="true" aria-controls="sources-panel">Sources</button>
            <button data-inspector="checks" aria-pressed="false" aria-controls="checks-panel">Checks</button>
            <button data-inspector="history" aria-pressed="false" aria-controls="history-panel">History</button>
          </div>
          <div class="inspector-panel" id="sources-panel">
            <p>Attach a document or image, up to 5 MiB. Originals stay on this computer.</p>
            <div class="actions"><button id="attach-draft">${icon('attach')} Attach file</button><button id="sources-draft">View sources</button></div>
            <input type="file" id="source-upload" hidden>
            <div id="support-result" class="result-block"></div>
          </div>
          <div class="inspector-panel" id="checks-panel" hidden>
            <p>Check the saved draft for missing details before review.</p>
            <button id="check-draft">${icon('check')} Check draft</button><div id="check-result" class="result-block" aria-live="polite"></div>
          </div>
          <div class="inspector-panel" id="history-panel" hidden>
            <button id="history-draft">${icon('history')} Saved versions</button><div id="history-result" class="result-block" aria-live="polite"></div>
          </div>
        </section>
        ${copilotCard(capabilities)}
      </aside>
    </div>`;
}

function copilotCard({ copilot, nativeMenus }) {
  return `<section class="card support-card copilot-card">
    <div class="section-heading">${tile('skills')}<h2>Work with Copilot</h2></div>
    <p>${copilot ? 'Prepare a request in the connected VS Code window. You choose when to send it.'
      : 'Open this workspace from VS Code to use Copilot.'}</p>
    ${copilot ? `<button id="ask-copilot">Continue with Copilot ${icon('external')}</button>` : ''}
    ${nativeMenus ? `<button id="native-spec">Review in VS Code ${icon('external')}</button>` : ''}
  </section>`;
}

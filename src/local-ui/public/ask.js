import { askHistoryDisplay } from './ask-history-display.js';
import { ASK_HINT, askSuggestions } from './ask-navigation.js';
import { escape, heading, icon, markdown, words } from './views.js';

const routes = new Set(['home', 'specs', 'stories', 'workflows', 'agents', 'skills', 'instructions', 'code', 'run', 'decisions', 'about']);
const chip = (text, key, value) => `<button type="button" class="button" data-${key}="${escape(value)}">${escape(text)}</button>`;

function historyView(value) {
  const display = askHistoryDisplay(value);
  if (!display) return '';
  const { title, summary, rows, patch } = display;
  const next = value.continuation;
  return `<section class="card ask-answer">
    <h2>${escape(title)}</h2>
    <ul class="ask-history-scope">${summary.map(detail => `<li>${escape(detail)}</li>`).join('')}</ul>
    ${rows.length ? `<ol class="ask-history-rows">${rows.map(row =>
      `<li><strong>${escape(row.label)}</strong><small>${escape(row.detail)}</small></li>`).join('')}</ol>` : ''}
    ${patch?.text ? `<details><summary>View patch</summary><pre class="section-output">${escape(patch.text)}</pre></details>` : ''}
    ${patch?.status === 'binary' ? '<p class="muted">Binary files have no text patch.</p>' : ''}
    ${next?.selection ? chip(next.behavior === 'retry' ? 'Retry this page' : 'Next page', 'continue', next.selection) : ''}
  </section>`;
}

function answerView(value) {
  const { work, help, artifact, diagnostics = [], specifications = [], choices = [], items = [], candidates = [] } = value;
  if (artifact) return `<article class="card ask-answer">
    <h2>${escape(artifact.title)}</h2><p class="muted">${escape(artifact.reference)} · ${escape(words(artifact.reviewState))}</p>
    <div class="draft-preview">${markdown(artifact.content)}</div>
    <details><summary>View source Markdown</summary><pre class="section-output">${escape(artifact.content)}</pre></details>
  </article>`;
  return `${work ? `<section class="card ask-answer"><h2>${escape(work.title)}</h2>
    <p>${escape(work.id)} · ${escape(work.phaseLabel ?? 'No active phase')} · ${escape(words(work.status ?? work.workStatus))}</p>
    ${work.blockers?.length ? `<h3>Blockers</h3><ul>${work.blockers.map(item => `<li>${escape(words(item))}</li>`).join('')}</ul>` : ''}
    ${work.kind === 'story' ? chip('Open the spec used for this Story', 'query', 'spec used for story ' + work.id) : ''}
  </section>` : ''}
  ${specifications.length ? `<section class="card ask-answer"><h2>Specifications</h2><div class="ask-actions">${specifications.map(item =>
    chip(`Open ${item.reference} · ${item.title}`, 'selection', item.selection)).join('')}</div></section>` : ''}
  ${help ? `<article class="card ask-answer"><h2>${escape(help.title)}</h2>${markdown(help.text)}
    <p class="muted">${escape(help.citation)}</p>${help.truncated ? `<p>Read the full topic in a terminal with <code>singularity-flow show ${escape(help.handle)}</code>.</p>` : ''}</article>` : ''}
  ${items.length ? `<section class="card ask-answer"><h2>Destinations</h2><div class="ask-actions">${items.filter(item => routes.has(item.id) || item.id === 'help').map(item =>
    chip(item.label, item.id === 'help' ? 'query' : 'route', item.id === 'help' ? item.topic : item.id)).join('')}</div></section>` : ''}
  ${choices.length || candidates.length ? `<section class="card ask-answer"><h2>Choose what to look up</h2><div class="ask-actions">${choices.map(item =>
    chip(item.id + ' · ' + words(item.kind), 'query', item.kind + ' ' + item.id)).join('')}${candidates.map(item => chip(item.title, 'query', item.id)).join('')}</div></section>` : ''}
  ${historyView(value)}
  ${diagnostics.map(item => `<p class="card ask-answer" role="status">${escape(item.message)}</p>`).join('')}
  ${value.status === 'empty' && !value.coverage && !diagnostics.length ? '<p class="muted">Enter a screen name, a work question, or a specification ID.</p>' : ''}`;
}

export function mountAsk(root, { checkout, navigate, read }) {
  root.innerHTML = heading('Ask SFlow', ASK_HINT + '.') + `<section class="card ask-search">
    <form id="ask-form">
      <label for="ask-question">Ask a question</label>
      <div class="ask-input-row"><input id="ask-question" type="search" maxlength="2000" autocomplete="off"
        placeholder="Where do I write a specification?" aria-controls="ask-suggestions"><button type="submit" class="primary">Ask</button></div>
      ${checkout ? `<p class="muted ask-scope">Checkout · ${escape(checkout)}</p>` : ''}
    </form>
    <ul id="ask-suggestions" aria-label="Suggested destinations"></ul>
  </section>
  <div id="ask-status" role="status" class="muted"></div>
  <section id="ask-answer" aria-label="Answer"></section>`;
  const field = root.querySelector('#ask-question');
  const suggestions = root.querySelector('#ask-suggestions');
  const answer = root.querySelector('#ask-answer');
  const status = root.querySelector('#ask-status');
  let pending = false;

  function draw() {
    const items = askSuggestions(field.value, new Set([...routes, 'help']));
    suggestions.hidden = items.length === 0;
    suggestions.innerHTML = items.map(item => `<li><button type="button" data-${item.id === 'help' ? 'query' : 'route'}="${escape(item.id === 'help' ? item.topic : item.id)}">
      <span>${escape(item.label)}<small>${escape(item.detail)}</small></span>${icon('right')}</button></li>`).join('');
  }

  async function show(input) {
    if (pending) return;
    pending = true;
    status.textContent = 'Reading…';
    try {
      const result = await read(input);
      if (!result || !answer.isConnected) return;
      answer.innerHTML = answerView(result);
      status.textContent = result.kind === 'artifact' ? 'Specification opened.' : 'Answer ready.';
    } catch (error) {
      if (status.isConnected) status.textContent = error.message;
    } finally {
      pending = false;
    }
  }

  function submit(query) {
    const value = query.trim();
    if (!value) return;
    field.value = value;
    suggestions.hidden = true;
    void show({ interaction: 'submit', query: value });
  }

  function interact(event) {
    const action = event.target.closest('button');
    if (!action) return;
    const { query, route, selection, continue: continuation } = action.dataset;
    if (query) submit(query);
    else if (routes.has(route)) navigate(route);
    else if (selection) void show({ interaction: 'activate', selection });
    else if (continuation) void show({ interaction: 'continue', selection: continuation });
  }

  field.addEventListener('input', draw);
  root.querySelector('#ask-form').addEventListener('submit', event => { event.preventDefault(); submit(field.value); });
  suggestions.addEventListener('click', interact);
  answer.addEventListener('click', interact);
  field.addEventListener('keydown', event => {
    if (event.key === 'Escape') { suggestions.hidden = true; return; }
    if (event.key === 'ArrowDown') {
      draw();
      if (suggestions.querySelector('button')) { event.preventDefault(); suggestions.querySelector('button').focus(); }
    }
  });
  suggestions.addEventListener('keydown', event => {
    const button = event.target.closest('li');
    if (event.key === 'ArrowDown' && button?.nextElementSibling) button.nextElementSibling.querySelector('button').focus();
    else if (event.key === 'ArrowUp') (button?.previousElementSibling?.querySelector('button') ?? field).focus();
    else if (event.key === 'Escape') { suggestions.hidden = true; field.focus(); }
    else return;
    event.preventDefault();
  });
  draw();
  field.focus();
}

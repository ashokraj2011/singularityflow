import { askHistoryDisplay } from './ask-history-display.js';
import { ASK_HINT, askSuggestions } from './ask-navigation.js';
import { escape, heading, icon, markdown, words } from './views.js';

const routes = new Set(['home', 'specs', 'stories', 'workflows', 'agents', 'skills', 'instructions', 'code', 'run', 'decisions', 'about']);
const chip = (text, key, value) => `<button type="button" class="button" data-${key}="${escape(value)}">${escape(text)}</button>`;

const evidenceChip = id => id ? chip('View evidence', 'evidence', id) : '';

function taskForm(evidence, supporting) {
  return `<details class="ask-task"><summary>Prepare a task from this evidence</summary>
    <form id="ask-task-form" data-target="${escape(evidence.id)}">
      <label for="ask-task-words">What should the task do?</label><textarea id="ask-task-words" name="words" rows="3" maxlength="2000" required></textarea>
      <label for="ask-task-kind">Task type</label><select id="ask-task-kind" name="kind">
        <option value="change">Change</option><option value="fix">Fix</option><option value="feature">Feature</option>
        <option value="investigate">Investigation</option><option value="review">Review</option><option value="docs">Documentation</option>
        <option value="tests">Tests</option><option value="refactor">Refactor</option><option value="chore">Chore</option></select>
      ${evidence.specification ? '<label for="ask-task-clauses">Clause IDs (optional)</label><input id="ask-task-clauses" name="clauses" type="text" placeholder="REQ-001, AC-001" maxlength="2000">' : ''}
      ${supporting.length ? `<fieldset><legend>Supporting evidence</legend>${supporting.map(({ id, label }) =>
        `<label><input type="checkbox" name="evidence" value="${escape(id)}"> ${escape(label)}</label>`).join('')}</fieldset>` : ''}
      <button type="submit" class="primary">Review task plan</button>
    </form></details>`;
}

function taskView(value) {
  const buttons = value.actions.filter(action => ['inspect', 'start'].includes(action.id));
  const routes = value.actions.filter(action => !buttons.includes(action));
  return `<section class="card ask-answer"><h2>${value.workId ? 'Task ' + escape(value.workId) : 'Task plan'}</h2>
    <p>${escape(value.message)}</p><p>${escape(value.intent)}</p><p class="muted">${escape(value.plan)}</p>
    ${value.specification ? `<p><strong>${escape(value.specification.reference)}</strong> · ${escape(value.specification.clauseIds.join(', ') || 'Whole revision')}</p>` : ''}
    <details><summary>${value.evidence.length} evidence ${value.evidence.length === 1 ? 'link' : 'links'}</summary><ul>
      ${value.evidence.map(({ ref }) => `<li>${escape(ref.reference ?? ref.workId ?? ref.path ?? ref.commit ?? ref.topic ?? ref.kind)}</li>`).join('')}</ul></details>
    ${value.diagnostic ? `<p role="status">${escape(value.diagnostic.message)}</p>` : ''}
    <div class="ask-actions">${buttons.map(action => chip(action.label, 'task-action', action.id)).join('')}</div>
    ${routes.map(action => `<p>${escape(action.label)} <code>${escape(action.command)}</code></p>`).join('')}</section>`;
}

function evidenceView(evidence, supporting, canPrepare) {
  const fields = Object.entries(evidence.details ?? {}).filter(([, value]) => value != null);
  return `<article class="card ask-answer">
    <h2>${escape(evidence.title)}</h2>
    <p class="muted">${[evidence.locator, evidence.revision].filter(Boolean).map(escape).join(' · ')}</p>
    ${fields.length ? `<dl>${fields.map(([key, value]) => `<dt>${escape(words(key))}</dt><dd>${escape(value)}</dd>`).join('')}</dl>` : ''}
    ${evidence.content ? `<div class="draft-preview">${markdown(evidence.content)}</div>` : ''}
    ${canPrepare && (!evidence.specification || evidence.specification.reviewState === 'reviewed') ? taskForm(evidence, supporting) : ''}
  </article>`;
}

function evidenceOptions(answer) {
  return [answer.work, ...(answer.specifications ?? []), answer.help, ...(askHistoryDisplay(answer)?.rows ?? [])]
    .filter(item => item?.evidenceId).map(item => ({ id: item.evidenceId, label: item.title ?? item.label ?? item.reference }));
}

function explanationView(data) {
  return `<section class="card ask-answer">
    <h2>${data.status === 'copilot-assisted' ? 'Copilot-organized explanation' : 'Explanation from recorded evidence'}</h2>
    ${data.statements.length ? `<ul>${data.statements.map(item =>
      `<li>${escape(item.text)} ${evidenceChip(item.evidenceId)}</li>`).join('')}</ul>` : '<p>There is no verified evidence available for an explanation.</p>'}
  </section>`;
}

function historyView(value) {
  const display = askHistoryDisplay(value);
  if (!display) return '';
  const { title, summary, rows, patch } = display;
  const next = value.continuation;
  return `<section class="card ask-answer">
    <h2>${escape(title)}</h2>
    <ul class="ask-history-scope">${summary.map(detail => `<li>${escape(detail)}</li>`).join('')}</ul>
    ${rows.length ? `<ol class="ask-history-rows">${rows.map(row =>
      `<li><strong>${escape(row.label)}</strong><small>${escape(row.detail)}</small>${evidenceChip(row.evidenceId)}</li>`).join('')}</ol>` : ''}
    ${patch?.text ? `<details><summary>View patch</summary><pre class="section-output">${escape(patch.text)}</pre></details>` : ''}
    ${patch?.status === 'binary' ? '<p class="muted">Binary files have no text patch.</p>' : ''}
    ${value.conversation?.hasMore ? chip('Next page', 'query', 'next page') : next?.selection ? chip(next.behavior === 'retry' ? 'Retry this page' : 'Next page', 'continue', next.selection) : ''}
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
    ${evidenceChip(work.evidenceId)}
    ${work.kind === 'story' ? chip('Open the spec used for this Story', 'query', work.evidenceId
      ? 'show the specification behind the first result' : 'spec used for story ' + work.id) : ''}
  </section>` : ''}
  ${specifications.length ? `<section class="card ask-answer"><h2>Specifications</h2><div class="ask-actions">${specifications.map(item =>
    chip(`Open ${item.reference} · ${item.title}`, item.evidenceId ? 'evidence' : 'selection', item.evidenceId ?? item.selection)).join('')}</div></section>` : ''}
  ${help ? `<article class="card ask-answer"><h2>${escape(help.title)}</h2>${evidenceChip(help.evidenceId)}${markdown(help.text)}
    <p class="muted">${escape(help.citation)}</p>${help.truncated ? `<p>Read the full topic in a terminal with <code>singularity-flow show ${escape(help.handle)}</code>.</p>` : ''}</article>` : ''}
  ${items.length ? `<section class="card ask-answer"><h2>Destinations</h2><div class="ask-actions">${items.filter(item => routes.has(item.id) || item.id === 'help').map(item =>
    chip(item.label, item.id === 'help' ? 'query' : 'route', item.id === 'help' ? item.topic : item.id)).join('')}</div></section>` : ''}
  ${choices.length || candidates.length ? `<section class="card ask-answer"><h2>Choose what to look up</h2><div class="ask-actions">${choices.map(item =>
    chip(item.id + ' · ' + words(item.kind), item.selection ? 'choice' : 'query', item.selection ?? item.kind + ' ' + item.id)).join('')}${candidates.map(item => chip(item.title, item.selection ? 'choice' : 'query', item.selection ?? item.id)).join('')}</div></section>` : ''}
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
  <div id="ask-conversation" class="ask-actions" aria-label="Conversation"></div>
  <div id="ask-status" role="status" class="muted"></div>
  <section id="ask-answer" aria-label="Answer"></section>
  <section id="ask-evidence" aria-label="Evidence and explanation"></section>
  <section id="ask-task" aria-label="Task handoff"></section>`;
  const field = root.querySelector('#ask-question');
  const suggestions = root.querySelector('#ask-suggestions');
  const answer = root.querySelector('#ask-answer');
  const detail = root.querySelector('#ask-evidence');
  const taskPanel = root.querySelector('#ask-task');
  const actions = root.querySelector('#ask-conversation');
  const status = root.querySelector('#ask-status');
  let pending = false;
  let conversation = null;
  let activeTask = null;
  let supporting = [];

  function sessionActions() {
    if (!checkout) return;
    const items = [chip('Resume saved conversation', 'conversation-action', 'resume')];
    if (conversation) {
      items.unshift(chip('New conversation', 'conversation-action', 'new'));
      if (conversation.canExplain) items.push(chip('Explain with Copilot', 'conversation-action', 'explain'));
      if (conversation.taskAdmissionId) items.push(chip('Open task handoff', 'task-action', 'inspect'));
      items.push(chip('Forget conversation', 'conversation-action', 'forget'));
    }
    actions.innerHTML = items.join('');
  }
  const scope = () => conversation ? { conversationId: conversation.id, revision: conversation.revision } : {};

  function draw() {
    const items = askSuggestions(field.value, new Set([...routes, 'help']));
    suggestions.hidden = items.length === 0;
    suggestions.innerHTML = items.map(item => `<li><button type="button" data-${item.id === 'help' ? 'query' : 'route'}="${escape(item.id === 'help' ? item.topic : item.id)}">
      <span>${escape(item.label)}<small>${escape(item.detail)}</small></span>${icon('right')}</button></li>`).join('');
  }

  async function show(input) {
    if (pending) return;
    pending = true;
    status.textContent = ({ 'task-start': 'Starting the task…', 'task-prepare': 'Checking the task plan…' })[input.interaction] ?? 'Reading…';
    try {
      const result = await read(input);
      if (!result || !answer.isConnected) return;
      if (result.resultType === 'sflow-task-handoff') {
        activeTask = result.id;
        conversation = { ...conversation, ...result.conversation, taskAdmissionId: activeTask };
        sessionActions();
        taskPanel.innerHTML = taskView(result);
        taskPanel.scrollIntoView({ block: 'nearest' });
        status.textContent = result.message;
        return;
      }
      if (result.conversation) conversation = result.conversation;
      if (result.kind === 'forgotten' || result.status === 'conflict') conversation = null;
      sessionActions();
      if (result.evidence || result.explanation) {
        detail.innerHTML = result.evidence ? evidenceView(result.evidence, supporting.filter(item => item.id !== result.evidence.id), Boolean(conversation))
          : explanationView(result.explanation);
        detail.querySelector('h2')?.scrollIntoView({ block: 'nearest' });
      } else {
        detail.innerHTML = '';
        supporting = evidenceOptions(result);
        answer.innerHTML = result.kind === 'forgotten' ? '' : answerView(result);
        if (!conversation || activeTask !== conversation.taskAdmissionId) {
          taskPanel.innerHTML = '';
          activeTask = null;
        }
      }
      status.textContent = result.kind === 'forgotten' ? 'Saved conversation removed.'
        : result.kind === 'artifact' ? 'Specification opened.' : 'Answer ready.';
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
    void show({ interaction: 'submit', query: value, ...(conversation ? scope() : checkout ? { remember: true } : {}) });
  }

  function interact(event) {
    const action = event.target.closest('button');
    if (!action) return;
    const { query, route, selection, continue: continuation, evidence, choice, conversationAction, taskAction } = action.dataset;
    if (pending) return;
    if (taskAction && conversation?.taskAdmissionId) {
      void show({ interaction: taskAction === 'start' ? 'task-start' : 'task-status', admissionId: conversation.taskAdmissionId });
      return;
    }
    if (conversationAction === 'new') {
      conversation = null;
      answer.innerHTML = detail.innerHTML = status.textContent = '';
      taskPanel.innerHTML = '';
      activeTask = null;
      supporting = [];
      field.value = '';
      sessionActions();
      draw();
      field.focus();
      return;
    }
    if (conversationAction === 'resume') { void show({ interaction: 'resume' }); return; }
    if (conversationAction && conversation) {
      if (conversationAction !== 'forget' || globalThis.confirm('Forget this private Ask conversation?')) {
        void show({ interaction: conversationAction, ...scope() });
      }
      return;
    }
    if ((evidence || choice) && conversation) {
      void show({ interaction: evidence ? 'evidence' : 'select', target: evidence ?? choice, ...scope() });
      return;
    }
    if (query) submit(query);
    else if (routes.has(route)) navigate(route);
    else if (selection) void show({ interaction: 'activate', selection });
    else if (continuation) void show({ interaction: 'continue', selection: continuation });
  }

  field.addEventListener('input', draw);
  root.querySelector('#ask-form').addEventListener('submit', event => { event.preventDefault(); submit(field.value); });
  suggestions.addEventListener('click', interact);
  answer.addEventListener('click', interact);
  detail.addEventListener('click', interact);
  detail.addEventListener('submit', event => {
    if (event.target.id !== 'ask-task-form') return;
    event.preventDefault();
    if (pending || !conversation) return;
    const form = new FormData(event.target);
    const clauses = String(form.get('clauses') ?? '').split(/[\s,]+/u).filter(Boolean);
    void show({ interaction: 'task-prepare', ...scope(), target: event.target.dataset.target,
      words: form.get('words'), kind: form.get('kind'), clauses, evidence: form.getAll('evidence') });
  });
  taskPanel.addEventListener('click', interact);
  actions.addEventListener('click', interact);
  sessionActions();
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

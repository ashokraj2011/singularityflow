import { askHistoryDisplay } from './ask-history-display.js';
import { askSuggestions } from './ask-navigation.js';
import { escape, icon, markdown, words } from './views.js';
import { chatLogView, searchFileView, searchResultsView } from './ask-results.js';

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
  const visible = [answer.work, ...(answer.specifications ?? []), answer.help, ...(askHistoryDisplay(answer)?.rows ?? []),
    ...(answer.savedResults ?? []).filter(row => row.availability === 'available')];
  return [...new Map(visible.filter(item => item?.evidenceId).map(item => [item.evidenceId, item])).values()]
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
  ${value.task?.workId && !value.task.id ? `<section class="card ask-answer"><h2>Task ${escape(value.task.workId)}</h2>
    <p>${[value.task.workStatus ?? value.task.status, value.task.phase].filter(Boolean).map(escape).join(' · ')}</p></section>` : ''}
  ${historyView(value)}
  ${value.savedResults?.length ? `<section class="card ask-answer"><h2>Saved results</h2><ol class="ask-history-rows">
    ${value.savedResults.map(row => `<li>${row.availability === 'available'
      ? escape(row.title) + ' ' + evidenceChip(row.evidenceId)
      : row.availability === 'local-only' ? 'Available on the original device' : 'Unavailable in this checkout'}</li>`).join('')}</ol></section>` : ''}
  ${diagnostics.map(item => `<p class="card ask-answer" role="status">${escape(item.message)}</p>`).join('')}
  ${value.status === 'empty' && !value.coverage && !diagnostics.length ? '<p class="muted">Enter a screen name, a work question, or a specification ID.</p>' : ''}`;
}

export function mountAsk(root, { checkout, navigate, read }) {
  root.innerHTML = `<div class="ask-page" data-mode="search">
    <header class="ask-hero">
      <div class="segmented ask-modes" role="group" aria-label="Search or chat">
        <button type="button" data-ask-mode="search" aria-pressed="true">${icon('search')} Search</button>
        <button type="button" data-ask-mode="chat" aria-pressed="false">${icon('chat')} Chat</button>
      </div>
      <h1 id="ask-title">What are you looking for?</h1>
      <p id="ask-scope-description">Search your workspace and SFlow Help.</p>
    </header>
    <section id="ask-chat" aria-label="Chat conversation" role="log" hidden></section>
    <section class="ask-search">
      <form id="ask-form">
        <label for="ask-question" class="sr-only">Ask a question</label>
        <div class="ask-input-row"><span id="ask-input-icon">${icon('search')}</span><input id="ask-question" type="search" maxlength="2000" autocomplete="off"
          placeholder="Search a Story, specification, or file…" aria-controls="ask-suggestions">
          <textarea id="ask-chat-question" aria-label="Ask a question" placeholder="Ask Copilot anything…" maxlength="2000" rows="2" hidden></textarea>
          <button id="ask-submit" type="submit" class="primary">Search ${icon('right')}</button></div>
        <ul id="ask-suggestions" aria-label="Suggested destinations" hidden></ul>
        <div id="ask-search-options" class="ask-options">
          ${checkout ? `<span class="ask-scope">${icon('checkout')} <span>${escape(checkout)}</span></span>
            <label><input id="ask-portable" type="checkbox"> Save across devices</label>` : ''}
        </div>
        <div id="ask-chat-options" class="ask-options" hidden>
          <label><input id="ask-workspace" type="checkbox"> Use workspace context</label>
          <button type="button" class="quiet" data-chat-action="reset">${icon('add')} New chat</button>
          <button type="button" class="quiet" id="ask-cancel" hidden>Cancel reply</button>
        </div>
      </form>
      <div class="ask-starters" id="ask-search-starters" role="group" aria-label="Suggested searches">
        <button type="button" data-query="current story">${icon('stories')} Current Story</button>
        <button type="button" data-query="commits last week">${icon('history')} Recent commits</button>
        <button type="button" data-query="story-lifecycle">${icon('about')} Publishing help</button>
      </div>
      <div class="ask-starters" id="ask-chat-starters" role="group" aria-label="Suggested prompts" hidden>
        <button type="button" data-prompt="Explain ">${icon('specs')} Explain a concept</button>
        <button type="button" data-prompt="Help me compare ">${icon('workflows')} Compare options</button>
        <button type="button" data-prompt="Help me plan ">${icon('check')} Plan an approach</button>
      </div>
    </section>
    <div id="ask-conversation" class="ask-actions" aria-label="Conversation"></div>
    <div id="ask-status" role="status" class="muted"></div>
    <section id="ask-answer" aria-label="Answer"></section>
    <section id="ask-evidence" aria-label="Evidence and explanation"></section>
    <section id="ask-task" aria-label="Task handoff"></section>
  </div>`;
  const $ = selector => root.querySelector(selector);
  const page = $('.ask-page');
  const searchField = $('#ask-question');
  const chatField = $('#ask-chat-question');
  let field = searchField;
  const portable = $('#ask-portable');
  const workspace = $('#ask-workspace');
  const suggestions = $('#ask-suggestions');
  const answer = $('#ask-answer');
  const detail = $('#ask-evidence');
  const taskPanel = $('#ask-task');
  const actions = $('#ask-conversation');
  const status = $('#ask-status');
  const chatLog = $('#ask-chat');
  const send = $('#ask-submit');
  const cancel = $('#ask-cancel');
  const searchStarters = $('#ask-search-starters');
  const chatStarters = $('#ask-chat-starters');
  const modeButtons = [...$('.ask-modes').querySelectorAll('button')];
  const drafts = { search: '', chat: '' };
  let mode = 'search';
  let chatTurns = [];
  let searchResult = null;
  let pending = false;
  let controller = null;
  let conversation = null;
  let conflict = null;
  let activeTask = null;
  let supporting = [];

  function sessionActions() {
    if (!checkout) return;
    const items = [chip('Resume saved conversation', 'conversation-action', 'resume'),
      chip('Resume across devices', 'conversation-action', 'resume-shared')];
    if (conflict) items.unshift(chip('Resume latest version', 'conversation-action', 'resume-conflict'));
    portable.disabled = Boolean(conversation);
    if (conversation) portable.checked = conversation.portability === 'shared-provider';
    if (conversation) {
      items.unshift(chip('New conversation', 'conversation-action', 'new'));
      if (conversation.canExplain) items.push(chip('Explain with Copilot', 'conversation-action', 'explain'));
      if (conversation.taskAdmissionId) items.push(chip('Open task handoff', 'task-action', 'inspect'));
      items.push(chip('Forget conversation', 'conversation-action', 'forget'));
    }
    actions.innerHTML = items.join('');
  }
  const scope = () => conversation ? { conversationId: conversation.id, revision: conversation.revision } : {};

  function updateSubmit() {
    send.disabled = pending || !field.value.trim();
  }

  function draw() {
    updateSubmit();
    const items = askSuggestions(field.value, new Set([...routes, 'help']));
    suggestions.hidden = mode !== 'search' || !field.value.trim() || items.length === 0;
    suggestions.innerHTML = items.map(item => `<li><button type="button" data-${item.id === 'help' ? 'query' : 'route'}="${escape(item.id === 'help' ? item.topic : item.id)}">
      <span>${escape(item.label)}<small>${escape(item.detail)}</small></span>${icon('right')}</button></li>`).join('');
  }

  function changeMode(next, question = null) {
    const leaving = mode;
    const previousText = field.value;
    drafts[mode] = previousText;
    mode = next;
    page.dataset.mode = next;
    const chatting = next === 'chat';
    searchField.hidden = chatting;
    chatField.hidden = !chatting;
    field = chatting ? chatField : searchField;
    field.value = question ?? (drafts[mode] || previousText);
    $('#ask-input-icon').innerHTML = icon(chatting ? 'chat' : 'search');
    $('#ask-title').textContent = chatting ? 'How can I help?' : 'What are you looking for?';
    $('#ask-scope-description').hidden = searchStarters.hidden = chatting;
    send.innerHTML = (chatting ? 'Send ' : 'Search ') + icon('right');
    $('#ask-search-options').hidden = actions.hidden = answer.hidden = taskPanel.hidden = chatting;
    $('#ask-chat-options').hidden = chatLog.hidden = chatStarters.hidden = !chatting;
    for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.askMode === next));
    if (leaving !== next) { status.textContent = ''; detail.replaceChildren(); }
    suggestions.hidden = true;
    updateSubmit();
    field.focus();
    if (chatting && leaving !== next) void show({ interaction: 'chat-history' });
  }

  async function show(input) {
    if (pending) return;
    pending = true;
    const chatting = input.interaction === 'chat';
    controller = chatting ? new AbortController() : null;
    send.disabled = true;
    for (const button of modeButtons) button.disabled = true;
    cancel.hidden = !chatting;
    status.textContent = ({ 'task-start': 'Starting the task…', 'task-prepare': 'Checking the task plan…',
      chat: 'Copilot is replying…', 'chat-history': '', 'chat-reset': '' })[input.interaction] ?? 'Reading…';
    try {
      const result = await read(input, { signal: controller?.signal });
      if (!result || !answer.isConnected) return;
      if (result.kind === 'chat-history' || result.kind === 'chat') {
        if (result.kind === 'chat-history') {
          chatTurns = result.turns;
          if (input.interaction === 'chat-reset') { field.value = ''; drafts.chat = ''; detail.replaceChildren(); }
        } else {
          if (result.status !== 'resolved') { status.textContent = result.diagnostic?.message ?? 'Copilot did not answer.'; return; }
          chatTurns = [...chatTurns, result].slice(-4);
          if (field.value.trim() === input.query) field.value = '';
          drafts.chat = field.value;
          detail.replaceChildren();
        }
        chatLog.innerHTML = chatLogView(chatTurns);
        status.textContent = result.kind === 'chat' ? 'Reply ready.' : '';
        if (result.kind === 'chat') { field.focus(); field.scrollIntoView({ block: 'nearest' }); }
        return;
      }
      if (result.kind === 'search-file' || result.artifact && (mode === 'chat' || searchResult)) {
        detail.innerHTML = result.file ? searchFileView(result.file) : answerView(result);
        detail.querySelector('h2')?.scrollIntoView({ block: 'nearest' });
        status.textContent = result.file || result.artifact ? 'Source opened.' : 'Source unavailable.';
        return;
      }
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
      conflict = result.status === 'conflict' ? result.currentConversation ?? null : null;
      if (['forgotten', 'workspace-search'].includes(result.kind) || result.kind === 'conversation' && !result.conversation) conversation = null;
      sessionActions();
      if (result.evidence || result.explanation) {
        detail.innerHTML = result.evidence ? evidenceView(result.evidence, supporting.filter(item => item.id !== result.evidence.id), Boolean(conversation && !conversation.taskAvailability))
          : explanationView(result.explanation);
        detail.querySelector('h2')?.scrollIntoView({ block: 'nearest' });
      } else {
        detail.innerHTML = '';
        supporting = evidenceOptions(result);
        searchResult = result.kind === 'workspace-search' ? result : null;
        answer.innerHTML = searchResult ? searchResultsView(searchResult) : result.kind === 'forgotten' ? '' : answerView(result);
        if (!conversation || activeTask !== conversation.taskAdmissionId) {
          taskPanel.innerHTML = '';
          activeTask = null;
        }
      }
      status.textContent = result.kind === 'forgotten' ? 'Saved conversation removed.'
        : result.kind === 'artifact' ? 'Specification opened.'
        : result.status === 'conflict' ? 'Conversation updated. Resume its latest version.' : 'Answer ready.';
    } catch (error) {
      if (status.isConnected) status.textContent = controller?.signal.aborted ? 'Reply cancelled.' : error.message;
    } finally {
      controller = null;
      pending = false;
      updateSubmit();
      cancel.hidden = true;
      for (const button of modeButtons) button.disabled = false;
    }
  }

  function submit(query) {
    const value = query.trim();
    if (!value) return;
    field.value = value;
    suggestions.hidden = true;
    if (mode === 'chat') { void show({ interaction: 'chat', query: value, workspace: workspace.checked }); return; }
    void show({ interaction: 'submit', query: value, workspaceSearch: true,
      ...(conversation ? scope() : checkout ? { remember: true, ...(portable.checked ? { portable: true } : {}) } : {}) });
  }

  function interact(event) {
    const action = event.target.closest('button');
    if (!action) return;
    const { query, prompt, route, selection, file, continue: continuation, evidence, choice, conversationAction, taskAction,
      resultFilter, askMode, chatAction } = action.dataset;
    if (pending) return;
    if (askMode) {
      if (action.hasAttribute('data-discuss-results')) workspace.checked = true;
      changeMode(askMode, action.closest('#ask-answer') ? field.value : null);
      return;
    }
    if (chatAction === 'reset') { void show({ interaction: 'chat-reset' }); return; }
    if (prompt) {
      field.value = prompt;
      field.focus();
      field.setSelectionRange(prompt.length, prompt.length);
      updateSubmit();
      return;
    }
    if (resultFilter && searchResult) {
      answer.innerHTML = searchResultsView(searchResult, resultFilter);
      answer.querySelector(`[data-result-filter="${resultFilter}"]`).focus();
      return;
    }
    if (taskAction && conversation?.taskAdmissionId) {
      void show({ interaction: taskAction === 'start' ? 'task-start' : 'task-status', admissionId: conversation.taskAdmissionId });
      return;
    }
    if (conversationAction === 'new') {
      conversation = null;
      conflict = null;
      portable.checked = false;
      searchResult = null;
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
    if (conversationAction === 'resume' || conversationAction === 'resume-shared' || conversationAction === 'resume-conflict') {
      void show({ interaction: 'resume', ...(conversationAction === 'resume-shared' ? { portable: true } : {}),
        ...(conversationAction === 'resume-conflict' ? { conversationId: conflict?.conversationId } : {}) });
      return;
    }
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
    if (query) {
      if (mode === 'chat') changeMode('search', query);
      if (searchStarters.contains(action)) field.focus();
      submit(query);
    }
    else if (routes.has(route)) navigate(route);
    else if (file) void show({ interaction: 'open-file', selection: file });
    else if (selection) void show({ interaction: 'activate', selection });
    else if (continuation) void show({ interaction: 'continue', selection: continuation });
  }

  searchField.addEventListener('input', draw);
  chatField.addEventListener('input', updateSubmit);
  chatField.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(chatField.value); }
  });
  root.querySelector('#ask-form').addEventListener('submit', event => { event.preventDefault(); submit(field.value); });
  suggestions.addEventListener('click', interact);
  searchStarters.addEventListener('click', interact);
  chatStarters.addEventListener('click', interact);
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
  chatLog.addEventListener('click', interact);
  $('#ask-chat-options').addEventListener('click', interact);
  $('.ask-modes').addEventListener('click', interact);
  cancel.onclick = () => controller?.abort();
  sessionActions();
  searchField.addEventListener('keydown', event => {
    if (event.key === 'Escape') { suggestions.hidden = true; return; }
    if (event.key === 'ArrowDown' && mode === 'search') {
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

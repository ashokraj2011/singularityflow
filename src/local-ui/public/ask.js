import { askHistoryDisplay } from './ask-history-display.js';
import { askSuggestions } from './ask-navigation.js';
import { askIntent, askSavedReference } from './ask-query.js';
import { escape, icon, markdown, words } from './views.js';
import { chatLogView, searchFileView, searchResultsView } from './ask-results.js';

const routes = new Set(['home', 'specs', 'stories', 'workflows', 'agents', 'skills', 'instructions', 'code', 'run', 'decisions', 'about']);
const chip = (text, key, value) => `<button type="button" class="button" data-${key}="${escape(value)}">${escape(text)}</button>`;

const evidenceChip = id => id ? chip('View evidence', 'evidence', id) : '';

const storyQuestions = [
  ['stories', 'Where does this Story stand?'],
  ['decisions', 'What needs a decision?'],
  ['run', 'What tests ran?'],
  ['code', 'What changed?']
];

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

export function mountAsk(root, { context, issue, navigate, read, preparedQuestion = null }) {
  const story = issue ? null : context.story;
  const checkout = issue || context.engine && !story ? null : context.label;
  const limit = 8;
  root.innerHTML = `<div class="ask-page">
    <header class="ask-hero">
      <div><h1>Ask SFlow</h1><p>${story ? 'Ask about your Story, then follow up in the same conversation.'
        : 'Ask a question, or search for work, files, and SFlow help.'}</p></div>
      <button class="button" type="button" data-chat-action="reset">${icon('add')} New chat</button>
    </header>
    <div class="ask-context">
      <span class="tile-icon">${icon(story ? 'stories' : 'checkout')}</span>
      <div><strong>${escape(story?.title || story?.workId || checkout || 'No Story selected')}</strong>
        ${story ? `<small>${escape([story.workId, story.repositoryId, story.workspaceName].filter(Boolean).join(' · '))}</small>` : ''}
        ${issue ? `<small>${escape(issue)}</small>` : ''}
      </div>
      ${checkout ? '<button class="quiet" type="button" data-action="choose-checkout">Change checkout</button>'
        : `<a class="text-link" href="#stories">Browse Stories ${icon('right')}</a>`}
    </div>
    ${checkout ? `<details class="ask-saved"><summary>Saved searches</summary>
      <label><input id="ask-portable" type="checkbox"> Save across devices</label>
      <div id="ask-conversation" class="ask-actions" aria-label="Saved search actions"></div>
    </details>` : ''}
    <section id="ask-chat" aria-label="Chat conversation" role="log" aria-relevant="additions text"></section>
    <div id="ask-standalone"><section id="ask-answer" aria-label="Search answer"></section></div>
    <section id="ask-evidence" aria-label="Evidence and explanation"></section>
    <section id="ask-task" aria-label="Task handoff"></section>
    <div class="ask-starters" role="group" aria-label="${story ? 'Questions about this Story' : 'Suggested questions'}">
      ${story ? storyQuestions.map(([glyph, question]) => `<button type="button" data-chat-query="${escape(question)}">${icon(glyph)} ${escape(question)}</button>`).join('')
        : `${checkout ? `<button type="button" data-query="commits last week">${icon('history')} Recent commits</button>` : ''}
          <button type="button" data-query="story-lifecycle">${icon('about')} Publishing help</button>`}
    </div>
    <section class="ask-composer card">
      <div id="ask-status" role="status" class="muted"></div>
      <form id="ask-form">
        <label for="ask-question" class="sr-only">Ask a question</label>
        <div class="ask-input-row">
          <textarea id="ask-question" autocomplete="off" maxlength="2000" rows="2" aria-controls="ask-suggestions"
            aria-describedby="ask-send-note" placeholder="${story ? 'Ask about this Story…' : 'Ask a question or search…'}"></textarea>
          <div class="ask-send-actions">
            <button id="ask-search" type="submit" class="button">${icon('search')} Search</button>
            <button id="ask-submit" type="submit" class="primary">Send ${icon('right')}</button>
          </div>
        </div>
        <div class="ask-options">
          ${checkout ? `<label><input id="ask-workspace" type="checkbox"> Include ${story ? 'Story and workspace' : 'workspace'} context</label>` : ''}
          <span id="ask-send-note">Open-ended questions use Copilot.</span>
          <button type="button" class="quiet" id="ask-cancel" hidden>Cancel reply</button>
        </div>
        <ul id="ask-suggestions" aria-label="Suggested destinations" hidden></ul>
      </form>
    </section>
  </div>`;
  const $ = selector => root.querySelector(selector);
  const field = $('#ask-question');
  const portable = $('#ask-portable');
  const workspace = $('#ask-workspace');
  const suggestions = $('#ask-suggestions');
  const answer = $('#ask-answer');
  const detail = $('#ask-evidence');
  const taskPanel = $('#ask-task');
  const actions = $('#ask-conversation');
  const status = $('#ask-status');
  const chatLog = $('#ask-chat');
  const starters = $('.ask-starters');
  const send = $('#ask-submit');
  const search = $('#ask-search');
  const cancel = $('#ask-cancel');
  let turns = [];
  let searchId = null;
  let searchResult = null;
  let pending = false;
  let controller = null;
  let conversation = null;
  let conflict = null;
  let activeTask = null;
  let supporting = [];

  function sessionActions() {
    if (!actions) return;
    const items = [chip('Resume saved conversation', 'conversation-action', 'resume'),
      chip('Resume across devices', 'conversation-action', 'resume-shared')];
    if (conflict) items.unshift(chip('Resume latest version', 'conversation-action', 'resume-conflict'));
    portable.disabled = Boolean(conversation);
    if (conversation) {
      portable.checked = conversation.portability === 'shared-provider';
      if (conversation.canExplain) items.push(chip('Explain with Copilot', 'conversation-action', 'explain'));
      if (conversation.taskAdmissionId) items.push(chip('Open task handoff', 'task-action', 'inspect'));
      items.push(chip('Forget conversation', 'conversation-action', 'forget'));
    }
    actions.innerHTML = items.join('');
  }
  const conversationScope = () => conversation ? { conversationId: conversation.id, revision: conversation.revision } : {};

  function updateSubmit() {
    send.disabled = search.disabled = pending || !field.value.trim();
  }

  function drawSuggestions() {
    updateSubmit();
    const items = askSuggestions(field.value, new Set([...routes, 'help']));
    suggestions.hidden = !field.value.trim() || items.length === 0;
    suggestions.innerHTML = items.map(item => `<li><button type="button" data-${item.id === 'help' ? 'query' : 'route'}="${escape(item.id === 'help' ? item.topic : item.id)}">
      <span>${escape(item.label)}<small>${escape(item.detail)}</small></span>${icon('right')}</button></li>`).join('');
  }

  function drawTurns() {
    $('#ask-standalone').append(answer);
    chatLog.innerHTML = chatLogView(turns, searchId);
    chatLog.querySelector('#ask-search-result')?.append(answer);
    starters.hidden = turns.length > 0;
  }

  async function show(input) {
    if (pending) return;
    pending = true;
    const chatting = input.interaction === 'chat';
    controller = chatting ? new AbortController() : null;
    updateSubmit();
    cancel.hidden = !chatting;
    status.textContent = ({ 'task-start': 'Starting the task…', 'task-prepare': 'Checking the task plan…',
      chat: 'Finding an answer…', 'chat-reset': '' })[input.interaction] ?? 'Reading…';
    try {
      await historyReady;
      if (!answer.isConnected) return;
      const result = await read(input, { signal: controller?.signal });
      if (!result || !answer.isConnected) return;
      if (result.turn) {
        turns = [...turns, result.turn].slice(-limit);
        if (input.interaction === 'submit' && !result.evidence) searchId = result.turn.id;
        if (field.value.trim() === input.query) field.value = '';
        detail.replaceChildren();
        drawTurns();
      }
      if (result.kind === 'chat-history') {
        turns = result.turns;
        if (input.interaction === 'chat-reset') {
          searchId = searchResult = conversation = conflict = activeTask = null;
          supporting = [];
          field.value = '';
          if (workspace) workspace.checked = false;
          if (portable) portable.checked = false;
          for (const panel of [answer, detail, taskPanel]) panel.replaceChildren();
          sessionActions();
        }
        drawTurns();
        return;
      }
      if (result.kind === 'chat') {
        status.textContent = result.status === 'resolved' ? '' : result.diagnostic?.message ?? 'Copilot did not answer. Try Search for recorded work.';
        if (result.status === 'resolved') chatLog.lastElementChild?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (result.kind === 'search-file' || input.interaction === 'activate') {
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
        detail.replaceChildren();
        supporting = evidenceOptions(result);
        searchResult = result.kind === 'workspace-search' ? result : null;
        answer.innerHTML = searchResult ? searchResultsView(searchResult) : result.kind === 'forgotten' ? '' : answerView(result);
        if (!conversation || activeTask !== conversation.taskAdmissionId) {
          taskPanel.replaceChildren();
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
    }
  }

  function submit(query, searchOnly = false) {
    const value = query.trim();
    if (!value || pending) return;
    field.value = value;
    suggestions.hidden = true;
    const intent = askIntent(value);
    const lookup = ['spec', 'work-history', 'commits', 'comparison'].includes(intent.kind) || intent.workId
      || (!story && ['work', 'story-spec'].includes(intent.kind)) || (conversation && askSavedReference(value));
    if (!searchOnly && !lookup) {
      void show({ interaction: 'chat', query: value, workspace: Boolean(workspace?.checked) });
      return;
    }
    void show({ interaction: 'submit', query: value, ...(checkout ? { workspaceSearch: true } : {}),
      ...(conversation ? conversationScope() : checkout ? { remember: true, ...(portable.checked ? { portable: true } : {}) } : {}) });
  }

  function interact(event) {
    const action = event.target.closest('button');
    if (!action || pending) return;
    const { query, chatQuery, prompt, route, selection, file, continue: continuation, evidence, choice, conversationAction,
      taskAction, resultFilter, chatAction } = action.dataset;
    if (chatAction === 'reset') { void show({ interaction: 'chat-reset' }); return; }
    if (prompt !== undefined) {
      if (action.hasAttribute('data-use-context') && workspace) workspace.checked = true;
      field.value = prompt || turns.find(turn => turn.id === searchId)?.question || '';
      field.focus();
      drawSuggestions();
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
    if (conversationAction === 'resume' || conversationAction === 'resume-shared' || conversationAction === 'resume-conflict') {
      void show({ interaction: 'resume', ...(conversationAction === 'resume-shared' ? { portable: true } : {}),
        ...(conversationAction === 'resume-conflict' ? { conversationId: conflict?.conversationId } : {}) });
      return;
    }
    if (conversationAction && conversation) {
      if (conversationAction !== 'forget' || globalThis.confirm('Forget this saved search conversation?')) {
        void show({ interaction: conversationAction, ...conversationScope() });
      }
      return;
    }
    if ((evidence || choice) && conversation) {
      void show({ interaction: evidence ? 'evidence' : 'select', target: evidence ?? choice, ...conversationScope() });
      return;
    }
    if (query || chatQuery) submit(query || chatQuery, Boolean(query));
    else if (routes.has(route)) navigate(route);
    else if (file) void show({ interaction: 'open-file', selection: file });
    else if (selection) void show({ interaction: 'activate', selection });
    else if (continuation) void show({ interaction: 'continue', selection: continuation });
  }

  field.addEventListener('input', drawSuggestions);
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit(field.value);
    } else if (event.key === 'Escape') {
      suggestions.hidden = true;
    } else if (event.key === 'ArrowDown' && !suggestions.hidden) {
      const first = suggestions.querySelector('button');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  $('#ask-form').addEventListener('submit', event => {
    event.preventDefault();
    submit(field.value, event.submitter === search);
  });
  $('.ask-page').addEventListener('click', interact);
  detail.addEventListener('submit', event => {
    if (event.target.id !== 'ask-task-form') return;
    event.preventDefault();
    if (pending || !conversation) return;
    const form = new FormData(event.target);
    const clauses = String(form.get('clauses') ?? '').split(/[\s,]+/u).filter(Boolean);
    void show({ interaction: 'task-prepare', ...conversationScope(), target: event.target.dataset.target,
      words: form.get('words'), kind: form.get('kind'), clauses, evidence: form.getAll('evidence') });
  });
  suggestions.addEventListener('keydown', event => {
    const item = event.target.closest('li');
    if (event.key === 'ArrowDown' && item?.nextElementSibling) item.nextElementSibling.querySelector('button').focus();
    else if (event.key === 'ArrowUp') (item?.previousElementSibling?.querySelector('button') ?? field).focus();
    else if (event.key === 'Escape') { suggestions.hidden = true; field.focus(); }
    else return;
    event.preventDefault();
  });
  cancel.onclick = () => controller?.abort();
  sessionActions();
  if (preparedQuestion) field.value = preparedQuestion;
  updateSubmit();
  field.focus({ preventScroll: true });
  const historyReady = read({ interaction: 'chat-history' }).then(result => {
    if (!result || !answer.isConnected) return;
    turns = result.turns;
    drawTurns();
  }).catch(error => {
    if (!pending && status.isConnected) status.textContent = error.message;
  });
  return () => controller?.abort();
}

/** Shared browser presentation. Operations and decisions remain SFlow-owned. No repository I/O. */
import {
  backToSpecs, catalogCard, dataOf, date, decisionView, details, draftView, empty, errorView, escape, heading,
  historyView, icon, loading, markdown, navigation, newButton, overviewView, pageLabel, pill, runPanels, runView,
  searchField, searchText, specHref, table, words
} from './views.js';

const $ = selector => document.querySelector(selector);
const state = {
  session: null, epoch: 0, page: 'home', draft: null, dirty: false, saving: false, creating: false,
  switching: false, uncertain: false, pendingSave: null, pendingCreation: null, pendingFork: null,
  activities: [], recentSpecs: new Map(), eventSequence: 0, objectUrls: [], focusAsk: false,
  disposeView: null, preparedQuestion: null
};
const preferences = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`sflow.view.${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`sflow.view.${key}`, JSON.stringify(value)); } catch { /* View preferences are optional. */ } }
};
let storyRefresh;

function setCollapsed(collapsed) {
  document.body.classList.toggle('collapsed', collapsed);
  const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
  const button = $('#collapse');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(!collapsed));
  $('#collapse-icon').innerHTML = icon(collapsed ? 'expand' : 'collapse');
}
setCollapsed(preferences.get('collapsed', false) === true);
$('#collapse').onclick = () => {
  const collapsed = !document.body.classList.contains('collapsed');
  setCollapsed(collapsed);
  preferences.set('collapsed', collapsed);
};

function navigationPanel(open, restoreFocus = true) {
  if (open && !$('#activity').hidden) activityPanel(false, false);
  document.body.classList.toggle('nav-open', open);
  $('#navigation-scrim').hidden = !open;
  $('.workspace').inert = open;
  $('#mobile-menu').setAttribute('aria-expanded', String(open));
  if (open) ($('#navigation [aria-current="page"]') ?? $('.brand')).focus();
  else if (restoreFocus) $('#mobile-menu').focus();
}
$('#mobile-menu').onclick = () => navigationPanel(true);
$('#navigation-scrim').onclick = () => navigationPanel(false);
$('#sidebar').addEventListener('click', event => {
  if (event.target.closest('a') && document.body.classList.contains('nav-open')) navigationPanel(false);
});
const mobileLayout = matchMedia('(max-width: 760px)');
mobileLayout.addEventListener('change', event => {
  if (!event.matches && document.body.classList.contains('nav-open')) navigationPanel(false, false);
});

function activityPanel(open, restoreFocus = true) {
  $('#activity').hidden = !open;
  $('#activity-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#activity-close').focus();
  else if (restoreFocus) $('#activity-toggle').focus();
}
$('#activity-toggle').onclick = () => activityPanel($('#activity').hidden);
$('#activity-close').onclick = () => activityPanel(false);
$('#banner-close').onclick = () => { banner(null); $('#main').focus({ preventScroll: true }); };
$('.skip').onclick = event => { event.preventDefault(); $('#main').focus(); };
$('#create-cancel').onclick = () => $('#create-dialog').close();
$('#context-cancel').onclick = () => $('#context-dialog').close();
$('#context-stories').onclick = () => $('#context-dialog').close();

function updateCheckout(context, followsActiveStory) {
  $('#context-name').textContent = context.engine && !context.story ? 'No Story selected' : context.label;
  $('#context-switch').title = context.root;
  $('#context-switch').setAttribute('aria-description', followsActiveStory ? 'Following the active Story' : 'Using the checkout selected in this tab');
}

function useContext(value) {
  const { context, capabilities, followsActiveStory, activeStoryIssue } = value;
  Object.assign(state.session, { context, capabilities, followsActiveStory, activeStoryIssue });
  updateCheckout(context, followsActiveStory);
}

async function refreshStoryContext() {
  const session = state.session;
  if (!session?.followsActiveStory || state.switching) return false;
  storyRefresh ??= api('/api/session?follow=1').then(value => {
    if (state.session !== session || !session.followsActiveStory || state.switching) return false;
    const changed = value.context.id !== session.context.id || value.activeStoryIssue !== session.activeStoryIssue;
    if (changed) { useContext(value); renderActivity(); }
    return changed;
  }).finally(() => { storyRefresh = null; });
  return storyRefresh;
}

async function followCodeView() {
  if (!state.session?.followsActiveStory || state.page !== 'code' || document.hidden) return;
  try {
    if (await refreshStoryContext() && state.page === 'code' && location.hash === '#code') await navigate();
  } catch { /* The connection status is handled by the workspace heartbeat. */ }
}

async function switchCheckout(input, button) {
  if (!dirtyGuard()) return;
  state.switching = true;
  button.disabled = true;
  $('#context-error').textContent = '';
  try {
    const result = await api('/api/contexts', { method: 'POST', data: input });
    const dialog = $('#context-dialog');
    if (dialog.open) dialog.close();
    state.draft = null;
    state.dirty = false;
    state.pendingSave = null;
    state.pendingFork = null;
    state.uncertain = false;
    useContext(result);
    renderActivity();
    state.switching = false;
    if (state.page === 'code' || location.hash === '#home') await navigate(); else go('home');
  } catch (error) {
    if ($('#context-dialog').open) $('#context-error').textContent = error.message;
    else banner(error.message);
  } finally {
    state.switching = false;
    button.disabled = false;
  }
}

$('#context-switch').onclick = async () => {
  const button = $('#context-switch');
  button.disabled = true;
  try {
    const result = await api('/api/contexts');
    $('#context-error').textContent = '';
    const follow = $('#context-follow');
    follow.textContent = result.followsActiveStory ? 'Refresh active Story' : 'Follow active Story';
    follow.onclick = () => switchCheckout({ followActiveStory: true }, follow);
    $('#context-choices').innerHTML = result.contexts.map(context => {
      const current = context.id === result.currentId;
      return `<button class="context-choice" data-known-context="${escape(context.id)}" ${current ? 'disabled' : ''}>
        <span><strong>${escape(context.label)}</strong><small>${escape(context.root)}</small></span>${current ? pill('Current', 'accent') : icon('right')}</button>`;
    }).join('');
    $('#context-dialog').showModal();
    document.querySelectorAll('[data-known-context]').forEach(choice => {
      choice.onclick = () => switchCheckout({ contextId: choice.dataset.knownContext }, choice);
    });
  } catch (error) { banner(error.message); }
  finally { button.disabled = !state.session; }
};

const activityLabels = {
  'spec.list': 'Open Spec Studio', 'spec.read': 'Read draft', 'spec.show': 'Read specification',
  'spec.create': 'Create specification', 'spec.save': 'Save draft', 'spec.fork': 'Copy draft',
  'spec.check': 'Check draft', 'spec.history': 'Read saved versions', 'spec.sources': 'List sources',
  'spec.source.read': 'Read source', 'spec.source.add': 'Attach source', 'story.list': 'List Stories',
  'workflow.list': 'List Workflows', 'agent.list': 'List Agents', 'skill.list': 'List Skills',
  'instruction.list': 'List Instructions', 'decision.list': 'Read decisions',
  'code.changes': 'Explain code changes', 'code.repository': 'Explore repository code', 'code.source': 'Open code excerpt',
  ...Object.fromEntries(runPanels)
};
function renderActivity() {
  const count = $('#activity-count');
  count.textContent = state.activities.length;
  count.hidden = state.activities.length === 0;
  $('#activity-items').innerHTML = state.activities.map(entry => {
    const specId = entry.result?.value?.specId;
    const canOpen = specId && entry.contextKey === state.session?.context.key;
    const tone = entry.state === 'succeeded' ? 'success' : entry.state === 'failed' ? 'failure' : 'attention';
    const status = entry.state === 'succeeded' ? 'Complete' : words(entry.state);
    return `<article class="activity-item"><div class="section-heading"><strong>${escape(activityLabels[entry.operation] ?? entry.operation)}</strong>${pill(status, tone)}</div>
      <small>${escape(entry.contextLabel)} · ${escape(date(entry.acceptedAt))}</small>
      ${entry.error ? `<p>${escape(entry.error.message)}</p>` : ''}
      ${canOpen ? `<p><a class="text-link" href="${specHref(specId, entry.operation === 'spec.show')}">Open specification ${icon('right')}</a></p>` : ''}
      <details><summary>Request ID</summary><code>${escape(entry.invocationId)}</code></details></article>`;
  }).join('') || '<p class="muted">Recent workspace activity will appear here.</p>';
}
function activity(item) {
  const previous = state.activities.findIndex(entry => entry.invocationId === item.invocationId);
  if (previous >= 0) state.activities[previous] = { ...state.activities[previous], ...item };
  else state.activities.unshift(item);
  state.activities.sort((a, b) => String(b.acceptedAt ?? '').localeCompare(String(a.acceptedAt ?? '')));
  state.activities = state.activities.slice(0, 64);
  renderActivity();
}

async function api(route, { method = 'GET', data, content, timeout = 15_000, signal = null } = {}) {
  const tabId = state.session?.tabId ?? sessionStorage.getItem('sflow.tab');
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(route, { method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { ...(data ? content === undefined ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/octet-stream', 'X-SFlow-Content': encodeURIComponent(JSON.stringify(data)) } : {}), ...(tabId ? { 'X-SFlow-Tab': tabId } : {}),
      ...(state.session?.csrf ? { 'X-SFlow-CSRF': state.session.csrf } : {}) }, ...(data ? { body: content === undefined ? JSON.stringify(data) : content } : {}) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message ?? 'The request failed.'); error.code = result.error?.code; error.details = result.error?.details; error.status = response.status; throw error; }
  return result;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function operation(name, input = {}, { invocationId = crypto.randomUUID(), contextId = state.session.context.id } = {}) {
  let receipt;
  try {
    const content = name === 'spec.source.add' ? input.file : ['spec.save', 'spec.fork'].includes(name) ? new Blob([input.content]) : undefined;
    const metadata = { ...input }; if (content !== undefined) { delete metadata.file; delete metadata.content; }
    receipt = await api(content === undefined ? '/api/operations' : '/api/content',
      { method: 'POST', data: { contextId, invocationId, operation: name, input: metadata }, content });
  }
  catch (error) {
    if (error.status) throw error;
    // A lost acceptance reply is inspected by its original ID, never re-sent.
    try { receipt = await api(`/api/requests/${invocationId}`); }
    catch {
      error.message = `The reply was lost. Inspect request ${invocationId} before repeating a save. Your text is still in this tab.`;
      error.code = 'UI_ACCEPTANCE_UNKNOWN'; throw error;
    }
  }
  return awaitOperation(invocationId, receipt);
}
async function awaitOperation(invocationId, receipt) {
  activity(receipt);
  const deadline = Date.now() + 6 * 60_000;
  while (['queued', 'running'].includes(receipt.state)) {
    if (Date.now() > deadline) { const error = new Error(`Request ${invocationId} is still running. Its wait ended; the operation was not repeated.`); error.code = 'UI_OUTCOME_UNKNOWN'; throw error; }
    await delay(400);
    try { receipt = await api(`/api/requests/${invocationId}`); activity(receipt); }
    catch (cause) { const error = new Error(`The wait for ${invocationId} was interrupted. Inspect its original receipt before repeating a save.`); error.code = 'UI_OUTCOME_UNKNOWN'; error.invocationId = invocationId; throw error; }
  }
  if (receipt.state !== 'succeeded') { const error = new Error(receipt.error?.message ?? 'The operation did not complete.'); Object.assign(error, receipt.error, { invocationId, outcome: receipt.state }); throw error; }
  return { ...receipt.result, contextKey: receipt.contextKey };
}
function setConnected(status, label) {
  $('#connection').dataset.status = status;
  $('#connection-text').textContent = label;
  $('#connection').title = label;
}
function banner(message) {
  $('#banner').hidden = !message;
  $('#banner-message').textContent = message ?? '';
}
function nativeButton(menu, label) {
  return state.session.capabilities.nativeMenus
    ? `<button data-native="${menu}">${escape(label)} ${icon('external')}</button>` : '';
}
function go(hash) { location.hash = hash; }
function focusAsk() {
  if (!state.session) return;
  const field = $('#ask-question:not([hidden]), #ask-chat-question:not([hidden])');
  if (state.page === 'ask' && field) { field.focus(); return; }
  state.focusAsk = true;
  go('ask');
}
$('#quick-ask').onclick = focusAsk;
function dirtyGuard() {
  if (state.saving || state.creating || state.switching) {
    banner('Wait for the current action to finish before switching views.');
    return false;
  }
  return !state.dirty || confirm('Leave this specification without saving your changes?');
}
async function editorHandoff(type, extra = {}) {
  try {
    const accepted = await api('/api/handoffs', { method: 'POST', data: { contextId: state.session.context.id, type, ...extra } });
    banner('Connecting to the matching VS Code window…');
    for (let count = 0; count < 25; count++) {
      await delay(600);
      const result = await api(`/api/handoffs/${accepted.id}`);
      if (!['queued', 'dispatched'].includes(result.state)) { banner(result.message); return; }
    }
    banner('The editor has not acknowledged this handoff. Check that window before trying again. No model execution was observed.');
  } catch (error) { banner(`${error.code ?? 'EDITOR UNAVAILABLE'}: ${error.message}`); }
}

function overview() {
  const { context } = state.session;
  const lastWrite = state.activities.find(entry => entry.contextKey === context.key && entry.state === 'succeeded'
    && ['spec.create', 'spec.save', 'spec.fork'].includes(entry.operation) && entry.result?.value?.specId);
  const recent = state.recentSpecs.get(context.key) ?? lastWrite?.result.value;
  $('#main').innerHTML = overviewView(context, recent);
}

async function library(epoch) {
  const { value } = await operation('spec.list');
  if (epoch !== state.epoch) return;
  const drafts = (value.drafts ?? []).map(entry => ({ ...entry, status: 'Local draft', version: `Version ${entry.sequence}`, type: 'draft' }));
  const shared = (value.specs ?? []).map(entry => ({
    specId: entry.specId, title: entry.latest.title, status: words(entry.latest.reviewState, 'Published'),
    version: `Revision ${entry.latest.revision}`, type: 'published'
  }));
  const entries = [...drafts, ...shared];
  $('#main').innerHTML = heading('Spec Studio', 'Start a specification, continue a draft or read a published revision.', newButton())
    + `<section class="card collection">
      <div class="toolbar">${searchField('spec-search', 'Find a specification', 'Search by title or ID…')}
        <div class="segmented" role="group" aria-label="Specification filter">
          <button data-spec-filter="all" aria-pressed="true">All</button><button data-spec-filter="draft" aria-pressed="false">Drafts</button>
          <button data-spec-filter="published" aria-pressed="false">Published</button>
        </div><span id="spec-count" class="results-count" role="status"></span>
      </div>
      <div id="spec-list"></div>
    </section>`
    + (value.unreadable?.length ? `<p class="feature-note subtle-note">Some entries couldn’t be read. Open Spec Studio in VS Code for recovery details. (${value.unreadable.length})</p>` : '')
    + (value.state?.status === 'not-fetched' ? '<p class="feature-note">Published specifications have not been fetched in this checkout. Local drafts are available.</p>' : '');
  let filter = 'all';
  const draw = () => {
    const query = searchText($('#spec-search').value);
    const visible = entries.filter(entry => (filter === 'all' || entry.type === filter)
      && searchText(`${entry.title ?? ''} ${entry.specId}`).includes(query));
    $('#spec-count').textContent = `${visible.length} ${visible.length === 1 ? 'specification' : 'specifications'}`;
    $('#spec-list').innerHTML = visible.length ? table('Specifications', 'spec-table',
      ['<th scope="col">Specification</th>', '<th scope="col">Status</th>', '<th scope="col">Version</th>', '<th scope="col"><span class="sr-only">Open</span></th>'],
      visible.map(entry => {
        const href = specHref(entry.specId, entry.type === 'published');
        const edit = entry.type === 'draft';
        return `<tr><td><a class="row-title" href="${href}">${escape(entry.title ?? 'Untitled specification')}</a>
          <small class="identifier">${escape(entry.specId)}</small></td>
          <td>${pill(entry.status, edit ? 'attention' : '')}</td><td>${escape(entry.version)}</td>
          <td><a class="text-link row-action" href="${href}" aria-label="${edit ? 'Edit' : 'Read'} ${escape(entry.title ?? entry.specId)}">${edit ? 'Edit' : 'Read'} ${icon('right')}</a></td></tr>`;
      }))
      : !entries.length && !query && filter === 'all'
        ? empty('No specifications yet', 'Create a draft when you have an idea you want to develop.', newButton())
        : empty('No matching specifications', 'Try a different search or filter.');
  };
  $('#spec-search').oninput = draw;
  document.querySelectorAll('[data-spec-filter]').forEach(button => {
    button.onclick = () => {
      filter = button.dataset.specFilter;
      document.querySelectorAll('[data-spec-filter]').forEach(control => control.setAttribute('aria-pressed', String(control === button)));
      draw();
    };
  });
  draw();
}
async function specification(specId, published, epoch) {
  const { value } = await operation(published ? 'spec.show' : 'spec.read', { specId });
  if (epoch !== state.epoch) return;
  const title = (published ? value.manifest?.title : value.title) ?? specId;
  state.recentSpecs.set(state.session.context.key, { specId, title, published });
  if (published) {
    $('#main').innerHTML = backToSpecs() + heading(title, `Published revision ${value.revision}`)
      + `<article class="card draft-preview">${markdown(value.spec ?? '')}</article>`;
    return;
  }
  state.draft = { ...value };
  state.dirty = false;
  state.uncertain = false;
  $('#main').innerHTML = draftView(specId, title, value, state.session.capabilities);

  const textarea = $('#draft-content');
  const wordCount = () => {
    const count = textarea.value.trim().split(/\s+/u).filter(Boolean).length;
    $('#word-count').textContent = `${count} ${count === 1 ? 'word' : 'words'}`;
  };
  const changed = () => {
    state.dirty = true;
    $('#save-state').textContent = 'Unsaved changes';
    wordCount();
  };
  textarea.oninput = changed;
  $('#draft-title').oninput = changed;
  wordCount();
  $('#save-draft').onclick = () => saveDraft();

  const formatButtons = [...document.querySelectorAll('[data-insert]')];
  const editorMode = preview => {
    const article = $('#draft-preview');
    if (preview) article.innerHTML = markdown(textarea.value);
    article.hidden = !preview;
    textarea.hidden = preview;
    $('#preview-mode').setAttribute('aria-pressed', String(preview));
    $('#write-mode').setAttribute('aria-pressed', String(!preview));
    formatButtons.forEach(button => { button.disabled = preview; });
  };
  $('#preview-mode').onclick = () => editorMode(true);
  $('#write-mode').onclick = () => { editorMode(false); textarea.focus(); };
  formatButtons.forEach(button => {
    button.onclick = () => {
      const start = textarea.selectionStart, end = textarea.selectionEnd, selected = textarea.value.slice(start, end);
      const formatted = { heading: `\n## ${selected || 'Heading'}\n`, bold: `**${selected || 'text'}**`, bullet: `\n- ${selected || 'Item'}\n` };
      textarea.setRangeText(formatted[button.dataset.insert], start, end, 'select');
      textarea.focus();
      changed();
    };
  });

  const inspector = [...document.querySelectorAll('[data-inspector]')];
  inspector.forEach(button => {
    button.onclick = () => {
      for (const tab of inspector) {
        tab.setAttribute('aria-pressed', String(tab === button));
        $(`#${tab.dataset.inspector}-panel`).hidden = tab !== button;
      }
    };
  });
  $('#check-draft').onclick = async () => {
    if (state.dirty && !await saveDraft()) return;
    await supportOperation('spec.check', $('#check-result'), $('#check-draft'));
  };
  $('#sources-draft').onclick = () => sources();
  $('#attach-draft').onclick = () => $('#source-upload').click();
  $('#source-upload').onchange = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void attachSource(file);
  };
  $('#history-draft').onclick = () => supportOperation('spec.history', $('#history-result'), $('#history-draft'));
  const assist = $('#ask-copilot');
  if (assist) assist.onclick = async () => {
    if (state.dirty && !await saveDraft()) return;
    await editorHandoff('spec.assist', { specId });
  };
  const publish = $('#native-spec');
  if (publish) publish.onclick = async () => {
    if (state.dirty && !await saveDraft()) return;
    await editorHandoff('native.menu', { menu: 'specs', specId });
  };
}

async function supportOperation(name, element, button) {
  element.innerHTML = loading('Reading saved draft…');
  button.disabled = true;
  try {
    const { value } = await operation(name, { specId: state.draft.specId });
    if (!document.contains(element)) return;
    if (name === 'spec.history') { element.innerHTML = historyView(value); return; }
    const report = value.report ?? value;
    const findings = report.blocking ?? [];
    const outcome = report.reviewReady === true ? 'Ready for review' : report.reviewReady === false ? 'Needs attention' : 'Check complete';
    element.innerHTML = `${pill(outcome, report.reviewReady ? 'success' : 'attention')}
      ${findings.length ? `<ul class="text-list">${findings.map(item => `<li>${escape(item.message ?? item.code)}</li>`).join('')}</ul>` : ''}
      ${typeof value.next === 'string' ? `<details class="diagnostics"><summary>Next action</summary><code class="command-view">${escape(value.next)}</code></details>` : ''}`;
  } catch (error) {
    if (document.contains(element)) element.innerHTML = errorView(error, {
      retry: false, title: name === 'spec.history' ? 'Saved versions unavailable' : 'Draft check unavailable'
    });
  } finally { button.disabled = false; }
}
async function sources() {
  const element = $('#support-result'); element.innerHTML = loading('Reading sources…');
  try {
    const { value } = await operation('spec.sources', { specId: state.draft.specId });
    if (!document.contains(element)) return;
    element.innerHTML = (value.sources ?? []).map(({ source }) => `<div class="source-entry"><strong>${escape(source.name)}</strong><small>${escape(source.type === 'file' ? 'Local file' : source.type)}</small><button data-source="${escape(source.id)}">Read source</button></div>`).join('') || '<p>No sources yet. Attach a document or image to give this idea more context.</p>';
    element.querySelectorAll('[data-source]').forEach(button => { button.onclick = () => { void readSource(button.dataset.source, element); }; });
  } catch (error) { if (document.contains(element)) element.innerHTML = errorView(error, { retry: false, title: 'Source unavailable' }); }
}
async function attachSource(file, restore = null) {
  if (file.size > 5 * 1024 * 1024) { banner('Choose a file up to 5 MiB for browser upload. Larger files can be attached in VS Code.'); return; }
  if (state.dirty && !await saveDraft()) return;
  const draft = state.draft, specId = draft.specId, button = $('#attach-draft');
  button.disabled = true;
  try {
    const { value } = await operation('spec.source.add', { specId, name: file.name, file, ...(restore ? { restore } : {}) });
    if (state.draft === draft) {
      draft.sequence = value.sequence ?? (await operation('spec.read', { specId })).value.sequence;
      if (state.draft !== draft) return;
      if (!state.dirty) $('#save-state').textContent = `All changes saved · version ${draft.sequence}`;
      await sources();
      if (state.draft === draft) banner('Source attached. The original stays on this computer.');
    }
  } catch (error) { banner(`${error.code ?? 'UPLOAD FAILED'}: ${error.message}`); }
  finally { if (document.contains(button)) button.disabled = false; }
}
async function readSource(sourceId, element) {
  try {
    const result = await operation('spec.source.read', { specId: state.draft.specId, sourceId });
    if (!document.contains(element)) return;
    const source = result.value.sources?.[0];
    if (source?.status === 'upload-required') {
      element.innerHTML = '<p>The original file is missing on this computer. Select the same file again to restore it; its fingerprint will be checked.</p><input type="file" id="restore-source" aria-label="Restore original file">';
      $('#restore-source').onchange = event => { const file = event.target.files?.[0]; if (file) void attachSource(file, sourceId); }; return;
    }
    const resource = result.resources?.[0];
    if (resource) {
      const response = await fetch(`/api/content/${resource.id}`, { headers: { 'X-SFlow-Tab': state.session.tabId } });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message ?? 'The original image could not be read.'); }
      const blob = await response.blob();
      if (!document.contains(element)) return;
      const url = URL.createObjectURL(blob);
      state.objectUrls.push(url);
      element.innerHTML = `<img class="source-preview" src="${url}" alt="${escape(source.source?.name ?? 'Attached image')}"><p class="muted">Original local image. Previewing is not acceptance or visual sign-off.</p>`;
    } else element.innerHTML = source?.text ? `<pre class="section-output">${escape(source.text)}</pre>${source.next ? '<p class="muted">This is a bounded excerpt. Read the full document through its native SFlow source route.</p>' : ''}` : `<p>${escape(source?.message ?? source?.reason ?? 'This file needs its native document viewer. Open its source in VS Code.')}</p>`;
  } catch (error) { if (document.contains(element)) element.innerHTML = errorView(error, { retry: false, title: 'Source unavailable' }); }
}
async function saveDraft() {
  if (state.saving || !state.draft) return false;
  if (state.uncertain) { banner('Inspect the previous save in Activity before saving again. Your unsaved text has been kept.'); return false; }
  state.saving = true; const button = $('#save-draft'); button.disabled = true;
  const content = $('#draft-content').value, title = $('#draft-title').value;
  const specId = state.draft.specId; $('#save-state').textContent = 'Saving…';
  try {
    const invocationId = crypto.randomUUID();
    state.pendingSave = { invocationId, content, title };
    const { value } = await operation('spec.save', { specId, sequence: state.draft.sequence, content, title }, { invocationId });
    state.draft.sequence = value.sequence;
    state.recentSpecs.set(state.session.context.key, { specId, title, published: false });
    state.dirty = $('#draft-content').value !== content || $('#draft-title').value !== title;
    $('#save-state').textContent = state.dirty ? 'New changes are waiting to be saved' : `All changes saved · version ${value.sequence}`;
    state.pendingSave = null;
    banner(null); return true;
  } catch (error) {
    state.uncertain = ['UI_ACCEPTANCE_UNKNOWN', 'UI_OUTCOME_UNKNOWN', 'UI_RECEIPT_WRITE_FAILED', 'UI_OPERATION_TIMEOUT', 'UI_RECEIPT_EXPIRED'].includes(error.code);
    if (['SPEC_DRAFT_STALE', 'SPEC_DRAFT_CONFLICT'].includes(error.code)) conflictActions();
    $('#save-state').textContent = 'Not saved · your text is still here'; banner(`${error.code ?? 'SAVE FAILED'}: ${error.message}`); return false;
  } finally {
    state.saving = false; button.disabled = false;
    if (state.uncertain && !$('#inspect-save')) {
      button.insertAdjacentHTML('beforebegin', '<button id="inspect-save">Check previous save</button>');
      $('#inspect-save').onclick = () => { void inspectSave(); };
    }
  }
}
async function inspectSave() {
  const pending = state.pendingSave;
  if (!pending || !state.draft) return;
  const button = $('#inspect-save'); button.disabled = true;
  try {
    const { value } = await operation('spec.read', { specId: state.draft.specId, operationId: `lws-${pending.invocationId}` });
    if (value.saveReceipt?.state !== 'recorded') {
      banner('The original save is not proved by a retained snapshot yet. Your writing is still here. Inspect Activity or the canonical draft/history in Spec Studio before trying another write.'); return;
    }
    if (value.sequence !== value.saveReceipt.sequence) {
      renderComparison(value, 'Your save completed before this newer version.');
      banner('The previous save succeeded. Newer writing also exists; your unsaved text was preserved.'); conflictActions(); return;
    }
    state.draft.sequence = value.sequence; state.uncertain = false; state.pendingSave = null;
    state.dirty = $('#draft-content').value !== pending.content || $('#draft-title').value !== pending.title;
    $('#save-state').textContent = state.dirty ? 'Previous save confirmed · newer changes waiting' : `All changes saved · version ${value.sequence}`;
    button.remove(); banner('Confirmed the original save from SFlow’s verified snapshot. The save was not repeated.');
  } catch (error) { banner(`${error.code ?? 'INSPECTION FAILED'}: ${error.message}`); }
  finally { if (document.contains(button)) button.disabled = false; }
}
function renderComparison(value, description) {
  const element = $('#compare-result');
  element.innerHTML = `<h2>Latest saved version · ${escape(value.sequence)}</h2>
    <p>${escape(description)} Your writing is still in the editor.</p><pre class="section-output">${escape(value.spec)}</pre>`;
  element.hidden = false;
}
function conflictActions() {
  if ($('#compare-draft')) return;
  $('#save-draft').insertAdjacentHTML('beforebegin', '<button id="compare-draft">Compare latest</button><button id="fork-draft">Save as another draft</button>');
  $('#compare-draft').onclick = async () => {
    const draft = state.draft;
    try {
      const { value } = await operation('spec.read', { specId: draft.specId });
      if (state.draft === draft) renderComparison(value, 'Compare the saved wording with the draft below.');
    }
    catch (error) { banner(error.message); }
  };
  $('#fork-draft').onclick = async () => {
    if (state.saving) return;
    const textarea = $('#draft-content'), title = $('#draft-title'), button = $('#fork-draft');
    state.saving = true; textarea.disabled = true; title.disabled = true; button.disabled = true;
    try {
      let result;
      if (state.pendingFork) result = await awaitOperation(state.pendingFork, await api(`/api/requests/${state.pendingFork}`));
      else {
        const invocationId = crypto.randomUUID(); state.pendingFork = invocationId;
        result = await operation('spec.fork', { specId: state.draft.specId, content: textarea.value }, { invocationId });
      }
      state.pendingFork = null; state.pendingSave = null; state.uncertain = false; state.dirty = false; state.saving = false;
      go(`spec/${encodeURIComponent(result.value.specId)}`);
    } catch (error) { if (error.outcome === 'failed') state.pendingFork = null; banner(`${error.code ?? 'COPY INCOMPLETE'}: ${error.message}`); }
    finally { state.saving = false; if (document.contains(button)) { button.disabled = false; textarea.disabled = false; title.disabled = false; button.textContent = state.pendingFork ? 'Check previous copy' : 'Save as another draft'; } }
  };
}
const storyColumns = [['title', 'Story'], ['phase', 'Phase'], ['createdAt', 'Created'], ['createdBy', 'Creator']];
function storyPhase(row) { return row.phaseLabel ?? (row.phase ? words(row.phase) : ''); }

async function stories(epoch, initialId = '') {
  const result = await operation('story.list');
  if (epoch !== state.epoch) return;
  const rows = result.value.stories ?? [];
  const key = row => JSON.stringify([row.workId, row.checkoutPath]);
  const choices = new Map((result.choices ?? []).map(choice => [key(choice), choice.choiceId]));
  $('#main').innerHTML = heading('Stories', 'Open a Story checkout on this computer.',
    '<button data-action="retry">Refresh</button>' + nativeButton('intake', 'Start a Story in VS Code'))
    + `<section class="card collection"><div class="toolbar">
      ${searchField('story-search', 'Find a Story', 'Search by title, ID, creator, repository or workspace…')}
      <div class="segmented" role="group" aria-label="Story filter">
        <button data-story-filter="all" aria-pressed="true">All</button><button data-story-filter="ready" aria-pressed="false">Can open here</button>
      </div><span id="story-count" class="results-count" role="status"></span>
      </div><div id="story-list"></div></section>`;
  let sort = preferences.get('story-sort', null);
  if (!storyColumns.some(([field]) => field === sort?.field) || ![1, -1].includes(sort.direction)) {
    sort = { field: 'createdAt', direction: -1 };
  }
  $('#story-search').value = initialId;
  let onlyReady = false;
  const sortValue = {
    title: row => row.title ?? row.workId,
    phase: storyPhase,
    createdBy: row => row.createdBy
  };
  const compare = (left, right) => {
    if (sort.field === 'createdAt') {
      const a = Date.parse(left.createdAt), b = Date.parse(right.createdAt);
      if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
      return Number.isFinite(a) ? (a - b) * sort.direction : 0;
    }
    return String(sortValue[sort.field](left) ?? '').localeCompare(String(sortValue[sort.field](right) ?? '')) * sort.direction;
  };
  const draw = () => {
    const query = searchText($('#story-search').value);
    const filtered = rows.filter(row => (!onlyReady || choices.has(key(row)))
      && searchText([row.title, row.workId, storyPhase(row), row.createdBy, row.repository?.id, row.workspace?.name].join(' ')).includes(query)).sort(compare);
    $('#story-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'Story' : 'Stories'}`;
    const columns = storyColumns.map(([field, label]) => {
      const direction = field === sort.field ? sort.direction === -1 ? 'descending' : 'ascending' : null;
      return `<th scope="col"${direction ? ` aria-sort="${direction}"` : ''}><button data-sort="${field}">${label}${direction ? ` <span aria-hidden="true">${direction === 'descending' ? '↓' : '↑'}</span>` : ''}</button></th>`;
    });
    $('#story-list').innerHTML = filtered.length ? table('Stories', 'story-table', columns, filtered.map(row => {
      const title = row.title ?? row.workId;
      const choice = choices.get(key(row));
      const location = [row.workId, row.repository?.id, row.workspace?.name].filter(Boolean).join(' · ');
      const secondary = row.role === 'secondary';
      const name = choice
        ? `<button class="story-title" data-context="${escape(choice)}" aria-label="Open ${escape(title)}${secondary ? ` in ${escape(row.repository.id)}` : ''}"><span>${escape(title)}</span>${icon('right')}</button>`
        : `<span class="row-title">${escape(title)}</span>`;
      return `<tr>
        <td>${name}<small>${escape(location)}</small>
          ${secondary ? '<small>Additional repository</small>' : ''}
          ${choice ? '' : `<small>${escape(row.reason ?? 'No local checkout')}</small>`}</td>
        <td>${pill(storyPhase(row) || words(row.availability), choice ? 'accent' : '')}</td>
        <td>${escape(date(row.createdAt))}</td><td>${escape(row.createdBy || 'Not recorded')}</td>
      </tr>`;
    })) : !rows.length
      ? empty('No Stories listed', 'Start or attach a Story in SFlow to see it here.', '', 'stories')
      : empty('No matching Stories', 'Try a different search or filter.', '', 'stories');
    document.querySelectorAll('[data-sort]').forEach(button => {
      button.onclick = () => {
        const field = button.dataset.sort;
        sort = { field, direction: sort.field === field ? -sort.direction : field === 'createdAt' ? -1 : 1 };
        preferences.set('story-sort', sort);
        draw();
        $(`[data-sort="${field}"]`)?.focus();
      };
    });
    document.querySelectorAll('[data-context]').forEach(button => {
      button.onclick = () => switchCheckout({ choiceId: button.dataset.context }, button);
    });
  };
  $('#story-search').oninput = draw;
  document.querySelectorAll('[data-story-filter]').forEach(button => {
    button.onclick = () => {
      onlyReady = button.dataset.storyFilter === 'ready';
      document.querySelectorAll('[data-story-filter]').forEach(control => control.setAttribute('aria-pressed', String(control === button)));
      draw();
    };
  });
  draw();
}

const catalogs = {
  workflows: { type: 'workflow', description: 'Browse the workflows available to this checkout.' },
  agents: { type: 'agent', description: 'Find agents and see what work they are meant to do.' },
  skills: { type: 'skill', description: 'Find reusable skills by name, purpose or tag.' },
  instructions: { type: 'instruction', description: 'Find instructions available to workflows and agents.' }
};
async function catalog(page, epoch, initialId = '') {
  const { type, description } = catalogs[page];
  const result = await operation(`${type}.list`);
  if (epoch !== state.epoch) return;
  const value = dataOf(result.value) ?? {};
  const entries = Array.isArray(value) ? value : value[page] ?? value.items ?? value.entries ?? value.rows ?? [];
  const searchable = entries.map(entry => ({ entry, text: searchText([
    entry.label, entry.title, entry.name, entry.id, entry.workflowId, entry.description,
    entry.purpose, entry.summary, entry.tags, entry.source, entry.scope
  ].join(' ')) }));
  $('#main').innerHTML = heading(pageLabel(page), description, nativeButton(page === 'workflows' ? 'workflows' : 'configuration', 'Manage in VS Code'))
    + `<div class="toolbar catalog-toolbar">${searchField('catalog-search', 'Search catalog', 'Search by name, purpose or tag…')}
      <span id="catalog-count" class="results-count" role="status"></span></div><div id="catalog-list" class="catalog"></div>`;
  const draw = () => {
    const query = searchText($('#catalog-search').value);
    const filtered = searchable.filter(item => item.text.includes(query));
    $('#catalog-count').textContent = `${filtered.length} ${filtered.length === 1 ? 'result' : 'results'}`;
    $('#catalog-list').innerHTML = filtered.length ? filtered.map(({ entry }) => catalogCard(page, entry)).join('')
      : empty(query ? 'No results for this search' : 'Nothing listed yet', query ? 'Try a different name or keyword.'
        : 'Entries appear here when they are available in this checkout.', '', page);
  };
  $('#catalog-search').value = initialId;
  $('#catalog-search').oninput = draw;
  draw();
}

async function runAndTest(epoch) {
  const { story } = state.session.context;
  $('#main').innerHTML = heading('Run & Test', story
    ? `Application status for this checkout and test evidence for ${story.workId}.`
    : 'Inspect configured commands, current app status and retained test results.',
    nativeButton('run', 'Open Run & Test in VS Code'))
    + `<div class="run-grid">${runPanels.map(([name, title]) => `<section class="card run-card"><h2>${title}</h2>
      <div data-run-panel="${name}">${loading('Reading…')}</div></section>`).join('')}</div>`;
  await Promise.all(runPanels.map(async ([name]) => {
    const panel = $(`[data-run-panel="${name}"]`);
    try {
      const { value } = await operation(name);
      if (epoch === state.epoch) panel.innerHTML = runView(name, value);
    } catch (error) {
      if (epoch === state.epoch) panel.innerHTML = errorView(error, { retry: false, title: 'This result is unavailable' });
    }
  }));
}
async function decisions(epoch) {
  const actions = nativeButton('decisions', 'Review in VS Code');
  const { story } = state.session.context;
  let result;
  try { result = await operation('decision.list'); }
  catch (error) {
    if (error.code !== 'DECISIONS_PHASE_UNKNOWN' || !story) throw error;
    if (epoch === state.epoch) $('#main').innerHTML = heading('Decisions', '', actions)
      + empty('No active phase', 'This Story has no active phase to review.', `<a class="button" href="#stories/${encodeURIComponent(story.workId)}">Open Stories</a>`, 'decisions');
    return;
  }
  if (epoch !== state.epoch) return;
  $('#main').innerHTML = heading('Decisions', 'See what needs attention in this Story.', actions) + decisionView(result.value);
}
async function about(epoch) {
  const { value } = await operation('about');
  if (epoch !== state.epoch) return;
  const build = state.session.build;
  const properties = [['Version', build.version], ['Runtime', `${build.runtime} · ${build.platform} ${build.arch}`],
    ['Protocol', build.protocol], ['Build', build.fingerprint], ['Source', build.engineRoot]];
  $('#main').innerHTML = heading('About', 'Installed build and local service details.', '<button id="disconnect-tab">Disconnect this tab</button>')
    + `<section class="card card-body"><h2>Connected build</h2><dl class="properties">
      ${properties.map(([key, entry]) => `<dt>${key}</dt><dd>${escape(entry)}</dd>`).join('')}</dl>
      ${details(value, 'Installation details')}</section>`;
  $('#disconnect-tab').onclick = async () => {
    if (!dirtyGuard()) return;
    try {
      await api('/api/session/close', { method: 'POST', data: {} });
      sessionStorage.removeItem('sflow.tab');
      state.session = null; state.dirty = false;
      $('#context-switch').disabled = $('#quick-ask').disabled = true;
      $('#main').innerHTML = empty('This tab is disconnected', 'Open SFlow from the terminal or VS Code to reconnect.', '', 'about');
      setConnected('disconnected', 'Disconnected');
    } catch (error) { banner(error.message); }
  };
}

async function navigate() {
  if (!state.session) return;
  const parts = location.hash.slice(1).split('/'), page = parts[0] || 'home';
  if ((state.dirty || state.saving || state.creating || state.switching) && !dirtyGuard()) {
    history.replaceState(null, '', state.draft ? specHref(state.draft.specId) : `#${state.page}`);
    return;
  }
  state.page = page; state.draft = null; state.dirty = false; state.uncertain = false;
  document.body.dataset.page = page;
  state.disposeView?.();
  state.disposeView = null;
  state.pendingSave = null; state.pendingFork = null;
  state.objectUrls.forEach(url => URL.revokeObjectURL(url)); state.objectUrls = [];
  const epoch = ++state.epoch;
  const label = pageLabel(page);
  document.title = `${label} · SFlow Workspace`;
  $('#current-page').textContent = label;
  document.querySelectorAll('#sidebar .nav-link[href]').forEach(anchor => {
    if (anchor.hash === `#${page === 'spec' ? 'specs' : page}`) anchor.setAttribute('aria-current', 'page');
    else anchor.removeAttribute('aria-current');
  });
  const main = $('#main');
  main.innerHTML = loading(`Opening ${label}…`);
  banner(null);
  window.scrollTo(0, 0);
  if (!$('#activity').hidden) activityPanel(false, false);
  // Focus the destination so keyboard and screen reader users start at the new view.
  main.focus({ preventScroll: true });
  try {
    if (['home', 'ask', 'code'].includes(page)) {
      await refreshStoryContext();
      if (epoch !== state.epoch) return;
    }
    if (page === 'home') overview();
    else if (page === 'ask') {
      const { mountAsk } = await import('./ask.js');
      if (epoch !== state.epoch) return;
      const { context, activeStoryIssue } = state.session;
      const contextId = context.id;
      const preparedQuestion = state.preparedQuestion?.contextId === contextId ? state.preparedQuestion.text : null;
      state.preparedQuestion = null;
      mountAsk(main, {
        context, issue: activeStoryIssue,
        preparedQuestion,
        navigate: go,
        readStory: async name => {
          const { value } = await operation(name, {}, { contextId });
          return epoch === state.epoch && contextId === state.session?.context.id ? value : null;
        },
        read: async (input, { signal } = {}) => {
          const timeout = ['task-start', 'task-prepare'].includes(input.interaction) ? 305_000 : input.interaction === 'chat' ? 58_000 : 22_000;
          const value = await api('/api/ask', { method: 'POST', data: { ...input, contextId }, timeout, signal });
          return epoch === state.epoch && contextId === state.session?.context.id ? value : null;
        }
      });
      if (state.focusAsk) { state.focusAsk = false; $('#ask-question').focus(); }
    }
    else if (page === 'specs') await library(epoch);
    else if (page === 'spec') await specification(decodeURIComponent(parts[1] ?? ''), parts[2] === 'published', epoch);
    else if (page === 'stories') await stories(epoch, decodeURIComponent(parts[1] ?? ''));
    else if (Object.hasOwn(catalogs, page)) await catalog(page, epoch, decodeURIComponent(parts[1] ?? ''));
    else if (page === 'code') {
      const { context, activeStoryIssue } = state.session;
      if (activeStoryIssue || context.engine && !context.story) {
        main.innerHTML = heading('Code Explainer') + empty('Open a Story to see its code',
          activeStoryIssue ?? 'Choose a Story from the workspace. Code Explainer will use its application checkout.',
          '<a class="button" href="#stories">Browse Stories</a>', 'stories');
        return;
      }
      const { mountCodeExplainer } = await import('./code-explainer.js');
      if (epoch !== state.epoch) return;
      const panel = document.createElement('div');
      main.replaceChildren(panel);
      state.disposeView = mountCodeExplainer(panel, { context, navigate: go, editor: nativeButton('code', 'Open in VS Code'),
        operation: (name, input) => operation(name, input, { contextId: context.id }),
        ask: text => { state.preparedQuestion = { contextId: context.id, text }; go('ask'); } });
    }
    else if (page === 'run') await runAndTest(epoch);
    else if (page === 'decisions') await decisions(epoch);
    else if (page === 'about') await about(epoch);
    else go('home');
  } catch (error) { if (epoch === state.epoch) main.innerHTML = errorView(error); }
}

document.addEventListener('click', event => {
  const native = event.target.closest('[data-native]')?.dataset.native;
  if (native) { void editorHandoff('native.menu', { menu: native }); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'create' && state.session) {
    $('#create-error').textContent = '';
    $('#create-dialog').showModal();
    $('#spec-title').focus();
  }
  if (action === 'choose-checkout') $('#context-switch').click();
  if (action === 'retry') void navigate();
});
$('#create-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; state.creating = true;
  try {
    let result;
    if (state.pendingCreation) {
      const id = state.pendingCreation;
      result = await awaitOperation(id, await api(`/api/requests/${id}`));
    } else {
      const id = crypto.randomUUID(); state.pendingCreation = id;
      result = await operation('spec.create', { title: $('#spec-title').value, intent: $('#spec-idea').value || null, kind: $('#spec-kind').value }, { invocationId: id });
    }
    const { value } = result; state.pendingCreation = null;
    if (result.contextKey !== state.session.context.key) { banner('The specification was created in the previous checkout. Switch back using the checkout menu to open it from Activity.'); return; }
    $('#create-dialog').close(); $('#create-form').reset(); go(`spec/${encodeURIComponent(value.specId)}`);
  } catch (error) {
    if (error.outcome === 'failed' || error.status >= 400 && error.status < 500 && error.status !== 404) state.pendingCreation = null;
    $('#create-error').textContent = `${error.code ?? ''} ${error.message}${state.pendingCreation ? ' The next click inspects the same request; it will not create another specification.' : ''}`;
  }
  finally { state.creating = false; button.disabled = false; button.textContent = state.pendingCreation ? 'Check previous creation' : 'Create specification'; }
};
window.addEventListener('hashchange', () => { void navigate(); });
window.addEventListener('focus', () => { void followCodeView(); });
document.addEventListener('visibilitychange', () => { void followCodeView(); });
window.addEventListener('beforeunload', event => { if (state.dirty || state.saving || state.pendingCreation) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.body.classList.contains('nav-open')) navigationPanel(false);
    else if (!$('#activity').hidden && !document.querySelector('dialog[open]')) activityPanel(false);
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && state.session && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    if (document.body.classList.contains('nav-open')) navigationPanel(false, false);
    focusAsk();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 's' && state.draft) {
    event.preventDefault();
    void saveDraft();
  }
});
async function boot() {
  $('#navigation').innerHTML = navigation();
  for (const [id, name] of [['about-icon', 'about'], ['mobile-menu', 'menu'], ['checkout-icon', 'checkout'],
    ['checkout-chevron', 'down'], ['quick-ask-icon', 'search'], ['activity-icon', 'clock'], ['activity-close', 'close'], ['banner-close', 'close']]) {
    $(`#${id}`).innerHTML = icon(name);
  }
  $('#quick-ask-key').textContent = /Mac|iPhone|iPad/u.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  // Remove the one-use fragment before any asynchronous read or navigation.
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
  if (ticket) history.replaceState(null, '', '#home');
  try {
    if (ticket) {
      state.session = await api('/api/session', { method: 'POST', data: { ticket } });
      sessionStorage.setItem('sflow.tab', state.session.tabId);
    } else {
      const tabId = sessionStorage.getItem('sflow.tab');
      state.session = { ...await api('/api/session'), tabId };
    }
    updateCheckout(state.session.context, state.session.followsActiveStory);
    $('#context-switch').disabled = $('#quick-ask').disabled = false;
    setConnected('connected', 'Connected locally');
    try {
      const existing = await api('/api/requests');
      existing.requests.forEach(activity);
    } catch { /* An unavailable activity list must not block the workspace. */ }
    await navigate();
    setInterval(() => { void followCodeView(); }, 2000);
    setInterval(async () => {
      if (document.hidden || !state.session) return;
      // Polling is not activity for the service's idle stop, unless this tab holds writing not yet saved.
      const working = state.dirty || state.saving || state.creating || Boolean(state.pendingSave || state.pendingCreation || state.pendingFork);
      try {
        const events = await api(`/api/events?after=${state.eventSequence}${working ? '&working=1' : ''}`);
        state.eventSequence = events.sequence;
        if ($('#connection').dataset.status !== 'connected') setConnected('connected', 'Connected locally');
      } catch {
        if ($('#connection').dataset.status !== 'disconnected') setConnected('disconnected', 'Reconnect needed');
      }
    }, 10_000);
  } catch (error) {
    setConnected('disconnected', 'Disconnected');
    $('#main').innerHTML = errorView(error, { retry: false, title: 'Couldn’t connect to the workspace' })
      + '<p class="feature-note">Reopen with <code>singularity-flow ui open</code> or <strong>Open SFlow in browser</strong> in VS Code.</p>';
  }
}
void boot();

/** Shared browser presentation. Operations and decisions remain SFlow-owned. No repository I/O. */
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = { home: '⌂', specs: '▤', stories: '◫', workflows: '◇', agents: '♙', skills: '◈', instructions: '≡', run: '▷', decisions: '☑', about: 'ⓘ' };
const pages = [['home', 'Overview'], ['specs', 'Spec Studio'], ['stories', 'Stories'], ['workflows', 'Workflows'], ['agents', 'Agents'], ['skills', 'Skills'], ['instructions', 'Instructions'], ['run', 'Run & Test'], ['decisions', 'Decisions'], ['about', 'About']];
const state = { session: null, epoch: 0, page: 'home', draft: null, dirty: false, saving: false, creating: false, uncertain: false, pendingSave: null, pendingCreation: null, pendingFork: null, activities: [], choices: [], eventSequence: 0, objectUrls: [] };
const preferences = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`sflow.view.${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`sflow.view.${key}`, JSON.stringify(value)); } catch { /* View preferences are optional. */ } }
};
document.body.classList.toggle('collapsed', preferences.get('collapsed', false));
$('#collapse').onclick = () => { document.body.classList.toggle('collapsed'); preferences.set('collapsed', document.body.classList.contains('collapsed')); };
function activityPanel(open) { $('#activity').hidden = !open; }
$('#activity-toggle').onclick = () => activityPanel($('#activity').hidden);
$('#activity-close').onclick = () => activityPanel(false);
$('#create-cancel').onclick = () => $('#create-dialog').close();
$('#context-cancel').onclick = () => $('#context-dialog').close();
$('#context-switch').onclick = async () => {
  try {
    const result = await api('/api/contexts');
    $('#context-choices').innerHTML = result.contexts.map(context => `<button class="context-choice" data-known-context="${escape(context.id)}"><strong>${escape(context.label)}</strong><small>${escape(context.root)}</small>${context.id === result.currentId ? '<span class="pill">Current</span>' : ''}</button>`).join('');
    $('#context-dialog').showModal();
    document.querySelectorAll('[data-known-context]').forEach(button => { button.onclick = async () => {
      if (!dirtyGuard()) return;
      try { button.disabled = true; const result = await api('/api/contexts', { method: 'POST', data: { contextId: button.dataset.knownContext } }); $('#context-dialog').close(); await changedContext(result); }
      catch (error) { banner(error.message); button.disabled = false; }
    }; });
  } catch (error) { banner(error.message); }
};
async function changedContext(result) {
  state.dirty = false; state.draft = null; state.session.context = result.context; state.session.capabilities = result.capabilities;
  $('#context-name').textContent = result.context.label; $('#context-name').title = result.context.root;
  if (state.activities.length) activity(state.activities[0]);
  if (location.hash === '#home') await navigate(); else go('home');
}
function activity(item) {
  const previous = state.activities.findIndex(entry => entry.invocationId === item.invocationId);
  if (previous >= 0) state.activities[previous] = { ...state.activities[previous], ...item };
  else state.activities.unshift(item);
  state.activities = state.activities.slice(0, 64);
  $('#activity-count').textContent = state.activities.length;
  $('#activity-items').innerHTML = state.activities.map(entry => `<div class="activity-item"><span class="pill">${escape(entry.state)}</span><br><strong>${escape(entry.operation)}</strong><small>${escape(entry.contextLabel)} · ${escape(entry.invocationId)}</small>${entry.result?.value?.specId && entry.contextKey === state.session?.context.key ? `<p><a href="#spec/${encodeURIComponent(entry.result.value.specId)}">Open specification →</a></p>` : ''}${entry.error ? `<p>${escape(entry.error.message)}</p>` : ''}</div>`).join('') || '<p class="muted">Your workspace activity will appear here.</p>';
}
async function api(route, { method = 'GET', data, content, timeout = 15_000 } = {}) {
  const tabId = state.session?.tabId ?? sessionStorage.getItem('sflow.tab');
  const response = await fetch(route, { method, credentials: 'same-origin', signal: AbortSignal.timeout(timeout),
    headers: { ...(data ? content === undefined ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/octet-stream', 'X-SFlow-Content': encodeURIComponent(JSON.stringify(data)) } : {}), ...(tabId ? { 'X-SFlow-Tab': tabId } : {}),
      ...(state.session?.csrf ? { 'X-SFlow-CSRF': state.session.csrf } : {}) }, ...(data ? { body: content === undefined ? JSON.stringify(data) : content } : {}) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message ?? 'The request failed.'); error.code = result.error?.code; error.details = result.error?.details; error.status = response.status; throw error; }
  return result;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function operation(name, input = {}, { invocationId = crypto.randomUUID() } = {}) {
  const contextId = state.session.context.id;
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
function setConnected(label) { $('#connection').innerHTML = `<i></i><span class="nav-label">${escape(label)}</span>`; }
function banner(message) { $('#banner').hidden = !message; $('#banner').textContent = message ?? ''; }
function errorView(error, retry = true) {
  return `<div class="error"><div class="eyebrow">${escape(error.code ?? 'CONNECTION INTERRUPTED')}</div><h2>Let’s get this moving</h2><p>${escape(error.message)}</p>${error.details ? `<details><summary>Original SFlow details</summary><pre>${escape(JSON.stringify(error.details, null, 2))}</pre></details>` : ''}${retry ? '<button data-action="retry">Try again</button>' : ''}</div>`;
}
function empty(title, description, action = '') { return `<div class="card empty"><div class="empty-symbol">▤</div><h2>${escape(title)}</h2><p>${escape(description)}</p>${action}</div>`; }
function heading(eyebrow, title, description, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">${escape(eyebrow)}</div><h1>${escape(title)}</h1><p class="muted">${escape(description)}</p></div><div class="heading-actions">${actions}</div></div>`; }
function newButton() { return '<button class="primary" data-action="create">＋ New specification</button>'; }
function nativeButton(menu, label) { return state.session.capabilities.nativeMenus ? `<button data-native="${menu}">${escape(label)} ↗</button>` : ''; }
function date(value) { const when = value ? new Date(value) : null; return when && Number.isFinite(when.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(when) : 'Not recorded'; }
function go(hash) { location.hash = hash; }
function dirtyGuard() { if (state.saving || state.creating) { banner('Please wait for the current save before switching views.'); return false; } return !state.dirty || confirm('This specification has unsaved changes. Leave it without saving?'); }
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

async function overview() {
  $('#main').innerHTML = `<section class="welcome"><div class="eyebrow">A LITTLE CLARITY GOES A LONG WAY</div><h1>Good work starts with<br>a shared understanding.</h1><p>Turn a rough idea into a clear specification. Keep the details, decisions and delivery connected as the work develops.</p>${newButton()}</section><div class="cards"><a class="card" href="#specs"><div class="eyebrow">DEFINE</div><h3>Shape your next idea ↗</h3><p class="muted">Create, edit and save in Spec Studio.</p></a><a class="card" href="#stories"><div class="eyebrow">DELIVER</div><h3>Find your current work ↗</h3><p class="muted">Stories, their creators and local checkouts.</p></a><a class="card" href="#run"><div class="eyebrow">VALIDATE</div><h3>See Run & Test plans ↗</h3><p class="muted">Inspect the configuration for this checkout.</p></a></div><div class="feature-note">Connected to <strong>${escape(state.session.context.root)}</strong>. This tab has its own context. SFlow’s existing checks and approval requirements still apply.</div>`;
}
async function library(epoch) {
  const { value } = await operation('spec.list'); if (epoch !== state.epoch) return;
  const drafts = (value.drafts ?? []).map(item => ({ ...item, status: 'Local draft', editable: true }));
  const published = (value.specs ?? []).filter(item => !drafts.some(draft => draft.specId === item.specId)).map(item => ({ ...item, title: item.latest.title, status: item.latest.reviewState, editable: false }));
  $('#main').innerHTML = heading('SPEC STUDIO', 'A place for the idea to take shape', 'Start simply. Save your work at any time.', newButton())
    + `<div class="toolbar"><input class="search" id="spec-search" aria-label="Find a specification" placeholder="Search by name or ID…"><span class="muted">${drafts.length + published.length} specifications</span></div><div id="spec-list"></div>`
    + (value.unreadable?.length ? `<div class="feature-note">${value.unreadable.length} entries could not be read. They were preserved. Inspect Spec Studio in VS Code for their recovery details.</div>` : '');
  const draw = query => {
    const entries = [...drafts, ...published].filter(entry => `${entry.title} ${entry.specId}`.toLowerCase().includes(query.toLowerCase()));
    $('#spec-list').innerHTML = entries.length ? `<div class="table-wrap"><table><thead><tr><th>Specification</th><th>Status</th><th>Version</th><th></th></tr></thead><tbody>${entries.map(entry => `<tr><td><strong>${escape(entry.title)}</strong><small>${escape(entry.specId)}</small></td><td><span class="pill ${entry.editable ? 'draft' : ''}">${escape(entry.status)}</span></td><td>${entry.editable ? `Save ${entry.sequence}` : `Revision ${entry.latest.revision}`}</td><td><a href="#spec/${encodeURIComponent(entry.specId)}${entry.editable ? '' : '/published'}">${entry.editable ? 'Continue editing' : 'Read specification'} →</a></td></tr>`).join('')}</tbody></table></div>` : empty(query ? 'No matching specifications' : 'Your next idea belongs here', query ? 'Try a different name or ID.' : 'You don’t need a complete brief. A sentence is enough to get started.', query ? '' : newButton());
  };
  draw(''); $('#spec-search').oninput = event => draw(event.target.value);
}
function markdown(source) {
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
  return out.join('');
}
async function specification(specId, published, epoch) {
  const { value } = await operation(published ? 'spec.show' : 'spec.read', { specId }); if (epoch !== state.epoch) return;
  if (published) {
    $('#main').innerHTML = heading('SPEC STUDIO', value.manifest?.title ?? specId, `Published revision ${value.revision}`, '<a href="#specs">← Back to specifications</a>') + `<article class="editor-paper" id="draft-preview">${markdown(value.spec ?? '')}</article>`; return;
  }
  state.draft = { ...value }; state.dirty = false; state.uncertain = false;
  $('#main').innerHTML = `<div class="page-heading editor-heading"><div><div class="eyebrow"><a href="#specs">SPEC STUDIO</a> / DRAFT</div><input class="editor-title" id="draft-title" maxlength="240" aria-label="Specification name" value="${escape(value.title)}"><small>${escape(specId)} · ${escape(value.kind ?? 'Choose a kind in VS Code')}</small></div><div class="heading-actions"><span class="save-state" id="save-state">All changes saved · version ${value.sequence}</span><button class="primary" id="save-draft">Save changes</button></div></div>
  <div class="editor-layout"><div class="editor-paper"><div class="editor-toolbar"><button data-insert="heading" title="Insert heading">H₂</button><button data-insert="bold" title="Bold text"><strong>B</strong></button><button data-insert="bullet" title="Insert list">• List</button><span class="spacer"></span><button class="selected" id="write-mode">Write</button><button id="preview-mode">Preview</button></div><textarea id="draft-content" aria-label="Specification content" spellcheck="true">${escape(value.spec)}</textarea><article id="draft-preview" hidden></article><div class="editor-footer"><span>Markdown supported · text stays in this tab until saved</span><span id="word-count"></span></div></div>
  <aside class="editor-side"><section class="card support-card"><h3>Build confidence, one detail at a time</h3><p>Explain the problem, the people affected and what a good outcome looks like. SFlow can check for gaps as you go.</p><button id="check-draft">Check this specification</button><div id="check-result" class="section-output"></div></section><section class="card support-card"><h3>Your supporting material</h3><p>Local files remain on this computer. Review the original sources and saved versions.</p><button id="sources-draft">View sources</button><button id="history-draft">Saved versions</button><div id="support-result" class="section-output"></div></section><section class="card support-card"><h3>Work with Copilot</h3><p id="copilot-note">This browser has no connected Copilot window. Open Spec Studio in VS Code to co-create with Copilot. No model has been called.</p></section></aside></div>`;
  const textarea = $('#draft-content');
  const words = () => { $('#word-count').textContent = `${textarea.value.trim().split(/\s+/u).filter(Boolean).length} words`; };
  const changed = () => { state.dirty = true; $('#save-state').textContent = 'Unsaved changes'; words(); };
  textarea.oninput = changed; $('#draft-title').oninput = changed; words();
  $('#save-draft').onclick = () => saveDraft();
  $('#preview-mode').onclick = () => { $('#draft-preview').innerHTML = markdown(textarea.value); $('#draft-preview').hidden = false; textarea.hidden = true; $('#preview-mode').classList.add('selected'); $('#write-mode').classList.remove('selected'); };
  $('#write-mode').onclick = () => { $('#draft-preview').hidden = true; textarea.hidden = false; $('#write-mode').classList.add('selected'); $('#preview-mode').classList.remove('selected'); textarea.focus(); };
  document.querySelectorAll('[data-insert]').forEach(button => { button.onclick = () => {
    const start = textarea.selectionStart, end = textarea.selectionEnd, selected = textarea.value.slice(start, end);
    const inserted = button.dataset.insert === 'bold' ? `**${selected || 'text'}**` : button.dataset.insert === 'heading' ? `\n## ${selected || 'Heading'}\n` : `\n- ${selected || 'Item'}\n`;
    textarea.setRangeText(inserted, start, end, 'select'); textarea.focus(); changed();
  }; });
  $('#check-draft').onclick = async () => {
    if (state.dirty && !await saveDraft()) return;
    await supportOperation('spec.check', '#check-result');
  };
  $('#sources-draft').insertAdjacentHTML('beforebegin', '<button id="attach-draft">＋ Attach a file or image</button><input type="file" id="source-upload" hidden><small>Up to 5 MiB · stored locally</small>');
  $('#sources-draft').onclick = () => sources();
  $('#attach-draft').onclick = () => $('#source-upload').click();
  $('#source-upload').onchange = event => { const file = event.target.files?.[0]; if (file) void attachSource(file); };
  if (state.session.capabilities.copilot) {
    $('#copilot-note').textContent = 'Prepare a request in the matching Copilot window. You choose when to send it. Suggestions stay proposals until you review them.';
    $('#copilot-note').insertAdjacentHTML('afterend', '<button id="ask-copilot">Continue with Copilot ↗</button>');
    $('#ask-copilot').onclick = async () => { if (state.dirty && !await saveDraft()) return; await editorHandoff('spec.assist', { specId }); };
  }
  $('#history-draft').onclick = () => supportOperation('spec.history', '#support-result');
  if (state.session.capabilities.nativeMenus) {
    $('#history-draft').insertAdjacentHTML('afterend', '<button id="native-spec">Review and publish in VS Code ↗</button>');
    $('#native-spec').onclick = async () => { if (state.dirty && !await saveDraft()) return; await editorHandoff('native.menu', { menu: 'specs', specId }); };
  }
}
async function supportOperation(name, target) {
  const element = $(target); element.textContent = 'Reading…';
  try {
    const { value } = await operation(name, { specId: state.draft.specId });
    if (!document.contains(element)) return;
    const report = name === 'spec.check' ? value.report ?? value : value;
    element.innerHTML = name === 'spec.check' ? `<p><strong>${report.reviewReady ? 'Ready for the next review' : 'A few details need attention'}</strong></p><ul>${(report.blocking ?? []).map(item => `<li>${escape(item.message ?? item.code)}</li>`).join('')}</ul><p class="muted">This checks the saved version. Human review remains a separate step.</p>` : `<pre class="section-output">${escape(JSON.stringify(report, null, 2))}</pre>`;
    if (name === 'spec.check' && value.next) element.insertAdjacentHTML('beforeend', `<p class="muted">Next step from SFlow:</p><code>${escape(value.next)}</code>`);
  } catch (error) { if (document.contains(element)) element.innerHTML = errorView(error, false); }
}
async function sources() {
  const element = $('#support-result'); element.textContent = 'Reading your sources…';
  try {
    const { value } = await operation('spec.sources', { specId: state.draft.specId });
    if (!document.contains(element)) return;
    element.innerHTML = (value.sources ?? []).map(({ source }) => `<div class="source-entry"><strong>${escape(source.name)}</strong><small>${escape(source.type === 'file' ? 'Local file' : source.type)}</small><button data-source="${escape(source.id)}">Read source</button></div>`).join('') || '<p>No sources yet. Attach a document or image to give this idea more context.</p>';
    element.querySelectorAll('[data-source]').forEach(button => { button.onclick = () => { void readSource(button.dataset.source, element); }; });
  } catch (error) { if (document.contains(element)) element.innerHTML = errorView(error, false); }
}
async function attachSource(file, restore = null) {
  if (file.size > 5 * 1024 * 1024) { banner('Choose a file up to 5 MiB for browser upload. Larger files can be attached in VS Code.'); return; }
  if (state.dirty && !await saveDraft()) return;
  const specId = state.draft.specId, button = $('#attach-draft'); button.disabled = true;
  try {
    const { value } = await operation('spec.source.add', { specId, name: file.name, file, ...(restore ? { restore } : {}) });
    if (state.draft?.specId === specId) {
      if (value.sequence) state.draft.sequence = value.sequence;
      else state.draft.sequence = (await operation('spec.read', { specId })).value.sequence;
      await sources(); banner('Attached locally. The original file bytes are not uploaded to Git.');
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
      const response = await fetch(`/api/content/${resource.id}`, { credentials: 'same-origin', headers: { 'X-SFlow-Tab': state.session.tabId } });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error?.message ?? 'The original image could not be read.'); }
      const url = URL.createObjectURL(await response.blob()); state.objectUrls.push(url);
      element.innerHTML = `<img class="source-preview" src="${url}" alt="${escape(source.source?.name ?? 'Attached image')}"><p class="muted">Original local image. Previewing is not acceptance or visual sign-off.</p>`;
    } else element.innerHTML = source?.text ? `<pre class="section-output">${escape(source.text)}</pre>${source.next ? '<p class="muted">This is a bounded excerpt. Read the full document through its native SFlow source route.</p>' : ''}` : `<p>${escape(source?.message ?? source?.reason ?? 'This file needs its native document viewer. Open its source in VS Code.')}</p>`;
  } catch (error) { if (document.contains(element)) element.innerHTML = errorView(error, false); }
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
      $('#support-result').innerHTML = `<p>Your save completed, and another version was saved afterward. Compare the latest wording before making a new change.</p><pre class="section-output">${escape(value.spec)}</pre>`;
      banner('The previous save succeeded. Newer writing also exists; your unsaved text was preserved.'); conflictActions(); return;
    }
    state.draft.sequence = value.sequence; state.uncertain = false; state.pendingSave = null;
    state.dirty = $('#draft-content').value !== pending.content || $('#draft-title').value !== pending.title;
    $('#save-state').textContent = state.dirty ? 'Previous save confirmed · newer changes waiting' : `All changes saved · version ${value.sequence}`;
    button.remove(); banner('Confirmed the original save from SFlow’s verified snapshot. The save was not repeated.');
  } catch (error) { banner(`${error.code ?? 'INSPECTION FAILED'}: ${error.message}`); }
  finally { if (document.contains(button)) button.disabled = false; }
}
function conflictActions() {
  if ($('#compare-draft')) return;
  $('#save-draft').insertAdjacentHTML('beforebegin', '<button id="compare-draft">Compare latest</button><button id="fork-draft">Save as another draft</button>');
  $('#compare-draft').onclick = async () => {
    try { const { value } = await operation('spec.read', { specId: state.draft.specId }); $('#support-result').innerHTML = `<p><strong>Latest saved writing · version ${value.sequence}</strong></p><p>Your writing is still in the editor.</p><pre class="section-output">${escape(value.spec)}</pre>`; }
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
async function stories(epoch) {
  const result = await operation('story.list'); if (epoch !== state.epoch) return;
  const rows = result.value.stories ?? []; state.choices = result.choices ?? [];
  $('#main').innerHTML = heading('STORIES', 'Pick up where you left off', 'Available Story checkouts on this computer. Selecting one changes only this tab.', nativeButton('intake', 'Start a Story in VS Code')) + '<div class="toolbar"><input id="story-search" class="search" aria-label="Find a Story" placeholder="Search by title, creator or repository…"></div><div id="story-list"></div>';
  let sort = preferences.get('story-sort', { field: 'createdAt', direction: -1 });
  const draw = () => {
    const query = $('#story-search').value.toLowerCase();
    const filtered = rows.filter(row => [row.title, row.workId, row.createdBy, row.repository?.id].join(' ').toLowerCase().includes(query)).sort((a, b) => String(a[sort.field] ?? '').localeCompare(String(b[sort.field] ?? '')) * sort.direction);
    $('#story-list').innerHTML = filtered.length ? `<div class="table-wrap"><table><thead><tr>${[['title', 'Story'], ['phase', 'Phase'], ['createdAt', 'Created'], ['createdBy', 'Creator']].map(([key, label]) => `<th><button data-sort="${key}">${label}${sort.field === key ? sort.direction === -1 ? ' ↓' : ' ↑' : ''}</button></th>`).join('')}<th></th></tr></thead><tbody>${filtered.map(row => {
      const choice = state.choices.find(item => item.checkoutPath === row.checkoutPath && item.workId === row.workId);
      return `<tr><td><strong>${escape(row.title ?? row.workId)}</strong><small>${escape(row.workId)} · ${escape(row.repository?.id)}</small></td><td><span class="pill">${escape(row.phase ?? row.availability)}</span></td><td>${escape(date(row.createdAt))}</td><td>${escape(row.createdBy ?? 'Not recorded')}</td><td>${choice ? `<button data-context="${escape(choice.choiceId)}">Open →</button>` : escape(row.reason ?? 'Unavailable')}</td></tr>`;
    }).join('')}</tbody></table></div>` : empty('No matching Stories', 'Story checkouts appear here after they are created or attached using SFlow.');
    document.querySelectorAll('[data-sort]').forEach(button => { button.onclick = () => { sort = { field: button.dataset.sort, direction: sort.field === button.dataset.sort ? -sort.direction : -1 }; preferences.set('story-sort', sort); draw(); }; });
    document.querySelectorAll('[data-context]').forEach(button => { button.onclick = async () => {
      try { if (!dirtyGuard()) return; button.disabled = true; const result = await api('/api/contexts', { method: 'POST', data: { choiceId: button.dataset.context } }); await changedContext(result); }
      catch (error) { banner(error.message); button.disabled = false; }
    }; });
  };
  $('#story-search').oninput = draw; draw();
}
async function catalog(page, epoch) {
  const type = { workflows: 'workflow', agents: 'agent', skills: 'skill', instructions: 'instruction' }[page];
  const result = await operation(`${type}.list`); if (epoch !== state.epoch) return;
  // Some canonical readers already use the versioned command-result envelope; keep its raw
  // transport result intact and project the same data for presentation as their native client.
  const value = result.value?.resultType === 'command-result' ? result.value.data : result.value;
  const entries = Array.isArray(value) ? value : value[page] ?? value.items ?? value.entries ?? value.rows ?? [];
  $('#main').innerHTML = heading('YOUR TOOLKIT', pages.find(([id]) => id === page)[1], 'Discover reusable building blocks for your team.', nativeButton(page === 'workflows' ? 'workflows' : 'configuration', 'Manage in VS Code'))
    + '<div class="toolbar"><input id="catalog-search" class="search" aria-label="Search catalog" placeholder="Search by name, purpose or tag…"></div><div id="catalog-list" class="catalog"></div><div class="feature-note">Catalog browsing is available here. Editing, imports and activation continue through their existing VS Code and CLI operations during this browser rollout.</div>';
  const draw = () => {
    const query = $('#catalog-search').value.toLowerCase();
    $('#catalog-list').innerHTML = entries.filter(entry => JSON.stringify(entry).toLowerCase().includes(query)).map(entry => `<article class="card"><span class="pill">${escape(entry.source ?? entry.scope ?? type)}</span><h3>${escape(entry.label ?? entry.title ?? entry.name ?? entry.id ?? entry.workflowId ?? 'Catalog entry')}</h3><p class="muted">${escape(entry.description ?? entry.purpose ?? entry.summary ?? '')}</p><small>${escape(entry.id ?? entry.workflowId ?? '')}</small></article>`).join('') || empty('Nothing to show yet', 'Try a different search, or manage this catalog in VS Code.');
  }; $('#catalog-search').oninput = draw; draw();
}
async function runAndTest(epoch) {
  const values = await Promise.allSettled(['app.plan', 'app.status', 'tests.plan', 'tests.summary'].map(name => operation(name)));
  if (epoch !== state.epoch) return;
  $('#main').innerHTML = heading('RUN & TEST', 'Understand how this checkout runs', 'These plans come from SFlow’s existing execution owners.', nativeButton('run', 'Open Run & Test in VS Code'))
    + '<div class="feature-note">Starting applications, executing tests and changing run configuration remain in Workspace Run & Test in VS Code for this rollout. No application or tests are started by opening this page.</div>'
    + values.map((entry, i) => `<section class="card run-card"><h2>${['Application plan', 'Application status', 'Test plan', 'Test summary'][i]}</h2>${entry.status === 'fulfilled' ? `<pre class="section-output">${escape(JSON.stringify(entry.value.value, null, 2))}</pre>` : errorView(entry.reason, false)}</section>`).join('');
}
async function decisions(epoch) {
  const { value } = await operation('decision.list'); if (epoch !== state.epoch) return;
  $('#main').innerHTML = heading('DECISIONS', 'Make the next choice with context', 'SFlow’s current decision result for this checkout.', nativeButton('decisions', 'Review in VS Code'))
    + `<div class="card"><pre class="section-output">${escape(JSON.stringify(value, null, 2))}</pre></div><div class="feature-note">Browser authentication does not establish human approval. Use the exact qualified decision route returned by SFlow in your native client.</div>`;
}
async function about(epoch) {
  const { value } = await operation('about'); if (epoch !== state.epoch) return;
  const build = state.session.build;
  $('#main').innerHTML = heading('ABOUT', 'One SFlow, another way to work', 'An independent local service and browser interface.', '<button id="disconnect-tab">Disconnect this tab</button>') + `<section class="card"><h2>Connected build</h2><dl class="property-list">${[['Version', build.version], ['Runtime', `${build.runtime} · ${build.platform} ${build.arch}`], ['Protocol', build.protocol], ['Build', build.fingerprint], ['Source', build.engineRoot]].map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('')}</dl></section><section class="card"><details><summary>Installation details</summary><pre class="section-output">${escape(JSON.stringify(value, null, 2))}</pre></details></section>`;
  $('#disconnect-tab').onclick = async () => {
    if (!dirtyGuard()) return;
    try { await api('/api/session/close', { method: 'POST', data: {} }); sessionStorage.removeItem('sflow.tab'); state.session = null; state.dirty = false; $('#main').innerHTML = empty('This tab is disconnected', 'Saved work and admitted operations remain available through SFlow. Open a new link from the CLI or VS Code to reconnect.'); setConnected('Disconnected'); }
    catch (error) { banner(error.message); }
  };
}
async function navigate() {
  if (!state.session) return;
  const parts = location.hash.slice(1).split('/'), page = parts[0] || 'home';
  if ((state.dirty || state.saving || state.creating) && !dirtyGuard()) { history.replaceState(null, '', state.draft ? `#spec/${encodeURIComponent(state.draft.specId)}` : `#${state.page}`); return; }
  state.page = page; state.draft = null; state.dirty = false;
  state.objectUrls.forEach(url => URL.revokeObjectURL(url)); state.objectUrls = [];
  const epoch = ++state.epoch;
  $('#current-page').textContent = page === 'spec' ? 'Spec Studio' : pages.find(([id]) => id === page)?.[1] ?? 'Overview';
  document.querySelectorAll('nav a').forEach(anchor => anchor.toggleAttribute('aria-current', anchor.hash === `#${page === 'spec' ? 'specs' : page}`));
  document.querySelector('nav a[aria-current]')?.setAttribute('aria-current', 'page');
  $('#main').innerHTML = '<div class="loading"><span class="spinner"></span>Reading from your workspace…</div>'; banner(null);
  try {
    if (page === 'home') await overview();
    else if (page === 'specs') await library(epoch);
    else if (page === 'spec') await specification(decodeURIComponent(parts[1] ?? ''), parts[2] === 'published', epoch);
    else if (page === 'stories') await stories(epoch);
    else if (['workflows', 'agents', 'skills', 'instructions'].includes(page)) await catalog(page, epoch);
    else if (page === 'run') await runAndTest(epoch);
    else if (page === 'decisions') await decisions(epoch);
    else if (page === 'about') await about(epoch);
    else go('home');
  } catch (error) { if (epoch === state.epoch) $('#main').innerHTML = errorView(error); }
}
document.addEventListener('click', event => {
  const native = event.target.closest('[data-native]')?.dataset.native;
  if (native) { void editorHandoff('native.menu', { menu: native }); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'create') { $('#create-error').textContent = ''; $('#create-dialog').showModal(); $('#spec-title').focus(); }
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
window.addEventListener('beforeunload', event => { if (state.dirty || state.saving || state.pendingCreation) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 's' && state.draft) { event.preventDefault(); void saveDraft(); } });
async function boot() {
  $('#navigation').innerHTML = pages.map(([id, label], index) => `${index === 3 ? '<div class="section-label">BUILDING BLOCKS</div>' : index === 7 ? '<div class="section-label">WORKSPACE TOOLS</div>' : ''}<a href="#${id}" title="${label}"><span class="nav-icon" aria-hidden="true">${icons[id]}</span><span class="nav-label">${label}</span></a>`).join('');
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
    $('#context-name').textContent = state.session.context.label; $('#context-name').title = state.session.context.root;
    setConnected('Connected locally');
    const existing = await api('/api/requests'); existing.requests.forEach(activity);
    await navigate();
    setInterval(async () => {
      if (document.hidden) return;
      try { const events = await api(`/api/events?after=${state.eventSequence}`); state.eventSequence = events.sequence; setConnected('Connected locally'); }
      catch { setConnected('Reconnect needed'); }
    }, 10_000);
  } catch (error) {
    setConnected('Disconnected'); $('#main').innerHTML = errorView(error, false) + '<div class="feature-note">Reopen this workspace with <code>singularity-flow ui open</code> or <strong>Open SFlow in browser</strong> in VS Code. Your existing work has not been changed.</div>';
  }
}
void boot();

import { dataOf, escape, heading, icon } from './views.js';

let viewAssets;
function loadView() {
  viewAssets ??= Promise.all([
    fetch('/code-explainer-view.html').then(response => {
      if (!response.ok) throw new Error('Code Explainer’s browser view is unavailable.');
      return response.text();
    }),
    import('./code-explainer-view.js'),
    new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/code-explainer-view.css';
      link.onload = resolve;
      link.onerror = () => { link.remove(); reject(new Error('Code Explainer’s stylesheet could not load.')); };
      document.head.append(link);
    })
  ]).catch(error => { viewAssets = null; throw error; });
  return viewAssets;
}

function sourceRows(lines, first, selected) {
  return lines.map((text, index) => {
    const line = first + index;
    return `<li${line === selected ? ' aria-current="true"' : ''}><span>${line}</span><code>${escape(text)}</code></li>`;
  }).join('');
}

function diffRows(symbol) {
  return `<ul class="cx-source-lines" aria-label="Captured diff">${symbol.diff.map(row =>
    `<li data-diff="${escape(row.k)}"><span>${row.b ?? ''}</span><span>${row.a ?? ''}</span><span>${escape(row.k)}</span><code>${escape(row.t)}</code></li>`
  ).join('')}</ul>${symbol.diffTruncated ? '<p class="cx-preview-note">Showing part of the captured diff.</p>' : ''}`;
}

/** Connect the shared view to the selected browser checkout. Only the view's issued IDs are used. */
export function mountCodeExplainer(root, { operation, editor, ask, navigate }) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const $ = selector => root.querySelector(selector);
  let receive = () => {}, teardown, snapshot, repository, repositoryPath = null;
  let graphRequest = 0, repoRequest = 0, previewRequest = 0;
  let view = 'changes', scope = null, depth = 1;
  let lastMessage = 0;
  let presentation;
  const active = () => !signal.aborted && root.isConnected;
  root.className = 'cx-browser';
  root.innerHTML = heading('Code Explainer', '', editor)
    + `<div class="cx-browser-error" role="status" hidden><p></p><button type="button" data-cx-retry>${icon('history')} Retry</button></div>
      <div data-cx-mount></div>
      <dialog class="cx-source-dialog" aria-labelledby="cx-preview-title">
        <header><div><h2 id="cx-preview-title"></h2><p id="cx-preview-subtitle"></p></div>
          <button type="button" class="icon-button" aria-label="Close preview">${icon('close')}</button>
        </header><div id="cx-preview-body"></div>
      </dialog>`;

  function message(type, fields = {}) {
    if (active()) receive({ type, ...fields });
  }
  function notice(text, tone = 'warn') {
    message('cx.notice', { text, tone });
  }
  function startupError(error) {
    $('[data-cx-mount]').setAttribute('aria-busy', 'false');
    $('.cx-browser-error p').textContent = error.message;
    $('.cx-browser-error').hidden = false;
  }
  async function readMap(next, path = null, callDepth = depth) {
    const result = await operation(`code.${next}`, { depth: callDepth, ...(path ? { scope: path } : {}) });
    const data = dataOf(result.value)?.codeMap;
    if (!data?.model) throw new Error('SFlow returned no code map for this checkout.');
    return data;
  }
  async function graph(next = view, path = scope, focus = null) {
    const current = ++graphRequest;
    const target = next === 'repository' ? path : null;
    message('cx.progress', { text: next === 'changes' ? 'Reading code changes…' : 'Mapping source in this checkout…' });
    $('.cx-browser-error').hidden = true;
    try {
      const data = await readMap(next, target);
      if (!active() || current !== graphRequest) return;
      view = next; scope = target;
      snapshot = data;
      const selected = focus && data.model.symbols.find(symbol => symbol.file === focus.file && symbol.line === focus.line);
      message('cx.model', { model: data.model, reset: true, progress: null, focus: selected?.id });
      if (focus && !selected) notice('This declaration changed or falls outside the current view. Refresh the folder and choose it again.');
    } catch (error) {
      if (!active() || current !== graphRequest) return;
      message('cx.progress', { text: null });
      if (snapshot) notice(error.message, 'bad');
      else {
        message('cx.empty', { text: error.message });
        startupError(error);
      }
    }
  }
  async function folders(next, fresh = false) {
    const current = ++repoRequest;
    repositoryPath = next;
    repository = null;
    message('cx.repository', { path: next, loading: true });
    try {
      const data = !fresh && next === scope && view === 'repository' && snapshot?.repository
        ? snapshot : await readMap('repository', next);
      if (!active() || current !== repoRequest) return;
      repository = data.repository;
      message('cx.repository', { path: next, explanation: repository });
    } catch (error) {
      if (current === repoRequest) message('cx.repository', { path: next, error: error.message });
    }
  }
  const dialog = $('dialog');
  const previewBody = $('#cx-preview-body');
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { previewRequest += 1; });
  function preview(title, subtitle, html) {
    $('#cx-preview-title').textContent = title;
    $('#cx-preview-subtitle').textContent = subtitle;
    previewBody.innerHTML = html;
    if (!dialog.open) dialog.showModal();
  }
  async function openSource(file, line = 1) {
    const source = snapshot.sources.find(item => item.path === file);
    if (!source) { notice('This file has no source preview in this view. Open its folder in Map.'); return; }
    const current = ++previewRequest;
    preview(file, `Line ${line}`, '<p class="cx-preview-note" role="status">Reading the captured source…</p>');
    try {
      const result = await operation('code.source', { file, line, sha256: source.sha256 });
      if (!active() || current !== previewRequest) return;
      const value = dataOf(result.value)?.codeMap;
      if (!value?.lines) throw new Error('SFlow returned no source preview.');
      const end = value.first + value.lines.length - 1;
      preview(file, value.lines.length ? `Lines ${value.first}–${end} of ${value.total}` : 'Empty file',
        `<ul class="cx-source-lines" aria-label="Source excerpt">${sourceRows(value.lines, value.first, line)}</ul>`);
      previewBody.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (active() && current === previewRequest) preview(file, `Line ${line}`, `<p class="cx-preview-note" role="alert">${escape(error.message)}</p>`);
    }
  }
  function openDiff(symbol) {
    if (!symbol?.diff.length) { notice('No line diff was captured for this declaration.'); return; }
    previewRequest += 1;
    preview(symbol.qualifiedName, symbol.file ?? 'Captured change', diffRows(symbol));
  }
  async function changeExplorer(symbol) {
    const current = ++previewRequest;
    preview('Change Explorer', '', '<p class="cx-preview-note" role="status">Reading the captured change…</p>');
    try {
      const currentChange = view === 'changes' ? snapshot : await readMap('changes');
      if (!active() || current !== previewRequest) return;
      const rows = currentChange.model.symbols.filter(item => item.diff.length);
      if (!rows.length) {
        preview('Change Explorer', '', '<p class="cx-preview-note">There are no captured line diffs in this view.</p>');
        return;
      }
      const chosen = rows.find(item => item.id === symbol?.id) ?? rows[0];
      preview('Change Explorer', 'Captured line diffs',
        `<label class="cx-preview-picker">Declaration <select>${rows.map(item =>
          `<option value="${escape(item.id)}"${item === chosen ? ' selected' : ''}>${escape(item.file ?? '')} · ${escape(item.qualifiedName)}</option>`
        ).join('')}</select></label><div data-cx-diff-body>${diffRows(chosen)}</div>`);
      previewBody.querySelector('select').onchange = event => {
        const selected = rows.find(item => item.id === event.target.value);
        if (selected) $('[data-cx-diff-body]').innerHTML = diffRows(selected);
      };
    } catch (error) {
      if (active() && current === previewRequest) preview('Change Explorer', '', `<p class="cx-preview-note" role="alert">${escape(error.message)}</p>`);
    }
  }
  async function share(action, model, symbol) {
    const { changePrompt, copilotPrompt, explanationText, exportDocument } = await import('./code-explainer-model.js');
    if (!active() || snapshot.model.id !== model.id) return;
    if (action === 'cx.ask') {
      ask(((symbol && copilotPrompt(model, symbol.id)) || changePrompt(model)).slice(0, 2000));
    } else if (action === 'cx.copy' && symbol) {
      const text = explanationText(model, symbol.id);
      try { await navigator.clipboard.writeText(text); notice('Explanation copied.', 'ok'); }
      catch { if (active()) preview('Copy explanation', symbol.qualifiedName, `<textarea readonly rows="8">${escape(text)}</textarea>`); }
    } else if (action === 'cx.export') {
      const report = exportDocument(model, new Date().toISOString());
      report.note = 'Derived from a captured change and static code analysis in the selected checkout. Test references and requirement tags are links to inspect.';
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'code-explanation-' + (model.story?.workId ?? model.repository.name).replace(/[^A-Za-z0-9._-]/g, '-') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  function postMessage(request) {
    if (!active()) return;
    if (request.type === 'cx.ready') { void graph(); return; }
    const model = snapshot?.model;
    if (!model || request.model !== model.id || !Number.isSafeInteger(request.request) || request.request <= lastMessage) return;
    lastMessage = request.request;
    const symbol = model.symbols.find(item => item.id === request.symbol);
    switch (request.type) {
      case 'cx.reindex': void graph(); break;
      case 'cx.depth':
        if ([1, 2, 3].includes(request.depth)) { depth = request.depth; void graph(); }
        break;
      case 'cx.view':
        if (request.view === 'full') void graph('repository', scope);
        else if (request.view === 'delta') void graph('changes');
        break;
      case 'cx.scope': {
        const area = model.areas.list[request.index];
        if (area || request.index === -1) void graph('repository', area?.path ?? null);
        break;
      }
      case 'cx.repository': {
        if (request.to === 'root') void folders(null);
        else if (request.to === 'up') void folders(repositoryPath?.split('/').slice(0, -1).join('/') || null);
        else if (request.to === 'refresh') void folders(repositoryPath, true);
        else if (request.to === 'entry' && repository?.entries[request.index]) void folders(repository.entries[request.index].path);
        break;
      }
      case 'cx.repoOpen': {
        const file = repository?.files[request.index];
        if (file?.symbols.some(item => item.line === request.line)) {
          void graph('repository', repositoryPath, { file: file.path, line: request.line });
        }
        break;
      }
      case 'cx.open': if (symbol?.file && symbol.status !== 'removed') void openSource(symbol.file, symbol.line ?? 1); break;
      case 'cx.openModule': {
        const file = model.modules.find(item => item.id === request.module);
        if (file?.path) void openSource(file.path);
        break;
      }
      case 'cx.openLine':
        if (symbol?.file && request.line >= symbol.start && request.line <= symbol.end) void openSource(symbol.file, request.line);
        break;
      case 'cx.openTest': {
        const reference = symbol?.tests[request.index];
        if (reference) void openSource(reference.path, reference.line);
        break;
      }
      case 'cx.openSite': {
        const edge = model.edges.find(item => item.id === request.edge);
        const file = model.symbols.find(item => item.id === edge?.from)?.file;
        if (file && edge.sites.includes(request.line)) void openSource(file, request.line);
        break;
      }
      case 'cx.diff': openDiff(symbol); break;
      case 'cx.changeExplorer': void changeExplorer(symbol); break;
      case 'cx.ask':
      case 'cx.copy':
      case 'cx.export':
        void share(request.type, model, symbol).catch(error => notice(error.message, 'bad'));
        break;
      case 'cx.story':
        if (model.story && request.to === 'journey') navigate('stories/' + encodeURIComponent(model.story.workId));
        else if (request.to === 'approvals') navigate('decisions');
        break;
    }
  }

  async function start() {
    $('[data-cx-mount]').setAttribute('aria-busy', 'true');
    try {
      const [markup, { default: mountView }] = await loadView();
      if (!active()) return;
      const panel = $('[data-cx-mount]');
      panel.innerHTML = markup;
      const pathForm = document.createElement('form');
      pathForm.className = 'cx-path-form';
      pathForm.innerHTML = '<input type="search" aria-label="Repository-relative path" placeholder="Folder or file path" maxlength="1000"><button type="submit" class="cx-btn">Open</button>';
      pathForm.onsubmit = event => {
        event.preventDefault();
        const path = pathForm.querySelector('input').value.trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
        void folders(path && path !== '.' ? path : null);
      };
      $('#cx-repo-scope').insertAdjacentElement('afterend', pathForm);
      teardown = mountView({
        embedded: true, postMessage, subscribe: callback => { receive = callback; },
        getState: () => presentation, setState: value => { presentation = value; }
      });
      panel.setAttribute('aria-busy', 'false');
    } catch (error) {
      if (active()) startupError(error);
    }
  }
  $('[data-cx-retry]').onclick = () => { if (teardown) void graph(); else void start(); };
  void start();
  return () => {
    lifetime.abort();
    if (dialog.open) dialog.close();
    teardown?.();
  };
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const DOCUMENTS_CANVAS_ID = 'singularity-flow-documents';
export const DOCUMENTS_INSTANCE_ID = 'singularity-flow-documents';

export const DOCUMENTS_HELP = `Singularity Flow documents

  /documents
  /documents list [WORK-ID]
  /documents view <DOCUMENT-ID|PATH>

The command opens the Documents canvas when the Copilot host supports canvases.
Otherwise it prints the same catalog or document in the session timeline.`;

function safeValue(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > 2048 || CONTROL_CHARACTERS.test(normalized)) throw new Error(`${label} contains invalid characters or is too long.`);
  return normalized;
}

export function parseDocumentsArguments(raw = '') {
  const value = String(raw).trim();
  if (!value || value === 'list') return { action: 'list', workId: null, reference: null };
  if (['help', '-h', '--help'].includes(value)) return { action: 'help', workId: null, reference: null };

  const list = value.match(/^list\s+(.+)$/i);
  if (list) return { action: 'list', workId: safeValue(list[1], 'Work ID'), reference: null };

  const view = value.match(/^view\s+(.+)$/i);
  if (view) return { action: 'view', workId: null, reference: safeValue(view[1], 'Document reference') };

  throw new Error(`Unknown documents action '${value}'. Use /documents, /documents list [WORK-ID], or /documents view <DOCUMENT-ID>.`);
}

export function flowArguments(request, { json = false } = {}) {
  if (request.action === 'list') {
    const args = ['documents', 'list'];
    if (request.workId) args.push(request.workId);
    if (json) args.push('--json');
    return args;
  }
  if (request.action === 'view') {
    const args = ['documents', 'view', request.reference];
    if (request.workId) args.push('--work-id', request.workId);
    if (json) args.push('--json');
    return args;
  }
  throw new Error(`Action '${request.action}' does not invoke the Singularity Flow CLI.`);
}

export function inferWorkId(records = []) {
  for (const record of records) {
    const match = String(record.path ?? '').match(/\.singularity\/work-items\/([^/]+)\//);
    if (match) return match[1];
  }
  return null;
}

export function renderDocumentsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Singularity Flow Documents</title>
  <style>
    :root { color-scheme: dark; --bg: #0d1117; --panel: #151b23; --panel2: #1c2430; --line: #30363d; --text: #f0f6fc; --muted: #8b949e; --blue: #2f81f7; --green: #3fb950; --amber: #d29922; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input { font: inherit; }
    .shell { display: grid; grid-template-rows: auto auto 1fr; min-height: 100vh; }
    header { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: #111720; }
    .brand { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(145deg, #1f6feb, #8957e5); font-weight: 800; }
    h1 { margin: 0; font-size: 16px; }
    .subtitle { color: var(--muted); font-size: 12px; }
    .spacer { flex: 1; }
    .button { border: 1px solid var(--line); border-radius: 7px; padding: 7px 11px; background: var(--panel2); color: var(--text); cursor: pointer; }
    .button:hover, .button:focus-visible { border-color: var(--blue); outline: none; }
    .tabs { display: flex; gap: 4px; padding: 9px 18px 0; border-bottom: 1px solid var(--line); background: #111720; }
    .tab { border: 0; border-bottom: 2px solid transparent; padding: 8px 12px 10px; background: transparent; color: var(--muted); cursor: pointer; }
    .tab.active { border-color: var(--blue); color: var(--text); }
    main { min-height: 0; display: grid; grid-template-columns: minmax(260px, 34%) 1fr; }
    aside { min-height: 0; overflow: auto; border-right: 1px solid var(--line); background: var(--panel); }
    .search-wrap { position: sticky; top: 0; z-index: 2; padding: 12px; background: var(--panel); border-bottom: 1px solid var(--line); }
    #search { width: 100%; border: 1px solid var(--line); border-radius: 7px; padding: 9px 10px; background: var(--bg); color: var(--text); }
    #search:focus { border-color: var(--blue); outline: none; }
    #list { padding: 7px; }
    .document { width: 100%; border: 1px solid transparent; border-radius: 8px; padding: 10px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .document:hover { background: var(--panel2); }
    .document.selected { border-color: var(--blue); background: rgba(47,129,247,.12); }
    .document-title { display: flex; align-items: center; gap: 7px; font-weight: 650; }
    .document-meta { margin-top: 4px; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kind { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); }
    .kind.input { background: var(--amber); } .kind.workflow { background: #a371f7; } .kind.generated { background: var(--green); }
    article { min-width: 0; min-height: 0; overflow: auto; padding: 22px; }
    .empty { display: grid; place-items: center; min-height: 60vh; color: var(--muted); text-align: center; }
    .detail-header { display: flex; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 16px; }
    .detail-header h2 { margin: 0 0 5px; font-size: 20px; overflow-wrap: anywhere; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .chip { border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; color: var(--muted); font-size: 12px; }
    .location { margin: 16px 0; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--muted); overflow-wrap: anywhere; }
    pre { margin: 0; padding: 18px; border: 1px solid var(--line); border-radius: 9px; background: #080c12; color: #d8dee9; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    a { color: #58a6ff; }
    .error { margin: 18px; padding: 12px; border: 1px solid #f85149; border-radius: 8px; background: rgba(248,81,73,.1); color: #ffb3ad; }
    .status { color: var(--muted); font-size: 12px; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; grid-template-rows: minmax(220px, 40vh) 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand">SF</div>
      <div><h1>Documents</h1><div id="context" class="subtitle">Singularity Flow work-item artifacts</div></div>
      <div class="spacer"></div><span id="status" class="status">Loading…</span><button id="refresh" class="button" type="button">Refresh</button>
    </header>
    <nav class="tabs" aria-label="Document categories">
      <button class="tab active" data-filter="all" type="button">All</button>
      <button class="tab" data-filter="generated" type="button">Generated</button>
      <button class="tab" data-filter="input" type="button">Inputs</button>
      <button class="tab" data-filter="workflow" type="button">Workflow</button>
    </nav>
    <main>
      <aside><div class="search-wrap"><input id="search" type="search" placeholder="Search ID, phase, title, or path" aria-label="Search documents"></div><div id="list"></div></aside>
      <article id="detail"><div class="empty"><div><strong>Select a document</strong><br>Choose an artifact or supporting input from the list.</div></div></article>
    </main>
  </div>
  <script>
    const state = { documents: [], filter: 'all', query: '', selected: null, initial: null };
    const list = document.getElementById('list');
    const detail = document.getElementById('detail');
    const status = document.getElementById('status');
    const context = document.getElementById('context');
    const category = record => record.type === 'artifact' ? 'generated' : (record.type === 'file' || record.type === 'url') ? 'input' : 'workflow';
    const location = record => record.url || record.path || '';
    const setStatus = message => { status.textContent = message; };
    const button = (text, className) => { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.className = className; return el; };

    function visibleDocuments() {
      const query = state.query.toLowerCase();
      return state.documents.filter(record => (state.filter === 'all' || category(record) === state.filter) && (!query || [record.id, record.label, record.phase, location(record)].some(value => String(value || '').toLowerCase().includes(query))));
    }

    function renderList() {
      list.replaceChildren();
      const records = visibleDocuments();
      if (!records.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.style.minHeight = '180px'; empty.textContent = 'No matching documents.'; list.append(empty); return; }
      for (const record of records) {
        const item = button('', 'document' + (state.selected === record.id ? ' selected' : ''));
        const title = document.createElement('div'); title.className = 'document-title';
        const dot = document.createElement('span'); dot.className = 'kind ' + category(record);
        const label = document.createElement('span'); label.textContent = record.label || record.id;
        title.append(dot, label);
        const meta = document.createElement('div'); meta.className = 'document-meta'; meta.textContent = [record.id, record.phase, location(record)].filter(Boolean).join(' · ');
        item.append(title, meta); item.addEventListener('click', () => showDocument(record.id)); list.append(item);
      }
    }

    function appendChip(container, value) { if (!value) return; const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = value; container.append(chip); }

    async function copyText(value) {
      try { await navigator.clipboard.writeText(value); setStatus('Copied'); }
      catch { setStatus('Copy unavailable'); }
    }

    function renderDetail(result) {
      const record = result.record; detail.replaceChildren();
      const header = document.createElement('div'); header.className = 'detail-header';
      const heading = document.createElement('div'); heading.style.flex = '1';
      const title = document.createElement('h2'); title.textContent = record.label || record.id;
      const id = document.createElement('div'); id.className = 'subtitle'; id.textContent = record.id;
      const chips = document.createElement('div'); chips.className = 'chips';
      appendChip(chips, record.type); appendChip(chips, record.phase); appendChip(chips, record.status); appendChip(chips, record.mimeType); appendChip(chips, record.generation != null ? 'generation ' + record.generation : null);
      heading.append(title, id, chips);
      const copy = button('Copy reference', 'button'); copy.addEventListener('click', () => copyText(record.id));
      header.append(heading, copy); detail.append(header);
      const place = document.createElement('div'); place.className = 'location'; place.textContent = record.url || result.absolutePath || record.path || 'No location'; detail.append(place);
      if (record.url) { const link = document.createElement('a'); link.href = record.url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Open external document'; detail.append(link); }
      else if (result.binary) { const binary = document.createElement('div'); binary.className = 'empty'; binary.style.minHeight = '220px'; binary.textContent = 'Binary document — open the path shown above in the appropriate desktop viewer.'; detail.append(binary); }
      else { const content = document.createElement('pre'); content.textContent = result.content == null ? 'This document has no text preview.' : result.content; detail.append(content); }
    }

    async function showDocument(reference) {
      state.selected = reference; renderList(); setStatus('Loading document…');
      try {
        const response = await fetch('/api/document?reference=' + encodeURIComponent(reference));
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Unable to load document.');
        renderDetail(result); setStatus('Ready');
      } catch (error) { detail.innerHTML = ''; const box = document.createElement('div'); box.className = 'error'; box.textContent = error.message; detail.append(box); setStatus('Error'); }
    }

    async function load(refresh = false) {
      setStatus('Loading…');
      try {
        const response = await fetch('/api/state' + (refresh ? '?refresh=1' : '')); const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to load document catalog.');
        state.documents = result.documents || []; state.initial = result.selectedReference || state.initial;
        context.textContent = [result.workId, result.cwd].filter(Boolean).join(' · ') || 'Singularity Flow work-item artifacts';
        renderList(); setStatus(state.documents.length + ' document' + (state.documents.length === 1 ? '' : 's'));
        const preferred = state.initial && state.documents.find(record => record.id === state.initial || record.path === state.initial);
        if (preferred) { state.initial = null; await showDocument(preferred.id); }
        else if (!state.selected && state.documents.length) await showDocument(state.documents[0].id);
      } catch (error) { list.innerHTML = ''; const box = document.createElement('div'); box.className = 'error'; box.textContent = error.message; list.append(box); setStatus('Error'); }
    }

    document.getElementById('search').addEventListener('input', event => { state.query = event.target.value; renderList(); });
    document.getElementById('refresh').addEventListener('click', () => load(true));
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => { for (const item of document.querySelectorAll('.tab')) item.classList.toggle('active', item === tab); state.filter = tab.dataset.filter; renderList(); });
    load();
  </script>
</body>
</html>`;
}

import { dataOf, empty, errorView, escape, heading, icon, loading, pill, words } from './views.js';

const lenses = [
  ['calls', 'Call map'], ['logic', 'Logic'], ['flow', 'Data flow'],
  ['concepts', 'Concepts'], ['entities', 'Data types'], ['trace', 'Requirements & tests']
];
const count = (number, singular, plural = `${singular}s`) => `${number} ${number === 1 ? singular : plural}`;
const blank = message => `<p class="cx-empty">${escape(message)}</p>`;
const modeButton = (view, active) => `<button type="button" data-cx-view="${view}" aria-pressed="${view === active}">${words(view)}</button>`;
const sourcePath = symbol => `${symbol.file ?? ''}${symbol.line ? `:${symbol.line}` : ''}`;
const fileName = file => file.split('/').at(-1);
const pathButton = (file, label, decoration = '') => `<button type="button" class="cx-path-button" data-cx-path="${escape(file)}">${decoration}<span>${escape(label)}</span></button>`;
const statusLabels = { added: 'Added', modified: 'Edited', removed: 'Removed', deleted: 'Deleted', renamed: 'Renamed' };

function changeMark(status) {
  return Object.hasOwn(statusLabels, status)
    ? `<span class="cx-change cx-${status}">${statusLabels[status]}</span>` : '';
}

function symbolLink(symbol, detail = '', title = '') {
  return `<button type="button" class="cx-node" data-cx-symbol="${escape(symbol.id)}"${title ? ` title="${escape(title)}"` : ''}><strong>${escape(symbol.name)}</strong>
    <small>${escape(detail || sourcePath(symbol))}</small></button>`;
}

function folders(data, scope) {
  const parts = scope?.split('/') ?? [];
  const crumbs = [pathButton('', 'Repository')];
  for (let index = 0; index < parts.length; index += 1) {
    crumbs.push(index === parts.length - 1 ? `<span aria-current="location">${escape(parts[index])}</span>`
      : pathButton(parts.slice(0, index + 1).join('/'), parts[index]));
  }
  return `<div class="cx-folder-tools">
    <nav class="cx-breadcrumb" aria-label="Repository path">${crumbs.join('<span aria-hidden="true">/</span>')}</nav>
    <form data-cx-go><label class="sr-only" for="cx-path">Repository-relative path</label>
      <input id="cx-path" name="path" placeholder="Open a folder or file by path" value="${escape(scope)}" maxlength="1000">
      <button type="submit">Go</button></form>
    ${data?.entries.length ? `<details class="cx-folders"${data.sourceFiles ? '' : ' open'}>
      <summary>Browse folders and files</summary><div class="cx-folder-list">${data.entries.map(entry => pathButton(entry.path,
        `${fileName(entry.path)}${entry.kind === 'folder' ? ` · ${count(entry.files, 'file')}` : ''}`, icon(entry.kind === 'folder' ? 'checkout' : 'code'))).join('')}</div>
    </details>` : ''}</div>`;
}

function outline(data, symbols, selected, query) {
  const term = query.trim().toLowerCase();
  const files = data.modules.filter(file => term || data.view === 'repository' || file.status !== 'unchanged'
    || file.id === symbols.get(selected)?.moduleId);
  const groups = files.map(file => {
    const fileMatches = file.path.toLowerCase().includes(term);
    const matches = file.symbolIds.map(id => symbols.get(id)).filter(item => item &&
      (fileMatches || item.name.toLowerCase().includes(term)));
    if (!fileMatches && !matches.length) return '';
    return `<div class="cx-file"><div class="cx-file-title" title="${escape(file.path)}">${icon('code')}
      <span><strong>${escape(fileName(file.path))}</strong><small>${escape(file.path)}</small></span>${changeMark(file.status)}</div>
      ${matches.length ? matches.map(symbol => `<button type="button" class="cx-symbol" data-cx-symbol="${escape(symbol.id)}"
        aria-current="${symbol.id === selected}"><span>${escape(symbol.name)}</span><small>${symbol.line ?? ''}</small></button>`).join('')
        : '<p class="cx-file-none">No declarations in this view</p>'}</div>`;
  }).filter(Boolean);
  return groups.join('') || blank(term ? 'No files or declarations match your search.' : 'No code declarations in this scope.');
}

function callMap(data, symbols, symbol) {
  if (!symbol) return blank('Select a declaration to follow its calls.');
  function neighbors(endpoint, peer) {
    const links = data.calls.filter(edge => edge[endpoint] === symbol.id);
    const peers = new Map();
    for (const link of links) {
      const target = symbols.get(link[peer]);
      if (target && !peers.has(target.id)) peers.set(target.id, { target, line: link.line, caller: symbols.get(link.from)?.file });
    }
    return [...peers.values()].map(({ target, line, caller }) =>
      symbolLink(target, '', line == null || !caller ? '' : `Call at ${caller}:${line}`)).join('');
  }
  return `<div class="cx-lens-heading"><div><h2>Call map</h2><p>Call links are inferred from names and imports in the files shown.</p></div></div>
    <div class="cx-graph">
      <section aria-label="Callers"><h3>Called by</h3><div class="cx-node-list">${neighbors('to', 'from') || blank('No callers found in this view.')}</div></section>
      <span class="cx-arrow">${icon('right')}</span>
      <section aria-label="Selected declaration"><h3>Selected</h3><div class="cx-node cx-selected-node"><strong>${escape(symbol.name)}</strong>
        <small>${escape(sourcePath(symbol))}</small></div></section>
      <span class="cx-arrow">${icon('right')}</span>
      <section aria-label="Called declarations"><h3>Calls</h3><div class="cx-node-list">${neighbors('from', 'to') || blank('No calls found in this view.')}</div></section>
    </div>`;
}

function logicView(symbol) {
  const logic = symbol?.logic;
  if (!logic?.rows.length) return blank('No logic was identified for this declaration.');
  return `<div class="cx-lens-heading"><div><h2>Logic</h2><p>Branches and statements in source order.</p></div>
    ${symbol.metrics ? pill(count(symbol.metrics.decisions, 'decision'), 'purple') : ''}</div>
    <ol class="cx-logic">${logic.rows.map(row => `<li><span class="cx-line-no">${row.line ?? ''}</span>
      <code class="cx-indent-${row.depth}">${row.kind !== 'step' ? `<b>${escape(row.kind)}</b> ` : ''}${escape(row.text)}</code></li>`).join('')}</ol>
    ${logic.partial ? '<p class="cx-note">Showing part of this declaration’s logic.</p>' : ''}`;
}

function flowView(flow, symbols, selectedEntry) {
  const entry = flow.entries.find(item => item.id === selectedEntry) ?? flow.entries[0];
  if (!entry) return blank('No application entry points were identified in these files. Open the folder containing a UI, route or task entry.');
  const nodes = new Map(flow.nodes.map(node => [node.id, node]));
  const pathEdges = new Set(flow.paths[entry.id]?.edges ?? []);
  const edges = flow.edges.filter(edge => pathEdges.has(edge.id));
  function nodeLabel(id) {
    const node = nodes.get(id);
    const symbol = symbols.get(node?.symbol);
    return symbol ? symbolLink(symbol, node.label) : `<span class="cx-node cx-flow-node">${escape(node?.label)}</span>`;
  }
  return `<div class="cx-lens-heading"><div><h2>Data flow</h2><p>Connections SFlow found in the source.</p></div>
    <label class="cx-entry">Entry point<select data-cx-entry>${flow.entries.map(item => `<option value="${escape(item.id)}"
      ${item.id === entry.id ? 'selected' : ''}>${escape(item.label)}</option>`).join('')}</select></label></div>
    ${edges.length ? `<ul class="cx-flow-list">${edges.map(edge => `<li>${nodeLabel(edge.from)}
      <span class="cx-flow-edge">${escape(edge.label || words(edge.kind))} ${icon('right')}</span>${nodeLabel(edge.to)}</li>`).join('')}</ul>`
      : blank('No downstream links were identified for this entry point.') }`;
}

function conceptsView(concepts, modules, symbols) {
  const layers = concepts.layers.filter(layer => layer.modules.length);
  if (!layers.length && !concepts.concepts.length) return blank('No code groups were identified in this scope.');
  return `<div class="cx-lens-heading"><div><h2>Concepts</h2><p>Groups suggested by file roles and names in the code.</p></div></div>
    <div class="cx-layer-list">${layers.map(layer => `<details class="cx-record"><summary><strong>${escape(layer.label)}</strong>${pill(count(layer.modules.length, 'file'))}</summary>
      <ul>${layer.modules.map(item => `<li><code>${escape(modules.get(item.id)?.path ?? '')}</code> <small>${escape(item.reason)}</small></li>`).join('')}</ul></details>`).join('')}</div>
    ${concepts.concepts.length ? `<div class="cx-concepts">${concepts.concepts.map(concept => {
      const linked = concept.symbols.map(id => symbols.get(id)).filter(Boolean);
      return `<details class="cx-record"><summary><strong>${escape(concept.label)}</strong></summary>
        <div class="cx-linked-nodes">${linked.length ? linked.map(symbol => symbolLink(symbol)).join('') : (concept.modules?.length
          ? `<ul>${concept.modules.map(id => `<li><code>${escape(modules.get(id)?.path)}</code></li>`).join('')}</ul>` : blank('No declarations shown.'))}</div></details>`;
    }).join('')}</div>` : ''}`;
}

function entitiesView(entities, modules, symbols) {
  if (!entities.entities.length) return blank('No data types were identified in these files.');
  return `<div class="cx-lens-heading"><div><h2>Data types</h2><p>Classes, interfaces and data shapes found in the source.</p></div></div>
    <div class="cx-records">${entities.entities.map(entity => {
      const file = modules.get(entity.moduleId)?.path;
      const symbol = symbols.get(entity.symbol);
      const fields = entity.fields.map(field => [field.name, field.type]);
      fields.push(...entity.values.map(value => [value, null]));
      return `<details class="cx-record"><summary><strong>${escape(entity.name)}</strong>${pill(words(entity.kind))}</summary>
        <p class="cx-note"><code>${escape(file)}${entity.line ? `:${entity.line}` : ''}</code></p>
        ${fields.length ? `<ul>${fields.map(([name, type]) => `<li><code>${escape(name)}</code> ${type ? `<small>${escape(type)}</small>` : ''}</li>`).join('')}</ul>` : ''}
        ${symbol ? `<div class="cx-linked-nodes">${symbolLink(symbol)}</div>` : ''}</details>`;
    }).join('')}</div>`;
}

function traceView(data, modules, symbols) {
  if (data.view !== 'changes') return blank('Open Changes to see the requirements and retained test results for this work.');
  const { trace } = data;
  const tests = new Map(trace.tests.map(test => [test.id, test]));
  return `<div class="cx-lens-heading"><div><h2>Requirements &amp; tests</h2><p>Requirement links, tagged tests and recorded runs for these changes.</p></div></div>
    ${trace.requirements.length ? `<div class="cx-records">${trace.requirements.map(requirement => {
      const files = requirement.modules.map(id => modules.get(id)).filter(Boolean);
      const linked = requirement.tests.map(id => tests.get(id)?.path).filter(Boolean);
      const text = requirement.text ?? requirement.label;
      const code = files.map(file => {
        const declarations = file.symbolIds.map(id => symbols.get(id)).filter(Boolean);
        const target = declarations.find(symbol => symbol.status !== 'unchanged') ?? declarations[0];
        return target ? `<button type="button" class="cx-trace-file" data-cx-symbol="${escape(target.id)}"><code>${escape(file.path)}</code>${icon('right')}</button>`
          : `<code>${escape(file.path)}</code>`;
      }).join('');
      return `<details class="cx-record"><summary><strong>${escape(requirement.id)}</strong>
        ${pill(requirement.gap ? 'Coverage gap' : files.length || linked.length ? 'Linked' : 'Declared', requirement.gap ? 'gold' : '')}</summary>
        ${text && text !== requirement.id ? `<p>${escape(text)}</p>` : ''}
        <dl class="cx-trace-links"><dt>Code</dt><dd>${code || 'No linked files in this view'}</dd>
          <dt>Tests</dt><dd>${linked.length ? linked.map(file => `<code>${escape(file)}</code>`).join('') : 'No linked tests in this view'}</dd></dl>
        ${requirement.gap ? `<p class="cx-note">${escape(requirement.gap)}</p>` : ''}</details>`;
    }).join('')}</div>` : blank(trace.available ? 'No requirements were linked to this change view.' : 'This checkout has no captured Story trace for these changes.')}
    <h3 class="cx-runs-heading">Recorded runs</h3>
    ${trace.runs.length ? `<div class="cx-records">${trace.runs.map(run => `<div class="cx-record cx-run"><strong>${escape(run.label)}</strong>${pill(words(run.status), run.status === 'passed' ? 'green' : run.status === 'failed' ? 'red' : '')}</div>`).join('')}</div>`
      : blank('No test runs were retained for this change view.') }`;
}

function inspector(symbol) {
  if (!symbol) return '';
  const excerpt = symbol.excerpt;
  const diff = excerpt?.kind === 'diff';
  return `<section class="cx-inspector" aria-label="Selected code">
    <div class="cx-lens-heading"><div><h2 tabindex="-1">${escape(symbol.name)}</h2><p><code>${escape(sourcePath(symbol))}</code></p></div>
    <div class="cx-marks">${changeMark(symbol.status)}${symbol.added || symbol.removed
      ? `<span class="cx-delta"><b>+${symbol.added}</b><b>−${symbol.removed}</b></span>` : ''}</div></div>
    ${symbol.signature ? `<pre class="cx-signature"><code>${escape(symbol.signature)}</code></pre>` : ''}
    ${symbol.explanation.length ? `<div class="cx-explanation">${symbol.explanation.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}</div>` : ''}
    ${excerpt?.rows.length ? `<details class="cx-excerpt" open><summary>${diff ? 'Changed lines' : 'Source excerpt'}</summary>
      <div class="cx-code-lines"><table aria-label="${diff ? 'Changed lines' : 'Source excerpt'}">
        <thead class="sr-only"><tr>${diff ? '<th>Before</th><th>After</th><th>Change</th>' : '<th>Line</th>'}<th>Source</th></tr></thead>
        <tbody>${excerpt.rows.map(row =>
        `<tr class="${row.mark === '+' ? 'cx-line-added' : row.mark === '-' ? 'cx-line-removed' : ''}">
          ${diff ? `<td>${row.before ?? ''}</td>` : ''}<td>${row.after ?? ''}</td>${diff ? `<td>${escape(row.mark)}</td>` : ''}
          <td><code>${escape(row.text)}</code></td></tr>`).join('')}</tbody></table></div>
      ${excerpt.partial ? '<p class="cx-note">Showing part of this declaration.</p>' : ''}</details>` : ''}</section>`;
}

export async function mountCodeExplainer(root, { operation, editor }) {
  const $ = selector => root.querySelector(selector);
  let view = 'changes', scope = null, lens = 'calls', data = null, query = '';
  let selected = null, entry = null, request = 0;
  let symbols = new Map(), modules = new Map();
  root.className = 'cx-page';

  function showOutline() {
    $('[data-cx-outline]').innerHTML = outline(data, symbols, selected, query);
  }
  function showLens() {
    const symbol = symbols.get(selected);
    const panes = {
      calls: () => callMap(data, symbols, symbol), logic: () => logicView(symbol),
      flow: () => flowView(data.flow, symbols, entry), trace: () => traceView(data, modules, symbols),
      concepts: () => conceptsView(data.concepts, modules, symbols), entities: () => entitiesView(data.entities, modules, symbols)
    };
    $('[data-cx-body]').innerHTML = panes[lens]();
    $('[data-cx-inspector]').innerHTML = ['calls', 'logic'].includes(lens) ? inspector(symbol) : '';
    const walk = data.walkthrough.indexOf(selected);
    const counter = $('[data-cx-walk]');
    counter.hidden = data.walkthrough.length < 2 || !['calls', 'logic'].includes(lens);
    $('[data-cx-walk-count]').textContent = walk < 0 ? 'Walk changes' : `${walk + 1} of ${data.walkthrough.length}`;
    $('[data-cx-step="-1"]').disabled = walk <= 0;
    $('[data-cx-step="1"]').disabled = walk === data.walkthrough.length - 1;
  }
  function select(id, { openCalls = false, focusOutline = false } = {}) {
    if (!symbols.has(id)) return;
    selected = id;
    if (openCalls) setLens('calls'); else showLens();
    showOutline();
    if (focusOutline) {
      const button = [...root.querySelectorAll('.cx-symbol')].find(item => item.dataset.cxSymbol === id);
      (button ?? $('[data-cx-inspector] h2'))?.focus({ preventScroll: true });
    }
  }
  function setLens(next) {
    lens = next;
    root.querySelectorAll('[data-cx-lens]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.cxLens === lens)));
    showLens();
  }
  function frame(body, folderData = null, busy = false) {
    root.innerHTML = `${heading('Code Explainer', 'Explore calls, logic and the Story requirements behind your code.',
      `<button type="button" data-cx-reload ${busy ? 'disabled' : ''}>${icon('history')} Refresh</button>${editor}`)}
      <div class="cx-toolbar"><div class="segmented" role="group" aria-label="Code to explore">${modeButton('changes', view)}${modeButton('repository', view)}</div>
      ${folderData ? `<p class="cx-context">${escape([folderData.workId, folderData.branch].filter(Boolean).join(' · '))}</p>` : ''}</div>
      ${view === 'repository' ? folders(folderData, scope) : ''}${body}`;
  }
  function render() {
    const notice = data.notices.length ? `<div class="cx-notice" role="status">${data.notices.map(line => `<p>${escape(line)}</p>`).join('')}</div>` : '';
    if (view === 'changes' && !data.changedFiles && !data.trace.requirements.length && !data.trace.runs.length) {
      frame(notice + empty('No code changes found', 'Browse tracked files in this checkout to explore their calls and structure.',
        '<button type="button" data-cx-view="repository">Browse repository</button>', 'code'), data);
      return;
    }
    if (view === 'repository' && !data.modules.length) {
      frame(notice + empty('No source to show in this scope', 'Choose a folder or enter the path to a tracked source file.', '', 'code'), data);
      return;
    }
    frame(`${notice}<div class="cx-workspace"><aside class="card cx-outline">
      <div class="cx-outline-heading"><h2>${view === 'changes' ? 'Changed files' : 'Files'}</h2><p>${count(view === 'changes' ? data.changedFiles : data.sourceFiles, 'file')} · ${count(data.symbols.length, 'declaration')} in view</p>
        <label class="cx-search">${icon('search')}<span class="sr-only">Find a file or declaration</span><input type="search" placeholder="Find a file or declaration" data-cx-search value="${escape(query)}"></label></div>
      <div class="cx-outline-files" data-cx-outline></div></aside>
      <section class="card cx-detail">
        <div class="cx-lenses" role="group" aria-label="Code analysis view">${lenses.map(([key, label]) =>
          `<button type="button" data-cx-lens="${key}" aria-pressed="${lens === key}">${label}</button>`).join('')}</div>
        <div class="cx-walk" data-cx-walk hidden><span>Walk changes</span><div>
          <button type="button" data-cx-step="-1" aria-label="Previous change">${icon('left')}</button>
          <span data-cx-walk-count aria-live="polite"></span>
          <button type="button" data-cx-step="1" aria-label="Next change">${icon('right')}</button></div></div>
        <div class="cx-body" data-cx-body></div><div data-cx-inspector></div>
      </section></div>`, data);
    showOutline();
    showLens();
  }
  async function load(nextView = view, nextScope = scope, focusSelector = null) {
    const serial = ++request;
    const changedScope = nextView !== view || nextScope !== scope;
    view = nextView; scope = view === 'repository' ? nextScope : null;
    if (changedScope) { selected = null; entry = null; lens = 'calls'; query = ''; }
    frame(loading(view === 'changes' ? 'Reading code changes…' : 'Reading repository code…'), null, true);
    try {
      const result = await operation(`code.${view}`, view === 'repository' && scope ? { scope } : {});
      if (serial !== request || !root.isConnected) return;
      data = dataOf(result.value)?.codeMap;
      if (!data) throw new Error('SFlow returned no code map for this checkout.');
      symbols = new Map(data.symbols.map(symbol => [symbol.id, symbol]));
      modules = new Map(data.modules.map(module => [module.id, module]));
      if (!symbols.has(selected)) selected = data.walkthrough[0] ?? data.symbols.find(symbol => symbol.status !== 'unchanged')?.id
        ?? data.symbols[0]?.id ?? null;
      if (!selected && view === 'changes' && (data.trace.requirements.length || data.trace.runs.length)) lens = 'trace';
      render();
    } catch (error) {
      if (serial !== request || !root.isConnected) return;
      frame(errorView(error, { retry: false, title: 'Couldn’t read code in this checkout' }));
    }
    if (focusSelector) $(focusSelector)?.focus({ preventScroll: true });
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset;
    if ('cxReload' in action) void load(view, scope, '[data-cx-reload]');
    if (action.cxView && action.cxView !== view) void load(action.cxView, null, `[data-cx-view="${action.cxView}"]`);
    if ('cxPath' in action) void load('repository', action.cxPath || null, '#cx-path');
    if (action.cxLens) setLens(action.cxLens);
    if (action.cxSymbol) select(action.cxSymbol, { openCalls: !['calls', 'logic'].includes(lens), focusOutline: true });
    if (action.cxStep) select(data.walkthrough[data.walkthrough.indexOf(selected) + Number(action.cxStep)]);
  });
  root.addEventListener('input', event => {
    if (event.target.matches('[data-cx-search]')) { query = event.target.value; showOutline(); }
  });
  root.addEventListener('change', event => {
    if (event.target.matches('[data-cx-entry]')) {
      entry = event.target.value;
      showLens();
      $('[data-cx-entry]')?.focus({ preventScroll: true });
    }
  });
  root.addEventListener('submit', event => {
    if (!event.target.matches('[data-cx-go]')) return;
    event.preventDefault();
    const relative = new FormData(event.target).get('path').trim().replace(/^\.\//u, '').replace(/\/$/u, '');
    void load('repository', relative || null, '#cx-path');
  });
  await load();
}

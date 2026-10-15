/** Stable editor DOM: edits invalidate checked bytes; results never replace the source buffer. */
export const WORKFLOW_MARKUP_BODY = `
<header class="page-header"><h1>Create a workflow from tags</h1>
<p>Extend an installed starter, describe the work, and declare decisions, skills and instruction tags. Compilation is model-free; import and activation remain separate reviews.</p></header>
<label class="field" for="markup-source">Workflow markup</label>
<textarea id="markup-source" rows="22" maxlength="262144" spellcheck="false" aria-describedby="markup-hint"></textarea>
<p id="markup-hint" class="muted">Version 1 maps every starter phase to its own namespaced phase. Plain descriptions are guidance, not executable conditions. Use decisions for branching and max-attempts for backward rule routes.</p>
<div class="card-foot"><button id="markup-check">Check tags & routes</button><button id="markup-copilot" class="secondary">Draft / improve with Copilot…</button><button id="markup-import" class="secondary" disabled>Save bundle & review import…</button></div>
<p id="markup-status" role="status" aria-live="polite">Loading the example…</p>
<section id="markup-result" hidden><h2 id="markup-title"></h2><ol id="markup-phases"></ol>
<h3>Decisions and routes</h3><ul id="markup-routes"></ul>
<details><summary>Source-to-node mapping</summary><div id="markup-map"></div></details>
<p id="markup-meaning" class="muted"></p></section>`;

export const WORKFLOW_MARKUP_STYLE = `
#markup-source{box-sizing:border-box;width:100%;font-family:var(--vscode-editor-font-family,ui-monospace,monospace);resize:vertical}
#markup-result code,#markup-result pre{white-space:pre-wrap;overflow-wrap:anywhere}
#markup-result li{margin:8px 0}#markup-result button{text-align:left}
.card-foot{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.field{display:block;margin:12px 0 6px}
`;

export const WORKFLOW_MARKUP_SCRIPT = `
(() => {
  const byId = id => document.getElementById('markup-' + id);
  const source = byId('source'), check = byId('check'), save = byId('import'), copilot = byId('copilot');
  const api = window.__sfVscode;
  let revision = 0, checked = null, busy = false;
  const kept = api.getState ? api.getState() : null;
  if (kept && typeof kept.source === 'string') source.value = kept.source;
  function changed() {
    revision++; checked = null; save.disabled = true; byId('result').hidden = true;
    byId('status').textContent = 'Description changed. Check the exact tags and routes again.';
    if (api.setState) api.setState({source:source.value});
    api.postMessage({type:'markup.changed', revision});
  }
  source.addEventListener('input', changed);
  check.onclick = () => { if (busy) return; busy = true; checked = null; check.disabled = true; save.disabled = true;
    byId('status').textContent = 'Checking definition, dependency closure and native route simulation…';
    api.postMessage({type:'markup.check', source:source.value, revision}); };
  save.onclick = () => { if (busy || !checked) return; busy = true; save.disabled = true; check.disabled = true;
    api.postMessage({type:'markup.import', revision, sourceSha256:checked.sourceSha256, bundleSha256:checked.bundleSha256}); };
  copilot.onclick = () => api.postMessage({type:'markup.copilot', source:source.value});
  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'markup.example') {
      if (!source.value) source.value = message.source;
      byId('status').textContent = 'Edit the example, then check. Nothing has been imported.';
      return;
    }
    if (message.type === 'markup.error' || message.type === 'markup.done') {
      busy = false; check.disabled = false;
      if (message.revision !== revision) return;
      byId('status').textContent = message.message; save.disabled = !checked; return;
    }
    if (message.type !== 'markup.checked') return;
    busy = false; check.disabled = false;
    if (message.revision !== revision) return;
    checked = message.result; save.disabled = false;
    byId('status').textContent = 'Portable checks passed. Review the nodes before saving and importing.';
    byId('title').textContent = checked.workflow.label;
    const phases = byId('phases'); phases.replaceChildren();
    checked.workflow.phases.forEach(phase => { const li = document.createElement('li'); li.textContent = phase.label + ' · ' + phase.agent + ' (' + phase.id + ')'; phases.appendChild(li); });
    const routes = byId('routes'); routes.replaceChildren();
    checked.workflow.decisions.forEach(decision => { const li = document.createElement('li');
      li.textContent = decision.label + ' · after ' + decision.after + ' · ' + decision.kind + (decision.maxRounds ? ' · limit ' + decision.maxRounds + ', then human review' : '');
      const list = document.createElement('ul'); decision.routes.forEach(route => { const item = document.createElement('li'); item.textContent = route.label + ' → ' + route.to; list.appendChild(item); }); li.appendChild(list); routes.appendChild(li); });
    byId('meaning').textContent = checked.meaning;
    const map = byId('map'); map.replaceChildren();
    checked.sourceMap.forEach(binding => { const detail = document.createElement('details'), label = document.createElement('summary'), code = document.createElement('pre');
      label.textContent = binding.target + ' · line ' + binding.line; code.textContent = source.value.slice(binding.start, binding.end);
      detail.appendChild(label); detail.appendChild(code); map.appendChild(detail); });
    byId('result').hidden = false;
  });
  api.postMessage({type:'markup.ready'});
})();`;

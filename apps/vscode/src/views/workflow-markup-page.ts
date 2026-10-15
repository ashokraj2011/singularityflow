/** Stable editor DOM: edits invalidate checked bytes; results never replace the source buffer. */
export const WORKFLOW_MARKUP_BODY = `
<header class="page-header"><h1>Create a workflow with Copilot</h1>
<p>Describe what your team does. Copilot creates the markup; SFlow checks the resulting phases, agents, skills and routes before you import it.</p></header>
<label class="field" for="markup-intent">What should this workflow do?</label>
<textarea id="markup-intent" rows="7" maxlength="32768" aria-describedby="markup-intent-hint" placeholder="Intake a screenshot and acceptance criteria. Test the web app. If tests fail, repair the code and retest, up to 3 attempts. Keep human approval checkpoints and close with an evidence report."></textarea>
<p id="markup-intent-hint" class="muted">Use your own words: steps, pass/fail decisions, retry limits and human checkpoints. You do not need to write tags. Copilot will ask about concrete gaps and propose a checked draft here when its tool is available.</p>
<label class="field" for="markup-catalog-source">Reuse assets from</label><select id="markup-catalog-source"><option value="approved">Approved repository configuration</option><option value="installed">Installed starters only</option></select>
<details><summary>Find agents, skills, instructions and workflow contracts</summary>
<label class="field" for="markup-kind">Asset type</label><select id="markup-kind"><option value="">All types</option><option>agent</option><option>skill</option><option>instruction</option><option>command-skill</option><option>workflow</option><option>phase</option><option>template</option><option>approval-authority</option><option>constitution</option><option>quality-command</option><option>execution-task</option><option>mcp-server</option></select>
<label class="field" for="markup-query">Name, purpose or tag</label><input id="markup-query" maxlength="512" placeholder="angular, testing, framework:angular…" />
<div class="card-foot"><button id="markup-search" class="secondary">Search catalog</button><button id="markup-more" class="secondary" disabled>More</button></div><p id="markup-catalog-status" role="status"></p><ul id="markup-assets"></ul></details>
<div class="card-foot"><button id="markup-copilot" disabled>Create draft with Copilot…</button><button id="markup-open" class="secondary">Load Copilot draft…</button></div>
<p class="muted">1. Send the prepared request in Copilot. 2. Review its checked draft here, or load a saved XML file when the chat tool is unavailable. 3. Review the phases and routes, then import. Drafting uses your chat model; checking is model-free.</p>
<details id="markup-advanced"><summary>Advanced: inspect or edit markup</summary>
<label class="field" for="markup-source">Workflow markup</label>
<textarea id="markup-source" rows="22" maxlength="262144" spellcheck="false" aria-describedby="markup-hint"></textarea>
<p id="markup-hint" class="muted">Version 1 maps every starter phase to its own namespaced phase. Plain descriptions are guidance, not executable conditions. Use decisions for branching and max-attempts for backward rule routes.</p>
</details>
<div class="card-foot"><button id="markup-check" class="secondary">Check draft & routes</button><button id="markup-import" disabled>Save bundle & review import…</button></div>
<p id="markup-status" role="status" aria-live="polite">Loading the example…</p>
<section id="markup-result" hidden><h2 id="markup-title"></h2><ol id="markup-phases"></ol>
<h3>Decisions and routes</h3><ul id="markup-routes"></ul>
<h3>Intent coverage and reused assets</h3><ul id="markup-coverage"></ul>
<details><summary>Source-to-node mapping</summary><div id="markup-map"></div></details>
<p id="markup-meaning" class="muted"></p></section>`;

export const WORKFLOW_MARKUP_STYLE = `
#markup-source,#markup-intent{box-sizing:border-box;width:100%;resize:vertical}
#markup-source{font-family:var(--vscode-editor-font-family,ui-monospace,monospace)}
#markup-intent{font:inherit}#markup-advanced{margin-top:20px}
#markup-catalog-status,#markup-assets,#markup-coverage{overflow-wrap:anywhere}
#markup-result code,#markup-result pre{white-space:pre-wrap;overflow-wrap:anywhere}
#markup-result li{margin:8px 0}#markup-result button{text-align:left}
.card-foot{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.field{display:block;margin:12px 0 6px}
`;

export const WORKFLOW_MARKUP_SCRIPT = `
(() => {
  const byId = id => document.getElementById('markup-' + id);
  const source = byId('source'), intent = byId('intent'), check = byId('check'), save = byId('import'), copilot = byId('copilot'), open = byId('open');
  const catalogSource = byId('catalog-source'); let catalogPage = null, catalogRequest = 0;
  const api = window.__sfVscode;
  let revision = 0, checked = null, busy = false, hasDraft = false;
  const kept = api.getState ? api.getState() : null;
  if (kept && typeof kept.source === 'string') source.value = kept.source;
  if (kept && typeof kept.intent === 'string') intent.value = kept.intent;
  if (kept && kept.catalogSource === 'installed') catalogSource.value = 'installed';
  if (kept) hasDraft = kept.hasDraft === true;
  function retain() { if (api.setState) api.setState({source:source.value,intent:intent.value,hasDraft,catalogSource:catalogSource.value}); }
  function enableCopilot() { copilot.disabled = busy || (!intent.value.trim() && !hasDraft); }
  function setBusy(value) { busy = value; check.disabled = busy || !hasDraft; open.disabled = busy; enableCopilot(); }
  enableCopilot(); check.disabled = !hasDraft;
  function changed() {
    revision++; checked = null; save.disabled = true; byId('result').hidden = true;
    byId('status').textContent = hasDraft ? 'Draft or description changed. Check the exact draft and routes again.' : 'Description ready. Create a draft with Copilot, then load the saved XML here.';
    retain(); enableCopilot(); check.disabled = busy || !hasDraft;
    api.postMessage({type:'markup.changed', revision});
  }
  source.addEventListener('input', () => { hasDraft = true; changed(); });
  intent.addEventListener('input', changed);
  function clearCatalog() { catalogRequest++; catalogPage = null; byId('assets').replaceChildren(); byId('more').disabled = true; }
  catalogSource.addEventListener('change', () => { clearCatalog(); changed(); });
  byId('kind').addEventListener('change', clearCatalog); byId('query').addEventListener('input', clearCatalog);
  function search(more) { api.postMessage({type:'markup.catalog', request:++catalogRequest, catalogSource:catalogSource.value, kind:byId('kind').value, query:byId('query').value,
    cursor:more && catalogPage ? catalogPage.nextCursor : 0, expectedSource:more && catalogPage ? catalogPage.sourceSha256 : undefined});
    byId('catalog-status').textContent = 'Reading the selected declared catalog; no repository-wide scan…'; }
  byId('search').onclick = () => { catalogPage = null; search(false); };
  byId('more').onclick = () => { if (catalogPage && catalogPage.nextCursor != null) search(true); };
  check.onclick = () => { if (busy || !hasDraft) return; setBusy(true); checked = null; save.disabled = true;
    byId('status').textContent = 'Checking definition, dependency closure and native route simulation…';
    api.postMessage({type:'markup.check', source:source.value, intent:intent.value, catalogSource:catalogSource.value, revision}); };
  save.onclick = () => { if (busy || !checked) return; setBusy(true); save.disabled = true;
    api.postMessage({type:'markup.import', revision, sourceSha256:checked.sourceSha256, bundleSha256:checked.bundleSha256}); };
  copilot.onclick = () => { if (!busy) api.postMessage({type:'markup.copilot', intent:intent.value, source:hasDraft ? source.value : undefined, catalogSource:catalogSource.value, revision}); };
  open.onclick = () => { if (busy) return; setBusy(true); save.disabled = true;
    byId('status').textContent = 'Select the XML draft saved by Copilot…';
    api.postMessage({type:'markup.open', revision}); };
  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'markup.nativeBusy') { setBusy(true); byId('status').textContent = 'Checking the draft received directly from Copilot; no repository files are changed…'; return; }
    if (message.type === 'markup.nativeIdle') { setBusy(false); return; }
    if (message.type === 'markup.proposed') {
      if (message.revision !== revision) return;
      source.value = message.source; hasDraft = true; retain();
      message.type = 'markup.checked';
    }
    if (message.type === 'markup.catalogResult') {
      if (message.catalogSource !== catalogSource.value || message.request !== catalogRequest) return;
      catalogPage = message.result; byId('more').disabled = catalogPage.nextCursor == null;
      byId('catalog-status').textContent = catalogPage.total + ' matching assets. Source ' + catalogPage.sourceSha256 + '. Discovery grants no authority.';
      const assets = byId('assets'); assets.replaceChildren();
      catalogPage.entries.forEach(asset => { const li = document.createElement('li'), use = document.createElement('button');
        li.textContent = asset.kind + ': ' + asset.id + ' — ' + asset.description + ' [' + asset.tags.join(', ') + '] ';
        use.textContent = 'Use in intent'; use.disabled = !asset.available; use.onclick = () => { intent.value += ' [' + asset.kind + ':' + asset.id + ']'; changed(); };
        li.appendChild(use); assets.appendChild(li); }); return;
    }
    if (message.type === 'markup.catalogError') { if (message.request === catalogRequest) byId('catalog-status').textContent = message.message; return; }
    if (message.type === 'markup.example') {
      if (!source.value) source.value = message.source;
      byId('status').textContent = 'Describe your workflow above, or load a saved draft. An example is available under Advanced. Nothing has been imported.';
      return;
    }
    if (message.type === 'markup.loaded') {
      setBusy(false);
      if (message.revision !== revision) return;
      source.value = message.source; hasDraft = true; changed(); check.onclick(); return;
    }
    if (message.type === 'markup.error' || message.type === 'markup.done') {
      setBusy(false);
      if (message.revision !== revision) return;
      byId('status').textContent = message.message; save.disabled = !checked; return;
    }
    if (message.type !== 'markup.checked') return;
    setBusy(false);
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
    const coverage = byId('coverage'); coverage.replaceChildren();
    if (checked.intent) checked.intent.requirements.forEach(item => { const li = document.createElement('li'); li.textContent = item.statement + ' → ' + item.targets.join(', '); coverage.appendChild(li); });
    (checked.reusedAssets || []).forEach(item => { const li = document.createElement('li'); li.textContent = (item.id === item.as ? 'Reused ' : 'Derived ') + item.kind + ': ' + item.id + (item.id === item.as ? '' : ' → ' + item.as); coverage.appendChild(li); });
    if (checked.intent) { const li = document.createElement('li'); li.textContent = 'Coverage is structural; a human must review whether the generated workflow matches the intent.'; coverage.appendChild(li); }
    const map = byId('map'); map.replaceChildren();
    checked.sourceMap.forEach(binding => { const detail = document.createElement('details'), label = document.createElement('summary'), code = document.createElement('pre');
      label.textContent = binding.target + ' · line ' + binding.line; code.textContent = source.value.slice(binding.start, binding.end);
      detail.appendChild(label); detail.appendChild(code); map.appendChild(detail); });
    byId('result').hidden = false;
  });
  api.postMessage({type:'markup.ready'});
})();`;

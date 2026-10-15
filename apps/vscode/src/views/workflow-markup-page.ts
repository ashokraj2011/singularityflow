/** Stable editor DOM: edits invalidate checked bytes; results never replace the source buffer. */
export const WORKFLOW_MARKUP_BODY = `
<header class="page-header"><h1>Create a workflow with Copilot</h1>
<p>Describe what your team does. Copilot creates the markup; SFlow checks the resulting phases, agents, skills and routes before you import it.</p></header>
<label class="field" for="markup-intent">What should this workflow do?</label>
<textarea id="markup-intent" rows="7" maxlength="32768" aria-describedby="markup-intent-hint" placeholder="Intake a screenshot and acceptance criteria. Test the web app. If tests fail, repair the code and retest, up to 3 attempts. Keep human approval checkpoints and close with an evidence report."></textarea>
<p id="markup-intent-hint" class="muted">Use your own words: steps, pass/fail decisions, retry limits and human checkpoints. You do not need to write tags. Copilot will ask about concrete gaps and save a new XML draft.</p>
<div class="card-foot"><button id="markup-copilot" disabled>Create draft with Copilot…</button><button id="markup-open" class="secondary">Load Copilot draft…</button></div>
<p class="muted">1. Send the prepared request in Copilot. 2. Load its saved XML draft here. 3. Review SFlow's checked phases and routes, then import. Drafting uses your selected chat model; loading and checking are model-free.</p>
<details id="markup-advanced"><summary>Advanced: inspect or edit markup</summary>
<label class="field" for="markup-source">Workflow markup</label>
<textarea id="markup-source" rows="22" maxlength="262144" spellcheck="false" aria-describedby="markup-hint"></textarea>
<p id="markup-hint" class="muted">Version 1 maps every starter phase to its own namespaced phase. Plain descriptions are guidance, not executable conditions. Use decisions for branching and max-attempts for backward rule routes.</p>
</details>
<div class="card-foot"><button id="markup-check" class="secondary">Check draft & routes</button><button id="markup-import" disabled>Save bundle & review import…</button></div>
<p id="markup-status" role="status" aria-live="polite">Loading the example…</p>
<section id="markup-result" hidden><h2 id="markup-title"></h2><ol id="markup-phases"></ol>
<h3>Decisions and routes</h3><ul id="markup-routes"></ul>
<details><summary>Source-to-node mapping</summary><div id="markup-map"></div></details>
<p id="markup-meaning" class="muted"></p></section>`;

export const WORKFLOW_MARKUP_STYLE = `
#markup-source,#markup-intent{box-sizing:border-box;width:100%;resize:vertical}
#markup-source{font-family:var(--vscode-editor-font-family,ui-monospace,monospace)}
#markup-intent{font:inherit}#markup-advanced{margin-top:20px}
#markup-result code,#markup-result pre{white-space:pre-wrap;overflow-wrap:anywhere}
#markup-result li{margin:8px 0}#markup-result button{text-align:left}
.card-foot{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.field{display:block;margin:12px 0 6px}
`;

export const WORKFLOW_MARKUP_SCRIPT = `
(() => {
  const byId = id => document.getElementById('markup-' + id);
  const source = byId('source'), intent = byId('intent'), check = byId('check'), save = byId('import'), copilot = byId('copilot'), open = byId('open');
  const api = window.__sfVscode;
  let revision = 0, checked = null, busy = false, hasDraft = false;
  const kept = api.getState ? api.getState() : null;
  if (kept && typeof kept.source === 'string') source.value = kept.source;
  if (kept && typeof kept.intent === 'string') intent.value = kept.intent;
  if (kept) hasDraft = kept.hasDraft === true;
  function retain() { if (api.setState) api.setState({source:source.value,intent:intent.value,hasDraft}); }
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
  check.onclick = () => { if (busy || !hasDraft) return; setBusy(true); checked = null; save.disabled = true;
    byId('status').textContent = 'Checking definition, dependency closure and native route simulation…';
    api.postMessage({type:'markup.check', source:source.value, revision}); };
  save.onclick = () => { if (busy || !checked) return; setBusy(true); save.disabled = true;
    api.postMessage({type:'markup.import', revision, sourceSha256:checked.sourceSha256, bundleSha256:checked.bundleSha256}); };
  copilot.onclick = () => { if (!busy) api.postMessage({type:'markup.copilot', intent:intent.value, source:hasDraft ? source.value : undefined}); };
  open.onclick = () => { if (busy) return; setBusy(true); save.disabled = true;
    byId('status').textContent = 'Select the XML draft saved by Copilot…';
    api.postMessage({type:'markup.open', revision}); };
  window.addEventListener('message', event => {
    const message = event.data || {};
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
    const map = byId('map'); map.replaceChildren();
    checked.sourceMap.forEach(binding => { const detail = document.createElement('details'), label = document.createElement('summary'), code = document.createElement('pre');
      label.textContent = binding.target + ' · line ' + binding.line; code.textContent = source.value.slice(binding.start, binding.end);
      detail.appendChild(label); detail.appendChild(code); map.appendChild(detail); });
    byId('result').hidden = false;
  });
  api.postMessage({type:'markup.ready'});
})();`;

/** HTML for the visual instruction library. All state changes return to the extension host. */
import {
  brandLockup, escape, icon } from './webview.ts';
import { agentSummary } from './instruction-designer-model.ts';
import type {
  InstructionCatalog, InstructionEntry, InstructionTab, PromptDraft, SkillDraft
} from './instruction-designer-model.ts';
import type { IconName } from './webview.ts';
import { CATALOG_SEARCH_SCRIPT } from './catalog-search.ts';

const TAB_ICONS: Record<InstructionTab, IconName> = {
  agents: 'agent', delivery: 'delivery', prompts: 'prompt', skills: 'skill', packs: 'pack'
};

export interface InstructionDesignerView {
  tab: InstructionTab;
  selected: InstructionEntry | null;
  prompt: PromptDraft | null;
  skill: SkillDraft | null;
  errors: string[];
  notice: string | null;
  configurationBlockedReason: string | null;
}

function tabs(tab: InstructionTab, catalog: InstructionCatalog): string {
  const choices: Array<[InstructionTab, string, number]> = [
    ['agents', 'Agents', catalog.agents.length], ['delivery', 'Mappings & remote', catalog.mappings.length],
    ['prompts', 'Prompts', catalog.prompts.length],
    ['skills', 'Skills', catalog.skills.length], ['packs', 'Prompt packs', catalog.packs.length]
  ];
  return `<nav class="instruction-tabs" aria-label="Instruction types">${choices.map(([id, label, count]) =>
    `<button class="tab${id === tab ? ' active' : ''}" aria-current="${id === tab ? 'page' : 'false'}" data-tab="${id}">${icon(TAB_ICONS[id])}${escape(label)} <span>${count}</span></button>`
  ).join('')}</nav>`;
}

function inventory(tab: InstructionTab, entries: InstructionEntry[], selected: InstructionEntry | null): string {
  return `<aside class="instruction-library" data-catalog-tab="${escape(tab)}">
    <div class="library-head"><div><p class="eyebrow">${escape(tab)}</p><h2>${tab === 'packs' ? 'Packaged library' : 'Repository library'}</h2></div>
      ${tab === 'packs' ? '' : `<button class="icon-button" data-new="1" title="Create new ${escape(tab.slice(0, -1))}" aria-label="Create new ${escape(tab.slice(0, -1))}">${icon('add')}</button>`}</div>
    <label for="instruction-catalog-search">Search ${escape(tab)}</label>
    <input id="instruction-catalog-search" type="search" data-search placeholder="Name or description…" aria-describedby="instruction-catalog-count">
    <div class="form-actions"><button class="secondary" data-search-action="search">Search</button><button class="secondary" data-search-action="clear">Clear search</button></div>
    <p id="instruction-catalog-count" data-search-count class="meta" role="status" aria-live="polite"></p>
    <p data-search-empty class="meta" hidden>No matches. Clear the search to see all entries.</p>
    <div class="instruction-list">${entries.length ? entries.map((entry) => `<button class="instruction-item${selected?.path === entry.path ? ' selected' : ''}" data-select="${escape(entry.path)}" data-filter-text="${escape(`${entry.id} ${entry.name} ${entry.description} ${entry.scope}`)}">
      <strong>${icon(TAB_ICONS[tab])}${escape(entry.name)}</strong><span>${escape(entry.description || (entry.scope === 'packaged' ? 'Packaged instruction' : 'Repository instruction'))}</span>
      <small>${tab === 'agents' ? (entry.scope === 'packaged' ? 'packaged' : 'this repository') : entry.scope === 'packaged' ? 'read only' : 'editable'}</small></button>`).join('') : `<p class="empty-state">No ${escape(tab)} yet.</p>`}</div>
  </aside>`;
}

function errors(view: InstructionDesignerView): string {
  return view.errors.length ? `<div class="blockers"><strong>Fix before saving</strong><ul>${view.errors.map((error) => `<li>${escape(error)}</li>`).join('')}</ul></div>` : '';
}

const STUDIO_ROUTE = 'Agents are created and changed in Workflow Studio, so every agent is checked the same way and an agent travels with the steps it drafts in one review.';

/** An agent as it is, read only: changing it opens Workflow Studio at it. */
function agentViewer(view: InstructionDesignerView): string {
  const entry = view.selected;
  if (!entry) return `<div class="empty"><h3>Select an agent</h3><p>${escape(STUDIO_ROUTE)}</p><div class="form-actions"><button data-new="1">${icon('add')}Create an agent in Workflow Studio</button></div></div>`;
  const summary = agentSummary(entry.content, entry.id);
  const packaged = entry.scope === 'packaged';
  return `<section class="instruction-editor">
    <div class="editor-title"><p class="eyebrow">Agent · ${packaged ? 'comes with Singularity Flow' : 'this repository'}</p><h1>${escape(summary.label)}</h1><p class="muted">${escape(summary.description)}</p></div>
    ${errors(view)}<p class="meta">${escape(STUDIO_ROUTE)}${packaged ? ' Duplicate it there to make an editable copy.' : ''}</p>
    <div class="form-actions"><button data-open-studio-agent="${escape(entry.id)}">${icon('agent')}${packaged ? 'Open in Workflow Studio' : 'Edit in Workflow Studio'}</button></div>
    ${summary.phases.length ? `<p class="meta"><strong>May draft</strong> ${escape(summary.phases.join(', '))}</p>` : ''}
    <div class="composition-map"><strong>Prompt composition</strong><span>${icon('phase')}Phase contract</span><i>${icon('add')}</i><span>${icon('agent')}This agent</span><i>${icon('add')}</i><span>${icon('worldModel')}Repository brief</span><i>${icon('add')}</i><span>${icon('approval')}Approved inputs</span></div>
    <details class="agent-prompt"><summary>View the agent file</summary><p class="meta"><code>${escape(entry.path)}</code>. The runtime phase adds Story inputs, policy and applicable skills.</p><pre class="pack-preview">${escape(entry.content)}</pre></details>
  </section>`;
}

function deliveryEditor(catalog: InstructionCatalog, view: InstructionDesignerView): string {
  const configured = catalog.mappings.filter((row) => row.source === 'configured');
  const statuses = catalog.agentStatus;
  return `<section class="instruction-editor delivery-editor">
    <div class="editor-title"><p class="eyebrow">Copilot routing &amp; remote trust</p><h1>${icon('delivery', { size: 24 })}Agent delivery</h1><p class="muted">Map native Copilot agent names to Flow agents, then review, lock, and materialize their remote Markdown.</p></div>
    ${errors(view)}${view.notice ? `<p class="ok-text">${escape(view.notice)}</p>` : ''}
    <section class="delivery-section"><div class="section-heading"><div><h2>${icon('agent')}Copilot → Flow agent mappings</h2><p class="muted">Unmapped same-name agents continue to resolve automatically.</p></div><code>${escape(catalog.mappingPath)}</code></div>
      <select data-agent-catalog hidden>${catalog.agents.map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`).join('')}</select>
      <div class="mapping-table" data-mapping-list>${configured.map((row) => mappingRow(row.copilotAgent, row.agentId, catalog)).join('') || '<p class="empty-state">No explicit mappings. Add one when the native Copilot agent name differs from the Flow agent ID.</p>'}</div>
      <div class="form-actions"><button class="secondary" data-add-mapping="1">${icon('add')}Add mapping</button><button data-save-mappings="1">Save mappings</button></div>
    </section>
    <section class="delivery-section"><div class="section-heading"><div><h2>${icon('gate')}Remote resource trust</h2><p class="muted">Trust is explicit and reviewable. Sync never changes a lock.</p></div><button class="secondary" data-agent-action="refresh" data-agent-id="*">${icon('refresh')}Refresh status</button></div>
      <div class="trust-grid">${catalog.agents.map((agent) => trustCard(agent, statuses.find((entry) => entry.id === agent.id))).join('') || '<p class="empty-state">No agents were found.</p>'}</div>
    </section>
  </section>`;
}

function mappingRow(copilotAgent: string, agentId: string, catalog: InstructionCatalog): string {
  return `<div class="mapping-row" data-mapping-row><label><span>Native Copilot agent</span><input data-copilot-agent value="${escape(copilotAgent)}" placeholder="architecture"></label><span class="mapping-arrow">→</span><label><span>Flow agent</span><select data-flow-agent>${catalog.agents.map((agent) => `<option value="${escape(agent.id)}"${agent.id === agentId ? ' selected' : ''}>${escape(agent.name)}</option>`).join('')}</select></label><button class="icon-button danger" data-remove-mapping="1" title="Remove mapping" aria-label="Remove mapping">${icon('remove')}</button></div>`;
}

function trustCard(agent: InstructionEntry, status: InstructionCatalog['agentStatus'][number] | undefined): string {
  const state = status?.status ?? (agent.description ? 'unknown' : 'local-only');
  const resources = status?.dependencies ?? [];
  const action = state === 'unlocked' ? 'trust' : state === 'stale' ? 'update' : state === 'needs-sync' ? 'sync' : null;
  return `<article class="trust-card"><div class="trust-head"><div><strong>${icon('agent')}${escape(agent.name)}</strong><small>${escape(agent.scope)}</small></div><span class="status-chip ${escape(state)}">${escape(state.replace('-', ' '))}</span></div>
    <p>${resources.length ? `${resources.length} remote resource${resources.length === 1 ? '' : 's'}` : 'Local instructions only'}</p>
    ${resources.length ? `<ul class="resource-status">${resources.map((resource) => `<li><span>${icon(resource.type === 'skill' ? 'skill' : 'artifact')}${escape(resource.id)}</span><span>${escape(resource.type)} · ${escape(resource.status)}${resource.sha256 ? ' · pinned' : ''}</span></li>`).join('')}</ul>` : ''}
    ${action ? `<button data-agent-action="${action}" data-agent-id="${escape(agent.id)}">${icon(action === 'sync' ? 'refresh' : 'gate')}${action === 'trust' ? 'Review & trust' : action === 'update' ? 'Review update' : 'Sync locked resources'}</button>` : ''}
  </article>`;
}

function promptEditor(catalog: InstructionCatalog, view: InstructionDesignerView): string {
  const draft = view.prompt;
  if (!draft) return '<div class="empty"><h3>Select a prompt</h3><p>Prompts are reusable repository instructions. Workflow configuration decides where each one is used.</p></div>';
  const isNew = !view.selected;
  const path = view.selected?.path ?? `singularity/prompts/${draft.id || '<id>'}.md`;
  const used = catalog.promptUsage[path] ?? [];
  return `<section class="instruction-editor">
    <div class="editor-title"><p class="eyebrow">Reusable prompt</p><h1>${isNew ? 'Create a prompt' : escape(view.selected?.name)}</h1><p class="muted">${used.length ? `Used by ${escape(used.join(' and '))}.` : 'Not currently selected by workflow configuration.'}</p></div>
    ${errors(view)}<label class="field"><span>Prompt ID</span><input data-prompt-id value="${escape(draft.id)}"${isNew ? '' : ' disabled'} placeholder="impact-analysis"></label>
    <label class="field full"><span>Markdown instructions</span><textarea data-prompt-body rows="26">${escape(draft.body)}</textarea></label>
    <div class="form-actions"><button data-save-prompt="1">${isNew ? 'Create prompt' : 'Save prompt'}</button><button class="secondary" data-cancel="1">Cancel</button></div>
  </section>`;
}

function skillEditor(view: InstructionDesignerView): string {
  const draft = view.skill;
  if (!draft) return '<div class="empty"><h3>Select a skill</h3><p>Repository skills define repeatable <code>/sf-*</code> actions and the exact CLI interaction behind them.</p></div>';
  const isNew = !view.selected;
  return `<section class="instruction-editor">
    <div class="editor-title"><p class="eyebrow">Repository skill</p><h1>${isNew ? 'Create a skill' : escape(draft.id)}</h1><p class="muted">Skills are stored as <code>.github/skills/&lt;id&gt;/SKILL.md</code> and remain ordinary Markdown.</p></div>
    ${errors(view)}<div class="form-grid">
      <label class="field"><span>Skill ID</span><input data-skill-id value="${escape(draft.id)}"${isNew ? '' : ' disabled'} placeholder="sf-impact"></label>
      <label class="field"><span>Argument hint</span><input data-skill-hint value="${escape(draft.argumentHint)}" placeholder="[WORK-ID] [--json]"></label>
      <label class="field full"><span>Description</span><input data-skill-description value="${escape(draft.description)}"></label>
      <label class="choice full"><input type="checkbox" data-skill-disable${draft.disableModelInvocation ? ' checked' : ''}><span><strong>Run without model invocation</strong><small>Use for deterministic read-only or CLI-only commands.</small></span></label>
    </div>
    <label class="field full"><span>Skill instructions</span><textarea data-skill-body rows="22">${escape(draft.body)}</textarea></label>
    <div class="form-actions"><button data-save-skill="1">${isNew ? 'Create skill' : 'Save skill'}</button><button class="secondary" data-cancel="1">Cancel</button></div>
  </section>`;
}

function packViewer(view: InstructionDesignerView): string {
  const entry = view.selected;
  if (!entry) return '<div class="empty"><h3>Select a prompt pack</h3><p>Packaged <code>/sf-*</code> skills are safe defaults. Copy one into the repository to customize it without changing the installation.</p></div>';
  return `<section class="instruction-editor"><div class="editor-title"><p class="eyebrow">Packaged prompt pack · read only</p><h1>/${escape(entry.name)}</h1><p class="muted">${escape(entry.description)}</p></div>
    ${view.notice ? `<p class="ok-text">${escape(view.notice)}</p>` : ''}
    <div class="pack-meta"><span><strong>Arguments</strong>${escape(entry.argumentHint || 'none')}</span><span><strong>Customization target</strong><code>${escape(entry.repositoryPath)}</code></span></div>
    <pre class="pack-preview">${escape(entry.content)}</pre>
    <div class="form-actions"><button data-copy-pack="${escape(entry.path)}">Copy into repository</button></div>
  </section>`;
}

export function instructionDesignerHtml(catalog: InstructionCatalog, view: InstructionDesignerView): string {
  const entries = view.tab === 'delivery' ? catalog.agents : catalog[view.tab];
  const editor = view.tab === 'agents' ? agentViewer(view)
    : view.tab === 'delivery' ? deliveryEditor(catalog, view)
    : view.tab === 'prompts' ? promptEditor(catalog, view)
      : view.tab === 'skills' ? skillEditor(view) : packViewer(view);
  const links = Object.entries(catalog.phases.reduce<Record<string, string[]>>((result, phase) => {
    result[phase.id] = catalog.agents.filter((agent) => agentSummary(agent.content, agent.id).phases.includes(phase.id))
      .map((agent) => agent.name); return result;
  }, {})).filter(([, agents]) => agents.length);
  return `<header>${brandLockup()}<h1>${icon('agent', { size: 24 })}Agents, prompts &amp; skills</h1><p class="meta">Design what Copilot receives, see where it runs, and keep every instruction as reviewed Markdown.</p><p><button class="secondary" data-agent-action="refresh" data-agent-id="*">${icon('refresh')}Reload approved instructions</button></p></header>
    ${tabs(view.tab, catalog)}
    ${view.configurationBlockedReason ? `<p class="blockers"><strong>Read-only recovery configuration</strong><br>${escape(view.configurationBlockedReason)} Restore or reinitialize <code>sflow/config</code> before editing.</p>` : ''}
    ${view.configurationBlockedReason ? '<fieldset disabled>' : ''}
    <section class="relationship-strip"><strong>Phase routing</strong>${links.length ? links.map(([phase, agents]) => `<span><b>${escape(phase)}</b> → ${escape(agents.join(', '))}</span>`).join('') : '<span class="muted">No repository agents are routed to phases yet.</span>'}</section>
    ${view.tab === 'delivery' ? `<main class="instruction-studio single"><div>${editor}</div></main>` : `<main class="instruction-studio">${inventory(view.tab, entries, view.selected)}<div>${editor}</div></main>`}
    ${view.configurationBlockedReason ? '</fieldset>' : ''}`;
}

// Icons rendered into browser-created rows must be encoded as a JavaScript string
// literal. Interpolating the raw multiline SVG inside a quoted runtime string makes
// the entire webview script invalid, which disables every control on this page.
const REMOVE_ICON_SCRIPT_LITERAL = JSON.stringify(icon('remove'));

export const INSTRUCTION_DESIGNER_SCRIPT = CATALOG_SEARCH_SCRIPT + String.raw`
const vscode = window.__sfVscode;
const removeIcon = ${REMOVE_ICON_SCRIPT_LITERAL};
const val = (selector) => document.querySelector(selector)?.value ?? '';
const mappingRows = () => [...document.querySelectorAll('[data-mapping-row]')].map((row) => ({ copilotAgent: row.querySelector('[data-copilot-agent]')?.value.trim() ?? '', agentId: row.querySelector('[data-flow-agent]')?.value ?? '' }));
document.addEventListener('click', (event) => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.tab) vscode.postMessage({ type: 'tab', tab: target.dataset.tab });
  if (target.dataset.select) vscode.postMessage({ type: 'select', path: target.dataset.select });
  if (target.dataset.new) vscode.postMessage({ type: 'new' });
  if (target.dataset.cancel) vscode.postMessage({ type: 'cancel' });
  if (target.dataset.copyPack) vscode.postMessage({ type: 'copy-pack', path: target.dataset.copyPack });
  if (target.dataset.openStudioAgent) vscode.postMessage({ type: 'open-studio', agent: target.dataset.openStudioAgent });
  if (target.dataset.savePrompt) vscode.postMessage({ type: 'save-prompt', id: val('[data-prompt-id]'), body: val('[data-prompt-body]') });
  if (target.dataset.saveSkill) vscode.postMessage({ type: 'save-skill', id: val('[data-skill-id]'), description: val('[data-skill-description]'), argumentHint: val('[data-skill-hint]'), disableModelInvocation: Boolean(document.querySelector('[data-skill-disable]')?.checked), body: val('[data-skill-body]') });
  if (target.dataset.addMapping) { const list = document.querySelector('[data-mapping-list]'); list?.querySelector('.empty-state')?.remove(); const options = [...document.querySelectorAll('[data-agent-catalog] option')].map((option) => '<option value="' + option.value + '">' + option.textContent + '</option>').join('') || '<option value="">Choose Flow agent</option>'; list?.insertAdjacentHTML('beforeend', '<div class="mapping-row" data-mapping-row><label><span>Native Copilot agent</span><input data-copilot-agent placeholder="architecture"></label><span class="mapping-arrow">→</span><label><span>Flow agent</span><select data-flow-agent>' + options + '</select></label><button class="icon-button danger" data-remove-mapping="1" title="Remove mapping" aria-label="Remove mapping">' + removeIcon + '</button></div>'); }
  if (target.dataset.removeMapping) target.closest('[data-mapping-row]')?.remove();
  if (target.dataset.saveMappings) vscode.postMessage({ type: 'save-mappings', rows: mappingRows() });
  if (target.dataset.agentAction) vscode.postMessage({ type: 'agent-action', action: target.dataset.agentAction, agentId: target.dataset.agentId });
});
const search = document.querySelector('[data-search]');
const catalogTab = document.querySelector('[data-catalog-tab]')?.dataset?.catalogTab;
const savedCatalog = vscode.getState ? (vscode.getState() || {}).catalogSearch || {} : {};
if (search && typeof savedCatalog[catalogTab] === 'string') search.value = savedCatalog[catalogTab];
const filterCatalog = () => {
  if (!search) return;
  const rows = [...document.querySelectorAll('[data-filter-text]')];
  let visible = 0;
  rows.forEach((item) => { item.hidden = !catalogMatches(search.value, [item.dataset.filterText]); if (!item.hidden) visible += 1; });
  const count = document.querySelector('[data-search-count]');
  if (count) count.textContent = visible + ' of ' + rows.length + ' shown';
  const empty = document.querySelector('[data-search-empty]');
  if (empty) empty.hidden = visible !== 0 || rows.length === 0;
  const clear = document.querySelector('[data-search-action="clear"]');
  if (clear) clear.disabled = !search.value;
  if (vscode.setState && catalogTab) {
    const current = vscode.getState ? vscode.getState() || {} : {};
    current.catalogSearch = Object.assign({}, current.catalogSearch, { [catalogTab]: search.value }); vscode.setState(current);
  }
};
search?.addEventListener('input', filterCatalog);
document.querySelector('[data-search-action="search"]')?.addEventListener('click', () => { filterCatalog(); search?.focus(); });
document.querySelector('[data-search-action="clear"]')?.addEventListener('click', () => { search.value = ''; filterCatalog(); search.focus(); });
filterCatalog();`;

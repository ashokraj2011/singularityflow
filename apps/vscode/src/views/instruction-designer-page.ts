/** HTML for the visual instruction library. All state changes return to the extension host. */
import { escape, icon } from './webview.ts';
import type {
  AgentDraft, InstructionCatalog, InstructionEntry, InstructionTab, PromptDraft, SkillDraft
} from './instruction-designer-model.ts';
import type { IconName } from './webview.ts';

const TAB_ICONS: Record<InstructionTab, IconName> = {
  agents: 'agent', delivery: 'delivery', prompts: 'prompt', skills: 'skill', packs: 'pack'
};

export interface InstructionDesignerView {
  tab: InstructionTab;
  selected: InstructionEntry | null;
  agent: AgentDraft | null;
  prompt: PromptDraft | null;
  skill: SkillDraft | null;
  errors: string[];
  notice: string | null;
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

function remoteRows(kind: 'skill' | 'template' | 'output', draft: AgentDraft, disabled: boolean): string {
  const rows = kind === 'skill' ? draft.remoteSkills : kind === 'template' ? draft.remoteTemplates : draft.remoteOutputs;
  const cells = rows.map((entry, index) => {
    const output = kind === 'output' ? entry as AgentDraft['remoteOutputs'][number] : null;
    const common = entry as AgentDraft['remoteSkills'][number];
    return `<div class="remote-row" data-remote-row="${kind}">
      <label><span>ID</span><input data-remote-id value="${escape(entry.id)}"${disabled ? ' disabled' : ''} placeholder="${kind === 'skill' ? 'security-guidance' : kind === 'template' ? 'design-template' : 'design-export'}"></label>
      <label class="remote-url"><span>${kind === 'output' ? 'URL template' : 'Public HTTPS Markdown URL'}</span><input data-remote-url value="${escape(output?.urlTemplate ?? common.url ?? '')}"${disabled ? ' disabled' : ''} placeholder="https://docs.example.com/${kind}.md"></label>
      ${kind === 'output'
        ? `<label><span>Phase</span><select data-remote-phase${disabled ? ' disabled' : ''}>${catalogPhaseOptions(draft, output?.phase ?? '')}</select></label><label><span>Target</span><input data-remote-target value="${escape(output?.target ?? '')}"${disabled ? ' disabled' : ''} placeholder="artifacts/design/reference.md"></label>`
        : `<label><span>Phases</span><input data-remote-phases value="${escape(common.phases.join(','))}"${disabled ? ' disabled' : ''} placeholder="design,implementation"></label>`}
      <label><span>Max bytes</span><input data-remote-max value="${escape(entry.maxBytes || '-')}"${disabled ? ' disabled' : ''} inputmode="numeric"></label>
      <label class="remote-optional"><input type="checkbox" data-remote-optional${entry.optional ? ' checked' : ''}${disabled ? ' disabled' : ''}><span>Optional</span></label>
      ${disabled ? '' : `<button type="button" class="icon-button danger" data-remove-remote="${kind}" title="Remove ${kind}" aria-label="Remove ${kind}">${icon('remove')}</button>`}
    </div>`;
  }).join('');
  return `<div class="remote-resource-list" data-remote-list="${kind}">${cells || `<p class="empty-state">No remote ${kind === 'output' ? 'generated artifacts' : `${kind}s`}.</p>`}</div>
    ${disabled ? '' : `<button type="button" class="secondary" data-add-remote="${kind}">${icon('add')}Add ${kind === 'output' ? 'generated artifact' : kind}</button>`}`;
}

function catalogPhaseOptions(draft: AgentDraft, selected: string): string {
  const phases = [...new Set([...draft.phases, selected].filter(Boolean))];
  return `<option value="">Choose phase</option>${phases.map((phase) => `<option value="${escape(phase)}"${phase === selected ? ' selected' : ''}>${escape(phase)}</option>`).join('')}`;
}

function inventory(tab: InstructionTab, entries: InstructionEntry[], selected: InstructionEntry | null): string {
  return `<aside class="instruction-library">
    <div class="library-head"><div><p class="eyebrow">${escape(tab)}</p><h2>${tab === 'packs' ? 'Packaged library' : 'Repository library'}</h2></div>
      ${tab === 'packs' ? '' : `<button class="icon-button" data-new="1" title="Create new ${escape(tab.slice(0, -1))}" aria-label="Create new ${escape(tab.slice(0, -1))}">${icon('add')}</button>`}</div>
    <input type="search" data-search placeholder="Filter ${escape(tab)}…" aria-label="Filter library">
    <div class="instruction-list">${entries.length ? entries.map((entry) => `<button class="instruction-item${selected?.path === entry.path ? ' selected' : ''}" data-select="${escape(entry.path)}" data-filter-text="${escape(`${entry.name} ${entry.description}`.toLowerCase())}">
      <strong>${icon(TAB_ICONS[tab])}${escape(entry.name)}</strong><span>${escape(entry.description || (entry.scope === 'packaged' ? 'Packaged instruction' : 'Repository instruction'))}</span>
      <small>${entry.scope === 'packaged' ? 'read only' : 'editable'}</small></button>`).join('') : `<p class="empty-state">No ${escape(tab)} yet.</p>`}</div>
  </aside>`;
}

function checks(name: string, values: Array<{ id: string; label: string }>, selected: string[], disabled = false): string {
  return `<div class="choice-grid">${values.map((entry) => `<label class="choice"><input type="checkbox" name="${name}" value="${escape(entry.id)}"${selected.includes(entry.id) ? ' checked' : ''}${disabled ? ' disabled' : ''}><span><strong>${escape(entry.label)}</strong><small>${escape(entry.id)}</small></span></label>`).join('') || '<span class="muted">None are declared yet.</span>'}</div>`;
}

function errors(view: InstructionDesignerView): string {
  return view.errors.length ? `<div class="blockers"><strong>Fix before saving</strong><ul>${view.errors.map((error) => `<li>${escape(error)}</li>`).join('')}</ul></div>` : '';
}

function agentEditor(catalog: InstructionCatalog, view: InstructionDesignerView): string {
  const draft = view.agent;
  if (!draft) return '<div class="empty"><h3>Select an agent</h3><p>See which phases it serves, the repository views it receives, and the exact instruction sent to Copilot.</p></div>';
  const isNew = !view.selected;
  const packaged = view.selected?.scope === 'packaged';
  const locked = packaged ? ' disabled' : '';
  const tools = ['read', 'search', 'edit', 'execute', 'web'];
  return `<section class="instruction-editor">
    <div class="editor-title"><p class="eyebrow">Governed agent</p><h1>${isNew ? 'Create an agent' : escape(draft.label)}</h1><p class="muted">Agents combine these instructions with the active phase, selected repository world-model views, and approved inputs.</p></div>
    ${errors(view)}<div class="form-grid">
      <label class="field"><span>Agent ID</span><input data-agent-id value="${escape(draft.id)}"${isNew && !packaged ? '' : ' disabled'} placeholder="security-reviewer"></label>
      <label class="field"><span>Display name</span><input data-agent-label value="${escape(draft.label)}" placeholder="Security reviewer"${locked}></label>
      <label class="field full"><span>Description</span><input data-agent-description value="${escape(draft.description)}" placeholder="What decisions this agent helps make"${locked}></label>
    </div>
    <h2>${icon('gate')}Available in phases</h2>${checks('agent-phases', catalog.phases, draft.phases, packaged)}
    <h2>${icon('approval')}Default agent for</h2><p class="muted">A default must also be selected above.</p>${checks('agent-defaults', catalog.phases, draft.defaultFor, packaged)}
    <h2>${icon('book')}Repository world-model views</h2>${checks('agent-views', catalog.worldModelViews.map((id) => ({ id, label: id })), draft.worldModelViews, packaged)}
    <h2>${icon('code')}Allowed tools</h2>${checks('agent-tools', tools.map((id) => ({ id, label: id })), draft.tools, packaged)}
    <label class="field full"><span>Agent instructions</span><textarea data-agent-body rows="18"${packaged ? ' readonly' : ''}>${escape(draft.body)}</textarea></label>
    <section class="remote-delivery"><div class="section-heading"><div><p class="eyebrow">Remote Markdown delivery</p><h2>${icon('delivery')}Skills, templates &amp; generated artifacts</h2></div><span class="status-chip">Public HTTPS · hash locked</span></div>
      <p class="muted">Only resources declared here are fetched. Secrets are never embedded; first trust records exact SHA-256 hashes in <code>singularity/agents.lock.yml</code>.</p>
      <h3>${icon('skill')}Remote skills</h3><p class="muted">Prompt context loaded only for the phases listed.</p>${remoteRows('skill', draft, packaged)}
      <h3>${icon('artifact')}Remote artifact templates</h3><p class="muted">Referenced explicitly as <code>agent:${escape(draft.id || '<agent>')}/&lt;template-id&gt;</code>.</p>${remoteRows('template', draft, packaged)}
      <h3>${icon('delivery')}Remote generated artifacts</h3><p class="muted">Fetched once per generation into the governed phase artifact folder.</p>${remoteRows('output', draft, packaged)}
    </section>
    <div class="composition-map"><strong>Prompt composition</strong><span>${icon('phase')}Phase contract</span><i>${icon('add')}</i><span>${icon('agent')}This agent</span><i>${icon('add')}</i><span>${icon('worldModel')}World model</span><i>${icon('add')}</i><span>${icon('approval')}Approved inputs</span></div>
    <div class="form-actions">${packaged ? `<button data-copy-agent="${escape(view.selected?.path)}">Copy into repository</button>` : `<button data-save-agent="1">${isNew ? 'Create agent' : 'Save agent'}</button>`}<button class="secondary" data-cancel="1">Cancel</button></div>
  </section>`;
}

function deliveryEditor(catalog: InstructionCatalog, view: InstructionDesignerView): string {
  const configured = catalog.mappings.filter((row) => row.source === 'configured');
  const statuses = catalog.agentStatus;
  return `<section class="instruction-editor delivery-editor">
    <div class="editor-title"><p class="eyebrow">Copilot routing &amp; remote trust</p><h1>${icon('delivery', { size: 24 })}Agent delivery</h1><p class="muted">Map native Copilot agent names to governed Flow agents, then review, lock, and materialize their remote Markdown.</p></div>
    ${errors(view)}${view.notice ? `<p class="ok-text">${escape(view.notice)}</p>` : ''}
    <section class="delivery-section"><div class="section-heading"><div><h2>${icon('agent')}Copilot → Flow agent mappings</h2><p class="muted">Unmapped same-name agents continue to resolve automatically.</p></div><code>${escape(catalog.mappingPath)}</code></div>
      <select data-agent-catalog hidden>${catalog.agents.map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`).join('')}</select>
      <div class="mapping-table" data-mapping-list>${configured.map((row) => mappingRow(row.copilotAgent, row.agentId, catalog)).join('') || '<p class="empty-state">No explicit mappings. Add one when the native Copilot agent name differs from the Flow agent ID.</p>'}</div>
      <div class="form-actions"><button class="secondary" data-add-mapping="1">${icon('add')}Add mapping</button><button data-save-mappings="1">Save mappings</button></div>
    </section>
    <section class="delivery-section"><div class="section-heading"><div><h2>${icon('gate')}Remote resource trust</h2><p class="muted">Trust is explicit and reviewable. Sync never changes a lock.</p></div><button class="secondary" data-agent-action="refresh" data-agent-id="*">${icon('refresh')}Refresh status</button></div>
      <div class="trust-grid">${catalog.agents.map((agent) => trustCard(agent, statuses.find((entry) => entry.id === agent.id))).join('') || '<p class="empty-state">No governed agents were found.</p>'}</div>
    </section>
  </section>`;
}

function mappingRow(copilotAgent: string, agentId: string, catalog: InstructionCatalog): string {
  return `<div class="mapping-row" data-mapping-row><label><span>Native Copilot agent</span><input data-copilot-agent value="${escape(copilotAgent)}" placeholder="architecture"></label><span class="mapping-arrow">→</span><label><span>Governed Flow agent</span><select data-flow-agent>${catalog.agents.map((agent) => `<option value="${escape(agent.id)}"${agent.id === agentId ? ' selected' : ''}>${escape(agent.name)}</option>`).join('')}</select></label><button class="icon-button danger" data-remove-mapping="1" title="Remove mapping" aria-label="Remove mapping">${icon('remove')}</button></div>`;
}

function trustCard(agent: InstructionEntry, status: InstructionCatalog['agentStatus'][number] | undefined): string {
  const state = status?.status ?? (agent.description ? 'unknown' : 'local-only');
  const resources = status?.dependencies ?? [];
  const action = state === 'unlocked' ? 'trust' : state === 'stale' ? 'update' : state === 'needs-sync' ? 'sync' : null;
  return `<article class="trust-card"><div class="trust-head"><div><strong>${icon('agent')}${escape(agent.name)}</strong><small>${escape(agent.scope)}</small></div><span class="status-chip ${escape(state)}">${escape(state.replace('-', ' '))}</span></div>
    <p>${resources.length ? `${resources.length} remote resource${resources.length === 1 ? '' : 's'}` : 'Local instructions only'}</p>
    ${resources.length ? `<ul class="resource-status">${resources.map((resource) => `<li><span>${icon(resource.type === 'skill' ? 'skill' : 'artifact')}${escape(resource.id)}</span><span>${escape(resource.type)} · ${escape(resource.status)}${resource.sha256 ? ` · ${escape(resource.sha256.slice(0, 10))}` : ''}</span></li>`).join('')}</ul>` : ''}
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
  const editor = view.tab === 'agents' ? agentEditor(catalog, view)
    : view.tab === 'delivery' ? deliveryEditor(catalog, view)
    : view.tab === 'prompts' ? promptEditor(catalog, view)
      : view.tab === 'skills' ? skillEditor(view) : packViewer(view);
  const links = Object.entries(catalog.phases.reduce<Record<string, string[]>>((result, phase) => {
    result[phase.id] = catalog.agents.filter((agent) => {
      const draft = parseAgentForPage(agent);
      return draft.phases.includes(phase.id);
    }).map((agent) => agent.name); return result;
  }, {})).filter(([, agents]) => agents.length);
  return `<header><div class="brand-lockup">SINGULARITY <span>Flow</span></div><h1>${icon('agent', { size: 24 })}Agents, prompts &amp; skills</h1><p class="meta">Design what Copilot receives, see where it runs, and keep every instruction as governed Markdown.</p></header>
    ${tabs(view.tab, catalog)}
    <section class="relationship-strip"><strong>Phase routing</strong>${links.length ? links.map(([phase, agents]) => `<span><b>${escape(phase)}</b> → ${escape(agents.join(', '))}</span>`).join('') : '<span class="muted">No repository agents are routed to phases yet.</span>'}</section>
    ${view.tab === 'delivery' ? `<main class="instruction-studio single"><div>${editor}</div></main>` : `<main class="instruction-studio">${inventory(view.tab, entries, view.selected)}<div>${editor}</div></main>`}`;
}

function parseAgentForPage(entry: InstructionEntry): AgentDraft {
  const header = entry.content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const phases = header.match(/^\s*sflow-phases:\s*["']?([^"'\n]*)/m)?.[1] ?? '';
  return { id: entry.id, label: entry.name, description: entry.description,
    phases: phases.split(',').map((item) => item.trim()).filter(Boolean), defaultFor: [], worldModelViews: [], tools: [], body: '', remoteSkills: [], remoteTemplates: [], remoteOutputs: [] };
}

export const INSTRUCTION_DESIGNER_SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const val = (selector) => document.querySelector(selector)?.value ?? '';
const checked = (name) => [...document.querySelectorAll('input[name="' + name + '"]:checked')].map((node) => node.value);
const remoteRows = (kind) => [...document.querySelectorAll('[data-remote-row="' + kind + '"]')].map((row) => {
  const base = { id: row.querySelector('[data-remote-id]')?.value.trim() ?? '', optional: Boolean(row.querySelector('[data-remote-optional]')?.checked), maxBytes: row.querySelector('[data-remote-max]')?.value.trim() || '-' };
  if (kind === 'output') return { ...base, urlTemplate: row.querySelector('[data-remote-url]')?.value.trim() ?? '', phase: row.querySelector('[data-remote-phase]')?.value.trim() ?? '', target: row.querySelector('[data-remote-target]')?.value.trim() ?? '' };
  return { ...base, url: row.querySelector('[data-remote-url]')?.value.trim() ?? '', phases: (row.querySelector('[data-remote-phases]')?.value ?? '').split(',').map((value) => value.trim()).filter(Boolean) };
});
const mappingRows = () => [...document.querySelectorAll('[data-mapping-row]')].map((row) => ({ copilotAgent: row.querySelector('[data-copilot-agent]')?.value.trim() ?? '', agentId: row.querySelector('[data-flow-agent]')?.value ?? '' }));
const remoteTemplate = (kind) => {
  const output = kind === 'output';
  return '<div class="remote-row" data-remote-row="' + kind + '"><label><span>ID</span><input data-remote-id placeholder="resource-id"></label><label class="remote-url"><span>' + (output ? 'URL template' : 'Public HTTPS Markdown URL') + '</span><input data-remote-url placeholder="https://docs.example.com/resource.md"></label>' + (output ? '<label><span>Phase</span><input data-remote-phase placeholder="design"></label><label><span>Target</span><input data-remote-target placeholder="artifacts/design/reference.md"></label>' : '<label><span>Phases</span><input data-remote-phases placeholder="design,implementation"></label>') + '<label><span>Max bytes</span><input data-remote-max value="-"></label><label class="remote-optional"><input type="checkbox" data-remote-optional><span>Optional</span></label><button type="button" class="icon-button danger" data-remove-remote="' + kind + '" title="Remove resource" aria-label="Remove resource">${icon('remove')}</button></div>';
};
document.addEventListener('click', (event) => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.tab) vscode.postMessage({ type: 'tab', tab: target.dataset.tab });
  if (target.dataset.select) vscode.postMessage({ type: 'select', path: target.dataset.select });
  if (target.dataset.new) vscode.postMessage({ type: 'new' });
  if (target.dataset.cancel) vscode.postMessage({ type: 'cancel' });
  if (target.dataset.copyPack) vscode.postMessage({ type: 'copy-pack', path: target.dataset.copyPack });
  if (target.dataset.copyAgent) vscode.postMessage({ type: 'copy-agent', path: target.dataset.copyAgent });
  if (target.dataset.saveAgent) vscode.postMessage({ type: 'save-agent', id: val('[data-agent-id]'), label: val('[data-agent-label]'), description: val('[data-agent-description]'), phases: checked('agent-phases'), defaultFor: checked('agent-defaults'), worldModelViews: checked('agent-views'), tools: checked('agent-tools'), body: val('[data-agent-body]'), remoteSkills: remoteRows('skill'), remoteTemplates: remoteRows('template'), remoteOutputs: remoteRows('output') });
  if (target.dataset.savePrompt) vscode.postMessage({ type: 'save-prompt', id: val('[data-prompt-id]'), body: val('[data-prompt-body]') });
  if (target.dataset.saveSkill) vscode.postMessage({ type: 'save-skill', id: val('[data-skill-id]'), description: val('[data-skill-description]'), argumentHint: val('[data-skill-hint]'), disableModelInvocation: Boolean(document.querySelector('[data-skill-disable]')?.checked), body: val('[data-skill-body]') });
  if (target.dataset.addRemote) { const list = document.querySelector('[data-remote-list="' + target.dataset.addRemote + '"]'); list?.querySelector('.empty-state')?.remove(); list?.insertAdjacentHTML('beforeend', remoteTemplate(target.dataset.addRemote)); }
  if (target.dataset.removeRemote) target.closest('[data-remote-row]')?.remove();
  if (target.dataset.addMapping) { const list = document.querySelector('[data-mapping-list]'); list?.querySelector('.empty-state')?.remove(); const options = [...document.querySelectorAll('[data-agent-catalog] option')].map((option) => '<option value="' + option.value + '">' + option.textContent + '</option>').join('') || '<option value="">Choose Flow agent</option>'; list?.insertAdjacentHTML('beforeend', '<div class="mapping-row" data-mapping-row><label><span>Native Copilot agent</span><input data-copilot-agent placeholder="architecture"></label><span class="mapping-arrow">→</span><label><span>Governed Flow agent</span><select data-flow-agent>' + options + '</select></label><button class="icon-button danger" data-remove-mapping="1" title="Remove mapping" aria-label="Remove mapping">${icon('remove')}</button></div>'); }
  if (target.dataset.removeMapping) target.closest('[data-mapping-row]')?.remove();
  if (target.dataset.saveMappings) vscode.postMessage({ type: 'save-mappings', rows: mappingRows() });
  if (target.dataset.agentAction) vscode.postMessage({ type: 'agent-action', action: target.dataset.agentAction, agentId: target.dataset.agentId });
});
document.querySelector('[data-search]')?.addEventListener('input', (event) => {
  const term = event.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-filter-text]').forEach((item) => { item.hidden = term && !item.dataset.filterText.includes(term); });
});`;

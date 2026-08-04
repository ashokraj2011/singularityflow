/** HTML for the visual instruction library. All state changes return to the extension host. */
import { escape, icon } from './webview.ts';
import type {
  AgentDraft, InstructionCatalog, InstructionEntry, InstructionTab, PromptDraft, SkillDraft
} from './instruction-designer-model.ts';
import type { IconName } from './webview.ts';

const TAB_ICONS: Record<InstructionTab, IconName> = {
  agents: 'agent', prompts: 'prompt', skills: 'skill', packs: 'pack'
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
    ['agents', 'Agents', catalog.agents.length], ['prompts', 'Prompts', catalog.prompts.length],
    ['skills', 'Skills', catalog.skills.length], ['packs', 'Prompt packs', catalog.packs.length]
  ];
  return `<nav class="instruction-tabs" aria-label="Instruction types">${choices.map(([id, label, count]) =>
    `<button class="tab${id === tab ? ' active' : ''}" aria-current="${id === tab ? 'page' : 'false'}" data-tab="${id}">${icon(TAB_ICONS[id])}${escape(label)} <span>${count}</span></button>`
  ).join('')}</nav>`;
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
    <div class="composition-map"><strong>Prompt composition</strong><span>${icon('phase')}Phase contract</span><i>${icon('add')}</i><span>${icon('agent')}This agent</span><i>${icon('add')}</i><span>${icon('worldModel')}World model</span><i>${icon('add')}</i><span>${icon('approval')}Approved inputs</span></div>
    <div class="form-actions">${packaged ? `<button data-copy-agent="${escape(view.selected?.path)}">Copy into repository</button>` : `<button data-save-agent="1">${isNew ? 'Create agent' : 'Save agent'}</button>`}<button class="secondary" data-cancel="1">Cancel</button></div>
  </section>`;
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
  const entries = catalog[view.tab];
  const editor = view.tab === 'agents' ? agentEditor(catalog, view)
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
    <main class="instruction-studio">${inventory(view.tab, entries, view.selected)}<div>${editor}</div></main>`;
}

function parseAgentForPage(entry: InstructionEntry): AgentDraft {
  const header = entry.content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const phases = header.match(/^\s*sflow-phases:\s*["']?([^"'\n]*)/m)?.[1] ?? '';
  return { id: entry.id, label: entry.name, description: entry.description,
    phases: phases.split(',').map((item) => item.trim()).filter(Boolean), defaultFor: [], worldModelViews: [], tools: [], body: '' };
}

export const INSTRUCTION_DESIGNER_SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const val = (selector) => document.querySelector(selector)?.value ?? '';
const checked = (name) => [...document.querySelectorAll('input[name="' + name + '"]:checked')].map((node) => node.value);
document.addEventListener('click', (event) => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.tab) vscode.postMessage({ type: 'tab', tab: target.dataset.tab });
  if (target.dataset.select) vscode.postMessage({ type: 'select', path: target.dataset.select });
  if (target.dataset.new) vscode.postMessage({ type: 'new' });
  if (target.dataset.cancel) vscode.postMessage({ type: 'cancel' });
  if (target.dataset.copyPack) vscode.postMessage({ type: 'copy-pack', path: target.dataset.copyPack });
  if (target.dataset.copyAgent) vscode.postMessage({ type: 'copy-agent', path: target.dataset.copyAgent });
  if (target.dataset.saveAgent) vscode.postMessage({ type: 'save-agent', id: val('[data-agent-id]'), label: val('[data-agent-label]'), description: val('[data-agent-description]'), phases: checked('agent-phases'), defaultFor: checked('agent-defaults'), worldModelViews: checked('agent-views'), tools: checked('agent-tools'), body: val('[data-agent-body]') });
  if (target.dataset.savePrompt) vscode.postMessage({ type: 'save-prompt', id: val('[data-prompt-id]'), body: val('[data-prompt-body]') });
  if (target.dataset.saveSkill) vscode.postMessage({ type: 'save-skill', id: val('[data-skill-id]'), description: val('[data-skill-description]'), argumentHint: val('[data-skill-hint]'), disableModelInvocation: Boolean(document.querySelector('[data-skill-disable]')?.checked), body: val('[data-skill-body]') });
});
document.querySelector('[data-search]')?.addEventListener('input', (event) => {
  const term = event.target.value.trim().toLowerCase();
  document.querySelectorAll('[data-filter-text]').forEach((item) => { item.hidden = term && !item.dataset.filterText.includes(term); });
});`;

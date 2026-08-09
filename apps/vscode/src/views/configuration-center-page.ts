/** HTML renderer for the repository Configuration Center. */
import { escape, icon } from './webview.ts';
import type { IconName } from './webview.ts';
import type { AuthorityView, ConfigurationCenterView, ConfigurationTab, McpServerView } from './configuration-center-model.ts';

function csv(values: string[]): string { return escape(values.join(', ')); }

function tabs(active: ConfigurationTab): string {
  return `<nav class="tabs" aria-label="Configuration areas">
    ${(['overview', 'people', 'mcp'] as const).map((tab) => `<button class="tab${active === tab ? ' active' : ''}" data-tab="${tab}">${tab === 'overview' ? 'Overview' : tab === 'people' ? 'People & approvals' : 'MCP tools'}</button>`).join('')}
  </nav>`;
}

function overview(view: ConfigurationCenterView): string {
  const cards: Array<[string, IconName, string, string]> = [
    ['capabilities', 'capability', 'Capabilities', 'What the organisation builds and which repositories deliver it.'],
    ['proposals', 'merge', 'Review proposals', 'Pending capability-map changes waiting for exact-diff review and activation.'],
    ['workflow', 'workflow', 'Workflows & artifacts', 'Work types, phases, gates, inputs, and document templates.'],
    ['instructions', 'agent', 'Agents & delivery', 'Agent routing, prompts, skills, remote templates, generated artifacts, and trust status.'],
    ['people', 'team', 'People & approvals', 'Human identities and the authority groups permitted to approve.'],
    ['mcp', 'mcp', 'MCP tools', 'Host-owned tool servers with governed agent, phase, and tool allowlists.'],
    ['visual-assurance', 'visual', 'Visual assurance', 'Pinned design sources, viewport coverage, comparison evidence, and readiness.'],
    ['prompt-audit', 'prompt', 'Prompt audit', 'Optional workspace-local capture of composed governed prompts.']
  ];
  return `<section class="plain"><div class="section-heading"><h2>${icon('configuration')}Configuration areas</h2></div>
    <div class="configuration-grid">${cards.map(([action, glyph, title, detail]) => `<button class="configuration-card secondary" data-action="${action}">${icon(glyph, { size: 20 })}<strong>${title}</strong><span>${detail}</span></button>`).join('')}</div>
    <h2>${icon('ok')}Repository readiness</h2>
    <div class="summary-grid"><div class="summary-card"><strong>${view.authorities.length}</strong><span>Approval groups</span></div><div class="summary-card"><strong>${view.mcpServers.length}</strong><span>Governed MCP servers</span></div><div class="summary-card"><strong>${view.agents.length}</strong><span>Governed agents</span></div><div class="summary-card"><strong>${view.phases.length}</strong><span>Story phases</span></div></div>
    <p class="muted">Jira and Teams credentials remain in VS Code SecretStorage. They are never written into workflow files or prompts.</p>
    <p class="card-foot"><button class="secondary" data-action="jira">Jira connection</button><button class="secondary" data-action="teams">Teams notifications</button><button class="secondary" data-action="open-workflow">Open workflow YAML</button><button class="secondary" data-action="open-portfolio">Open portfolio YAML</button></p>
  </section>`;
}

function memberText(group: AuthorityView): string {
  return group.members.map((entry) => [entry.name, entry.email, entry.githubLogin].filter(Boolean).join(' | ')).join('\n');
}

function people(view: ConfigurationCenterView, selected: AuthorityView | null): string {
  return `<section class="plain"><h2>${icon('agent')}My local profile</h2>
    <p class="muted">This profile changes guidance only. Governed decisions use the Git and GitHub identities shown in approval records.</p>
    <form id="profile-form" class="editor-card"><div class="form-grid"><label><span>Name</span><input name="name" type="text" value="${escape(view.profile.name)}"></label><label><span>Role</span><select name="role">${['product-owner','business-analyst','product-designer','architect','developer','qa','security','delivery-manager','operations','other'].map((role) => `<option value="${role}"${role === view.profile.role ? ' selected' : ''}>${role}</option>`).join('')}</select></label></div><div class="card-foot"><button type="submit">Save local profile</button></div></form>
    <div class="section-heading"><h2>${icon('team')}Human approval authorities</h2><button class="secondary" data-action="new-authority">Add authority</button></div>
    <p class="muted">People are not agents. These groups match real Git email or authenticated GitHub login when somebody approves or rejects.</p>
    <div class="configuration-list">${view.authorities.map((group) => `<button class="configuration-row secondary" data-authority="${escape(`${group.scope}:${group.id}`)}"><span>${icon('approval')}</span><strong>${escape(group.label)}</strong><small>${group.scope === 'story' ? 'Story workflow' : 'Initiative workflow'} · ${group.allowAnyGitIdentity ? 'any Git identity' : `${group.members.length} member${group.members.length === 1 ? '' : 's'}`}</small></button>`).join('') || '<p class="empty">No approval groups are configured.</p>'}</div>
    ${selected ? authorityForm(selected) : ''}
  </section>`;
}

function authorityForm(group: AuthorityView): string {
  return `<form id="authority-form" class="editor-card" data-previous-id="${escape(group.id)}"><div class="section-heading"><h2>${icon('approval')}${group.id ? 'Edit' : 'New'} authority</h2></div>
    <div class="form-grid"><label><span>Applies to</span>${group.id
      ? `<input type="hidden" name="scope" value="${group.scope}"><input type="text" value="${group.scope === 'story' ? 'Story workflows' : 'Initiative workflows'}" disabled><small>Scope is fixed after creation so the group cannot be copied into a second governed file accidentally.</small>`
      : `<select name="scope"><option value="story">Story workflows</option><option value="initiative">Initiative workflows</option></select>`}</label><label><span>Authority ID</span><input name="id" type="text" value="${escape(group.id)}" placeholder="architecture-reviewers"></label><label class="span-2"><span>Display label</span><input name="label" type="text" value="${escape(group.label)}"></label></div>
    ${group.scope === 'story' ? `<label class="check"><input name="allowAnyGitIdentity" type="checkbox"${group.allowAnyGitIdentity ? ' checked' : ''}>Any configured Git identity may act as this Story authority</label>` : '<p class="notice">Initiative authorities require named Git identities. This prevents an Initiative gate from silently becoming open to everyone.</p>'}
    <label class="stack"><span>Named members</span><textarea name="members" rows="5" placeholder="Name | email@example.com | github-login">${escape(memberText(group))}</textarea><small>One person per line: name | email | optional GitHub login.</small></label>
    <div class="card-foot"><button type="submit">Save authority</button><button class="secondary" type="button" data-action="cancel-edit">Cancel</button>${group.id ? '<span class="grow"></span><button class="danger" type="button" data-action="delete-authority">Delete</button>' : ''}</div></form>`;
}

function mcpForm(server: McpServerView): string {
  return `<form id="mcp-form" class="editor-card" data-previous-id="${escape(server.id)}"><div class="section-heading"><h2>${icon('mcp')}${server.id ? 'Edit' : 'New'} MCP policy</h2></div>
    <div class="form-grid"><label><span>Server ID</span><input name="id" type="text" value="${escape(server.id)}" placeholder="playwright"></label><label><span>Display label</span><input name="label" type="text" value="${escape(server.label)}"></label><label><span>Host reference</span><input name="hostReference" type="text" value="${escape(server.hostReference)}"></label><label><span>Host approval</span><select name="approval"><option value="confirm"${server.approval === 'confirm' ? ' selected' : ''}>Confirm every use</option><option value="host"${server.approval === 'host' ? ' selected' : ''}>Use host policy</option></select></label><label class="span-2"><span>Governed agents</span><input name="agents" type="text" value="${csv(server.agents)}" placeholder="qa, product-designer"><small>Comma-separated. Empty means every agent whose Agent Markdown permits the namespace.</small></label><label class="span-2"><span>Allowed phases</span><input name="phases" type="text" value="${csv(server.phases)}" placeholder="verification, conformance"></label><label class="span-2"><span>Allowed tools</span><input name="tools" type="text" value="${csv(server.tools)}" placeholder="browser_navigate, browser_snapshot"><small>Unqualified MCP tool names. Empty permits the whole host namespace.</small></label></div>
    <div class="check-grid"><label class="check"><input name="required" type="checkbox"${server.required ? ' checked' : ''}>Required for matching contexts</label><label class="check"><input name="captureToolCalls" type="checkbox"${server.captureToolCalls ? ' checked' : ''}>Record material tool calls</label><label class="check"><input name="captureResults" type="checkbox"${server.captureResults ? ' checked' : ''}>Require result evidence</label></div>
    <div class="card-foot"><button type="submit">Save MCP policy</button><button class="secondary" type="button" data-action="cancel-edit">Cancel</button>${server.id ? '<span class="grow"></span><button class="danger" type="button" data-action="delete-mcp">Delete</button>' : ''}</div></form>`;
}

function mcp(view: ConfigurationCenterView, selected: McpServerView | null): string {
  return `<section class="plain"><div class="section-heading"><h2>${icon('mcp')}Governed MCP tools</h2><button class="secondary" data-action="new-mcp">Add server policy</button></div>
    <p class="muted">VS Code or Copilot owns the process and credentials. Singularity Flow governs which agents, phases, and tools may use it, then records durable evidence.</p>
    ${(view.mcpErrors.length || view.mcpWarnings.length) ? `<div class="notice warning">${[...view.mcpErrors, ...view.mcpWarnings].map((entry) => `<p>${escape(entry)}</p>`).join('')}</div>` : ''}
    <div class="configuration-list">${view.mcpServers.map((server) => {
      const readiness = server.readiness ?? (server.configured ? 'needs-host-setup' : 'needs-host-setup');
      const glyph: IconName = readiness === 'ready' ? 'ok' : readiness === 'misconfigured' ? 'bad' : 'warning';
      const detail = readiness === 'ready'
        ? `ready on this machine · ${server.sources.join(', ')}`
        : readiness === 'misconfigured'
          ? `misconfigured · ${server.readinessReasons?.join(' ') || 'review host configuration'}`
          : server.configured
            ? 'configured; start, trust, authenticate, then attest readiness'
            : 'host setup required';
      return `<button class="configuration-row secondary" data-mcp="${escape(server.id)}"><span>${icon(glyph)}</span><strong>${escape(server.label)}</strong><small>${escape(`${server.hostReference} · ${detail}`)}</small></button>`;
    }).join('') || '<p class="empty">No MCP servers are governed yet.</p>'}</div>
    <p class="card-foot"><button class="secondary" data-action="playwright">Add Playwright host starter</button><button class="secondary" data-action="open-mcp-host">Open VS Code MCP host file</button><button class="secondary" data-action="instructions">Open Agent Designer</button></p>
    ${selected ? mcpForm(selected) : ''}
  </section>`;
}

export function configurationCenterHtml(view: ConfigurationCenterView, tab: ConfigurationTab, selectedAuthority: AuthorityView | null, selectedMcp: McpServerView | null, notice: string | null, errors: string[]): string {
  return `<header class="inbox-header"><div class="brand-lockup">SINGULARITY <span>FLOW</span></div><p class="eyebrow">Governed repository setup</p><h1>${icon('configuration', { size: 24 })}Configuration Center</h1><p class="meta">Configure the product through guided screens. Use YAML only for advanced settings that do not yet have a form.</p></header>
    ${tabs(tab)}${notice ? `<div class="notice ok">${escape(notice)}</div>` : ''}${errors.length ? `<div class="notice error">${errors.map((entry) => `<p>${escape(entry)}</p>`).join('')}</div>` : ''}
    ${tab === 'overview' ? overview(view) : tab === 'people' ? people(view, selectedAuthority) : mcp(view, selectedMcp)}`;
}

export const CONFIGURATION_CENTER_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const csv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const members = (value) => String(value || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', email = '', githubLogin = ''] = line.split('|').map((part) => part.trim()); return { name, email, githubLogin };
  });
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]'); if (tab) return vscode.postMessage({ type: 'tab', tab: tab.dataset.tab });
    const authority = event.target.closest('[data-authority]'); if (authority) return vscode.postMessage({ type: 'select-authority', key: authority.dataset.authority });
    const mcp = event.target.closest('[data-mcp]'); if (mcp) return vscode.postMessage({ type: 'select-mcp', id: mcp.dataset.mcp });
    const action = event.target.closest('[data-action]'); if (action) return vscode.postMessage({ type: 'action', action: action.dataset.action });
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (form.id === 'profile-form') vscode.postMessage({ type: 'save-profile', name: data.get('name'), role: data.get('role') });
    if (form.id === 'authority-form') vscode.postMessage({ type: 'save-authority', previousId: form.dataset.previousId, scope: data.get('scope'), id: data.get('id'), label: data.get('label'), allowAnyGitIdentity: data.get('allowAnyGitIdentity') === 'on', members: members(data.get('members')) });
    if (form.id === 'mcp-form') vscode.postMessage({ type: 'save-mcp', previousId: form.dataset.previousId, id: data.get('id'), label: data.get('label'), hostReference: data.get('hostReference'), agents: csv(data.get('agents')), phases: csv(data.get('phases')), tools: csv(data.get('tools')), approval: data.get('approval'), required: data.get('required') === 'on', captureToolCalls: data.get('captureToolCalls') === 'on', captureResults: data.get('captureResults') === 'on' });
  });`;

/** HTML renderer for the repository Configuration Center. */
import {
  brandLockup, escape, icon } from './webview.ts';
import type { IconName } from './webview.ts';
import type { AuthorityView, ConfigurationCenterView, ConfigurationTab, McpServerView } from './configuration-center-model.ts';
import { PROFILE_PERSONAS } from './profile-personas.ts';
import { testSetupHtml, TEST_SETUP_SCRIPT } from './test-setup-page.ts';
import type { TestSetupView } from './test-setup-model.ts';

function csv(values: string[]): string { return escape(values.join(', ')); }

type ConfigurationNavigationItem = {
  label: string;
  glyph: IconName;
  tab?: ConfigurationTab;
  action?: string;
};

const CONFIGURATION_NAVIGATION: Array<{ label: string; items: ConfigurationNavigationItem[] }> = [
  { label: 'Repository setup', items: [
    { label: 'Overview', glyph: 'configuration', tab: 'overview' },
    { label: 'After install', glyph: 'configuration', action: 'after-install' },
    { label: 'Recreate & sync configuration', glyph: 'configuration', action: 'recreate-sync' },
    { label: 'Upgrade / migrate SFlow', glyph: 'configuration', action: 'capability-refresh' },
    { label: 'Repair or upgrade setup', glyph: 'configuration', action: 'repository-setup' },
    { label: 'Capabilities', glyph: 'capability', action: 'capabilities' },
    { label: 'Test setup', glyph: 'phase', tab: 'tests' },
    { label: 'Workflow Studio', glyph: 'workflow', action: 'workflow-studio' },
    { label: 'Shared workflow drafts', glyph: 'workflow', action: 'shared-workflow-drafts' },
    { label: 'World Model', glyph: 'worldModel', tab: 'world-model' },
    { label: 'AST intelligence', glyph: 'worldModel', action: 'ast-intelligence' }
  ] },
  { label: 'AI & automation', items: [
    { label: 'Auto mode', glyph: 'start', tab: 'auto' },
    { label: 'Agents & delivery', glyph: 'agent', action: 'open-instruction-designer' },
    { label: 'Skills', glyph: 'agent', action: 'skills' },
    { label: 'Instructions', glyph: 'agent', action: 'instructions' },
    { label: 'Model routing', glyph: 'agent', tab: 'models' },
    { label: 'MCP tools', glyph: 'mcp', tab: 'mcp' }
  ] },
  { label: 'Governance & review', items: [
    { label: 'People & approvals', glyph: 'team', tab: 'people' },
    { label: 'Review proposals', glyph: 'merge', action: 'proposals' },
    { label: 'Visual assurance', glyph: 'visual', action: 'visual-assurance' },
    { label: 'Flow Impact', glyph: 'impact', action: 'open-flow-impact' },
    { label: 'Prompt audit', glyph: 'prompt', action: 'open-prompt-audit' }
  ] }
];

function navigation(active: ConfigurationTab): string {
  return `<aside class="configuration-sidebar">
    <nav class="configuration-nav" aria-label="Configuration areas">
      ${CONFIGURATION_NAVIGATION.map((group) => `<section class="configuration-nav-group" aria-labelledby="configuration-nav-${escape(group.label.toLowerCase().replace(/[^a-z]+/g, '-'))}">
        <h2 id="configuration-nav-${escape(group.label.toLowerCase().replace(/[^a-z]+/g, '-'))}">${escape(group.label)}</h2>
        <ul>${group.items.map((item) => `<li><button type="button" class="configuration-nav-item${item.tab === active ? ' active' : ''}"${item.tab === active ? ' aria-current="page"' : ''}${item.tab ? ` data-tab="${item.tab}"` : ` data-action="${item.action}"`}>${icon(item.glyph, { size: 16 })}<span>${escape(item.label)}</span></button></li>`).join('')}</ul>
      </section>`).join('')}
    </nav>
  </aside>`;
}


function overview(view: ConfigurationCenterView): string {
  return `<section class="plain configuration-overview"><div class="section-heading"><div><h2>${icon('ok')}Repository readiness</h2><p class="muted">A quick view of the governed setup that applies to this repository.</p></div></div>
    <div class="summary-grid"><div class="summary-card"><strong>${view.authorities.length}</strong><span>Approval groups</span></div><div class="summary-card"><strong>${view.mcpServers.length}</strong><span>Governed MCP servers</span></div><div class="summary-card"><strong>${view.agents.length}</strong><span>Governed agents</span></div><div class="summary-card"><strong>${view.phases.length}</strong><span>Story phases</span></div></div>
    <p class="muted">Workflow ledger: <strong>${escape(view.ledger.summary)}</strong>. ${escape(view.ledger.detail)}</p>
    <h2>Connections</h2>
    <div class="configuration-action-list">
      <button class="configuration-action-row" data-action="jira">${icon('configuration', { size: 16 })}<span><strong>Jira connection</strong><small>Project and connection settings</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="teams">${icon('agent', { size: 16 })}<span><strong>Teams notifications</strong><small>Notification and delivery settings</small></span>${icon('next')}</button>
    </div>
    <p class="muted configuration-caption">Credentials stay in VS Code SecretStorage, never workflow files or prompts.</p>

    ${view.publish.changes.length ? `<h2>${icon('merge')}Unpublished configuration</h2>
    <p class="muted">${view.publish.changes.length} file${view.publish.changes.length === 1 ? '' : 's'} changed on ${escape(view.publish.branch)}.</p>
    <ul class="plain-list">${view.publish.changes.map((file) => `<li><code>${escape(file)}</code></li>`).join('')}</ul>
    ${view.publish.unrelated.length
    // Publishing commits one scoped transaction, so unrelated working-tree changes block it. Saying
    // which ones is the difference between a refusal and an instruction.
    ? `<p class="notice warning">Separate these unrelated changes before publishing: ${escape(view.publish.unrelated.join(', '))}</p>`
    : '<p class="card-foot"><button data-action="publish-configuration">Review &amp; publish configuration</button></p>'}` : ''}

    ${view.modelFreedom ? `<h2>${icon('agent')}Model independence</h2>
    <p class="muted">Lifecycle status: <strong>${escape(view.modelFreedom.status)}</strong> · mode ${escape(view.modelFreedom.mode)}.</p>
    ${view.modelFreedom.blockers.length ? `<ul class="plain-list">${view.modelFreedom.blockers.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul>` : ''}
    ${view.modelFreedom.warnings.length ? `<ul class="plain-list muted">${view.modelFreedom.warnings.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul>` : ''}` : ''}

    <h2>Workflow tools</h2>
    <div class="configuration-action-list">
      <button class="configuration-action-row" data-action="recreate-sync">${icon('configuration', { size: 16 })}<span><strong>Recreate &amp; sync configuration</strong><small>Apply pending edits to current approved configuration, archive old proposals, and sync. One click authorizes the update; no Git merge or follow-up questions. Application code and Stories stay unchanged.</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="workflow-studio">${icon('workflow', { size: 16 })}<span><strong>Workflow Studio</strong><small>Design workflows, steps, agents and approvals visually, then publish once.</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="shared-workflow-drafts">${icon('workflow', { size: 16 })}<span><strong>Shared workflow drafts</strong><small>Explicitly save partial drafts in the configuration authority across machines.</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="open-copilot">${icon('agent', { size: 16 })}<span><strong>Continue active Story in Copilot</strong><small>Hand the open interval to Copilot with governed context.</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="open-specification-trace">${icon('document', { size: 16 })}<span><strong>Specification traceability</strong><small>Review which clauses each artifact and test claims to satisfy.</small></span>${icon('next')}</button>
    </div>
    <details class="configuration-advanced-tools"><summary>Advanced configuration</summary>
      <p class="card-foot"><button class="secondary" data-action="open-workflow">Open workflow YAML</button><button class="secondary" data-action="open-portfolio">Open portfolio YAML</button><button class="link" data-action="reset-jira">Reset saved Jira</button></p>
      <div class="configuration-action-list">
        <button class="configuration-action-row" data-action="inspect-composition-cache">${icon('ok', { size: 16 })}<span><strong>Inspect composition cache</strong><small>Review cached agent composition and validity.</small></span>${icon('next')}</button>
        <button class="configuration-action-row" data-action="check-ledger-deployment">${icon('ok', { size: 16 })}<span><strong>Check ledger deployment</strong><small>Verify the governance ledger is reachable and current.</small></span>${icon('next')}</button>
        <button class="configuration-action-row" data-action="open-impact-file">${icon('configuration', { size: 16 })}<span><strong>Open impact.yml</strong><small>Study methods, cohorts, metrics, guardrails, and privacy.</small></span>${icon('next')}</button>
      </div>
    </details>
  </section>`;
}

function option(value: string, current: string, label: string): string {
  return `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(label)}</option>`;
}

/** The two upper Auto policy layers. Capability-specific ceilings remain on the capability page. */
function autoMode(view: ConfigurationCenterView): string {
  const eligibility = (current: string) => [
    option('disabled', current, 'Disabled'),
    option('plan-only', current, 'Plan only — create reviewed plans'),
    option('bounded', current, 'Bounded execution — start confirmed plans')
  ].join('');
  return `<section class="plain">
    <div class="section-heading"><div><h2>${icon('start')}Auto mode</h2>
      <p class="muted">Enable Auto at the repository, then opt in only the work types that may use it. Capability policy may tighten these settings but can never widen them.</p></div>
      <span class="pill ${view.auto.enabled ? 'ok' : ''}">${view.auto.enabled ? 'repository enabled' : 'repository disabled'}</span>
    </div>
    <form id="auto-form" class="editor-card">
      <label class="field"><span>Repository Auto</span>
        <select name="enabled">
          ${option('false', String(view.auto.enabled), 'Off — manual governed workflow only')}
          ${option('true', String(view.auto.enabled), 'On — allow opted-in work types')}
        </select>
        <small>This is the master switch. Turning it on does not start work and does not bypass confirmation, approvals, protected paths, or budgets.</small>
      </label>
      <h3>Work-type eligibility</h3>
      ${view.auto.workTypes.length ? `<div class="form-grid">${view.auto.workTypes.map((workType) => `
        <label class="field"><span>${escape(workType.label)}</span>
          <select data-auto-work-type="${escape(workType.id)}">${eligibility(workType.eligibility)}</select>
          <small><code>${escape(workType.id)}</code></small>
        </label>`).join('')}</div>` : '<p class="empty">No Story work types are declared in this workflow.</p>'}
      <div class="notice warning">Changes are saved as protected repository configuration. Use <strong>Review &amp; publish configuration</strong> after saving before they apply to new Auto plans.</div>
      <p class="card-foot"><button type="submit">Save Auto policy</button><button type="button" class="secondary" data-action="discard-edits">Discard changes</button><button type="button" class="secondary" data-action="capabilities">Review capability limits</button></p>
    </form>
  </section>`;
}

/**
 * Task → model, as the engine resolved it. `[ADP:REQ-020]` `[ADP:REQ-012]`
 *
 * Read-only, deliberately. The mapping is a governed file; a panel that edited it in place would be
 * a second route to changing policy that no review saw. The button opens the YAML instead.
 *
 * The two things worth seeing here are not in either file on its own: which concrete model a task
 * actually reaches after aliases resolve, and which phases route by it. `workflow.yml` says
 * `task: code` and never says what that is; the mapping says what `code` is and never says who uses
 * it. This is the join.
 */
/** Which tiers' effort and Auto profile the mapping sends to Copilot, in words. */
function sendParametersText(value: 'all' | 'none' | string[] | undefined): string {
  if (value === 'all') return 'every tier\'s effort and Auto profile';
  if (Array.isArray(value) && value.length) return `the effort and Auto profile of ${value.map((task) => `<code>${escape(task)}</code>`).join(', ')}`;
  return 'nothing (no tier\'s effort or Auto profile)';
}

function modelRouting(view: ConfigurationCenterView): string {
  const routing = view.modelRouting;
  const heading = `<div class="section-heading"><div><h2>${icon('agent')}Model routing</h2>
    <p class="muted">Work is routed by what it is, not by who sells the model. Only the tier mapping names a vendor, so a model change is one edit in one reviewed file.</p></div>
    <button class="secondary" data-action="open-model-tiers">Open tier mapping</button></div>`;

  if (!routing?.configured) {
    // Not configured is not broken: routing is opt-in, and a repository without a mapping simply
    // uses whatever model each caller names. Saying "none" here would read as a fault.
    return `<section class="plain">${heading}
      <div class="editor-card"><p class="muted">This repository has no <code>singularity/modelTiers.yml</code>, so nothing is routed by task yet. Model choice stays with whatever each caller names.</p></div></section>`;
  }
  if (routing.error) {
    return `<section class="plain">${heading}
      <div class="editor-card"><p class="danger">${escape(routing.error)}</p>
      <p class="muted">The mapping exists but cannot be read, so no task can resolve. This is different from having no mapping at all.</p></div></section>`;
  }

  const rows = routing.tasks.map((entry) => {
    const via = entry.aliasOf ? `<span class="muted"> via ${escape(entry.aliasOf)}</span>` : '';
    const fallback = entry.fallback.length
      ? `<code>${entry.fallback.map((name) => escape(name)).join('</code> → <code>')}</code>`
      : '<span class="muted">none</span>';
    // Sent params go to Copilot; the rest are recorded on the receipt only (see sendParameters).
    const params = entry.params
      ? Object.entries(entry.params).map(([key, value]) => `<code>${escape(key)}=${escape(String(value))}</code>${entry.sentParams && Object.hasOwn(entry.sentParams, key) ? ' <span class="pill">sent</span>' : ''}`).join(' ')
      : '<span class="muted">—</span>';
    // An empty phase list is the normal case for tasks a workflow never declares, so it reads as
    // "nothing routes by this yet" rather than as a gap someone forgot to fill.
    const phases = entry.phases.length
      ? entry.phases.map((phase) => `<code>${escape(phase)}</code>`).join(' ')
      : '<span class="muted">not declared by any phase</span>';
    return `<tr><td><strong>${escape(entry.task)}</strong>${via}</td>
      <td><code>${escape(entry.model)}</code></td><td>${fallback}</td><td>${params}</td><td>${phases}</td></tr>`;
  }).join('');

  return `<section class="plain">${heading}
    <div class="editor-card">
      <table class="rows"><thead><tr><th>Task</th><th>Model</th><th>Fallback</th><th>Parameters</th><th>Routed by</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <p class="muted">Sent to Copilot: ${sendParametersText(routing.sendParameters)}. Set <code>sendParameters</code> in the tier mapping to <code>none</code>, <code>all</code> or a list of tasks; params not sent are recorded on each invocation receipt only.</p>
      <p class="muted">Mapping revision <code>${escape((routing.revision ?? '').slice(0, 12))}</code> — pinned per story alongside the task, so a model retired mid-story changes what runs without changing what the story was governed by.</p>
    </div></section>`;
}

/** The World Model is the Repository brief read from the source; this tab only chooses which directories it reads. */
function worldModel(view: ConfigurationCenterView): string {
  const model = view.worldModel;
  const source = view.configurationState;
  const proposed = Boolean(source.effective?.kind && source.effective.kind !== 'working-tree');
  return `<section class="plain world-model-settings">
    <div class="section-heading"><div><p class="eyebrow">World Model</p><h2>${icon('worldModel')}Repository brief</h2><p class="muted">Every phase prompt gets a short Repository brief read from the source with no build: the rules that apply, contracts, flows, what the Story's change touches and the risky places.</p></div><div class="button-row"><button class="secondary" data-action="repository-brief">Open Repository Brief</button><button class="secondary" data-action="open-workflow">Open advanced YAML</button></div></div>
    <p class="muted">See what a phase receives with <code>singularity-flow wm brief --phase PHASE</code>. A work type leaves it out with <code>intelligence.worldModel: off</code>.</p>
    <form id="world-model-form">
      <div class="editor-card">
        <h2>${icon('document')}Source scope</h2>
        <p class="muted">The directories the Repository brief and AST intelligence read.</p>
        <div class="form-grid">
          <label class="span-2"><span>Application source roots</span><input name="sourceRoots" type="text" value="${csv(model.sourceRoots)}" placeholder="apps/payments, services/checkout"><small>Comma-separated repository directories. Leave empty to read the whole application tree.</small></label>
          <label class="span-2"><span>Shared source roots</span><input name="sharedRoots" type="text" value="${csv(model.sharedRoots)}" placeholder="libs/contracts, libs/platform"><small>Shared contracts and platform code read alongside the application roots.</small></label>
        </div>
        <p class="card-foot"><button class="secondary" type="button" data-action="diagnose-monorepo">Benchmark this repository</button><small>Measures warm Git status and scoped fingerprint cost without changing Git configuration.</small></p>
      </div>
      <p class="notice">${proposed
    ? 'Saving creates a review proposal from the exact approved authority; it never rewrites the application checkout.'
    : 'Saving writes a validated local draft; review and publish it before it takes effect.'}${view.publish.changes.length ? ` <strong>${view.publish.changes.length} local configuration change${view.publish.changes.length === 1 ? '' : 's'} awaiting publication.</strong>` : ''}</p>
      <div class="card-foot"><button type="submit">Save source scope</button><button type="button" class="secondary" data-action="discard-edits">Discard changes</button></div>
    </form>
  </section>`;
}

function memberText(group: AuthorityView): string {
  return group.members.map((entry) => [entry.name, entry.email, entry.githubLogin].filter(Boolean).join(' | ')).join('\n');
}

function currentIdentityCard(view: ConfigurationCenterView): string {
  const identity = view.gitIdentity;
  if (!identity) return `<div class="editor-card"><h2>${icon('approval')}Add my Git identity</h2>
    <p class="notice warning">No Git email or GitHub login is available for this repository. Configure <code>git user.name</code> and <code>git user.email</code>, then refresh this screen.</p></div>`;
  const story = view.authorities.filter((entry) => entry.scope === 'story');
  const initiative = view.authorities.filter((entry) => entry.scope === 'initiative');
  const choices = [
    ...(story.length || initiative.length ? [`<option value="*">All configured approval groups (${story.length + initiative.length}) — default</option>`] : []),
    ...(story.length ? [`<option value="story:*">All Story approval groups (${story.length})</option>`] : []),
    ...(initiative.length ? [`<option value="initiative:*">All Initiative approval groups (${initiative.length})</option>`] : []),
    ...(story.length ? [`<optgroup label="Individual Story groups">${story.map((group) => `<option value="story:${escape(group.id)}">${escape(group.label)}</option>`).join('')}</optgroup>`] : []),
    ...(initiative.length ? [`<optgroup label="Individual Initiative groups">${initiative.map((group) => `<option value="initiative:${escape(group.id)}">${escape(group.label)}</option>`).join('')}</optgroup>`] : [])
  ].join('');
  return `<form id="current-identity-authority-form" class="editor-card">
    <div class="section-heading"><div><h2>${icon('approval')}Add my current Git identity</h2><p class="muted">By default, your identity is added to every configured approval group. You can narrow it to one scope or group. Existing matching members are enriched, never duplicated.</p></div></div>
    <div class="summary-grid"><div class="summary-card"><strong>${escape(identity.name)}</strong><span>Git name</span></div><div class="summary-card"><strong>${escape(identity.email || 'not configured')}</strong><span>Git email</span></div><div class="summary-card"><strong>${escape(identity.githubLogin || 'not resolved')}</strong><span>GitHub login</span></div></div>
    <div class="form-grid"><label class="span-2"><span>Apply identity to</span><select name="target">${choices}</select><small>Authority is granted only to the selected governed groups.</small></label></div>
    <div class="check-grid"><label class="check"><input name="allowSelfApproval" type="checkbox"${view.approvalAllowSelfApproval ? ' checked' : ''}>Allow self-approval for newly started work</label>
    <label class="check"><input name="autoEnrollNewIdentities" type="checkbox"${view.approvalAutoEnrollNewIdentities ? ' checked' : ''}>Automatically add a new Git identity to every approval group when work starts</label></div>
    <small>Both controls are enabled by default for normal team configuration and can be disabled here. Current profile: <code>${escape(view.approvalSecurityProfile)}</code>. Active work keeps its pinned policy.</small>
    <div class="card-foot"><button type="submit">Add, commit &amp; push</button></div>
  </form>`;
}

function people(view: ConfigurationCenterView, selected: AuthorityView | null): string {
  return `<section class="plain"><h2>${icon('agent')}My local profile</h2>
    <p class="muted">This profile changes guidance only. Governed decisions use the Git and GitHub identities shown in approval records.</p>
    <form id="profile-form" class="editor-card"><div class="form-grid"><label><span>Name</span><input name="name" type="text" value="${escape(view.profile.name)}"></label><label><span>Menu persona</span><select name="role">${PROFILE_PERSONAS.map((persona) => `<option value="${persona.id}"${persona.id === view.profile.role ? ' selected' : ''}>${escape(persona.label)}</option>`).join('')}</select><small>Changes menu order and suggestions only.</small></label></div><div class="card-foot"><button type="submit">Save local profile</button><button type="button" class="secondary" data-action="discard-edits">Discard changes</button></div></form>
    ${currentIdentityCard(view)}
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
    <p class="card-foot"><button class="secondary" data-action="playwright">Add Playwright host starter</button><button class="secondary" data-action="open-mcp-host">Open VS Code MCP host file</button><button class="secondary" data-action="open-instruction-designer">Open Agent Designer</button></p>
    ${selected ? mcpForm(selected) : ''}
  </section>`;
}

export function configurationCenterHtml(
  view: ConfigurationCenterView,
  tab: ConfigurationTab,
  selectedAuthority: AuthorityView | null,
  selectedMcp: McpServerView | null,
  notice: string | null,
  errors: string[],
  pendingProposal: { branch: string; baseBranch: string } | null = null,
  testSetup: TestSetupView = { targets: [], selected: null, inspection: null }
): string {
  const candidate = view.configurationState.candidate;
  const candidateNotice = candidate?.status === 'invalid'
    ? `<div class="notice error"><p><strong>Local configuration candidate was not loaded.</strong> ${escape(candidate.error ?? 'Validation failed.')}</p><p>The editor continues to show approved effective configuration. Open the YAML, repair the candidate, and reload.</p><button class="secondary" data-action="open-workflow">Open workflow YAML</button></div>`
    : candidate?.status === 'valid'
      ? `<div class="notice warning"><strong>Validated local configuration candidate.</strong> These editable values are not effective authority until configuration is reviewed and published.</div>`
      : '';
  const content = `${notice ? `<div class="notice ok">${escape(notice)}</div>` : ''}${errors.length ? `<div class="notice error">${errors.map((entry) => `<p>${escape(entry)}</p>`).join('')}<button class="secondary" data-help-topic="configuration">Explain this error</button></div>` : ''}${candidateNotice}
      ${tab === 'overview' ? overview(view) : tab === 'tests' ? testSetupHtml(testSetup) : tab === 'auto' ? autoMode(view) : tab === 'world-model' ? worldModel(view) : tab === 'models' ? modelRouting(view) : tab === 'people' ? people(view, selectedAuthority) : mcp(view, selectedMcp)}`;
  const guardedContent = pendingProposal
    ? `<div class="notice warning" role="status"><strong>Configuration proposal pending review.</strong> The submitted settings are on <code>${escape(pendingProposal.branch)}</code> and are not approved yet. Merge it into <code>${escape(pendingProposal.baseBranch)}</code>, then recheck the approved authority. If you discarded it instead, deliberately resume the approved baseline. The approved baseline below is read-only until then.<span class="grow"></span><button class="secondary" type="button" data-action="workflow-proposals">Review proposal</button><button class="secondary" id="configuration-pending-refresh" type="button">Recheck approved authority</button><button class="secondary" id="configuration-resume-approved" type="button">Resume approved baseline</button></div><fieldset disabled aria-label="Approved configuration is read-only while a proposal is pending">${content}</fieldset>`
    : content;
  return `<header class="inbox-header">${brandLockup()}<p class="eyebrow">Governed repository setup</p><h1>${icon('configuration', { size: 24 })}Configuration Center</h1><p class="meta">Configure the product through guided screens. Use YAML only for advanced settings that do not yet have a form.</p></header>
    <div id="configuration-runtime-message" class="notice warning" role="status" aria-live="polite" hidden><span id="configuration-runtime-text"></span><span class="grow"></span><button class="secondary" id="configuration-reload" type="button">Reload newer configuration</button><button class="secondary" id="configuration-keep" type="button">Keep editing</button><button class="secondary" id="configuration-runtime-resume-approved" type="button" hidden>Resume approved baseline</button></div>
    <div class="configuration-shell">${navigation(tab)}<main class="configuration-content">
      ${guardedContent}
    </main></div>`;
}

export const CONFIGURATION_CENTER_SCRIPT = `
  const vscode = window.__sfVscode;
  const csv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const members = (value) => String(value || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', email = '', githubLogin = ''] = line.split('|').map((part) => part.trim()); return { name, email, githubLogin };
  });
  let dirty = false;
  let savingForm = false;
  const markDirty = () => { if (!dirty) { dirty = true; vscode.postMessage({ type: 'form-dirty', dirty: true }); } };
  const runtime = document.getElementById('configuration-runtime-message');
  const runtimeText = document.getElementById('configuration-runtime-text');
  const showRuntime = (text, conflict) => {
    if (runtimeText) runtimeText.textContent = text;
    if (runtime) runtime.hidden = false;
    const reload = document.getElementById('configuration-reload');
    const keep = document.getElementById('configuration-keep');
    if (reload) reload.hidden = !conflict; if (keep) keep.hidden = !conflict;
  };
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'configuration-repository-changed') showRuntime('Repository configuration changed while you were editing. Reload to use the newer version, or keep this draft and review the conflict before saving.', true);
    if (event.data?.type === 'configuration-save-error') {
      savingForm = false;
      document.querySelectorAll('form button[type="submit"]').forEach((button) => { button.disabled = false; });
      showRuntime((event.data.errors || []).join(' '), event.data.conflict === true);
    }
    if (event.data?.type === 'configuration-save-busy') showRuntime('A configuration save is already being validated. Wait for that result before retrying.', false);
    if (event.data?.type === 'configuration-proposal-pending') {
      savingForm = false;
      dirty = false;
      document.querySelectorAll('form input, form select, form textarea, form button').forEach((control) => { control.disabled = true; });
      showRuntime('Configuration proposal ' + event.data.branch + ' is pending review into ' + event.data.baseBranch + '. The submitted values are shown read-only; merge or discard the proposal before editing again.', false);
      const resume = document.getElementById('configuration-runtime-resume-approved');
      if (resume) resume.hidden = false;
    }
  });
  document.getElementById('configuration-reload')?.addEventListener('click', () => vscode.postMessage({ type: 'reload-dirty' }));
  document.getElementById('configuration-pending-refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'reload-dirty' }));
  document.getElementById('configuration-resume-approved')?.addEventListener('click', () => vscode.postMessage({ type: 'resume-approved-baseline' }));
  document.getElementById('configuration-runtime-resume-approved')?.addEventListener('click', () => vscode.postMessage({ type: 'resume-approved-baseline' }));
  document.getElementById('configuration-keep')?.addEventListener('click', () => { if (runtime) runtime.hidden = true; vscode.postMessage({ type: 'keep-dirty' }); });
  document.addEventListener('input', (event) => { if (event.target?.closest('form')) markDirty(); });
  document.addEventListener('click', (event) => {
    const help = event.target.closest('[data-help-topic]'); if (help) return vscode.postMessage({ type: 'open-help-topic', topic: help.dataset.helpTopic });
    const tab = event.target.closest('[data-tab]'); if (tab) return vscode.postMessage({ type: 'tab', tab: tab.dataset.tab });
    const authority = event.target.closest('[data-authority]'); if (authority) return vscode.postMessage({ type: 'select-authority', key: authority.dataset.authority });
    const mcp = event.target.closest('[data-mcp]'); if (mcp) return vscode.postMessage({ type: 'select-mcp', id: mcp.dataset.mcp });
    const openPath = event.target.closest('[data-open-path]'); if (openPath) return vscode.postMessage({ type: 'open-path', path: openPath.dataset.openPath });
    const action = event.target.closest('[data-action]'); if (action) return vscode.postMessage({ type: 'action', action: action.dataset.action });
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.target;
    if (savingForm) return;
    savingForm = true;
    form.querySelectorAll('button[type="submit"]').forEach((button) => { button.disabled = true; });
    const data = new FormData(form);
    if (form.id === 'test-setup-form') return submitTestSetup(form);
    if (form.id === 'profile-form') vscode.postMessage({ type: 'save-profile', name: data.get('name'), role: data.get('role') });
    if (form.id === 'current-identity-authority-form') vscode.postMessage({ type: 'add-current-identity', target: data.get('target'), allowSelfApproval: data.get('allowSelfApproval') === 'on', autoEnrollNewIdentities: data.get('autoEnrollNewIdentities') === 'on' });
    if (form.id === 'authority-form') vscode.postMessage({ type: 'save-authority', previousId: form.dataset.previousId, scope: data.get('scope'), id: data.get('id'), label: data.get('label'), allowAnyGitIdentity: data.get('allowAnyGitIdentity') === 'on', members: members(data.get('members')) });
    if (form.id === 'mcp-form') vscode.postMessage({ type: 'save-mcp', previousId: form.dataset.previousId, id: data.get('id'), label: data.get('label'), hostReference: data.get('hostReference'), agents: csv(data.get('agents')), phases: csv(data.get('phases')), tools: csv(data.get('tools')), approval: data.get('approval'), required: data.get('required') === 'on', captureToolCalls: data.get('captureToolCalls') === 'on', captureResults: data.get('captureResults') === 'on' });
    if (form.id === 'auto-form') vscode.postMessage({ type: 'save-auto', enabled: data.get('enabled') === 'true', workTypes: Array.from(form.querySelectorAll('[data-auto-work-type]')).map((field) => ({ id: field.dataset.autoWorkType, eligibility: field.value })) });
    if (form.id === 'world-model-form') vscode.postMessage({ type: 'save-world-model', sourceRoots: csv(data.get('sourceRoots')), sharedRoots: csv(data.get('sharedRoots')) });
  });
  document.addEventListener('change', (event) => {
    if (event.target?.closest('form')) markDirty();
  });
  ${TEST_SETUP_SCRIPT}`;

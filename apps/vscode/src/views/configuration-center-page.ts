/** HTML renderer for the repository Configuration Center. */
import {
  brandLockup, escape, icon } from './webview.ts';
import type { IconName } from './webview.ts';
import type { AuthorityView, ConfigurationCenterView, ConfigurationTab, McpServerView } from './configuration-center-model.ts';
import { PROFILE_PERSONAS } from './profile-personas.ts';

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
    { label: 'Capabilities', glyph: 'capability', action: 'capabilities' },
    { label: 'Workflows & artifacts', glyph: 'workflow', action: 'workflow' },
    { label: 'World model', glyph: 'worldModel', tab: 'world-model' },
    { label: 'AST intelligence', glyph: 'worldModel', action: 'ast-intelligence' }
  ] },
  { label: 'AI & automation', items: [
    { label: 'Agents & delivery', glyph: 'agent', action: 'open-instruction-designer' },
    { label: 'Model routing', glyph: 'agent', tab: 'models' },
    { label: 'Templates & instructions', glyph: 'document', tab: 'templates' },
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

/**
 * The editable file sets: artifact templates, repository prompts, skills and prompt packs.
 *
 * This is the Configuration sidebar's file tree, moved. It is read-only in the sense that the rows
 * open the file rather than editing it in place — the catalog and these files are governed, and a
 * panel that wrote them here would be a second way to change policy that no review saw.
 */
function fileSets(view: ConfigurationCenterView): string {
  return view.fileSets.map((set) => `<section class="plain">
    <div class="section-heading"><h2>${icon(set.id === 'templates' ? 'artifact' : set.id === 'prompts' ? 'prompt' : set.id === 'agents' ? 'agent' : 'skill')}${escape(set.label)}</h2>
      <span class="muted">${set.files.length ? `${set.files.length}` : 'none'}</span></div>
    ${set.files.length ? `<table class="configuration-table"><thead><tr>
      <th>Name</th><th>Reference</th><th>File</th><th>Status</th>
    </tr></thead><tbody>
    ${set.files.map((entry) => `<tr>
        <td><strong>${escape(entry.label)}</strong>${entry.description ? `<br><small>${escape(entry.description)}</small>` : ''}</td>
        <td>${entry.catalogId ? `<code>template:${escape(entry.catalogId)}</code>` : `<small class="muted">${entry.kind ? escape(entry.kind) : 'not catalogued'}</small>`}</td>
        <td><button class="link" data-open-path="${escape(entry.path)}">${escape(entry.name)}</button></td>
        <td>${status(entry)}</td>
      </tr>`).join('')}
  </tbody></table>` : `<p class="empty">This repository declares no ${escape(set.label.toLowerCase())}.</p>`}
  </section>`).join('');
}

/**
 * Whether an edit survives an upgrade outranks how many phases reference it, so packaged wins the
 * cell. Usage that was never computed is reported as exactly that, never as "unused".
 */
function status(entry: ConfigurationCenterView['fileSets'][number]['files'][number]): string {
  if (entry.packaged) return '<small class="muted">packaged</small>';
  if (entry.usedBy === null) return '<small class="muted">not computed</small>';
  return entry.usedBy.length ? escape(entry.usedBy.join(', ')) : '<small class="muted">unused</small>';
}

function overview(view: ConfigurationCenterView): string {
  return `<section class="plain configuration-overview"><div class="section-heading"><div><h2>${icon('ok')}Repository readiness</h2><p class="muted">A quick view of the governed setup that applies to this repository.</p></div></div>
    <div class="summary-grid"><div class="summary-card"><strong>${view.authorities.length}</strong><span>Approval groups</span></div><div class="summary-card"><strong>${view.mcpServers.length}</strong><span>Governed MCP servers</span></div><div class="summary-card"><strong>${view.agents.length}</strong><span>Governed agents</span></div><div class="summary-card"><strong>${view.phases.length}</strong><span>Story phases</span></div></div>
    <p class="muted">Workflow ledger: <strong>${escape(view.ledger.summary)}</strong>. ${escape(view.ledger.detail)}</p>
    <p class="muted">Jira and Teams credentials remain in VS Code SecretStorage. They are never written into workflow files or prompts.</p>
    <p class="card-foot"><button class="secondary" data-action="jira">Jira connection</button><button class="secondary" data-action="teams">Teams notifications</button><button class="secondary" data-action="reset-jira">Reset saved Jira</button><button class="secondary" data-action="open-workflow">Open workflow YAML</button><button class="secondary" data-action="open-portfolio">Open portfolio YAML</button></p>

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

    <h2>${icon('workflow')}Common actions</h2>
    <p class="muted">Open the most common operational tools without turning every destination into an equally prominent card.</p>
    <div class="configuration-action-list">
      <button class="configuration-action-row" data-action="open-designer">${icon('workflow', { size: 16 })}<span><strong>Workflow Designer</strong><small>Work types, phases, gates, and artifact flow.</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="open-copilot">${icon('agent', { size: 16 })}<span><strong>Continue active Story in Copilot</strong><small>Hand the open interval to Copilot with governed context.</small></span>${icon('next')}</button>
      <button class="configuration-action-row" data-action="open-specification-trace">${icon('document', { size: 16 })}<span><strong>Specification traceability</strong><small>Review which clauses each artifact and test claims to satisfy.</small></span>${icon('next')}</button>
    </div>
    <details class="configuration-advanced-tools"><summary>Advanced tools</summary>
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
    const params = entry.params
      ? Object.entries(entry.params).map(([key, value]) => `<code>${escape(key)}=${escape(String(value))}</code>`).join(' ')
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
      <p class="muted">Mapping revision <code>${escape((routing.revision ?? '').slice(0, 12))}</code> — pinned per story alongside the task, so a model retired mid-story changes what runs without changing what the story was governed by.</p>
    </div></section>`;
}

function worldModel(view: ConfigurationCenterView): string {
  const model = view.worldModel;
  return `<section class="plain world-model-settings">
    <h2>${icon('worldModel')}Current grounding</h2>
    ${view.worldModelStatus.rebuildReason
    ? `<p class="notice warning">${escape(view.worldModelStatus.rebuildReason)}<span class="grow"></span><button class="secondary" data-action="build-world-model">Rebuild</button></p>`
    : view.worldModelStatus.built
      ? ''
      : '<p class="notice warning">This repository has no world model yet, so governed prompts are ungrounded.<span class="grow"></span><button class="secondary" data-action="build-world-model">Build the world model</button></p>'}
    ${view.worldModelStatus.views.length
    ? `<table class="configuration-table"><thead><tr><th>View</th><th>References</th><th>File</th></tr></thead><tbody>
      ${view.worldModelStatus.views.map((entry) => `<tr><td><strong>${escape(entry.id)}</strong></td>
        <td>${entry.references ? `${entry.references}` : '<small class="muted">no references</small>'}</td>
        <td><button class="link" data-open-path="${escape(entry.path)}">${escape(entry.path)}</button></td></tr>`).join('')}
    </tbody></table>`
    : '<p class="empty">No views have been generated.</p>'}

    <div class="section-heading"><div><h2>${icon('worldModel')}World-model behavior</h2><p class="muted">Control when repository grounding is required and how missing context is created. Read-only status commands never invoke a model.</p></div><button class="secondary" data-action="open-workflow">Open advanced YAML</button></div>
    <form id="world-model-form">
      <div class="editor-card">
        <h2>${icon('approval')}Grounding policy</h2>
        <div class="form-grid">
          <label><span>Phase grounding</span><select name="grounding">${option('off', model.grounding, 'Off — do not require grounding')}${option('warn', model.grounding, 'Warn — continue with a visible warning')}${option('enforce', model.grounding, 'Enforce — block until grounded')}</select><small>Warn is the adoption-friendly setting. Enforce turns missing or invalid grounding into a hard lifecycle gate.</small></label>
          <label><span>Stale model</span><select name="staleness">${option('warn', model.staleness, 'Warn and continue')}${option('fail', model.staleness, 'Fail until refreshed')}${option('ignore', model.staleness, 'Ignore staleness')}</select><small>Controls a committed model whose source-tree hash no longer matches the repository.</small></label>
        </div>
      </div>

      <div class="editor-card">
        <h2>${icon('worldModel')}Materialization</h2>
        <p class="muted">Choose whether Flow may create a missing model while performing a mutating lifecycle action.</p>
        <div class="form-grid">
          <label><span>Mode</span><select name="materializationMode">${option('explicit', model.materialization.mode, 'Explicit — user runs world-model command')}${option('on-demand', model.materialization.mode, 'On demand — prepare when required')}${option('disabled', model.materialization.mode, 'Disabled — no automatic materialization; explicit builds remain available')}</select></label>
          <label><span>Generation depth</span><select name="materializationDepth" id="world-model-depth">${option('light', model.materialization.depth, 'Light — deterministic, zero model tokens')}${option('phase', model.materialization.depth, 'Phase — phase-aware, may invoke a model')}</select></label>
          <label><span>Confirmation</span><select name="materializationConfirmation" id="world-model-confirmation">${option('prompt', model.materialization.confirmation, 'Prompt before generation')}${option('automatic', model.materialization.confirmation, 'Automatic — light depth only')}</select><small>Automatic is deliberately restricted to deterministic light generation. Model-driven generation always needs confirmation.</small></label>
          <label><span>Publication</span><select name="materializationPublish">${option('governed', model.materialization.publish, 'Governed — commit and publish')}${option('local', model.materialization.publish, 'Local — do not publish')}</select></label>
          <label><span>Look ahead</span><select name="materializationLookahead">${option('none', model.materialization.lookahead, 'Current phase only')}${option('next-phase', model.materialization.lookahead, 'Also prepare next phase')}</select></label>
        </div>
        <div class="notice"><strong>Recommended low-friction setup:</strong> on demand + light + automatic. It creates deterministic repository facts without calling a model or consuming model tokens.</div>
      </div>

      <div class="editor-card">
        <h2>${icon('document')}Content and storage</h2>
        <div class="form-grid">
          <label class="span-2"><span>Declared views</span><input name="views" type="text" value="${csv(model.views)}" placeholder="business, architecture, development"><small>Comma-separated lower-case IDs. Saving is refused if a phase or agent references a view you removed.</small></label>
          <label class="span-2"><span>Application source roots</span><input name="sourceRoots" type="text" value="${csv(model.sourceRoots)}" placeholder="apps/payments, services/checkout"><small>Comma-separated repository directories. Leave empty to model the whole application tree.</small></label>
          <label class="span-2"><span>Shared source roots</span><input name="sharedRoots" type="text" value="${csv(model.sharedRoots)}" placeholder="libs/contracts, libs/platform"><small>Shared contracts and platform code included alongside the application roots. Sparse-absent tracked files remain present through Git object IDs.</small></label>
          <label><span>Output directory</span><input name="outputDir" type="text" value="${escape(model.outputDir)}"></label>
          <label><span>Builder prompt</span><input name="promptSource" type="text" value="${escape(model.promptSource)}"><small>Use <code>builtin</code> or a repository-relative Markdown file.</small></label>
          <label><span>State fetch timeout (ms)</span><input name="stateFetchTimeoutMs" type="number" min="250" max="60000" step="250" value="${model.stateFetchTimeoutMs}"></label>
        </div>
      </div>

      <div class="editor-card">
        <h2>${icon('impact')}Generation performance</h2>
        <div class="form-grid">
          <label class="check"><input name="generationParallel" type="checkbox"${model.generation.parallel ? ' checked' : ''}>Build independent views in parallel</label>
          <label><span>Maximum workers</span><input name="generationMaxWorkers" type="number" min="1" max="16" step="1" value="${model.generation.maxWorkers}"><small>Used only when parallel generation is enabled.</small></label>
          <label><span>Strategy</span><input type="text" value="One worker per view" disabled><small>The current deterministic strategy is fixed to <code>view</code>.</small></label>
        </div>
        <p class="card-foot"><button class="secondary" type="button" data-action="diagnose-monorepo">Benchmark this repository</button><small>Measures warm Git status and scoped fingerprint cost without changing Git configuration.</small></p>
      </div>

      <div class="editor-card">
        <h2>${icon('prompt')}Prompt injection</h2>
        <div class="form-grid">
          <label><span>Mode</span><select name="injectionMode">${option('append', model.injection.mode, 'Append when placeholder is absent')}${option('replace', model.injection.mode, 'Replace placeholder only')}${option('off', model.injection.mode, 'Off — do not inject')}</select></label>
          <label><span>Maximum injected bytes</span><input name="injectionMaxBytes" type="number" min="1" step="1024" value="${model.injection.maxBytes}"></label>
          <label class="span-2"><span>Placeholder</span><input name="injectionPlaceholder" type="text" value="${escape(model.injection.placeholder)}"></label>
        </div>
        <p class="muted">${model.injection.rulesCount} advanced routing rule${model.injection.rulesCount === 1 ? '' : 's'} configured. Guided saving preserves these rules unchanged; edit them in workflow YAML when conditional agent, phase, or path routing is required.</p>
      </div>
      <div class="card-foot"><button type="submit">Save world-model settings</button><button class="secondary" type="button" data-action="open-workflow">Open YAML</button></div>
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
    <form id="profile-form" class="editor-card"><div class="form-grid"><label><span>Name</span><input name="name" type="text" value="${escape(view.profile.name)}"></label><label><span>Menu persona</span><select name="role">${PROFILE_PERSONAS.map((persona) => `<option value="${persona.id}"${persona.id === view.profile.role ? ' selected' : ''}>${escape(persona.label)}</option>`).join('')}</select><small>Changes menu order and suggestions only.</small></label></div><div class="card-foot"><button type="submit">Save local profile</button></div></form>
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
    <p class="card-foot"><button class="secondary" data-action="playwright">Add Playwright host starter</button><button class="secondary" data-action="open-mcp-host">Open VS Code MCP host file</button><button class="secondary" data-action="instructions">Open Agent Designer</button></p>
    ${selected ? mcpForm(selected) : ''}
  </section>`;
}

export function configurationCenterHtml(view: ConfigurationCenterView, tab: ConfigurationTab, selectedAuthority: AuthorityView | null, selectedMcp: McpServerView | null, notice: string | null, errors: string[]): string {
  return `<header class="inbox-header">${brandLockup()}<p class="eyebrow">Governed repository setup</p><h1>${icon('configuration', { size: 24 })}Configuration Center</h1><p class="meta">Configure the product through guided screens. Use YAML only for advanced settings that do not yet have a form.</p></header>
    <div id="configuration-runtime-message" class="notice warning" role="status" aria-live="polite" hidden><span id="configuration-runtime-text"></span><span class="grow"></span><button class="secondary" id="configuration-reload" type="button">Reload newer configuration</button><button class="secondary" id="configuration-keep" type="button">Keep editing</button></div>
    <div class="configuration-shell">${navigation(tab)}<main class="configuration-content">
      ${notice ? `<div class="notice ok">${escape(notice)}</div>` : ''}${errors.length ? `<div class="notice error">${errors.map((entry) => `<p>${escape(entry)}</p>`).join('')}</div>` : ''}
      ${tab === 'overview' ? overview(view) : tab === 'world-model' ? worldModel(view) : tab === 'models' ? modelRouting(view) : tab === 'templates' ? fileSets(view) : tab === 'people' ? people(view, selectedAuthority) : mcp(view, selectedMcp)}
    </main></div>`;
}

export const CONFIGURATION_CENTER_SCRIPT = `
  const vscode = window.__sfVscode;
  const csv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const members = (value) => String(value || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name = '', email = '', githubLogin = ''] = line.split('|').map((part) => part.trim()); return { name, email, githubLogin };
  });
  let dirty = false;
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
    if (event.data?.type === 'configuration-save-error') showRuntime((event.data.errors || []).join(' '), false);
  });
  document.getElementById('configuration-reload')?.addEventListener('click', () => vscode.postMessage({ type: 'reload-dirty' }));
  document.getElementById('configuration-keep')?.addEventListener('click', () => { if (runtime) runtime.hidden = true; vscode.postMessage({ type: 'keep-dirty' }); });
  document.addEventListener('input', (event) => { if (event.target?.closest('form')) markDirty(); });
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]'); if (tab) return vscode.postMessage({ type: 'tab', tab: tab.dataset.tab });
    const authority = event.target.closest('[data-authority]'); if (authority) return vscode.postMessage({ type: 'select-authority', key: authority.dataset.authority });
    const mcp = event.target.closest('[data-mcp]'); if (mcp) return vscode.postMessage({ type: 'select-mcp', id: mcp.dataset.mcp });
    const openPath = event.target.closest('[data-open-path]'); if (openPath) return vscode.postMessage({ type: 'open-path', path: openPath.dataset.openPath });
    const action = event.target.closest('[data-action]'); if (action) return vscode.postMessage({ type: 'action', action: action.dataset.action });
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (form.id === 'profile-form') vscode.postMessage({ type: 'save-profile', name: data.get('name'), role: data.get('role') });
    if (form.id === 'current-identity-authority-form') vscode.postMessage({ type: 'add-current-identity', target: data.get('target'), allowSelfApproval: data.get('allowSelfApproval') === 'on', autoEnrollNewIdentities: data.get('autoEnrollNewIdentities') === 'on' });
    if (form.id === 'authority-form') vscode.postMessage({ type: 'save-authority', previousId: form.dataset.previousId, scope: data.get('scope'), id: data.get('id'), label: data.get('label'), allowAnyGitIdentity: data.get('allowAnyGitIdentity') === 'on', members: members(data.get('members')) });
    if (form.id === 'mcp-form') vscode.postMessage({ type: 'save-mcp', previousId: form.dataset.previousId, id: data.get('id'), label: data.get('label'), hostReference: data.get('hostReference'), agents: csv(data.get('agents')), phases: csv(data.get('phases')), tools: csv(data.get('tools')), approval: data.get('approval'), required: data.get('required') === 'on', captureToolCalls: data.get('captureToolCalls') === 'on', captureResults: data.get('captureResults') === 'on' });
    if (form.id === 'world-model-form') vscode.postMessage({ type: 'save-world-model', views: csv(data.get('views')), sourceRoots: csv(data.get('sourceRoots')), sharedRoots: csv(data.get('sharedRoots')), outputDir: data.get('outputDir'), promptSource: data.get('promptSource'), stateFetchTimeoutMs: Number(data.get('stateFetchTimeoutMs')), generation: { parallel: data.get('generationParallel') === 'on', maxWorkers: Number(data.get('generationMaxWorkers')), strategy: 'view' }, materialization: { mode: data.get('materializationMode'), publish: data.get('materializationPublish'), lookahead: data.get('materializationLookahead'), depth: data.get('materializationDepth'), confirmation: data.get('materializationConfirmation') }, grounding: data.get('grounding'), staleness: data.get('staleness'), injection: { placeholder: data.get('injectionPlaceholder'), mode: data.get('injectionMode'), maxBytes: Number(data.get('injectionMaxBytes')) } });
  });
  document.addEventListener('change', (event) => {
    if (event.target?.closest('form')) markDirty();
    if (event.target && event.target.id === 'world-model-confirmation' && event.target.value === 'automatic') {
      const depth = document.getElementById('world-model-depth'); if (depth) depth.value = 'light';
    }
  });`;

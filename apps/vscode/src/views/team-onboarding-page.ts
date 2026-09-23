/** Accessible, responsive TON-v1 webview fragment. Host wiring lives in the panel. */
import { escape, icon } from './webview.ts';
import {
  TEAM_ONBOARDING_MAX_SELECTED,
  TEAM_ONBOARDING_STATUS_LABELS,
  TEAM_ONBOARDING_STEPS,
  effectiveTeamRepositoryStatus,
  eligibleTeamRepositories,
  selectedTeamRepositories,
  teamOnboardingProblems,
  teamOnboardingProposalPreview,
  teamOnboardingStepNumber,
  workspaceRepositoryActionLabel,
  type TeamOnboardingRepositoryRow,
  type TeamOnboardingRepositoryStatus,
  type TeamOnboardingView
} from './team-onboarding-model.ts';

/** Closed webview contract. Every identity value is an opaque ID resolved against host-owned state. */
export const TEAM_ONBOARDING_MESSAGE_TYPES = Object.freeze([
  'team-field',
  'authority',
  'authority-from-selection',
  'catalog-search',
  'catalog-provider',
  'catalog-refresh',
  'catalog-more',
  'repository-paste',
  'repository-selection',
  'repository-field',
  'inspect-selected',
  'inspection-cancel',
  'repository-decision',
  'repository-retry',
  'repository-resolve',
  'proposal-submit',
  'proposal-review',
  'navigate-step',
  'workspace-capability',
  'workspace-refresh',
  'workspace-open'
] as const);

export type TeamOnboardingMessageType = typeof TEAM_ONBOARDING_MESSAGE_TYPES[number];

function progress(view: TeamOnboardingView): string {
  const active = teamOnboardingStepNumber(view.step) - 1;
  return `<aside class="start-wizard" aria-label="Team onboarding progress">
    <div class="start-wizard-heading">
      <div><span class="eyebrow">Onboard a team</span>
        <strong>Repositories → reviewed capability map → workspace</strong></div>
      <span class="pill">Step ${active + 1} of ${TEAM_ONBOARDING_STEPS.length}</span>
    </div>
    <ol class="start-wizard-rail">
      ${TEAM_ONBOARDING_STEPS.map((step, index) => {
    const state = index < active ? 'done' : index === active ? 'current' : 'upcoming';
    return `<li class="start-wizard-step ${state}"${index === active ? ' aria-current="step"' : ''}>
          <span class="start-wizard-marker">${index < active ? icon('ok') : index + 1}</span>
          <span><strong>${escape(step.label)}</strong><small>${escape(step.description)}</small></span>
        </li>`;
  }).join('')}
    </ol>
  </aside>`;
}

function tone(status: TeamOnboardingRepositoryStatus): '' | 'ok' | 'wait' | 'bad' {
  if (status === 'will-add' || status === 'will-link') return 'ok';
  if (status === 'needs-choice') return 'wait';
  return status === 'left-out' ? '' : '';
}

function statusPill(row: TeamOnboardingRepositoryRow): string {
  const status = effectiveTeamRepositoryStatus(row);
  const busy = row.inspecting === true;
  return `<span class="pill ${busy ? 'wait' : tone(status)}" aria-label="Status: ${escape(busy ? 'Checking' : TEAM_ONBOARDING_STATUS_LABELS[status])}">
    ${busy ? 'Checking…' : escape(TEAM_ONBOARDING_STATUS_LABELS[status])}</span>`;
}

function blockerHtml(problems: readonly string[], id: string): string {
  if (!problems.length) return '';
  return `<div class="notice error" id="${id}" role="alert"><strong>Before continuing</strong>
    <ul class="blockers">${problems.map((problem) => `<li>${escape(problem)}</li>`).join('')}</ul></div>`;
}

function authorityField(view: TeamOnboardingView): string {
  if (!view.authorities.length) {
    return `<div class="empty-state"><strong>No capability-map authority is registered yet.</strong>
      <p>Select a repository below, then explicitly choose which selected repository will own the first reviewed map.</p>
      <button type="button" class="secondary" data-team-action="authority-from-selection">Choose first authority…</button></div>`;
  }
  if (view.authorities.length === 1 && view.authorities[0]) {
    const authority = view.authorities[0];
    return `<div class="relationship-field"><strong>${escape(authority.label)}</strong>
      <small><code>${escape(authority.leadUrl)}</code>${authority.detail ? ` · ${escape(authority.detail)}` : ''}</small></div>`;
  }
  return `<label class="field span-2" for="team-authority"><span>Capability-map authority</span>
    <select id="team-authority" data-team-authority>
      <option value="">Choose the exact authority…</option>
      ${view.authorities.map((authority) => `<option value="${escape(authority.id)}"${authority.id === view.selectedAuthorityId ? ' selected' : ''}>${escape(authority.label)}</option>`).join('')}
    </select><small>The host resolves this choice to the approved authority URL and revision.</small></label>`;
}

function repositorySelectionRow(row: TeamOnboardingRepositoryRow): string {
  const metadata = [row.visibility, row.access].filter(Boolean).join(' · ');
  return `<tr>
    <td><input type="checkbox" data-repository-select="${escape(row.id)}"${row.selected ? ' checked' : ''}
      aria-label="Select ${escape(row.nameWithOwner)}"></td>
    <td><strong>${icon('repository')}${escape(row.nameWithOwner)}</strong>
      <small>${escape(metadata || 'Repository catalog result')}</small></td>
    <td>${statusPill(row)}</td>
    <td>${row.selected
    ? `<input id="repository-name-${escape(row.id)}" type="text" data-repository-name="${escape(row.id)}"
          value="${escape(row.friendlyName)}" aria-label="Friendly capability name for ${escape(row.nameWithOwner)}">`
    : '<span class="muted">Select to name</span>'}</td>
    <td>${row.selected
    ? `<input id="repository-id-${escape(row.id)}" type="text" data-repository-id="${escape(row.id)}"
          value="${escape(row.capabilityId)}" spellcheck="false" aria-label="Capability ID for ${escape(row.nameWithOwner)}">`
    : '<span class="muted">—</span>'}</td>
  </tr>`;
}

function catalog(view: TeamOnboardingView): string {
  const selected = selectedTeamRepositories(view).length;
  return `<section class="editor-card" aria-labelledby="repository-catalog-heading">
    <div class="section-heading"><div><p class="eyebrow">Repository discovery</p>
      <h2 id="repository-catalog-heading">Choose repositories</h2></div>
      <span class="count-badge" aria-label="${selected} of ${TEAM_ONBOARDING_MAX_SELECTED} selected">${selected}/${TEAM_ONBOARDING_MAX_SELECTED}</span></div>
    <p class="meta">Only checked rows will be inspected. Listing and filtering grant no governance authority.</p>
    <form class="toolbar-row" data-catalog-search-form role="search">
      <label class="field compact" for="team-repository-query"><span>Find by owner or repository</span>
        <input id="team-repository-query" type="search" data-catalog-query value="${escape(view.catalog.query)}"
          placeholder="payments" autocomplete="off"></label>
      <button type="submit" class="secondary">${icon('search')}Search</button>
      ${view.catalog.providerConnected ? '' : `<button type="button" class="secondary" data-team-action="catalog-provider">
        ${icon('repository')}Load GitHub/GHE repositories…</button>`}
      <button type="button" class="secondary" data-team-action="catalog-refresh"${view.catalog.loading ? ' disabled' : ''}>${icon('refresh')}Refresh</button>
      <button type="button" class="secondary" data-team-action="repository-paste">Paste clone URL…</button>
    </form>
    <p class="muted" role="status" aria-live="polite">${view.catalog.loading
    ? 'Reading the bounded repository catalog…'
    : escape(view.catalog.notice ?? view.catalog.sourceLabel ?? 'Repository catalog ready.')}</p>
    <div class="table-wrap"><table>
      <caption>Repositories available to select for this team</caption>
      <thead><tr><th scope="col">Choose</th><th scope="col">Repository</th><th scope="col">Status</th><th scope="col">Friendly name</th><th scope="col">Capability ID</th></tr></thead>
      <tbody>${view.repositories.length
    ? view.repositories.map(repositorySelectionRow).join('')
    : '<tr><td colspan="5"><div class="empty-state">No repositories match this catalog read.</div></td></tr>'}</tbody>
    </table></div>
    ${view.catalog.hasMore
    ? '<p><button type="button" class="secondary" data-team-action="catalog-more">Load more repositories</button></p>'
    : ''}
  </section>`;
}

function proposalPreview(view: TeamOnboardingView): string {
  const preview = teamOnboardingProposalPreview(view);
  const selected = selectedTeamRepositories(view);
  return `<aside class="document-preview" aria-labelledby="team-proposal-preview-heading">
    <p class="eyebrow">One atomic change</p>
    <h2 id="team-proposal-preview-heading">Proposal preview</h2>
    <p class="meta">Nothing below changes the approved map until the normal proposal review is activated.</p>
    <dl class="review-binding">
      <dt>Collection</dt><dd><strong>${escape(preview.team.name || 'Unnamed team')}</strong><br><code>${escape(preview.team.id || 'team-id')}</code></dd>
      <dt>Authority</dt><dd>${preview.authority
    ? `<strong>${escape(preview.authority.label)}</strong><br><code>${escape(preview.authority.leadUrl)}</code>`
    : '<span class="muted">Not chosen</span>'}</dd>
      ${preview.team.jiraProject ? `<dt>Jira</dt><dd><code>${escape(preview.team.jiraProject)}</code></dd>` : ''}
    </dl>
    <h3>Repository children</h3>
    ${selected.length ? `<ul class="resource-status">${selected.map((row) => {
    const status = effectiveTeamRepositoryStatus(row);
    const linkedId = row.status === 'will-link' ? row.existingCapabilityId : null;
    return `<li><span><strong>${escape(row.friendlyName || row.nameWithOwner)}</strong>
          <small><code>${escape(linkedId || row.capabilityId || 'child-id')}</code> · ${escape(row.nameWithOwner)}</small></span>
        <span class="pill ${tone(status)}">${escape(TEAM_ONBOARDING_STATUS_LABELS[status])}</span></li>`;
  }).join('')}</ul>` : '<div class="empty-state">Select repositories to preview the team structure.</div>'}
    <details class="advanced-settings"><summary>Advanced settings</summary>
      <p class="meta">Read-only safe defaults for this team transaction. Change an approved member later through the normal reviewed capability edit flow.</p>
      <ul><li>Whole-repository source scope</li><li><code>blobless</code> clone mode</li>
        <li>No sparse cone</li><li><code>refuse</code> fallback</li></ul>
    </details>
    ${preview.excluded.length ? `<h3>Excluded from this proposal</h3><ul>${preview.excluded.map((row) =>
    `<li><strong>${escape(row.repository)}</strong> — ${escape(row.label)}${row.reason ? `: ${escape(row.reason)}` : ''}</li>`).join('')}</ul>` : ''}
  </aside>`;
}

function teamAndRepositories(view: TeamOnboardingView): string {
  const problems = teamOnboardingProblems(view, 'team-and-repositories');
  return `<div class="artifact-studio">
    <div>
      <section class="editor-card" aria-labelledby="team-details-heading">
        <p class="eyebrow">Team identity</p><h2 id="team-details-heading">Name the team</h2>
        <div class="form-grid">
          <label class="field" for="team-name"><span>Team name</span>
            <input id="team-name" type="text" data-team-field="name" value="${escape(view.teamName)}" placeholder="Checkout platform" autocomplete="off">
            <small>Shown to people throughout the capability map.</small></label>
          <label class="field" for="team-id"><span>Team ID</span>
            <input id="team-id" type="text" data-team-field="id" value="${escape(view.teamId)}" placeholder="checkout-platform" spellcheck="false" autocomplete="off">
            <small>Derived until edited; permanent lower-case kebab-case.</small></label>
          <label class="field" for="team-jira"><span>Jira project <span class="muted">optional</span></span>
            <input id="team-jira" type="text" data-team-field="jiraProject" value="${escape(view.jiraProject)}" placeholder="PAY" spellcheck="false" autocomplete="off"></label>
          ${authorityField(view)}
        </div>
      </section>
      ${catalog(view)}
      ${blockerHtml(problems, 'team-step-problems')}
      <div class="form-actions">
        <span class="grow"></span>
        <button type="button" data-team-action="inspect-selected"${problems.length || view.catalog.loading ? ' disabled' : ''}
          aria-describedby="${problems.length ? 'team-step-problems' : ''}">Check selected repositories ${icon('next')}</button>
      </div>
    </div>
    ${proposalPreview(view)}
  </div>`;
}

function inspectionAction(row: TeamOnboardingRepositoryRow): string {
  if (row.inspecting) return '<span class="muted">Checking…</span>';
  if (row.decision === 'set-aside') {
    return row.status === 'left-out'
      ? '<span class="muted">Excluded</span>'
      : `<button type="button" class="secondary compact-action" data-row-action="include" data-row-id="${escape(row.id)}">Include again</button>`;
  }
  if (row.status === 'needs-choice') {
    return `<button type="button" class="secondary compact-action" data-row-action="resolve" data-row-id="${escape(row.id)}">Resolve…</button>
      <button type="button" class="link compact-action" data-row-action="set-aside" data-row-id="${escape(row.id)}">Set aside</button>`;
  }
  if (row.status === 'not-checked') {
    return `<button type="button" class="secondary compact-action" data-row-action="retry" data-row-id="${escape(row.id)}">Check now</button>`;
  }
  if (row.status === 'will-add' || row.status === 'will-link') {
    return `<button type="button" class="link compact-action" data-row-action="set-aside" data-row-id="${escape(row.id)}">Set aside</button>`;
  }
  return '<span class="muted">Excluded</span>';
}

function checkAndOnboard(view: TeamOnboardingView): string {
  const rows = selectedTeamRepositories(view);
  const eligible = eligibleTeamRepositories(view).length;
  const problems = teamOnboardingProblems(view, 'check-and-onboard');
  const percent = view.inspection.total
    ? Math.round((view.inspection.completed / view.inspection.total) * 100) : 0;
  return `<div class="artifact-studio">
    <div>
      <section class="editor-card" aria-labelledby="inspection-heading">
        <div class="section-heading"><div><p class="eyebrow">Bounded inspection queue</p>
          <h2 id="inspection-heading">Check and onboard</h2></div>
          <span class="count-badge">${eligible} eligible</span></div>
        <p class="meta">Only the ${rows.length} selected ${rows.length === 1 ? 'repository' : 'repositories'} enter this queue. A failure never becomes evidence of absence.</p>
        <div role="progressbar" aria-label="Repository inspection progress" aria-valuemin="0"
          aria-valuemax="${view.inspection.total}" aria-valuenow="${view.inspection.completed}">
          <strong>${view.inspection.completed} of ${view.inspection.total} checked</strong>
          <small class="muted"> · ${percent}%${view.inspection.cancelled ? ' · remaining checks cancelled' : ''}</small>
        </div>
        ${view.inspection.running
    ? '<p><button type="button" class="secondary" data-team-action="inspection-cancel">Cancel remaining checks</button></p>'
    : ''}
        <div class="table-wrap"><table>
          <caption>Inspection outcome for each selected repository</caption>
          <thead><tr><th scope="col">Repository</th><th scope="col">Capability</th><th scope="col">Result</th><th scope="col">What was proved</th><th scope="col">Decision</th></tr></thead>
          <tbody>${rows.map((row) => `<tr>
            <td><strong>${icon('repository')}${escape(row.nameWithOwner)}</strong></td>
            <td><strong>${escape(row.status === 'will-link' ? row.existingCapabilityName || row.friendlyName : row.friendlyName)}</strong>
              <small><code>${escape(row.status === 'will-link' ? row.existingCapabilityId || row.capabilityId : row.capabilityId)}</code></small></td>
            <td>${statusPill(row)}</td>
            <td>${row.detail ? escape(row.detail) : '<span class="muted">Waiting for an explicit check.</span>'}</td>
            <td>${inspectionAction(row)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </section>
      ${view.proposal.message ? `<div class="notice ${view.proposal.status === 'failed' ? 'error' : 'ok'}" role="status">${escape(view.proposal.message)}</div>` : ''}
      ${blockerHtml(problems, 'proposal-step-problems')}
      <div class="form-actions">
        <button type="button" class="secondary" data-team-action="step-back"${view.inspection.running || view.proposal.status === 'running' ? ' disabled' : ''}>Back</button>
        <span class="grow"></span>
        ${view.proposal.status === 'review-required'
    ? '<button type="button" data-team-action="proposal-review">Review capability proposal</button>'
    : view.proposal.status === 'active'
      ? `<button type="button" data-team-action="step-next">Continue to workspaces ${icon('next')}</button>`
      : `<button type="button" data-team-action="proposal-submit"${problems.length || view.proposal.status === 'running' ? ' disabled' : ''}
            aria-describedby="${problems.length ? 'proposal-step-problems' : ''}">${view.proposal.status === 'running' ? 'Creating proposal…' : 'Create one review proposal'}</button>`}
      </div>
    </div>
    ${proposalPreview(view)}
  </div>`;
}

function workspaces(view: TeamOnboardingView): string {
  const active = view.proposal.status === 'active';
  const selectedCapabilities = view.workspace.capabilities.filter((entry) => entry.selected);
  const cloneCount = view.workspace.repositories.filter((entry) => entry.action === 'clone').length;
  const reuseCount = view.workspace.repositories.filter((entry) => entry.action === 'reuse').length;
  const pendingCount = view.workspace.repositories.filter((entry) => entry.action === 'pending').length;
  return `<section class="editor-card" aria-labelledby="workspace-step-heading">
    <div class="section-heading"><div><p class="eyebrow">Approved capabilities → local workspace</p>
      <h2 id="workspace-step-heading">Workspaces</h2></div>
      <span class="count-badge">${view.workspace.repositories.length}</span></div>
    <p class="meta">The existing workspace form remains the writer. Clone or reuse is decided only after its exact folder and target preflight.</p>
    ${!active ? `<div class="notice" role="status"><strong>Proposal activation is still required.</strong>
      <p>The approved capability map must contain the team before it can be selected for a workspace.</p>
      ${view.proposal.status === 'review-required' ? '<button type="button" data-team-action="proposal-review">Review capability proposal</button>' : ''}</div>` : ''}
    ${active ? `<div class="form-grid">
      <fieldset class="field span-2"><legend>Capabilities for this workspace</legend>
        <div class="choice-grid">${view.workspace.capabilities.length
    ? view.workspace.capabilities.map((capability) => `<label class="choice">
              <input type="checkbox" data-workspace-capability="${escape(capability.id)}"${capability.selected ? ' checked' : ''}>
              <span><strong>${escape(capability.name)}</strong><small><code>${escape(capability.capabilityId)}</code> · ${escape(capability.authorityLabel)}</small></span>
            </label>`).join('')
    : '<div class="empty-state">Reading approved capabilities…</div>'}</div>
      </fieldset>
    </div>
    <div class="summary-grid">
      <div class="summary-card"><strong>${selectedCapabilities.length}</strong><span>capabilities selected</span></div>
      <div class="summary-card"><strong>${cloneCount}</strong><span>repositories will clone</span></div>
      <div class="summary-card"><strong>${reuseCount}</strong><span>checkouts will be reused</span></div>
      <div class="summary-card"><strong>${pendingCount}</strong><span>await workspace preflight</span></div>
    </div>
    <div class="table-wrap"><table>
      <caption>Repository materialization preview</caption>
      <thead><tr><th scope="col">Repository</th><th scope="col">Origin</th><th scope="col">Action</th><th scope="col">Target/evidence</th></tr></thead>
      <tbody>${view.workspace.repositories.length ? view.workspace.repositories.map((repository) => `<tr>
        <td><strong>${icon('repository')}${escape(repository.name)}</strong></td>
        <td><code>${escape(repository.origin)}</code></td>
        <td><span class="pill ${repository.action === 'pending' ? 'wait' : 'ok'}">${workspaceRepositoryActionLabel(repository.action)}</span></td>
        <td>${escape(repository.targetPath ?? repository.evidence ?? 'Resolved by workspace preflight')}</td>
      </tr>`).join('') : '<tr><td colspan="4"><div class="empty-state">Choose capabilities to preview their repositories.</div></td></tr>'}</tbody>
    </table></div>` : ''}
    ${view.workspace.message ? `<div class="notice" role="status">${escape(view.workspace.message)}</div>` : ''}
    <div class="form-actions">
      <button type="button" class="secondary" data-team-action="step-back"${view.workspace.busy ? ' disabled' : ''}>Back to proposal</button>
      <button type="button" class="secondary" data-team-action="workspace-refresh"${!active || view.workspace.busy ? ' disabled' : ''}>${icon('refresh')}Refresh preview</button>
      <span class="grow"></span>
      <button type="button" data-team-action="workspace-open"${!active || !view.workspace.ready || view.workspace.busy ? ' disabled' : ''}>Continue to workspace setup ${icon('next')}</button>
    </div>
  </section>`;
}

/** HTML fragment for the shared CSP/nonce page shell. */
export function teamOnboardingHtml(view: TeamOnboardingView): string {
  const body = view.step === 'team-and-repositories'
    ? teamAndRepositories(view)
    : view.step === 'check-and-onboard' ? checkAndOnboard(view) : workspaces(view);
  return `<main class="team-onboarding" aria-labelledby="team-onboarding-heading">
    <header class="inbox-header"><p class="eyebrow">Capability setup · TON-v1</p>
      <h1 id="team-onboarding-heading">${icon('team', { size: 24 })}Onboard a team</h1>
      <p class="meta">Choose only the repositories this team owns, review one atomic capability-map proposal, then create a workspace from the approved result.</p>
    </header>
    ${progress(view)}
    ${view.error ? `<div class="notice error" role="alert">${escape(view.error)}</div>` : ''}
    ${body}
  </main>`;
}

/**
 * The page reports intent only. URLs, RDS refs, cursors, authority revisions and proposal refs are
 * deliberately absent from every message; the panel resolves each opaque ID against current state.
 */
export const TEAM_ONBOARDING_SCRIPT = `
  const vscode = window.__sfVscode;
  const post = (type, fields = {}) => vscode.postMessage({ type, ...fields });

  document.addEventListener('submit', (event) => {
    if (!event.target.matches('[data-catalog-search-form]')) return;
    event.preventDefault();
    post('catalog-search', { query: document.querySelector('[data-catalog-query]')?.value?.trim() ?? '' });
  });

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-team-action],[data-row-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.teamAction;
    if (action === 'catalog-refresh') post('catalog-refresh');
    else if (action === 'authority-from-selection') post('authority-from-selection');
    else if (action === 'catalog-provider') post('catalog-provider');
    else if (action === 'catalog-more') post('catalog-more');
    else if (action === 'repository-paste') post('repository-paste');
    else if (action === 'inspect-selected') post('inspect-selected');
    else if (action === 'inspection-cancel') post('inspection-cancel');
    else if (action === 'proposal-submit') post('proposal-submit');
    else if (action === 'proposal-review') post('proposal-review');
    else if (action === 'step-back') post('navigate-step', { direction: 'back' });
    else if (action === 'step-next') post('navigate-step', { direction: 'next' });
    else if (action === 'workspace-refresh') post('workspace-refresh');
    else if (action === 'workspace-open') post('workspace-open');
    else if (target.dataset.rowAction === 'set-aside' || target.dataset.rowAction === 'include') {
      post('repository-decision', {
        rowId: target.dataset.rowId,
        decision: target.dataset.rowAction === 'set-aside' ? 'set-aside' : 'include'
      });
    } else if (target.dataset.rowAction === 'retry') {
      post('repository-retry', { rowId: target.dataset.rowId });
    } else if (target.dataset.rowAction === 'resolve') {
      post('repository-resolve', { rowId: target.dataset.rowId });
    }
  });

  document.addEventListener('change', (event) => {
    const data = event.target.dataset;
    if (data.teamAuthority !== undefined) {
      post('authority', { authorityId: event.target.value });
    } else if (data.repositorySelect !== undefined) {
      post('repository-selection', { rowId: data.repositorySelect, selected: event.target.checked === true });
    } else if (data.repositoryName !== undefined) {
      post('repository-field', { rowId: data.repositoryName, field: 'name', value: event.target.value });
    } else if (data.repositoryId !== undefined) {
      post('repository-field', { rowId: data.repositoryId, field: 'id', value: event.target.value });
    } else if (data.workspaceCapability !== undefined) {
      post('workspace-capability', { capabilityKey: data.workspaceCapability, selected: event.target.checked === true });
    }
  });

  document.addEventListener('input', (event) => {
    const field = event.target.dataset?.teamField;
    if (field === 'name' || field === 'id' || field === 'jiraProject') {
      post('team-field', { field, value: event.target.value });
    }
  });
`;

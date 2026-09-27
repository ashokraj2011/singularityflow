/** Escaped, nonce-shell content. Draft JSON is never executable webview markup. */
import { WORKFLOW_DRAFT_INPUT_MAX_BYTES, type SharedWorkflowDraftView } from './workflow-drafts-model.ts';
import { escape } from './webview.ts';
import { workflowDraftContent, workflowDraftEnvelope, workflowDraftGuide, WORKFLOW_DRAFT_STAGES, type WorkflowDraftGuideField } from './workflow-drafts-guide.ts';

export function workflowDraftDurabilityLabel(view: SharedWorkflowDraftView): string {
  const revision = view.editor?.record.revision ?? '?';
  const labels = { shared: `Shared revision ${revision} · all captured changes saved`,
    memory: 'Not shared · pending changes have not been saved to Git', saving: 'Saving… · shared acknowledgement pending',
    failed: 'Not saved · storage/content needs attention; prior shared revision retained',
    conflict: 'Conflict · shared revision retained; autosave paused',
    uncertain: 'Acknowledgement unknown · check operation status; autosave paused',
    deleted: 'Deleted · this draft ID will not be recreated; private recovery is separate' };
  return labels[view.durability];
}

export function workflowDraftRecoveryLabel(view: SharedWorkflowDraftView): string {
  const recovery = view.recovery;
  if (!recovery || recovery.status === 'unavailable') return 'Private recovery unavailable · pending changes are in panel memory only';
  if (recovery.status === 'failed') return `Private checkpoint needs attention · ${recovery.message ?? 'the latest pending text is not acknowledged locally'}`;
  if (recovery.status === 'checking') return 'Checking private recovery on this machine…';
  if (recovery.status === 'writing') return 'Private checkpoint pending · newest edits are not yet acknowledged locally';
  if (recovery.candidateAvailable) return `Private recovery available · based on shared revision ${recovery.candidate?.base.record.revision ?? '?'} · not automatically restored`;
  if (recovery.status === 'saved') return 'Private checkpoint saved on this machine · encrypted, not shared to Git';
  return 'No pending private checkpoint · acknowledged shared revisions remain in Git';
}

function lifecycleSimulationHtml(preview: Record<string, unknown>): string {
  const value = preview.simulation;
  const simulation = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!simulation || !Array.isArray(simulation.workflows)) return '<p>Structural lifecycle simulation was not reported. This is not a complete lifecycle verdict.</p>';
  return `<section aria-labelledby="draft-simulation-title"><h3 id="draft-simulation-title">Structural lifecycle simulation · ${escape(simulation.status)}</h3>
    <p>Profile: <code>${escape(simulation.profile)}</code>. Hypothetical transitions only: no tests, models, human decisions or external operations were executed. This is not Ready to run.</p>
    ${simulation.workflows.slice(0, 16).map((raw) => {
      const report = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const scenarios = Array.isArray(report.scenarios) ? report.scenarios : [];
      const coverage = report.coverage && typeof report.coverage === 'object' ? report.coverage as Record<string, unknown> : {};
      return `<details><summary>${escape(report.workflowId ?? '')} · ${escape(report.status)} · ${escape(scenarios.length)} scenarios</summary>
        <p>Resolved contract: <code>${escape(report.sourceDefinitionSha256)}</code>. ${escape(coverage.phaseCount)} phases; ${escape(coverage.eventCount)} projected events.</p>
        <p>Scenario summary: first ${Math.min(scenarios.length, 64)} of ${scenarios.length}. The exact Preview JSON below retains the full bounded report.</p>
        <table><thead><tr><th>Scenario</th><th>Phase</th><th>Expected route</th><th>Projected outcome</th></tr></thead><tbody>${scenarios.slice(0, 64).map((rawScenario) => {
          const item = rawScenario && typeof rawScenario === 'object' ? rawScenario as Record<string, unknown> : {};
          return `<tr><td>${escape(item.id)}</td><td>${escape(item.phaseId ?? 'workflow')}</td><td>${escape(item.expected)}</td><td>${escape(item.outcome)}</td></tr>`;
        }).join('')}</tbody></table>
        <p>Excluded: ${escape(Array.isArray(coverage.excluded) ? coverage.excluded.join(', ') : 'not reported')}.</p>
      </details>`;
    }).join('')}
    <details><summary>Exact saved-revision Preview JSON</summary><pre><code>${escape(JSON.stringify(preview, null, 2))}</code></pre></details></section>`;
}

function workflowChangeImpactHtml(preview: Record<string, unknown>): string {
  const value = preview.workflowChanges;
  if (!value || typeof value !== 'object') return '';
  const change = value as Record<string, unknown>;
  const impact = change.impact && typeof change.impact === 'object' ? change.impact as Record<string, unknown> : {};
  const dependencies = Array.isArray(impact.sharedDependencies) ? impact.sharedDependencies : [];
  const replacements = Array.isArray(change.replacements) ? change.replacements : [];
  return `<section aria-labelledby="draft-change-impact"><h3 id="draft-change-impact">Workflow edit / linked-copy impact · ${escape(change.status)}</h3>
    <p>Selected approved configuration only. Shared definitions: ${escape(impact.sharedDefinitions ?? 'not reported')}. Existing Story pins: ${escape(impact.retainedStories)}. Other repositories: ${escape(impact.otherRepositories)}. No approval, activation or execution is granted.</p>
    <ul>${replacements.slice(0, 16).map((raw) => {
      const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return `<li>${escape(row.operation)} <code>${escape(row.id)}</code> from <code>${escape(row.sourceId)}</code> · changed policy fields: ${escape(Array.isArray(row.policyRelevantFields) ? row.policyRelevantFields.join(', ') || 'none' : 'not reported')}. Omitted raw fields are preserved.</li>`;
    }).join('')}</ul>
    <p>Declared shared dependency summary: first ${Math.min(dependencies.length, 64)} of ${dependencies.length}. The exact Preview JSON retains the full bounded graph and identities.</p>
    <table><thead><tr><th>Shared dependency</th><th>Existing direct consumers</th></tr></thead><tbody>${dependencies.slice(0, 64).map((raw) => {
      const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const consumers = Array.isArray(row.directDependents) ? row.directDependents : [];
      const shown = consumers.slice(0, 32).map((rawConsumer) => {
        const consumer = rawConsumer && typeof rawConsumer === 'object' ? rawConsumer as Record<string, unknown> : {};
        return `${String(consumer.kind ?? '')}:${String(consumer.id ?? '')}`;
      }).join(', ');
      return `<tr><td>${escape(row.kind)}:<code>${escape(row.id)}</code></td><td>${escape(shown || 'none declared')}${consumers.length > 32 ? ` · first 32 of ${consumers.length}` : ''}</td></tr>`;
    }).join('')}</tbody></table></section>`;
}

function guidedHtml(view: SharedWorkflowDraftView): string {
  const editor = view.editor!; const disabled = view.busy || editor.readOnlyReason ? ' disabled' : '';
  const navigationDisabled = view.busy ? ' disabled' : '';
  const text = (value: unknown): string => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : Array.isArray(value) ? value.join(', ') : '';
  const answer = (field: WorkflowDraftGuideField, label: string, value: unknown, index = 0): string => {
    const id = `guide-${field}-${index}`;
    return `<label for="${id}">${escape(label)}<textarea id="${id}" rows="${['agent-prompt', 'skill-instructions', 'template-content', 'description', 'rationale'].includes(field) ? 4 : 1}" spellcheck="false"${view.busy || editor.readOnlyReason ? ' readonly' : ''}>${escape(text(value))}</textarea></label>
      <button type="button" class="secondary" data-draft-action="guide-answer" data-guide-field="${field}" data-guide-input="${id}" data-guide-index="${index}"${disabled}>Apply answer</button>`;
  };
  const catalog = view.preview?.catalogChoices;
  const groups = catalog && typeof catalog === 'object' && Array.isArray((catalog as Record<string, unknown>).groups)
    ? (catalog as { groups: Record<string, unknown>[] }).groups : [];
  const selection = (kind: string, label: string, index = 0): string => {
    const selectionDisabled = view.busy || editor.readOnlyReason || view.dirty ? ' disabled' : '';
    const group = groups.find((value) => value.kind === (kind.startsWith('workflow-') ? 'workflow' : kind));
    const choices = group && Array.isArray(group.choices) ? group.choices.slice(0, 64) : [];
    const id = `catalog-${kind}-${index}`;
    return choices.length ? `<label for="${id}">${escape(label)}<select id="${id}"${selectionDisabled}><option value="">Leave unresolved / choose explicitly</option>${choices.map((raw) => {
      const choice = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const ref = choice.ref && typeof choice.ref === 'object' ? choice.ref as Record<string, unknown> : {};
      return `<option value="${escape(ref.id)}">${escape(choice.label)} (${escape(ref.id)})</option>`;
    }).join('')}</select></label><button type="button" class="secondary" data-draft-action="catalog-answer" data-choice-kind="${kind}" data-choice-select="${id}" data-guide-index="${index}"${selectionDisabled}>Apply captured catalog choice</button>${group?.nextCursor !== null ? '<p class="muted">This is a bounded catalog page, not every entry. Unlisted requests remain unresolved.</p>' : ''}` : `<p class="muted">${escape(label)}: captured choices unavailable. Request Preview of the exact saved revision; never guess an approved ID.</p>`;
  };
  let content: string;
  try {
    const guide = workflowDraftGuide(editor.inputText);
    const envelope = workflowDraftEnvelope(editor.inputText);
    if (view.stage === 1) content = '<p>What should this workflow help people complete? Leave a field empty when undecided; no meaning is guessed.</p>'
      + answer('id', 'Package identity (lower-case kebab-case)', guide.payload.id)
      + answer('label', 'Package label', guide.payload.label) + answer('description', 'Goal / purpose', guide.payload.description)
      + '<p>For an empty component package, select an exact approved workflow to edit or make a linked copy. Omitted advanced policy is preserved. A copy shares existing phases, agents, templates and skills; it does not change those objects or existing Story pins.</p>'
      + selection('workflow-edit', 'Prepare workflow-only edit') + selection('workflow-fork', 'Prepare linked copy (uses your new package identity)')
      + guide.workflows.map((workflow, index) => answer('workflow-label', 'Explicit workflow label override (leave unapplied to preserve source)', workflow.label, index)
        + answer('workflow-description', 'Explicit workflow description override', workflow.description, index)).join('')
      + (view.preview?.approvedSource && typeof view.preview.approvedSource === 'object' ? `<p>Captured approved base: <code>${escape((view.preview.approvedSource as Record<string, unknown>).baseRevision)}</code>. This choice requests the selected repository Story scope only; host IDs are not granted.</p><button type="button" class="secondary" data-draft-action="catalog-answer" data-choice-kind="approved-base"${disabled}>Use captured approved base and repository Story target</button>` : '<p class="muted">Preview supplies the exact approved base for an explicit target choice; no revision is fabricated.</p>');
    else if (view.stage === 2) {
      const order = guide.workflows[0]?.phases;
      content = '<p>Are these the right steps? New steps create incomplete candidate phase, agent, skill and template definitions. No business prompt or catalog binding is invented.</p>'
        + (Array.isArray(order) ? `<ol>${order.slice(0, 32).map((id, index) => `<li>${escape(id)}
          ${index > 0 ? `<button type="button" class="secondary" data-draft-action="move-stage" data-guide-index="${index}" data-guide-direction="-1"${disabled}>Move earlier</button>` : ''}
          ${index + 1 < order.length ? `<button type="button" class="secondary" data-draft-action="move-stage" data-guide-index="${index}" data-guide-direction="1"${disabled}>Move later</button>` : ''}</li>`).join('')}</ol>` : '<p>Stage order is unresolved.</p>')
        + (guide.payload.intent === 'edit' || guide.payload.intent === 'fork' ? '<p>Workflow-only changes reuse approved stages. Shared component edits need their own reviewed package. Skill order changes require a newly compiled confirmed binding.</p>' : `<button type="button" data-draft-action="add-stage"${disabled}>Add new candidate stage</button>`)
        + selection('phase', 'Append an existing approved catalog stage')
        + guide.phases.map((phase, index) => {
          const artifact = phase.artifact && typeof phase.artifact === 'object' ? phase.artifact as Record<string, unknown> : {};
          return `<details><summary>${escape(phase.id)} · stage content</summary>${answer('phase-label', 'Stage label', phase.label, index)}${answer('phase-inputs', 'Required input stage IDs (comma-separated, unresolved IDs allowed)', phase.inputs, index)}${selection('execution-task', 'Select the actual execution task', index)}
            <details><summary>Required output contract (your explicit choices)</summary>${answer('phase-artifact-path', `Own-artifact path under artifacts/${String(phase.id)}/`, artifact.path, index)}${answer('phase-artifact-kind', 'Artifact kind (for example custom:findings — not a ready-made meaning)', artifact.kind, index)}${answer('phase-artifact-minimum', 'Minimum literal bytes', artifact.minimumBytes, index)}${answer('phase-artifact-maximum', 'Maximum literal bytes', artifact.maximumBytes, index)}${answer('phase-write-scope', 'Write scope: type artifact-only to request own-artifact edits; no source grant', phase.writeScope, index)}</details></details>`;
        }).join('');
    } else if (view.stage === 3) content = '<p>Who or what does each step? Supply actual purpose and procedural text. Empty text remains a decision gap. Reuse requires an explicit choice from the captured approved catalog. Model generation and human/deterministic role adapters are unavailable here.</p>'
      + guide.agents.map((agent, index) => `<details><summary>${escape(agent.id)} · candidate agent</summary>${answer('agent-description', 'Role purpose', agent.description, index)}${answer('agent-prompt', agent.promptAsset ? 'Hand-written prompt · captured literal asset (no host file read)' : 'Hand-written prompt', workflowDraftContent(envelope, agent, 'prompt'), index)}</details>`).join('')
      + guide.skills.map((skill, index) => `<details><summary>${escape(skill.id)} · candidate skill</summary>${answer('skill-description', 'Skill purpose', skill.description, index)}${answer('skill-instructions', 'Procedural instructions', workflowDraftContent(envelope, skill, 'instructions'), index)}</details>`).join('')
      + guide.templates.map((template, index) => `<details><summary>${escape(template.id)} · candidate template</summary>${answer('template-content', 'Required output template', workflowDraftContent(envelope, template, 'content'), index)}</details>`).join('')
      + guide.phases.map((phase, index) => `<details><summary>${escape(phase.id)} · reuse existing components explicitly</summary>${selection('agent', 'Approved catalog agent', index)}${selection('template', 'Approved catalog template', index)}</details>`).join('');
    else if (view.stage === 4) content = '<p>What may each agent do, and who reviews the work? Typed references are requests, not approved catalog selections. Optional tools default to none. No policy floor, mandatory gate or planned-claim obligation is removed.</p>'
      + '<p class="warning">Native operation/host mapping is unavailable. Captured reviewer/quality catalog IDs are navigation-only: they do not prove membership or grant execution. Nonempty operation bindings may be unsupported.</p>'
      + guide.agents.map((agent, index) => `<details><summary>${escape(agent.id)} · requested operations</summary>${answer('agent-tools', 'Requested operation binding aliases (comma-separated)', agent.toolBindings, index)}</details>`).join('')
      + guide.phases.map((phase, index) => `<details><summary>${escape(phase.id)} · requested review</summary>${answer('phase-review', 'Existing reviewer binding alias, or leave unresolved', phase.approvalBinding, index)}${selection('approval-authority', 'Actual approved reviewer group', index)}${selection('quality-command', 'Actual approved quality check', index)}</details>`).join('');
    else if (view.stage === 5) content = `<p>Is this the package you want to propose? Candidate components: ${guide.workflows.length} workflows, ${guide.phases.length} stages, ${guide.agents.length} agents, ${guide.skills.length} skills, ${guide.templates.length} templates.</p>`
      + '<p>These counts are not a completeness or readiness verdict. Show is pinned to an acknowledged revision and reports its actual coverage.</p>' + answer('rationale', 'Review explanation', guide.payload.rationale);
    else content = `<p>Submit this package for the required review?</p><p class="warning">Trusted submission confirmation is unavailable in this editor. Shared persistence and Preview are not approval, active configuration or execution. These buttons copy review routes only; the terminal separately revalidates and presents an exact package, or refuses unresolved findings. Headless Copilot cannot mint consent.</p>
      <button type="button" class="secondary" data-draft-action="submit-review"${view.busy || view.recovery?.candidateAvailable || ['failed', 'checking'].includes(view.recovery?.status) ? ' disabled' : ''}>Copy rooted Shell submission-review command</button>
      <button type="button" class="secondary" data-draft-action="copilot-submit-review"${view.busy || view.recovery?.candidateAvailable || ['failed', 'checking'].includes(view.recovery?.status) ? ' disabled' : ''}>Copy Copilot submission handoff</button>`;
  } catch (error) { content = `<p class="warning">${escape(error instanceof Error ? error.message : String(error))}</p><p>Advanced JSON is retained unchanged. Resolve its shape before guided edits.</p>`; }
  return `<section aria-labelledby="guide-title"><h3 id="guide-title">Step ${view.stage} of 6 · ${WORKFLOW_DRAFT_STAGES[view.stage - 1]}</h3>
    <p>Authoring progress only — these stages do not run the workflow. Apply answer captures a complete semantic edit; un-applied question text is not saved.</p>
    <nav aria-label="Authoring sections">${WORKFLOW_DRAFT_STAGES.map((label, index) => `<button type="button" class="secondary" data-draft-action="stage" data-guide-stage="${index + 1}"${navigationDisabled}>${escape(label)}</button>`).join('')}</nav>
    ${content}<details><summary>Explain this stage</summary><p>Typed choices edit the inert partial request only. Leave unresolved by keeping a field empty. Unknown advanced fields, literal assets and unrelated hand-written content are preserved. Full compiler checks, catalog authority, approval and execution remain distinct owners.</p></details>
    <div class="form-actions">${view.stage > 1 ? `<button type="button" class="secondary" data-draft-action="stage" data-guide-stage="${view.stage - 1}"${navigationDisabled}>Back</button>` : ''}
    ${view.stage < 6 ? `<button type="button" class="secondary" data-draft-action="stage" data-guide-stage="${view.stage + 1}"${navigationDisabled}>Next / leave unresolved</button>` : ''}
    <button type="button" class="secondary" data-draft-action="show"${navigationDisabled}>Show workflow</button>
    <button type="button" class="secondary" data-draft-action="preview"${navigationDisabled}>Preview saved package (read-only)</button>
    <button type="button" class="secondary" data-draft-action="back-drafts"${navigationDisabled}>Back to drafts</button>
    <button type="button" class="secondary" data-draft-action="exit"${navigationDisabled}>Exit (flush captured edits)</button></div></section>`;
}

export function sharedWorkflowDraftsHtml(view: SharedWorkflowDraftView): string {
  const editor = view.editor;
  const disabled = view.busy ? ' disabled' : '';
  const recoveryBlocked = view.recovery?.candidateAvailable || ['failed', 'checking'].includes(view.recovery?.status);
  const show = view.show;
  const missing = show && Array.isArray(show.missingDecisions) ? show.missingDecisions : [];
  const assessment = show?.assessment && typeof show.assessment === 'object' ? show.assessment as Record<string, unknown> : {};
  const coverage = assessment.coverage && typeof assessment.coverage === 'object' ? assessment.coverage as Record<string, unknown> : null;
  const graph = show?.graph && typeof show.graph === 'object' ? show.graph as Record<string, unknown> : {};
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return `<main aria-labelledby="drafts-title"><header><p class="eyebrow">Workflow authoring · Shared Git drafts</p>
    <h1 id="drafts-title">Shared Workflow Drafts</h1><p>Guide, read and save inert partial workflow packages through the same CLI DraftStore used by a shell.</p>
    <p class="muted">Opened repository: <code>${escape(view.repository)}</code><br>Draft authority: <code>${escape(view.authority ?? 'Not observed yet')}</code></p>
    <p>Shared autosave requires explicit editing-scope opt-in. Private recovery is encrypted on this machine and never submits, publishes, approves, installs or executes a workflow.</p></header>
    <p id="draft-live-error" class="warning" role="alert"${view.error ? '' : ' hidden'}>${escape(view.error ?? '')}</p>
    ${view.error ? `<section class="warning" role="alert"><strong>Draft operation needs attention</strong><p>${escape(view.error)}</p><p>The editor buffer is retained. A shared write may need operation-status reconciliation or explicit Reload. For private-checkpoint contention, Refresh private recovery; nothing is overwritten automatically.</p></section>` : ''}
    ${view.notice ? `<p role="status" aria-live="polite">${escape(view.notice)}</p>` : ''}
    <p id="draft-operation" class="muted">${view.operationId ? `Last write operation ID: ${escape(view.operationId)}. Check status before retrying uncertain writes.` : ''}</p><button type="button" class="secondary" data-draft-action="operation-status"${disabled}>Check last write status (read-only)</button>
    ${view.busy ? '<p role="status" aria-live="polite">Waiting for the shared-draft CLI…</p>' : ''}
    <section><h2>Last observed shared drafts</h2><div class="form-actions"><button type="button" class="secondary" data-draft-action="refresh"${disabled}>Refresh shared list</button>
      <button type="button" data-draft-action="create"${disabled}>Create empty shared draft</button></div>
      ${view.drafts.length ? `<table><thead><tr><th>Draft</th><th>Saved revision</th><th>Open</th></tr></thead><tbody>${view.drafts.map((draft) => `<tr><td>${escape(draft.displayName)}<br><code>${escape(draft.draftId)}</code></td><td>${escape(draft.revision)}</td><td><button type="button" class="secondary" data-draft-action="open" data-draft-id="${escape(draft.draftId)}"${disabled}>Open draft</button></td></tr>`).join('')}</tbody></table>` : view.authority ? '<p class="muted">No live shared drafts were observed in the last successful list. Refresh or explicitly create an empty draft.</p>' : '<p class="warning">The shared draft list has not loaded. This is not an empty catalog; Refresh to retry.</p>'}</section>
    ${editor ? `<section><h2>Draft editor · <code>${escape(editor.record.draftId)}</code></h2>
      <p id="draft-revision">Retained saved revision ${escape(editor.record.revision)} · lifecycle epoch ${escape(editor.record.lifecycleEpoch)}<br>
      <code>${escape(editor.record.revisionSha256)}</code><br>Compare-and-swap head: <code>${escape(editor.head)}</code><br>Retained draft authority: <code>${escape(editor.authority)}</code></p>
      <p id="draft-dirty" role="status" aria-live="polite">${escape(workflowDraftDurabilityLabel(view))}</p>
      <p id="draft-autosave" role="status">Shared autosave ${view.autosave ? 'on for this exact draft' : 'off'}.</p>
      <p id="draft-recovery-status" role="status" aria-live="polite">${escape(workflowDraftRecoveryLabel(view))}</p>
      <button type="button" class="secondary" data-draft-action="recovery-refresh"${disabled}>Refresh private recovery (read-only)</button>
      <button type="button" class="secondary" data-draft-action="recovery-inspect-locks"${disabled}>Inspect interrupted private locks</button>
      ${view.recovery.locks ? `<section><h3>Private lock ownership</h3><p>Inspection never removes a lock. Live, legacy, unknown and unsupported ownership stays blocked; elapsed time alone is not proof of death. Windows repair is unavailable without native process-domain proof.</p><table><thead><tr><th>Lock</th><th>Observed owner</th><th>Action</th></tr></thead><tbody>${view.recovery.locks.map((lock) => `<tr><td>${escape(lock.kind)}</td><td>${escape(lock.status)}${lock.owner ? ` · PID ${escape(lock.owner.pid)}` : ''}<br>${escape(lock.reason)}</td><td>${lock.status === 'dead' && lock.repairSupported && lock.reviewId ? `<button type="button" class="secondary" data-draft-action="recovery-repair-lock" data-lock-kind="${escape(lock.kind)}"${disabled}>Review dead lock repair…</button>` : 'No safe repair available'}</td></tr>`).join('')}</tbody></table></section>` : ''}
      ${view.recovery?.candidateAvailable ? `<section id="draft-recovery-choice" aria-labelledby="draft-recovery-title"><h3 id="draft-recovery-title">Recover private pending edits</h3>
        <p>A checkpoint was retained for this exact repository, authority and draft on this machine. Restore requires the same shared base; newer shared revisions are not overwritten or merged. Reconcile an unknown write with Check last write status before a shared write or checkpoint discard.</p>
        <p>Checkpoint captured: <code>${escape(view.recovery.candidate?.capturedAt ?? '')}</code>. Comparison is read-only and may normalize line endings for display; it is not bytewise merge approval.</p>
        <div class="form-actions"><button type="button" data-draft-action="recovery-restore"${view.busy || !view.recovery.restoreAllowed ? ' disabled' : ''}>Restore private edits</button>
        <button type="button" class="secondary" data-draft-action="recovery-compare"${disabled}>Compare with current shared revision</button>
        <button type="button" class="secondary" data-draft-action="recovery-discard"${disabled}>Discard private checkpoint…</button></div></section>` : ''}
      <p class="muted">Only acknowledged private checkpoints can survive a crash. The latest unacknowledged or oversized visible edits may remain memory-only. Native close does not flush to Git. Reopen this repository and draft for explicit recovery; no restore or shared autosave is automatic.</p>
      <p>Editing destination: <code>${escape(editor.authority)}</code> · visible to principals permitted by the Git repository provider. Nothing here is an active workflow. Enabling autosave authorizes ordinary draft edits here only, not sharing elsewhere or submission.</p>
      <button type="button" class="secondary" data-draft-action="${view.autosave ? 'autosave-off' : 'autosave-on'}"${view.busy || (!view.autosave && (editor.readOnlyReason || recoveryBlocked)) ? ' disabled' : ''}>${view.autosave ? 'Pause shared autosave' : 'Enable shared autosave for this draft'}</button>
      <p id="draft-input-error" class="warning" role="alert" hidden></p>
      ${editor.readOnlyReason ? `<p class="warning">${escape(editor.readOnlyReason)}</p>` : ''}
      <input type="hidden" id="draft-binding" value="${escape(editor.binding)}">
      <label for="draft-name">Display name<input id="draft-name" value="${escape(editor.name)}" autocomplete="off"${editor.readOnlyReason ? ' disabled' : ''}></label>
      ${guidedHtml(view)}
      <details><summary>Change advanced partial package JSON and literal assets</summary><label for="draft-input">Advanced JSON<textarea id="draft-input" rows="22" spellcheck="false"${editor.readOnlyReason ? ' readonly' : ''}>${escape(editor.inputText)}</textarea></label>
      <p class="muted">Closed JSON envelope: <code>{"payload": {…}, "assets": [{"path": "logical/path", "content": "literal text"}]}</code>. Paths are labels, not local file reads. Missing decisions are allowed; secret/environment-local storage admission still applies.</p>
      </details><div class="form-actions"><button type="button" data-draft-action="save"${view.busy || editor.readOnlyReason || recoveryBlocked ? ' disabled' : ''}>Save shared revision / retry</button>
      <button type="button" class="secondary" data-draft-action="reload"${disabled}>Reload latest (discard unsaved changes…)</button>
      <button type="button" class="secondary" data-draft-action="show"${disabled}>Show saved revision (read-only)</button></div>
      <button type="button" class="secondary" data-draft-action="preview"${disabled}>Preview exact saved package (read-only)</button>
      <details><summary>Delete via terminal review</summary><p>Native webview deletion confirmation is unavailable. This prepares a terminal command only; the terminal separately presents the exact current draft, repository and revision with Cancel as the default. Submitted snapshots and active workflows are not deletion targets.</p>
      <p class="muted">Shell copy is rooted to this exact repository. Copilot copy requires this repository to be the only opened folder; its headless route cannot capture deletion consent.</p>
      <button type="button" class="secondary" data-draft-action="terminal-review"${disabled}>Copy Shell review command</button>
      <button type="button" class="secondary" data-draft-action="copilot-review"${disabled}>Copy Copilot handoff</button></details></section>` : '<section><p>Open a shared draft to edit its partial package.</p></section>'}
    ${view.preview ? `<section id="draft-preview"><h2>Exact saved-package Preview · read-only</h2><p>Plan: <code>${escape(view.preview.planSha256)}</code>. Authoring: ${escape((view.preview.readiness as Record<string, unknown>)?.authoring)}. Host: ${escape((view.preview.readiness as Record<string, unknown>)?.host)}. Execution: ${escape((view.preview.readiness as Record<string, unknown>)?.execution)}.</p>
      <p>Static validity is not Ready to run. Human confirmation, membership, native host enforcement and activation remain separate; no operation was executed.</p>
      ${workflowChangeImpactHtml(view.preview)}
      ${lifecycleSimulationHtml(view.preview)}
      <ul>${Array.isArray(view.preview.findings) ? view.preview.findings.slice(0, 128).map((finding) => {
        const item = finding && typeof finding === 'object' ? finding as Record<string, unknown> : {};
        return `<li><code>${escape(item.code)}</code> · ${escape(item.fieldPath)} · ${escape(item.message)}</li>`;
      }).join('') : ''}</ul><p>Catalog choices are pinned to this Preview's approved source and saved revision. After a candidate edit, Preview again; no old assessment certifies new bytes.</p></section>` : ''}
    ${show ? `<section id="draft-show" aria-labelledby="draft-show-title"><h2 id="draft-show-title">Read-only Show · saved revision</h2>
      ${coverage ? `<p>Authoring assessment: ${escape(assessment.status ?? 'not reported')}. These checks describe the exact saved package, not unsaved editor text.</p><dl>${([['schema', 'Request schema'], ['references', 'Reference resolution'], ['policy', 'Policy source'], ['graph', 'Workflow graph'], ['simulation', 'Structural lifecycle simulation'], ['hostEnforcement', 'Native host enforcement'], ['behavior', 'Behavior evaluation']] as const).map(([key, label]) => `<dt>${label}</dt><dd>${escape(coverage[key] ?? 'not reported')}</dd>`).join('')}</dl>`
        : '<p>Assessment coverage was not reported. Complete-package validation, graph coverage and execution readiness are unavailable.</p>'}
      <p>Static validation is not Ready to run. No submission, approval, activation or host acceptance is implied.</p>
      ${edges.length ? `<details><summary>Declared input relationships (first ${Math.min(edges.length, 64)})</summary><ul>${edges.slice(0, 64).map((raw) => {
        const edge = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        return `<li>${escape(edge.workflowId)}: <code>${escape(edge.from)}</code> → <code>${escape(edge.to)}</code></li>`;
      }).join('')}</ul></details>` : ''}
      <h3>Unresolved decisions reported by the saved-package assessment</h3>${missing.length ? `<ul>${missing.slice(0, 64).map((decision) => {
        const item = decision && typeof decision === 'object' ? decision as Record<string, unknown> : {};
        return `<li>${escape(item.label)} · <code>${escape(item.fieldPath)}</code></li>`;
      }).join('')}</ul>` : '<p>No unresolved decisions were reported by this assessment. This is not a ready-to-run verdict.</p>'}
      <details><summary>Exact saved-revision Show JSON</summary><pre><code>${escape(JSON.stringify(show, null, 2))}</code></pre></details></section>` : ''}
    </main>`;
}

export const SHARED_WORKFLOW_DRAFTS_SCRIPT = `
  const draftsVscode = window.__sfVscode;
  const showEditorError = (message) => {
    const error = document.getElementById('draft-input-error');
    if (error) { error.textContent = message; error.hidden = !message; }
  };
  const editorFields = () => {
    const binding = document.getElementById('draft-binding');
    const name = document.getElementById('draft-name');
    const input = document.getElementById('draft-input');
    if (!binding || !name || !input) return {};
    if (new TextEncoder().encode(input.value).byteLength > ${WORKFLOW_DRAFT_INPUT_MAX_BYTES}) {
      showEditorError('Draft JSON exceeds the 5 MiB transport limit. This pasted text remains only in this visible editor and is not sent or saved. Reduce it before any panel action.');
      return null;
    }
    if (new TextEncoder().encode(name.value).byteLength > 512 || /[\\0\\r\\n]/u.test(name.value)) {
      showEditorError('Display name exceeds its bounded single-line limit. The visible text is retained and not sent. Reduce it before any panel action.');
      return null;
    }
    showEditorError('');
    return { binding: binding.value, name: name.value, inputText: input.value };
  };
  document.addEventListener('input', (event) => {
    if (event.target?.id !== 'draft-name' && event.target?.id !== 'draft-input') return;
    const status = document.getElementById('draft-dirty');
    if (status) status.textContent = 'Not shared · captured editor changes await a separate shared acknowledgement.';
    const recovery = document.getElementById('draft-recovery-status');
    if (recovery) recovery.textContent = 'Private checkpoint pending · newest edits are not yet acknowledged locally';
    const fields = editorFields();
    if (fields) draftsVscode.postMessage({ type: 'change', ...fields });
  });
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-draft-action]') : null;
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const fields = editorFields();
    if (!fields) return;
    const extra = {};
    if (target.dataset.lockKind) extra.lockKind = target.dataset.lockKind;
    if (target.dataset.guideStage) extra.stage = Number(target.dataset.guideStage);
    if (target.dataset.guideIndex) extra.index = Number(target.dataset.guideIndex);
    if (target.dataset.guideDirection) extra.direction = Number(target.dataset.guideDirection);
    if (target.dataset.choiceKind) {
      extra.choiceKind = target.dataset.choiceKind;
      if (target.dataset.choiceSelect) {
        const value = document.getElementById(target.dataset.choiceSelect)?.value;
        if (typeof value !== 'string' || !value || new TextEncoder().encode(value).byteLength > 512 || /[\\0\\r\\n]/u.test(value)) { showEditorError('Choose one bounded captured catalog value or leave this decision unresolved. No binding was sent.'); return; }
        extra.choiceId = value;
      }
    }
    if (target.dataset.guideField) {
      const value = document.getElementById(target.dataset.guideInput)?.value;
      if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 128 * 1024) {
        showEditorError('The guided answer exceeds 128 KiB or is missing. Its visible text is retained but has not been applied or sent.'); return;
      }
      extra.field = target.dataset.guideField; extra.value = value;
    }
    draftsVscode.postMessage({ type: target.dataset.draftAction, ...fields, ...extra,
      ...(target.dataset.draftId ? { draftId: target.dataset.draftId } : {}) });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'draft-status' && message.binding === document.getElementById('draft-binding')?.value) {
      const visibleCaptured = editorFields() !== null;
      for (const [id, key] of [['draft-dirty', 'durability'], ['draft-autosave', 'autosave'], ['draft-revision', 'revision'], ['draft-operation', 'operation'], ['draft-recovery-status', 'recovery']]) {
        const element = document.getElementById(id);
        if (element && typeof message[key] === 'string' && message[key].length <= 5000) element.textContent = !visibleCaptured && id === 'draft-dirty'
          ? 'Visible text is not captured or saved. Any shared acknowledgement covers only the prior bounded checkpoint.'
          : !visibleCaptured && id === 'draft-recovery-status'
            ? 'Visible text is not privately checkpointed. Any local acknowledgement covers only the prior bounded capture.' : message[key];
      }
      const error = document.getElementById('draft-live-error');
      if (error && typeof message.error === 'string' && message.error.length <= 4000) { error.textContent = message.error; error.hidden = !message.error; }
      const show = document.getElementById('draft-show'); if (show && message.hasShow === false) show.hidden = true;
      const preview = document.getElementById('draft-preview'); if (preview && message.hasPreview === false) preview.hidden = true;
      const recoveryChoice = document.getElementById('draft-recovery-choice');
      if (recoveryChoice && message.hasRecoveryCandidate === false) recoveryChoice.hidden = true;
      for (const button of document.querySelectorAll?.('[data-draft-action]') ?? []) {
        if (!(button instanceof HTMLButtonElement)) continue;
        const action = button.dataset.draftAction;
        const edits = ['save', 'guide-answer', 'add-stage', 'move-stage', 'catalog-answer', 'autosave-on'];
        button.disabled = message.busy === true || (message.readOnly === true && edits.includes(action))
          || (action === 'catalog-answer' && message.dirty === true)
          || (['save', 'autosave-on', 'submit-review', 'copilot-submit-review'].includes(action) && message.recoveryBlocked === true)
          || (action === 'recovery-restore' && message.restoreAllowed !== true)
          || (['recovery-restore', 'recovery-compare', 'recovery-discard'].includes(action) && message.hasRecoveryCandidate !== true);
      }
      return;
    }
    if (message?.type !== 'editor-rejected' || typeof message.message !== 'string'
        || message.message.length > 4000 || message.binding !== document.getElementById('draft-binding')?.value) return;
    showEditorError(message.message + ' The visible text has not been replaced or sent to the CLI. Reduce it before any panel action.');
  });
`;

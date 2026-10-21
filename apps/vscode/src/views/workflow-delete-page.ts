/**
 * The Delete… review page of Workflow Studio. [docs/SPEC-WORKFLOW-RETIREMENT-v1.md, Surfaces]
 *
 * Pure: the argv of the two `workflow delete` commands, the engine's plan as the page shows it, and
 * the markup. The page shows the exact plan `workflow delete <ID> --dry-run --json` returns: what is
 * removed (by kind), what is kept and which workflows still use it, agents that lose steps, cleaned
 * references, the Stories that use the workflow, the backup that is saved first and the plan digest.
 * Its one action, Propose deletion, confirms that digest. Names and paths only, never file contents.
 */
import { brandLockup, escape, icon } from './webview.ts';

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SELECTOR = /^(?:story|initiative):[a-z0-9][a-z0-9-]{0,63}$/u;
const PLAN_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_ROWS = 2000;
const USED_BY_SHOWN = 8;

/** `workflow delete <SELECTOR> --dry-run [--new-default ID] --json`: the exact plan, nothing changes. */
export function workflowDeletePreviewArgs(selector: string, newDefault: string | null = null): string[] {
  return ['workflow', 'delete', selector, '--dry-run', ...(newDefault ? ['--new-default', newDefault] : []), '--json'];
}

/**
 * Confirm the previewed digest. `--propose` only when the plan bound an approved destination, as a
 * duplicate's does; a repository without one writes its own files for the person to commit.
 */
export function workflowDeleteConfirmArgs(selector: string, planSha256: string, newDefault: string | null, propose: boolean): string[] {
  return ['workflow', 'delete', selector, '--confirm', planSha256, ...(newDefault ? ['--new-default', newDefault] : []),
    ...(propose ? ['--propose'] : []), '--json'];
}

/** `workflow archive|restore <SELECTOR> [--reason TEXT] [--new-default ID] [--propose] --json`. */
export function workflowArchiveArgs(selector: string, { restore = false, reason = null, newDefault = null, propose = false }:
  { restore?: boolean; reason?: string | null; newDefault?: string | null; propose?: boolean } = {}): string[] {
  return ['workflow', restore ? 'restore' : 'archive', selector, ...(!restore && reason ? ['--reason', reason] : []),
    ...(!restore && newDefault ? ['--new-default', newDefault] : []), ...(propose ? ['--propose'] : []), '--json'];
}

/** A refusal the engine printed as `{ error: { code, message, details } }`, read off a failed run. */
export interface EngineRefusal { code: string; message: string; details: Record<string, unknown> }
export function refusalOf(error: unknown): EngineRefusal | null {
  const refused = (error as { result?: { error?: { code?: unknown; message?: unknown; details?: unknown } } } | null)?.result?.error;
  if (!refused || typeof refused.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(refused.code)) return null;
  const details = refused.details && typeof refused.details === 'object' && !Array.isArray(refused.details) ? refused.details as Record<string, unknown> : {};
  return { code: refused.code, message: typeof refused.message === 'string' ? refused.message : (error as Error)?.message ?? '', details };
}

/** The live workflow IDs a refusal names for a new default (`details.live`). */
export function liveWorkflows(refusal: EngineRefusal | null): string[] {
  const live = refusal?.details.live;
  return Array.isArray(live) ? [...new Set(live.filter((id): id is string => typeof id === 'string' && WORKFLOW_ID.test(id)))] : [];
}

export interface PlanEntry { kind: string; id: string | null; path: string | null; usedBy: string[]; reason: string | null }
export interface PlanStory { id: string; status: string | null; branch: string | null }
export interface DeletePlan {
  workflowId: string; governs: 'story' | 'initiative'; selector: string; planSha256: string;
  removed: PlanEntry[]; kept: PlanEntry[];
  trimmed: Array<{ id: string; path: string | null; steps: string[] }>;
  cleanups: Array<Record<string, unknown> & { kind: string }>;
  unreadable: Array<{ workflow: string; message: string }>;
  stories: { status: string; reason: string | null; pinned: PlanStory[]; unpinned: PlanStory[]; unchecked: PlanStory[] };
  /** An approved configuration destination was bound into the plan: confirming proposes for review. */
  proposes: boolean;
  newDefault: string | null;
}

const text = (value: unknown, limit = 500): string | null => (typeof value === 'string' && value.trim() ? value.slice(0, limit) : null);
const strings = (value: unknown, limit = 200): string[] => (Array.isArray(value) ? value : [])
  .map((entry) => text(entry, 300)).filter((entry): entry is string => entry !== null).slice(0, limit);
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : [])
  .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)).slice(0, MAX_ROWS);
const story = (entry: Record<string, unknown>): PlanStory | null => (text(entry.id, 200)
  ? { id: text(entry.id, 200)!, status: text(entry.status, 60), branch: text(entry.branch, 260) } : null);
const stories = (value: unknown): PlanStory[] => records(value).map(story).filter((entry): entry is PlanStory => entry !== null);

/** The engine's plan as the page uses it, or null when the answer is not a delete plan. */
export function deletePlanFrom(value: unknown): DeletePlan | null {
  const plan = value as Record<string, unknown> | null;
  if (!plan || plan.resultType !== 'workflow-delete-plan' || typeof plan.planSha256 !== 'string' || !PLAN_SHA256.test(plan.planSha256)
      || typeof plan.selector !== 'string' || !SELECTOR.test(plan.selector) || (plan.governs !== 'story' && plan.governs !== 'initiative')
      || typeof plan.workflowId !== 'string' || !WORKFLOW_ID.test(plan.workflowId)) return null;
  const entry = (row: Record<string, unknown>): PlanEntry | null => {
    const kind = text(row.kind, 80);
    const id = text(row.id, 200);
    const path = text(row.path, 600);
    return kind && (id || path) ? { kind, id, path, usedBy: strings(row.usedBy), reason: text(row.reason, 120) } : null;
  };
  const listed = plan.stories as Record<string, unknown> | undefined;
  return {
    workflowId: plan.workflowId, governs: plan.governs, selector: plan.selector, planSha256: plan.planSha256,
    removed: records(plan.removed).map(entry).filter((row): row is PlanEntry => row !== null),
    kept: records(plan.kept).map(entry).filter((row): row is PlanEntry => row !== null),
    trimmed: records(plan.trimmed).flatMap((row) => text(row.id, 200) ? [{ id: text(row.id, 200)!, path: text(row.path, 600), steps: strings(row.steps) }] : []),
    cleanups: records(plan.cleanups).flatMap((row) => text(row.kind, 80) ? [{ ...row, kind: text(row.kind, 80)! }] : []),
    unreadable: records(plan.unreadableWorkflows).flatMap((row) => text(row.workflow, 200)
      ? [{ workflow: text(row.workflow, 200)!, message: text(row.message, 1200) ?? 'It could not be read.' }] : []),
    stories: {
      status: text(listed?.status, 40) ?? 'unavailable', reason: text(listed?.reason, 1200),
      pinned: stories(listed?.pinned), unpinned: stories(listed?.unpinned), unchecked: stories(listed?.unchecked)
    },
    proposes: Boolean(plan.destinationAuthority),
    newDefault: text(plan.newDefault, 64)
  };
}

/** What a confirmed delete returned: the proposal (or the local write) and the backup it saved first. */
export interface DeleteResult { reviewRequired: boolean; branch: string | null; backupPath: string | null; uploaded: boolean }
export function deleteResultFrom(value: unknown): DeleteResult {
  const result = (value ?? {}) as Record<string, unknown>;
  const backup = (result.backup ?? {}) as Record<string, unknown>;
  return { reviewRequired: result.reviewRequired === true, branch: text(result.branch, 260), backupPath: text(backup.path, 2000), uploaded: result.pushed !== false };
}

/** The command that previews bringing the workflow back from its backup bundle. */
export function restoreCommand(backupPath: string): string {
  return `singularity-flow workflow import "${backupPath.replace(/(["\\$`])/gu, '\\$1')}" --dry-run`;
}

const KIND_WORDS: Record<string, string> = {
  'story.workflow': 'Workflow', 'initiative.workflow': 'Epic workflow', 'story.phases': 'Steps', 'initiative.initiativePhases': 'Epic steps',
  'story.templates': 'Template catalog entries', 'story.artifactSets': 'Artifact sets', 'story.approvalAuthorities': 'Approval groups',
  'initiative.approvalAuthorities': 'Epic approval groups', 'story.mcpServers': 'MCP servers', 'story.integrations.targets': 'Integration targets',
  'initiative.applicabilityPolicies': 'Applicability policies', agent: 'Agents', skill: 'Skills', instruction: 'Instructions',
  'template-file': 'Template files', vendored: 'Vendored imports', constitution: 'Constitutions'
};
const REASON_WORDS: Record<string, string> = {
  'approval-group': 'Approval groups are never deleted', seeded: 'Seeded with Singularity Flow', 'built-in-agent': 'A built-in agent',
  'compiled-skill-step': 'A compiled skill step', 'canonical-epic-step': 'A canonical Epic step', 'shared-default': 'The shared default constitution',
  'owner-kept': 'What owns it is kept', 'another-workflow-unreadable': 'Kept because another workflow could not be read',
  'not-removed-by-delete': 'Not removed by a delete'
};
export const kindWords = (kind: string): string => KIND_WORDS[kind] ?? kind;

/** Entries grouped by kind, in the order the engine first names each kind. */
export function byKind(entries: PlanEntry[]): Array<{ kind: string; label: string; entries: PlanEntry[] }> {
  const groups = new Map<string, PlanEntry[]>();
  for (const entry of entries) groups.set(entry.kind, [...(groups.get(entry.kind) ?? []), entry]);
  return [...groups].map(([kind, rows]) => ({ kind, label: kindWords(kind), entries: rows }));
}

/** A cleaned reference in plain words. */
export function cleanupWords(cleanup: Record<string, unknown> & { kind: string }, label: (selector: string) => string): string {
  const list = (value: unknown) => strings(value).join(', ');
  switch (cleanup.kind) {
    case 'mcp-server-steps': return `MCP server ${text(cleanup.id) ?? ''} stops listing ${list(cleanup.steps)}`;
    case 'document-allowed-steps': return `Documents' allowed steps lose ${list(cleanup.steps)}`;
    case 'context-step-overrides': return `Context overrides for ${list(cleanup.steps)} are removed`;
    case 'skill-attachments': return `${Number(cleanup.rows) || 0} skill attachment row${Number(cleanup.rows) === 1 ? '' : 's'} removed or trimmed`;
    case 'impact-eligibility': return `Impact studies ${list(cleanup.studies)} stop naming this workflow`;
    case 'archive-entry': return 'Its entry in the archived-workflow list is removed';
    case 'default-workflow': return `New Stories default to ${label(`story:${text(cleanup.to) ?? ''}`)} instead`;
    case 'agent-lock': return `Agent lock rows for ${list(cleanup.agents)} are removed`;
    case 'imports-lock': return `Import lock rows ${list(cleanup.imports)} are removed`;
    default: return cleanup.kind;
  }
}

export interface DeleteReviewView {
  label: string; selector: string; plan: DeletePlan | null; busy: boolean; notice: string | null; error: string | null;
  /** The default workflow needs a replacement before a plan can be shown. */
  needsDefault: boolean; done: DeleteResult | null; labels: Record<string, string>;
}

function usedByHtml(entry: PlanEntry, label: (selector: string) => string): string {
  if (!entry.usedBy.length) return `<span class="muted">${escape(REASON_WORDS[entry.reason ?? ''] ?? entry.reason ?? 'Kept')}</span>`;
  const names = entry.usedBy.map(label);
  const shown = names.slice(0, USED_BY_SHOWN).join(', ') + (names.length > USED_BY_SHOWN ? ` and ${names.length - USED_BY_SHOWN} more` : '');
  return `<span class="muted" title="${escape(names.join(', '))}">Used by ${escape(shown)}</span>`;
}

function rowName(entry: PlanEntry): string {
  return `<code>${escape(entry.id ?? entry.path)}</code>${entry.id && entry.path ? ` <small class="muted wd-path">${escape(entry.path)}</small>` : ''}`;
}

function storiesHtml(plan: DeletePlan): string {
  const { stories } = plan;
  const list = (rows: PlanStory[]) => rows.map((row) => `<li><code>${escape(row.id)}</code>${row.status ? ` <small class="muted">${escape(row.status)}</small>` : ''}</li>`).join('');
  if (plan.governs !== 'story') return '<p class="muted">Epics carry no Story workflow pin to check.</p>';
  if (stories.status !== 'checked') {
    return `<p class="muted" data-wd-stories="unchecked">The Stories could not be checked here${stories.reason ? `: ${escape(stories.reason.replace(/\.$/u, ''))}` : ''}. Proposing checks them again.</p>`;
  }
  const blocking = stories.unpinned.length
    ? `<div class="notice error" role="alert" data-wd-blocked>${icon('blocked')}<div><strong>The delete is blocked.</strong> Workflow '${escape(plan.workflowId)}' is used by ${stories.unpinned.length} unfinished Stor${stories.unpinned.length === 1 ? 'y' : 'ies'} that run from the live configuration: ${escape(stories.unpinned.map((row) => row.id).join(', '))}. Finish or cancel them, or archive the workflow instead.</div></div>` : '';
  return `${blocking}${stories.pinned.length ? `<p>Keep running on their pinned copy of the workflow:</p><ul class="wd-list" data-wd-pinned>${list(stories.pinned)}</ul>` : ''}
    ${stories.unchecked.length ? `<p>Could not be checked here; proposing checks them again:</p><ul class="wd-list">${list(stories.unchecked)}</ul>` : ''}
    ${!stories.pinned.length && !stories.unpinned.length && !stories.unchecked.length ? '<p class="muted" data-wd-stories="none">No unfinished Story uses this workflow.</p>' : ''}`;
}

export function workflowDeleteHtml(view: DeleteReviewView): string {
  const label = (selector: string) => view.labels[selector] ?? selector.replace(/^story:/u, '');
  const plan = view.plan;
  const header = `<header class="inbox-header"><div>${brandLockup()}<p class="eyebrow">Workflow Studio</p>
    <h1>${icon('remove', { size: 24 })}Delete ${escape(view.label)}</h1>
    ${view.done ? '' : `<p class="meta">Review exactly what goes and what stays. Nothing changes until you propose the deletion${plan?.proposes === false ? '' : ' and the proposal is reviewed and activated'}. Stories that already run on it keep their pinned copy.</p>`}</div></header>`;
  const notices = [
    view.busy ? '<div class="notice warning" role="status">Working…</div>' : '',
    view.notice ? `<div class="notice ok" role="status">${icon('info')}${escape(view.notice)}</div>` : '',
    view.error ? `<div class="notice error" role="alert" data-wd-error>${icon('blocked')}${escape(view.error)}</div>` : ''
  ].join('');
  const close = `<button type="button" class="secondary" data-wd-action="cancel">${view.done ? 'Close' : 'Cancel'}</button>`;
  if (view.done) {
    const done = view.done;
    const restore = done.backupPath ? restoreCommand(done.backupPath) : null;
    return `<main class="wd-page">${header}${notices}<section class="plain wd-done" data-wd-done>
      <h2>${icon('ok')}${done.reviewRequired && done.branch ? `Deletion proposed as <code>${escape(done.branch)}</code>` : 'Deletion written to this repository'}</h2>
      <p>${done.reviewRequired && done.branch
        ? (done.uploaded ? 'It waits for review under Workflow Studio → Changes; the approved configuration changes only when it is activated.'
          : 'It is saved on this computer and uploading; Workflow Studio → Changes shows it once uploaded, or why it could not be.')
        : 'The configuration files changed in this checkout. Review the diff and commit it through your usual review.'}</p>
      ${done.backupPath ? `<p>A complete backup of the workflow was saved first:</p><p><code class="wd-path" data-wd-backup>${escape(done.backupPath)}</code></p>
        <p>To bring it back, preview importing the backup: <code data-wd-restore>${escape(restore)}</code></p>` : ''}
      <div class="wd-actions">${done.reviewRequired && done.branch ? '<button type="button" data-wd-action="review">Review and activate</button>' : ''}
        ${restore ? '<button type="button" class="secondary" data-wd-action="copy">Copy restore command</button>' : ''}${close}</div></section></main>`;
  }
  if (!plan) {
    return `<main class="wd-page">${header}${notices}<div class="wd-actions">${view.needsDefault
      ? '<button type="button" data-wd-action="default">Choose new default…</button>' : `<button type="button" data-wd-action="preview"${view.busy ? ' disabled' : ''}>Preview again</button>`}${close}</div></main>`;
  }
  const blocked = plan.stories.unpinned.length > 0;
  const section = (key: string, title: string, body: string) => `<section class="plain wd-section" data-wd-section="${key}"><h2>${title}</h2>${body}</section>`;
  // Names alone wrap as chips, so dozens of steps stay readable; an object with its own file keeps a row.
  const removed = byKind(plan.removed).map((group) => {
    const rows = group.entries.some((entry) => entry.id && entry.path);
    return `<h3>${escape(group.label)} <small class="muted">${group.entries.length}</small></h3>
    <ul class="${rows ? 'wd-list' : 'wd-chips'}" data-wd-kind="${escape(group.kind)}">${group.entries.map((entry) => `<li>${rowName(entry)}</li>`).join('')}</ul>`;
  }).join('');
  const kept = byKind(plan.kept).map((group) => `<h3>${escape(group.label)} <small class="muted">${group.entries.length}</small></h3>
    <ul class="wd-list">${group.entries.map((entry) => `<li>${rowName(entry)} ${usedByHtml(entry, label)}</li>`).join('')}</ul>`).join('');
  const trimmed = plan.trimmed.map((agent) => `<li><code>${escape(agent.id)}</code> loses ${escape(agent.steps.join(', ') || 'the removed steps')}</li>`).join('');
  const cleaned = plan.cleanups.map((cleanup) => `<li>${escape(cleanupWords(cleanup, label))}</li>`).join('');
  return `<main class="wd-page" data-wd-plan="${escape(plan.planSha256)}">${header}${notices}
    <p class="wd-summary"><strong>${plan.removed.length}</strong> removed · <strong>${plan.kept.length}</strong> kept because something still needs them${plan.trimmed.length ? ` · <strong>${plan.trimmed.length}</strong> agent${plan.trimmed.length === 1 ? '' : 's'} trimmed` : ''}${plan.cleanups.length ? ` · <strong>${plan.cleanups.length}</strong> reference${plan.cleanups.length === 1 ? '' : 's'} cleaned` : ''}</p>
    ${plan.unreadable.map((entry) => `<div class="notice warning">${icon('warning')}Could not read ${escape(label(entry.workflow))}, so every dependency is kept: ${escape(entry.message)}</div>`).join('')}
    ${plan.newDefault ? `<div class="notice warning">${icon('warning')}It is the default workflow for new Stories; ${escape(label(`story:${plan.newDefault}`))} becomes the default.</div>` : ''}
    ${section('stories', `${icon('story')}Stories`, storiesHtml(plan))}
    ${section('removed', `${icon('remove')}Removed`, removed || '<p class="muted">Nothing.</p>')}
    ${section('kept', `${icon('ok')}Kept, and what still uses each`, kept || '<p class="muted">Nothing is kept: no other workflow uses what this one uses.</p>')}
    ${plan.trimmed.length ? section('trimmed', `${icon('agent')}Agents that lose steps`, `<p class="muted">Each is used elsewhere, so it stays and only the removed steps go.</p><ul class="wd-list">${trimmed}</ul>`) : ''}
    ${plan.cleanups.length ? section('cleanups', `${icon('configuration')}References cleaned`, `<ul class="wd-list">${cleaned}</ul>`) : ''}
    ${section('backup', `${icon('archive')}Backup`, `<p>Before anything changes, a complete export bundle of this workflow is saved on this computer. Its path, and the command that restores it, are shown here afterwards.</p>`)}
    ${section('digest', `${icon('policy')}Exact plan`, `<p>Proposing confirms this digest. If the configuration changes first, the page previews again.</p><p><code class="wd-path" data-wd-digest>${escape(plan.planSha256)}</code></p>
      <p class="muted">${plan.proposes ? 'Creates a review proposal against the approved configuration.' : 'This repository has no approved configuration authority, so the change is written to its files for you to review and commit.'}</p>`)}
    <div class="wd-actions"><button type="button" data-wd-action="confirm" data-wd-sha="${escape(plan.planSha256)}"${view.busy || blocked ? ' disabled' : ''}>Propose deletion</button>
      <button type="button" class="secondary" data-wd-action="preview"${view.busy ? ' disabled' : ''}>Preview again</button>${close}</div>
  </main>`;
}

export const WORKFLOW_DELETE_STYLE = `
.wd-page { max-width: 980px; }
.wd-summary { margin: 1rem 0; }
.wd-section { margin: 1rem 0; }
.wd-section h2, .wd-done h2 { display:flex; gap:.4rem; align-items:center; font-size:1.05rem; margin:0 0 .5rem; flex-wrap:wrap; }
.wd-section h3 { font-size:.9rem; margin:.7rem 0 .3rem; }
.wd-list { margin:.2rem 0; padding-left:1.2rem; display:grid; gap:.2rem; }
.wd-list li { overflow-wrap:anywhere; }
.wd-chips { display:flex; flex-wrap:wrap; gap:.3rem .4rem; margin:.2rem 0; padding:0; list-style:none; }
.wd-chips li { min-width:0; overflow-wrap:anywhere; }
.wd-path { overflow-wrap:anywhere; }
.wd-actions { display:flex; flex-wrap:wrap; gap:.5rem; margin:1.2rem 0; }
/* The decision stays in reach however long the plan is. */
.wd-page > .wd-actions { position:sticky; bottom:0; z-index:1; margin-bottom:0; padding:.6rem 0; border-top:var(--sf-border); background:var(--vscode-editor-background); }
.notice > div { min-width:0; }
`;

/** Click handling: it posts what the markup names; the host checks it against the plan it holds. */
export const WORKFLOW_DELETE_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest && event.target.closest('[data-wd-action]');
    if (!target || target.disabled) return;
    event.preventDefault();
    if (target.dataset.wdAction === 'confirm') document.querySelectorAll('[data-wd-action]').forEach((node) => { node.disabled = node.dataset.wdAction !== 'cancel'; });
    api.postMessage({ type: 'delete.' + target.dataset.wdAction, planSha256: target.dataset.wdSha || null });
  });
})();
`;

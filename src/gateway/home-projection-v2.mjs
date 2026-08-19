/**
 * The bounded, versioned projection every My Work surface renders.
 *
 * It is built only after the kernel seals planner navigation choices. Consequently every action
 * below carries an authority-issued opaque handle; this module cannot mint or infer authority.
 */
import { recordSha256 } from '../records.mjs';
import { primaryAction } from './result.mjs';

export const HOME_PROJECTION_SCHEMA_VERSION = 2;
export const HOME_LENSES = Object.freeze(['developer', 'qa', 'architect', 'product-owner', 'admin']);

export function normalizeHomeLens(value) {
  return HOME_LENSES.includes(value) ? value : 'developer';
}

function boundedContextLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 128) return null;
  if (label.startsWith('/') || label.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(label)) return null;
  return label;
}

function uiAction(action) {
  if (!action) return null;
  return Object.freeze({
    id: action.id,
    handle: action.handle,
    label: action.label,
    kind: action.kind,
    reasonCode: action.reasonCode,
    confirmation: action.confirmation,
    interaction: action.interaction,
    emphasis: action.emphasis,
    executable: action.executable,
    slots: Object.freeze({ ...(action.slots ?? {}) }),
    fallback: action.fallback ? Object.freeze({
      label: action.fallback.label ?? action.label,
      command: action.fallback.command ?? null,
      skill: action.fallback.skill ?? null
    }) : null
  });
}

function workCard(work, rail, action) {
  if (!work) return null;
  return Object.freeze({
    id: work.id,
    kind: work.kind,
    title: work.title ?? null,
    repositoryId: work.repositoryId ?? null,
    branch: work.branch ?? null,
    phase: work.phase ?? null,
    status: work.status ?? null,
    group: work.group ?? null,
    rail: Object.freeze([...(rail ?? [])]),
    action
  });
}

function attentionItem({ id, kind, title, workId = null, phase = null, reasonCode, action = null, detail = null }) {
  return Object.freeze({ id, kind, title, workId, phase, reasonCode, detail, action });
}

export function homeProjectionV2(result, { registryHash = null, now = () => Date.now() } = {}) {
  const data = result.data ?? {};
  const actions = Object.freeze((result.next ?? []).map(uiAction));
  const primary = uiAction(primaryAction(result));
  const workspace = data.workspace ?? null;
  const repository = data.repository ?? null;
  const currentWork = data.currentWork ?? data.activeWork ?? null;
  const attentionWork = data.attentionWork ?? null;
  const review = actions.find((action) => action.id.startsWith('home:review:')) ?? null;
  const needsUser = attentionWork ? [attentionItem({
    id: `decision:${attentionWork.kind}:${attentionWork.id}`,
    kind: 'decision',
    title: attentionWork.title ?? attentionWork.id,
    workId: attentionWork.id,
    phase: attentionWork.phase,
    reasonCode: 'home.needs-your-decision',
    action: review
  })] : [];

  const worthChecking = [];
  if (data.localChanges?.dirty) worthChecking.push(attentionItem({
    id: `local:${data.localChanges.worktreeHash ?? 'dirty'}`,
    kind: 'local-risk',
    title: `${data.localChanges.files ?? 0} changed path(s) remain local`,
    workId: currentWork?.id ?? null,
    reasonCode: 'home.local-work-unreconciled',
    action: actions.find((action) => action.id === 'home:work.return') ?? null
  }));
  if (data.currentWork?.group === 'recovery-required') worthChecking.push(attentionItem({
    id: `recovery:${data.currentWork.id}`,
    kind: 'recovery',
    title: `Publication recovery is required for ${data.currentWork.id}`,
    workId: data.currentWork.id,
    phase: data.currentWork.phase,
    reasonCode: 'home.recovery-required',
    action: actions.find((action) => action.id === 'home:work.continue') ?? null
  }));
  for (const fault of data.faults ?? []) {
    if (worthChecking.length >= 3 || fault.disposition === 'resolved') break;
    worthChecking.push(attentionItem({
      id: `fault:${fault.faultId}`,
      kind: 'fault',
      title: fault.summary ?? fault.faultId,
      reasonCode: 'fault.unresolved',
      action: actions.find((action) => action.id === `fault:fix:${fault.faultId}`) ?? null,
      detail: fault.severity ?? null
    }));
  }

  const actor = data.actor ?? { id: 'actor:unavailable', display: data.personalization?.displayName ?? null };
  const context = Object.freeze({
    workspaceId: boundedContextLabel(workspace?.id),
    workspaceLabel: boundedContextLabel(workspace?.name),
    repositoryId: boundedContextLabel(repository?.id),
    branch: repository?.branch ?? null,
    head: repository?.head ?? null,
    worktreeFingerprint: data.localChanges?.worktreeHash ?? result.subject?.revision?.worktreeHash ?? null,
    activeWorkId: currentWork?.id ?? null
  });
  const subjectRevision = recordSha256({
    actorId: actor.id,
    context,
    subject: result.subject ?? null,
    activeWork: currentWork ? {
      id: currentWork.id, kind: currentWork.kind, phase: currentWork.phase,
      status: currentWork.status, group: currentWork.group
    } : null,
    workflowRail: data.rail ?? [],
    registryHash,
    actionIds: actions.map((action) => action.id)
  });
  const degraded = (result.warnings ?? []).length > 0;

  return Object.freeze({
    schemaVersion: HOME_PROJECTION_SCHEMA_VERSION,
    resultType: 'my-work-home',
    asOf: new Date(now()).toISOString(),
    actor: Object.freeze({ id: actor.id, ...(actor.display ? { display: actor.display } : {}) }),
    context,
    lens: Object.freeze({ id: normalizeHomeLens(data.lens) }),
    prompt: Object.freeze({
      placeholderMessageId: 'home.prompt-placeholder',
      goals: actions
    }),
    needsUser: Object.freeze(needsUser),
    activeWork: workCard(currentWork, data.rail, primary),
    now: primary,
    why: result.why,
    today: data.today ?? null,
    yesterday: data.yesterday ?? null,
    worthChecking: Object.freeze(worthChecking.slice(0, 3)),
    recent: Object.freeze((data.recent ?? []).slice(0, 5)),
    health: Object.freeze({
      status: degraded ? 'degraded' : 'healthy',
      warnings: Object.freeze((result.warnings ?? []).map((warning) => warning.code)),
      journal: data.journalAvailable === false ? 'unavailable' : 'local-only'
    }),
    subjectRevision,
    sources: Object.freeze([
      Object.freeze({ id: 'governed-records', freshness: 'current-read', available: workspace !== null }),
      Object.freeze({ id: 'git-worktree', freshness: data.localChanges ? 'current-read' : 'not-checked', available: Boolean(data.localChanges) }),
      Object.freeze({ id: 'local-journal', freshness: data.today?.generatedAt ?? data.yesterday?.generatedAt ?? 'not-checked', available: data.journalAvailable !== false })
    ])
  });
}

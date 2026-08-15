import { createHash } from 'node:crypto';
import { branch, changedFiles, changes, head, identity, repoRoot } from './git.mjs';
import { readPendingPublication } from './publication-pending.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { workRecords, WORK_GROUP_ORDER } from './gateway/work-records.mjs';
import {
  activeWorkspaceFile, buildWorkspaceContext, readActiveWorkspaceContext, workspaceRegistryFile
} from './workspace-context.mjs';
import { workspaceStatus } from './workspace.mjs';
import { SingularityFlowError } from './util.mjs';

const HANDLE_TTL_MS = 15 * 60 * 1000;
const MAX_CHOICES = 6;
const ACTION_REGISTRY_VERSION = 'developer-home.v1';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function actorKey(actor) {
  return actor?.email ?? actor?.login ?? actor?.name ?? 'unknown';
}

function phaseSummary(workflow) {
  const order = workflow.phaseOrder ?? [];
  const phases = order.map((id) => {
    const phase = workflow.phases?.[id] ?? {};
    const approvals = (phase.approvals ?? []).filter((item) => !item.invalidatedAt);
    return {
      id,
      label: phase.label ?? id,
      status: phase.status ?? 'unknown',
      generation: phase.generation ?? 0,
      agent: phase.defaultAgent ?? null,
      artifacts: (phase.artifacts ?? []).map((artifact) => ({
        id: artifact.id ?? artifact.path,
        path: artifact.path,
        sha256: artifact.sha256 ?? null
      })),
      approvals: approvals.map((approval) => ({
        decision: approval.decision,
        actor: approval.actor ?? null,
        agent: approval.agent ?? null,
        at: approval.at ?? null,
        selfApproval: Boolean(approval.selfApproval)
      }))
    };
  });
  return {
    currentPhase: workflow.currentPhase ?? null,
    status: workflow.status ?? (workflow.currentPhase ? 'active' : 'complete'),
    approved: phases.filter((phase) => phase.status === 'approved').length,
    total: phases.length,
    phases
  };
}

function boundedChangedFiles(root, dirty) {
  if (!dirty.trim()) return [];
  return changedFiles(root)
    .filter((candidate) => typeof candidate === 'string' && candidate && !candidate.startsWith('/'))
    .slice(0, 100);
}

function repositoryRevision(repository, storyId = null) {
  const dirty = repository.state === 'ready' ? changes(repository.absolutePath) : '';
  return {
    repositoryId: repository.id,
    branch: repository.branch,
    head: repository.head,
    storyId,
    worktreeHash: digest(dirty),
    dirty: Boolean(dirty.trim()),
    changedFiles: boundedChangedFiles(repository.absolutePath, dirty)
  };
}

function resolutionSource(location) {
  const source = String(location?.source ?? 'working-tree').toLowerCase();
  if (source.includes('working')) return 'working-tree';
  if (source.includes('remote')) return 'remote-ref';
  if (source.includes('ledger')) return 'ledger-evidence';
  if (source.includes('branch') || source.includes('ref')) return 'git-ref';
  return 'repository-index';
}

function choiceHandle(choice, subjectRevision, actor, hostSession, now) {
  return `sfh_${digest({
    registry: ACTION_REGISTRY_VERSION,
    id: choice.id,
    operation: choice.operation,
    goalId: choice.goalId,
    target: choice.target,
    subjectRevision,
    actor: actorKey(actor),
    hostSession,
    issuedAt: now
  }).slice(0, 32)}`;
}

export function bindDeveloperHomeChoices(choices, { subjectRevision, actor, hostSession = null, now }) {
  const expiresAt = new Date(Date.parse(now) + HANDLE_TTL_MS).toISOString();
  return choices.slice(0, MAX_CHOICES).map((choice) => ({
    ...choice,
    actionRegistryVersion: ACTION_REGISTRY_VERSION,
    handle: choiceHandle(choice, subjectRevision, actor, hostSession, now),
    subjectRevision,
    actor: actorKey(actor),
    hostSession,
    issuedAt: now,
    expiresAt
  }));
}

export function validateDeveloperHomeHandle(choice, {
  subjectRevision, actor, hostSession = null, now = new Date().toISOString()
}) {
  if (!choice || choice.actionRegistryVersion !== ACTION_REGISTRY_VERSION) return false;
  if (choice.subjectRevision !== subjectRevision || choice.actor !== actorKey(actor)) return false;
  if ((choice.hostSession ?? null) !== (hostSession ?? null)) return false;
  if (Date.parse(choice.expiresAt) <= Date.parse(now)) return false;
  return choice.handle === choiceHandle(choice, subjectRevision, actor, hostSession, choice.issuedAt);
}

function workChoice(item) {
  const label = item.group === 'recovery-required'
    ? `Recover publication for ${item.id}`
    : item.group === 'waiting-on-you'
      ? `Review ${item.id}`
      : `Continue ${item.id}`;
  return {
    id: `work:${item.id}:${item.group}`,
    operation: item.group === 'waiting-on-you' ? 'review.packet' : 'work.continue',
    goalId: item.group === 'waiting-on-you' ? 'review-governed-work' : 'continue-governed-work',
    target: { repositoryId: item.repositoryId, workId: item.id, phase: item.phase ?? null },
    label,
    detail: `${item.phaseLabel ?? item.phase ?? 'workflow'} · ${item.status ?? item.group}`,
    repositoryId: item.repositoryId,
    workId: item.id,
    phase: item.phase,
    reasonCode: item.whyVisible,
    fallbackCommand: item.group === 'waiting-on-you'
      ? `singularity-flow review ${item.phase ?? ''}`.trim()
      : `singularity-flow story return ${item.id}`,
    navigationTarget: item.group === 'waiting-on-you' ? 'approvals' : 'lifecycle'
  };
}

async function workspaceContext(workspaceReference) {
  const registry = workspaceRegistryFile();
  if (workspaceReference) return buildWorkspaceContext(registry, workspaceReference);
  const active = await readActiveWorkspaceContext(activeWorkspaceFile(), registry, { refresh: true });
  if (!active) throw new SingularityFlowError(
    "No workspace is active. Select one with 'singularity-flow workspace use <WORKSPACE>' first."
  );
  return active;
}

async function recordsForRepository(repository, actor) {
  if (repository.state !== 'ready') return { items: [], warning: `${repository.id} is ${repository.state}.` };
  try {
    const index = await buildRepositorySubjectIndex(repository.absolutePath);
    const pending = new Set();
    for (const subject of index.list('story')) {
      const marker = await readPendingPublication(repository.absolutePath, {
        kind: 'story', id: subject.id, migrate: false
      }).catch(() => null);
      if (marker) pending.add(subject.id);
    }
    const records = await workRecords(repository.absolutePath, {
      actor, pendingPublications: pending, includeCompleted: true
    });
    return {
      ...records,
      items: records.items.map((item) => ({ ...item, repositoryId: repository.id }))
    };
  } catch (error) {
    return { items: [], warning: `${repository.id}: ${String(error.message).replaceAll(repository.absolutePath, '<repository>')}` };
  }
}

/**
 * Which repository the home is about, and where it is on disk.
 *
 * Exported because the projection deliberately does *not* carry an absolute path — `[UXH:REQ-065]`
 * forbids unrestricted filesystem paths in anything rendered — and the gateway binding needs one.
 * A caller that needed both would otherwise re-derive the root from the working directory, which is
 * the bug where the home describes one workspace and the kernel binds to another.
 */
export async function homeRepository(workspaceReference = null) {
  const context = await workspaceContext(workspaceReference);
  const status = await workspaceStatus(context.workspacePath);
  const selected = status.repositories.find((item) => item.id === context.repositoryId)
    ?? status.repositories.find((item) => item.id === status.workspace.leadRepository)
    ?? status.repositories[0];
  if (!selected) throw new SingularityFlowError(`Workspace '${context.workspaceId}' has no repositories.`);
  return { context, status, selected, root: selected.absolutePath ?? null };
}

export async function developerHome({ workspaceReference = null, hostSession = null } = {}) {
  const now = new Date().toISOString();
  const { context, status, selected: selectedRepository } = await homeRepository(workspaceReference);
  const actor = selectedRepository.state === 'ready'
    ? identity(selectedRepository.absolutePath, { offline: true })
    : { name: process.env.USER ?? process.env.USERNAME ?? 'unknown-user', email: null, login: null };
  const collected = await Promise.all(status.repositories.map((repository) => recordsForRepository(repository, actor)));
  const items = collected.flatMap((entry) => entry.items ?? []);
  const warnings = [
    ...(status.warnings ?? []).map((warning) => {
      let message = String(warning.message).replaceAll(context.workspacePath, '<workspace>');
      for (const repository of status.repositories) {
        if (repository.absolutePath) message = message.replaceAll(repository.absolutePath, `<repository:${repository.id}>`);
      }
      return message;
    }),
    ...collected.map((entry) => entry.warning).filter(Boolean)
  ];
  const groups = Object.fromEntries(WORK_GROUP_ORDER.map((group) => [
    group,
    items.filter((item) => item.group === group).sort((left, right) =>
      (right.lastMaterialEvent?.at ?? '').localeCompare(left.lastMaterialEvent?.at ?? '') || left.id.localeCompare(right.id))
  ]));
  const active = context.storyId
    ? items.find((item) => item.id === context.storyId) ?? null
    : items.find((item) => item.repositoryId === selectedRepository.id && item.branch === selectedRepository.branch) ?? null;
  const revision = repositoryRevision(selectedRepository, active?.id ?? context.storyId ?? null);
  const subjectRevision = digest({
    actionRegistry: ACTION_REGISTRY_VERSION,
    actor: actorKey(actor), workspace: context.workspaceId, repository: revision,
    records: items.map((item) => [item.repositoryId, item.id, item.phase, item.status, item.lastMaterialEvent?.at])
  });
  const ordered = [
    ...groups['recovery-required'],
    ...(active ? [active] : groups.active.filter((item) => item.repositoryId === selectedRepository.id)),
    ...groups['waiting-on-you'],
    ...groups['waiting-on-others'],
    ...groups.active.filter((item) => item.id !== active?.id),
    ...groups['recently-completed']
  ];
  const seen = new Set();
  const choices = [];
  for (const item of ordered) {
    const key = `${item.repositoryId}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(workChoice(item));
  }
  if (choices.length < MAX_CHOICES) choices.push({
    id: 'work:list', operation: 'work.list', label: 'Open my work',
    goalId: 'inspect-governed-work', target: { workspaceId: context.workspaceId },
    detail: `${items.length} visible governed work item(s)`, reasonCode: 'work.inventory',
    fallbackCommand: 'singularity-flow inbox', navigationTarget: 'inbox'
  });
  if (!active && choices.length < MAX_CHOICES) choices.push({
    id: 'work:start', operation: 'work.start.intake', label: 'Start Story intake',
    goalId: 'start-governed-story', target: { repositoryId: selectedRepository.id },
    detail: 'Create or attach governed work', reasonCode: 'work.no-active-story',
    fallbackCommand: 'singularity-flow start <WORK-ID>', navigationTarget: 'lifecycle'
  });
  if (choices.length < MAX_CHOICES) choices.push({
    id: 'workspace:switch', operation: 'workspace.switch', label: 'Switch workspace',
    goalId: 'switch-workspace', target: { workspaceId: context.workspaceId },
    detail: `Currently ${context.workspaceName}`, reasonCode: 'workspace.available',
    fallbackCommand: 'singularity-flow workspace list', navigationTarget: 'workspaces'
  });
  if (choices.length < MAX_CHOICES) choices.push({
    id: 'context:explain', operation: 'context.explain', label: 'Explain this context',
    goalId: 'understand-current-context', target: { workspaceId: context.workspaceId, repositoryId: selectedRepository.id },
    detail: 'Show what SFlow selected and why', reasonCode: 'context.inspect',
    fallbackCommand: 'singularity-flow home', navigationTarget: 'lifecycle'
  });
  const headline = active
    ? `${active.id} is in ${active.phaseLabel ?? active.phase ?? 'its workflow'} (${active.status ?? 'active'}).`
    : `${context.workspaceName} has ${items.filter((item) => item.group !== 'recently-completed').length} active governed work item(s).`;
  return {
    schemaVersion: 1,
    resultType: 'developer-home',
    asOf: now,
    actor,
    context: {
      workspace: { id: context.workspaceId, name: context.workspaceName },
      repository: revision,
      activeStory: active ? { id: active.id, phase: active.phase, status: active.status } : null,
      freshness: { capturedAt: now, networkContacted: false, source: 'local-workspace' }
    },
    briefing: { kind: 'current-state', headline, counts: Object.fromEntries(WORK_GROUP_ORDER.map((key) => [key, groups[key].length])) },
    primaryChoiceId: choices[0]?.id ?? null,
    choices: bindDeveloperHomeChoices(choices, { subjectRevision, actor, hostSession, now }),
    notices: warnings,
    subjectRevision,
    sources: status.repositories.map((repository) => ({ id: repository.id, state: repository.state }))
  };
}

export async function developerReturn({ workId = null, root = null, hostSession = null } = {}) {
  const now = new Date().toISOString();
  const repository = root ?? repoRoot();
  const currentBranch = branch(repository);
  const index = await buildRepositorySubjectIndex(repository);
  const selected = resolveContext(index, {
    reference: workId ?? currentBranch,
    kind: 'story',
    required: true
  });
  const workflow = selected.state;
  const actor = identity(repository, { offline: true });
  const pending = await readPendingPublication(repository, {
    kind: 'story', id: selected.id, migrate: false
  }).catch(() => null);
  const lifecycle = phaseSummary(workflow);
  const dirtyText = changes(repository);
  const revision = {
    repositoryId: null,
    branch: currentBranch,
    head: head(repository),
    storyId: selected.id,
    worktreeHash: digest(dirtyText),
    dirty: Boolean(dirtyText.trim()),
    changedFiles: boundedChangedFiles(repository, dirtyText)
  };
  const current = lifecycle.phases.find((phase) => phase.id === lifecycle.currentPhase) ?? null;
  const subjectRevision = digest({
    actionRegistry: ACTION_REGISTRY_VERSION,
    actor: actorKey(actor), repository: revision,
    workflow: workflow.revision ?? workflow.updatedAt ?? null,
    resolution: workflow.resolution ?? null,
    lifecycle
  });
  const choices = [];
  if (pending) choices.push({
    id: `recover:${selected.id}`, operation: 'work.continue', label: 'Recover pending publication',
    goalId: 'recover-publication', target: { workId: selected.id, phase: lifecycle.currentPhase },
    detail: `${selected.id} has an unpublished lifecycle transaction`, workId: selected.id, phase: lifecycle.currentPhase,
    reasonCode: 'recovery.resume-publication', fallbackCommand: 'singularity-flow recover', navigationTarget: 'lifecycle'
  });
  else if (current?.status === 'awaiting_approval') choices.push({
    id: `review:${selected.id}`, operation: 'review.packet', label: `Review ${current.label}`,
    goalId: 'review-governed-work', target: { workId: selected.id, phase: current.id },
    detail: `${selected.id} is awaiting approval`, workId: selected.id, phase: current.id,
    reasonCode: 'approval.open-the-packet', fallbackCommand: `singularity-flow review ${current.id}`, navigationTarget: 'approvals'
  });
  else if (current) choices.push({
    id: `continue:${selected.id}`, operation: 'work.continue', label: `Continue ${current.label}`,
    goalId: 'continue-governed-work', target: { workId: selected.id, phase: current.id },
    detail: `${current.status} · generation ${current.generation}`, workId: selected.id, phase: current.id,
    reasonCode: 'work.resume-phase', fallbackCommand: `singularity-flow nextsteps`, navigationTarget: 'lifecycle'
  });
  choices.push({
    id: `status:${selected.id}`, operation: 'work.readiness', label: 'Open lifecycle status',
    goalId: 'inspect-work-readiness', target: { workId: selected.id, phase: lifecycle.currentPhase },
    detail: `${lifecycle.approved}/${lifecycle.total} phases approved`, workId: selected.id, phase: lifecycle.currentPhase,
    reasonCode: 'work.check-readiness', fallbackCommand: `singularity-flow story return ${selected.id}`, navigationTarget: 'lifecycle'
  });
  return {
    schemaVersion: 1,
    resultType: 'developer-return',
    asOf: now,
    actor,
    context: {
      repository: revision,
      story: {
        id: selected.id,
        title: workflow.workItem?.title ?? selected.id,
        canonicalBranch: selected.canonicalBranch ?? null
      },
      freshness: { capturedAt: now, networkContacted: false, source: resolutionSource(selected.location) }
    },
    briefing: {
      headline: lifecycle.currentPhase
        ? `${selected.id} returns to ${current?.label ?? lifecycle.currentPhase} (${current?.status ?? 'active'}).`
        : `${selected.id} is complete.`,
      lifecycle,
      pinned: {
        configurationSha256: workflow.resolution?.configSha256 ?? workflow.resolution?.configurationSha256 ?? null,
        specificationGeneration: workflow.resolution?.specificationGeneration ?? null,
        planRevision: workflow.resolution?.planRevision ?? null
      },
      git: revision,
      interval: workflow.workIntervals?.current ?? null,
      recovery: pending ? { required: true, kind: pending.kind ?? 'pending-publication' } : { required: false },
      evidenceGaps: current?.artifacts?.length ? [] : (current ? ['current-phase-has-no-registered-artifacts'] : [])
    },
    choices: bindDeveloperHomeChoices(choices, { subjectRevision, actor, hostSession, now }),
    notices: [],
    subjectRevision
  };
}

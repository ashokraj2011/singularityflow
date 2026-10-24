/**
 * `work.start` and `work.draft.save`: the exact governed creation a person confirms. `[INT:CON-064]` `[INT:CON-066]`
 *
 * Conversation never creates work. A host collects the intake in its own form, hands the typed
 * record to `kernel.recordIntake`, and gets back an intake ID that lives only in this host session
 * `[INT:CON-065]`. Resolving `work.start` with that ID runs this planner, which is a read: it checks
 * the record against the repository's own workflow — the work type must be one it declares, the
 * work ID must not already be visible work, the branch is rendered by the configured naming rule —
 * and returns the exact normalized subject, repository, profile, external references and effects.
 * That preview is what the kernel signs and what an exact confirmation is bound to.
 *
 * The act itself is not here. It routes through the existing `start` operation — branch and
 * lifecycle initialization, configuration pinning, the publication transaction — by way of the
 * argv `workStartArguments` derives from the reviewed preview and nothing else, so a host's
 * executor cannot start something other than what was confirmed `[INT:CON-066]`.
 */
import { randomUUID } from 'node:crypto';

import { SingularityFlowError } from '../../util.mjs';
import { gatewayStoreEntries, updateGatewayStore } from '../local-store.mjs';
import { planDescriptor, plannerActor } from '../plan-descriptor.mjs';
import { effects, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';

/** The only shape a gateway can start in this build; the others stay on their explicit commands. */
export const GATEWAY_STARTABLE_SHAPES = Object.freeze(['story']);

function intakeOf(session, intakeId) {
  const intake = session?.intake?.(intakeId) ?? null;
  if (!intake) {
    throw new SingularityFlowError(`Intake '${intakeId}' is not part of this session; collect it again.`, {
      code: 'WORK_INTAKE_UNKNOWN'
    });
  }
  return intake;
}

/** What starting changes, every time: it is a governed creation with a publication. */
export const WORK_START_EFFECTS = Object.freeze({
  stateChanged: true, filesChanged: true, gitRefsChanged: true, publicationCreated: true, externalSystemsChanged: true
});

/** Fields of the work-type declaration a reader needs to weigh the choice `[INT:REQ-068]`. */
export function workTypeChoices(definition) {
  return Object.entries(definition?.workTypes ?? {}).slice(0, 12).map(([id, type]) => ({
    id, label: type.label ?? id, phases: [...(type.phases ?? [])]
  }));
}

export async function workStartPlan({ arguments: args = {}, root = null, context = {}, session = null } = {}) {
  const intake = intakeOf(session, args.intakeId);
  if (!GATEWAY_STARTABLE_SHAPES.includes(intake.shape ?? 'story')) {
    throw new SingularityFlowError(`Starting a${intake.shape === 'initiative' ? 'n' : ''} ${intake.shape} stays on its explicit command.`, {
      code: 'WORK_START_SHAPE_EXPLICIT_ONLY', details: { nextAction: `sflow ${intake.shape} start` }
    });
  }
  if (!root) throw new SingularityFlowError('Starting work needs the repository it starts in.', { code: 'WORK_START_NO_ROOT' });
  const [{ loadDefinition }, { renderStoryBranchName }] = await Promise.all([
    import('../../config.mjs'), import('../../story-branch-name.mjs')
  ]);
  const definition = await loadDefinition(root);
  const choices = workTypeChoices(definition);
  const workType = choices.find((choice) => choice.id === intake.workType);
  if (!workType) {
    throw new SingularityFlowError(`'${intake.workType}' is not a work type this repository declares.`, {
      code: 'WORK_TYPE_UNKNOWN', details: { known: choices.map((choice) => choice.id) }
    });
  }
  const records = await workRecords(root, { includeCompleted: true, ...context, definition });
  if (resolveWorkRecord(records, { workId: intake.workId })) {
    throw new SingularityFlowError(`'${intake.workId}' is already visible work; continue it instead.`, {
      code: 'WORK_ALREADY_STARTED', details: { nextAction: `sflow status --work-id ${intake.workId}` }
    });
  }
  const tracker = intake.tracker ?? 'none';
  if (tracker === 'none' && (!intake.title || !intake.description)) {
    throw new SingularityFlowError('Untracked work needs a title and a description.', { code: 'WORK_INTAKE_INCOMPLETE' });
  }
  if (tracker === 'github' && !intake.trackerKey) {
    throw new SingularityFlowError('GitHub-tracked work needs the issue reference.', { code: 'WORK_INTAKE_INCOMPLETE' });
  }
  const branch = renderStoryBranchName(definition.git?.branchNaming?.pattern, { id: intake.workId, title: intake.title ?? null });
  const preview = {
    action: 'start-work',
    subject: { kind: 'story', id: intake.workId, title: intake.title ?? null },
    workspace: context.workspace?.id ?? null,
    repository: context.repositoryId ?? root,
    workProfile: { workType: workType.id, label: workType.label, phases: workType.phases },
    branch: { name: branch, base: intake.baseBranch ?? null, isolatedWorktree: true },
    source: tracker === 'none'
      ? { tracker: 'none', description: intake.description, acceptanceCriteria: intake.acceptanceCriteria ?? null }
      : { tracker, key: tracker === 'jira' ? intake.workId : intake.trackerKey },
    // `[INT:REQ-069]`: the systems this act leaves alone are part of what is confirmed.
    unchanged: ['other Stories', 'approvals', 'the developer working tree'],
    externalReferences: tracker === 'none' ? [] : [{ tracker, key: tracker === 'jira' ? intake.workId : intake.trackerKey, access: 'read' }]
  };
  return planDescriptor({
    effects: WORK_START_EFFECTS,
    idempotencyKey: `work.start:${preview.repository}:${intake.workId}`,
    externalTargets: [{ kind: 'git-remote', purpose: 'publish the Story branch' },
      ...preview.externalReferences.map((reference) => ({ kind: reference.tracker, purpose: 'read the tracked item' }))],
    preview
  });
}

/**
 * The `start` argv for a reviewed preview — derived from the preview alone. `[INT:CON-066]`
 *
 * Every value comes from the signed preview, so a host executor that builds its command here starts
 * exactly what was confirmed. The branch is passed explicitly because the preview already rendered
 * the configured naming rule; letting `start` render it again is a second answer to one question.
 */
export function workStartArguments(preview) {
  const source = preview.source;
  return [
    'start', preview.subject.id, '--json', '--fetch',
    ...(source.tracker === 'jira' ? ['--jira'] : []),
    ...(source.tracker === 'github' ? ['--github', source.key] : []),
    ...(source.tracker === 'none' ? ['--title', preview.subject.title, '--description', source.description] : []),
    ...(source.tracker === 'none' && source.acceptanceCriteria ? ['--acceptance-criteria', source.acceptanceCriteria] : []),
    '--work-type', preview.workProfile.workType,
    '--isolated-worktree',
    '--ref', preview.branch.name,
    ...(preview.branch.base ? ['--from-branch', preview.branch.base] : [])
  ];
}

/** `work.draft.save`: keep an intake for later, locally, as a proposal and never as an input. */
export async function workDraftSavePlan({ arguments: args = {}, context = {}, session = null } = {}) {
  const actorId = plannerActor(context);
  if (!actorId) throw new SingularityFlowError('A draft needs the actor it belongs to.', { code: 'WORK_DRAFT_NO_ACTOR' });
  const intake = intakeOf(session, args.intakeId);
  return planDescriptor({
    effects: { contextChanged: true },
    idempotencyKey: `work.draft.save:${actorId}:${args.intakeId}`,
    preview: { action: 'save-draft', label: args.label, intake, store: 'machine-local', approvedInput: false }
  });
}

export async function workDraftSaveExecute({ plan, context = {}, env = process.env } = {}) {
  const actorId = plannerActor(context);
  const { label, intake } = plan.review.preview;
  const entry = { id: `drf_${randomUUID().replaceAll('-', '').slice(0, 16)}`, actorId, label, intake, savedAt: new Date().toISOString() };
  await updateGatewayStore('drafts', (entries) => [...entries, entry], { env });
  return sflowResult({
    kind: 'read',
    operation: { id: 'work.draft.save', classification: 'mutation' },
    outcome: { status: 'succeeded', messageId: 'gateway.completed', slots: { draft: entry.id } },
    effects: effects({ contextChanged: true }),
    why: [{ code: 'work.draft-saved-locally', source: 'deterministic', slots: { draft: entry.id } }],
    preserved: [{ code: 'work.no-governed-record-created', source: 'deterministic', scope: 'stateChanged' }],
    restState: 'complete',
    data: { draft: { id: entry.id, label, savedAt: entry.savedAt } }
  });
}

export async function workDrafts(actorId, { env = process.env } = {}) {
  return gatewayStoreEntries('drafts', actorId, { env });
}

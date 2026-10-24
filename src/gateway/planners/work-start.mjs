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
import { effects, noEffects, plannerNavigation, preservedAll, repositoryReference, sflowResult } from '../result.mjs';
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

/**
 * What starting changes, every time: a governed creation with a publication. The push is the
 * publication, so it is `publicationCreated`; a tracker is only read, so nothing external changes.
 */
export const WORK_START_EFFECTS = Object.freeze({
  stateChanged: true, filesChanged: true, gitRefsChanged: true, publicationCreated: true, externalSystemsChanged: false
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
    repository: context.repositoryId ?? repositoryReference(root),
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
 *
 * Every value travels inside its own option as `--name=value`. Passed as the next argv item, a value
 * that starts with `--` is read as a new option, so a title of `--from-branch=evil` was shown as a
 * title and started as a base branch. Joined, a value can only ever be that option's.
 */
export function workStartArguments(preview) {
  const source = preview.source;
  const option = (name, value) => `--${name}=${value}`;
  return [
    'start', preview.subject.id, '--json', '--fetch',
    ...(source.tracker === 'jira' ? ['--jira'] : []),
    ...(source.tracker === 'github' ? [option('github', source.key)] : []),
    ...(source.tracker === 'none' ? [option('title', preview.subject.title), option('description', source.description)] : []),
    ...(source.tracker === 'none' && source.acceptanceCriteria ? [option('acceptance-criteria', source.acceptanceCriteria)] : []),
    option('work-type', preview.workProfile.workType),
    '--isolated-worktree',
    option('ref', preview.branch.name),
    ...(preview.branch.base ? [option('from-branch', preview.branch.base)] : [])
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

// ---------------------------------------------------------------------------------------------------
// Execution: the existing `start` operation, reached unchanged. `[INT:CON-066]` `[INT:CON-115]`
// ---------------------------------------------------------------------------------------------------

async function pendingPublication(root, workId) {
  const { inspectPendingPublication } = await import('../../publication-pending.mjs');
  const found = await inspectPendingPublication(root, { kind: 'story', id: workId }).catch(() => null);
  return found && found.status !== 'absent' ? { status: found.status, path: found.path ?? null } : null;
}

/**
 * The interrupted publication, first. `[INT:REQ-156]` `[INT:CON-115]`
 *
 * Whatever else could be said next, the reader's work is committed locally and not yet published,
 * and the record that lets it be finished is intact. So that record leads, its recovery is the one
 * primary action, and the effects say exactly what landed: the local commit and branch, not the
 * publication.
 */
function publicationRecoveryResult(workId, pending, { before = false } = {}) {
  return sflowResult({
    kind: before ? 'refusal' : 'read',
    operation: { id: 'work.start', classification: 'mutation' },
    subject: { kind: 'story', id: workId },
    outcome: { status: before ? 'refused' : 'failed', messageId: 'gateway.refused', slots: { work: workId } },
    effects: before ? noEffects() : effects({ stateChanged: true, filesChanged: true, gitRefsChanged: true }),
    why: [{ code: 'publication.pending', source: 'lifecycle', reference: pending.path, slots: { work: workId, status: pending.status } }],
    preserved: before
      ? preservedAll('work.start-recovery-record-kept', { reference: pending.path })
      : [{ code: 'work.start-recovery-record-kept', source: 'lifecycle', scope: 'publicationCreated', reference: pending.path }],
    next: [plannerNavigation({
      handle: `recover:publication:${workId}`, id: 'recover:publication', label: 'Finish the interrupted publication',
      rank: 0, kind: 'read', reasonCode: 'recovery.resume-publication', confirmation: 'none', interaction: 'recovery',
      emphasis: 'primary', executable: false,
      fallback: { label: 'Finish it in the terminal', command: `sflow sync ${workId}` }
    }, 'work.continue', { workId })],
    data: { workId, recovery: { record: pending.path, status: pending.status, command: `sflow sync ${workId}` } }
  });
}

/**
 * A start stopped before it reported — killed on its timeout, or by a signal. `[INT:CON-115]`
 *
 * Nothing says how far it got: the branch, the work record, the worktree and the publication may
 * each exist or not. So this is never "no work was created"; it names what may exist, declares the
 * previewed effects as possible, and points at the two commands that tell which.
 */
function startOutcomeUnknown(workId, preview) {
  const check = [`sflow status --work-id ${workId}`, `sflow sync ${workId}`];
  return sflowResult({
    kind: 'read',
    operation: { id: 'work.start', classification: 'mutation' },
    subject: { kind: 'story', id: workId },
    outcome: { status: 'failed', messageId: 'gateway.refused', slots: { work: workId } },
    effects: effects({ stateChanged: true, filesChanged: true, gitRefsChanged: true, publicationCreated: true }),
    why: [{ code: 'work.start-outcome-unknown', source: 'lifecycle', slots: { work: workId } }],
    preserved: [{ code: 'work.tracker-only-read', source: 'lifecycle', scope: 'externalSystemsChanged' }],
    next: [plannerNavigation({
      handle: `unknown:${workId}`, id: 'start-unknown:check', label: `Check what exists for ${workId}`, rank: 0, kind: 'read',
      reasonCode: 'work.start-outcome-unknown', confirmation: 'none', interaction: 'recovery', emphasis: 'primary', executable: false,
      fallback: { label: 'Check it in the terminal', command: check[0] }
    }, 'work.continue', { workId })],
    data: {
      workId,
      outcome: 'unknown',
      mayHaveCreated: [`the Story branch ${preview.branch.name}`, `the work record for ${workId}`, 'its isolated worktree', 'its publication to the remote'],
      check
    }
  });
}

/** v1 `start` effects, in the v2 vocabulary: a branch is created whenever state is. */
function startEffects(reported = {}) {
  return effects({
    stateChanged: Boolean(reported.stateChanged),
    filesChanged: Boolean(reported.filesChanged),
    gitRefsChanged: Boolean(reported.stateChanged || reported.publicationCreated),
    publicationCreated: Boolean(reported.publicationCreated),
    externalSystemsChanged: Boolean(reported.externalSystemsChanged)
  });
}

/**
 * The work.start executor, for a host that can run the `start` operation.
 *
 * `runStart(argv, { cwd })` is the host's own route to the CLI — a child process here, the editor's
 * CLI client there — and returns `{ status, json }`. The argv comes from the signed preview alone.
 * Before anything runs, a competing pending publication for the same work is the answer
 * `[INT:REQ-036]`; after a failure, a pending publication record is preserved and leads.
 */
export function workStartExecutor({ runStart }) {
  if (typeof runStart !== 'function') throw new TypeError('A work.start executor needs the host route to start.');
  return async ({ plan, root }) => {
    const preview = plan.review.preview;
    const workId = preview.subject.id;
    const competing = await pendingPublication(root, workId);
    if (competing) return publicationRecoveryResult(workId, competing, { before: true });
    const ran = await runStart(workStartArguments(preview), { cwd: root });
    const reported = ran?.json ?? null;
    if (ran?.status === 0 && reported?.resultType === 'command-result' && reported.outcome?.status === 'succeeded') {
      const data = reported.data ?? {};
      return sflowResult({
        kind: 'read',
        operation: { id: 'work.start', classification: 'mutation' },
        subject: { kind: 'story', id: workId, revision: { sourceCommit: data.publication?.commit ?? null } },
        outcome: { status: 'succeeded', messageId: 'gateway.completed', slots: { work: workId, phase: data.currentPhase ?? 'none' } },
        effects: startEffects(reported.effects),
        why: [{ code: 'work.started', source: 'lifecycle', reference: data.publication?.commit ?? null, slots: { work: workId } }],
        next: [plannerNavigation({
          handle: `started:${workId}`, id: 'started:continue', label: `Continue ${workId}`, rank: 0, kind: 'read',
          reasonCode: 'work.started', confirmation: 'none', interaction: 'navigation', emphasis: 'primary', executable: false,
          fallback: { label: 'See the work', command: `sflow status --work-id ${workId}` }
        }, 'work.continue', { workId })],
        // `[INT:REQ-069]`: what was created, where, pinned to what, and what was left alone.
        data: {
          workId,
          workspace: preview.workspace,
          repositories: [preview.repository],
          branch: data.publication?.branch ?? preview.branch.name,
          base: data.base ?? null,
          pinnedProfile: { workType: data.workType ?? preview.workProfile.workType, phase: data.currentPhase ?? null },
          createdRecords: [data.returnLocator?.path, data.testPolicy?.path].filter(Boolean),
          publication: data.publication ?? null,
          worktree: { isolated: Boolean(data.worktree?.isolated) },
          unchangedSystems: preview.unchanged,
          nextVerb: 'continue'
        }
      });
    }
    const pending = await pendingPublication(root, workId);
    if (pending) return publicationRecoveryResult(workId, pending);
    if (ran?.timedOut || ran?.signal) return startOutcomeUnknown(workId, preview);
    // A refusal from `start` is a refusal here; it declares no effects in its own contract too.
    const code = String(reported?.error?.code ?? 'WORK_START_FAILED').slice(0, 128);
    return sflowResult({
      kind: 'refusal',
      operation: { id: 'work.start', classification: 'mutation' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { work: workId, code } },
      effects: noEffects(),
      why: [{ code: 'work.start-refused', source: 'lifecycle', slots: { code } }],
      preserved: preservedAll('work.no-governed-record-created', { reference: workId }),
      restState: 'blocked',
      data: { workId, remediation: (reported?.remediationPlan?.steps ?? []).slice(0, 5).map((step) => step.command).filter(Boolean) }
    });
  };
}

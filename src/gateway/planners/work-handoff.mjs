/**
 * `work.handoff`: reconstruct a bounded handoff from governed records.
 *
 * A handoff is deliberately a projection, not a new lifecycle record and not a summary of the
 * conversation that happened to precede it. Unknown sections remain explicitly unknown. Local
 * changes are read only when the caller asks for them, because a handoff must not make an
 * undisclosed repository scan look like evidence it collected.
 */
import { head } from '../../git.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { handoffPacket } from '../journey-contracts.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, plannerNavigation, preservedAll, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';
import { localChangesFor } from './work-continue.mjs';

function notFound(workId) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'work.handoff', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId } },
    effects: noEffects(),
    why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', slots: { workId } }],
    preserved: preservedAll('work.nothing-was-carried-out', { reference: workId }),
    restState: 'blocked'
  });
}

function headOf(root) {
  try {
    return head(root) ?? null;
  } catch {
    return null;
  }
}

function localEvidence(localChanges, included) {
  if (!included) return Object.freeze({ state: 'not-read', reason: 'not-requested' });
  if (!localChanges) return Object.freeze({ state: 'unavailable', reason: 'git-did-not-answer' });
  return Object.freeze({ state: 'read', ...localChanges });
}

export function workHandoffResult(item, {
  subject = null,
  includeLocalChanges = false,
  localChanges = null,
  sourceCommit = null
} = {}) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(String(sourceCommit ?? ''))) {
    throw new SingularityFlowError('A handoff packet requires the exact source commit it describes.', {
      code: 'WORK_HANDOFF_REVISION_MISSING', details: { workId: item?.id ?? null }
    });
  }

  const local = localEvidence(localChanges, includeLocalChanges);
  const matchingSubject = subject?.id === item.id && (!subject.kind || subject.kind === item.kind)
    ? subject
    : null;
  const resultSubject = subjectWith(matchingSubject, {
    kind: item.kind,
    id: item.id,
    revision: {
      sourceCommit,
      worktreeHash: includeLocalChanges ? localChanges?.worktreeHash ?? null : null,
      worktreeAlgorithm: includeLocalChanges ? localChanges?.worktreeAlgorithm ?? null : null
    }
  });
  const completed = (item.rail ?? []).filter((phase) => phase.state === 'done');
  const remaining = (item.rail ?? []).filter((phase) => phase.state !== 'done');
  const packet = handoffPacket({
    approvedIntent: {
      state: 'reference-only',
      approvedContentRead: false,
      work: { id: item.id, kind: item.kind, title: item.title },
      source: 'governed-record'
    },
    currentPhase: {
      id: item.phase,
      label: item.phaseLabel ?? item.phase,
      status: item.status,
      generation: item.generation,
      rail: item.rail ?? []
    },
    legalNextAction: item.nextAction ?? null,
    revisions: {
      sourceCommit,
      lifecycleHash: resultSubject.revision.lifecycleHash,
      ...(includeLocalChanges && localChanges?.worktreeHash
        ? {
          worktreeHash: localChanges.worktreeHash,
          worktreeAlgorithm: localChanges.worktreeAlgorithm ?? null
        }
        : {})
    },
    completedWork: completed,
    remainingWork: remaining,
    localChanges: local,
    tests: { state: 'not-read' },
    evidence: {
      state: item.lastMaterialEvent ? 'recorded' : 'not-found',
      lastMaterialEvent: item.lastMaterialEvent ?? null,
      recovery: item.recovery ?? null
    },
    openQuestions: { state: 'not-read' },
    risks: { state: 'read', blockers: item.blockers ?? [] },
    reconstruction: {
      source: 'governed-records',
      conversationUsed: false,
      generatedAt: null
    }
  });

  return sflowResult({
    kind: 'read',
    operation: { id: 'work.handoff', classification: 'read' },
    subject: resultSubject,
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.read',
      slots: { work: item.id, phase: item.phase ?? 'none' }
    },
    effects: noEffects(),
    why: [{
      code: 'work.reconstructed-from-records',
      source: 'lifecycle',
      reference: item.id,
      slots: { phase: item.phase ?? 'none', generation: String(item.generation ?? 0) }
    }],
    warnings: !includeLocalChanges || !localChanges
      ? [{ code: 'return.local-changes-unread', source: 'unavailable', slots: {} }]
      : [],
    next: [plannerNavigation({
      handle: `handoff:${item.id}:continue`,
      id: `handoff:${item.id}:continue`,
      label: 'Open current work',
      rank: 0,
      kind: 'read',
      reasonCode: 'work.legal-now',
      confirmation: 'none',
      interaction: 'navigation',
      emphasis: 'primary',
      executable: false,
      fallback: { label: 'Open current work', command: `sflow status --work-id ${item.id}` }
    }, 'work.continue', { workId: item.id, workKind: item.kind })],
    restState: null,
    data: {
      packet,
      work: item,
      rail: item.rail ?? [],
      localChanges: local
    }
  });
}

export async function workHandoff({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) {
    throw new SingularityFlowError('work.handoff requires the repository root it should read.', {
      code: 'WORK_HANDOFF_NO_ROOT'
    });
  }
  const records = await workRecords(root, { includeCompleted: true, ...context });
  const item = resolveWorkRecord(records, args);
  if (!item) return notFound(args.workId);
  const includeLocalChanges = args.includeLocalChanges === true;
  const sourceCommit = context.sourceCommit ?? headOf(root);
  if (!sourceCommit) {
    return sflowResult({
      kind: 'refusal',
      operation: { id: 'work.handoff', classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId: item.id } },
      effects: noEffects(),
      why: [{ code: 'work.revision-unavailable', source: 'evidence', slots: { workId: item.id } }],
      preserved: preservedAll('work.nothing-was-carried-out', { reference: item.id }),
      restState: 'blocked'
    });
  }
  return workHandoffResult(item, {
    subject,
    includeLocalChanges,
    localChanges: includeLocalChanges ? (context.localChanges ?? localChangesFor(root)) : null,
    sourceCommit
  });
}

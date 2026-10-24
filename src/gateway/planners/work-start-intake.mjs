/**
 * `work.start.intake`: open the existing governed intake without creating work.
 *
 * Intake is a host form, not a second lifecycle implementation in the gateway. This planner carries
 * only bounded defaults that the resolver validated; the form still reads workflows, remote base
 * branches, authority, and preflight from the engine before enabling Start.
 */
import { noEffects, plannerNavigation, sflowResult } from '../result.mjs';

const SHAPES = new Set(['initiative', 'epic', 'story']);

const RECORD_FIELDS = Object.freeze([
  'workId', 'shape', 'workType', 'tracker', 'trackerKey', 'title', 'description', 'acceptanceCriteria', 'baseBranch', 'source'
]);

/**
 * A complete proposal becomes a session intake and one next step: review the exact start.
 *
 * The model may turn prose into these typed fields `[INT:CON-064]`; what it cannot do is create
 * anything. The record is host-session data until a confirmed plan runs `[INT:CON-065]`, and the
 * only way on from here is the work.start plan, whose exact preview a person confirms out of band.
 */
function recordedIntake(args, session, subject) {
  const fields = Object.fromEntries(RECORD_FIELDS.filter((field) => args[field] !== undefined).map((field) => [field, args[field]]));
  const { intakeId, record, expiresAt } = session.recordIntake(fields);
  return sflowResult({
    kind: 'read',
    operation: { id: 'work.start.intake', classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: { work: record.workId } },
    effects: noEffects(),
    why: [{ code: 'work.intake-recorded', source: 'deterministic', reference: intakeId, slots: { work: record.workId } }],
    next: [plannerNavigation({
      handle: `intake:${intakeId}`, id: 'intake:review-start', label: `Review exactly how ${record.workId} will start`,
      rank: 0, kind: 'plan', reasonCode: 'work.intake-recorded', confirmation: 'exact-confirm', interaction: 'form',
      emphasis: 'primary', executable: false,
      fallback: { label: 'Start in the terminal', command: `sflow start ${record.workId}` }
    }, 'work.start', { intakeId })],
    data: { surface: 'start-intake', intakeId, expiresAt, intake: record }
  });
}

export function workStartIntake({ arguments: args = {}, subject = null, session = null } = {}) {
  if (args.workId && args.workType && typeof session?.recordIntake === 'function') return recordedIntake(args, session, subject);
  const shape = SHAPES.has(args.shape) ? args.shape : null;
  return sflowResult({
    kind: 'clarification',
    operation: { id: 'work.start.intake', classification: 'read' },
    subject,
    outcome: { status: 'succeeded', messageId: 'gateway.clarification', slots: { field: 'work intake' } },
    effects: noEffects(),
    why: [{
      code: 'developer.start-with-intake',
      source: 'deterministic',
      reference: args.workspaceId ?? args.repositoryId ?? null,
      slots: { source: args.source ?? 'manual' }
    }],
    next: [],
    restState: 'informational',
    data: {
      surface: 'start-intake',
      defaults: {
        source: args.source ?? null,
        workspaceId: args.workspaceId ?? null,
        repositoryId: args.repositoryId ?? null,
        shape,
        workType: args.workType ?? null,
        summary: args.summary ?? null
      },
      requiredInputs: [
        'work description',
        ...(shape === 'story' || !shape ? ['definition of done', 'remote base branch'] : ['success outcome'])
      ]
    }
  });
}

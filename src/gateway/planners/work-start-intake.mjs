/**
 * `work.start.intake`: open the existing governed intake without creating work.
 *
 * Intake is a host form, not a second lifecycle implementation in the gateway. This planner carries
 * only bounded defaults that the resolver validated; the form still reads workflows, remote base
 * branches, authority, and preflight from the engine before enabling Start.
 */
import { noEffects, sflowResult } from '../result.mjs';

const SHAPES = new Set(['initiative', 'epic', 'story']);

export function workStartIntake({ arguments: args = {}, subject = null } = {}) {
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

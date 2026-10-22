/**
 * The publication route guidance names for the run's model mode.
 *
 * Its own module so the phase contract (manual-authorship.mjs), which the Copilot edit guard
 * loads on every tool call, stays free of the operation context.
 */
import { operationContext } from './operation-context.mjs';
import {
  effectivePhasePublicationProducer, phasePublicationCommand, phasePublicationCommandForProducer
} from './manual-authorship.mjs';

/**
 * With a model, the configured producer's command. Without one, the producer that can publish
 * without a model, in place (the draft `prepare` wrote) and with --no-model: the same route
 * prepublish offers once the draft is ready. Null when nothing can publish the phase without a
 * model. Guidance that named the configured route regardless had a person record their own
 * writing as governed-agent/copilot-host.
 */
export function phasePublicationCommandForMode(phase, {
  modelEnabled = operationContext()?.modelMode?.enabled !== false, executable = 'singularity-flow'
} = {}) {
  if (modelEnabled) return phasePublicationCommand(phase, executable);
  const producer = effectivePhasePublicationProducer(phase, { modelEnabled: false });
  return producer === 'governed-agent' ? null
    : phasePublicationCommandForProducer(phase, producer, { executable, noModel: true });
}

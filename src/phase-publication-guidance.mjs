/** Host publication command rendering; the SDK returns semantic data. */
import { phasePublicationAuthorship, allowedPublicationProducers } from './kernel/phase-policy.mjs';

/**
 * The complete publication contract consumed by CLI, recovery, prompts, UI actions, and skills.
 * Constructing the contract validates the configured default producer before guidance can escape.
 */
export function phasePublicationContract(phase, {
  producer = null, imported = false, executable = 'singularity-flow'
} = {}) {
  const { producer: selected, channel } = phasePublicationAuthorship(phase, { producer, imported });
  const allowedProducers = Object.freeze([...allowedPublicationProducers(phase)]);
  return Object.freeze({
    producer: selected,
    channel,
    allowedProducers,
    command: `${executable} phase publish ${phase?.id ?? '<phase>'} --authored ${selected} --channel ${channel}`
  });
}

/** One canonical command prevents CLI guidance, recovery, and Copilot skills from drifting. */
export function phasePublicationCommand(phase, executable = 'singularity-flow') {
  return phasePublicationContract(phase, { executable }).command;
}

/** Build a deliberate alternate route only when the phase contract actually permits it. */
export function phasePublicationCommandForProducer(phase, producer, {
  executable = 'singularity-flow', source = null, noModel = false
} = {}) {
  const { channel } = phasePublicationContract(phase, {
    producer, imported: source != null, executable
  });
  return [
    executable, 'phase', 'publish', phase?.id ?? '<phase>', '--authored', producer,
    '--channel', channel,
    ...(source == null ? [] : ['--from', source]),
    ...(noModel ? ['--no-model'] : [])
  ].join(' ');
}

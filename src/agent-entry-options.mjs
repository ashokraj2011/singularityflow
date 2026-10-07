import { SingularityFlowError } from './util.mjs';

/** Reject bypass/ambiguous forms before a compact entry probes Git or a selected workspace. */
export function validateAgentEntryRequest(command, { positionals, options }) {
  const code = `${command.toUpperCase().replaceAll('-', '_')}_OPTIONS_INVALID`;
  const refuse = message => { throw new SingularityFlowError(message, { code }); };
  if (options['for-agent'] !== true || options.json !== true) refuse('--for-agent requires --json; both are boolean flags.');
  if (command === 'review-source') {
    if (positionals[1] !== 'context' || positionals.length > 3) refuse('Compact source review accepts context and one optional active phase only.');
  } else if (positionals.length > 2) refuse(`${command} accepts only one optional identity.`);
  const allowed = new Set(['json', 'for-agent', 'no-model', 'timings', 'timing',
    ...(command === 'inputs' ? ['dry-run'] : [])]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) refuse(`Unsupported ${command} entry option --${key}. Entry cannot bypass or approve a gate.`);
  if (options['dry-run'] !== undefined && typeof options['dry-run'] !== 'boolean') refuse('--dry-run is a boolean flag.');
}

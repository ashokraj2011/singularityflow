import { SingularityFlowError } from './util.mjs';

/** Reject bypass/ambiguous forms before a compact entry probes Git or a selected workspace. */
export function validateAgentEntryRequest(command, { positionals, options }) {
  const code = `${command.toUpperCase().replaceAll('-', '_')}_OPTIONS_INVALID`;
  const refuse = message => { throw new SingularityFlowError(message, { code }); };
  if (options['for-agent'] !== true || options.json !== true) refuse('--for-agent requires --json; both are boolean flags.');
  if (command === 'review-source') {
    if (positionals[1] !== 'context' || positionals.length > 3) refuse(`--for-agent belongs to review-source context, check, status, submit and decision-context${positionals[1] && positionals[1] !== 'context' ? `; run review-source ${positionals[1]} without it` : ', with one optional active phase'}.`);
  } else if (positionals.length > 2) refuse(`${command} accepts only one optional identity.`);
  const allowed = new Set(['json', 'for-agent', 'no-model', 'timings', 'timing',
    ...(command === 'inputs' ? ['dry-run'] : [])]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) refuse(`Unsupported ${command} entry option --${key}. Entry cannot bypass or approve a gate.`);
  if (options['dry-run'] !== undefined && typeof options['dry-run'] !== 'boolean') refuse('--dry-run is a boolean flag.');
}

export function validatePhaseEntryRequest({ positionals, options }) {
  if (positionals.length > 3) throw new SingularityFlowError('phase enter accepts only an optional phase ID.');
  const allowed = new Set(['json', 'for-agent', 'compose', 'work-id', 'no-model', 'timings', 'timing']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new SingularityFlowError(
    `Unsupported phase enter option --${key}. Entry cannot bypass or approve a gate.`, { code: 'PHASE_ENTRY_OPTIONS_INVALID' });
  for (const flag of ['compose', 'for-agent', 'json']) if (options[flag] !== undefined
    && typeof options[flag] !== 'boolean') throw new SingularityFlowError(`--${flag} is a boolean flag.`);
}

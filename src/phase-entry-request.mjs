/** Early syntax checks must not import packet rendering or the authoring graph. */
import { SingularityFlowError } from './util.mjs';

export function validatePhaseEntryRequest({ positionals, options }) {
  if (positionals.length > 3) throw new SingularityFlowError('phase enter accepts only an optional phase ID.');
  const allowed = new Set(['json', 'for-agent', 'compose', 'work-id', 'no-model', 'timings', 'timing']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new SingularityFlowError(
    `Unsupported phase enter option --${key}. Entry cannot bypass or approve a gate.`, { code: 'PHASE_ENTRY_OPTIONS_INVALID' });
  for (const flag of ['compose', 'for-agent', 'json']) if (options[flag] !== undefined
    && typeof options[flag] !== 'boolean') throw new SingularityFlowError(`--${flag} is a boolean flag.`);
}

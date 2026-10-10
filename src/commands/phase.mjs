import { operationContext } from '../operation-context.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { phaseEntryAgentPresentation } from '../agent-packet-presentation.mjs';

export function validatePhaseEntryRequest({ positionals, options }) {
  if (positionals.length > 3) throw new SingularityFlowError('phase enter accepts only an optional phase ID.');
  const allowed = new Set(['json', 'for-agent', 'compose', 'work-id', 'no-model', 'timings', 'timing']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new SingularityFlowError(
    `Unsupported phase enter option --${key}. Entry cannot bypass or approve a gate.`, { code: 'PHASE_ENTRY_OPTIONS_INVALID' });
  for (const flag of ['compose', 'for-agent', 'json']) if (options[flag] !== undefined
    && typeof options[flag] !== 'boolean') throw new SingularityFlowError(`--${flag} is a boolean flag.`);
}

export async function run(argv, { positionals, options }) {
  if (positionals[1] !== 'enter') return (await import('./legacy.mjs')).run(argv);
  validatePhaseEntryRequest({ positionals, options });
  const { enterPhase } = await import('../phase-entry.mjs');
  const result = await enterPhase({ phaseId: positionals[2] ?? null,
    workId: optionString(options, 'work-id'), compose: optionBoolean(options, 'compose'),
    modelEnabled: operationContext()?.modelMode?.enabled !== false });
  const forAgent = optionBoolean(options, 'for-agent');
  console.log(JSON.stringify(forAgent ? phaseEntryAgentPresentation(result) : result, null, forAgent ? undefined : 2));
}

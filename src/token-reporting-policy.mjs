/** Pure reporting preference contract, shared by strict policy and informational reads. */
import { SingularityFlowError } from './util.mjs';

export function validateTokenReportingPolicy(tokens) {
  if (tokens?.mode && tokens.mode !== 'exact-or-unavailable') throw new SingularityFlowError("tokens.mode must be 'exact-or-unavailable'.");
  for (const [model, pricing] of Object.entries(tokens?.pricing ?? {})) {
    if (!model.trim()) throw new SingularityFlowError('tokens.pricing model names must not be empty.');
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw new SingularityFlowError(`Token pricing for '${model}' must be an object.`);
    for (const field of ['input', 'output', 'cachedInput']) {
      if (pricing[field] != null && (!Number.isFinite(pricing[field]) || pricing[field] < 0)) throw new SingularityFlowError(`tokens.pricing.${model}.${field} must be a non-negative number.`);
    }
    if (pricing.input == null && pricing.output == null && pricing.cachedInput == null) throw new SingularityFlowError(`Token pricing for '${model}' must define input, output, or cachedInput.`);
  }
  // Premium-request multipliers are GitHub's per-model rates. They change, so none are bundled.
  const multipliers = tokens?.premiumMultipliers;
  if (multipliers != null && (typeof multipliers !== 'object' || Array.isArray(multipliers))) throw new SingularityFlowError('tokens.premiumMultipliers must map model names to numbers.');
  for (const [model, multiplier] of Object.entries(multipliers ?? {})) {
    if (!model.trim()) throw new SingularityFlowError('tokens.premiumMultipliers model names must not be empty.');
    if (!Number.isFinite(multiplier) || multiplier < 0) throw new SingularityFlowError(`tokens.premiumMultipliers.${model} must be a non-negative number.`);
  }
}

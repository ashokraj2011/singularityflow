/** Keep soft-gate confirmations identical for direct and legacy command services. */
import { optionStrings } from './util.mjs';

export async function withCommandConfirmation(options, invoke) {
  const overrides = new Set(optionStrings(options, 'confirm-override')
    .flatMap(value => String(value).split(',')).map(value => value.trim()).filter(Boolean));
  if (!overrides.size) return invoke();
  const { sequenceConfirmationRequired, withConfirmationPort } = await import('./sequence.mjs');
  return withConfirmationPort((message, gate) => {
    if (overrides.has(`continue:${gate}`)) return true;
    throw sequenceConfirmationRequired(message, gate);
  }, invoke);
}

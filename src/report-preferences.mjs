/** Display pricing is live observation policy, never permission to execute or approve. */
import { readConfigurationSource } from './configuration-source.mjs';
import { validateTokenReportingPolicy } from './token-reporting-policy.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';
import { SingularityFlowError } from './util.mjs';

export function readReportPreferences(root) {
  return measureCommandSpan('report.preferences', async () => {
    const source = await readConfigurationSource(root);
    if (source.error) throw source.error;
    if (!source.workflow.exists) throw new SingularityFlowError('Workflow configuration is unavailable.');
    const tokens = source.parsed?.tokens;
    validateTokenReportingPolicy(tokens);
    return { pricing: tokens?.pricing ?? null, premiumMultipliers: tokens?.premiumMultipliers ?? null };
  });
}

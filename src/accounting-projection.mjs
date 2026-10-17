/** Observation preferences only. This value can never authorize a workflow operation. */
import { readConfigurationSource, configurationSourceBinding } from './configuration-source.mjs';
import { normalizeLogging } from './logging.mjs';
import { normalizeHarnessImports } from './harness-import-policy.mjs';
import { SingularityFlowError } from './util.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';

export async function accountingProjection(root) {
  return measureCommandSpan('accounting.preferences', async () => {
    const source = await readConfigurationSource(root);
    if (source.error) throw source.error;
    if (!source.workflow.exists || !source.parsed || typeof source.parsed !== 'object') {
      throw new SingularityFlowError('Accounting configuration is unavailable.');
    }
    incrementCommandCounter('accounting.projections');
    return Object.freeze({ logging: normalizeLogging(source.parsed.logging ?? {}),
      harnessImports: normalizeHarnessImports(source.parsed.harnessImports), sourceBinding: configurationSourceBinding(root, source) });
  });
}

/** Product-only receipt recovery entered by a full normal source install. */
import { parseArgs, optionString, SingularityFlowError } from '../src/util.mjs';
import { repairMissingInstallationReceipt, upgradeLegacyInstallationReceipt, reinstallPlanText } from '../src/reinstall.mjs';

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const accepted = new Set(['checkout', 'registry', 'skip-tests', 'copilot-telemetry', 'legacy-receipt']);
  const legacy = options['legacy-receipt'] === true;
  if (positionals.length || Object.keys(options).some(key => !accepted.has(key))
      || !optionString(options, 'checkout') || (!legacy && options['skip-tests'] !== true)
      || (options['legacy-receipt'] !== undefined && !legacy)
      || (options['skip-tests'] !== undefined && typeof options['skip-tests'] !== 'boolean')
      || (options['copilot-telemetry'] !== undefined && typeof options['copilot-telemetry'] !== 'boolean')) {
    throw new SingularityFlowError('Missing-receipt repair requires --checkout and explicit --skip-tests.');
  }
  const repair = legacy ? upgradeLegacyInstallationReceipt : repairMissingInstallationReceipt;
  const result = await repair({
    checkout: optionString(options, 'checkout'), registry: optionString(options, 'registry'),
    skipTests: options['skip-tests'] === true, telemetry: options['copilot-telemetry'] !== false
  });
  console.log(reinstallPlanText(result));
  if (legacy) console.log('Installation receipt upgraded from v1 to v2. The exact old receipt is retained with recorded lineage.');
} catch (error) {
  console.error(`Installation receipt repair failed: ${error.message}`);
  process.exitCode = 1;
}

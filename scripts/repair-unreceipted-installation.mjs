/** Product-only missing-receipt repair entered by a full normal source install. */
import { parseArgs, optionString, SingularityFlowError } from '../src/util.mjs';
import { repairMissingInstallationReceipt, reinstallPlanText } from '../src/reinstall.mjs';

try {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const accepted = new Set(['checkout', 'registry', 'skip-tests', 'copilot-telemetry']);
  if (positionals.length || Object.keys(options).some(key => !accepted.has(key))
      || !optionString(options, 'checkout') || options['skip-tests'] !== true
      || (options['copilot-telemetry'] !== undefined && typeof options['copilot-telemetry'] !== 'boolean')) {
    throw new SingularityFlowError('Missing-receipt repair requires --checkout and explicit --skip-tests.');
  }
  const result = await repairMissingInstallationReceipt({
    checkout: optionString(options, 'checkout'), registry: optionString(options, 'registry'),
    skipTests: true, telemetry: options['copilot-telemetry'] !== false
  });
  console.log(reinstallPlanText(result));
} catch (error) {
  console.error(`Installation receipt repair failed: ${error.message}`);
  process.exitCode = 1;
}

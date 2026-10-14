import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { doctorSnapshot, doctorText } from '../doctor.mjs';
import { repoRoot } from '../git.mjs';
import { optionBoolean, optionString, optionStrings } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => doctorCommand(positionals, options)));
}

export async function doctorCommand(positionals, options) {
  if (optionBoolean(options, 'git-speed')) {
    const root = repoRoot();
    const { applyFosGitSpeed, inspectFosGitSpeed } = await import('../fos-git-speed.mjs');
    const report = optionBoolean(options, 'apply')
      ? await applyFosGitSpeed(root, optionStrings(options, 'enable'))
      : inspectFosGitSpeed(root);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Git speed: ${report.status}`);
      const settings = report.report?.settings ?? report.settings ?? {};
      for (const [id, value] of Object.entries(settings)) {
        console.log(`${id}: ${value.value ?? 'unset'} · ${value.compatible ? 'compatible' : 'unsupported'} · ${value.scope}`);
      }
      if (report.receipt) console.log(`Receipt: ${report.receipt.receiptId}`);
    }
    return report;
  }
  if (optionString(options, 'fix') === 'telemetry') {
    const { telemetryCommand } = await import('./telemetry.mjs');
    return telemetryCommand(['telemetry', 'enable'], options);
  }
  const root = repoRoot();
  const inspect = () => doctorSnapshot(root, {
    workId: positionals[1],
    offline: optionBoolean(options, 'offline'),
    performance: optionBoolean(options, 'performance')
  });
  // Performance doctor is explicitly a measurement of the checkout from which it was invoked,
  // including a new repository with no workflow. Routing already excludes the active workspace;
  // configuration overlay resolution must do the same or a missing/stale selection elsewhere on
  // the laptop can fail before the invoking checkout is measured at all.
  const report = optionBoolean(options, 'performance')
    ? await inspect()
    : await withApprovedConfigurationRead(root, inspect);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(doctorText(report));
  if (!report.healthy) process.exitCode = 2;
}

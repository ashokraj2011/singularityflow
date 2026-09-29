/**
 * What a new build does before its first mutation command on this machine, once.
 *
 * It brings every product surface to the installed build, repairs machine-local state through the
 * registered healers, and starts the background pass that opens a review for each registered
 * repository whose approved configuration lags this build. It never fails the command it precedes.
 * The pass is recorded per build, so it runs again only when another build runs. A pass that an
 * install pre-empted is not recorded, so the next mutation tries it again.
 */
import os from 'node:os';
import { startConfigurationReviews } from './configuration-review-pass.mjs';
import { repairLocalState } from './local-state-repair.mjs';
import { alignBeforeFirstMutation, recordBuildPass } from './product-alignment.mjs';
import { foregroundConfigurationRefresh } from './product-alignment-gate.mjs';
import { commandExists, parseArgs, run } from './util.mjs';

function refreshesConfiguration(argv) {
  try {
    const [command, subcommand] = parseArgs(argv ?? []).positionals;
    return foregroundConfigurationRefresh(command, subcommand);
  } catch {
    return false;
  }
}

export async function firstRunPass({
  runningBuild,
  argv,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  write = (line) => process.stderr.write(`${line}\n`),
  repairLocal = repairLocalState,
  startReviews = startConfigurationReviews
} = {}) {
  const product = await alignBeforeFirstMutation({
    runningBuild, argv, execute, exists, homeDirectory, environment, write, record: false
  });
  if (product.status === 'handed-off') return product;
  const healers = await repairLocal({ environment, homeDirectory });
  for (const healer of healers) {
    if (healer.outcome === 'healed') write(`Singularity Flow repaired ${healer.count} item(s) of machine-local state (${healer.id}).`);
    if (healer.outcome === 'failed') write(`Singularity Flow could not repair machine-local state (${healer.id}): ${healer.reason}`);
  }
  if (product.status === 'skipped') return Object.freeze({ status: 'skipped', healers });
  // A foreground refresh is this build's configuration pass: the person is refreshing configuration
  // explicitly, and a background refresh of the same registry beside it would contend for its cache.
  // `singularity-flow product reviews` still runs the shared pass on request.
  const reviews = refreshesConfiguration(argv)
    ? Object.freeze({ status: 'foreground-refresh' })
    : await startReviews({ runningBuild, homeDirectory, environment });
  if (reviews.status === 'started') {
    write('Singularity Flow: checking this build\'s packaged configuration against your registered repositories in the background. `singularity-flow product status` shows any review it opens.');
  }
  await recordBuildPass({
    homeDirectory, runningBuild,
    entry: {
      at: new Date().toISOString(),
      trigger: 'first-mutation',
      outcome: product.status,
      steps: (product.result?.steps ?? []).map((step) => ({ ...step })),
      healers: healers.map(({ receipt, ...rest }) => ({ ...rest, ...(receipt ? { receipt } : {}) })),
      configurationReviews: reviews.status
    }
  }).catch(() => undefined);
  return Object.freeze({ status: product.status, healers, configurationReviews: reviews.status });
}

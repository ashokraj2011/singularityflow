/**
 * What a new build does before its first mutation command on this machine, once.
 *
 * It brings every product surface to the installed build and repairs machine-local state through
 * the registered healers. It never fails the command it precedes. The pass is recorded per build,
 * so it runs again only when another build runs. A pass that an install pre-empted is not
 * recorded, so the next mutation tries it again.
 */
import os from 'node:os';
import { repairLocalState } from './local-state-repair.mjs';
import { alignBeforeFirstMutation, recordBuildPass } from './product-alignment.mjs';
import { commandExists, run } from './util.mjs';

export async function firstRunPass({
  runningBuild,
  argv,
  execute = run,
  exists = commandExists,
  homeDirectory = os.homedir(),
  environment = process.env,
  write = (line) => process.stderr.write(`${line}\n`),
  repairLocal = repairLocalState
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
  await recordBuildPass({
    homeDirectory, runningBuild,
    entry: {
      at: new Date().toISOString(),
      trigger: 'first-mutation',
      outcome: product.status,
      steps: (product.result?.steps ?? []).map((step) => ({ ...step })),
      healers: healers.map(({ receipt, ...rest }) => ({ ...rest, ...(receipt ? { receipt } : {}) }))
    }
  }).catch(() => undefined);
  return Object.freeze({ status: product.status, healers });
}

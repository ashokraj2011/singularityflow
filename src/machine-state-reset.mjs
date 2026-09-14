import path from 'node:path';

export const MACHINE_STATE_REGISTRY_NAMES = [
  'workspaces.json', 'active-workspace.json', 'leads.json'
];

function uniqueResolved(paths) {
  return [...new Set(paths.filter(Boolean).map((value) => path.resolve(value)))].sort();
}

/**
 * Serialize every destructive machine-state reset on a lock outside the directory being reset,
 * then acquire the ordinary inode-bound leases used by registry writers.  The outer lease means
 * two reset variants cannot race even when they were configured with different registry files;
 * the inner leases mean a reset cannot rename registry bytes while a normal writer owns them.
 *
 * The callback receives the live lock pathnames.  Callers that stage the machine-state root must
 * leave those entries in place until the callback returns, otherwise a writer could recreate the
 * original directory and obtain a second, apparently independent lease.
 */
export async function withMachineStateResetBarrier({
  localStateRoot,
  registryFiles = [],
  leaseOptions = {}
}, operation) {
  const root = path.resolve(localStateRoot);
  const defaults = MACHINE_STATE_REGISTRY_NAMES.map((name) => path.join(root, name));
  const files = uniqueResolved([...defaults, ...registryFiles]);
  // This lock must remain outside `root`: destructive reset deliberately stages the contents of
  // `root`, and moving the reset lease with those contents would reopen the race it closes.
  const resetLeaseFile = `${root}.destructive-reset`;
  const { withRegistryFileLease } = await import('./workspace.mjs');
  const acquireRegistries = (index) => index === files.length
    ? operation({
      lockPaths: new Set(files.map((file) => `${file}.lock`)),
      resetLockPath: `${resetLeaseFile}.lock`
    })
    : withRegistryFileLease(files[index], () => acquireRegistries(index + 1), leaseOptions);
  return withRegistryFileLease(resetLeaseFile, () => acquireRegistries(0), leaseOptions);
}

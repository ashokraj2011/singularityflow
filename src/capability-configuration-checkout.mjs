/** Capability mutations own their objects; retained push recovery must never borrow a cache. */
import { prepareConfigurationObjectCheckout } from './configuration-object-store.mjs';
import { run } from './util.mjs';

/**
 * Clone only the configuration authority. Fresh mapping remains shallow. Reviews and remaps
 * reuse exact complete configuration objects in an independent disposable checkout; the lease
 * ends before authoring, so an uncertain push can retain its checkout just as before.
 */
export async function cloneCapabilityConfiguration(scratch, {
  remote, transport, authorityCommit, fullHistory = false,
  cacheRoot = process.cwd(), runRemoteCommand, env = process.env
}) {
  const pool = fullHistory ? await prepareConfigurationObjectCheckout(cacheRoot, scratch, {
    remote, transport, authorityCommit, completeObjects: true, independent: true,
    runRemoteCommand, env
  }) : null;
  if (pool) {
    // --dissociate completed synchronously: this checkout no longer depends on borrowed objects.
    await pool.release({ cleanupConfirmed: true });
    return run('git', ['checkout', '--quiet', 'sflow/config'], {
      cwd: scratch, env: transport.env, timeoutMs: 120_000, maxBuffer: 4 * 1024 * 1024
    });
  }
  return runRemoteCommand([
    'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
    ...(fullHistory ? [] : ['--depth', '1']), '--branch', 'sflow/config', transport.remote, scratch
  ], { operation: 'remote-configuration', env: transport.env });
}

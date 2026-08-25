/**
 * A read-only overlay for approved configuration that is not checked out on the application branch.
 *
 * Application branches intentionally do not carry `singularity/`.  Read-only surfaces still need
 * the approved workflow, prompts and templates from `sflow/config`, while every lifecycle and Git
 * read must continue to target the application checkout.  This request-local mapping is that split.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const scopes = new AsyncLocalStorage();
const RUNTIME_ROOTS = new Set([
  'initiatives', 'work-items', 'seeds', 'world-model', 'knowledge', 'pins',
  'identity-reservations', 'telemetry'
]);

export function isConfigurationReadPath(value) {
  const relative = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!relative || relative.startsWith('/') || relative.includes('\0')
    || path.posix.normalize(relative) !== relative || relative.split('/').includes('..')) return false;
  if (relative === 'singularity/configuration-source.json') return false;
  if (relative === '.github/agents' || relative.startsWith('.github/agents/')) return true;
  if (!relative.startsWith('singularity/')) return false;
  const root = relative.slice('singularity/'.length).split('/')[0];
  return Boolean(root) && !RUNTIME_ROOTS.has(root);
}

export function withConfigurationReadRoot(applicationRoot, configurationRoot, authority, fn) {
  const current = scopes.getStore();
  if (current) return fn();
  return scopes.run({
    applicationRoot: path.resolve(applicationRoot),
    configurationRoot: path.resolve(configurationRoot),
    authority
  }, fn);
}

export function configurationReadRoot(root) {
  const scope = scopes.getStore();
  return scope && path.resolve(root) === scope.applicationRoot
    ? scope.configurationRoot
    : path.resolve(root);
}

export function configurationReadRootForPath(root, relative) {
  return isConfigurationReadPath(relative) ? configurationReadRoot(root) : path.resolve(root);
}

export function configurationReadAuthority(root) {
  const scope = scopes.getStore();
  return scope && path.resolve(root) === scope.applicationRoot ? scope.authority : null;
}

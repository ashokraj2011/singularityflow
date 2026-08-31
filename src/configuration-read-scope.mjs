/**
 * A read-only overlay for approved configuration that is not checked out on the application branch.
 *
 * Application branches intentionally do not carry `singularity/`.  Read-only surfaces still need
 * the approved workflow, prompts and templates from `sflow/config`, while every lifecycle and Git
 * read must continue to target the application checkout.  This request-local mapping is that split.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import {
  DEFAULT_CONFIGURATION_ASSET_POLICY, isConfigurationAssetPath
} from './configuration-assets.mjs';

const scopes = new AsyncLocalStorage();

export function isConfigurationReadPath(value, policy = scopes.getStore()?.assetPolicy) {
  return isConfigurationAssetPath(value, policy ?? DEFAULT_CONFIGURATION_ASSET_POLICY);
}

export function withConfigurationReadRoot(applicationRoot, configurationRoot, authority, fn, {
  assetPolicy = DEFAULT_CONFIGURATION_ASSET_POLICY,
  configurationSnapshot = null
} = {}) {
  return scopes.run({
    applicationRoot: path.resolve(applicationRoot),
    configurationRoot: path.resolve(configurationRoot),
    authority,
    assetPolicy,
    configurationSnapshot
  }, fn);
}

/** Return the request-local approved-configuration scope for this application checkout. */
export function configurationReadScope(root) {
  const scope = scopes.getStore();
  return scope && path.resolve(root) === scope.applicationRoot ? scope : null;
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

/**
 * Return the exact verified configuration snapshot retained for this request, when available.
 *
 * Selected-path reads intentionally return null. Their private directory is a security boundary:
 * exposing the parent snapshot would let a narrow verifier recover configuration files which the
 * caller deliberately omitted from its view.
 */
export function configurationReadSnapshot(root) {
  const scope = scopes.getStore();
  return scope && path.resolve(root) === scope.applicationRoot
    ? scope.configurationSnapshot ?? null
    : null;
}

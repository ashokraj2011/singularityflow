/**
 * Build one non-secret, non-executable Git environment for enterprise remote operations.
 *
 * System/global proxy, trust, TLS-backend, and credential-helper configuration is configuration a
 * corporate Git installation needs in order to reach its provider. Repository selectors, local
 * configuration, arbitrary command-scoped configuration, hooks, URL rewrites, replacement objects,
 * alternates, and trace sinks are ambient execution authority and never cross this boundary.
 */
import os from 'node:os';

import { run } from './util.mjs';

const ENTERPRISE_GIT_CONFIG_PATTERN = [
  String.raw`http\.(proxy|proxyauthmethod|sslcainfo|sslcapath|sslbackend|schannelusesslcainfo)`,
  String.raw`http\..+\.(proxy|proxyauthmethod|sslcainfo|sslcapath|sslbackend|schannelusesslcainfo)`,
  String.raw`credential\.(helper|usehttppath)`,
  String.raw`credential\..+\.(helper|usehttppath)`
].map((entry) => `(${entry})`).join('|');

const MAX_ENTRIES = 256;
const MAX_BYTES = 256 * 1024;
const ENTERPRISE_ENVIRONMENTS = new WeakSet();

/** Remove process/repository authority while retaining ordinary proxy and CA environment values. */
export function withoutGitProcessOverrides(source = process.env) {
  const env = { ...source };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_SHALLOW_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
    'GIT_SSL_NO_VERIFY',
    // These variables are executable transport authority, not authentication state. Corporate SSH
    // remains available through the platform ssh binary, normal ssh configuration, and
    // SSH_AUTH_SOCK; an inherited wrapper must not replace Git's transport, proxy, or prompt
    // executable inside the isolated preview/apply/clone boundary.
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
    'GIT_ASKPASS', 'GIT_ASKPASS_REQUIRE', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
    'GIT_PROXY_COMMAND',
    // Remote operations do not need an editor, pager, external diff, or sequence driver. Removing
    // them keeps later maintenance from accidentally turning this environment into a command
    // execution channel when a Git subcommand changes.
    'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_EXTERNAL_DIFF',
    // This is command-scoped suppression, not an enterprise trust source. Let the reviewed system
    // scope participate in the allowlist snapshot even when the caller inherited a wrapper which
    // disabled it; the resulting child environment is isolated below either way.
    'GIT_CONFIG_NOSYSTEM'
  ]) delete env[key];
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG' || key === 'GIT_CONFIG_COUNT' || key === 'GIT_CONFIG_PARAMETERS'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
      || /^GIT_TRACE(?:2(?:_.*)?|_.*)?$/.test(key)
      || key === 'GIT_CURL_VERBOSE' || key === 'GIT_REDIRECT_STDERR') delete env[key];
  }
  return env;
}

function allowedEnterpriseGitConfiguration(sourceEnv, runCommand) {
  const queryEnv = withoutGitProcessOverrides(sourceEnv);
  // This is a local trust snapshot, but it still executes the configured Git binary. Bound it by
  // the same operation deadline as the remote command it prepares and force-terminate a wrapper
  // that ignores SIGTERM. A broken office wrapper must not consume an unbounded synchronous pause
  // before the asynchronously supervised network operation even starts.
  const requestedTimeout = Number(sourceEnv?.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(25, Math.min(2_000, Math.trunc(requestedTimeout)))
    : 2_000;
  const entries = [];
  for (const scope of ['system', 'global']) {
    const observed = runCommand('git', [
      'config', `--${scope}`, '--includes', '--null', '--get-regexp',
      `^(${ENTERPRISE_GIT_CONFIG_PATTERN})$`
    ], {
      cwd: os.tmpdir(), env: queryEnv, allowFailure: true, timeoutMs,
      killSignal: 'SIGKILL', maxBuffer: MAX_BYTES
    });
    if (observed.status === 1 && !observed.error && observed.timedOut !== true) continue;
    if (observed.status !== 0) return [];
    for (const record of String(observed.stdout ?? '').split('\0')) {
      if (!record) continue;
      const separator = record.indexOf('\n');
      if (separator <= 0) continue;
      const key = record.slice(0, separator);
      const value = record.slice(separator + 1);
      if (entries.length >= MAX_ENTRIES
        || Buffer.byteLength(key, 'utf8') > 1024
        || Buffer.byteLength(value, 'utf8') > 32 * 1024) return [];
      entries.push([key, value]);
    }
  }
  return entries;
}

/**
 * Snapshot the reviewed enterprise transport/auth allowlist into command-scoped Git configuration.
 * Values remain private child-process environment bytes and must never be returned or logged.
 */
export function enterpriseGitEnvironment(sourceEnv = process.env, { runCommand = run } = {}) {
  // One onboarding command passes this exact object through catalog validation, clone fan-out and
  // initialization. Reusing the in-memory object avoids re-reading roaming/system Git config once
  // per repository, while a later CLI invocation naturally starts from a different process.env
  // object and takes a fresh snapshot. The WeakSet cannot be forged through an environment value.
  if (sourceEnv && typeof sourceEnv === 'object' && ENTERPRISE_ENVIRONMENTS.has(sourceEnv)) {
    return sourceEnv;
  }
  const env = withoutGitProcessOverrides(sourceEnv);
  const enterpriseConfiguration = allowedEnterpriseGitConfiguration(sourceEnv, runCommand);
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_NOSYSTEM;
  const isolated = {
    ...env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: String(enterpriseConfiguration.length)
  };
  enterpriseConfiguration.forEach(([key, value], index) => {
    isolated[`GIT_CONFIG_KEY_${index}`] = key;
    isolated[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  ENTERPRISE_ENVIRONMENTS.add(isolated);
  return isolated;
}

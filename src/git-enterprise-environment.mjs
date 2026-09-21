/**
 * Build one non-secret, non-executable Git environment for enterprise remote operations.
 *
 * System/global proxy, trust, TLS-backend, and credential-helper configuration is configuration a
 * corporate Git installation needs in order to reach its provider. Repository selectors, local
 * configuration, arbitrary command-scoped configuration, hooks, URL rewrites, replacement objects,
 * alternates, and trace sinks are ambient execution authority and never cross this boundary.
 */
import os from 'node:os';

import { run, SingularityFlowError } from './util.mjs';
import { gitEmptyConfigPath } from './git-isolation-paths.mjs';

const ENTERPRISE_GIT_CONFIG_PATTERN = [
  String.raw`http\.(proxy|proxyauthmethod|sslcainfo|sslcapath|sslbackend|schannelusesslcainfo)`,
  String.raw`http\..+\.(proxy|proxyauthmethod|sslcainfo|sslcapath|sslbackend|schannelusesslcainfo)`,
  String.raw`credential\.(helper|usehttppath)`,
  String.raw`credential\..+\.(helper|usehttppath)`
].map((entry) => `(${entry})`).join('|');

const MAX_ENTRIES = 256;
const MAX_BYTES = 256 * 1024;
const ENTERPRISE_ENVIRONMENTS = new WeakSet();
// Cache only the reviewed system/global policy, never the ambient process environment around it.
// PATH, recovery directories, proxy variables and test/host launch context can legitimately change
// during one long-lived extension or test process and must be sampled for every operation.
let processEnterpriseConfiguration = null;
const ENTERPRISE_GIT_CONFIG_KEY = new RegExp(`^(${ENTERPRISE_GIT_CONFIG_PATTERN})$`, 'u');
const GIT_PROCESS_OVERRIDE_KEYS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_SHALLOW_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
  'GIT_SSL_NO_VERIFY',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_ASKPASS', 'GIT_ASKPASS_REQUIRE', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
  'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE',
  'GIT_PROXY_COMMAND',
  'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_EXTERNAL_DIFF',
  'GIT_CONFIG_NOSYSTEM'
]);

function unavailableConfiguration(scope, reason) {
  throw new SingularityFlowError(
    `Cannot verify the ${scope} Git transport and credential-helper configuration (${reason}). `
      + 'Singularity Flow did not continue with an incomplete Git configuration. '
      + 'Check the approved Git installation and configuration, then retry.',
    { code: 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE', details: { scope, reason } }
  );
}

/** Remove process/repository authority while retaining ordinary proxy and CA environment values. */
export function withoutGitProcessOverrides(source = process.env) {
  const env = { ...source };
  // Windows environment names are case-insensitive. Normalize only for the denylist comparison,
  // then delete the caller's original spelling so mixed/lower-case aliases cannot survive and be
  // interpreted by Git for Windows as their canonical upper-case variables.
  for (const sourceKey of Object.keys(env)) {
    const key = sourceKey.toUpperCase();
    if (GIT_PROCESS_OVERRIDE_KEYS.has(key)
      || key === 'GIT_CONFIG' || key === 'GIT_CONFIG_COUNT' || key === 'GIT_CONFIG_PARAMETERS'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
      || /^GIT_TRACE(?:2(?:_.*)?|_.*)?$/.test(key)
      || key === 'GIT_CURL_VERBOSE' || key === 'GIT_REDIRECT_STDERR') delete env[sourceKey];
  }
  return env;
}

function parseEnterpriseGitConfiguration(stdout) {
  const output = String(stdout ?? '');
  // Status zero means Git found at least one matching key. Empty output is therefore a malformed or
  // truncated launcher response, not a trustworthy empty scope.
  if (!output) return null;
  // A successful `git config --null` response terminates every record. A missing terminator can be
  // truncated output even when a wrapper incorrectly reports status zero, so never admit its
  // apparently complete prefix.
  if (Buffer.byteLength(output, 'utf8') > MAX_BYTES || !output.endsWith('\0')) return null;
  const records = output.slice(0, -1).split('\0');
  if (records.length > MAX_ENTRIES) return null;
  const entries = [];
  for (const record of records) {
    const separator = record.indexOf('\n');
    if (separator <= 0) return null;
    const key = record.slice(0, separator);
    const value = record.slice(separator + 1);
    // Recheck Git's requested allowlist at the trust boundary. Besides defending against malformed
    // wrapper output, this keeps one bad record from turning a partially parsed scope into ambient
    // command authority.
    if (!ENTERPRISE_GIT_CONFIG_KEY.test(key)
      || Buffer.byteLength(key, 'utf8') > 1024
      || Buffer.byteLength(value, 'utf8') > 32 * 1024) return null;
    entries.push([key, value]);
  }
  return entries;
}

function allowedEnterpriseGitConfiguration(sourceEnv, runCommand) {
  const queryEnv = withoutGitProcessOverrides(sourceEnv);
  // This is a local trust snapshot, but it still executes the configured Git binary. Bound it by
  // the same operation deadline as the remote command it prepares and force-terminate a wrapper
  // that ignores SIGTERM. A broken office wrapper must not consume an unbounded synchronous pause
  // before the asynchronously supervised network operation even starts. Roaming Windows Git
  // configuration and antivirus can exceed the former two-second deadline; a bounded longer read
  // is safer than losing the helper and reporting the next remote refusal as a sign-in failure.
  const requestedTimeout = Number(sourceEnv?.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(25, Math.min(10_000, Math.trunc(requestedTimeout)))
    : 10_000;
  const observedScopes = new Map();
  for (const scope of ['system', 'global']) {
    let observed;
    try {
      observed = runCommand('git', [
        'config', `--${scope}`, '--includes', '--null', '--get-regexp',
        `^(${ENTERPRISE_GIT_CONFIG_PATTERN})$`
      ], {
        cwd: os.tmpdir(), env: queryEnv, allowFailure: true, timeoutMs,
        killSignal: 'SIGKILL', maxBuffer: MAX_BYTES
      });
    } catch {
      // A custom Git launcher can throw before `allowFailure` has a chance to normalize the result.
      // Inspect the other scope too, but never replay its partial prefix when this scope could
      // contain a reset or a more-specific credential helper.
      observedScopes.set(scope, { entries: null, reason: 'launcher-failed' });
      continue;
    }
    if (observed?.status === 1 && !observed.error && observed.timedOut !== true
      && observed.outputOverflow !== true && observed.blocked !== true
      && observed.aborted !== true && observed.signal == null
      && String(observed.stdout ?? '') === '' && String(observed.stderr ?? '') === '') {
      observedScopes.set(scope, { entries: [], reason: null });
      continue;
    }
    if (observed?.status !== 0 || observed.error || observed.timedOut === true
      || observed.outputOverflow === true || observed.blocked === true
      || observed.aborted === true || observed.signal != null) {
      const reason = observed?.timedOut === true ? 'timeout'
        : observed?.outputOverflow === true ? 'output-limit'
          : observed?.aborted === true || observed?.signal != null ? 'interrupted'
            : observed?.error?.code === 'ENOENT' ? 'git-unavailable' : 'read-failed';
      observedScopes.set(scope, { entries: null, reason });
      continue;
    }
    const scopeEntries = parseEnterpriseGitConfiguration(observed.stdout);
    observedScopes.set(scope, {
      entries: scopeEntries,
      reason: scopeEntries === null ? 'invalid-response' : null
    });
  }

  const systemEntries = observedScopes.get('system');
  const globalEntries = observedScopes.get('global');
  // Git configuration precedence depends on both file scope and URL specificity. A global empty
  // credential.helper can reset system helpers, while a URL-specific system HTTP value can outrank a
  // generic global value. Neither scope is meaningful in isolation. The previous silent empty
  // snapshot removed office credential helpers and made the next Git failure look like bad login.
  if (!systemEntries || systemEntries.entries === null) {
    unavailableConfiguration('system', systemEntries?.reason ?? 'unavailable');
  }
  if (!globalEntries || globalEntries.entries === null) {
    unavailableConfiguration('global', globalEntries?.reason ?? 'unavailable');
  }
  const entries = [...systemEntries.entries, ...globalEntries.entries];
  // Never retain a lower-precedence prefix when the exact ordered snapshot exceeds its process-wide
  // bound; doing so would change Git's override/reset semantics.
  if (entries.length > MAX_ENTRIES) unavailableConfiguration('combined', 'entry-limit');
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
  // A CLI invocation can address the same authority many times (inventory, preflight, publish,
  // reconciliation). Reuse only the reviewed Git configuration entries. Reconstruct the isolated
  // object from the current process environment so operation-local PATH/recovery/proxy changes are
  // never frozen by whichever remote operation happened to run first.
  let enterpriseConfiguration;
  if (sourceEnv === process.env && runCommand === run
      && processEnterpriseConfiguration !== null) {
    enterpriseConfiguration = processEnterpriseConfiguration;
  } else {
    enterpriseConfiguration = allowedEnterpriseGitConfiguration(sourceEnv, runCommand);
    if (sourceEnv === process.env && runCommand === run) {
      processEnterpriseConfiguration = Object.freeze(enterpriseConfiguration
        .map(([key, value]) => Object.freeze([key, value])));
      enterpriseConfiguration = processEnterpriseConfiguration;
    }
  }
  delete env.GIT_CONFIG_SYSTEM;
  delete env.GIT_CONFIG_NOSYSTEM;
  const isolated = {
    ...env,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: gitEmptyConfigPath(),
    GIT_CONFIG_GLOBAL: gitEmptyConfigPath(),
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

/**
 * Admit an environment at the remote-Git execution boundary.
 *
 * Product callers sometimes add operation-local values (timeouts, proxy variables, test probes)
 * to an ordinary environment instead of threading the already-attested object through every
 * layer. Preserve those non-authority values, but always source system/global Git policy from the
 * process's reviewed snapshot. Only an object carrying the private in-memory attestation may retain
 * its command-scoped Git entries; this is what lets frozenRemoteTransport keep its random alias
 * without admitting caller-forged counted configuration.
 */
export function remoteGitEnvironment(sourceEnv = process.env) {
  if (sourceEnv && typeof sourceEnv === 'object' && ENTERPRISE_ENVIRONMENTS.has(sourceEnv)) {
    return sourceEnv;
  }
  const authority = enterpriseGitEnvironment(process.env);
  const admitted = withoutGitProcessOverrides(sourceEnv);
  // Unlike a local plumbing command, a remote operation must not select arbitrary system/global
  // configuration files supplied by its caller. Their reviewed allowlist is already represented by
  // the command-scoped entries copied from `authority` below.
  for (const key of Object.keys(admitted)) {
    if (['GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key.toUpperCase())) delete admitted[key];
  }
  const isolated = { ...authority, ...admitted };
  for (const [key, value] of Object.entries(authority)) {
    const upper = key.toUpperCase();
    if (upper === 'GIT_NO_REPLACE_OBJECTS' || upper === 'GIT_CONFIG_NOSYSTEM'
      || upper === 'GIT_CONFIG_SYSTEM' || upper === 'GIT_CONFIG_GLOBAL'
      || upper === 'GIT_ATTR_NOSYSTEM' || upper === 'GIT_CONFIG_COUNT'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper)) isolated[key] = value;
  }
  ENTERPRISE_ENVIRONMENTS.add(isolated);
  return isolated;
}

/**
 * Preserve the in-memory enterprise attestation when a caller only extends an already-isolated
 * environment with bounded invocation-local Git configuration.
 *
 * This is deliberately not an attestation API for arbitrary environments: an unmarked source
 * leaves its derivative unmarked, so the next enterprise boundary must inspect and isolate it.
 */
export function inheritEnterpriseGitEnvironment(sourceEnv, derivedEnv) {
  if (sourceEnv && typeof sourceEnv === 'object' && ENTERPRISE_ENVIRONMENTS.has(sourceEnv)
      && derivedEnv && typeof derivedEnv === 'object') {
    ENTERPRISE_ENVIRONMENTS.add(derivedEnv);
  }
  return derivedEnv;
}

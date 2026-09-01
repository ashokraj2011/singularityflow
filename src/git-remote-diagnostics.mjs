import { createHash, randomUUID } from 'node:crypto';

import { networkDisabled, run, SingularityFlowError } from './util.mjs';

export const REMOTE_FAILURE_CLASSES = Object.freeze([
  'network-transient',
  'offline',
  'authentication-required',
  'authorization-denied',
  'tls-trust',
  'proxy-configuration',
  'remote-not-found',
  'branch-not-found',
  'rate-limited',
  'protocol-unsupported',
  'unknown'
]);

const ADVICE = Object.freeze({
  'network-transient': 'Check DNS and network reachability, then retry the same bootstrap session.',
  offline: 'Reconnect to the network, then retry the same bootstrap session.',
  'authentication-required': 'Sign in to Git or configure its credential helper, then retry. Do not put a token in the URL.',
  'authorization-denied': 'Ask the repository owner for read access, then retry the same bootstrap session.',
  'tls-trust': 'Install the organisation trust chain through the approved system or Git configuration, then retry.',
  'proxy-configuration': 'Correct the approved Git or operating-system proxy configuration, then retry.',
  'remote-not-found': 'Verify the repository URL and your access to it, then retry.',
  'branch-not-found': 'Choose a branch that exists on the remote or publish the expected branch, then retry.',
  'rate-limited': 'Wait for the provider limit to reset, then retry the same bootstrap session.',
  'protocol-unsupported': 'Use a Git transport supported by this installation and the remote provider.',
  unknown: 'Run workspace doctor --network and inspect Git access outside SFlow before retrying.'
});

/** A display-safe remote. Query strings, fragments and URL credentials never survive. */
export function sanitizeRemote(value) {
  const remote = String(value ?? '').trim();
  if (!remote) return '';
  try {
    const parsed = new URL(remote);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // SCP-like SSH remotes contain a transport username, not a credential. They have no query or
    // fragment semantics, so retaining the host/path is both useful and safe.
    return remote.replace(/[?#].*$/, '');
  }
}

/** Credential-bearing HTTP(S) URLs are refused because a resumable record must never persist one. */
export function assertCredentialFreeRemote(value) {
  const remote = String(value ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository remote is required.', { code: 'BOOTSTRAP_REMOTE_REQUIRED' });
  if (/[\0\r\n]/.test(remote) || remote.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(remote)) {
    throw new SingularityFlowError(
      'The repository remote uses an option-like or external-helper transport that workspace bootstrap does not permit.',
      { code: 'BOOTSTRAP_REMOTE_PROTOCOL_UNSAFE' }
    );
  }
  try {
    const parsed = new URL(remote);
    // An SSH URL may legitimately carry a transport login (`ssh://git@host/repo`), but a password
    // component is credential material under every URL scheme. Reject it before any bootstrap,
    // transport intent, workspace manifest, or refresh cache can persist the exact remote string.
    if (parsed.password || (['http:', 'https:'].includes(parsed.protocol) && parsed.username)) {
      throw new SingularityFlowError(
        'Repository URLs containing credentials cannot be stored in a bootstrap session. Configure a Git credential helper and use the credential-free URL.',
        { code: 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL' }
      );
    }
    if (['http:', 'https:'].includes(parsed.protocol) && (parsed.search || parsed.hash)) {
      throw new SingularityFlowError(
        'Repository URLs containing query parameters or fragments cannot be stored in a bootstrap session. Configure a Git credential helper and use the stable credential-free URL.',
        { code: 'BOOTSTRAP_REMOTE_CONTAINS_EPHEMERAL_CREDENTIAL' }
      );
    }
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    // Absolute paths and SCP-like SSH syntax are valid Git remotes and are validated by Git.
  }
  return remote;
}

/** Remove common credential material before a diagnostic is written to durable local state. */
export function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/("(?:access_?token|refresh_?token|client_?secret|password|secret|api_?key)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/([?&](?:access_?token|refresh_?token|client_?secret|password|secret|api_?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(access_?token|refresh_?token|client_?secret|password|secret|api_?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1');
}

export function remoteFingerprint(value) {
  return createHash('sha256').update(String(value ?? '').trim()).digest('hex');
}

/** Resolve and freeze the credential-free fetch or push authority behind one local remote name. */
export function configuredRemoteAuthority(root, remote = 'origin', { direction = 'push' } = {}) {
  if (!['fetch', 'push'].includes(direction)) {
    throw new SingularityFlowError(`Unsupported Git remote direction '${direction}'.`);
  }
  const result = run('git', [
    'remote', 'get-url', ...(direction === 'push' ? ['--push'] : []), remote
  ], { cwd: root, allowFailure: true });
  const url = result.status === 0 ? assertCredentialFreeRemote(result.stdout.trim()) : null;
  return Object.freeze({
    remote: String(remote),
    direction,
    url,
    fingerprint: url ? remoteFingerprint(url) : null
  });
}

/**
 * Read the repository identity exactly as it is stored in the checkout's local Git config.
 *
 * `git remote get-url` is the right command for selecting a transport, but it applies mutable
 * `url.*.insteadOf` rules. That makes it the wrong identity proof for a reviewed workspace: a
 * machine-level rewrite can make a differently configured remote look like the reviewed URL (or
 * make the reviewed raw URL look different). Keep identity and transport selection separate.
 *
 * A push remote inherits the fetch URL when no explicit `pushurl` exists, matching Git's behavior.
 * Multiple distinct URLs are reported as ambiguous rather than silently selecting one; a governed
 * operation cannot prove which repository all of those endpoints identify.
 */
export function configuredRemoteIdentity(root, remote = 'origin', { direction = 'fetch' } = {}) {
  if (!['fetch', 'push'].includes(direction)) {
    throw new SingularityFlowError(`Unsupported Git remote direction '${direction}'.`);
  }
  const readValues = (key) => {
    const result = run('git', ['config', '--local', '--get-all', key], {
      cwd: root, allowFailure: true
    });
    if (result.status !== 0) return [];
    return String(result.stdout ?? '').split('\n').map((value) => value.trim()).filter(Boolean)
      .map(assertCredentialFreeRemote);
  };
  const fetchUrls = readValues(`remote.${remote}.url`);
  const configuredPushUrls = direction === 'push'
    ? readValues(`remote.${remote}.pushurl`)
    : [];
  const urls = direction === 'push' && configuredPushUrls.length
    ? configuredPushUrls
    : fetchUrls;
  const unique = [...new Set(urls)];
  const url = unique.length === 1 ? unique[0] : null;
  return Object.freeze({
    remote: String(remote),
    direction,
    url,
    urls: Object.freeze([...urls]),
    configured: urls.length > 0,
    ambiguous: unique.length > 1,
    inherited: direction === 'push' && configuredPushUrls.length === 0,
    fingerprint: url ? remoteFingerprint(url) : null
  });
}

/** Fingerprint the credential-free fetch or push authority configured behind one remote name. */
export function configuredRemoteFingerprint(root, remote = 'origin', options = {}) {
  return configuredRemoteAuthority(root, remote, options).fingerprint;
}

/**
 * Address one exact URL without allowing Git to apply a later mutable url.* rewrite to it.
 *
 * Git applies insteadOf/pushInsteadOf even when the caller passes a literal URL, so merely replacing
 * a remote name with its captured value does not freeze transport authority. Route a random,
 * invocation-local alias through an exact command configuration rule instead. URL rewriting is a
 * single pass: the captured URL produced by this rule is the transport result, not new rewrite
 * input. The unguessable full-length alias also wins longest-prefix selection over ambient rules.
 */
export function frozenRemoteTransport(remote, { push = false, env = process.env } = {}) {
  const url = assertCredentialFreeRemote(remote);
  const alias = `sflow-frozen-${randomUUID()}:`;
  const inheritedCount = Number(env.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isInteger(inheritedCount) && inheritedCount >= 0 ? inheritedCount : 0;
  const entries = [
    [`url.${url}.insteadOf`, alias],
    ...(push ? [[`url.${url}.pushInsteadOf`, alias]] : [])
  ];
  const transportEnv = { ...env, GIT_CONFIG_COUNT: String(start + entries.length) };
  for (let index = 0; index < entries.length; index += 1) {
    transportEnv[`GIT_CONFIG_KEY_${start + index}`] = entries[index][0];
    transportEnv[`GIT_CONFIG_VALUE_${start + index}`] = entries[index][1];
  }
  return Object.freeze({
    url,
    remote: alias,
    env: Object.freeze(transportEnv)
  });
}

function outputFor(result) {
  return [result?.stderr, result?.stdout, result?.error?.message]
    .filter(Boolean).map(String).join('\n');
}

/**
 * Describe a failed local Git post-clone operation without echoing helper/filter diagnostics.
 *
 * Sparse checkout can lazy-fetch and Git may invoke a configured credential helper or content
 * filter while doing it. Their output is therefore secret-bearing provider input, just like remote
 * stderr. The digest is enough to correlate a terminal trace without persisting the bytes.
 */
export function safeGitDiagnosticReference(result, fallback = 'Git refused the operation') {
  const raw = outputFor(result);
  const exit = Number.isInteger(result?.status) ? result.status : 'unknown';
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `${fallback} (exit ${exit}; diagnostic sha256:${digest})`;
}

function failureEvidence(result) {
  const raw = outputFor(result);
  return {
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal ?? null,
    timedOut: result?.timedOut === true,
    blocked: result?.blocked === true,
    diagnosticSha256: createHash('sha256').update(raw).digest('hex'),
    diagnosticBytes: Buffer.byteLength(raw, 'utf8')
  };
}

/** Deterministic classification only. Raw provider output is deliberately not returned. */
export function classifyGitRemoteFailure(result, { branch = null } = {}) {
  const output = outputFor(result);
  let classification = 'unknown';
  if (result?.blocked || /network.+disabled|offline/i.test(output)) classification = 'offline';
  else if (result?.timedOut
    || /timed? out|temporary failure|connection (?:reset|closed)|could not resolve host|name or service not known|network is unreachable|failed to connect|early eof|unexpected (?:disconnect|eof)|remote end hung up unexpectedly|rpc failed|broken pipe/i.test(output)) classification = 'network-transient';
  else if (/rate.?limit|too many requests|http[^\n]*429/i.test(output)) classification = 'rate-limited';
  else if (/proxy authentication|required proxy|unable to access[^\n]*proxy|could not resolve proxy/i.test(output)) classification = 'proxy-configuration';
  else if (/certificate|ssl certificate|tls|schannel|unknown ca|self.signed/i.test(output)) classification = 'tls-trust';
  else if (/authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey\)|invalid credentials|http[^\n]*401/i.test(output)) classification = 'authentication-required';
  else if (/access denied|not authorized|insufficient permission|http[^\n]*403|write access.+not granted/i.test(output)) classification = 'authorization-denied';
  else if (/remote branch .+ not found|couldn't find remote ref|invalid refspec/i.test(output)) classification = 'branch-not-found';
  else if (/repository .+ not found|does not appear to be a git repository|no such file or directory/i.test(output)) classification = 'remote-not-found';
  else if (/unsupported protocol|transport .+ not allowed|protocol .+ not supported/i.test(output)) classification = 'protocol-unsupported';

  return Object.freeze({
    classification,
    code: `REMOTE_${classification.replaceAll('-', '_').toUpperCase()}`,
    retryable: ['network-transient', 'offline', 'rate-limited', 'proxy-configuration', 'tls-trust', 'authentication-required'].includes(classification),
    branch,
    advice: ADVICE[classification]
  });
}

function symrefBranch(stdout) {
  const match = String(stdout ?? '').match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m);
  return match?.[1] ?? null;
}

function headBranches(stdout) {
  return [...new Set(String(stdout ?? '').split('\n').map((line) => {
    const match = line.trim().match(/^[0-9a-f]{40,64}\s+refs\/heads\/([^\s]+)$/i);
    return match?.[1] ?? null;
  }).filter(Boolean))].sort();
}

/**
 * Read a remote without allowing an interactive credential prompt.
 *
 * The result contains classifications and ref names, never provider stderr. Callers may persist it.
 */
export function probeGitRemote(remote, {
  branch = null,
  timeoutMs = Number(process.env.SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS ?? 30_000),
  runCommand = run,
  env = process.env
} = {}) {
  const url = assertCredentialFreeRemote(remote);
  const safeRemote = sanitizeRemote(url);
  if (networkDisabled(env)) {
    const blocked = { status: 1, stdout: '', stderr: '', signal: null, timedOut: false, blocked: true };
    return {
      ok: false,
      remote: safeRemote,
      remoteFingerprint: remoteFingerprint(url),
      defaultBranch: null,
      branches: [],
      failure: { ...classifyGitRemoteFailure(blocked, { branch }), evidence: failureEvidence(blocked) }
    };
  }
  const transport = frozenRemoteTransport(url, { env });
  const result = runCommand('git', [
    'ls-remote', '--symref', '--', transport.remote, 'HEAD', 'refs/heads/*'
  ], {
    allowFailure: true,
    timeoutMs,
    env: { ...transport.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  if (result.status !== 0) {
    return {
      ok: false,
      remote: safeRemote,
      remoteFingerprint: remoteFingerprint(url),
      defaultBranch: null,
      branches: [],
      failure: { ...classifyGitRemoteFailure(result, { branch }), evidence: failureEvidence(result) }
    };
  }
  const branches = headBranches(result.stdout);
  const defaultBranch = symrefBranch(result.stdout);
  if (branch && !branches.includes(branch)) {
    return {
      ok: false,
      remote: safeRemote,
      remoteFingerprint: remoteFingerprint(url),
      defaultBranch,
      branches,
      failure: {
        classification: 'branch-not-found',
        code: 'REMOTE_BRANCH_NOT_FOUND',
        retryable: false,
        branch,
        advice: ADVICE['branch-not-found'],
        evidence: failureEvidence(result)
      }
    };
  }
  return {
    ok: true,
    remote: safeRemote,
    remoteFingerprint: remoteFingerprint(url),
    defaultBranch,
    branches,
    failure: null
  };
}

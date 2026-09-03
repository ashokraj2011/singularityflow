import { createHash, randomUUID } from 'node:crypto';

import { networkDisabled, run, SingularityFlowError } from './util.mjs';

export const REMOTE_FAILURE_CLASSES = Object.freeze([
  'network-transient',
  'offline',
  'git-unavailable',
  'working-directory-unavailable',
  'credential-helper-unavailable',
  'authentication-required',
  'sso-authorization-required',
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
  'git-unavailable': 'Install Git or add the approved Git executable to PATH, restart the calling application, then retry.',
  'working-directory-unavailable': 'Restore or reopen the local repository directory, then retry the same operation.',
  'credential-helper-unavailable': 'Install or repair the configured Git credential helper, then sign in and retry. Do not put a token in the URL.',
  'authentication-required': 'Sign in to Git or configure its credential helper, then retry. Do not put a token in the URL.',
  'sso-authorization-required': 'Authorize or re-authorize your Git credential for the organisation\'s SSO, then retry. Do not put a token in the URL.',
  'authorization-denied': 'Ask the repository owner for read access, then retry the same bootstrap session.',
  'tls-trust': 'Install the organisation trust chain through the approved system or Git configuration, then retry.',
  'proxy-configuration': 'Correct the approved Git or operating-system proxy configuration, then retry.',
  'remote-not-found': 'Verify the repository URL and your access to it, then retry.',
  'branch-not-found': 'Choose a branch that exists on the remote or publish the expected branch, then retry.',
  'rate-limited': 'Wait for the provider limit to reset, then retry the same bootstrap session.',
  'protocol-unsupported': 'Use a Git transport supported by this installation and the remote provider.',
  unknown: 'Run workspace doctor --network and inspect Git access outside SFlow before retrying.'
});
const SSH_USERNAME_PROTOCOLS = new Set(['ssh:', 'git+ssh:', 'ssh+git:']);
const BUILTIN_HIERARCHICAL_PROTOCOLS = new Set([
  'http:', 'https:', 'ssh:', 'git+ssh:', 'ssh+git:', 'git:', 'file:', 'ftp:', 'ftps:'
]);
const SCP_PASSWORD_SHAPED_USER_INFO = /^[^/@\s:]+:[^/@\s]+@[^:\s]+:.+/;
// Recognized scheme names are also legal SCP host names (`https:repo.git`), so malformed-scheme
// detection must be credential-specific. This catches user:password authority syntax even when
// missing/mixed slashes or an invalid host make WHATWG URL parsing impossible.
const MALFORMED_BUILTIN_CREDENTIAL = /^(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)[\\/]*[^/@\s:]+:[^/@\s]+@/i;
const DIAGNOSTIC_SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|api[-_]?key|access[-_]?key|private[-_]?key|signature|(?:^|[_.-])pat(?:$|[_.-])|[a-z]pat(?![a-z]))/i;
const DIAGNOSTIC_SECRET_VALUES = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g
];
const MAX_DIAGNOSTIC_CHARS = 8 * 1024;
const DIAGNOSTIC_REDACTION_OVERLAP_CHARS = 1024;
const MAX_REMOTE_CHARS = 8 * 1024;
const UNSAFE_DIAGNOSTIC_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const ASSIGNMENT_BREAKING_CONTROLS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const ZERO_WIDTH_FORMATS = /[\u200b-\u200f\u2060-\u206f\ufeff]/g;
const ANSI_ESCAPE_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\r\n]*(?:\u0007|\u001b\\)?/g;

function normalizeDiagnosticSyntax(value) {
  return String(value)
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(ZERO_WIDTH_FORMATS, '')
    .replace(ASSIGNMENT_BREAKING_CONTROLS, '')
    .replace(/\\+(["'=:])/g, '$1');
}

function boundedDiagnosticInput(source) {
  const boundary = MAX_DIAGNOSTIC_CHARS + DIAGNOSTIC_REDACTION_OVERLAP_CHARS;
  if (source.length <= boundary) return source;
  let start = boundary - 1;
  while (start >= 0 && !/\s/.test(source[start])) start -= 1;
  start += 1;
  let end = boundary;
  while (end < source.length && !/\s/.test(source[end])) end += 1;
  const at = source.indexOf('@', boundary);
  const colon = source.indexOf(':', start);
  return at >= boundary && at < end && colon >= start && colon < at
    ? `${source.slice(0, start)}[REDACTED REMOTE]`
    : source.slice(0, boundary);
}

function redactDiagnosticAssignments(value, { allowColon = true } = {}) {
  const text = String(value);
  const parts = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const quoted = text[index] === '"' || text[index] === "'" ? text[index] : null;
    const keyStart = quoted ? index + 1 : index;
    if (!/[A-Za-z]/.test(text[keyStart] ?? '')) { index += 1; continue; }
    let keyEnd = keyStart + 1;
    while (keyEnd < text.length && /[A-Za-z0-9_.-]/.test(text[keyEnd])) keyEnd += 1;
    let separator = keyEnd;
    let quotedHeader = false;
    if (quoted) {
      if (text[separator] === quoted) separator += 1;
      else if (text[separator] === ':') quotedHeader = true;
      else { index = keyEnd; continue; }
    }
    while (separator < text.length && /\s/.test(text[separator])) separator += 1;
    if (text[separator] !== '=' && !((allowColon || quotedHeader) && text[separator] === ':')) {
      index = keyEnd;
      continue;
    }
    let valueStart = separator + 1;
    while (valueStart < text.length && /[ \t]/.test(text[valueStart])) valueStart += 1;
    const key = text.slice(keyStart, keyEnd);
    if (!DIAGNOSTIC_SECRET_KEY.test(key)) { index = valueStart; continue; }
    const valueEnd = text.length;
    parts.push(text.slice(cursor, index), `${key}=[REDACTED]`);
    cursor = valueEnd;
    index = valueEnd;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

function remoteContainsEmbeddedSecret(remote) {
  // Within a Git remote, colons delimit URL ports and SCP host/path identities. Only an equals
  // assignment is unambiguously credential-shaped here; the diagnostic redactor remains broader.
  const assignmentText = normalizeDiagnosticSyntax(remote);
  if (redactDiagnosticAssignments(assignmentText, { allowColon: false }) !== assignmentText) return true;
  for (const match of remote.matchAll(/((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/@\s]+)@/gi)) {
    const protocol = match[1].includes(':') ? match[1].slice(0, -2).toLowerCase() : null;
    const userInfo = match[2];
    if (protocol && SSH_USERNAME_PROTOCOLS.has(protocol)
        && !userInfo.includes(':') && !/%[0-9a-f]{2}/i.test(userInfo)) continue;
    return true;
  }
  if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(remote)
      && /(?:^|[/\\])[^/\\\s@:]+:[^/\\\s@]+@[^/\\\s]+[/\\]/.test(remote)) return true;
  if (/(?:^|[/\\])(?:ssh|git\+ssh|ssh\+git):\/\/[^/\s@]*%[0-9a-f]{2}[^/\s@]*@/i.test(remote)) return true;
  return DIAGNOSTIC_SECRET_VALUES.some((pattern) => {
    pattern.lastIndex = 0;
    const matched = pattern.test(remote);
    pattern.lastIndex = 0;
    return matched;
  });
}

/** A display-safe remote. Query strings, fragments and URL credentials never survive. */
export function sanitizeRemote(value) {
  const remote = String(value ?? '').trim();
  if (!remote) return '';
  if (remote.length > MAX_REMOTE_CHARS) return '[invalid-remote]';
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(remote)) return '[invalid-remote]';
  if (remote.startsWith('-')) return '[invalid-remote]';
  if (/^[a-z][a-z0-9+.-]*::/i.test(remote)) return '[invalid-remote]';
  const hierarchicalSyntax = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(remote);
  const encodedUserInfo = /^((?:ssh|git\+ssh|ssh\+git):\/\/)([^/@\s]+)@/i.exec(remote);
  if (encodedUserInfo && /%[0-9a-f]{2}/i.test(encodedUserInfo[2])) return '[credential-redacted]';
  // A well-formed top-level URL can be made useful and safe by removing its complete user-info
  // component. Screen the remaining stable URL, excluding query/fragment data that is discarded
  // below, so secrets hidden in a path still fail closed without reducing every legacy
  // credential-bearing origin to an opaque marker during safe workspace adoption.
  const topLevelUserInfo = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i.exec(remote);
  const stableRemote = topLevelUserInfo
    ? `${topLevelUserInfo[1]}${remote.slice(topLevelUserInfo[0].length)}`
    : remote;
  const secretScanRemote = hierarchicalSyntax ? stableRemote.replace(/[?#].*$/, '') : remote;
  if (remoteContainsEmbeddedSecret(secretScanRemote)
    || (!hierarchicalSyntax && /(?:^|[/\\])[^/\s@:]+:[^/\s@]+@[^/\s]+[/\\]/.test(remote))) {
    return '[credential-redacted]';
  }
  if (SCP_PASSWORD_SHAPED_USER_INFO.test(remote)
      || MALFORMED_BUILTIN_CREDENTIAL.test(remote)) return '[credential-redacted]';
  if (remote.startsWith('//')) {
    const withoutSuffix = remote.replace(/[?#].*$/, '');
    const match = /^\/\/([^/\s]*)(.*)$/s.exec(withoutSuffix);
    if (!match) return '//[invalid-remote]';
    const authority = match[1].includes('@') ? match[1].slice(match[1].lastIndexOf('@') + 1) : match[1];
    return `//${authority}${match[2]}`;
  }
  // Scrub password-bearing user-info before parsing too. Malformed URLs can make the URL constructor
  // throw, but that must never cause an embedded secret to be returned unchanged. Username-only SSH
  // user-info remains a legitimate transport identity.
  const hierarchical = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i.exec(remote);
  let candidate = hierarchical && (/^https?:\/\//i.test(remote) || hierarchical[2].includes(':'))
    ? `${hierarchical[1]}${remote.slice(hierarchical[0].length)}`
    : remote;
  if (/^https?:\/\//i.test(candidate)) candidate = candidate.replace(/[?#].*$/, '');
  if (!candidate.includes('://') && !candidate.startsWith('//')
    && /^(?:[^/@\s]+@)?[^/:\\\s]+:.+/.test(candidate)) {
    return candidate.replace(/[?#].*$/, '');
  }
  try {
    const parsed = new URL(candidate);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
      && !BUILTIN_HIERARCHICAL_PROTOCOLS.has(parsed.protocol)) {
      return `${parsed.protocol}//[invalid-remote]`;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const protocol = candidate.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0];
    if (protocol) {
      return `${protocol}[invalid-remote]`;
    }
    // SCP-like SSH remotes contain a transport username, not a credential. They have no query or
    // fragment semantics, so retaining the host/path is both useful and safe.
    return candidate.replace(/[?#].*$/, '');
  }
}

/** Credential-bearing HTTP(S) URLs are refused because a resumable record must never persist one. */
export function assertCredentialFreeRemote(value) {
  const remote = String(value ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository remote is required.', { code: 'BOOTSTRAP_REMOTE_REQUIRED' });
  if (remote.length > MAX_REMOTE_CHARS) {
    throw new SingularityFlowError('The repository remote is too long to validate safely.', {
      code: 'BOOTSTRAP_REMOTE_TOO_LONG'
    });
  }
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(remote)
      || remote.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(remote)) {
    throw new SingularityFlowError(
      'The repository remote uses an option-like or external-helper transport that workspace bootstrap does not permit.',
      { code: 'BOOTSTRAP_REMOTE_PROTOCOL_UNSAFE' }
    );
  }
  if (SCP_PASSWORD_SHAPED_USER_INFO.test(remote)
      || MALFORMED_BUILTIN_CREDENTIAL.test(remote)) {
    throw new SingularityFlowError(
      'Repository remotes containing password-shaped SCP user information cannot be stored. Configure a Git credential helper and use a credential-free remote such as git@host:path.',
      { code: 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL' }
    );
  }
  const hierarchicalSyntax = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(remote);
  const hierarchicalRemote = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/@\s]+)@/i.exec(remote);
  const userInfoProtocol = hierarchicalRemote?.[1]?.includes(':')
    ? hierarchicalRemote[1].slice(0, -2).toLowerCase() : null;
  // Keep the credential checks fail-closed even when malformed host/escape syntax makes `new URL`
  // throw. A rejected value is never reflected in the error.
  if (hierarchicalRemote
    && (hierarchicalRemote[2].includes(':')
      || /%[0-9a-f]{2}/i.test(hierarchicalRemote[2])
      || !SSH_USERNAME_PROTOCOLS.has(userInfoProtocol))) {
    throw new SingularityFlowError(
      'Repository URLs containing credentials cannot be stored in a bootstrap session. Configure a Git credential helper and use the credential-free URL.',
      { code: 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL' }
    );
  }
  if (hierarchicalSyntax && /[?#]/.test(remote)) {
    throw new SingularityFlowError(
      'Repository URLs containing query parameters or fragments cannot be stored in a bootstrap session. Configure a Git credential helper and use the stable credential-free URL.',
      { code: 'BOOTSTRAP_REMOTE_CONTAINS_EPHEMERAL_CREDENTIAL' }
    );
  }
  if (remoteContainsEmbeddedSecret(remote)) {
    throw new SingularityFlowError(
      'The repository remote contains credential-shaped material that cannot be stored. Configure a Git credential helper and use a stable credential-free remote.',
      { code: 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL' }
    );
  }
  try {
    const parsed = new URL(remote);
    if (hierarchicalSyntax && !BUILTIN_HIERARCHICAL_PROTOCOLS.has(parsed.protocol)) {
      throw new SingularityFlowError(
        `Repository URL protocol '${parsed.protocol.replace(/:$/, '')}' is not permitted because Git would resolve it through an external remote helper. Use HTTPS, SSH, Git, file, or an approved local/SCP path.`,
        { code: 'BOOTSTRAP_REMOTE_PROTOCOL_UNSAFE' }
      );
    }
    // An SSH URL may legitimately carry a transport login (`ssh://git@host/repo`), but a password
    // component is credential material under every URL scheme. Reject it before any bootstrap,
    // transport intent, workspace manifest, or refresh cache can persist the exact remote string.
    if (parsed.password || (parsed.username && !SSH_USERNAME_PROTOCOLS.has(parsed.protocol))) {
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
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
      throw new SingularityFlowError(
        'The repository URL is malformed. Use a valid credential-free Git URL.',
        { code: 'BOOTSTRAP_REMOTE_MALFORMED_URL' }
      );
    }
    // Absolute paths and SCP-like SSH syntax are valid Git remotes and are validated by Git.
  }
  return remote;
}

/** Remove common credential material before a diagnostic is written to durable local state. */
export function redactDiagnosticText(value) {
  const source = String(value ?? '');
  const omitted = Math.max(0, source.length - MAX_DIAGNOSTIC_CHARS);
  let text = normalizeDiagnosticSyntax(boundedDiagnosticInput(source));
  text = text.replace(/\b[a-z][a-z0-9+.-]*::[^\r\n]*/gi, '[invalid-remote]');
  // Scrub complete URL units first. Removing only user-info or a known query key can leave an
  // arbitrary signed query/fragment behind, especially in provider diagnostics and webhook text.
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/(?=[^/\s@]*:[^/\s@]*@)[^\s]+/gi,
    '[REDACTED REMOTE]');
  text = text.replace(/\b(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)(?=[^\s@]*:[^\s@]*@)[^\s]+/gi,
    '[REDACTED REMOTE]');
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (remote) => sanitizeRemote(remote));
  text = text.replace(/(^|[\s("'=])\/\/[^\s<>"']+/g,
    (match, prefix) => `${prefix}${sanitizeRemote(match.slice(prefix.length))}`);
  text = text.replace(/\b(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)[^\s<>"']+/gi,
    (remote) => sanitizeRemote(remote));
  text = text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/@\s]+@/gi, '$1')
    .replace(/\b[^/\s@:]+:[^/\s@]+@[^\s]+/g, '[REDACTED REMOTE]');
  text = redactDiagnosticAssignments(text);
  text = text.replace(/\S+/g,
    (token) => remoteContainsEmbeddedSecret(token) ? '[REDACTED]' : token);
  for (const pattern of DIAGNOSTIC_SECRET_VALUES) text = text.replace(pattern, '[REDACTED]');
  text = text.replace(UNSAFE_DIAGNOSTIC_CONTROLS, ' ');
  const expansionOmitted = source.length <= MAX_DIAGNOSTIC_CHARS
    ? Math.max(0, text.length - MAX_DIAGNOSTIC_CHARS)
    : 0;
  text = text.slice(0, MAX_DIAGNOSTIC_CHARS);
  return omitted || expansionOmitted
    ? `${text}…[truncated ${omitted + expansionOmitted} chars]`
    : text;
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

function outputForClassification(result) {
  // Git repeats the requested URL/path inside several fatal messages. Treat that operand as data,
  // not diagnostic prose, so a repository named `saml`, `rate limit`, `ssl certificate`, or
  // `spawn git ENOENT` cannot select an unrelated recovery class.
  return outputFor(result).split(/\r?\n/).map((line) => line
    .replace(/^(\s*Cloning into\s+)(['"]).*\2(?:\.\.\.)?\s*$/i, '$1[local]...')
    .replace(/^(\s*fatal:\s*repository\s+).*(\s+not found\b.*)$/i, '$1[remote]$2')
    .replace(/^(\s*fatal:\s*).*(\s+does not appear to be a git repository\b.*)$/i, '$1[remote]$2')
    .replace(/^(\s*fatal:\s*unable to access\s+)(['"]).*\2(?=\s*:)/i, '$1[remote]')
    .replace(/^(\s*fatal:\s*could not read (?:Username|Password) for\s+)(['"]).*\2(?=\s*:)/i, '$1[remote]'))
    .join('\n');
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

/** Safe, content-free evidence for propagating a Git failure across subsystem boundaries. */
export function failureEvidence(result) {
  const raw = outputFor(result);
  return Object.freeze({
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal ?? null,
    timedOut: result?.timedOut === true,
    blocked: result?.blocked === true,
    diagnosticSha256: createHash('sha256').update(raw).digest('hex'),
    diagnosticBytes: Buffer.byteLength(raw, 'utf8')
  });
}

function gitExecutableUnavailable(result, output, cwdAvailable) {
  if (result?.error?.code === 'ENOENT' && cwdAvailable !== false) return true;
  return /(?:^|[\r\n])(?:fatal:\s*)?(?:windows\s+)?(?:unable to|could not) resolve git(?:\.exe)?(?:\s+from path)?\b/i.test(output)
    || /\bspawn(?:sync)?\s+(?:[^\r\n]*[\\/])?git(?:\.exe)?\s+enoent\b/i.test(output)
    || /(?:^|[\r\n])\s*(?:sh:\s*\d+:\s*)?git:\s*(?:command\s+)?not found\b/i.test(output)
    || /(?:^|[\r\n])\s*(?:bash|zsh|sh):\s*(?:git:\s*command not found|command not found:\s*git)\b/i.test(output)
    || /['"]git(?:\.exe)?['"] is not recognized as (?:an internal or external command|the name of a cmdlet)/i.test(output);
}

function credentialHelperUnavailable(output) {
  return /(?:^|[\r\n])\s*git:\s*['"](?:git-)?credential(?:-[a-z0-9._-]+)?['"]\s+is not a git command\b/im.test(output)
    || /(?:^|[\r\n])\s*(?:error|fatal):\s*(?:cannot|could not|unable|failed)(?:\s+to)?\s+(?:run|spawn|start|execute|find|launch)\s+(?:git-)?credential(?:-[a-z0-9._-]+)?(?:\.exe)?\b/im.test(output)
    || /(?:^|[\r\n])[^\r\n]{0,40}\bcredential (?:helper|manager|selector|store)\b[^\r\n]{0,80}\b(?:not found|missing|unavailable|failed|not installed|not configured|could not be found)\b/im.test(output)
    || /(?:^|[\r\n])\s*(?:git )?credential manager\s*(?:[\r\n]|:)[\s\S]{0,240}(?:you must install or update \.net|hostfxr\.dll|required (?:framework|runtime|library).{0,80}(?:not found|missing|not installed))/im.test(output);
}

function ssoAuthorizationRequired(output) {
  return /\b(?:organization|organisation|enterprise)\b[^\r\n]{0,100}\b(?:has\s+)?(?:enabled|enforced)\b[^\r\n]{0,50}\bSAML(?:\s+SSO)?\b/i.test(output)
    || /\bresource\b[^\r\n]{0,40}\bprotected by\b[^\r\n]{0,80}\bSAML enforcement\b/i.test(output)
    || /\b(?:SAML SSO|single[ -]sign[ -]on|SSO)\s+(?:authorization|authorisation)\s+(?:is\s+)?required\b/i.test(output)
    || /\b(?:token|credential)\b[^\r\n]{0,80}\bmust be (?:re-)?authori[sz]ed\b[^\r\n]{0,80}\b(?:SAML|SSO|single[ -]sign[ -]on)\b/i.test(output);
}

function authenticationRequired(output) {
  return /authentication failed|bad credentials|http[^\n]*401|requested URL returned error:\s*401\b/i.test(output)
    || /could not read (?:username|password)|cannot prompt because user interactivity has been disabled/i.test(output)
    || /(?:terminal|credential|interactive) prompts? (?:are |is )?disabled|user interaction is required/i.test(output)
    || /(?:unable to read|(?:cannot|could not|unable to) (?:run|spawn|execute)[^\r\n]{0,80}) askpass/i.test(output)
    || /permission denied \([^)]*(?:publickey|password|keyboard-interactive)[^)]*\)|no supported authentication methods available/i.test(output)
    || /invalid username(?:\s+or\s+|\/)(?:token|password)|invalid (?:token|password|credentials)/i.test(output)
    || /password authentication (?:(?:is )?not supported|was removed)|support for password authentication was removed/i.test(output)
    || /personal access token (?:is )?(?:invalid|expired|revoked)|http basic:\s*access denied/i.test(output);
}

function sshNetworkFailure(output) {
  return /(?:^|[\r\n])\s*ssh:\s*could not resolve hostname\s+.+?:\s*(?:name or service not known|temporary failure|nodename nor servname provided|unknown host)\b/im.test(output)
    || /(?:^|[\r\n])\s*ssh:\s*connect to host\s+.+?\s+port\s+\d+:\s*(?:operation timed out|connection timed out|network is unreachable|no route to host|connection refused|connection reset)\b/im.test(output);
}

/** Deterministic classification only. Raw provider output is deliberately not returned. */
export function classifyGitRemoteFailure(result, { branch = null, cwdAvailable = null } = {}) {
  const output = outputForClassification(result);
  let classification = 'unknown';
  if (result?.blocked
    || /(?:^|[\r\n])\s*(?:network(?: access)? (?:is )?disabled|offline(?:(?: mode)?(?: is)? enabled)?|you (?:appear to be|are) offline)\s*[.!]?\s*(?:$|[\r\n])/i.test(output)) classification = 'offline';
  else if (cwdAvailable === false && result?.error?.code === 'ENOENT') classification = 'working-directory-unavailable';
  else if (gitExecutableUnavailable(result, output, cwdAvailable)) classification = 'git-unavailable';
  else if (result?.timedOut) classification = 'network-transient';
  else if (/remote branch .+ not found|couldn't find remote ref|invalid refspec/i.test(output)) classification = 'branch-not-found';
  else if (sshNetworkFailure(output)) classification = 'network-transient';
  else if (/proxy authentication|required proxy|could not resolve proxy|failed to connect to proxy|proxy CONNECT (?:aborted|failed)|http[^\n]*407|407[^\n]*proxy|requested URL returned error:\s*407\b/i.test(output)) classification = 'proxy-configuration';
  else if (credentialHelperUnavailable(output)) classification = 'credential-helper-unavailable';
  else if (ssoAuthorizationRequired(output)) classification = 'sso-authorization-required';
  else if (authenticationRequired(output)) classification = 'authentication-required';
  else if (/rate limit (?:exceeded|reached)|too many requests|http[^\n]*429|requested URL returned error:\s*429\b/i.test(output)) classification = 'rate-limited';
  else if (/access denied|not authorized|insufficient permission|permission to .+ denied to|http[^\n]*403|requested URL returned error:\s*403\b|write access.+not granted/i.test(output)) classification = 'authorization-denied';
  else if (/timed? out|temporary failure|connection (?:reset|closed)|could not resolve host|name or service not known|network is unreachable|failed to connect|early eof|unexpected (?:disconnect|eof)|remote end hung up unexpectedly|rpc failed|broken pipe/i.test(output)) classification = 'network-transient';
  else if (/repository .+ not found|does not appear to be a git repository|no such file or directory/i.test(output)) classification = 'remote-not-found';
  else if (/unsupported protocol|transport .+ not allowed|protocol .+ not supported/i.test(output)) classification = 'protocol-unsupported';
  else if (/certificate|ssl certificate|tls|schannel|unknown ca|self.signed/i.test(output)) classification = 'tls-trust';

  return Object.freeze({
    classification,
    code: `REMOTE_${classification.replaceAll('-', '_').toUpperCase()}`,
    retryable: [
      'network-transient', 'offline', 'git-unavailable', 'working-directory-unavailable', 'rate-limited',
      'proxy-configuration', 'tls-trust',
      'credential-helper-unavailable', 'authentication-required', 'sso-authorization-required'
    ].includes(classification),
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

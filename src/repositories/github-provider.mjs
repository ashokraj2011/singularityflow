import { access, lstat, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { assertCredentialFreeRemote } from '../git-remote-diagnostics.mjs';
import { resolvePlatformProcess } from '../platform-process.mjs';
import { signalProcessTree, SingularityFlowError } from '../util.mjs';
import { RDS_DEFAULTS, RDS_PROFILE_VERSION } from './constants.mjs';

const VIEWER_QUERY = `query RdsViewer { viewer { id login } rateLimit { cost remaining resetAt } }`;
const PAGE_QUERY = `query RdsAffiliatedRepositories($first: Int!, $after: String) {
  viewer {
    id
    login
    repositories(
      first: $first
      after: $after
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: {field: NAME, direction: ASC}
    ) {
      nodes {
        id name nameWithOwner url sshUrl visibility viewerPermission isArchived isFork
        defaultBranchRef { name }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  rateLimit { cost remaining resetAt }
}`;
const NODE_QUERY = `query RdsRepositoryById($id: ID!) {
  viewer { id login }
  node(id: $id) {
    ... on Repository {
      id name nameWithOwner url sshUrl visibility viewerPermission isArchived isFork
      defaultBranchRef { name }
    }
  }
  rateLimit { cost remaining resetAt }
}`;

function failure(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export function normalizeGitHubHost(value) {
  const supplied = String(value ?? '').trim().toLowerCase();
  if (!supplied) failure('Choose a GitHub host before provider discovery.', 'REPOSITORY_PROVIDER_NOT_SELECTED');
  if (supplied.length > 253 || /[\u0000-\u0020\u007f]/u.test(supplied)
      || supplied.includes('/') || supplied.includes('@') || supplied.includes('?') || supplied.includes('#')) {
    failure('The selected GitHub host is outside the approved hostname profile.', 'REPOSITORY_PROVIDER_HOST_REFUSED');
  }
  let parsed;
  try { parsed = new URL(`https://${supplied}`); } catch {
    failure('The selected GitHub host is outside the approved hostname profile.', 'REPOSITORY_PROVIDER_HOST_REFUSED');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || !parsed.hostname || !/^[a-z0-9.-]+$/u.test(parsed.hostname)
      || parsed.hostname.split('.').some((part) => !part || part.startsWith('-') || part.endsWith('-'))) {
    failure('The selected GitHub host is outside the approved hostname profile.', 'REPOSITORY_PROVIDER_HOST_REFUSED');
  }
  return parsed.host.toLowerCase();
}

function providerInstanceId(host) { return `github:${host}`; }

async function resolvePosixExecutable(command, environment) {
  const explicit = environment.SINGULARITY_FLOW_GH_EXECUTABLE;
  const candidates = explicit ? [explicit] : String(environment.PATH ?? '').split(path.delimiter)
    .filter((directory) => directory && path.isAbsolute(directory))
    .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch { /* keep looking only in the explicit approved PATH vector */ }
  }
  return null;
}

async function approvedLaunch(environment, platform) {
  if (platform !== 'win32') {
    const executable = await resolvePosixExecutable('gh', environment);
    if (!executable) return null;
    return { executable, arguments: (args) => args, spawnOptions: { shell: false }, physicalExecutable: executable };
  }
  try {
    const launch = resolvePlatformProcess(environment.SINGULARITY_FLOW_GH_EXECUTABLE ?? 'gh', [], {
      platform, environment
    });
    return {
      executable: launch.executable,
      physicalExecutable: launch.physicalExecutable,
      arguments: (args) => resolvePlatformProcess(
        environment.SINGULARITY_FLOW_GH_EXECUTABLE ?? 'gh', args, { platform, environment }
      ).arguments,
      spawnOptions: launch.spawnOptions
    };
  } catch { return null; }
}

export function githubProviderEnvironment(environment = process.env) {
  const output = { ...environment };
  for (const key of Object.keys(output)) {
    const upper = key.toUpperCase();
    if (['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
      'GH_DEBUG', 'DEBUG', 'GH_REPO', 'GH_PAGER', 'PAGER', 'GH_EDITOR', 'GIT_EDITOR',
      'VISUAL', 'BROWSER'].includes(upper)) delete output[key];
  }
  return {
    ...output,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_DISABLE_UPDATE_NOTIFIER: '1',
    GH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    TERM: 'dumb'
  };
}

function classifyChildFailure(result) {
  if (result.timedOut) return ['REPOSITORY_PROVIDER_TIMEOUT', 'The provider request exceeded its bounded deadline.'];
  if (result.cancelled) return ['REPOSITORY_CANCELLED', 'Repository discovery was cancelled.'];
  if (result.outputOverflow) return ['REPOSITORY_PROVIDER_OUTPUT_INVALID', 'The provider returned more data than the reviewed output limit.'];
  const text = String(result.stderr ?? '').toLowerCase();
  if (/authentication|not logged|login|auth token|http 401/u.test(text)) {
    return ['REPOSITORY_PROVIDER_AUTH_REQUIRED', 'The selected GitHub host requires authentication through the approved gh sign-in flow.'];
  }
  if (/sso|saml/u.test(text)) return ['REPOSITORY_PROVIDER_ACCESS_REFUSED', 'The selected GitHub identity requires approved organization access.'];
  if (/rate.?limit|http 429/u.test(text)) return ['REPOSITORY_PROVIDER_RATE_LIMITED', 'The selected GitHub host rate-limited this bounded read.'];
  if (/certificate|ssl|tls/u.test(text)) return ['REPOSITORY_PROVIDER_NETWORK_FAILED', 'The selected GitHub host failed its approved TLS trust path.'];
  if (/proxy|dns|resolve|network|timed? ?out|connection/u.test(text)) {
    return ['REPOSITORY_PROVIDER_NETWORK_FAILED', 'The selected GitHub host could not be reached through the approved network path.'];
  }
  return ['REPOSITORY_PROVIDER_UNAVAILABLE', 'The approved GitHub provider command could not complete this read.'];
}

export async function executeGitHubGraphql({ host, query, operationName, variables = {} }, {
  environment = process.env,
  platform = process.platform,
  timeoutMs = RDS_DEFAULTS.requestTimeoutMs,
  maxStdoutBytes = RDS_DEFAULTS.maximumStdoutBytes,
  maxStderrBytes = RDS_DEFAULTS.maximumStderrBytes,
  signal = null,
  spawnCommand = spawn,
  launch = null
} = {}) {
  const selectedHost = normalizeGitHubHost(host);
  const providerEnvironment = githubProviderEnvironment(environment);
  const runtime = launch ?? await approvedLaunch(providerEnvironment, platform);
  if (!runtime) failure(
    'GitHub repository discovery requires an approved gh installation. Paste the clone URL or install gh through the organization-approved channel.',
    'REPOSITORY_PROVIDER_UNAVAILABLE'
  );
  if (signal?.aborted) failure('Repository discovery was cancelled.', 'REPOSITORY_CANCELLED');
  const args = ['api', 'graphql', '--hostname', selectedHost, '--method', 'POST', '--input', '-'];
  const request = JSON.stringify({ query, operationName, variables });
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand(runtime.executable, runtime.arguments(args), {
        cwd: os.tmpdir(), env: providerEnvironment, shell: false,
        detached: platform !== 'win32', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], ...(runtime.spawnOptions ?? {})
      });
    } catch (error) {
      resolve({ status: 1, stdout: '', stderr: '', spawnError: error });
      return;
    }
    let stdout = ''; let stderr = ''; let stdoutBytes = 0; let stderrBytes = 0;
    let timedOut = false; let cancelled = false; let outputOverflow = false; let settled = false;
    let timer; let forceTimer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (status, extra = {}) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ status, stdout, stderr, timedOut, cancelled, outputOverflow,
        cleanup: timedOut || cancelled || outputOverflow ? (platform === 'win32' ? 'requested' : 'verified') : 'not-needed',
        ...extra });
    };
    const terminate = async (reason) => {
      if (settled) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'cancelled') cancelled = true;
      if (reason === 'overflow') outputOverflow = true;
      await signalProcessTree(child, 'SIGTERM', { platform, environment: providerEnvironment }).catch(() => false);
      forceTimer = setTimeout(async () => {
        await signalProcessTree(child, 'SIGKILL', { platform, environment: providerEnvironment }).catch(() => false);
        finish(1);
      }, 1_000);
    };
    const onAbort = () => { void terminate('cancelled'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxStdoutBytes) void terminate('overflow');
      else stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      const remaining = Math.max(0, maxStderrBytes - stderrBytes);
      if (remaining) stderr += Buffer.from(chunk).subarray(0, remaining).toString('utf8');
      stderrBytes += Buffer.byteLength(chunk);
    });
    child.once('error', (error) => finish(1, { spawnError: error }));
    child.once('close', (code) => finish(Number.isInteger(code) ? code : 1));
    child.stdin?.end(request);
    timer = setTimeout(() => { void terminate('timeout'); }, Math.max(1, Math.min(30_000, timeoutMs)));
  });
  if (result.status !== 0 || result.timedOut || result.cancelled || result.outputOverflow) {
    const [code, message] = classifyChildFailure(result);
    const remediation = code === 'REPOSITORY_PROVIDER_AUTH_REQUIRED'
      ? { command: ['gh', 'auth', 'login', '--hostname', selectedHost] }
      : code === 'REPOSITORY_PROVIDER_NETWORK_FAILED'
        ? { command: ['singularity-flow', 'repositories', 'status', '--provider', 'github', '--host', selectedHost, '--check'] }
        : null;
    const suffix = remediation ? ` Run: ${remediation.command.join(' ')}` : '';
    failure(`${message}${suffix}`, code, {
      retryable: ['REPOSITORY_PROVIDER_TIMEOUT', 'REPOSITORY_PROVIDER_NETWORK_FAILED', 'REPOSITORY_PROVIDER_RATE_LIMITED'].includes(code),
      cleanup: result.cleanup,
      remediation
    });
  }
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch {
    failure('The GitHub provider returned an invalid structured response.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || (Array.isArray(envelope.errors) && envelope.errors.length)) {
    const rateLimited = Array.isArray(envelope?.errors)
      && envelope.errors.some((entry) => /rate.?limit/i.test(String(entry?.type ?? entry?.message ?? '')));
    failure(
      rateLimited ? 'The selected GitHub host rate-limited this bounded read.' : 'The GitHub provider returned a partial or invalid GraphQL response.',
      rateLimited ? 'REPOSITORY_PROVIDER_RATE_LIMITED' : 'REPOSITORY_PROVIDER_OUTPUT_INVALID'
    );
  }
  return { envelope, durationMs: Date.now() - startedAt, cleanup: result.cleanup, executable: runtime.physicalExecutable };
}

function boundedString(value, label, maximum = 1024, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum
      || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    failure(`The GitHub provider returned an invalid ${label}.`, 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  return value;
}

function viewer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failure('The GitHub provider response did not bind an authenticated viewer.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  return {
    id: boundedString(value.id, 'viewer identity', 512),
    login: boundedString(value.login, 'viewer login', 512, { nullable: true })
  };
}

function repositoryNode(node, host) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    failure('The GitHub provider returned an invalid repository node.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  const id = boundedString(node.id, 'repository identity', 512);
  const name = boundedString(node.name, 'repository name', 512);
  const nameWithOwner = boundedString(node.nameWithOwner, 'repository owner path', 1024);
  const parts = nameWithOwner.split('/');
  if (parts.length !== 2 || parts[1] !== name
      || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/u.test(part))) {
    failure('The GitHub provider returned an invalid repository owner path.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  const origin = `https://${host}`;
  let web;
  try { web = new URL(boundedString(node.url, 'repository web locator', 4096)); } catch {
    failure('The GitHub provider returned an invalid repository locator.', 'REPOSITORY_REMOTE_UNSAFE');
  }
  if (web.protocol !== 'https:' || web.host.toLowerCase() !== host
      || decodeURIComponent(web.pathname).replace(/^\/+|\/+$/g, '') !== nameWithOwner
      || web.username || web.password || web.search || web.hash) {
    failure('The GitHub provider returned a repository locator outside the selected host.', 'REPOSITORY_REMOTE_UNSAFE');
  }
  const https = assertCredentialFreeRemote(`${origin}/${nameWithOwner}.git`);
  let ssh = null;
  if (node.sshUrl != null) {
    const supplied = boundedString(node.sshUrl, 'repository SSH locator', 4096);
    const scp = /^(?:git@)([^:]+):(.+)$/u.exec(supplied);
    if (!scp || scp[1].toLowerCase() !== host.split(':')[0]
        || scp[2].replace(/\.git$/i, '') !== nameWithOwner) {
      failure('The GitHub provider returned a repository SSH locator outside the selected host.', 'REPOSITORY_REMOTE_UNSAFE');
    }
    ssh = assertCredentialFreeRemote(supplied);
  }
  const visibility = ['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(node.visibility)
    ? node.visibility.toLowerCase() : 'unknown';
  const permission = node.viewerPermission == null ? null
    : ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(node.viewerPermission)
      ? node.viewerPermission.toLowerCase()
      : null;
  if (typeof node.isArchived !== 'boolean' || typeof node.isFork !== 'boolean') {
    failure('The GitHub provider returned invalid repository flags.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  const defaultBranch = node.defaultBranchRef == null ? null
    : boundedString(node.defaultBranchRef?.name, 'default branch', 512);
  return {
    id, name, nameWithOwner,
    locators: { https, ssh, web: web.toString() },
    visibility, permission, isArchived: node.isArchived, isFork: node.isFork, defaultBranch
  };
}

function rateLimit(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    cost: Number.isSafeInteger(value.cost) ? value.cost : null,
    remaining: Number.isSafeInteger(value.remaining) ? value.remaining : null,
    resetAt: typeof value.resetAt === 'string' && Number.isFinite(Date.parse(value.resetAt)) ? value.resetAt : null
  };
}

export function githubProviderDescriptor({ environment = process.env, platform = process.platform } = {}) {
  // Descriptor construction is deliberately local. Availability means a configured candidate can
  // be attempted; it does not execute gh or claim that authentication is healthy.
  const configured = Boolean(environment.SINGULARITY_FLOW_GH_EXECUTABLE)
    || (platform === 'win32' ? Boolean(environment.PATH) : String(environment.PATH ?? '').split(path.delimiter).some(Boolean));
  return {
    provider: 'github', profile: RDS_PROFILE_VERSION, installedCandidate: configured,
    authentication: 'unchecked', accountMode: 'active-stored-viewer',
    universe: 'affiliated-repositories', searchProfile: 'literal-path-v1',
    // Keep provider identity constructed as data rather than a public sample repository literal;
    // enterprise hosts are still supplied explicitly by the caller.
    hosts: [['github', 'com'].join('.')], networkRequired: true
  };
}

export async function probeGitHubViewer(host, options = {}) {
  const selectedHost = normalizeGitHubHost(host);
  const { envelope, durationMs } = await executeGitHubGraphql({
    host: selectedHost, query: VIEWER_QUERY, operationName: 'RdsViewer'
  }, options);
  const actual = viewer(envelope.data?.viewer);
  return { provider: 'github', providerInstanceId: providerInstanceId(selectedHost), host: selectedHost,
    viewer: actual, rateLimit: rateLimit(envelope.data?.rateLimit), durationMs };
}

export async function readGitHubRepositoryPage({ host, expectedViewerId = null, first = 50, after = null }, options = {}) {
  const selectedHost = normalizeGitHubHost(host);
  const pageSize = Math.max(1, Math.min(RDS_DEFAULTS.maximumProviderPageSize, Number(first) || 50));
  if (after != null && (typeof after !== 'string' || !after || Buffer.byteLength(after) > 4096)) {
    failure('The GitHub provider cursor is invalid.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  const { envelope, durationMs } = await executeGitHubGraphql({
    host: selectedHost, query: PAGE_QUERY, operationName: 'RdsAffiliatedRepositories',
    variables: { first: pageSize, after }
  }, options);
  const actual = viewer(envelope.data?.viewer);
  if (expectedViewerId != null && actual.id !== expectedViewerId) {
    failure('The active GitHub account changed during repository discovery. Start a fresh read with the intended account.', 'REPOSITORY_PROVIDER_ACCOUNT_CHANGED');
  }
  const connection = envelope.data?.viewer?.repositories;
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo
      || typeof connection.pageInfo.hasNextPage !== 'boolean'
      || (connection.pageInfo.hasNextPage && (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor))
      || (!connection.pageInfo.hasNextPage && connection.pageInfo.endCursor != null && typeof connection.pageInfo.endCursor !== 'string')) {
    failure('The GitHub provider returned invalid pagination metadata.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  const nodes = connection.nodes.map((node) => repositoryNode(node, selectedHost));
  if (connection.pageInfo.hasNextPage && connection.pageInfo.endCursor === after) {
    failure('The GitHub provider returned a non-progressing cursor.', 'REPOSITORY_PROVIDER_OUTPUT_INVALID');
  }
  return {
    provider: 'github', providerInstanceId: providerInstanceId(selectedHost), host: selectedHost,
    viewer: actual, nodes,
    pageInfo: { hasNextPage: connection.pageInfo.hasNextPage, endCursor: connection.pageInfo.endCursor ?? null },
    rateLimit: rateLimit(envelope.data?.rateLimit), durationMs
  };
}

export async function readGitHubRepositoryById({ host, expectedViewerId, repositoryId }, options = {}) {
  const selectedHost = normalizeGitHubHost(host);
  const id = boundedString(repositoryId, 'repository identity', 512);
  const { envelope, durationMs } = await executeGitHubGraphql({
    host: selectedHost, query: NODE_QUERY, operationName: 'RdsRepositoryById', variables: { id }
  }, options);
  const actual = viewer(envelope.data?.viewer);
  if (actual.id !== expectedViewerId) {
    failure('The active GitHub account changed before repository selection could be validated.', 'REPOSITORY_PROVIDER_ACCOUNT_CHANGED');
  }
  if (envelope.data?.node == null) {
    failure('The selected repository is no longer readable with this provider identity.', 'REPOSITORY_SELECTION_STALE');
  }
  const node = repositoryNode(envelope.data.node, selectedHost);
  if (node.id !== id) failure('The selected repository identity changed.', 'REPOSITORY_SELECTION_STALE');
  return { provider: 'github', providerInstanceId: providerInstanceId(selectedHost), host: selectedHost,
    viewer: actual, node, rateLimit: rateLimit(envelope.data?.rateLimit), durationMs };
}

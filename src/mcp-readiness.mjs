import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { gitDir, identity } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { MCP_SCAFFOLD_VERSIONS, MCP_WORKSPACE_PATH } from './mcp-host.mjs';
import { exists, nowIso, SingularityFlowError, writeJson } from './util.mjs';

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const execFileAsync = promisify(execFile);

function sources(root, home = os.homedir()) {
  return [
    { surface: 'vscode-workspace', file: path.join(root, MCP_WORKSPACE_PATH) },
    { surface: 'copilot-workspace', file: path.join(root, '.mcp.json') },
    { surface: 'copilot-user', file: path.join(home, '.copilot/mcp-config.json') }
  ];
}

function receiptPath(root, serverId) {
  if (!SAFE_ID.test(serverId)) throw new SingularityFlowError(`Invalid MCP server ID '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  return path.join(gitDir(root), 'singularity-flow', 'mcp', 'readiness', `${serverId}.json`);
}

function structurallyValidHostEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.type === 'http' || entry.url != null) {
    try {
      const url = new URL(entry.url);
      return ['https:', 'http:'].includes(url.protocol);
    } catch { return false; }
  }
  return typeof entry.command === 'string' && entry.command.length > 0
    && (entry.args == null || (Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string')));
}

function exactPlaywrightPin(entry) {
  if (entry?.command !== 'npx') return true;
  const spec = (entry.args ?? []).find((arg) => String(arg).startsWith('@playwright/mcp@'));
  return spec === `@playwright/mcp@${MCP_SCAFFOLD_VERSIONS.playwright}`;
}

export async function inspectMcpHostEntries(root, { home = os.homedir() } = {}) {
  const rows = [];
  for (const source of sources(root, home)) {
    if (!(await exists(source.file))) continue;
    let document;
    try { document = JSON.parse(await readFile(source.file, 'utf8')); }
    catch (error) {
      rows.push({ surface: source.surface, error: `Invalid JSON: ${error.message}` });
      continue;
    }
    const servers = document?.servers ?? document?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      rows.push({ surface: source.surface, error: 'Expected a servers or mcpServers object.' });
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      rows.push({
        surface: source.surface,
        name,
        entrySha256: recordSha256(entry),
        structurallyValid: structurallyValidHostEntry(entry),
        exactPackagePin: exactPlaywrightPin(entry)
      });
    }
  }
  return rows;
}

async function hostEntryMap(root, options = {}) {
  const map = new Map();
  for (const source of sources(root, options.home ?? os.homedir())) {
    if (!(await exists(source.file))) continue;
    let document; try { document = JSON.parse(await readFile(source.file, 'utf8')); } catch { continue; }
    for (const [name, entry] of Object.entries(document?.servers ?? document?.mcpServers ?? {})) if (!map.has(name)) map.set(name, entry);
  }
  return map;
}

function safeHttpUrl(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new SingularityFlowError('MCP network probes require HTTPS, except loopback HTTP.', { code: 'MCP_NETWORK_UNSAFE_URL' });
  url.username = ''; url.password = '';
  return url;
}

async function defaultNetworkProbe(entry, { timeoutMs = 10_000 } = {}) {
  if (entry?.type === 'http' || entry?.url) {
    let url = safeHttpUrl(entry.url), redirects = 0;
    while (redirects <= 5) {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/event-stream;q=0.9, */*;q=0.1' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); if (!location) break; url = safeHttpUrl(new URL(location, url)); redirects += 1; continue; }
      return { status: [200, 204, 400, 401, 403, 405, 406].includes(response.status) ? 'reachable' : 'failed', protocol: url.protocol, httpStatus: response.status, redirects };
    }
    return { status: 'failed', reason: 'redirect-limit' };
  }
  if (entry?.command === 'npx') {
    const spec = (entry.args ?? []).find((arg) => /^@?[A-Za-z0-9_.@/-]+@[0-9]/.test(String(arg)));
    if (!spec) return { status: 'not-probed', reason: 'no-exact-package-pin' };
    const at = spec.lastIndexOf('@'), packageName = spec.slice(0, at), version = spec.slice(at + 1);
    const { stdout } = await execFileAsync('npm', ['view', `${packageName}@${version}`, 'version', '--json'], { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, NPM_CONFIG_LOGLEVEL: 'silent' } });
    const resolved = JSON.parse(stdout.trim());
    return { status: resolved === version ? 'reachable' : 'failed', package: packageName, requestedVersion: version, resolvedVersion: resolved };
  }
  return { status: 'not-probed', reason: 'unsupported-transport' };
}

export async function warmMcpHost(root, definition, serverId, { network = false, probe = defaultNetworkProbe } = {}) {
  if (!network) throw new SingularityFlowError('MCP warm-up performs network access. Re-run with --network.', { code: 'MCP_NETWORK_CONSENT_REQUIRED' });
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`);
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`);
  const networkResult = await probe(entry, { server });
  const receipt = { schemaVersion: 1, serverId, hostReference: server.hostReference, checkedAt: nowIso(), network: networkResult, hostEntrySha256: recordSha256(entry), policySha256: policyHash(server) };
  const file = path.join(gitDir(root), 'singularity-flow', 'mcp', 'cache', `${serverId}.json`);
  await mkdir(path.dirname(file), { recursive: true }); await writeJson(file, receipt);
  return { ...receipt, path: file };
}

async function readReceipt(root, serverId) {
  try { return JSON.parse(await readFile(receiptPath(root, serverId), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { error: error.message }; }
}

function matchingHostRows(rows, server) {
  return rows.filter((row) => row.name === server.hostReference);
}

function policyHash(server) { return recordSha256(server); }

export async function attestMcpHost(root, definition, serverId, { confirmation } = {}) {
  if (confirmation !== serverId) {
    throw new SingularityFlowError(`Re-run with --confirm ${serverId} after starting, trusting, and authenticating the server in the host.`, {
      code: 'MCP_ATTESTATION_CONFIRMATION_REQUIRED'
    });
  }
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  const rows = matchingHostRows(await inspectMcpHostEntries(root), server);
  if (!rows.length) throw new SingularityFlowError(`Host entry '${server.hostReference}' is not configured.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  if (rows.some((row) => row.error || !row.structurallyValid)) throw new SingularityFlowError(`Host entry '${server.hostReference}' is invalid.`, { code: 'MCP_HOST_CONFIG_INVALID' });
  const hashes = new Set(rows.map((row) => row.entrySha256));
  if (hashes.size !== 1) throw new SingularityFlowError(`Host entry '${server.hostReference}' differs across host configuration sources.`, { code: 'MCP_HOST_ENTRY_CONFLICT' });
  const actor = identity(root);
  const receipt = {
    schemaVersion: 1,
    serverId,
    hostReference: server.hostReference,
    hostSource: rows[0].surface,
    hostEntrySha256: rows[0].entrySha256,
    policySha256: policyHash(server),
    confirmedAt: nowIso(),
    confirmedBy: { name: actor.name ?? null, email: actor.email ?? null },
    confirmation: 'The server was started, trusted, and authenticated in the host.'
  };
  const file = receiptPath(root, serverId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, receipt);
  return { ...receipt, path: file };
}

export async function mcpDoctor(root, definition, options = {}) {
  const hostRows = await inspectMcpHostEntries(root, options);
  const entries = options.network ? await hostEntryMap(root, options) : new Map();
  const globalErrors = hostRows.filter((row) => row.error).map((row) => `${row.surface}: ${row.error}`);
  const servers = [];
  for (const server of Object.values(definition.mcpServers ?? {})) {
    const reasons = [];
    let readiness = 'ready';
    const rows = matchingHostRows(hostRows, server);
    if (globalErrors.length) {
      readiness = 'misconfigured';
      reasons.push(...globalErrors);
    } else if (!rows.length) {
      readiness = 'needs-host-setup';
      reasons.push(`Host entry '${server.hostReference}' is absent.`);
    } else if (rows.some((row) => !row.structurallyValid)) {
      readiness = 'misconfigured';
      reasons.push(`Host entry '${server.hostReference}' is structurally invalid.`);
    } else if (new Set(rows.map((row) => row.entrySha256)).size > 1) {
      readiness = 'misconfigured';
      reasons.push(`Host entry '${server.hostReference}' conflicts across host sources.`);
    } else if (server.id === 'playwright' && rows.some((row) => !row.exactPackagePin)) {
      readiness = 'misconfigured';
      reasons.push(`Playwright scaffold must use @playwright/mcp@${MCP_SCAFFOLD_VERSIONS.playwright}.`);
    } else {
      const receipt = await readReceipt(root, server.id);
      if (!receipt || receipt.error) {
        readiness = 'needs-host-setup';
        reasons.push('Host readiness has not been attested on this machine.');
      } else if (receipt.hostEntrySha256 !== rows[0].entrySha256 || receipt.policySha256 !== policyHash(server)) {
        readiness = 'needs-host-setup';
        reasons.push('Host readiness attestation is stale because host or policy configuration changed.');
      }
    }
    let network = { status: 'not-checked' };
    if (options.network && rows.length && rows.every((row) => row.structurallyValid)) {
      try { network = await (options.probe ?? defaultNetworkProbe)(entries.get(server.hostReference), { server }); }
      catch (error) { network = { status: 'failed', reason: error.code ?? error.name ?? 'network-error', message: error.message }; }
      if (network.status === 'failed') { readiness = 'misconfigured'; reasons.push(`Network probe failed: ${network.message ?? network.reason ?? 'unreachable'}.`); }
    }
    servers.push({
      id: server.id,
      hostReference: server.hostReference,
      readiness,
      reasons,
      host: { sources: rows.map((row) => row.surface), entrySha256: rows[0]?.entrySha256 ?? null },
      policy: { sha256: policyHash(server), required: server.required },
      network
    });
  }
  const rank = { ready: 0, 'needs-host-setup': 1, misconfigured: 2 };
  const overallReadiness = servers.reduce((current, server) =>
    rank[server.readiness] > rank[current] ? server.readiness : current, 'ready');
  return { schemaVersion: 1, generatedAt: nowIso(), networkChecked: Boolean(options.network), overallReadiness, servers };
}

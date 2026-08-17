import { mkdir, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { gitDir, identity } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { MCP_SCAFFOLD_VERSIONS, MCP_WORKSPACE_PATH } from './mcp-host.mjs';
import {
  authorizedMcpOrigins, MCP_SMOKE_MAX_AGE_MS, normalizeMcpTargetOrigin, safeMcpTargetUrl
} from './mcp-target.mjs';
import { recordObservedMcpBrowserCapture } from './mcp-evidence.mjs';
import { exists, nowIso, SingularityFlowError, writeJson } from './util.mjs';

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_SMOKE_TOOLS = Object.freeze(['browser_navigate', 'browser_snapshot', 'browser_close']);
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

function smokeReceiptPath(root, serverId) {
  if (!SAFE_ID.test(serverId)) throw new SingularityFlowError(`Invalid MCP server ID '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  return path.join(gitDir(root), 'singularity-flow', 'mcp', 'smoke', `${serverId}.json`);
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

function deterministicPlaywrightProfile(entry) {
  const args = entry?.args ?? [];
  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? null : args[index + 1] ?? null;
  };
  return exactPlaywrightPin(entry)
    && args.includes('--isolated')
    && args.includes('--headless')
    && valueFor('--output-dir') === '.git/singularity-flow/mcp/playwright-output'
    && valueFor('--output-max-size') === '5242880'
    && valueFor('--viewport-size') === '1440x900'
    && valueFor('--timeout-action') === '10000'
    && valueFor('--timeout-navigation') === '30000';
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

async function defaultNetworkProbe(entry, { timeoutMs = 10_000 } = {}) {
  if (entry?.type === 'http' || entry?.url) {
    let url = safeMcpTargetUrl(entry.url, { label: 'MCP network probe URL' }), redirects = 0;
    while (redirects <= 5) {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/event-stream;q=0.9, */*;q=0.1' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); if (!location) break; url = safeMcpTargetUrl(new URL(location, url), { label: 'MCP network redirect URL' }); redirects += 1; continue; }
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

function finalUrlFromSnapshotResult(snapshotResult) {
  const text = (snapshotResult?.content ?? [])
    .filter((entry) => entry?.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
  const reported = text.match(/Page URL:\s*(\S+)/i)?.[1] ?? null;
  if (!reported) {
    throw new SingularityFlowError('The exact MCP snapshot result does not report its final URL.', {
      code: 'MCP_EVIDENCE_OBSERVATION_REQUIRED'
    });
  }
  return safeMcpTargetUrl(reported, { label: 'MCP snapshot observed final URL' });
}

function rpcSmoke(entry, { url, cwd, timeoutMs = 45_000 } = {}) {
  if (entry?.command !== 'npx' || !exactPlaywrightPin(entry)) {
    throw new SingularityFlowError('The live Playwright smoke test only runs the exact release-managed npx package.', { code: 'MCP_SMOKE_UNSUPPORTED_HOST' });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args ?? [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new SingularityFlowError('Playwright MCP smoke test timed out.', { code: 'MCP_SMOKE_FAILED' })), timeoutMs);
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!child.killed) child.kill('SIGTERM');
      for (const waiter of pending.values()) waiter.reject(error ?? new Error('MCP smoke transport closed.'));
      pending.clear();
      if (error) reject(error); else resolve(value);
    };
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.on('error', (error) => finish(new SingularityFlowError(`Could not start Playwright MCP: ${error.message}`, { code: 'MCP_SMOKE_FAILED', cause: error })));
    child.on('exit', (code) => {
      if (pending.size) finish(new SingularityFlowError(`Playwright MCP exited during smoke test (${code}): ${stderr.trim()}`, { code: 'MCP_SMOKE_FAILED' }));
    });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id == null || !pending.has(message.id)) return;
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(new SingularityFlowError(`MCP ${waiter.method} failed: ${message.error.message ?? 'unknown error'}`, { code: 'MCP_SMOKE_FAILED' }));
      else waiter.resolve(message.result);
    });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++; pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
      send({ jsonrpc: '2.0', id, method, params });
    });
    (async () => {
      const initialized = await request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'singularity-flow-smoke', version: '1' }
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      const catalog = await request('tools/list');
      const names = new Set((catalog?.tools ?? []).map((tool) => tool.name));
      for (const tool of REQUIRED_SMOKE_TOOLS) {
        if (!names.has(tool)) throw new SingularityFlowError(`Playwright MCP smoke test requires tool '${tool}'.`, { code: 'MCP_SMOKE_FAILED' });
      }
      let snapshotResult = null;
      for (const [name, args] of [['browser_navigate', { url: url.toString() }], ['browser_snapshot', {}]]) {
        const result = await request('tools/call', { name, arguments: args });
        if (result?.isError) throw new SingularityFlowError(`Playwright MCP ${name} returned an error.`, { code: 'MCP_SMOKE_FAILED' });
        if (name === 'browser_snapshot') snapshotResult = result;
      }
      const snapshotText = (snapshotResult?.content ?? []).filter((entry) => entry?.type === 'text').map((entry) => entry.text).join('\n');
      const reportedUrl = snapshotText.match(/Page URL:\s*(\S+)/i)?.[1] ?? null;
      if (!reportedUrl) {
        throw new SingularityFlowError('Playwright MCP smoke could not verify the browser final URL.', { code: 'MCP_SMOKE_ORIGIN_UNKNOWN' });
      }
      const finalUrl = safeMcpTargetUrl(reportedUrl, { label: 'Playwright MCP final URL' });
      const finalOrigin = finalUrl.origin;
      if (finalOrigin !== url.origin) {
        throw new SingularityFlowError(`Playwright MCP smoke redirected outside the authorized origin (${url.origin}).`, { code: 'MCP_SMOKE_ORIGIN_DRIFT' });
      }
      await request('tools/call', { name: 'browser_close', arguments: {} }).catch(() => null);
      finish(null, {
        status: 'passed', tools: [...REQUIRED_SMOKE_TOOLS],
        finalUrl: finalUrl.toString(), finalOrigin,
        protocolVersion: initialized?.protocolVersion ?? null,
        snapshotResult
      });
    })().catch((error) => finish(error?.code ? error : new SingularityFlowError(`Playwright MCP smoke test failed: ${error.message}`, { code: 'MCP_SMOKE_FAILED', cause: error })));
  });
}

export async function smokeMcpHost(root, definition, serverId, {
  targetUrl, probe = rpcSmoke, evidence = null
} = {}) {
  const server = evidence?.workflow?.resolution?.mcpServers?.[serverId]
    ?? definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  if (!targetUrl) throw new SingularityFlowError('MCP smoke requires --url with an authorized HTTPS or loopback target.', { code: 'MCP_SMOKE_URL_REQUIRED' });
  const url = safeMcpTargetUrl(targetUrl, { label: 'MCP smoke URL' });
  if (evidence?.workflow) {
    const authorizedOrigins = authorizedMcpOrigins(evidence.workflow, serverId);
    if (authorizedOrigins.length && !authorizedOrigins.includes(url.origin)) {
      throw new SingularityFlowError(
        `MCP smoke target origin '${url.origin}' is outside this Story's authorization.`,
        { code: 'MCP_EVIDENCE_TARGET_UNAUTHORIZED' }
      );
    }
  }
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  const result = await probe(entry, { url, server, cwd: root });
  if (result?.status !== 'passed') throw new SingularityFlowError(`MCP smoke test failed for '${serverId}'.`, { code: 'MCP_SMOKE_FAILED' });
  const observedFinalUrl = evidence?.workflow
    ? finalUrlFromSnapshotResult(result.snapshotResult)
    : safeMcpTargetUrl(result.finalUrl, { label: 'MCP smoke observed final URL' });
  const finalOrigin = normalizeMcpTargetOrigin(result.finalOrigin, {
    required: true,
    label: 'MCP smoke final origin'
  });
  if (observedFinalUrl.origin !== finalOrigin || finalOrigin !== url.origin) {
    throw new SingularityFlowError(`MCP smoke ended outside the authorized origin (${url.origin}).`, { code: 'MCP_SMOKE_ORIGIN_DRIFT' });
  }
  const tools = new Set(result.tools ?? []);
  if (REQUIRED_SMOKE_TOOLS.some((tool) => !tools.has(tool))) {
    throw new SingularityFlowError('MCP smoke did not exercise the complete required browser tool set.', { code: 'MCP_SMOKE_INCOMPLETE' });
  }
  const { snapshotResult, ...receiptResult } = result;
  const receipt = {
    schemaVersion: 1,
    serverId,
    hostReference: server.hostReference,
    checkedAt: nowIso(),
    authorizedOrigin: url.origin,
    requestedUrlSha256: recordSha256(url.toString()),
    hostEntrySha256: recordSha256(entry),
    policySha256: policyHash(server),
    result: {
      ...receiptResult,
      finalUrl: undefined,
      finalUrlSha256: recordSha256(observedFinalUrl.toString())
    }
  };
  const file = smokeReceiptPath(root, serverId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, receipt);
  let evidenceRecord = null;
  if (evidence?.workflow) {
    if (!snapshotResult) {
      throw new SingularityFlowError('The MCP host did not return an exact snapshot result for evidence capture.', {
        code: 'MCP_EVIDENCE_OBSERVATION_REQUIRED'
      });
    }
    evidenceRecord = await recordObservedMcpBrowserCapture(root, evidence.workflow, {
      server: serverId,
      phase: evidence.phase,
      agent: evidence.agent,
      actor: evidence.actor,
      targetUrl: url.toString(),
      observedFinalUrl: observedFinalUrl.toString(),
      snapshotResult,
      smokeReceipt: receipt,
      itemDirectory: evidence.itemDirectory ?? null
    });
  }
  return { ...receipt, path: file, evidence: evidenceRecord };
}

async function readSmokeReceipt(root, serverId) {
  try { return JSON.parse(await readFile(smokeReceiptPath(root, serverId), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { error: error.message }; }
}

function validSmokeReceipt(receipt, { serverId, configured, expectedOrigins, now = Date.now() }) {
  if (!receipt || receipt.error || receipt.schemaVersion !== 1 || receipt.serverId !== serverId
    || receipt.hostReference !== configured.hostReference || receipt.result?.status !== 'passed'
    || !Array.isArray(receipt.result?.tools)
    || !/^[a-f0-9]{64}$/.test(receipt.requestedUrlSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(receipt.result?.finalUrlSha256 ?? '')
    || REQUIRED_SMOKE_TOOLS.some((tool) => !receipt.result.tools.includes(tool))) {
    return { valid: false, reason: 'receipt structure or server identity is invalid' };
  }
  let origin;
  try { origin = safeMcpTargetUrl(receipt.authorizedOrigin, { label: 'MCP smoke receipt origin' }).origin; }
  catch { return { valid: false, reason: 'receipt origin is invalid' }; }
  let finalOrigin;
  try { finalOrigin = safeMcpTargetUrl(receipt.result.finalOrigin, { label: 'MCP smoke receipt final origin' }).origin; }
  catch { return { valid: false, reason: 'receipt final origin is invalid' }; }
  if (finalOrigin !== origin) return { valid: false, reason: 'receipt final origin differs from its authorized origin' };
  if (expectedOrigins.length && !expectedOrigins.includes(origin)) {
    return { valid: false, reason: `receipt origin '${origin}' is not authorized for this Story` };
  }
  const checkedAt = Date.parse(receipt.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now + 60_000 || now - checkedAt > MCP_SMOKE_MAX_AGE_MS) {
    return { valid: false, reason: 'receipt is older than 24 hours or has an invalid timestamp' };
  }
  return { valid: true, origin };
}

export async function assertMcpPhaseReadiness(root, workflow, phase) {
  const policy = phase?.mcp ?? { requiredServers: [], requireSmoke: false };
  if (!policy.requiredServers?.length) return { servers: [] };
  const definition = { mcpServers: workflow.resolution?.mcpServers ?? {} };
  const report = await mcpDoctor(root, definition);
  const errors = [];
  const servers = [];
  for (const serverId of policy.requiredServers) {
    const configured = definition.mcpServers[serverId];
    const status = report.servers.find((entry) => entry.id === serverId);
    if (!configured || !status) errors.push(`Required MCP server '${serverId}' is not pinned in this Story.`);
    else if (status.readiness !== 'ready') errors.push(`MCP server '${serverId}' is ${status.readiness}: ${status.reasons.join(' ')}`);
    let smoke = null;
    if (configured && policy.requireSmoke) {
      const expectedOrigins = authorizedMcpOrigins(workflow, serverId);
      if (!expectedOrigins.length) errors.push(`MCP server '${serverId}' has no Story-pinned authorized origin.`);
      smoke = await readSmokeReceipt(root, serverId);
      if (!smoke || smoke.error) errors.push(`MCP server '${serverId}' has no successful live smoke receipt. Run singularity-flow mcp smoke ${serverId} --url <AUTHORIZED_URL>.`);
      else {
        const validity = validSmokeReceipt(smoke, { serverId, configured, expectedOrigins });
        if (!validity.valid || smoke.hostEntrySha256 !== status?.host?.entrySha256 || smoke.policySha256 !== status?.policy?.sha256) {
          errors.push(`MCP server '${serverId}' live smoke receipt is stale or unsuccessful${validity.reason ? `: ${validity.reason}` : ''}.`);
        }
      }
    }
    servers.push({ ...status, smoke });
  }
  if (errors.length) throw new SingularityFlowError(`Phase '${phase.id}' MCP readiness is blocked:\n- ${errors.join('\n- ')}`, { code: 'MCP_PHASE_NOT_READY', details: { phase: phase.id, errors } });
  return { servers };
}

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
  const entries = await hostEntryMap(root, options);
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
    } else if (server.id === 'playwright' && !deterministicPlaywrightProfile(entries.get(server.hostReference))) {
      readiness = 'misconfigured';
      reasons.push('Playwright host entry must use the deterministic isolated/headless output, viewport, and timeout profile produced by mcp scaffold.');
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

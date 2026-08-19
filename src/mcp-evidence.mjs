import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { withSubjectLock } from './subject-lock.mjs';
import { authorizedMcpOrigins, safeMcpTargetUrl } from './mcp-target.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import {
  exists, nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot,
  writeAtomic, writeJson
} from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const MCP_EVIDENCE_SCHEMA_VERSION = currentSchemaVersion('mcp-evidence');

const TOOL = /^[A-Za-z0-9_.-]+$/;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_RECORDS = 5000;
const SECRET = /(?:authorization|bearer|cookie|api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i;

function mediaType(file) {
  return ({
    '.json': 'application/json', '.xml': 'application/xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.md': 'text/markdown', '.txt': 'text/plain'
  })[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function sanitizeName(value) {
  const clean = path.basename(value).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  return clean || 'output.bin';
}

function observedPage(bytes, { authorizedOrigins, label = 'Playwright MCP snapshot' } = {}) {
  const text = bytes.toString('utf8');
  const reportedUrl = text.match(/Page URL:\s*(\S+)/i)?.[1] ?? null;
  if (!reportedUrl) {
    throw new SingularityFlowError(`${label} does not report a Page URL.`, {
      code: 'MCP_EVIDENCE_ORIGIN_UNKNOWN'
    });
  }
  const finalUrl = safeMcpTargetUrl(reportedUrl, { label: `${label} final URL` });
  if (authorizedOrigins.length && !authorizedOrigins.includes(finalUrl.origin)) {
    throw new SingularityFlowError(
      `${label} reports origin '${finalUrl.origin}', outside this Story's authorization.`,
      { code: 'MCP_EVIDENCE_TARGET_UNAUTHORIZED' }
    );
  }
  return { finalUrlSha256: recordSha256(finalUrl.toString()), finalOrigin: finalUrl.origin };
}

function verifiedNavigationReceipt(configured, server, targetUrl, authorizedOrigins, receipt) {
  if (receipt) receipt = readRecord('mcp-observation-receipt', receipt).record;
  if (!receipt || receipt.serverId !== server
      || receipt.hostReference !== configured.hostReference || receipt.result?.status !== 'passed'
      || !Array.isArray(receipt.result?.tools)
      || !receipt.result.tools.includes('browser_navigate') || !receipt.result.tools.includes('browser_snapshot')) {
    throw new SingularityFlowError('Origin-bound browser navigation requires a valid live Playwright MCP smoke receipt.', {
      code: 'MCP_EVIDENCE_OBSERVED_RECEIPT_INVALID'
    });
  }
  if (receipt.policySha256 !== recordSha256(configured)) {
    throw new SingularityFlowError('The live Playwright MCP smoke receipt does not match the Story-pinned MCP policy.', {
      code: 'MCP_EVIDENCE_OBSERVED_RECEIPT_STALE'
    });
  }
  const declared = safeMcpTargetUrl(targetUrl, { label: 'MCP navigation target URL' });
  if (receipt.requestedUrlSha256 !== recordSha256(declared.toString())) {
    throw new SingularityFlowError('The recorded navigation target differs from the URL exercised by the live MCP smoke.', {
      code: 'MCP_EVIDENCE_OBSERVED_RECEIPT_MISMATCH'
    });
  }
  const observedOrigin = safeMcpTargetUrl(receipt.result.finalOrigin, { label: 'Playwright MCP observed final origin' }).origin;
  if (!/^[a-f0-9]{64}$/.test(receipt.result.finalUrlSha256 ?? '')
      || observedOrigin !== declared.origin || receipt.authorizedOrigin !== declared.origin
      || (authorizedOrigins.length && !authorizedOrigins.includes(observedOrigin))) {
    throw new SingularityFlowError(
      `The live Playwright MCP observation ended at unauthorized origin '${observedOrigin}'.`,
      { code: 'MCP_EVIDENCE_TARGET_UNAUTHORIZED' }
    );
  }
  return {
    schemaVersion: 1,
    source: 'playwright-mcp-live-smoke',
    smokeReceiptSha256: recordSha256(receipt),
    hostEntrySha256: receipt.hostEntrySha256,
    policySha256: receipt.policySha256,
    requestedUrlSha256: receipt.requestedUrlSha256,
    observedFinalUrlSha256: receipt.result.finalUrlSha256,
    observedFinalOrigin: observedOrigin,
    checkedAt: receipt.checkedAt
  };
}

function safeOutputUrl(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new SingularityFlowError('MCP output URLs require HTTPS, except loopback HTTP.', { code: 'MCP_EVIDENCE_UNSAFE_URL' });
  if (url.username || url.password) throw new SingularityFlowError('MCP output URLs must not contain credentials.', { code: 'MCP_EVIDENCE_SECRET' });
  return url;
}

/** Read a response incrementally so an untrusted MCP server cannot force an unbounded allocation. */
export async function readResponseWithLimit(response, maxBytes = MAX_OUTPUT_BYTES) {
  if (!response.body) throw new SingularityFlowError('MCP output response has no body.', { code: 'MCP_EVIDENCE_DOWNLOAD_FAILED' });
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        await response.body.cancel?.().catch?.(() => {});
        throw new SingularityFlowError(`MCP evidence output exceeds ${maxBytes} bytes.`, { code: 'MCP_EVIDENCE_LIMIT' });
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error?.code === 'MCP_EVIDENCE_LIMIT') throw error;
    throw new SingularityFlowError(`MCP output stream failed: ${error.message}`, { code: 'MCP_EVIDENCE_DOWNLOAD_FAILED' });
  }
  return Buffer.concat(chunks, total);
}

async function downloadOutput(value, { fetchImpl = globalThis.fetch } = {}) {
  let url = safeOutputUrl(value), redirects = 0;
  while (redirects <= 5) {
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/octet-stream,*/*;q=0.1' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); if (!location) break; url = safeOutputUrl(new URL(location, url)); redirects += 1; continue; }
    if (!response.ok) throw new SingularityFlowError(`MCP output download failed with HTTP ${response.status}.`, { code: 'MCP_EVIDENCE_DOWNLOAD_FAILED' });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_OUTPUT_BYTES) throw new SingularityFlowError(`MCP evidence output exceeds ${MAX_OUTPUT_BYTES} bytes.`, { code: 'MCP_EVIDENCE_LIMIT' });
    const bytes = await readResponseWithLimit(response, MAX_OUTPUT_BYTES);
    const persisted = new URL(url); persisted.search = ''; persisted.hash = '';
    return { bytes, name: sanitizeName(path.basename(url.pathname) || 'remote-output.bin'), mediaType: response.headers.get('content-type')?.split(';')[0] || mediaType(url.pathname), sourceUrl: persisted.toString(), redirects };
  }
  throw new SingularityFlowError('MCP output download exceeded the redirect limit.', { code: 'MCP_EVIDENCE_DOWNLOAD_FAILED' });
}

function normalizeNodes(values = []) {
  const list = [...new Set(values.map((value) => String(value).trim().replace(/-/g, ':')).filter(Boolean))].sort();
  if (list.some((value) => !/^\d+:\d+$/.test(value))) {
    throw new SingularityFlowError('Design-source node IDs must use Figma colon form such as 1:3.', {
      code: 'MCP_EVIDENCE_INVALID'
    });
  }
  if (list.length > 1000) throw new SingularityFlowError('A design-source record cannot contain more than 1000 nodes.', { code: 'MCP_EVIDENCE_LIMIT' });
  return list;
}

function validateCommon(workflow, configured, values) {
  const activePhase = values.phase ?? workflow.currentPhase;
  if (!activePhase || !workflow.phases?.[activePhase]) throw new SingularityFlowError('MCP evidence requires an active phase.', { code: 'MCP_EVIDENCE_PHASE_REQUIRED' });
  if (workflow.phases[activePhase].status !== 'in_progress') {
    throw new SingularityFlowError(`MCP evidence can only target an in-progress phase; '${activePhase}' is ${workflow.phases[activePhase].status}.`, { code: 'MCP_EVIDENCE_PHASE_CLOSED' });
  }
  if (configured.phases.length && !configured.phases.includes(activePhase)) throw new SingularityFlowError(`MCP server '${values.server}' is not allowed in phase '${activePhase}'.`);
  if (configured.agents.length && (!values.agent || !configured.agents.includes(values.agent))) throw new SingularityFlowError(`MCP server '${values.server}' requires one of these governed agents: ${configured.agents.join(', ')}.`);
  if (!TOOL.test(values.tool ?? '')) throw new SingularityFlowError('MCP evidence requires --tool with an unqualified tool name.');
  if (configured.tools.length && !configured.tools.includes(values.tool)) throw new SingularityFlowError(`Tool '${values.tool}' is not allowed for MCP server '${values.server}'.`);
  return activePhase;
}

async function recordCount(directory) {
  if (!(await exists(directory))) return 0;
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
}

async function writeMcpEvidence(root, workflow, {
  server, tool, phase, outputPath = null, outputUrl = null, note = null, agent = null, actor = null,
  targetUrl = null,
  kind = 'tool-call', fileKey = null, fileVersion = null, fileVersionCreatedAt = null,
  nodes = [], format = null, profileId = null, screenId = null, stateId = null,
  itemDirectory = null
} = {}, { liveSmokeReceipt = null } = {}) {
  const configured = workflow.resolution?.mcpServers?.[server];
  if (!configured) throw new SingularityFlowError(`MCP server '${server}' is not pinned for this work item.`);
  if (!['tool-call', 'design-source', 'visual-artifact'].includes(kind)) throw new SingularityFlowError(`Unsupported MCP evidence kind '${kind}'.`, { code: 'MCP_EVIDENCE_INVALID' });
  const activePhase = validateCommon(workflow, configured, { server, tool, phase, agent });
  let targetOrigin = null;
  let originReceipt = null;
  const authorizedOrigins = authorizedMcpOrigins(workflow, server);
  if (tool === 'browser_navigate' && authorizedOrigins.length) {
    if (!targetUrl) {
      throw new SingularityFlowError('Authorized browser navigation evidence requires --target-url.', {
        code: 'MCP_EVIDENCE_TARGET_REQUIRED'
      });
    }
    targetOrigin = safeMcpTargetUrl(targetUrl, { label: 'MCP navigation target URL' }).origin;
    if (!authorizedOrigins.includes(targetOrigin)) {
      throw new SingularityFlowError(
        `MCP navigation target origin '${targetOrigin}' is outside this Story's authorization.`,
        { code: 'MCP_EVIDENCE_TARGET_UNAUTHORIZED' }
      );
    }
    if (!liveSmokeReceipt) {
      throw new SingularityFlowError(
        'Origin-bound browser navigation must come from a live Playwright MCP observation. Run mcp smoke for the exact approved URL; do not declare navigation with mcp record.',
        { code: 'MCP_EVIDENCE_OBSERVED_RECEIPT_REQUIRED' }
      );
    }
    originReceipt = verifiedNavigationReceipt(configured, server, targetUrl, authorizedOrigins, liveSmokeReceipt);
  }
  if (note && SECRET.test(note)) throw new SingularityFlowError('MCP evidence notes must not contain credentials or secrets.', { code: 'MCP_EVIDENCE_SECRET' });
  if (outputPath && outputUrl) throw new SingularityFlowError('Use either --output or --output-url, not both.');
  if (kind !== 'tool-call' && !outputPath && !outputUrl) throw new SingularityFlowError(`${kind} evidence requires --output or --output-url.`, { code: 'MCP_EVIDENCE_OUTPUT_REQUIRED' });
  if (kind === 'design-source') {
    if (!String(fileKey ?? '').trim() || !String(fileVersion ?? '').trim()) throw new SingularityFlowError('Design-source evidence requires --file-key and --file-version.', { code: 'MCP_EVIDENCE_INVALID' });
    if (fileVersionCreatedAt && (!Number.isFinite(Date.parse(fileVersionCreatedAt)) || !String(fileVersionCreatedAt).endsWith('Z'))) throw new SingularityFlowError('--file-version-created-at must be a UTC ISO-8601 timestamp.', { code: 'MCP_EVIDENCE_INVALID' });
  }
  if (kind === 'visual-artifact') {
    if (activePhase !== 'visual-verification') throw new SingularityFlowError('Visual-artifact evidence may only be recorded in the visual-verification phase.', { code: 'MCP_EVIDENCE_INVALID' });
    if (!profileId || !screenId || !stateId) throw new SingularityFlowError('Visual-artifact evidence requires --profile-id, --screen-id, and --state-id.', { code: 'MCP_EVIDENCE_INVALID' });
    const profiles = workflow.resolution?.verification?.profiles ?? [];
    if (!profiles.some((profile) => profile.id === profileId)) throw new SingularityFlowError(`Unknown verification profile '${profileId}'.`, { code: 'MCP_EVIDENCE_INVALID' });
    for (const [label, value] of [['screen ID', screenId], ['state ID', stateId]]) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new SingularityFlowError(`Visual artifact ${label} is invalid.`, { code: 'MCP_EVIDENCE_INVALID' });
    }
  }
  const itemRoot = itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const recordsDirectory = path.join(itemRoot, 'context', 'mcp', 'records');
  const id = `mcp-${randomUUID()}`;
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    if (await recordCount(recordsDirectory) >= MAX_RECORDS) throw new SingularityFlowError(`MCP evidence limit reached (${MAX_RECORDS} records).`, { code: 'MCP_EVIDENCE_LIMIT' });
    let output = null;
    if (outputPath) {
      const source = await secureRepositoryPath(root, outputPath, { label: 'MCP evidence source', mustExist: true, type: 'file' });
      const sourceInfo = await lstat(source.absolute);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new SingularityFlowError('MCP evidence source must be a regular, non-symbolic-link file.', { code: 'MCP_EVIDENCE_UNSAFE_PATH' });
      if (sourceInfo.size > MAX_OUTPUT_BYTES) throw new SingularityFlowError(`MCP evidence output exceeds ${MAX_OUTPUT_BYTES} bytes.`, { code: 'MCP_EVIDENCE_LIMIT' });
      const bytes = await readFile(source.absolute);
      const relative = posix(path.join('context', 'mcp', 'outputs', id, sanitizeName(source.relative)));
      const target = await secureRepositoryPath(itemRoot, relative, { label: 'Managed MCP evidence output' });
      await writeAtomic(target.absolute, bytes);
      const captured = await snapshot(target.absolute);
      output = { path: relative, sha256: captured.sha256, bytes: captured.size, mediaType: mediaType(source.relative), sourceDisposition: 'local-copy' };
      if (kind === 'visual-artifact' && output.mediaType !== 'image/png') throw new SingularityFlowError('Visual-artifact evidence must be a PNG file.', { code: 'MCP_EVIDENCE_INVALID' });
    }
    if (outputUrl) {
      const downloaded = await downloadOutput(outputUrl);
      const relative = posix(path.join('context', 'mcp', 'outputs', id, downloaded.name));
      const target = await secureRepositoryPath(itemRoot, relative, { label: 'Managed MCP evidence output' });
      await writeAtomic(target.absolute, downloaded.bytes);
      const captured = await snapshot(target.absolute);
      output = { path: relative, sha256: captured.sha256, bytes: captured.size, mediaType: downloaded.mediaType, sourceDisposition: 'remote-copy', sourceUrl: downloaded.sourceUrl, redirects: downloaded.redirects };
      if (kind === 'visual-artifact' && output.mediaType !== 'image/png') throw new SingularityFlowError('Visual-artifact evidence must be a PNG file.', { code: 'MCP_EVIDENCE_INVALID' });
    }
    const generation = Number(workflow.phases[activePhase]?.generation ?? 0) + 1;
    const record = {
      schemaVersion: MCP_EVIDENCE_SCHEMA_VERSION,
      id,
      kind,
      workId: workflow.workItem.id,
      phase: activePhase,
      targetGeneration: generation,
      server,
      hostReference: configured.hostReference,
      tool,
      agent,
      actor,
      recordedAt: nowIso(),
      captureSource: originReceipt ? 'observed-by-mcp-host' : 'declared-by-agent',
      note: note ?? null,
      targetOrigin,
      observedFinalUrlSha256: originReceipt?.observedFinalUrlSha256 ?? null,
      observedFinalOrigin: originReceipt?.observedFinalOrigin ?? null,
      originReceipt,
      output,
      ...(kind === 'design-source' ? {
        fileKey: String(fileKey).trim(),
        fileVersion: String(fileVersion).trim(),
        fileVersionCreatedAt: fileVersionCreatedAt ?? null,
        nodes: normalizeNodes(nodes),
        format: format ?? 'figma-mcp-metadata-xml',
        outputSha256: output.sha256
      } : {}),
      ...(kind === 'visual-artifact' ? {
        profileId, screenId, stateId, outputSha256: output.sha256
      } : {})
    };
    const file = path.join(recordsDirectory, `${id}.json`);
    await writeJson(file, record);
    return { file: posix(path.relative(root, file)), record };
  });
}

export async function recordMcpEvidence(root, workflow, values = {}) {
  const result = await writeMcpEvidence(root, workflow, values);
  if (values.tool === 'browser_snapshot') {
    return {
      ...result,
      gateSatisfying: false,
      noticeCode: 'mcp.evidence-observation-required',
      diagnosticCodes: ['MCP_EVIDENCE_OBSERVATION_REQUIRED']
    };
  }
  return result;
}

/**
 * The live MCP runner is the only production caller of this boundary. Keeping the receipt out of
 * recordMcpEvidence's public options prevents a CLI/model declaration from masquerading as a host
 * observation.
 */
export async function recordObservedMcpNavigationEvidence(root, workflow, {
  server, phase, agent = null, actor = null, targetUrl, smokeReceipt, itemDirectory = null
} = {}) {
  void root; void workflow; void server; void phase; void agent; void actor;
  void targetUrl; void smokeReceipt; void itemDirectory;
  throw new SingularityFlowError('A navigation cannot be recorded without its exact host snapshot transaction.', {
    code: 'MCP_EVIDENCE_OBSERVATION_REQUIRED'
  });
}

/**
 * Persist one host-observed browser transaction as an inseparable navigation/snapshot pair.
 * The snapshot bytes come directly from the exact `tools/call` result in the same MCP process.
 */
export async function recordObservedMcpBrowserCapture(root, workflow, {
  server, phase, agent = null, actor = null, targetUrl, observedFinalUrl,
  snapshotResult, smokeReceipt, itemDirectory = null
} = {}) {
  const configured = workflow.resolution?.mcpServers?.[server];
  if (!configured) throw new SingularityFlowError(`MCP server '${server}' is not pinned for this work item.`);
  const activePhase = validateCommon(workflow, configured, {
    server, tool: 'browser_navigate', phase, agent
  });
  if (!snapshotResult || typeof snapshotResult !== 'object') {
    throw new SingularityFlowError('The MCP host did not return the exact browser snapshot result.', {
      code: 'MCP_EVIDENCE_OBSERVATION_REQUIRED'
    });
  }
  const authorizedOrigins = authorizedMcpOrigins(workflow, server);
  const originReceipt = verifiedNavigationReceipt(
    configured, server, targetUrl, authorizedOrigins, smokeReceipt
  );
  const finalUrl = safeMcpTargetUrl(observedFinalUrl, { label: 'MCP host observed final URL' });
  if (recordSha256(finalUrl.toString()) !== originReceipt.observedFinalUrlSha256
      || finalUrl.origin !== originReceipt.observedFinalOrigin) {
    throw new SingularityFlowError('The snapshot transaction does not match the observed navigation receipt.', {
      code: 'MCP_EVIDENCE_OUTPUT_RECEIPT_MISMATCH'
    });
  }

  const itemRoot = itemDirectory ?? path.join(
    root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id
  );
  const recordsDirectory = path.join(itemRoot, 'context', 'mcp', 'records');
  const captureId = `capture-${randomUUID()}`;
  const outputRelative = posix(path.join('context', 'mcp', 'outputs', captureId, 'browser-snapshot.json'));
  await mkdir(itemRoot, { recursive: true });
  const outputTarget = await secureRepositoryPath(itemRoot, outputRelative, {
    label: 'Managed MCP browser snapshot output'
  });
  const outputBytes = Buffer.from(canonicalJson(snapshotResult));
  const generation = Number(workflow.phases[activePhase]?.generation ?? 0) + 1;

  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    if (await recordCount(recordsDirectory) > MAX_RECORDS - 2) {
      throw new SingularityFlowError(`MCP evidence limit reached (${MAX_RECORDS} records).`, {
        code: 'MCP_EVIDENCE_LIMIT'
      });
    }
    await writeAtomic(outputTarget.absolute, outputBytes);
    const captured = await snapshot(outputTarget.absolute);
    const output = {
      path: outputRelative, sha256: captured.sha256, bytes: captured.size,
      mediaType: 'application/json', sourceDisposition: 'mcp-host-capture'
    };
    const observationReceipt = {
      schemaVersion: currentSchemaVersion('mcp-observation-receipt'),
      source: 'playwright-mcp-live-capture',
      captureId,
      subject: { kind: 'story', id: workflow.workItem.id },
      phase: activePhase,
      targetGeneration: generation,
      server,
      hostReference: configured.hostReference,
      hostEntrySha256: smokeReceipt.hostEntrySha256,
      policySha256: smokeReceipt.policySha256,
      requestedUrlSha256: smokeReceipt.requestedUrlSha256,
      observedFinalUrlSha256: originReceipt.observedFinalUrlSha256,
      finalOrigin: originReceipt.observedFinalOrigin,
      tool: 'browser_snapshot',
      output: {
        path: output.path, sha256: output.sha256, bytes: output.bytes, mediaType: output.mediaType
      },
      capturedAt: smokeReceipt.checkedAt
    };
    const common = {
      schemaVersion: MCP_EVIDENCE_SCHEMA_VERSION,
      kind: 'tool-call',
      workId: workflow.workItem.id,
      phase: activePhase,
      targetGeneration: generation,
      server,
      hostReference: configured.hostReference,
      agent,
      actor,
      recordedAt: smokeReceipt.checkedAt,
      captureSource: 'observed-by-mcp-host',
      captureId,
      targetOrigin: finalUrl.origin,
      observedFinalUrlSha256: originReceipt.observedFinalUrlSha256,
      observedFinalOrigin: finalUrl.origin,
      observationReceipt
    };
    const navigation = { ...common, id: `${captureId}-navigate`, tool: 'browser_navigate', output: null };
    const snapshotRecord = { ...common, id: `${captureId}-snapshot`, tool: 'browser_snapshot', output };
    await writeJson(path.join(recordsDirectory, `${navigation.id}.json`), navigation);
    await writeJson(path.join(recordsDirectory, `${snapshotRecord.id}.json`), snapshotRecord);
    return Object.freeze({ captureId, navigation, snapshot: snapshotRecord });
  });
}

async function candidateRecordFiles(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  for (const relative of ['records', '.']) {
    const target = path.join(directory, relative);
    if (!(await exists(target))) continue;
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.join(target, entry.name));
    }
  }
  return [...new Set(files)].sort();
}

export async function verifyMcpEvidence(root, workflow, { itemDirectory = null } = {}) {
  const errors = [], warnings = [], passes = [], records = [];
  const storedVersions = new WeakMap();
  const itemRoot = itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const directory = path.join(itemRoot, 'context', 'mcp');
  for (const absolute of await candidateRecordFiles(directory)) {
    let record, storedVersion;
    try {
      const migrated = readRecord('mcp-evidence', await readFile(absolute));
      record = migrated.record;
      storedVersion = migrated.storedVersion;
    } catch (error) { errors.push(`MCP evidence '${path.basename(absolute)}' cannot be read: ${error.message}`); continue; }
    storedVersions.set(record, storedVersion);
    records.push(record);
    const prefix = `MCP evidence '${record.id ?? path.basename(absolute)}'`;
    if (record.workId !== workflow.workItem.id) errors.push(`${prefix} belongs to work item '${record.workId ?? 'unknown'}'.`);
    const configured = workflow.resolution?.mcpServers?.[record.server];
    if (!configured) { errors.push(`${prefix} references MCP server '${record.server ?? 'unknown'}' outside the pinned work-item policy.`); continue; }
    if (record.hostReference !== configured.hostReference) errors.push(`${prefix} host reference differs from the pinned policy.`);
    const authorizedOrigins = authorizedMcpOrigins(workflow, record.server);
    if (record.tool === 'browser_navigate' && authorizedOrigins.length) {
      if (!record.targetOrigin) errors.push(`${prefix} does not identify its browser navigation origin.`);
      else if (!authorizedOrigins.includes(record.targetOrigin)) errors.push(`${prefix} navigation origin '${record.targetOrigin}' is outside the Story authorization.`);
      if (record.captureSource === 'observed-by-mcp-host') {
        if (!record.captureId || record.observationReceipt?.captureId !== record.captureId) {
          errors.push(`[MCP_EVIDENCE_OUTPUT_RECEIPT_MISMATCH] ${prefix} has no matching host observation receipt.`);
        }
      } else warnings.push(`${prefix} is retained for audit but cannot satisfy a host-observed browser gate.`);
      if (!record.observedFinalOrigin || record.observedFinalOrigin !== record.targetOrigin) {
        errors.push(`${prefix} observed final origin does not match its authorized target origin.`);
      }
      if (record.captureSource === 'observed-by-mcp-host'
          && (record.observationReceipt?.policySha256 !== recordSha256(configured)
          || record.observationReceipt?.finalOrigin !== record.observedFinalOrigin)) {
        errors.push(`[MCP_EVIDENCE_OUTPUT_RECEIPT_MISMATCH] ${prefix} host receipt does not match its pinned policy or observed result.`);
      }
    }
    if (record.tool === 'browser_snapshot' && authorizedOrigins.length) {
      if (record.captureSource !== 'observed-by-mcp-host') {
        warnings.push(`${prefix} is agent-supplied or legacy evidence and is retained for audit only; it cannot satisfy the origin gate.`);
      } else if (!record.observedFinalOrigin || !authorizedOrigins.includes(record.observedFinalOrigin)) {
        errors.push(`${prefix} snapshot origin is absent or outside the Story authorization.`);
      }
    }
    if (!workflow.phaseOrder.includes(record.phase)) errors.push(`${prefix} references unknown phase '${record.phase ?? 'unknown'}'.`);
    if (configured.phases.length && !configured.phases.includes(record.phase)) errors.push(`${prefix} is outside MCP server '${record.server}' phase scope.`);
    if (configured.agents.length && !configured.agents.includes(record.agent)) errors.push(`${prefix} was recorded by governed agent '${record.agent ?? 'unknown'}', outside the pinned assignment.`);
    if (!TOOL.test(record.tool ?? '')) errors.push(`${prefix} has an invalid tool name.`);
    else if (configured.tools.length && !configured.tools.includes(record.tool)
        && !(record.captureSource === 'observed-by-mcp-host'
          && record.tool === 'browser_snapshot')) {
      errors.push(`${prefix} records disallowed tool '${record.tool}'.`);
    }
    if (record.kind === 'design-source') {
      if (!record.fileKey || !record.fileVersion || !Array.isArray(record.nodes)) errors.push(`${prefix} is missing design-source identity fields.`);
      if (record.format !== 'figma-mcp-metadata-xml' && record.format !== 'figma-rest-file-json' && record.format !== 'sflow-design-nodes-v1') errors.push(`${prefix} has unsupported design-source format '${record.format}'.`);
      if (record.outputSha256 !== record.output?.sha256) errors.push(`${prefix} outputSha256 does not match its managed output.`);
    }
    if (record.kind === 'visual-artifact') {
      const profiles = workflow.resolution?.verification?.profiles ?? [];
      if (record.phase !== 'visual-verification') errors.push(`${prefix} is outside the visual-verification phase.`);
      if (!profiles.some((profile) => profile.id === record.profileId)) errors.push(`${prefix} references unknown verification profile '${record.profileId ?? 'unknown'}'.`);
      if (!record.screenId || !record.stateId) errors.push(`${prefix} is missing screen/state identity.`);
      if (record.output?.mediaType !== 'image/png') errors.push(`${prefix} is not a PNG visual artifact.`);
      if (record.outputSha256 !== record.output?.sha256) errors.push(`${prefix} outputSha256 does not match its managed output.`);
    }
    if (record.output) {
      const target = await secureRepositoryPath(itemRoot, record.output.path ?? '', { label: `${prefix} output`, mustExist: false });
      const current = await snapshot(target.absolute);
      if (!current.exists) errors.push(`${prefix} output is missing: ${record.output.path}`);
      else if (current.sha256 !== record.output.sha256 || current.size !== record.output.bytes) errors.push(`${prefix} output changed after capture: ${record.output.path}`);
      else {
        if (record.tool === 'browser_snapshot' && authorizedOrigins.length && storedVersions.get(record) < MCP_EVIDENCE_SCHEMA_VERSION) {
          try {
            const observed = observedPage(await readFile(target.absolute), { authorizedOrigins, label: prefix });
            if (observed.finalUrlSha256 !== record.observedFinalUrlSha256 || observed.finalOrigin !== record.observedFinalOrigin) {
              errors.push(`${prefix} stored Page URL differs from its captured snapshot output.`);
            }
          } catch (error) { errors.push(`${prefix} cannot verify its captured Page URL: ${error.message}`); }
        }
        if (record.captureSource === 'observed-by-mcp-host') {
          const receipt = record.observationReceipt
            ? readRecord('mcp-observation-receipt', record.observationReceipt).record : null;
          if (!receipt
              || receipt.source !== 'playwright-mcp-live-capture'
              || receipt.subject?.kind !== 'story' || receipt.subject?.id !== workflow.workItem.id
              || receipt.phase !== record.phase
              || Number(receipt.targetGeneration) !== Number(record.targetGeneration)
              || receipt.server !== record.server || receipt.hostReference !== configured.hostReference
              || receipt.captureId !== record.captureId
              || receipt.policySha256 !== recordSha256(configured)
              || receipt.observedFinalUrlSha256 !== record.observedFinalUrlSha256
              || receipt.finalOrigin !== record.observedFinalOrigin
              || receipt.output?.path !== record.output.path
              || receipt.output?.sha256 !== current.sha256 || receipt.output?.bytes !== current.size
              || receipt.output?.mediaType !== record.output.mediaType) {
            errors.push(`[MCP_EVIDENCE_OUTPUT_RECEIPT_MISMATCH] ${prefix} output does not match its host observation receipt.`);
          }
        }
        passes.push(`MCP evidence output: ${record.server}/${record.tool}@${current.sha256.slice(0, 8)}`);
      }
    } else if (configured.evidence.captureResults) warnings.push(`${prefix} has no durable output although result capture is requested by policy.`);
  }
  const observedCaptures = new Map();
  for (const record of records.filter((entry) => entry.captureSource === 'observed-by-mcp-host')) {
    const list = observedCaptures.get(record.captureId) ?? [];
    list.push(record);
    observedCaptures.set(record.captureId, list);
  }
  for (const [captureId, paired] of observedCaptures) {
    const tools = paired.map((entry) => entry.tool).sort();
    const receipts = new Set(paired.map((entry) => recordSha256(entry.observationReceipt ?? null)));
    if (paired.length !== 2 || tools.join(',') !== 'browser_navigate,browser_snapshot' || receipts.size !== 1) {
      errors.push(`[MCP_EVIDENCE_RECEIPT_REPLAYED] Browser capture '${captureId}' is incomplete, duplicated, or has mismatched receipts.`);
    }
  }
  if (records.length) passes.push(`MCP evidence integrity: ${records.length} record(s)`);
  return { errors, warnings, passes, records };
}

export async function verifyPhaseMcpRequirements(root, workflow, phase, {
  itemDirectory = null,
  targetGeneration = Number(phase?.generation ?? 0) + 1
} = {}) {
  const requirements = phase?.mcp?.evidence ?? [];
  if (!requirements.length) return { errors: [], passes: [], records: [] };
  const integrity = await verifyMcpEvidence(root, workflow, { itemDirectory });
  const errors = [...integrity.errors];
  const passes = [];
  const records = integrity.records.filter((record) =>
    record.phase === phase.id && Number(record.targetGeneration) === Number(targetGeneration)
  );
  const browserServers = [...new Set(requirements
    .filter((requirement) => requirement.tool.startsWith('browser_'))
    .map((requirement) => requirement.server))];
  for (const server of browserServers) {
    if (!authorizedMcpOrigins(workflow, server).length) continue;
    const observedNavigation = records.find((record) =>
      record.server === server && record.tool === 'browser_navigate'
      && record.captureSource === 'observed-by-mcp-host'
      && records.some((candidate) =>
        candidate.captureId === record.captureId && candidate.tool === 'browser_snapshot'
        && candidate.captureSource === 'observed-by-mcp-host')
    );
    if (!observedNavigation) {
      errors.push(
        `Phase '${phase.id}' generation ${targetGeneration} requires a live, host-observed navigation receipt for origin-bound browser evidence from '${server}'.`
      );
    } else passes.push(`${server}/origin: ${observedNavigation.observedFinalOrigin}`);
  }
  for (const requirement of requirements) {
    const originBoundBrowser = requirement.tool.startsWith('browser_')
      && authorizedMcpOrigins(workflow, requirement.server).length > 0;
    const matches = records.filter((record) =>
      record.server === requirement.server
      && record.tool === requirement.tool
      && (!originBoundBrowser || (record.captureSource === 'observed-by-mcp-host'
        && records.some((candidate) => candidate.captureId === record.captureId
          && candidate.tool === (record.tool === 'browser_snapshot' ? 'browser_navigate' : 'browser_snapshot')
          && candidate.captureSource === 'observed-by-mcp-host')))
      && (!requirement.outputRequired || Boolean(record.output?.sha256))
    );
    if (matches.length < requirement.minimum) {
      errors.push(
        `Phase '${phase.id}' generation ${targetGeneration} requires ${requirement.minimum} MCP evidence record(s) for ${requirement.server}/${requirement.tool}`
        + `${requirement.outputRequired ? ' with a durable output' : ''}; found ${matches.length}.`
      );
    } else passes.push(`${requirement.server}/${requirement.tool}: ${matches.length}/${requirement.minimum}`);
  }
  return { errors, passes, records };
}

export async function listMcpEvidence(root, workflow, options = {}) {
  return (await verifyMcpEvidence(root, workflow, options)).records;
}

import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { withSubjectLock } from './subject-lock.mjs';
import { authorizedMcpOrigins, safeMcpTargetUrl } from './mcp-target.mjs';
import {
  exists, nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot,
  writeAtomic, writeJson
} from './util.mjs';

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

export async function recordMcpEvidence(root, workflow, {
  server, tool, phase, outputPath = null, outputUrl = null, note = null, agent = null, actor = null,
  targetUrl = null,
  kind = 'tool-call', fileKey = null, fileVersion = null, fileVersionCreatedAt = null,
  nodes = [], format = null, profileId = null, screenId = null, stateId = null,
  itemDirectory = null
} = {}) {
  const configured = workflow.resolution?.mcpServers?.[server];
  if (!configured) throw new SingularityFlowError(`MCP server '${server}' is not pinned for this work item.`);
  if (!['tool-call', 'design-source', 'visual-artifact'].includes(kind)) throw new SingularityFlowError(`Unsupported MCP evidence kind '${kind}'.`, { code: 'MCP_EVIDENCE_INVALID' });
  const activePhase = validateCommon(workflow, configured, { server, tool, phase, agent });
  let targetOrigin = null;
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
      schemaVersion: 2,
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
      captureSource: 'declared-by-agent',
      note: note ?? null,
      targetOrigin,
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
  const itemRoot = itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const directory = path.join(itemRoot, 'context', 'mcp');
  for (const absolute of await candidateRecordFiles(directory)) {
    let record;
    try { record = JSON.parse(await readFile(absolute, 'utf8')); }
    catch (error) { errors.push(`MCP evidence '${path.basename(absolute)}' is not valid JSON: ${error.message}`); continue; }
    if (record.schemaVersion === 1) record = { ...record, kind: 'tool-call', targetGeneration: record.generation };
    records.push(record);
    const prefix = `MCP evidence '${record.id ?? path.basename(absolute)}'`;
    if (![1, 2].includes(record.schemaVersion)) errors.push(`${prefix} has unsupported schemaVersion '${record.schemaVersion}'.`);
    if (record.workId !== workflow.workItem.id) errors.push(`${prefix} belongs to work item '${record.workId ?? 'unknown'}'.`);
    const configured = workflow.resolution?.mcpServers?.[record.server];
    if (!configured) { errors.push(`${prefix} references MCP server '${record.server ?? 'unknown'}' outside the pinned work-item policy.`); continue; }
    if (record.hostReference !== configured.hostReference) errors.push(`${prefix} host reference differs from the pinned policy.`);
    const authorizedOrigins = authorizedMcpOrigins(workflow, record.server);
    if (record.tool === 'browser_navigate' && authorizedOrigins.length) {
      if (!record.targetOrigin) errors.push(`${prefix} does not identify its browser navigation origin.`);
      else if (!authorizedOrigins.includes(record.targetOrigin)) errors.push(`${prefix} navigation origin '${record.targetOrigin}' is outside the Story authorization.`);
    }
    if (!workflow.phaseOrder.includes(record.phase)) errors.push(`${prefix} references unknown phase '${record.phase ?? 'unknown'}'.`);
    if (configured.phases.length && !configured.phases.includes(record.phase)) errors.push(`${prefix} is outside MCP server '${record.server}' phase scope.`);
    if (configured.agents.length && !configured.agents.includes(record.agent)) errors.push(`${prefix} was recorded by governed agent '${record.agent ?? 'unknown'}', outside the pinned assignment.`);
    if (!TOOL.test(record.tool ?? '')) errors.push(`${prefix} has an invalid tool name.`);
    else if (configured.tools.length && !configured.tools.includes(record.tool)) errors.push(`${prefix} records disallowed tool '${record.tool}'.`);
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
      else passes.push(`MCP evidence output: ${record.server}/${record.tool}@${current.sha256.slice(0, 8)}`);
    } else if (configured.evidence.captureResults) warnings.push(`${prefix} has no durable output although result capture is requested by policy.`);
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
  for (const requirement of requirements) {
    const matches = records.filter((record) =>
      record.server === requirement.server
      && record.tool === requirement.tool
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

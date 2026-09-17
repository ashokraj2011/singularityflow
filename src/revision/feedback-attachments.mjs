/**
 * REV feedback-document intake. This is deliberately independent of Story `documents upload`:
 * callers must prove the active work/phase before calling it, and registration only returns an
 * immutable evidence receipt for their transactional store. Neither function starts a revision,
 * sends content to a model, or promotes an upload into approved intent.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { scanText } from '../secrets.mjs';
import { SingularityFlowError, portableIdentifier } from '../util.mjs';

const DEFAULT_POLICY = Object.freeze({
  maximumFilesPerFeedback: 5,
  maximumOriginalBytesPerFile: 10 * 1024 * 1024,
  maximumSelectedRenditionBytes: 64 * 1024,
  maximumFeedbackBytes: 8192,
  planTtlMs: 30 * 60 * 1000,
  retentionClass: 'proof',
  accessClass: 'private'
});
const TEXT_TYPES = Object.freeze({
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values'
});
const EXTRACTABLE_BINARY_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
});
const BINARY_TYPES = new Set([
  '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.bmp', '.heic'
]);
const MAX_DELIMITED_ROWS = 100_000;
const MAX_DELIMITED_COLUMNS = 1_024;
const MAX_SELECTION_RANGES = 256;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_UNITS = 256;
const PROVIDER_TIMEOUT_MS = 30_000;

// The CLI should derive its advertised local-file formats from the same registry as admission.
export const feedbackAttachmentFormats = Object.freeze(Object.keys(TEXT_TYPES));

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function digest(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function recordDigest(value) { return `sha256:${recordSha256(value)}`; }
function equalJson(a, b) { return recordSha256(a) === recordSha256(b); }
function validDigest(value) { return /^sha256:[a-f0-9]{64}$/.test(String(value ?? '')); }
function validCommit(value) { return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(value ?? '')); }

function normalizedPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('REV_ATTACHMENT_POLICY', 'Attachment policy must be an object.');
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_POLICY)) fail('REV_ATTACHMENT_POLICY', `Attachment policy ${key} is not registered.`);
  }
  const policy = { ...DEFAULT_POLICY, ...input };
  for (const key of ['maximumFilesPerFeedback', 'maximumOriginalBytesPerFile', 'maximumSelectedRenditionBytes', 'maximumFeedbackBytes', 'planTtlMs']) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1 || policy[key] > 100 * 1024 * 1024) {
      fail('REV_ATTACHMENT_POLICY', `Attachment policy ${key} is invalid.`);
    }
  }
  if (!['proof', 'feedback'].includes(policy.retentionClass) || policy.accessClass !== 'private') {
    fail('REV_ATTACHMENT_POLICY', 'Feedback attachments require a supported private retention policy.');
  }
  return Object.freeze(policy);
}

function normalizedContext(context, policy) {
  if (!context || typeof context !== 'object') fail('REV_ATTACHMENT_CONTEXT', 'An exact active work context is required.');
  if (typeof context.repositoryRoot !== 'string' || !path.isAbsolute(context.repositoryRoot)) {
    fail('REV_ATTACHMENT_CONTEXT', 'An absolute selected repository root is required.');
  }
  const workId = portableIdentifier(context.workId, 'Work ID');
  const phaseId = portableIdentifier(context.phaseId, 'Phase ID');
  const loopId = context.loopId == null ? null : portableIdentifier(context.loopId, 'Loop ID');
  if (!Number.isSafeInteger(context.phaseGeneration) || context.phaseGeneration < 0) {
    fail('REV_ATTACHMENT_CONTEXT', 'An exact non-negative phase generation is required.');
  }
  if (context.loopRevision != null && (!Number.isSafeInteger(context.loopRevision) || context.loopRevision < 0)) {
    fail('REV_ATTACHMENT_CONTEXT', 'Loop revision must be a non-negative integer.');
  }
  if (!validCommit(context.headCommit) || !validDigest(context.sourceTreeSha256)
    || !validDigest(context.configSha256) || !validDigest(context.workflowSha256)) {
    fail('REV_ATTACHMENT_CONTEXT', 'Exact HEAD, source tree, configuration, and workflow digests are required.');
  }
  if (context.active !== true) fail('REV_ATTACHMENT_CONTEXT', 'Feedback attachments require an active work session.');
  const feedbackText = String(context.feedbackText ?? '');
  if (!feedbackText.trim() || Buffer.byteLength(feedbackText) > policy.maximumFeedbackBytes) {
    fail('REV_ATTACHMENT_FEEDBACK', 'Feedback must be nonempty and within the configured byte limit.');
  }
  if (scanText(feedbackText).length) fail('REV_FEEDBACK_SECRET', 'Feedback may contain a credential; no attachment was registered.');
  let canonicalCommonGitDir;
  try { canonicalCommonGitDir = realpathSync(gitCommonDir(context.repositoryRoot)); }
  catch { fail('REV_ATTACHMENT_CONTEXT', 'Selected repository has no verifiable common Git directory.'); }
  return Object.freeze({
    workId, phaseId, phaseGeneration: context.phaseGeneration,
    loopId, loopRevision: context.loopRevision ?? null,
    loopStatus: loopId === null ? 'not-available' : 'open',
    headCommit: context.headCommit,
    sourceTreeSha256: context.sourceTreeSha256,
    configSha256: context.configSha256,
    workflowSha256: context.workflowSha256,
    // The absolute path itself never enters a shared plan or receipt.
    repositorySha256: digest(Buffer.from(canonicalCommonGitDir)),
    feedbackSha256: digest(Buffer.from(feedbackText))
  });
}

function normalizedSelection(selection, sourceCount) {
  if (!Array.isArray(selection)) fail('REV_ATTACHMENT_SELECTION', 'Selection must be an array.');
  const seen = new Set();
  return selection.map((entry) => {
    const index = typeof entry === 'number' ? entry : entry?.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= sourceCount || seen.has(index)) {
      fail('REV_ATTACHMENT_SELECTION', 'Selection must name each attached file at most once.');
    }
    seen.add(index);
    const lineRanges = typeof entry === 'number' ? null : entry.lineRanges ?? null;
    if (lineRanges !== null && (!Array.isArray(lineRanges) || !lineRanges.length
      || lineRanges.length > MAX_SELECTION_RANGES)) {
      fail('REV_ATTACHMENT_SELECTION', 'Line selection must contain 1 to 256 ranges.');
    }
    if (lineRanges !== null) {
      let previousEnd = 0;
      for (const range of lineRanges) {
        if (!Number.isSafeInteger(range?.startLine) || !Number.isSafeInteger(range?.endLine)
          || range.startLine < 1 || range.endLine < range.startLine || range.startLine <= previousEnd) {
          fail('REV_ATTACHMENT_SELECTION', 'Line ranges must be sorted, disjoint, and one-based.');
        }
        previousEnd = range.endLine;
      }
    }
    return { index, lineRanges };
  }).sort((a, b) => a.index - b.index);
}

function displayName(source) {
  const supplied = source?.displayName ?? source?.path;
  if (typeof supplied !== 'string') fail('REV_ATTACHMENT_SOURCE', 'An attachment display name is required.');
  const name = path.win32.basename(path.posix.basename(supplied)).normalize('NFC');
  if (!name || name === '.' || name === '..' || /[\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name) > 255) {
    fail('REV_ATTACHMENT_SOURCE', 'Attachment display name is invalid.');
  }
  if (scanText(name).length) fail('REV_ATTACHMENT_SECRET', 'Attachment name may contain a credential; it was not registered.');
  return name;
}

async function sourceBytes(source, context, policy, authorizeRead) {
  const name = displayName(source);
  if (source?.source === 'copilot-host-attachment') {
    if (!Buffer.isBuffer(source.bytes) && !(source.bytes instanceof Uint8Array)) {
      fail('REV_CHAT_ATTACHMENT_UNAVAILABLE', 'Copilot did not expose verifiable original bytes. Import the same document with revision attachments preview --file <local-path>.');
    }
    if (typeof source.sourceHandle !== 'string' || !source.sourceHandle.trim()) {
      fail('REV_CHAT_ATTACHMENT_UNAVAILABLE', 'Copilot did not expose a stable attachment handle. Import the same document with revision attachments preview --file <local-path>.');
    }
    const bytes = Buffer.from(source.bytes);
    if (!bytes.length || bytes.length > policy.maximumOriginalBytesPerFile) {
      fail('REV_ATTACHMENT_SIZE', 'Attachment exceeds the configured original-byte limit or is empty.');
    }
    return { bytes, name, source: 'copilot-host-attachment', sourceHandleSha256: digest(Buffer.from(source.sourceHandle)) };
  }
  if (source?.source !== 'local-file' || typeof source.path !== 'string' || !path.isAbsolute(source.path)) {
    fail('REV_ATTACHMENT_SOURCE', 'Attachment requires a verifiable absolute local file or Copilot-host byte source.');
  }
  if (typeof authorizeRead !== 'function') fail('REV_ATTACHMENT_UNAUTHORIZED', 'No explicit attachment-read authority was supplied.');
  let resolved;
  try { resolved = await realpath(source.path); }
  catch { fail('REV_ATTACHMENT_UNAVAILABLE', 'Attachment file is unavailable.'); }
  if (await authorizeRead({ context, resolvedPath: resolved, requestedPath: source.path }) !== true) {
    fail('REV_ATTACHMENT_UNAUTHORIZED', 'Attachment file read was not authorized for the selected work session.');
  }
  let handle;
  try {
    handle = await open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > policy.maximumOriginalBytesPerFile) {
      fail('REV_ATTACHMENT_SIZE', 'Attachment must be a nonempty regular file within the configured byte limit.');
    }
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) fail('REV_ATTACHMENT_CHANGED', 'Attachment changed while it was read; preview it again.');
      read += result.bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail('REV_ATTACHMENT_CHANGED', 'Attachment changed while it was read; preview it again.');
    }
    return { bytes, name, source: 'local-file', sourceHandleSha256: digest(Buffer.from(resolved)) };
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail('REV_ATTACHMENT_UNAVAILABLE', 'Attachment file could not be read safely.');
  } finally { await handle?.close(); }
}

function isBinaryDisguisedAsText(bytes) {
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    || (bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
}

function validateRenditionText(text) {
  if (typeof text !== 'string' || !text.trim()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail('REV_ATTACHMENT_MIME', 'Extracted text is empty or contains binary or terminal-control bytes.');
  }
}

function binaryMagicMatches(bytes, mediaType) {
  if (mediaType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  if (mediaType === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === 'image/jpeg') return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  return false;
}

async function providerCall(action, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider timeout')), PROVIDER_TIMEOUT_MS);
      })
    ]);
  } catch {
    fail(code, 'Configured binary admission provider failed or timed out; no attachment was registered.');
  } finally { clearTimeout(timer); }
}

function providerReady(capabilities, profileSha256, mediaType) {
  return capabilities?.ready === true
    && capabilities.profileSha256 === profileSha256
    && Array.isArray(capabilities.mediaTypes)
    && capabilities.mediaTypes.includes(mediaType);
}

/**
 * A caller must supply this only after independently approving the exact scanner and extractor
 * profiles. A provider's self-description is never treated as approval or malware clearance.
 */
async function assessBinary(source, selected, policy, mediaType, binaryAdmission) {
  if (!binaryAdmission) {
    fail('REV_ATTACHMENT_TYPE_UNAVAILABLE',
      'PDF, DOCX, and image intake require an approved malware scanner and validated extractor; none is registered.');
  }
  const approval = binaryAdmission.approval;
  const scanner = binaryAdmission.scanner;
  const extractor = binaryAdmission.extractor;
  if (!approval || typeof approval.policyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(approval.policyId)
    || !validDigest(approval.scannerProfileSha256) || !validDigest(approval.extractorProfileSha256)
    || !Array.isArray(approval.mediaTypes) || approval.mediaTypes.length < 1
    || approval.mediaTypes.length > 5 || new Set(approval.mediaTypes).size !== approval.mediaTypes.length
    || !approval.mediaTypes.includes(mediaType)
    || approval.mediaTypes.some((type) => !Object.values(EXTRACTABLE_BINARY_TYPES).includes(type))
    || typeof scanner?.capabilities !== 'function' || typeof scanner?.scan !== 'function'
    || typeof extractor?.capabilities !== 'function' || typeof extractor?.extract !== 'function') {
    fail('REV_ATTACHMENT_BINARY_POLICY', 'Binary intake requires an explicit approved scanner/extractor policy for this format.');
  }
  if (source.claimedMediaType != null && source.claimedMediaType !== mediaType) {
    fail('REV_ATTACHMENT_MIME', 'Attachment type claim does not match the registered file type.');
  }
  if (!binaryMagicMatches(source.bytes, mediaType)) {
    fail('REV_ATTACHMENT_MIME', 'Binary attachment magic bytes do not match its claimed format.');
  }
  const originalSha256 = digest(source.bytes);
  const scannerCapability = await providerCall(() => scanner.capabilities(), 'REV_ATTACHMENT_SCAN_UNAVAILABLE');
  const extractorCapability = await providerCall(() => extractor.capabilities(), 'REV_ATTACHMENT_EXTRACT_UNAVAILABLE');
  if (!providerReady(scannerCapability, approval.scannerProfileSha256, mediaType)
    || !providerReady(extractorCapability, approval.extractorProfileSha256, mediaType)) {
    fail('REV_ATTACHMENT_BINARY_POLICY', 'Configured binary providers are not ready for the exact approved profiles and format.');
  }
  const scan = await providerCall(() => scanner.scan({
    bytes: Buffer.from(source.bytes), originalSha256, mediaType
  }), 'REV_ATTACHMENT_SCAN_UNAVAILABLE');
  if (scan?.verdict !== 'clean') {
    fail('REV_ATTACHMENT_SCAN_REJECTED', 'Binary attachment was not reported clean by the configured scanner.');
  }
  if (scan.originalSha256 !== originalSha256
    || scan.profileSha256 !== approval.scannerProfileSha256
    || !validDigest(scan.signatureSetSha256)) {
    fail('REV_ATTACHMENT_SCAN_UNAVAILABLE', 'Scanner verdict did not attest the exact bytes and approved profile.');
  }
  const extraction = await providerCall(() => extractor.extract({
    bytes: Buffer.from(source.bytes), originalSha256, mediaType,
    maximumExtractedBytes: MAX_EXTRACTED_BYTES, maximumSourceUnits: MAX_SOURCE_UNITS
  }), 'REV_ATTACHMENT_EXTRACT_UNAVAILABLE');
  if (extraction?.originalSha256 !== originalSha256
    || extraction.profileSha256 !== approval.extractorProfileSha256
    || !Array.isArray(extraction.segments) || !extraction.segments.length
    || extraction.segments.length > MAX_SOURCE_UNITS) {
    fail('REV_ATTACHMENT_EXTRACT_UNAVAILABLE', 'Extractor did not attest bounded content from the exact approved profile and bytes.');
  }
  const requiredUnitKind = mediaType === 'application/pdf' ? 'page'
    : mediaType.startsWith('image/') ? 'region' : 'section';
  const parts = [];
  const sourceUnits = [];
  let nextLine = 1;
  let extractedBytes = 0;
  let lastSourceIndex = 0;
  for (const segment of extraction.segments) {
    if (segment?.kind !== requiredUnitKind || typeof segment.text !== 'string'
      || !Number.isSafeInteger(segment.index) || segment.index <= lastSourceIndex
      || segment.index > 10_000) {
      fail('REV_ATTACHMENT_EXTRACT_UNAVAILABLE', 'Extractor returned an invalid source unit.');
    }
    lastSourceIndex = segment.index;
    if (Buffer.byteLength(segment.text) > MAX_EXTRACTED_BYTES) {
      fail('REV_ATTACHMENT_RENDITION_SIZE', 'Extracted text exceeds the binary intake limit.');
    }
    const text = segment.text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
    validateRenditionText(text);
    extractedBytes += Buffer.byteLength(text);
    if (extractedBytes > MAX_EXTRACTED_BYTES) {
      fail('REV_ATTACHMENT_RENDITION_SIZE', 'Extracted text exceeds the binary intake limit.');
    }
    const endLine = nextLine + text.split('\n').length - 1;
    sourceUnits.push({ kind: requiredUnitKind, index: segment.index, startLine: nextLine, endLine });
    nextLine = endLine + 1;
    parts.push(text);
  }
  const lines = parts.join('\n').split('\n');
  if (scanText(parts.join('\n')).length) {
    fail('REV_ATTACHMENT_SECRET', 'Extracted attachment may contain a credential; it was not registered.');
  }
  const ranges = selected ? (selected.lineRanges ?? [{ startLine: 1, endLine: lines.length }]) : null;
  if (ranges?.some((range) => range.endLine > lines.length)) {
    fail('REV_ATTACHMENT_SELECTION', 'Selected line range exceeds extracted attachment text.');
  }
  const rendition = ranges
    ? Buffer.from(ranges.map((range) => lines.slice(range.startLine - 1, range.endLine).join('\n')).join('\n'))
    : null;
  if (rendition && (rendition.length === 0 || rendition.length > policy.maximumSelectedRenditionBytes)) {
    fail('REV_ATTACHMENT_RENDITION_SIZE', 'Selected extracted text is empty or exceeds the rendition limit.');
  }
  const selectedProvenance = ranges?.flatMap((range) => sourceUnits.flatMap((unit) => {
    const startLine = Math.max(range.startLine, unit.startLine);
    const endLine = Math.min(range.endLine, unit.endLine);
    return startLine <= endLine ? [{ kind: unit.kind, index: unit.index, startLine, endLine }] : [];
  })) ?? null;
  return {
    metadata: {
      kind: 'user-document', source: source.source, sourceHandleSha256: source.sourceHandleSha256,
      displayName: source.name, mediaType, bytes: source.bytes.length, originalSha256,
      selected: Boolean(selected), retentionClass: policy.retentionClass, accessClass: policy.accessClass,
      extractionStatus: 'complete', parser: 'policy-pinned-external-extractor@1',
      lineCount: lines.length, sourceUnits, selectedRanges: ranges, selectedProvenance,
      renditionSha256: rendition ? digest(rendition) : null,
      scanStatus: 'configured-provider-reported-clean',
      scannerProfileSha256: approval.scannerProfileSha256,
      signatureSetSha256: scan.signatureSetSha256,
      extractorProfileSha256: approval.extractorProfileSha256,
      binaryAdmissionPolicySha256: recordDigest(approval),
      validationOutcome: 'provider-reported-scan-and-extraction', modelReadable: Boolean(selected)
    }, rendition
  };
}

/** Validate the entire delimited document, including unselected rows and quoted newlines. */
function parseDelimitedRows(text, separator) {
  const rows = [];
  let line = 1;
  let rowStartLine = 1;
  let columns = 1;
  let maximumColumns = 0;
  let state = 'field-start';
  const completeRow = () => {
    if (columns > MAX_DELIMITED_COLUMNS || rows.length >= MAX_DELIMITED_ROWS) {
      fail('REV_ATTACHMENT_FORMAT_LIMIT', 'Delimited attachment exceeds the row or column validation limit.');
    }
    rows.push({ startLine: rowStartLine, endLine: line });
    maximumColumns = Math.max(maximumColumns, columns);
    columns = 1;
    state = 'field-start';
  };
  for (const character of text) {
    if (character === '\n') {
      if (state !== 'quoted') completeRow();
      line += 1;
      if (state !== 'quoted') rowStartLine = line;
      continue;
    }
    if (state === 'quoted') {
      if (character === '"') state = 'after-quote';
      continue;
    }
    if (character === separator) {
      if (state === 'after-quote' || state === 'unquoted' || state === 'field-start') {
        columns += 1;
        state = 'field-start';
        continue;
      }
    }
    if (character === '"') {
      if (state === 'field-start' || state === 'after-quote') {
        state = 'quoted';
        continue;
      }
      fail('REV_ATTACHMENT_MIME', 'Delimited attachment contains an invalid quote.');
    }
    if (state === 'after-quote') {
      fail('REV_ATTACHMENT_MIME', 'Delimited attachment contains content after a closing quote.');
    }
    state = 'unquoted';
  }
  if (state === 'quoted') fail('REV_ATTACHMENT_MIME', 'Delimited attachment has an unclosed quoted field.');
  if (!text.endsWith('\n')) completeRow();
  if (!rows.length) fail('REV_ATTACHMENT_MIME', 'Delimited attachment contains no records.');
  return { rows, rowCount: rows.length, maximumColumns };
}

function selectedDelimitedRows(rows, ranges) {
  const byStart = new Map(rows.map((row, index) => [row.startLine, index]));
  const byEnd = new Map(rows.map((row, index) => [row.endLine, index]));
  return ranges.map((range) => {
    const first = byStart.get(range.startLine);
    const last = byEnd.get(range.endLine);
    if (first === undefined || last === undefined || first > last) {
      fail('REV_ATTACHMENT_SELECTION', 'Delimited selection must include complete records, including quoted multiline fields.');
    }
    return { startRow: first + 1, endRow: last + 1 };
  });
}

async function assessBytes(source, selected, policy, binaryAdmission) {
  const extension = path.extname(source.name).toLowerCase();
  const expectedType = TEXT_TYPES[extension];
  if (!expectedType) {
    const binaryMediaType = EXTRACTABLE_BINARY_TYPES[extension];
    if (binaryMediaType) return assessBinary(source, selected, policy, binaryMediaType, binaryAdmission);
    const reason = BINARY_TYPES.has(extension)
      ? 'PDF, DOCX, and image intake require an approved malware scanner and validated extractor; none is registered.'
      : 'This attachment format has no registered REV intake validator.';
    fail('REV_ATTACHMENT_TYPE_UNAVAILABLE', reason);
  }
  if (source.claimedMediaType != null && source.claimedMediaType !== expectedType) {
    fail('REV_ATTACHMENT_MIME', 'Attachment type claim does not match the registered file type.');
  }
  const originalSha256 = digest(source.bytes);
  const basic = {
    kind: 'user-document', source: source.source, sourceHandleSha256: source.sourceHandleSha256,
    displayName: source.name, mediaType: expectedType, bytes: source.bytes.length, originalSha256,
    selected: Boolean(selected), retentionClass: policy.retentionClass, accessClass: policy.accessClass
  };
  let text;
  if (isBinaryDisguisedAsText(source.bytes)) {
    fail('REV_ATTACHMENT_MIME', 'Attachment has binary document magic bytes but claims a text format.');
  }
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes); }
  catch { fail('REV_ATTACHMENT_MIME', 'Text attachment is not valid UTF-8.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail('REV_ATTACHMENT_MIME', 'Text attachment contains binary or terminal-control bytes.');
  }
  let decodedJson = null;
  if (extension === '.json') {
    try { decodedJson = JSON.stringify(JSON.parse(text)); }
    catch { fail('REV_ATTACHMENT_MIME', 'JSON attachment could not be fully validated.'); }
  }
  // Parsing decodes JSON escapes; screen both the original representation and decoded values.
  if (scanText(text).length || (decodedJson !== null && scanText(decodedJson).length)) {
    fail('REV_ATTACHMENT_SECRET', 'Attachment may contain a credential; it was not registered.');
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const delimited = extension === '.csv' || extension === '.tsv'
    ? parseDelimitedRows(lines.join('\n'), extension === '.csv' ? ',' : '\t') : null;
  const ranges = selected ? (selected.lineRanges ?? [{
    startLine: 1, endLine: delimited ? delimited.rows.at(-1).endLine : lines.length
  }]) : null;
  if (ranges?.some((range) => range.endLine > lines.length)) {
    fail('REV_ATTACHMENT_SELECTION', 'Selected line range exceeds the attachment.');
  }
  const selectedRowRanges = delimited && ranges ? selectedDelimitedRows(delimited.rows, ranges) : null;
  const rendition = ranges
    ? Buffer.from(ranges.map((range) => lines.slice(range.startLine - 1, range.endLine).join('\n')).join('\n'))
    : null;
  if (rendition && rendition.length === 0) {
    fail('REV_ATTACHMENT_SELECTION', 'Selected text rendition is empty; select nonempty lines.');
  }
  if (rendition && rendition.length > policy.maximumSelectedRenditionBytes) {
    fail('REV_ATTACHMENT_RENDITION_SIZE', 'Selected text exceeds the rendition limit; select fewer lines.');
  }
  return {
    metadata: { ...basic, extractionStatus: 'complete', parser: delimited ? 'utf8-delimited-records@1' : 'utf8-lines@1',
      lineCount: lines.length, renditionSha256: rendition ? digest(rendition) : null,
      selectedRanges: ranges, ...(delimited ? {
        rowCount: delimited.rowCount, maximumColumns: delimited.maximumColumns, selectedRowRanges
      } : {}),
      validationOutcome: delimited ? 'utf8-delimited-parse-and-secret-scan' : 'utf8-and-secret-scan',
      modelReadable: Boolean(selected) },
    rendition
  };
}

async function evaluate({ context, sources, selection, policy, authorizeRead, binaryAdmission }) {
  const effectivePolicy = normalizedPolicy(policy);
  const exactContext = normalizedContext(context, effectivePolicy);
  if (!Array.isArray(sources) || sources.length > effectivePolicy.maximumFilesPerFeedback) {
    fail('REV_ATTACHMENT_COUNT', 'Attachment count exceeds the configured per-feedback limit.');
  }
  const selected = normalizedSelection(selection, sources.length);
  const selectedByIndex = new Map(selected.map((item) => [item.index, item]));
  const assessed = [];
  for (let index = 0; index < sources.length; index += 1) {
    const loaded = await sourceBytes(sources[index], context, effectivePolicy, authorizeRead);
    loaded.claimedMediaType = sources[index]?.mediaType ?? null;
    const result = await assessBytes(loaded, selectedByIndex.get(index), effectivePolicy, binaryAdmission);
    assessed.push({ ...result, original: loaded.bytes });
  }
  if (assessed.reduce((total, item) => total + (item.rendition?.length ?? 0), 0)
    > effectivePolicy.maximumSelectedRenditionBytes) {
    fail('REV_ATTACHMENT_RENDITION_SIZE', 'Selected renditions exceed the per-feedback byte limit.');
  }
  const attachmentMetadata = assessed.map((item) => item.metadata);
  const inputSha256 = recordDigest({
    context: exactContext, policySha256: recordDigest(effectivePolicy),
    attachments: attachmentMetadata
  });
  return { exactContext, effectivePolicy, selected, assessed, attachmentMetadata, inputSha256 };
}

/** Read-only import preview. No bytes or paths are persisted. */
export async function previewFeedbackAttachments({
  context, sources = [], selection = [], policy = {}, authorizeRead, binaryAdmission, now = Date.now()
}) {
  const evaluated = await evaluate({ context, sources, selection, policy, authorizeRead, binaryAdmission });
  if (!Number.isFinite(now)) fail('REV_ATTACHMENT_PLAN', 'Preview time is invalid.');
  const core = {
    schemaVersion: 1, kind: 'revision-feedback-attachment-import-plan',
    ...evaluated.exactContext,
    policySha256: recordDigest(evaluated.effectivePolicy),
    inputSha256: evaluated.inputSha256,
    attachments: evaluated.attachmentMetadata,
    selectedIndexes: evaluated.selected.map((item) => item.index),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + evaluated.effectivePolicy.planTtlMs).toISOString(),
    expectedEffects: ['persist-selected-original-and-rendition', 'append-attachment-set-receipt']
  };
  const plan = { ...core, planSha256: recordDigest(core) };
  return {
    plan,
    preview: {
      kind: 'revision-feedback-attachment-preview',
      workId: plan.workId, phaseId: plan.phaseId, phaseGeneration: plan.phaseGeneration,
      loopStatus: plan.loopStatus,
      feedbackSha256: plan.feedbackSha256,
      attachments: evaluated.attachmentMetadata,
      selectedCount: evaluated.selected.length,
      effects: ['register feedback evidence only; no revision, model call, approval, or publication']
    }
  };
}

/**
 * Revalidates original bytes, selection, policy, context, and explicit confirmation before asking
 * a caller-provided transaction store to persist selected objects and an append-only receipt.
 * `store.append` must be atomic and must enforce idempotency-key uniqueness/CAS in its own store.
 */
export async function registerFeedbackAttachments({
  plan, context, sources = [], selection = [], confirm, idempotencyKey,
  policy = {}, authorizeRead, binaryAdmission, assertCurrentContext, store, now = Date.now()
}) {
  if (!plan || plan.kind !== 'revision-feedback-attachment-import-plan' || !validDigest(plan.planSha256)) {
    fail('REV_ATTACHMENT_PLAN', 'A valid feedback-attachment import plan is required.');
  }
  const { planSha256, ...planCore } = plan;
  if (recordDigest(planCore) !== planSha256 || confirm !== planSha256) {
    fail('REV_ATTACHMENT_CONFIRMATION', 'Confirm the exact current attachment import plan digest.');
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
    fail('REV_ATTACHMENT_IDEMPOTENCY', 'A bounded idempotency key is required.');
  }
  if (typeof assertCurrentContext !== 'function' || !store
    || typeof store.findByIdempotencyKey !== 'function' || typeof store.append !== 'function') {
    fail('REV_ATTACHMENT_STORE', 'Registration requires a current-context check and an atomic evidence store.');
  }
  const evaluated = await evaluate({ context, sources, selection, policy, authorizeRead, binaryAdmission });
  if (!evaluated.selected.length) {
    fail('REV_ATTACHMENT_SELECTION', 'Select at least one attachment before registration.');
  }
  if (evaluated.inputSha256 !== plan.inputSha256 || !equalJson(evaluated.attachmentMetadata, plan.attachments)
    || !equalJson(evaluated.exactContext, {
      workId: plan.workId, phaseId: plan.phaseId, phaseGeneration: plan.phaseGeneration,
      loopId: plan.loopId, loopRevision: plan.loopRevision,
      loopStatus: plan.loopStatus,
      headCommit: plan.headCommit, sourceTreeSha256: plan.sourceTreeSha256,
      configSha256: plan.configSha256, workflowSha256: plan.workflowSha256,
      repositorySha256: plan.repositorySha256, feedbackSha256: plan.feedbackSha256
    })) {
    fail('REV_ATTACHMENT_PLAN_STALE', 'Attachment bytes, selection, feedback, work, phase, or policy changed; preview again.');
  }
  if (await assertCurrentContext(context, plan) !== true) {
    fail('REV_ATTACHMENT_PLAN_STALE', 'The active work or phase changed; preview again.');
  }
  const selected = evaluated.assessed.filter((item) => item.metadata.selected);
  const attachments = selected.map((item) => {
    const { selected: _selected, ...metadata } = item.metadata;
    return metadata;
  });
  const requestSha256 = recordDigest({ planSha256, idempotencyKey, attachments });
  const existing = await store.findByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (existing.requestSha256 !== requestSha256) {
      fail('REV_ATTACHMENT_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different attachment set.');
    }
    return existing.receipt;
  }
  if (Date.parse(plan.expiresAt) <= now) fail('REV_ATTACHMENT_PLAN_EXPIRED', 'Attachment import plan expired; preview again.');
  const core = {
    schemaVersion: 1, kind: 'revision-feedback-attachment-set',
    workId: plan.workId, phaseId: plan.phaseId, phaseGeneration: plan.phaseGeneration,
    loopId: plan.loopId, loopRevision: plan.loopRevision,
    loopStatus: plan.loopStatus,
    headCommit: plan.headCommit, sourceTreeSha256: plan.sourceTreeSha256,
    configSha256: plan.configSha256, workflowSha256: plan.workflowSha256,
    repositorySha256: plan.repositorySha256, feedbackSha256: plan.feedbackSha256,
    importPlanSha256: planSha256, policySha256: plan.policySha256,
    attachments, confirmed: true, registeredAt: new Date(now).toISOString()
  };
  const receipt = { ...core, attachmentSetSha256: recordDigest(core) };
  const objects = selected.flatMap((item) => [
    { role: 'original', sha256: item.metadata.originalSha256, bytes: item.original },
    ...(item.rendition ? [{ role: 'selected-rendition', sha256: item.metadata.renditionSha256, bytes: item.rendition }] : [])
  ]);
  const persisted = await store.append({ idempotencyKey, requestSha256, receipt, objects, expectedContext: evaluated.exactContext });
  if (!persisted || persisted.requestSha256 !== requestSha256
    || persisted.receipt?.kind !== 'revision-feedback-attachment-set'
    || !validDigest(persisted.receipt?.attachmentSetSha256)) {
    fail('REV_ATTACHMENT_STORE', 'Evidence store did not confirm the exact attachment-set receipt.');
  }
  return persisted.receipt;
}

export const feedbackAttachmentDefaults = DEFAULT_POLICY;

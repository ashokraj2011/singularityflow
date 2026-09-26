/**
 * Inert, bounded capture of one explicitly selected local skill directory.
 *
 * This module deliberately has no configuration, host, Git, model, or network calls. A caller may
 * show proposals from the captured text, but must separately compile and approve a phase contract.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKP_PACKAGE_FORMAT = 'sflow-skill-package/v1';
export const SKP_PARSER_PROFILE = 'skp-skill-text/v1';
export const SKP_DECLARATION_FORMAT = 'sflow-skill-declarations/v1';
export const SKP_CAPTURE_LIMITS = Object.freeze({
  files: 256,
  directories: 512,
  depth: 16,
  entryBytes: 256 * 1024,
  // Current WFA accepts at most 1 MiB per asset and 16 MiB for the entire Story closure.
  referenceBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathBytes: 1024
});

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_DECLARATION_KEYS = new Set([
  'format', 'description', 'outputs', 'inputs', 'capabilityRequests'
]);
const ALLOWED_OUTPUT_KEYS = new Set(['id', 'path', 'kind', 'description']);
const ALLOWED_INPUT_KEYS = new Set(['phase', 'output', 'required']);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(code, message, details) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function packageDigest(core) {
  return `sha256:${createHash('sha256').update('skp.package.v1\0')
    .update(canonicalJson(core)).digest('hex')}`;
}

function comparePortable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkedLimits(requested = {}) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    fail('SKP_BUDGET_EXCEEDED', 'Skill capture limits must be an object.');
  }
  const result = {};
  for (const [name, ceiling] of Object.entries(SKP_CAPTURE_LIMITS)) {
    const value = requested[name] ?? ceiling;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      fail('SKP_BUDGET_EXCEEDED', `Skill capture limit '${name}' must be between 1 and ${ceiling}.`,
        { dimension: name, limit: ceiling, requested: value });
    }
    result[name] = value;
  }
  if (Object.keys(requested).some((key) => !(key in SKP_CAPTURE_LIMITS))) {
    fail('SKP_BUDGET_EXCEEDED', 'Skill capture has an unknown limit dimension.');
  }
  return result;
}

function portableSegment(segment) {
  const portableAlias = segment?.normalize('NFKC').toLowerCase();
  if (!segment || segment === '.' || segment === '..' || segment !== segment.normalize('NFC')
      || segment.startsWith('.')
      || /[<>:"\\|?*\u0000-\u001f\u007f]/u.test(segment)
      || /[. ]$/u.test(segment) || WINDOWS_RESERVED.test(segment)
      || WINDOWS_RESERVED.test(portableAlias)) {
    fail('SKP_PATH_REFUSED', `Skill package contains a non-portable path segment '${segment}'.`);
  }
  return portableAlias;
}

/** Validate a slash-separated package path, never a host absolute path. */
export function assertSkillPackagePath(relativePath, limits = SKP_CAPTURE_LIMITS) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/')
      || relativePath.includes('\\') || relativePath.split('/').some((part) => !part)) {
    fail('SKP_PATH_REFUSED', 'Skill package path must be a non-empty portable relative path.');
  }
  if (Buffer.byteLength(relativePath, 'utf8') > limits.pathBytes) {
    fail('SKP_BUDGET_EXCEEDED', `Skill package path exceeds ${limits.pathBytes} bytes.`,
      { dimension: 'pathBytes', limit: limits.pathBytes, path: relativePath });
  }
  return relativePath.split('/').map(portableSegment).join('/');
}

function roleFor(relativePath) {
  if (relativePath === 'SKILL.md') return 'instructions';
  if (relativePath === 'sflow-skill.json') return 'declaration';
  if (relativePath.startsWith('references/')) return 'reference';
  if (relativePath.startsWith('templates/')) return 'template';
  if (relativePath.startsWith('scripts/')) return 'script';
  return 'asset';
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/**
 * Read exactly the size observed before capture, then probe one byte for concurrent growth.
 * `FileHandle.readFile()` can keep allocating while another process appends to the file; this
 * bounded positional read never requests or retains more than the admitted per-file limit.
 * Exported for a deterministic growth-race test with a virtual file handle.
 */
export async function readBoundedSkillFile(handle, expectedBytes, maxBytes, relativePath) {
  const ceiling = relativePath === 'SKILL.md'
    ? SKP_CAPTURE_LIMITS.entryBytes : SKP_CAPTURE_LIMITS.referenceBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling) {
    fail('SKP_BUDGET_EXCEEDED', `Skill file '${relativePath}' has an invalid read limit.`,
      { dimension: relativePath === 'SKILL.md' ? 'entryBytes' : 'referenceBytes',
        path: relativePath, limit: ceiling, requested: maxBytes });
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    fail('SKP_BUDGET_EXCEEDED', `Skill file '${relativePath}' exceeds ${maxBytes} bytes.`,
      { dimension: relativePath === 'SKILL.md' ? 'entryBytes' : 'referenceBytes',
        path: relativePath, limit: maxBytes, actual: expectedBytes });
  }
  const bytes = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
    if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 1
        || result.bytesRead > expectedBytes - offset) {
      fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' changed while reading.`);
    }
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  const { bytesRead: extra } = await handle.read(probe, 0, 1, expectedBytes);
  if (extra !== 0) {
    fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' grew while reading.`);
  }
  return bytes;
}

async function stableFile(absolute, relativePath, maxBytes) {
  const before = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' disappeared.`);
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    fail('SKP_PATH_REFUSED', `Skill entry '${relativePath}' must be an ordinary file.`);
  }
  if (before.size > maxBytes) {
    fail('SKP_BUDGET_EXCEEDED', `Skill file '${relativePath}' exceeds ${maxBytes} bytes.`,
      { dimension: relativePath === 'SKILL.md' ? 'entryBytes' : 'referenceBytes',
        path: relativePath, limit: maxBytes, actual: before.size });
  }
  let handle;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' changed while opening.`);
    }
    const bytes = await readBoundedSkillFile(handle, opened.size, maxBytes, relativePath);
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || bytes.byteLength !== after.size) {
      fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' changed while reading.`);
    }
    const rebound = await lstat(absolute).catch(() => null);
    if (!rebound || rebound.isSymbolicLink() || !sameIdentity(before, rebound)) {
      fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' changed after reading.`);
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      fail('SKP_PATH_REFUSED', `Skill file '${relativePath}' became a link.`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scan(directory, limits) {
  const files = new Map();
  const directories = [];
  const aliases = new Map();
  let totalBytes = 0;
  async function walk(absolute, prefix, depth) {
    if (depth > limits.depth) {
      fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds directory depth ${limits.depth}.`,
        { dimension: 'depth', limit: limits.depth, path: prefix });
    }
    const before = await lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') fail('SKP_CAPTURE_UNSTABLE', `Skill directory '${prefix || '.'}' disappeared.`);
      throw error;
    });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail('SKP_PATH_REFUSED', `Skill directory '${prefix || '.'}' must be ordinary, not a link.`);
    }
    directories.push(prefix);
    if (directories.length > limits.directories) {
      fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds ${limits.directories} directories.`,
        { dimension: 'directories', limit: limits.directories, actual: directories.length });
    }
    let handle;
    try {
      handle = await opendir(absolute);
      for await (const entry of handle) {
        const child = prefix ? `${prefix}/${entry.name}` : entry.name;
        const alias = assertSkillPackagePath(child, limits);
        if (aliases.has(alias)) {
          fail('SKP_ID_CASE_COLLISION', `Skill paths '${aliases.get(alias)}' and '${child}' alias on a supported filesystem.`,
            { paths: [aliases.get(alias), child] });
        }
        aliases.set(alias, child);
        if (entry.name.startsWith('.')) {
          fail('SKP_PATH_REFUSED', `Hidden skill entry '${child}' requires separate admission.`);
        }
        const childAbsolute = path.join(absolute, entry.name);
        const metadata = await lstat(childAbsolute).catch((error) => {
          if (error?.code === 'ENOENT') fail('SKP_CAPTURE_UNSTABLE', `Skill entry '${child}' disappeared.`);
          throw error;
        });
        if (metadata.isSymbolicLink()) {
          fail('SKP_PATH_REFUSED', `Skill entry '${child}' is a symbolic link or junction.`);
        }
        if (metadata.isDirectory()) {
          await walk(childAbsolute, child, depth + 1);
        } else if (metadata.isFile()) {
          if (files.size >= limits.files) {
            fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds ${limits.files} files.`,
              { dimension: 'files', limit: limits.files, actual: files.size + 1 });
          }
          const maxBytes = child === 'SKILL.md' ? limits.entryBytes : limits.referenceBytes;
          const bytes = await stableFile(childAbsolute, child, maxBytes);
          totalBytes += bytes.byteLength;
          if (totalBytes > limits.totalBytes) {
            fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds ${limits.totalBytes} total bytes.`,
              { dimension: 'totalBytes', limit: limits.totalBytes, actual: totalBytes });
          }
          files.set(child, bytes);
        } else {
          fail('SKP_PATH_REFUSED', `Skill entry '${child}' is not an ordinary file or directory.`);
        }
      }
      handle = null; // for-await closes the directory handle
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        fail('SKP_CAPTURE_UNSTABLE', `Skill directory '${prefix || '.'}' changed while listing.`);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    const after = await lstat(absolute).catch(() => null);
    if (!after || after.isSymbolicLink() || !sameIdentity(before, after)) {
      fail('SKP_CAPTURE_UNSTABLE', `Skill directory '${prefix || '.'}' changed while listing.`);
    }
  }
  await walk(directory, '', 0);
  if (!files.has('SKILL.md')) {
    fail('SKP_SKILL_MISSING', 'Selected skill directory must contain an exact SKILL.md entry.');
  }
  return { files, directories: directories.sort(comparePortable), totalBytes };
}

function assertClosedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SKP_MANIFEST_INVALID', `${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('SKP_MANIFEST_INVALID', `${label} has unsupported field '${key}'.`);
  }
}

function parseDeclarations(bytes) {
  if (!bytes) return null;
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('SKP_MANIFEST_INVALID', 'sflow-skill.json must be UTF-8.');
  }
  let data;
  try {
    data = JSON.parse(source);
  } catch {
    fail('SKP_MANIFEST_INVALID', 'sflow-skill.json must be strict JSON.');
  }
  const parsed = YAML.parseDocument(source, { uniqueKeys: true, schema: 'json' });
  if (parsed.errors.length) {
    fail('SKP_MANIFEST_INVALID', 'sflow-skill.json contains duplicate keys or unsupported syntax.');
  }
  assertClosedObject(data, ALLOWED_DECLARATION_KEYS, 'Skill declaration');
  if (data.format !== SKP_DECLARATION_FORMAT) {
    fail('SKP_MANIFEST_INVALID', `Skill declaration format must be '${SKP_DECLARATION_FORMAT}'.`);
  }
  if (data.description !== undefined && (typeof data.description !== 'string' || data.description.length > 4096)) {
    fail('SKP_MANIFEST_INVALID', 'Skill description must be a short string.');
  }
  if (data.outputs !== undefined) {
    if (!Array.isArray(data.outputs) || data.outputs.length > 32) {
      fail('SKP_MANIFEST_INVALID', 'Skill declaration outputs must be an array of at most 32 entries.');
    }
    for (const output of data.outputs) {
      assertClosedObject(output, ALLOWED_OUTPUT_KEYS, 'Skill output');
      if (!ID.test(output.id ?? '') || typeof output.path !== 'string') {
        fail('SKP_MANIFEST_INVALID', 'Each skill output needs a portable id and path.');
      }
      assertSkillPackagePath(output.path);
      if (output.kind !== undefined && (typeof output.kind !== 'string' || output.kind.length > 100)) {
        fail('SKP_MANIFEST_INVALID', 'Skill output kind must be a short string.');
      }
      if (output.description !== undefined && (typeof output.description !== 'string' || output.description.length > 4096)) {
        fail('SKP_MANIFEST_INVALID', 'Skill output description must be a short string.');
      }
    }
  }
  if (data.inputs !== undefined) {
    if (!Array.isArray(data.inputs) || data.inputs.length > 32) {
      fail('SKP_MANIFEST_INVALID', 'Skill declaration inputs must be an array of at most 32 entries.');
    }
    for (const input of data.inputs) {
      assertClosedObject(input, ALLOWED_INPUT_KEYS, 'Skill input');
      if (!ID.test(input.phase ?? '') || !ID.test(input.output ?? '')
          || (input.required !== undefined && typeof input.required !== 'boolean')) {
        fail('SKP_MANIFEST_INVALID', 'Each skill input needs phase and output ids and an optional required flag.');
      }
    }
  }
  if (data.capabilityRequests !== undefined) {
    if (!Array.isArray(data.capabilityRequests) || data.capabilityRequests.length > 32
        || data.capabilityRequests.some((item) => typeof item !== 'string' || !item || item.length > 200)) {
      fail('SKP_MANIFEST_INVALID', 'Capability requests must be an array of short strings.');
    }
  }
  return data;
}

function inspectText(bytes, declarations, includedPaths) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('SKP_MANIFEST_INVALID', 'SKILL.md must be UTF-8 text.');
  }
  const proposals = [];
  const findings = [];
  const declaredOutputIds = new Map();
  for (const [index, output] of (declarations?.outputs ?? []).entries()) {
    const previous = declaredOutputIds.get(output.id);
    if (previous && previous !== output.path) {
      findings.push({ code: 'SKP_OUTPUT_AMBIGUOUS',
        message: `Output '${output.id}' has conflicting declared paths.`,
        sources: [`/outputs/${index}/path`, `/outputs/${declaredOutputIds.get(`${output.id}:index`)}/path`] });
    }
    declaredOutputIds.set(output.id, output.path);
    declaredOutputIds.set(`${output.id}:index`, index);
    proposals.push({ field: 'produces', value: { ...output }, status: 'candidate',
      inferredBy: 'structured-declaration', source: { path: 'sflow-skill.json', pointer: `/outputs/${index}` } });
  }
  for (const [index, input] of (declarations?.inputs ?? []).entries()) {
    proposals.push({ field: 'consumes', value: { ...input }, status: 'candidate',
      inferredBy: 'structured-declaration', source: { path: 'sflow-skill.json', pointer: `/inputs/${index}` } });
  }
  if (declarations?.description) {
    proposals.push({ field: 'description', value: declarations.description, status: 'candidate',
      inferredBy: 'structured-declaration', source: { path: 'sflow-skill.json', pointer: '/description' } });
  }
  for (const [index, request] of (declarations?.capabilityRequests ?? []).entries()) {
    findings.push({ code: 'SKP_CAPABILITY_REQUEST_UNRESOLVED',
      message: `Capability request '${request}' requires separate selection and approval.`,
      source: { path: 'sflow-skill.json', pointer: `/capabilityRequests/${index}` } });
  }
  let section = '';
  let codeFence = false;
  const proseOutputs = new Set();
  const missingReferences = new Set();
  const lines = source.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/u.test(line)) { codeFence = !codeFence; continue; }
    if (codeFence) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    for (const reference of line.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/gu)) {
      const target = reference[1].replace(/^<|>$/gu, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
      let local;
      try { local = decodeURIComponent(target).replace(/^\.\//u, ''); }
      catch { fail('SKP_PATH_REFUSED', `Skill reference at SKILL.md:${index + 1} has invalid encoding.`); }
      assertSkillPackagePath(local);
      if (!includedPaths.has(local)
          && ![...includedPaths].some((item) => item.startsWith(`${local}/`))) {
        missingReferences.add(local);
      }
    }
    if (/\b(?:do not|don't|never|must not|no)\b.{0,80}\b(?:edit|modify|change|write)\b.{0,40}\b(?:source|code|files?)\b/iu.test(line)) {
      continue;
    }
    if (/\b(?:edit|modify|change|write)\b.{0,40}\b(?:source|code|files?)\b/iu.test(line)) {
      findings.push({ code: 'SKP_EFFECTS_REVIEW_REQUIRED',
        message: 'Source-edit language requires an explicit effects decision.',
        source: { path: 'SKILL.md', line: index + 1 } });
    }
    if (!/^(?:outputs?|produces?|deliverables?)\b/u.test(section)
        || !/^\s*[-*]\s+/u.test(line)) continue;
    const match = /`((?:artifacts|deliverables)\/[^`]+)`/u.exec(line)
      ?? /(?:^|[\s(])((?:artifacts|deliverables)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,12})(?=\s|$|[),;])/u.exec(line);
    if (!match) continue;
    const candidate = match[1].trim();
    try { assertSkillPackagePath(candidate); } catch { continue; }
    if (proseOutputs.has(candidate)) continue;
    proseOutputs.add(candidate);
    proposals.push({ field: 'produces.path', value: candidate, status: 'candidate',
      inferredBy: 'output-section', source: { path: 'SKILL.md', line: index + 1 } });
  }
  if (proseOutputs.size > 1 && !(declarations?.outputs?.length)) {
    findings.push({ code: 'SKP_OUTPUT_AMBIGUOUS',
      message: 'Multiple prose output paths need explicit output IDs and confirmation.' });
  }
  if (declarations?.outputs?.length && [...proseOutputs].some((item) => !declarations.outputs.some((output) => output.path === item))) {
    findings.push({ code: 'SKP_OUTPUT_AMBIGUOUS',
      message: 'Prose output paths differ from structured declarations; review the intended outputs.' });
  }
  if (/\bhttps?:\/\/[^\s)>`]+/iu.test(source)) {
    findings.push({ code: 'SKP_REMOTE_REFERENCE_UNRESOLVED',
      message: 'Skill text contains a URL; inspection did not fetch it.' });
  }
  if (/(?:^|\n)\s*(?:allowed-tools|agent|hooks?)\s*:/iu.test(source)) {
    findings.push({ code: 'SKP_NATIVE_METADATA_UNTRUSTED',
      message: 'Native skill metadata is retained as text and grants no phase authority.' });
  }
  if (missingReferences.size) {
    fail('SKP_SKILL_MISSING',
      `Skill references unavailable local files: ${[...missingReferences].sort(comparePortable).join(', ')}.`,
      { paths: [...missingReferences].sort(comparePortable) });
  }
  return { proposals, findings };
}

/** Compare both complete read passes before any captured package may be sealed. */
export function assertStableSkillCapture(first, second) {
  if (first.directories.join('\0') !== second.directories.join('\0')
      || first.files.size !== second.files.size || first.totalBytes !== second.totalBytes) {
    fail('SKP_CAPTURE_UNSTABLE', 'Skill package membership changed during capture.');
  }
  for (const [relativePath, bytes] of first.files) {
    const again = second.files.get(relativePath);
    if (!again || !bytes.equals(again)) {
      fail('SKP_CAPTURE_UNSTABLE', `Skill file '${relativePath}' changed during capture.`);
    }
  }
}

/** Verify an in-memory package without consulting its former source directory. */
export function verifySkillPackage({ manifest, contents }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.format !== SKP_PACKAGE_FORMAT || manifest.parserProfile !== SKP_PARSER_PROFILE
      || manifest.entry !== 'SKILL.md' || !ID.test(manifest.skillId ?? '')
      || !Array.isArray(manifest.files) || manifest.files.length < 1
      || manifest.files.length > SKP_CAPTURE_LIMITS.files || !(contents instanceof Map)) {
    fail('SKP_PACKAGE_CORRUPT', 'Skill package manifest or retained bytes are invalid.');
  }
  const expectedFields = ['entry', 'files', 'format', 'packageSha256', 'parserProfile', 'skillId'];
  if (Object.keys(manifest).sort().join(',') !== expectedFields.sort().join(',')) {
    fail('SKP_PACKAGE_CORRUPT', 'Skill package manifest has unsupported fields.');
  }
  if (!SHA256.test(manifest.packageSha256) || contents.size !== manifest.files.length) {
    fail('SKP_PACKAGE_CORRUPT', 'Skill package has incomplete bytes or an invalid digest.');
  }
  let previous = '';
  let total = 0;
  const aliases = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).sort().join(',') !== 'bytes,path,role,sha256'
        || typeof file.path !== 'string' || (previous && comparePortable(previous, file.path) >= 0)
        || file.role !== roleFor(file.path) || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0 || !SHA256.test(file.sha256)) {
      fail('SKP_PACKAGE_CORRUPT', 'Skill package file metadata is invalid.');
    }
    const alias = assertSkillPackagePath(file.path);
    if (aliases.has(alias)) fail('SKP_PACKAGE_CORRUPT', 'Skill package contains portable path aliases.');
    aliases.add(alias);
    const bytes = contents.get(file.path);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      fail('SKP_PACKAGE_CORRUPT', `Retained bytes for '${file.path}' differ from the manifest.`);
    }
    const perFileLimit = file.path === 'SKILL.md'
      ? SKP_CAPTURE_LIMITS.entryBytes : SKP_CAPTURE_LIMITS.referenceBytes;
    if (bytes.byteLength > perFileLimit) fail('SKP_PACKAGE_CORRUPT', 'Skill file exceeds its retained limit.');
    total += bytes.byteLength;
    previous = file.path;
  }
  if (!contents.has('SKILL.md') || total > SKP_CAPTURE_LIMITS.totalBytes) {
    fail('SKP_PACKAGE_CORRUPT', 'Skill package is missing its entry or exceeds its total limit.');
  }
  const { packageSha256, ...core } = manifest;
  if (packageDigest(core) !== packageSha256) {
    fail('SKP_PACKAGE_CORRUPT', 'Skill package manifest digest does not match its contents.');
  }
  return { verified: true, packageSha256, files: manifest.files.length, bytes: total };
}

/** JSON-safe inspection response; exact retained bytes remain only in `capture.contents`. */
export function skillInspectionView(capture) {
  verifySkillPackage(capture);
  return JSON.parse(JSON.stringify({
    source: capture.source,
    manifest: capture.manifest,
    proposals: capture.proposals,
    findings: capture.findings,
    metrics: capture.metrics,
    confirmationRequired: true,
    executable: false
  }));
}

function assertSkillId(skillId) {
  if (typeof skillId !== 'string' || !ID.test(skillId)) {
    fail('SKP_ID_CASE_COLLISION', 'Skill ID must be a portable lowercase kebab-case name.');
  }
}

function sealSkillPackage(skillId, contents, { source, directories, totalBytes, fileReads,
  expectedPackageSha256 }) {
  const files = [...contents].map(([relativePath, bytes]) => ({
    path: relativePath, role: roleFor(relativePath), bytes: bytes.byteLength, sha256: sha256(bytes)
  })).sort((left, right) => comparePortable(left.path, right.path));
  const core = {
    format: SKP_PACKAGE_FORMAT, skillId, entry: 'SKILL.md', files,
    parserProfile: SKP_PARSER_PROFILE
  };
  const manifest = { ...core, packageSha256: packageDigest(core) };
  if (expectedPackageSha256 !== undefined) {
    if (!SHA256.test(expectedPackageSha256)) {
      fail('SKP_SKILL_DRIFT', 'Expected skill package digest is invalid.');
    }
    if (manifest.packageSha256 !== expectedPackageSha256) {
      fail('SKP_SKILL_DRIFT', 'Selected skill bytes differ from the confirmed package.');
    }
  }
  verifySkillPackage({ manifest, contents });
  const declarations = parseDeclarations(contents.get('sflow-skill.json'));
  const inspection = inspectText(contents.get('SKILL.md'), declarations, new Set(contents.keys()));
  for (const file of files) {
    if (file.role === 'script') {
      inspection.findings.push({ code: 'SKP_EFFECT_UNSUPPORTED',
        message: `Script '${file.path}' was retained as inert bytes and requires separate operation admission.`,
        source: { path: file.path } });
    }
  }
  return {
    source, manifest, contents,
    proposals: inspection.proposals, findings: inspection.findings,
    metrics: { files: files.length, directories, bytes: totalBytes, fileReads,
      parserCalls: declarations ? 3 : 1, gitRequests: 0, remoteCalls: 0, modelCalls: 0 }
  };
}

/** Capture exact supplied bytes without consulting a directory, Git, a remote, or a model. */
export function inspectSkillPackageContents(skillId, suppliedContents, {
  expectedPackageSha256
} = {}) {
  assertSkillId(skillId);
  if (!(suppliedContents instanceof Map)) {
    fail('SKP_PACKAGE_CORRUPT', 'Skill contents must be a map of portable paths to Buffer bytes.');
  }
  if (suppliedContents.size > SKP_CAPTURE_LIMITS.files) {
    fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds ${SKP_CAPTURE_LIMITS.files} files.`,
      { dimension: 'files', limit: SKP_CAPTURE_LIMITS.files, actual: suppliedContents.size });
  }
  const entries = [...suppliedContents];
  for (const [relativePath, bytes] of entries) {
    assertSkillPackagePath(relativePath);
    if (!Buffer.isBuffer(bytes)) {
      fail('SKP_PACKAGE_CORRUPT', `Skill file '${relativePath}' must contain exact Buffer bytes.`);
    }
  }
  entries.sort(([left], [right]) => comparePortable(left, right));
  const aliases = new Map();
  const directories = new Set(['']);
  const contents = new Map();
  let totalBytes = 0;
  function register(relativePath, kind) {
    const alias = assertSkillPackagePath(relativePath);
    const previous = aliases.get(alias);
    if (previous && (previous.path !== relativePath || previous.kind !== kind)) {
      fail('SKP_ID_CASE_COLLISION',
        `Skill paths '${previous.path}' and '${relativePath}' alias on a supported filesystem.`,
        { paths: [previous.path, relativePath] });
    }
    aliases.set(alias, { path: relativePath, kind });
  }
  for (const [relativePath, bytes] of entries) {
    const parts = relativePath.split('/');
    const depth = parts.length - 1;
    if (depth > SKP_CAPTURE_LIMITS.depth) {
      fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds directory depth ${SKP_CAPTURE_LIMITS.depth}.`,
        { dimension: 'depth', limit: SKP_CAPTURE_LIMITS.depth, path: parts.slice(0, -1).join('/') });
    }
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      register(directory, 'directory');
      directories.add(directory);
      if (directories.size > SKP_CAPTURE_LIMITS.directories) {
        fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds ${SKP_CAPTURE_LIMITS.directories} directories.`,
          { dimension: 'directories', limit: SKP_CAPTURE_LIMITS.directories,
            actual: directories.size });
      }
    }
    register(relativePath, 'file');
    const maxBytes = relativePath === 'SKILL.md'
      ? SKP_CAPTURE_LIMITS.entryBytes : SKP_CAPTURE_LIMITS.referenceBytes;
    if (bytes.byteLength > maxBytes) {
      fail('SKP_BUDGET_EXCEEDED', `Skill file '${relativePath}' exceeds ${maxBytes} bytes.`,
        { dimension: relativePath === 'SKILL.md' ? 'entryBytes' : 'referenceBytes',
          path: relativePath, limit: maxBytes, actual: bytes.byteLength });
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > SKP_CAPTURE_LIMITS.totalBytes) {
      fail('SKP_BUDGET_EXCEEDED', `Skill package exceeds ${SKP_CAPTURE_LIMITS.totalBytes} total bytes.`,
        { dimension: 'totalBytes', limit: SKP_CAPTURE_LIMITS.totalBytes, actual: totalBytes });
    }
    contents.set(relativePath, Buffer.from(bytes));
  }
  if (!contents.has('SKILL.md')) {
    fail('SKP_SKILL_MISSING', 'Skill contents must contain an exact SKILL.md entry.');
  }
  return sealSkillPackage(skillId, contents, {
    source: { kind: 'in-memory' }, directories: directories.size, totalBytes,
    fileReads: 0, expectedPackageSha256
  });
}

/**
 * Capture exact bytes and return only evidence-bearing suggestions. The selected directory is
 * inspected twice; a content or membership change between passes refuses the entire candidate.
 */
export async function inspectSkillPackage(selectedDirectory, {
  skillId, limits: requestedLimits, expectedPackageSha256
} = {}) {
  if (typeof selectedDirectory !== 'string' || !selectedDirectory.trim()
      || selectedDirectory.includes('://')) {
    fail('SKP_SKILL_MISSING', 'Select an explicit local skill directory.');
  }
  const directory = path.resolve(selectedDirectory);
  const selected = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') {
      fail('SKP_SKILL_MISSING', 'Selected local skill directory is missing.');
    }
    throw error;
  });
  if (!selected.isDirectory() || selected.isSymbolicLink()) {
    fail('SKP_PATH_REFUSED', 'Selected skill directory must be an ordinary local directory.');
  }
  const id = skillId ?? path.basename(directory);
  assertSkillId(id);
  const limits = checkedLimits(requestedLimits);
  const first = await scan(directory, limits);
  const second = await scan(directory, limits);
  assertStableSkillCapture(first, second);
  const contents = new Map(first.files);
  return sealSkillPackage(id, contents, {
    source: { kind: 'local-directory', selectedPath: directory },
    directories: first.directories.length, totalBytes: first.totalBytes,
    fileReads: contents.size * 2, expectedPackageSha256
  });
}

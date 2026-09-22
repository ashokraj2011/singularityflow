/**
 * Public, names-only execution-environment declaration.
 *
 * Secret values do not belong in this file. The declaration may carry a shared credential-free
 * endpoint value or flag default, but it cannot carry a secret value, provider reference, command,
 * or other private material which could be mistaken for repository authority.
 */
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync
} from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { configurationReadRootForPath } from './configuration-read-scope.mjs';
import { portableFilesystemPathIdentity } from './configuration-assets.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const ENVIRONMENT_DECLARATION_PATH = 'singularity/environments.yml';
export const ENVIRONMENT_IDENTIFIER = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/;
const KINDS = new Set(['secret', 'endpoint', 'flag']);
const MAXIMUM_DECLARATION_BYTES = 256 * 1024;
const supportedDeclarationVersions = Object.freeze({ 1: true });
const RESERVED_VARIABLES = new Set([
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'HOME', 'SHELL', 'COMSPEC', 'PATHEXT',
  'SYSTEMROOT', 'USERPROFILE', 'TMP', 'TEMP', 'SSH_AUTH_SOCK',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'
]);
const RESERVED_PREFIXES = ['GIT_', 'LD_', 'DYLD_', 'NODE_', 'NPM_CONFIG_', 'SINGULARITY_FLOW_'];

function fail(message, details = null) {
  throw new SingularityFlowError(
    `Invalid ${ENVIRONMENT_DECLARATION_PATH}: ${message}`,
    { code: 'ENVIRONMENT_DECLARATION_INVALID', details }
  );
}

function object(value, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} contains unsupported field(s): ${unknown.sort().join(', ')}.`);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ENVIRONMENT_IDENTIFIER.test(value)) {
    fail(`${label} must be lower-kebab-case and at most 64 characters.`);
  }
  return value;
}

function portableGlob(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256
      || value !== value.normalize('NFC') || /[^\x20-\x7e]/u.test(value)
      || value.includes('\\') || value.includes('\0') || value.startsWith('!')
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || value.split('/').includes('..') || /[\[\]{}]/u.test(value)) {
    fail(`${label} must be a bounded repository-relative portable glob.`);
  }
  const normalized = value.replace(/^\.\//, '');
  const overbroad = new Set(['*', '**', '**/*', '*/*', '**/**', '**/.*']);
  if (overbroad.has(normalized)
      || (globRegex(normalized).test('src/app.js')
        && globRegex(normalized).test('README.md')
        && globRegex(normalized).test('package.json'))) {
    fail(`${label} must not match the entire repository.`);
  }
  return normalized;
}

function stringArray(value, label, { maximum = 64 } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array of at most ${maximum} entries.`);
  const normalized = value.map((entry, index) => portableGlob(entry, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate entries.`);
  return normalized.sort();
}

function normalizeRequirement(raw, environmentId, index) {
  const value = object(raw, `environments.${environmentId}.requires[${index}]`);
  const label = `environments.${environmentId}.requires[${index}]`;
  if (!KINDS.has(value.kind)) {
    fail(`${label}.kind must be secret, endpoint, or flag.`);
  }
  const allowed = value.kind === 'endpoint'
    ? ['name', 'kind', 'value']
    : value.kind === 'flag' ? ['name', 'kind', 'default'] : ['name', 'kind'];
  exactKeys(value, allowed, label);
  if (typeof value.name !== 'string' || !VARIABLE.test(value.name)) {
    fail(`${label}.name must be an upper-snake-case variable name.`);
  }
  if (RESERVED_VARIABLES.has(value.name)
      || RESERVED_PREFIXES.some((prefix) => value.name.startsWith(prefix))) {
    fail(`${label}.name '${value.name}' is reserved by the operating system or SFlow runtime.`);
  }
  if (value.kind === 'endpoint' && value.value != null) {
    if (typeof value.value !== 'string' || value.value.length > 2_048) {
      fail(`${label}.value must be a bounded HTTP(S) URL.`);
    }
    let endpoint;
    try { endpoint = new URL(value.value); } catch { fail(`${label}.value must be an absolute HTTP(S) URL.`); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash) {
      fail(`${label}.value must be an HTTP(S) URL without credentials, query, or fragment.`);
    }
  }
  if (value.kind === 'flag' && value.default != null
      && !(typeof value.default === 'string' || typeof value.default === 'boolean'
        || (typeof value.default === 'number' && Number.isFinite(value.default)))) {
    fail(`${label}.default must be a string, boolean, or finite number.`);
  }
  if (value.kind === 'flag' && value.default != null
      && (String(value.default).length > 256 || /\u0000/u.test(String(value.default)))) {
    fail(`${label}.default must be a bounded flag value without NUL bytes.`);
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    ...(value.kind === 'endpoint' && value.value != null ? { value: value.value } : {}),
    ...(value.kind === 'flag' && value.default != null ? { default: String(value.default) } : {})
  });
}

function normalize(raw) {
  const value = object(raw, 'root');
  exactKeys(value, ['schemaVersion', 'environments', 'checks', 'neverCommit'], 'root');
  if (supportedDeclarationVersions[value.schemaVersion] !== true) fail('schemaVersion must be exactly 1.');
  const rawEnvironments = object(value.environments, 'environments');
  const environmentIds = Object.keys(rawEnvironments).sort();
  if (!environmentIds.length || environmentIds.length > 64) {
    fail('environments must declare between 1 and 64 environments.');
  }
  const environments = {};
  for (const environmentId of environmentIds) {
    identifier(environmentId, `Environment '${environmentId}'`);
    const environment = object(rawEnvironments[environmentId], `environments.${environmentId}`);
    exactKeys(environment, ['requires', 'localFiles'], `environments.${environmentId}`);
    if (!Array.isArray(environment.requires) || !environment.requires.length
        || environment.requires.length > 128) {
      fail(`environments.${environmentId}.requires must contain between 1 and 128 entries.`);
    }
    const requires = environment.requires.map((entry, index) => normalizeRequirement(entry, environmentId, index))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (new Set(requires.map((entry) => entry.name)).size !== requires.length) {
      fail(`environments.${environmentId}.requires contains duplicate variable names.`);
    }
    environments[environmentId] = Object.freeze({
      requires: Object.freeze(requires),
      localFiles: Object.freeze(stringArray(
        environment.localFiles, `environments.${environmentId}.localFiles`
      ))
    });
  }

  const rawChecks = value.checks == null ? {} : object(value.checks, 'checks');
  const checks = {};
  if (Object.keys(rawChecks).length > 128) fail('checks may contain at most 128 entries.');
  for (const checkId of Object.keys(rawChecks).sort()) {
    identifier(checkId, `Check '${checkId}'`);
    const check = object(rawChecks[checkId], `checks.${checkId}`);
    exactKeys(check, ['environment'], `checks.${checkId}`);
    if (!Object.hasOwn(environments, check.environment)) {
      fail(`checks.${checkId}.environment references unknown environment '${check.environment}'.`);
    }
    checks[checkId] = Object.freeze({ environment: check.environment });
  }

  return Object.freeze({
    schemaVersion: 1,
    environments: Object.freeze(environments),
    checks: Object.freeze(checks),
    neverCommit: Object.freeze(stringArray(value.neverCommit, 'neverCommit', { maximum: 128 }))
  });
}

/**
 * A declaration check mapping is authority only when its ID names an exact quality command from
 * the approved or Story-pinned workflow catalog. Keeping this validation separate from parsing
 * lets repository configuration load before a workflow is selected without silently accepting a
 * typo at execution time.
 */
export function validateEnvironmentCheckMappings(declaration, qualityCommandIds) {
  if (!declaration) return;
  const ids = Array.from(qualityCommandIds ?? [], (entry) => String(entry));
  const catalog = new Set(ids);
  // A repeated ID matters only when the declaration uses that ID as an indirection. Unmapped
  // commands are selected by their owning phase and an unrelated duplicate must not make every
  // otherwise-valid environment declaration unusable.
  const duplicates = [...new Set(ids.filter((entry, index) => (
    ids.indexOf(entry) !== index && Object.hasOwn(declaration.checks ?? {}, entry)
  )))].sort();
  if (duplicates.length) {
    fail(`quality command catalog contains duplicate ID(s): ${duplicates.join(', ')}.`);
  }
  const unknown = Object.keys(declaration.checks ?? {}).filter((checkId) => !catalog.has(checkId));
  if (unknown.length) {
    fail(`checks references unknown quality command ID(s): ${unknown.sort().join(', ')}.`);
  }
}

/**
 * Validate the complete normalized quality-command catalog against one declaration.
 *
 * Command IDs are intentionally allowed to repeat across phases when their exact definitions are
 * equal. A conflicting repeated ID is refused only when `checks` uses that ID as an indirection;
 * an explicit per-command environment remains unambiguous because it is part of the selected
 * command itself. Both editor/proposal validation and runtime execution call this same boundary.
 */
export function validateEnvironmentQualityCommandCatalog(declaration, qualityCommands) {
  const commands = Array.from(qualityCommands ?? []);
  const definitions = new Map();
  const ids = new Set();
  for (const [index, command] of commands.entries()) {
    if (!command || typeof command !== 'object' || Array.isArray(command)
        || typeof command.id !== 'string' || !command.id) {
      fail(`quality command catalog entry ${index} is invalid.`);
    }
    ids.add(command.id);
    const serialized = canonicalJson(command);
    if (!definitions.has(command.id)) definitions.set(command.id, new Set());
    definitions.get(command.id).add(serialized);

    if (command.environment == null) continue;
    if (!declaration) {
      fail(`quality command '${command.id}' references environment '${command.environment}', but no environment declaration exists.`);
    }
    if (!Object.hasOwn(declaration.environments ?? {}, command.environment)) {
      fail(`quality command '${command.id}' references unknown environment '${command.environment}'.`);
    }
    const mapped = declaration.checks?.[command.id]?.environment ?? null;
    if (mapped && mapped !== command.environment) {
      fail(`quality command '${command.id}' explicitly uses environment '${command.environment}', but checks maps it to '${mapped}'.`);
    }
  }
  if (!declaration) return;

  const ambiguous = [...definitions]
    .filter(([id, variants]) => variants.size > 1 && Object.hasOwn(declaration.checks ?? {}, id))
    .map(([id]) => id)
    .sort();
  if (ambiguous.length) {
    fail(`checks maps ambiguous quality command ID(s) with conflicting definitions: ${ambiguous.join(', ')}.`);
  }
  validateEnvironmentCheckMappings(declaration, [...ids].sort());
}

export function parseEnvironmentDeclaration(bytes) {
  if (bytes.length > MAXIMUM_DECLARATION_BYTES) fail(`file exceeds ${MAXIMUM_DECLARATION_BYTES} bytes.`);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('file must be valid UTF-8.');
  }
  let document;
  try {
    document = YAML.parseDocument(source, {
      strict: true, uniqueKeys: true, prettyErrors: false, maxAliasCount: 0
    });
  } catch (error) {
    fail(`YAML cannot be parsed: ${error.message}`);
  }
  if (document.errors.length) fail(`YAML cannot be parsed: ${document.errors[0].message}`);
  let raw;
  try { raw = document.toJS({ maxAliasCount: 0 }); }
  catch (error) { fail(`YAML aliases are not supported: ${error.message}`); }
  const normalized = normalize(raw);
  return Object.freeze({
    ...normalized,
    declarationSha256: `sha256:${recordSha256(normalized)}`
  });
}

function validateSourceSync(root, { optional }) {
  const configuredRoot = configurationReadRootForPath(root, ENVIRONMENT_DECLARATION_PATH);
  const target = path.resolve(configuredRoot, ENVIRONMENT_DECLARATION_PATH);
  let info;
  try { info = lstatSync(target); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') {
      throw new SingularityFlowError(`Missing ${ENVIRONMENT_DECLARATION_PATH}.`, {
        code: 'ENVIRONMENT_DECLARATION_MISSING'
      });
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('declaration must be a real regular file.');
  let canonicalRoot;
  let canonicalTarget;
  try {
    canonicalRoot = realpathSync(configuredRoot);
    canonicalTarget = realpathSync(target);
  } catch (error) {
    fail(`declaration identity cannot be verified: ${error.message}`);
  }
  const expected = path.resolve(canonicalRoot, ENVIRONMENT_DECLARATION_PATH);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (canonicalTarget !== expected || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('declaration escapes or changes identity outside the approved configuration root.');
  }
  return { target: canonicalTarget, info };
}

async function validateSource(root, { optional }) {
  const configuredRoot = configurationReadRootForPath(root, ENVIRONMENT_DECLARATION_PATH);
  const target = path.resolve(configuredRoot, ENVIRONMENT_DECLARATION_PATH);
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') {
      throw new SingularityFlowError(`Missing ${ENVIRONMENT_DECLARATION_PATH}.`, {
        code: 'ENVIRONMENT_DECLARATION_MISSING'
      });
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('declaration must be a real regular file.');
  let canonicalRoot;
  let canonicalTarget;
  try {
    canonicalRoot = await realpath(configuredRoot);
    canonicalTarget = await realpath(target);
  } catch (error) {
    fail(`declaration identity cannot be verified: ${error.message}`);
  }
  const expected = path.resolve(canonicalRoot, ENVIRONMENT_DECLARATION_PATH);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (canonicalTarget !== expected || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('declaration escapes or changes identity outside the approved configuration root.');
  }
  return { target: canonicalTarget, info };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function unchangedDuringRead(before, after, bytesRead) {
  return sameIdentity(before, after)
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && bytesRead === after.size;
}

function boundedReadSync(source) {
  let descriptor;
  try {
    descriptor = openSync(source.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(source.info, opened)) {
      fail('declaration changed identity while it was being opened.');
    }
    if (opened.size > MAXIMUM_DECLARATION_BYTES) {
      fail(`file exceeds ${MAXIMUM_DECLARATION_BYTES} bytes.`);
    }
    const buffer = Buffer.alloc(MAXIMUM_DECLARATION_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAXIMUM_DECLARATION_BYTES) {
      fail(`file exceeds ${MAXIMUM_DECLARATION_BYTES} bytes.`);
    }
    const completed = fstatSync(descriptor);
    if (!unchangedDuringRead(opened, completed, offset)) {
      fail('declaration changed while it was being read.');
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail(`declaration cannot be opened safely: ${error.message}`);
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

async function boundedRead(source) {
  let handle;
  try {
    handle = await open(source.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(source.info, opened)) {
      fail('declaration changed identity while it was being opened.');
    }
    if (opened.size > MAXIMUM_DECLARATION_BYTES) {
      fail(`file exceeds ${MAXIMUM_DECLARATION_BYTES} bytes.`);
    }
    const buffer = Buffer.alloc(MAXIMUM_DECLARATION_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAXIMUM_DECLARATION_BYTES) {
      fail(`file exceeds ${MAXIMUM_DECLARATION_BYTES} bytes.`);
    }
    const completed = await handle.stat();
    if (!unchangedDuringRead(opened, completed, offset)) {
      fail('declaration changed while it was being read.');
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail(`declaration cannot be opened safely: ${error.message}`);
  } finally {
    await handle?.close();
  }
}

export function loadEnvironmentDeclarationSync(root, { optional = true } = {}) {
  const source = validateSourceSync(root, { optional });
  if (!source) return null;
  return Object.freeze({
    ...parseEnvironmentDeclaration(boundedReadSync(source)), path: ENVIRONMENT_DECLARATION_PATH
  });
}

export async function loadEnvironmentDeclaration(root, { optional = true } = {}) {
  return (await captureEnvironmentDeclaration(root, { optional }))?.declaration ?? null;
}

/**
 * Capture and parse one stable declaration byte sequence.
 *
 * Exporters must return these exact bytes rather than validating and reopening the mutable path.
 * The no-follow bounded reader proves one inode and content revision before either the normalized
 * declaration or its public bytes become observable.
 */
export async function captureEnvironmentDeclaration(root, { optional = true } = {}) {
  const source = await validateSource(root, { optional });
  if (!source) return null;
  const bytes = await boundedRead(source);
  const declaration = Object.freeze({
    ...parseEnvironmentDeclaration(bytes), path: ENVIRONMENT_DECLARATION_PATH
  });
  return Object.freeze({ declaration, bytes: Buffer.from(bytes) });
}

/**
 * Project the names-only declaration into the existing World-Model exclusion policy input.
 *
 * Environment parsing and configuration authority stay outside the packaged WMB kernel. The WMB
 * scope owner receives only normalized path patterns through `worldModel.excludedRoots`, exactly
 * like any other approved scope policy, so adding ENV support does not silently replace its frozen
 * extractor implementation identity.
 */
export function environmentWorldModelExcludedRoots(declaration) {
  if (!declaration) return [];
  return [...new Set([
    ...(declaration.neverCommit ?? []),
    ...Object.values(declaration.environments ?? {})
      .flatMap((environment) => environment.localFiles ?? [])
  ])].sort();
}

/** Add current environment-local patterns to an effective definition without mutating its owner. */
export function withEnvironmentWorldModelExclusions(definition, declaration) {
  const environmentExcludedRoots = environmentWorldModelExcludedRoots(declaration);
  if (!environmentExcludedRoots.length) return definition;
  const worldModel = definition?.worldModel ?? {};
  const excludedRoots = [...new Set([
    ...(worldModel.excludedRoots ?? []),
    ...environmentExcludedRoots
  ])].sort();
  if (excludedRoots.length === (worldModel.excludedRoots ?? []).length
      && excludedRoots.every((entry, index) => entry === worldModel.excludedRoots[index])) {
    return definition;
  }
  const descriptors = Object.getOwnPropertyDescriptors(definition);
  const original = descriptors.worldModel;
  const projectedWorldModel = {
    ...worldModel,
    excludedRoots
  };
  if (Object.isFrozen(worldModel)) Object.freeze(projectedWorldModel);
  descriptors.worldModel = {
    value: projectedWorldModel,
    enumerable: original?.enumerable ?? true,
    configurable: original?.configurable ?? true,
    writable: original?.writable ?? true
  };
  const projected = Object.create(Object.getPrototypeOf(definition), descriptors);
  return Object.isFrozen(definition) ? Object.freeze(projected) : projected;
}

function globRegex(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

/** Return the exact declaration rule which makes a repository-relative path environment-local. */
export function matchEnvironmentLocalPath(declaration, relativePath) {
  if (!declaration) return null;
  const candidate = String(relativePath ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!candidate || path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)
      || candidate.split('/').includes('..')) return null;
  // A repository may be authored on a case-sensitive host and consumed on default Windows or
  // macOS filesystems. Match the strictest supported filesystem identity so case aliases,
  // compatibility folds, and Win32 trailing-dot/space aliases cannot bypass a local-file rule.
  const candidateIdentity = portableFilesystemPathIdentity(candidate);
  for (const pattern of declaration.neverCommit ?? []) {
    if (globRegex(portableFilesystemPathIdentity(pattern)).test(candidateIdentity)) {
      return Object.freeze({ environmentId: null, kind: 'never-commit', pattern });
    }
  }
  for (const environmentId of Object.keys(declaration.environments ?? {}).sort()) {
    for (const pattern of declaration.environments[environmentId].localFiles ?? []) {
      if (globRegex(portableFilesystemPathIdentity(pattern)).test(candidateIdentity)) {
        return Object.freeze({ environmentId, kind: 'local-file', pattern });
      }
    }
  }
  return null;
}

/** Stable JSON form used by schema and audit tests without exposing parser internals. */
export function canonicalEnvironmentDeclaration(declaration) {
  if (!declaration) return null;
  const { path: _path, declarationSha256: _sha, ...value } = declaration;
  return canonicalJson(value);
}

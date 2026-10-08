import { createRequire } from 'node:module';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PACKAGE_ROOT } from '../../../package-root.mjs';
import { runQualityCommand } from '../../../quality-command-runner.mjs';
import { currentSchemaVersion, readRecord } from '../../../schema-migrations.mjs';
import { SingularityFlowError } from '../../../util.mjs';
import { canonicalJson, compareText, sealRecord, sha256, sha256Bytes } from '../../canonicalize.mjs';
import { BUILTIN_ARCH_CALM_CONTRACT } from '../../registry/projections.mjs';

// Resolve both executable dependencies and packaged schemas through the shared package boundary.
// The VS Code host replaces that boundary with its staged `cli/` directory while Node ESM resolves
// the repository/package root. Keeping `import.meta` out of this module is essential because the
// extension's worker entry points are CommonJS bundles.
const require = createRequire(path.join(PACKAGE_ROOT, 'package.json'));
const PACKAGE_VERSION = '1.57.0';
const PACKAGE_INTEGRITY = 'sha512-G3oAb4dJNnOAulKz6kgJ1fX8/ZutV+gLSMsej5eClFwAEaxre78CKqyCYFw8bDlzCY72w8A9B7RS3JHLuy26aQ==';
const ENTRY_SHA256 = 'sha256:19ed46688fc7b797841a1543002c2cf7a0a1b845cfb2f74b8dfb096d7ceb4041';
const CALM_SCHEMA_URI = 'https://calm.finos.org/release/1.2/meta/calm.json';
const DEFAULT_SCHEMA_ROOT = path.join(PACKAGE_ROOT, 'schemas', 'calm');
const SCHEMA_BUNDLE_SHA256 = 'sha256:1903d7b318601869c15340e5765a37cbc785b6084298a3e889120b986918995d';
const URL_MAPPING_SHA256 = 'sha256:7e53d8035a5e1640e2dab416570e6843799a63e6672dd32e52349f589963e066';
const MAXIMUM_REPORT_BYTES = 1024 * 1024;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

async function filesBelow(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      fail('The reviewed CALM schema bundle cannot contain links or special files.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
    }
    if (entry.isDirectory()) files.push(...await filesBelow(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function sha256File(target) {
  return `sha256:${sha256Bytes(await readFile(target))}`;
}

export async function createCalmToolchainLock({ schemaRoot = DEFAULT_SCHEMA_ROOT } = {}) {
  const absoluteSchemaRoot = path.resolve(schemaRoot);
  const mappingPath = path.join(absoluteSchemaRoot, 'url-map.json');
  const rootInfo = await lstat(absoluteSchemaRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    fail('The reviewed CALM schema root must be a regular directory.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  let packagePath;
  try { packagePath = require.resolve('@finos/calm-cli/package.json'); }
  catch (error) {
    fail(`The reviewed FINOS CALM validator is unavailable: ${error.message}`, 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  const packageDefinition = JSON.parse(await readFile(packagePath, 'utf8'));
  if (packageDefinition.version !== PACKAGE_VERSION) {
    fail(`FINOS CALM CLI ${PACKAGE_VERSION} is required; found '${packageDefinition.version ?? 'unknown'}'.`,
      'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  const entryPath = path.join(path.dirname(packagePath), 'dist', 'index.js');
  const entrySha256 = await sha256File(entryPath).catch((error) => {
    fail(`The reviewed FINOS CALM validator entry cannot be read: ${error.message}`, 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  });
  if (entrySha256 !== ENTRY_SHA256) {
    fail('The installed FINOS CALM validator does not match the reviewed executable.',
      'WMC_CALM_VALIDATOR_UNAVAILABLE', { expected: ENTRY_SHA256, received: entrySha256 });
  }
  const schemaPaths = (await filesBelow(absoluteSchemaRoot))
    .filter((value) => value.endsWith('.json') && value !== 'url-map.json');
  if (!schemaPaths.length || !(await lstat(mappingPath).catch(() => null))?.isFile()) {
    fail('The packaged offline CALM 1.2 schema bundle is incomplete.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  const schemaFiles = [];
  for (const relative of schemaPaths) {
    const full = path.join(absoluteSchemaRoot, relative);
    schemaFiles.push({ path: relative, sha256: await sha256File(full) });
  }
  const mappingBytes = await readFile(mappingPath, 'utf8');
  let mapping;
  try { mapping = JSON.parse(mappingBytes); }
  catch (error) { fail(`The CALM URL mapping is invalid: ${error.message}`, 'WMC_CALM_VALIDATOR_UNAVAILABLE'); }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    fail('The CALM URL mapping must be an object.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  for (const [url, relative] of Object.entries(mapping)) {
    if (!(url.startsWith('https://calm.finos.org/release/1.2/')
          || url === 'https://singularity-flow.dev/schemas/calm/enforcement-control-v1.json')
        || typeof relative !== 'string' || relative.startsWith('/') || relative.includes('..')
        || relative.includes('\\') || !schemaPaths.includes(relative)) {
      fail('The packaged CALM URL mapping contains an unsafe entry.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
    }
  }
  const schemaBundleSha256 = sha256(schemaFiles);
  const urlMappingSha256 = sha256({ utf8: canonicalJson(mapping) });
  const rootSchemaSha256 = schemaFiles.find((entry) => entry.path === 'release/1.2/meta/calm.json')?.sha256;
  if (schemaBundleSha256 !== SCHEMA_BUNDLE_SHA256 || urlMappingSha256 !== URL_MAPPING_SHA256
      || rootSchemaSha256 !== BUILTIN_ARCH_CALM_CONTRACT.output.schemaSha256) {
    fail('The offline CALM schemas or URL mapping do not match the reviewed bundle.',
      'WMC_CALM_VALIDATOR_UNAVAILABLE');
  }
  const lock = sealRecord({
    schemaVersion: currentSchemaVersion('calm-toolchain-lock'), kind: 'calm-toolchain-lock',
    schema: {
      release: '1.2', uri: CALM_SCHEMA_URI, bundleSha256: schemaBundleSha256,
      rootSchemaSha256,
      files: schemaFiles
    },
    validator: {
      package: '@finos/calm-cli', version: PACKAGE_VERSION, integrity: PACKAGE_INTEGRITY,
      entrySha256
    },
    urlMappingSha256
  }, 'lockSha256');
  return Object.freeze({
    lock: Object.freeze(readRecord('calm-toolchain-lock', lock).record),
    entryPath, schemaRoot: absoluteSchemaRoot, mappingPath
  });
}

function normalizedDiagnostic(value) {
  if (Array.isArray(value)) return value.map(normalizedDiagnostic)
    .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
  if (!value || typeof value !== 'object') return typeof value === 'string'
    ? stableDiagnosticText(value)
    : value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (['timestamp', 'generatedAt', 'duration', 'durationMs'].includes(key)) continue;
    result[key] = normalizedDiagnostic(value[key]);
  }
  return result;
}

function stableDiagnosticText(value) {
  return String(value ?? '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, '')
    .replaceAll('\\', '/')
    .replace(/(?:[A-Za-z]:)?\/[\w./-]*sflow-calm-[\w-]+/gu, '<temporary>');
}

function diagnosticText(result) {
  const joined = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  return stableDiagnosticText(joined).slice(0, 8_192);
}

function assertValidatorReport(report, result, strict) {
  const outputs = report && typeof report === 'object' && !Array.isArray(report)
    && Array.isArray(report.jsonSchemaValidationOutputs) && Array.isArray(report.spectralSchemaValidationOutputs)
    ? [...report.jsonSchemaValidationOutputs, ...report.spectralSchemaValidationOutputs] : null;
  if (!outputs || typeof report.hasErrors !== 'boolean' || typeof report.hasWarnings !== 'boolean'
      || outputs.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
        || !['error', 'warning', 'info', 'hint'].includes(item.severity)
        || typeof item.message !== 'string' || typeof item.path !== 'string')
      || report.hasErrors !== outputs.some((item) => item.severity === 'error')
      || report.hasWarnings !== outputs.some((item) => item.severity === 'warning')) {
    fail('CALM validator returned a missing, malformed or inconsistent report.',
      'WMC_CALM_VALIDATOR_UNAVAILABLE', { diagnostic: diagnosticText(result) });
  }
  if (report.hasErrors) {
    fail('The generated architecture does not pass the reviewed CALM 1.2 validator.',
      'WMC_CALM_SCHEMA_INVALID', { validation: normalizedDiagnostic(report) });
  }
  // The pinned CLI exits 1 for genuine strict-mode style warnings. No other failed exit
  // (including a signal, an empty report or an unexplained exit 1) can attest a projection.
  if (result.signal || !(result.status === 0 || (result.status === 1 && strict && report.hasWarnings))) {
    fail('CALM validator failed without an admissible validation outcome.',
      'WMC_CALM_VALIDATOR_UNAVAILABLE', { diagnostic: diagnosticText(result) });
  }
}

function validatorEnvironment(temporary, source = process.env) {
  const isolatedHome = path.join(temporary, 'home');
  const environment = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CACHE_HOME: path.join(isolatedHome, 'cache'),
    XDG_CONFIG_HOME: path.join(isolatedHome, 'config'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    TZ: 'UTC',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NO_PROXY: '*',
    no_proxy: '*'
  };
  // Node needs these platform variables on Windows. Do not forward arbitrary ambient
  // variables: validator subprocesses must never inherit credentials or user tokens.
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (typeof source[key] === 'string' && source[key]) environment[key] = source[key];
  }
  return environment;
}

/** Bootstrap loaded by Node before the third-party validator entry point. */
export function calmOfflineBootstrapSource() {
  return `'use strict';
const deny = () => { const error = new Error('Singularity Flow denied validator network access.'); error.code = 'SFLOW_NETWORK_DISABLED'; throw error; };
for (const name of ['net', 'tls']) {
  const api = require(name);
  for (const member of ['connect', 'createConnection']) if (typeof api[member] === 'function') api[member] = deny;
  if (api.Socket && typeof api.Socket.prototype.connect === 'function') api.Socket.prototype.connect = deny;
}
for (const name of ['http', 'https']) {
  const api = require(name);
  for (const member of ['request', 'get']) if (typeof api[member] === 'function') api[member] = deny;
}
const dns = require('dns');
for (const member of Object.keys(dns)) if (/^(lookup|resolve)/u.test(member) && typeof dns[member] === 'function') dns[member] = deny;
const dgram = require('dgram');
if (typeof dgram.createSocket === 'function') dgram.createSocket = deny;
globalThis.fetch = async () => deny();
`;
}

/** Validate one canonical projection with the reviewed CALM CLI and only packaged schemas. */
export async function validateCalmWithOfficialToolchain(projection, {
  schemaRoot = DEFAULT_SCHEMA_ROOT, timeoutMs = 30_000, signal = null,
  runCommand = runQualityCommand, strict = true
} = {}) {
  const toolchain = await createCalmToolchainLock({ schemaRoot });
  if (projection?.$schema !== CALM_SCHEMA_URI) {
    fail(`CALM projection must bind '${CALM_SCHEMA_URI}'.`, 'WMC_CALM_SCHEMA_INVALID');
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-calm-'));
  const isolatedHome = path.join(temporary, 'home');
  const architecturePath = path.join(temporary, 'architecture.json');
  const outputPath = path.join(temporary, 'validation.json');
  const offlineBootstrapPath = path.join(temporary, 'offline-network-deny.cjs');
  try {
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await writeFile(architecturePath, canonicalJson(projection), { mode: 0o600 });
    await writeFile(offlineBootstrapPath, calmOfflineBootstrapSource(), { mode: 0o600 });
    const environment = validatorEnvironment(temporary);
    const result = await runCommand(process.execPath, [
      '--require', offlineBootstrapPath, toolchain.entryPath,
      'validate', '--architecture', architecturePath,
      '--schema-directory', toolchain.schemaRoot,
      '--url-to-local-file-mapping', toolchain.mappingPath,
      ...(strict ? ['--strict'] : []), '--format', 'json', '--output', outputPath
    ], { cwd: temporary, env: environment, timeoutMs, captureBytes: 64 * 1024, signal, killTree: true });
    if (result.timedOut || result.aborted || result.error) {
      fail(result.aborted ? 'CALM validation was cancelled.'
        : result.timedOut ? 'CALM validation exceeded its bounded deadline.'
          : `CALM validator could not start: ${result.error.message}`,
      'WMC_CALM_VALIDATOR_UNAVAILABLE', { diagnostic: diagnosticText(result) });
    }
    let parsed = null;
    const reportInfo = await lstat(outputPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (reportInfo && (!reportInfo.isFile() || reportInfo.size > MAXIMUM_REPORT_BYTES)) {
      fail('CALM validator report is unsafe or exceeds its byte budget.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
    }
    const candidate = reportInfo ? await readFile(outputPath, 'utf8') : String(result.stdout ?? '').trim();
    if (Buffer.byteLength(candidate, 'utf8') > MAXIMUM_REPORT_BYTES) {
      fail('CALM validator report exceeds its byte budget.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
    }
    try { parsed = JSON.parse(candidate); } catch { /* rejected by the closed report contract */ }
    assertValidatorReport(parsed, result, strict);
    const normalizedResult = normalizedDiagnostic(parsed);
    return Object.freeze({
      status: 'passed', strict, toolchainLock: toolchain.lock,
      normalizedResult, normalizedResultSha256: sha256(normalizedResult)
    });
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export { CALM_SCHEMA_URI, DEFAULT_SCHEMA_ROOT };

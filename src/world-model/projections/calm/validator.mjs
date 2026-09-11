import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PACKAGE_ROOT } from '../../../package-root.mjs';
import { runQualityCommand } from '../../../quality-command-runner.mjs';
import { currentSchemaVersion, readRecord } from '../../../schema-migrations.mjs';
import { SingularityFlowError } from '../../../util.mjs';
import { canonicalJson, compareText, sealRecord, sha256, sha256Bytes } from '../../canonicalize.mjs';

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

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

async function filesBelow(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const child = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
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
  if (!schemaPaths.length || !(await stat(mappingPath).catch(() => null))?.isFile()) {
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
  for (const [url, relative] of Object.entries(mapping)) {
    if (!(url.startsWith('https://calm.finos.org/release/1.2/')
          || url === 'https://singularity-flow.dev/schemas/calm/enforcement-control-v1.json')
        || typeof relative !== 'string' || relative.startsWith('/') || relative.includes('..')) {
      fail('The packaged CALM URL mapping contains an unsafe entry.', 'WMC_CALM_VALIDATOR_UNAVAILABLE');
    }
  }
  const schemaBundleSha256 = sha256(schemaFiles);
  const lock = sealRecord({
    schemaVersion: currentSchemaVersion('calm-toolchain-lock'), kind: 'calm-toolchain-lock',
    schema: {
      release: '1.2', uri: CALM_SCHEMA_URI, bundleSha256: schemaBundleSha256,
      rootSchemaSha256: schemaFiles.find((entry) => entry.path.endsWith('/calm.json'))?.sha256,
      files: schemaFiles
    },
    validator: {
      package: '@finos/calm-cli', version: PACKAGE_VERSION, integrity: PACKAGE_INTEGRITY,
      entrySha256
    },
    urlMappingSha256: sha256({ utf8: canonicalJson(mapping) })
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

/** Validate one canonical projection with the reviewed CALM CLI and only packaged schemas. */
export async function validateCalmWithOfficialToolchain(projection, {
  schemaRoot = DEFAULT_SCHEMA_ROOT, timeoutMs = 30_000, signal = null,
  runCommand = runQualityCommand
} = {}) {
  const toolchain = await createCalmToolchainLock({ schemaRoot });
  if (projection?.$schema !== CALM_SCHEMA_URI) {
    fail(`CALM projection must bind '${CALM_SCHEMA_URI}'.`, 'WMC_CALM_SCHEMA_INVALID');
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-calm-'));
  const isolatedHome = path.join(temporary, 'home');
  const architecturePath = path.join(temporary, 'architecture.json');
  const outputPath = path.join(temporary, 'validation.json');
  try {
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await writeFile(architecturePath, canonicalJson(projection), { mode: 0o600 });
    const environment = validatorEnvironment(temporary);
    const result = await runCommand(process.execPath, [
      toolchain.entryPath, 'validate', '--architecture', architecturePath,
      '--schema-directory', toolchain.schemaRoot,
      '--url-to-local-file-mapping', toolchain.mappingPath,
      '--strict', '--format', 'json', '--output', outputPath
    ], { cwd: temporary, env: environment, timeoutMs, captureBytes: 64 * 1024, signal, killTree: true });
    if (result.timedOut || result.aborted || result.error) {
      fail(result.aborted ? 'CALM validation was cancelled.'
        : result.timedOut ? 'CALM validation exceeded its bounded deadline.'
          : `CALM validator could not start: ${result.error.message}`,
      'WMC_CALM_VALIDATOR_UNAVAILABLE', { diagnostic: diagnosticText(result) });
    }
    let parsed = null;
    try { parsed = JSON.parse(await readFile(outputPath, 'utf8')); }
    catch {
      const candidate = String(result.stdout ?? '').trim();
      try { parsed = candidate ? JSON.parse(candidate) : null; } catch { /* handled below */ }
    }
    const normalizedResult = normalizedDiagnostic(parsed ?? {
      status: result.status === 0 ? 'passed' : 'failed', diagnostic: diagnosticText(result)
    });
    // CALM strict mode deliberately exits non-zero for style warnings. Preserve those warnings in
    // the normalized receipt, but only reject a document when the structured validator result
    // reports schema/rule errors. An unexplained non-zero exit is still a validator failure.
    if (result.status !== 0 && parsed?.hasErrors !== false) {
      fail('The generated architecture does not pass the reviewed CALM 1.2 validator.',
        'WMC_CALM_SCHEMA_INVALID', { validation: normalizedResult, diagnostic: diagnosticText(result) });
    }
    return Object.freeze({
      status: 'passed', toolchainLock: toolchain.lock,
      normalizedResult, normalizedResultSha256: sha256(normalizedResult)
    });
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

export { CALM_SCHEMA_URI, DEFAULT_SCHEMA_ROOT };

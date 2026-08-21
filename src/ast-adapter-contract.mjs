import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { createAstDerivationKey } from './ast-derivation-key.mjs';
import { registeredAstManifestPaths } from './ast-pack-registry.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { runQualityCommand } from './quality-command-runner.mjs';

export const AST_ADAPTER_PROTOCOL_VERSION = 2;
export const AST_ADAPTER_MINIMUM_PROTOCOL_VERSION = 1;
const ASSURANCE = new Set(['text', 'syntax', 'semantic']);
const CAPABILITIES = new Set(['skeleton', 'query', 'gate']);
const STAGES = new Set(['syntax', 'semantic']);
const DIGEST = /^[a-f0-9]{64}$/;
const FACT_KINDS = new Set(['file', 'symbol', 'import', 'relationship', 'diagnostic', 'module']);
const RELATIONSHIPS = new Set([
  'contains', 'extends', 'implements', 'conforms-to', 'overrides', 'calls', 'references',
  'reads', 'writes', 'annotated-by', 'imports', 'exports', 'expect-actual', 'test-covers'
]);
const FORBIDDEN_FACT_FIELDS = new Set(['sourceBody', 'text', 'body', 'content', 'prompt', 'completion', 'environment', 'stderr', 'stdout', 'log']);
const POLYGLOT_ADAPTER = path.join(PACKAGE_ROOT, 'src', 'ast-packs', 'polyglot-syntax-adapter.mjs');
const POLYGLOT_CORE = path.join(PACKAGE_ROOT, 'src', 'ast-packs', 'polyglot-syntax-core.mjs');
const POLYGLOT_LICENSE = path.join(PACKAGE_ROOT, 'LICENSE');
let bundledManifestPromise = null;

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function astAdapterManifestSha256(value) {
  const copy = structuredClone(value);
  if (copy.implementation) delete copy.implementation.manifestSha256;
  return recordSha256(copy);
}

function validateImplementation(value, manifest, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${source} implementation metadata is required.`);
  if (!DIGEST.test(value.artifactSha256 ?? '') || !DIGEST.test(value.manifestSha256 ?? '')) {
    throw new SingularityFlowError(`${source} implementation artifactSha256 and manifestSha256 must be SHA-256 digests.`);
  }
  if (value.manifestSha256 !== astAdapterManifestSha256(manifest)) {
    throw new SingularityFlowError(`${source} implementation manifestSha256 does not bind the manifest bytes.`);
  }
  const runtime = value.runtime;
  if (!runtime || typeof runtime.id !== 'string' || !runtime.id || typeof runtime.version !== 'string'
      || !runtime.version || typeof runtime.platform !== 'string' || !runtime.platform) {
    throw new SingularityFlowError(`${source} implementation runtime requires id, version, and platform.`);
  }
  const grammars = value.grammars ?? [];
  if (!Array.isArray(grammars) || grammars.some((grammar) => !grammar?.language || !grammar?.id
      || !grammar?.version || !DIGEST.test(grammar?.artifactSha256 ?? ''))) {
    throw new SingularityFlowError(`${source} implementation grammars require language, id, version, and artifactSha256.`);
  }
  const dependencies = value.dependencies ?? {};
  for (const field of ['lockSha256', 'bundleSha256']) {
    if (dependencies[field] != null && !DIGEST.test(dependencies[field])) {
      throw new SingularityFlowError(`${source} implementation dependencies.${field} must be null or a SHA-256 digest.`);
    }
  }
  const files = value.files ?? [];
  if (!Array.isArray(files) || files.some((file) => typeof file?.path !== 'string' || !path.isAbsolute(file.path)
    || !DIGEST.test(file?.sha256 ?? ''))) {
    throw new SingularityFlowError(`${source} implementation.files must contain absolute installed paths and SHA-256 digests.`);
  }
  return {
    artifactSha256: value.artifactSha256,
    manifestSha256: value.manifestSha256,
    runtime: { id: runtime.id, version: runtime.version, platform: runtime.platform },
    grammars: grammars.map((grammar) => ({
      language: grammar.language, id: grammar.id, version: grammar.version,
      artifactSha256: grammar.artifactSha256
    })).sort((left, right) => `${left.language}\0${left.id}`.localeCompare(`${right.language}\0${right.id}`)),
    dependencies: {
      lockSha256: dependencies.lockSha256 ?? null,
      bundleSha256: dependencies.bundleSha256 ?? null
    },
    files: files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path))
  };
}

function languageDefinitions(value, source, stage, assurance) {
  if (Array.isArray(value)) {
    if (!value.length || value.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item))) {
      throw new SingularityFlowError(`${source} languages must be a non-empty language array or object.`);
    }
    return Object.fromEntries([...new Set(value)].sort().map((language) => [language, {
      extensions: [], canonicalFilenames: [], aliases: [], priority: 0,
      parserEngine: 'legacy-adapter', parserVersion: 'unspecified', grammarId: null, grammarVersion: null,
      maximumAssurance: assurance, projectKinds: [], toolchainRanges: [], platforms: []
    }]));
  }
  if (!value || typeof value !== 'object') throw new SingularityFlowError(`${source} languages must be a non-empty language array or object.`);
  const definitions = {};
  for (const [language, definition] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(language) || !definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new SingularityFlowError(`${source} language '${language}' is invalid.`);
    }
    const maximumAssurance = definition.maximumAssurance ?? assurance;
    if (!ASSURANCE.has(maximumAssurance) || (stage === 'syntax' && maximumAssurance !== assurance)) {
      throw new SingularityFlowError(`${source} language '${language}' has an invalid assurance ceiling.`);
    }
    for (const field of ['parserEngine', 'parserVersion']) {
      if (typeof definition[field] !== 'string' || !definition[field]) throw new SingularityFlowError(`${source} language '${language}' requires ${field}.`);
    }
    const lists = {};
    for (const field of ['extensions', 'canonicalFilenames', 'aliases', 'projectKinds', 'toolchainRanges', 'platforms']) {
      const list = definition[field] ?? [];
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item)) {
        throw new SingularityFlowError(`${source} language '${language}'.${field} must be a string array.`);
      }
      lists[field] = [...new Set(list)].sort();
    }
    if (stage === 'semantic' && (!lists.projectKinds.length || !lists.toolchainRanges.length || !lists.platforms.length)) {
      throw new SingularityFlowError(`${source} semantic language '${language}' requires projectKinds, toolchainRanges, and platforms.`);
    }
    definitions[language] = {
      ...lists,
      priority: Number.isInteger(definition.priority) ? definition.priority : 0,
      parserEngine: definition.parserEngine, parserVersion: definition.parserVersion,
      grammarId: definition.grammarId ?? null, grammarVersion: definition.grammarVersion ?? null,
      maximumAssurance
    };
  }
  if (!Object.keys(definitions).length) throw new SingularityFlowError(`${source} languages must not be empty.`);
  return definitions;
}

/**
 * Validate an adapter advertisement without importing adapter code into the kernel process.
 * Actual adapters are optional executables and communicate using bounded JSON envelopes.
 */
export function validateAstAdapterManifest(value, source = 'AST adapter manifest') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${source} must be an object.`);
  if (value.protocolVersion === 1) return validateLegacyAstAdapterManifest(value, source);
  const allowed = new Set([
    'protocolVersion', 'id', 'packVersion', 'extractorVersion', 'stage', 'argv',
    'capabilities', 'languages', 'assurance', 'implementation', 'licenses', 'conformance'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`${source} contains unknown field '${key}'.`);
  if (value.protocolVersion !== AST_ADAPTER_PROTOCOL_VERSION) throw new SingularityFlowError(`${source} protocolVersion must be ${AST_ADAPTER_PROTOCOL_VERSION}.`);
  if (!/^[a-z][a-z0-9-]*$/.test(value.id ?? '')) throw new SingularityFlowError(`${source} id must be lower-case kebab-case.`);
  if (!ASSURANCE.has(value.assurance)) throw new SingularityFlowError(`${source} assurance must be text, syntax, or semantic.`);
  const stage = value.stage ?? value.assurance;
  if (!STAGES.has(stage) || (stage === 'syntax' && !['text', 'syntax'].includes(value.assurance)) || (stage === 'semantic' && value.assurance !== 'semantic')) {
    throw new SingularityFlowError(`${source} stage and assurance are incompatible.`);
  }
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.some((item) => typeof item !== 'string' || !item)) {
    throw new SingularityFlowError(`${source} argv must be a non-empty structured argument array.`);
  }
  if (!value.extractorVersion || typeof value.extractorVersion !== 'string') throw new SingularityFlowError(`${source} extractorVersion is required.`);
  const packVersion = value.packVersion ?? value.extractorVersion;
  if (typeof packVersion !== 'string' || !packVersion) throw new SingularityFlowError(`${source} packVersion is required.`);
  if (value.capabilities != null && (!Array.isArray(value.capabilities)
    || value.capabilities.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item)))) {
    throw new SingularityFlowError(`${source} capabilities may contain only ${[...CAPABILITIES].join(', ')}.`);
  }
  const definitions = languageDefinitions(value.languages, source, stage, value.assurance);
  const licenses = value.licenses ?? [];
  if (!Array.isArray(licenses) || licenses.some((license) => !license?.id || !license?.spdx || !DIGEST.test(license?.sourceSha256 ?? ''))) {
    throw new SingularityFlowError(`${source} licenses require id, SPDX identifier, and sourceSha256.`);
  }
  const conformance = value.conformance ?? null;
  if (conformance != null && (!conformance.fixtureVersion || !['passed', 'preview'].includes(conformance.status)
    || !Array.isArray(conformance.languages))) {
    throw new SingularityFlowError(`${source} conformance metadata is invalid.`);
  }
  const implementation = validateImplementation(value.implementation, value, source);
  return Object.freeze({
    protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
    id: value.id,
    packVersion,
    stage,
    languages: Object.freeze(Object.keys(definitions).sort()),
    languageDefinitions: Object.freeze(definitions),
    assurance: value.assurance,
    argv: Object.freeze([...value.argv]),
    extractorVersion: value.extractorVersion,
    capabilities: Object.freeze([...(value.capabilities ?? [])].sort()),
    licenses: Object.freeze(licenses.map((license) => ({ id: license.id, spdx: license.spdx, sourceSha256: license.sourceSha256 }))),
    conformance: conformance ? Object.freeze({
      fixtureVersion: String(conformance.fixtureVersion), status: conformance.status,
      languages: [...new Set(conformance.languages)].sort()
    }) : null,
    implementation: Object.freeze(implementation)
  });
}

/**
 * Protocol v1 is a readable predecessor, not a route around protocol-v2 evidence rules. Older
 * adapters retain their bounded symbol/import/relationship utility, but their output is capped at
 * syntax assurance and is visibly marked legacy. In particular, a v1 adapter can never satisfy a
 * semantic lifecycle predicate.
 */
function validateLegacyAstAdapterManifest(value, source) {
  const allowed = new Set([
    'protocolVersion', 'id', 'languages', 'assurance', 'argv', 'extractorVersion',
    'capabilities', 'implementation'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`${source} protocol-v1 manifest contains unknown field '${key}'.`);
  if (!/^[a-z][a-z0-9-]*$/.test(value.id ?? '')) throw new SingularityFlowError(`${source} id must be lower-case kebab-case.`);
  if (!['syntax', 'semantic'].includes(value.assurance)) throw new SingularityFlowError(`${source} assurance must be syntax or semantic.`);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.some((item) => typeof item !== 'string' || !item)) {
    throw new SingularityFlowError(`${source} argv must be a non-empty structured argument array.`);
  }
  if (!value.extractorVersion || typeof value.extractorVersion !== 'string') throw new SingularityFlowError(`${source} extractorVersion is required.`);
  if (value.capabilities != null && (!Array.isArray(value.capabilities)
    || value.capabilities.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item)))) {
    throw new SingularityFlowError(`${source} capabilities may contain only ${[...CAPABILITIES].join(', ')}.`);
  }
  const definitions = languageDefinitions(value.languages, source, 'syntax', 'syntax');
  const implementation = validateImplementation(value.implementation, value, source);
  return Object.freeze({
    protocolVersion: 1,
    legacyProtocol: 1,
    legacyClaimedAssurance: value.assurance,
    id: value.id,
    packVersion: value.extractorVersion,
    stage: 'syntax',
    languages: Object.freeze(Object.keys(definitions).sort()),
    languageDefinitions: Object.freeze(definitions),
    assurance: 'syntax',
    argv: Object.freeze([...value.argv]),
    extractorVersion: value.extractorVersion,
    capabilities: Object.freeze([...(value.capabilities ?? [])].sort()),
    licenses: Object.freeze([]),
    conformance: null,
    implementation: Object.freeze(implementation)
  });
}

async function bundledPolyglotManifest() {
  if (!bundledManifestPromise) bundledManifestPromise = (async () => {
    const [adapterBytes, coreBytes, licenseBytes] = await Promise.all([
      readFile(POLYGLOT_ADAPTER), readFile(POLYGLOT_CORE), readFile(POLYGLOT_LICENSE)
    ]);
    const artifactSha256 = hashBytes(adapterBytes);
    const coreSha256 = hashBytes(coreBytes);
    const languages = Object.fromEntries(['java', 'python', 'kotlin', 'swift'].map((language) => [language, {
      extensions: language === 'java' ? ['.java'] : language === 'python' ? ['.py', '.pyi']
        : language === 'kotlin' ? ['.kt', '.kts'] : ['.swift'],
      canonicalFilenames: [], aliases: [], priority: 200,
      parserEngine: 'sflow-structural-preview', parserVersion: '1.1.0',
      grammarId: null, grammarVersion: null, maximumAssurance: 'text'
    }]));
    const manifest = {
      protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
      id: 'sflow-polyglot-syntax', packVersion: '1.1.0', extractorVersion: '1.1.0',
      stage: 'syntax', assurance: 'text', argv: [process.execPath, POLYGLOT_ADAPTER],
      capabilities: ['skeleton', 'query'], languages,
      licenses: [{ id: 'singularity-flow-polyglot-structural-preview', spdx: 'MIT', sourceSha256: hashBytes(licenseBytes) }],
      conformance: { fixtureVersion: '2', status: 'preview', languages: Object.keys(languages) },
      implementation: {
        artifactSha256, manifestSha256: '0'.repeat(64),
        runtime: { id: 'node', version: process.versions.node, platform: 'any' },
        grammars: [],
        dependencies: { lockSha256: null, bundleSha256: recordSha256({ adapterSha256: artifactSha256, coreSha256 }) },
        files: [
          { path: POLYGLOT_ADAPTER, sha256: artifactSha256 },
          { path: POLYGLOT_CORE, sha256: coreSha256 },
          { path: POLYGLOT_LICENSE, sha256: hashBytes(licenseBytes) }
        ]
      }
    };
    manifest.implementation.manifestSha256 = astAdapterManifestSha256(manifest);
    return validateAstAdapterManifest(manifest, 'bundled polyglot structural preview');
  })();
  return bundledManifestPromise;
}

export async function bundledAstAdapters() {
  return [await bundledPolyglotManifest()];
}

/** Verify installed/bundled artifact bytes without launching adapter code. */
export async function inspectAstAdapterArtifacts(manifest) {
  const diagnostics = [];
  for (const artifact of manifest.implementation.files ?? []) {
    const bytes = await readFile(artifact.path).catch(() => null);
    if (!bytes || hashBytes(bytes) !== artifact.sha256) diagnostics.push({
      code: bytes ? 'AST_ADAPTER_ARTIFACT_MISMATCH' : 'AST_ADAPTER_ARTIFACT_MISSING',
      adapter: manifest.id,
      message: `AST adapter pack '${manifest.id}' has a missing or changed installed artifact.`
    });
  }
  return { healthy: diagnostics.length === 0, diagnostics };
}

/** Manifests are discovered explicitly; package search paths and repository files are never executed. */
export async function discoverAstAdapters(environment = process.env) {
  const configured = String(environment.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS ?? '').trim();
  const adapters = environment.SINGULARITY_FLOW_AST_DISABLE_BUNDLED_PACK === '1' ? [] : await bundledAstAdapters();
  const diagnostics = []; const seen = new Set(adapters.map((adapter) => adapter.id));
  let registered = [];
  try { registered = await registeredAstManifestPaths(environment); }
  catch (error) { diagnostics.push({ code: 'AST_PACK_REGISTRY_INVALID', source: 'machine-registry', message: error.message }); }
  const sources = [
    ...registered.sort().map((manifestPath, index) => ({ manifestPath, source: `installed-pack-${index + 1}` })),
    ...configured.split(path.delimiter).filter(Boolean).map((manifestPath, index) => ({ manifestPath, source: `configured-manifest-${index + 1}` }))
  ];
  for (const { manifestPath, source } of sources) {
    try {
      const adapter = validateAstAdapterManifest(JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')), `AST adapter ${source}`);
      if (seen.has(adapter.id)) {
        diagnostics.push({ code: 'AST_ADAPTER_DUPLICATE', source, message: `Adapter id '${adapter.id}' is already configured; the duplicate was ignored.` });
        continue;
      }
      seen.add(adapter.id);
      adapters.push(adapter);
    } catch (error) {
      diagnostics.push({ code: 'AST_ADAPTER_INVALID', source, message: error.message });
    }
  }
  return { adapters, diagnostics };
}

export function astAdapterRequest({
  protocolVersion = AST_ADAPTER_PROTOCOL_VERSION, operation, stage = 'syntax', scope, files,
  budget, implementation = null, project = null
}) {
  if (![AST_ADAPTER_MINIMUM_PROTOCOL_VERSION, AST_ADAPTER_PROTOCOL_VERSION].includes(protocolVersion)) {
    throw new SingularityFlowError(`AST adapter request protocolVersion must be ${AST_ADAPTER_MINIMUM_PROTOCOL_VERSION} or ${AST_ADAPTER_PROTOCOL_VERSION}.`);
  }
  const request = {
    protocolVersion,
    operation,
    ...(protocolVersion === AST_ADAPTER_PROTOCOL_VERSION ? { stage } : {}),
    scope,
    files: Object.freeze(files.map((file) => Object.freeze({ path: file.path, sha256: file.sha256, language: file.language }))),
    ...(protocolVersion === AST_ADAPTER_PROTOCOL_VERSION
      ? { project: project ? Object.freeze(structuredClone(project)) : null }
      : {}),
    budget: Object.freeze({ ...budget }),
    implementation: implementation ? Object.freeze({
      artifactSha256: implementation.artifactSha256,
      manifestSha256: implementation.manifestSha256
    }) : null
  };
  request.derivationIdentity = recordSha256(request);
  return Object.freeze(request);
}

function safeSpan(value, source) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.startLine) || value.startLine < 1
    || !Number.isInteger(value.startColumn) || value.startColumn < 1
    || !Number.isInteger(value.endLine) || value.endLine < value.startLine
    || !Number.isInteger(value.endColumn) || value.endColumn < 1
    || (value.endLine === value.startLine && value.endColumn < value.startColumn)) {
    throw new SingularityFlowError(`${source} span must be a non-inverted 1-based line and column range.`);
  }
  return { startLine: value.startLine, startColumn: value.startColumn, endLine: value.endLine, endColumn: value.endColumn };
}

function assertNoForbiddenFields(value, source) {
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_FACT_FIELDS.has(key)) throw new SingularityFlowError(`${source} fact must not contain '${key}'.`);
      visit(child);
    }
  };
  visit(value);
}

function safeFact(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${source} fact must be an object.`);
  assertNoForbiddenFields(value, source);
  if (!FACT_KINDS.has(value.kind)) throw new SingularityFlowError(`${source} fact kind is not in the reviewed vocabulary.`);
  if (value.kind === 'symbol') {
    const legacySpan = Number.isInteger(value.line) ? { startLine: value.line, startColumn: 1, endLine: value.line, endColumn: 2 } : null;
    if (typeof value.name !== 'string' || !value.name || (!legacySpan && !value.span)) {
      throw new SingularityFlowError(`${source} symbol fact requires name and span.`);
    }
    const span = safeSpan(value.span ?? legacySpan, source);
    const id = typeof value.id === 'string' && value.id ? value.id
      : `legacy:${value.name}:${span.startLine}:${String(value.declarationKind ?? 'symbol')}`;
    return {
      kind: 'symbol', id, name: value.name,
      qualifiedName: String(value.qualifiedName ?? value.name),
      declarationKind: String(value.declarationKind ?? 'symbol'),
      signature: String(value.signature ?? `${value.declarationKind ?? 'symbol'} ${value.name}`).slice(0, 500),
      containerId: typeof value.containerId === 'string' ? value.containerId : null,
      ...(typeof value.syntaxId === 'string' && value.syntaxId ? { syntaxId: value.syntaxId } : {}),
      visibility: String(value.visibility ?? 'default'),
      modifiers: Array.isArray(value.modifiers) ? value.modifiers.map(String).slice(0, 50).sort() : [],
      annotations: Array.isArray(value.annotations) ? value.annotations.map(String).slice(0, 50).sort() : [],
      span, line: span.startLine, assurance: value.assurance
    };
  }
  if (value.kind === 'import') {
    if (typeof value.target !== 'string' || !value.target) throw new SingularityFlowError(`${source} import fact requires target.`);
    return {
      kind: 'import', target: value.target,
      importedNames: Array.isArray(value.importedNames) ? value.importedNames.map(String).slice(0, 100).sort() : [],
      aliases: Array.isArray(value.aliases) ? value.aliases.map(String).slice(0, 100).sort() : [],
      importKind: String(value.importKind ?? 'module'),
      ...(value.span ? { span: safeSpan(value.span, source) } : {}), assurance: value.assurance
    };
  }
  if (value.kind === 'relationship') {
    if (!RELATIONSHIPS.has(value.type) || typeof value.target !== 'string' || !value.target) {
      throw new SingularityFlowError(`${source} relationship fact requires type and target.`);
    }
    return {
      kind: 'relationship', type: value.type, target: value.target,
      ...(typeof (value.sourceId ?? value.source) === 'string' ? { sourceId: value.sourceId ?? value.source } : {}),
      ...(value.syntaxId ? { syntaxId: String(value.syntaxId) } : {}),
      ...(value.span ? { span: safeSpan(value.span, source) } : {}), assurance: value.assurance
    };
  }
  if (value.kind === 'module') {
    if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name) {
      throw new SingularityFlowError(`${source} module fact requires id and name.`);
    }
    return { kind: 'module', id: value.id, name: value.name, ...(value.span ? { span: safeSpan(value.span, source) } : {}), assurance: value.assurance };
  }
  if (value.kind === 'diagnostic') {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code ?? '')) throw new SingularityFlowError(`${source} diagnostic fact requires a reviewed code.`);
    return { kind: 'diagnostic', code: value.code, ...(value.span ? { span: safeSpan(value.span, source) } : {}), assurance: value.assurance };
  }
  if (value.kind === 'file') throw new SingularityFlowError(`${source} file facts are broker-authored and cannot be supplied by an adapter.`);
  throw new SingularityFlowError(`${source} fact kind is unsupported.`);
}

export function validateAstAdapterResponse(value, manifest, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`AST adapter '${manifest.id}' returned no JSON object.`);
  if (value.protocolVersion !== manifest.protocolVersion || value.adapterId !== manifest.id
    || value.extractorVersion !== manifest.extractorVersion || value.assurance !== manifest.assurance
    || (manifest.protocolVersion === AST_ADAPTER_PROTOCOL_VERSION && value.packVersion != null && value.packVersion !== manifest.packVersion)
    || (manifest.protocolVersion === AST_ADAPTER_PROTOCOL_VERSION && value.stage != null && value.stage !== manifest.stage)
    || value.derivationIdentity !== request.derivationIdentity
    || value.artifactSha256 !== manifest.implementation.artifactSha256
    || value.manifestSha256 !== manifest.implementation.manifestSha256) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' response identity or assurance does not match its manifest.`);
  }
  if (!Array.isArray(value.files)) throw new SingularityFlowError(`AST adapter '${manifest.id}' response files must be an array.`);
  const requested = new Map(request.files.map((file) => [file.path, file]));
  const seen = new Set(); const rejectedFiles = [];
  const files = value.files.flatMap((file) => {
    const expected = requested.get(file?.path);
    if (!expected || seen.has(file.path) || file.sha256 !== expected.sha256 || !Array.isArray(file.facts)) {
      throw new SingularityFlowError(`AST adapter '${manifest.id}' returned an unrequested, duplicate, stale, or malformed file result.`);
    }
    seen.add(file.path);
    try {
      const facts = file.facts.map((fact) => {
        const normalized = safeFact(fact, `AST adapter '${manifest.id}'`);
        if (normalized.assurance != null && normalized.assurance !== manifest.assurance) {
          throw new SingularityFlowError(`AST adapter '${manifest.id}' fact claims assurance outside its manifest.`);
        }
        if (manifest.stage === 'semantic' && normalized.kind === 'relationship'
          && ['calls', 'references', 'overrides', 'conforms-to'].includes(normalized.type)
          && (!normalized.sourceId || !normalized.target)) {
          throw new SingularityFlowError(`AST adapter '${manifest.id}' semantic relationship requires stable source and target endpoints.`);
        }
        const derivation = manifest.stage === 'semantic'
          ? adapterDerivationKey(manifest, expected.language, request.project)
          : null;
        return {
          ...normalized,
          assurance: manifest.assurance,
          ...(derivation && normalized.kind === 'relationship'
            ? { derivationSha256: derivation.derivationSha256 }
            : {})
        };
      });
      return [{ path: file.path, sha256: file.sha256, facts }];
    } catch (error) {
      rejectedFiles.push({ path: file.path, code: 'AST_ADAPTER_FILE_RESULT_INVALID' });
      return [];
    }
  });
  return {
    protocolVersion: manifest.protocolVersion,
    ...(manifest.legacyProtocol ? { legacyProtocol: manifest.legacyProtocol } : {}),
    adapterId: manifest.id,
    packVersion: manifest.packVersion,
    extractorVersion: manifest.extractorVersion,
    stage: manifest.stage,
    assurance: manifest.assurance,
    derivationIdentity: request.derivationIdentity,
    artifactSha256: manifest.implementation.artifactSha256,
    manifestSha256: manifest.implementation.manifestSha256,
    files, rejectedFiles,
    // Adapter prose is untrusted output and could contain source bytes, credentials, or host
    // paths. Preserve a bounded machine code while authoring the human sentence in the broker.
    diagnostics: Array.isArray(value.diagnostics)
      ? value.diagnostics.slice(0, 100).map((item) => {
          const proposed = String(item?.code ?? 'AST_ADAPTER_DIAGNOSTIC');
          const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(proposed) ? proposed : 'AST_ADAPTER_DIAGNOSTIC';
          return { code, message: `AST adapter '${manifest.id}' reported diagnostic ${code}.` };
        })
      : []
  };
}

function adapterEnvironment(environment) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
  const result = Object.fromEntries(allowed.filter((key) => environment[key] != null).map((key) => [key, environment[key]]));
  // VS Code's extension host is Electron. Reusing that exact, already-approved runtime for the
  // bundled adapter requires its documented Node mode; without this flag a packaged extension
  // would launch a second Electron application instead of the structured-argv adapter.
  if (process.versions.electron && process.execPath === (environment.SINGULARITY_FLOW_AST_NODE_EXECUTABLE ?? process.execPath)) {
    result.ELECTRON_RUN_AS_NODE = '1';
  }
  return result;
}

/** Execute one explicitly configured adapter through structured argv and a bounded JSON channel. */
export async function executeAstAdapter(manifest, request, {
  root, timeoutMs = 30_000, maxOutputBytes = 2 * 1024 * 1024, environment = process.env,
  signal = null
} = {}) {
  const executableArtifact = [...manifest.argv].reverse().find((entry) => existsSync(path.resolve(root, entry)));
  if (!executableArtifact) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' implementation artifact cannot be resolved for digest verification.`, { code: 'AST_ADAPTER_ARTIFACT_MISSING' });
  }
  const artifactBytes = await readFile(path.resolve(root, executableArtifact));
  if (hashBytes(artifactBytes) !== manifest.implementation.artifactSha256) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' implementation artifact digest does not match its manifest.`, { code: 'AST_ADAPTER_ARTIFACT_MISMATCH' });
  }
  for (const installed of manifest.implementation.files ?? []) {
    const bytes = await readFile(installed.path).catch(() => null);
    if (!bytes || hashBytes(bytes) !== installed.sha256) {
      throw new SingularityFlowError(`AST adapter '${manifest.id}' installed pack artifact digest does not match its manifest.`, { code: 'AST_ADAPTER_ARTIFACT_MISMATCH' });
    }
  }
  const [command, ...args] = manifest.argv;
  const result = await runQualityCommand(command, args, {
    cwd: root,
    env: { ...adapterEnvironment(environment), SINGULARITY_FLOW_AST_ADAPTER: '1' },
    shell: false,
    timeoutMs,
    captureBytes: maxOutputBytes,
    input: `${JSON.stringify(request)}\n`,
    signal,
    killTree: true
  });
  if (result.aborted) throw new SingularityFlowError(`AST adapter '${manifest.id}' was cancelled.`, { code: 'AST_ADAPTER_CANCELLED' });
  if (result.timedOut) throw new SingularityFlowError(`AST adapter '${manifest.id}' timed out after ${timeoutMs}ms.`, { code: 'AST_ADAPTER_TIMEOUT' });
  if (result.status !== 0) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' failed with exit status ${result.status}. Adapter output was not retained.`, { code: 'AST_ADAPTER_FAILED' });
  }
  if (result.stdoutTruncated) throw new SingularityFlowError(`AST adapter '${manifest.id}' exceeded its ${maxOutputBytes}-byte output budget.`, { code: 'AST_ADAPTER_OUTPUT_BUDGET' });
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) { throw new SingularityFlowError(`AST adapter '${manifest.id}' returned invalid JSON: ${error.message}`, { code: 'AST_ADAPTER_INVALID_RESPONSE' }); }
  return validateAstAdapterResponse(parsed, manifest, request);
}

export function adapterDerivationKey(manifest, language, project = null) {
  const definition = manifest.languageDefinitions[language];
  if (!definition) throw new SingularityFlowError(`AST adapter '${manifest.id}' does not advertise language '${language}'.`);
  const grammar = manifest.implementation.grammars.find((entry) => entry.language === language) ?? null;
  return createAstDerivationKey({
    stage: manifest.stage, language, adapterId: manifest.id, packVersion: manifest.packVersion,
    extractorVersion: manifest.extractorVersion, parserEngine: definition.parserEngine,
    parserVersion: definition.parserVersion, grammarId: definition.grammarId ?? grammar?.id ?? null,
    grammarVersion: definition.grammarVersion ?? grammar?.version ?? null,
    toolchain: project?.toolchain ?? null,
    projectModelSha256: project?.projectModelSha256 ?? null,
    dependencyGraphSha256: project?.dependencyGraphSha256 ?? null,
    configurationSha256: project?.configurationSha256 ?? null,
    profile: project?.profile ?? null, sourceSet: project?.sourceSets?.join(',') || null
  });
}

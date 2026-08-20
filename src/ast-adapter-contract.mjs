import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { runQualityCommand } from './quality-command-runner.mjs';

export const AST_ADAPTER_PROTOCOL_VERSION = 2;
const ASSURANCE = new Set(['syntax', 'semantic']);
const CAPABILITIES = new Set(['skeleton', 'query', 'gate']);
const DIGEST = /^[a-f0-9]{64}$/;

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
    }
  };
}

/**
 * Validate an adapter advertisement without importing adapter code into the kernel process.
 * Actual adapters are optional executables and communicate using bounded JSON envelopes.
 */
export function validateAstAdapterManifest(value, source = 'AST adapter manifest') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${source} must be an object.`);
  if (value.protocolVersion !== AST_ADAPTER_PROTOCOL_VERSION) throw new SingularityFlowError(`${source} protocolVersion must be ${AST_ADAPTER_PROTOCOL_VERSION}.`);
  if (!/^[a-z][a-z0-9-]*$/.test(value.id ?? '')) throw new SingularityFlowError(`${source} id must be lower-case kebab-case.`);
  if (!Array.isArray(value.languages) || !value.languages.length || value.languages.some((item) => typeof item !== 'string' || !item)) {
    throw new SingularityFlowError(`${source} languages must be a non-empty string array.`);
  }
  if (!ASSURANCE.has(value.assurance)) throw new SingularityFlowError(`${source} assurance must be syntax or semantic.`);
  if (!Array.isArray(value.argv) || !value.argv.length || value.argv.some((item) => typeof item !== 'string' || !item)) {
    throw new SingularityFlowError(`${source} argv must be a non-empty structured argument array.`);
  }
  if (!value.extractorVersion || typeof value.extractorVersion !== 'string') throw new SingularityFlowError(`${source} extractorVersion is required.`);
  if (value.capabilities != null && (!Array.isArray(value.capabilities)
    || value.capabilities.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item)))) {
    throw new SingularityFlowError(`${source} capabilities may contain only ${[...CAPABILITIES].join(', ')}.`);
  }
  const implementation = validateImplementation(value.implementation, value, source);
  return Object.freeze({
    protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
    id: value.id,
    languages: Object.freeze([...new Set(value.languages)].sort()),
    assurance: value.assurance,
    argv: Object.freeze([...value.argv]),
    extractorVersion: value.extractorVersion,
    capabilities: Object.freeze([...(value.capabilities ?? [])].sort()),
    implementation: Object.freeze(implementation)
  });
}

/** Manifests are discovered explicitly; package search paths and repository files are never executed. */
export async function discoverAstAdapters(environment = process.env) {
  const configured = String(environment.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS ?? '').trim();
  if (!configured) return { adapters: [], diagnostics: [] };
  const adapters = []; const diagnostics = []; const seen = new Set();
  for (const [index, manifestPath] of configured.split(path.delimiter).filter(Boolean).entries()) {
    const source = `configured-manifest-${index + 1}`;
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

export function astAdapterRequest({ operation, scope, files, budget, implementation = null }) {
  const request = {
    protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
    operation,
    scope,
    files: Object.freeze(files.map((file) => Object.freeze({ path: file.path, sha256: file.sha256, language: file.language }))),
    budget: Object.freeze({ ...budget }),
    implementation: implementation ? Object.freeze({
      artifactSha256: implementation.artifactSha256,
      manifestSha256: implementation.manifestSha256
    }) : null
  };
  request.derivationIdentity = recordSha256(request);
  return Object.freeze(request);
}

function safeFact(value, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${source} fact must be an object.`);
  const forbidden = ['sourceBody', 'text', 'body', 'content'].find((key) => Object.hasOwn(value, key));
  if (forbidden) throw new SingularityFlowError(`${source} fact must not contain source bytes in '${forbidden}'.`);
  if (value.kind === 'symbol') {
    if (typeof value.name !== 'string' || !value.name || !Number.isInteger(value.line) || value.line < 1) {
      throw new SingularityFlowError(`${source} symbol fact requires name and positive line.`);
    }
    return {
      kind: 'symbol', name: value.name, declarationKind: String(value.declarationKind ?? 'symbol'),
      line: value.line, assurance: value.assurance
    };
  }
  if (value.kind === 'import') {
    if (typeof value.target !== 'string' || !value.target) throw new SingularityFlowError(`${source} import fact requires target.`);
    return { kind: 'import', target: value.target, assurance: value.assurance };
  }
  if (value.kind === 'relationship') {
    if (typeof value.type !== 'string' || !value.type || typeof value.target !== 'string' || !value.target) {
      throw new SingularityFlowError(`${source} relationship fact requires type and target.`);
    }
    return {
      kind: 'relationship', type: value.type, target: value.target,
      ...(typeof value.source === 'string' ? { sourceId: value.source } : {}), assurance: value.assurance
    };
  }
  throw new SingularityFlowError(`${source} fact kind must be symbol, import, or relationship.`);
}

export function validateAstAdapterResponse(value, manifest, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`AST adapter '${manifest.id}' returned no JSON object.`);
  if (value.protocolVersion !== AST_ADAPTER_PROTOCOL_VERSION || value.adapterId !== manifest.id
    || value.extractorVersion !== manifest.extractorVersion || value.assurance !== manifest.assurance
    || value.derivationIdentity !== request.derivationIdentity
    || value.artifactSha256 !== manifest.implementation.artifactSha256
    || value.manifestSha256 !== manifest.implementation.manifestSha256) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' response identity or assurance does not match its manifest.`);
  }
  if (!Array.isArray(value.files)) throw new SingularityFlowError(`AST adapter '${manifest.id}' response files must be an array.`);
  const requested = new Map(request.files.map((file) => [file.path, file]));
  const seen = new Set();
  const files = value.files.map((file) => {
    const expected = requested.get(file?.path);
    if (!expected || seen.has(file.path) || file.sha256 !== expected.sha256 || !Array.isArray(file.facts)) {
      throw new SingularityFlowError(`AST adapter '${manifest.id}' returned an unrequested, duplicate, stale, or malformed file result.`);
    }
    seen.add(file.path);
    const facts = file.facts.map((fact) => {
      const normalized = safeFact(fact, `AST adapter '${manifest.id}'`);
      if (normalized.assurance != null && normalized.assurance !== manifest.assurance) {
        throw new SingularityFlowError(`AST adapter '${manifest.id}' fact claims assurance outside its manifest.`);
      }
      return { ...normalized, assurance: manifest.assurance };
    });
    return { path: file.path, sha256: file.sha256, facts };
  });
  return {
    protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
    adapterId: manifest.id,
    extractorVersion: manifest.extractorVersion,
    assurance: manifest.assurance,
    derivationIdentity: request.derivationIdentity,
    artifactSha256: manifest.implementation.artifactSha256,
    manifestSha256: manifest.implementation.manifestSha256,
    files,
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
  return Object.fromEntries(allowed.filter((key) => environment[key] != null).map((key) => [key, environment[key]]));
}

/** Execute one explicitly configured adapter through structured argv and a bounded JSON channel. */
export async function executeAstAdapter(manifest, request, {
  root, timeoutMs = 30_000, maxOutputBytes = 2 * 1024 * 1024, environment = process.env
} = {}) {
  const executableArtifact = [...manifest.argv].reverse().find((entry) => existsSync(path.resolve(root, entry)));
  if (!executableArtifact) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' implementation artifact cannot be resolved for digest verification.`, { code: 'AST_ADAPTER_ARTIFACT_MISSING' });
  }
  const artifactBytes = await readFile(path.resolve(root, executableArtifact));
  if (hashBytes(artifactBytes) !== manifest.implementation.artifactSha256) {
    throw new SingularityFlowError(`AST adapter '${manifest.id}' implementation artifact digest does not match its manifest.`, { code: 'AST_ADAPTER_ARTIFACT_MISMATCH' });
  }
  const [command, ...args] = manifest.argv;
  const result = await runQualityCommand(command, args, {
    cwd: root,
    env: { ...adapterEnvironment(environment), SINGULARITY_FLOW_AST_ADAPTER: '1' },
    shell: false,
    timeoutMs,
    captureBytes: maxOutputBytes,
    input: `${JSON.stringify(request)}\n`
  });
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

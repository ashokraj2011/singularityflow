import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SingularityFlowError } from './util.mjs';

export const AST_ADAPTER_PROTOCOL_VERSION = 1;
const ASSURANCE = new Set(['syntax', 'semantic']);

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
  return Object.freeze({
    protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
    id: value.id,
    languages: Object.freeze([...new Set(value.languages)].sort()),
    assurance: value.assurance,
    argv: Object.freeze([...value.argv]),
    extractorVersion: value.extractorVersion,
    capabilities: Object.freeze([...(value.capabilities ?? [])].sort())
  });
}

/** Manifests are discovered explicitly; package search paths and repository files are never executed. */
export async function discoverAstAdapters(environment = process.env) {
  const configured = String(environment.SINGULARITY_FLOW_AST_ADAPTER_MANIFESTS ?? '').trim();
  if (!configured) return { adapters: [], diagnostics: [] };
  const adapters = []; const diagnostics = [];
  for (const manifestPath of configured.split(path.delimiter).filter(Boolean)) {
    try {
      adapters.push(validateAstAdapterManifest(JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')), manifestPath));
    } catch (error) {
      diagnostics.push({ code: 'AST_ADAPTER_INVALID', source: manifestPath, message: error.message });
    }
  }
  return { adapters, diagnostics };
}

export function astAdapterRequest({ operation, scope, files, budget }) {
  return Object.freeze({
    protocolVersion: AST_ADAPTER_PROTOCOL_VERSION,
    operation,
    scope,
    files: Object.freeze(files.map((file) => Object.freeze({ path: file.path, sha256: file.sha256, language: file.language }))),
    budget: Object.freeze({ ...budget })
  });
}

import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const AST_DERIVATION_KEY_SCHEMA_VERSION = currentSchemaVersion('ast-derivation-key');
const DIGEST = /^[a-f0-9]{64}$/;

function nullableDigest(value, label) {
  if (value != null && !DIGEST.test(value)) throw new SingularityFlowError(`${label} must be null or a SHA-256 digest.`);
  return value ?? null;
}

export function astDerivationKeySha256(value) {
  const { derivationSha256: _digest, ...semantic } = structuredClone(value);
  return recordSha256(semantic);
}

export function validateAstDerivationKey(value, source = 'AST derivation key') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${source} must be a DerivationKeyV1 object.`);
  }
  value = readRecord('ast-derivation-key', value).record;
  if (!['text', 'syntax', 'semantic'].includes(value.stage) || !/^[a-z][a-z0-9-]*$/.test(value.language ?? '')) {
    throw new SingularityFlowError(`${source} requires a valid stage and language.`);
  }
  for (const field of ['adapterId', 'packVersion', 'extractorVersion', 'parserEngine', 'parserVersion']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new SingularityFlowError(`${source}.${field} is required.`);
  }
  if (value.toolchain != null && (typeof value.toolchain.kind !== 'string' || typeof value.toolchain.version !== 'string'
      || !DIGEST.test(value.toolchain.identitySha256 ?? ''))) {
    throw new SingularityFlowError(`${source}.toolchain is invalid.`);
  }
  for (const field of ['projectModelSha256', 'dependencyGraphSha256', 'configurationSha256']) nullableDigest(value[field], `${source}.${field}`);
  if (!DIGEST.test(value.derivationSha256 ?? '') || value.derivationSha256 !== astDerivationKeySha256(value)) {
    throw new SingularityFlowError(`${source}.derivationSha256 does not bind the derivation fields.`);
  }
  return structuredClone(value);
}

export function createAstDerivationKey({
  stage, language, adapterId, packVersion, extractorVersion,
  parserEngine, parserVersion, grammarId = null, grammarVersion = null,
  toolchain = null, projectModelSha256 = null, dependencyGraphSha256 = null,
  configurationSha256 = null, profile = null, sourceSet = null
}) {
  const value = {
    schemaVersion: AST_DERIVATION_KEY_SCHEMA_VERSION,
    stage, language, adapterId, packVersion, extractorVersion,
    parserEngine, parserVersion, grammarId, grammarVersion,
    toolchain: toolchain ? structuredClone(toolchain) : null,
    projectModelSha256, dependencyGraphSha256, configurationSha256,
    profile, sourceSet, derivationSha256: ''
  };
  value.derivationSha256 = astDerivationKeySha256(value);
  return Object.freeze(validateAstDerivationKey(value));
}

export function astSyntaxCacheKey(contentSha256, derivation) {
  const key = validateAstDerivationKey(derivation);
  if (key.stage !== 'syntax') throw new SingularityFlowError('Syntax cache keys require a syntax derivation.');
  return recordSha256({ sourceSha256: contentSha256, derivation: key });
}

export function astSemanticOverlayKey(syntaxKey, derivation) {
  const key = validateAstDerivationKey(derivation);
  if (key.stage !== 'semantic') throw new SingularityFlowError('Semantic overlay keys require a semantic derivation.');
  return recordSha256({ syntaxSkeletonSha256: syntaxKey, derivation: key });
}

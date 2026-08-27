import { SingularityFlowError } from './util.mjs';
import { normalizeSourceRoots } from './source-scope.mjs';

export const AST_MODES = Object.freeze(['auto', 'off']);
export const AST_FALLBACKS = Object.freeze(['host-and-text', 'text-only']);
export const AST_ASSURANCE = Object.freeze(['text', 'syntax', 'semantic']);
export const AST_EVIDENCE_MODES = Object.freeze(['replayable', 'identified', 'off']);
export const AST_STORY_START_WARM_MODES = Object.freeze(['background', 'before-first-phase', 'off']);
export const AST_STORY_START_WARM_SCOPES = Object.freeze(['configured-roots', 'repository']);
export const AST_PREDICATE_TYPES = Object.freeze([
  'path-exists', 'symbol-exists', 'import-boundary', 'annotation-present', 'inherits-from',
  'conforms-to', 'override-exists', 'public-signature-changed', 'module-dependency'
]);

const PREDICATE_FIELDS = Object.freeze({
  'path-exists': ['path'],
  'symbol-exists': ['symbol'],
  'import-boundary': ['path', 'target'],
  'annotation-present': ['symbol', 'annotation'],
  'inherits-from': ['symbol', 'target'],
  'conforms-to': ['symbol', 'target'],
  'override-exists': ['symbol', 'target'],
  'public-signature-changed': ['path', 'expectedSha256'],
  'module-dependency': ['module', 'target']
});

function positiveInteger(value, fallback, label) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1) throw new SingularityFlowError(`${label} must be a positive integer.`);
  return actual;
}

/**
 * Validate the repository-pinned AST policy without loading an AST implementation.
 *
 * Parsers remain optional packages. Keeping this normalizer in the configuration layer prevents
 * merely reading workflow.yml from pulling a compiler into the trusted kernel.
 */
export function normalizeAstPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('ast must be an object.');
  const allowed = new Set([
    'mode', 'fallback', 'languages', 'generatedRoots', 'budgets', 'predicates', 'evidence',
    'warmOnStoryStart'
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`ast contains unknown field '${key}'.`);
  const mode = value.mode ?? 'auto';
  const fallback = value.fallback ?? 'host-and-text';
  if (!AST_MODES.includes(mode)) throw new SingularityFlowError(`ast.mode must be ${AST_MODES.join(' or ')}.`);
  if (!AST_FALLBACKS.includes(fallback)) throw new SingularityFlowError(`ast.fallback must be ${AST_FALLBACKS.join(' or ')}.`);

  const languages = {};
  for (const [language, policy] of Object.entries(value.languages ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(language)) throw new SingularityFlowError(`ast.languages key '${language}' must be lower-case kebab-case.`);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new SingularityFlowError(`ast.languages.${language} must be an object.`);
    for (const key of Object.keys(policy)) if (!['mode', 'minimumAssurance', 'syntaxProvider', 'semanticProvider', 'semanticProfile'].includes(key)) throw new SingularityFlowError(`ast.languages.${language} contains unknown field '${key}'.`);
    const languageMode = policy.mode ?? 'auto';
    const minimumAssurance = policy.minimumAssurance ?? 'text';
    if (!AST_MODES.includes(languageMode)) throw new SingularityFlowError(`ast.languages.${language}.mode must be auto or off.`);
    if (!AST_ASSURANCE.includes(minimumAssurance)) throw new SingularityFlowError(`ast.languages.${language}.minimumAssurance must be text, syntax, or semantic.`);
    for (const field of ['syntaxProvider', 'semanticProvider']) {
      if (policy[field] != null && !/^[a-z][a-z0-9-]*$/.test(policy[field])) {
        throw new SingularityFlowError(`ast.languages.${language}.${field} must be a lower-case pack id.`);
      }
    }
    if (policy.semanticProfile != null && (typeof policy.semanticProfile !== 'string' || !policy.semanticProfile.trim())) {
      throw new SingularityFlowError(`ast.languages.${language}.semanticProfile must be a non-empty string.`);
    }
    languages[language] = {
      mode: languageMode, minimumAssurance,
      syntaxProvider: policy.syntaxProvider ?? null,
      semanticProvider: policy.semanticProvider ?? null,
      semanticProfile: policy.semanticProfile ?? null
    };
  }

  const generatedRoots = normalizeSourceRoots(value.generatedRoots, 'ast.generatedRoots');
  if (value.budgets != null && (!value.budgets || typeof value.budgets !== 'object' || Array.isArray(value.budgets))) {
    throw new SingularityFlowError('ast.budgets must be an object.');
  }
  for (const key of Object.keys(value.budgets ?? {})) {
    if (!['maxFiles', 'maxBytes', 'maxFileBytes'].includes(key)) throw new SingularityFlowError(`ast.budgets contains unknown field '${key}'.`);
  }
  const predicates = value.predicates ?? [];
  if (!Array.isArray(predicates)) throw new SingularityFlowError('ast.predicates must be an array.');
  for (const predicate of predicates) {
    if (!predicate || typeof predicate !== 'object' || !predicate.id || !['required', 'advisory'].includes(predicate.mode ?? 'advisory')) {
      throw new SingularityFlowError('Each ast predicate requires an id and mode required or advisory.');
    }
    if (!AST_PREDICATE_TYPES.includes(predicate.type)) {
      throw new SingularityFlowError(`AST predicate '${predicate.id}' type must be one of ${AST_PREDICATE_TYPES.join(', ')}.`);
    }
    const requiredFields = PREDICATE_FIELDS[predicate.type];
    const allowedFields = new Set(['id', 'mode', 'type', 'minimumAssurance', 'languages', 'profiles', ...requiredFields]);
    for (const key of Object.keys(predicate)) {
      if (!allowedFields.has(key)) throw new SingularityFlowError(`AST predicate '${predicate.id}' contains unknown field '${key}'.`);
    }
    for (const field of requiredFields) {
      const value = predicate[field];
      if (typeof value !== 'string' || !value.trim()) throw new SingularityFlowError(`AST predicate '${predicate.id}' requires ${field}.`);
    }
    if (predicate.expectedSha256 != null && !/^[a-f0-9]{64}$/.test(predicate.expectedSha256)) {
      throw new SingularityFlowError(`AST predicate '${predicate.id}' expectedSha256 must be a SHA-256 digest.`);
    }
    const rich = !['path-exists', 'symbol-exists'].includes(predicate.type);
    for (const field of ['languages', 'profiles']) {
      const list = predicate[field];
      if (rich && (!Array.isArray(list) || !list.length)) {
        throw new SingularityFlowError(`AST predicate '${predicate.id}' must declare applicable ${field}. Use ['*'] for every ${field === 'languages' ? 'language' : 'profile'}.`);
      }
      if (list != null && (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item.trim()))) {
        throw new SingularityFlowError(`AST predicate '${predicate.id}' ${field} must be a non-empty string array.`);
      }
    }
    if (!AST_ASSURANCE.includes(predicate.minimumAssurance ?? 'text')) throw new SingularityFlowError(`AST predicate '${predicate.id}' minimumAssurance must be text, syntax, or semantic.`);
  }
  const evidenceSource = value.evidence ?? {};
  if (!evidenceSource || typeof evidenceSource !== 'object' || Array.isArray(evidenceSource)) {
    throw new SingularityFlowError('ast.evidence must be an object.');
  }
  for (const key of Object.keys(evidenceSource)) {
    if (!['mode', 'store'].includes(key)) throw new SingularityFlowError(`ast.evidence contains unknown field '${key}'.`);
  }
  const evidenceMode = evidenceSource.mode ?? 'identified';
  const evidenceStore = evidenceSource.store ?? 'local-directory';
  if (!AST_EVIDENCE_MODES.includes(evidenceMode)) {
    throw new SingularityFlowError(`ast.evidence.mode must be ${AST_EVIDENCE_MODES.join(', ')}.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(evidenceStore)) {
    throw new SingularityFlowError('ast.evidence.store must be a lower-case logical store id.');
  }
  const storyStartSource = value.warmOnStoryStart ?? {};
  if (!storyStartSource || typeof storyStartSource !== 'object' || Array.isArray(storyStartSource)) {
    throw new SingularityFlowError('ast.warmOnStoryStart must be an object.');
  }
  for (const key of Object.keys(storyStartSource)) {
    if (!['mode', 'scope'].includes(key)) {
      throw new SingularityFlowError(`ast.warmOnStoryStart contains unknown field '${key}'.`);
    }
  }
  const storyStartMode = storyStartSource.mode ?? 'background';
  const storyStartScope = storyStartSource.scope ?? 'configured-roots';
  if (!AST_STORY_START_WARM_MODES.includes(storyStartMode)) {
    throw new SingularityFlowError(
      `ast.warmOnStoryStart.mode must be ${AST_STORY_START_WARM_MODES.join(', ')}.`
    );
  }
  if (!AST_STORY_START_WARM_SCOPES.includes(storyStartScope)) {
    throw new SingularityFlowError(
      `ast.warmOnStoryStart.scope must be ${AST_STORY_START_WARM_SCOPES.join(' or ')}.`
    );
  }
  return Object.freeze({
    mode,
    fallback,
    languages: Object.freeze(languages),
    generatedRoots: Object.freeze([...new Set(generatedRoots)].sort()),
    budgets: Object.freeze({
      maxFiles: positiveInteger(value.budgets?.maxFiles, 500, 'ast.budgets.maxFiles'),
      maxBytes: positiveInteger(value.budgets?.maxBytes, 20 * 1024 * 1024, 'ast.budgets.maxBytes'),
      maxFileBytes: positiveInteger(value.budgets?.maxFileBytes, 2 * 1024 * 1024, 'ast.budgets.maxFileBytes')
    }),
    predicates: Object.freeze(predicates.map((predicate) => Object.freeze({
      ...predicate,
      mode: predicate.mode ?? 'advisory',
      minimumAssurance: predicate.minimumAssurance ?? 'text',
      ...(predicate.languages ? { languages: Object.freeze([...new Set(predicate.languages)].sort()) } : {}),
      ...(predicate.profiles ? { profiles: Object.freeze([...new Set(predicate.profiles)].sort()) } : {})
    }))),
    evidence: Object.freeze({ mode: evidenceMode, store: evidenceStore }),
    warmOnStoryStart: Object.freeze({ mode: storyStartMode, scope: storyStartScope })
  });
}

export function assuranceSatisfies(actual, required) {
  return AST_ASSURANCE.indexOf(actual) >= AST_ASSURANCE.indexOf(required);
}

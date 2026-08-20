import { SingularityFlowError } from './util.mjs';
import { normalizeSourceRoots } from './source-scope.mjs';

export const AST_MODES = Object.freeze(['auto', 'off']);
export const AST_FALLBACKS = Object.freeze(['host-and-text', 'text-only']);
export const AST_ASSURANCE = Object.freeze(['text', 'syntax', 'semantic']);
export const AST_EVIDENCE_MODES = Object.freeze(['replayable', 'identified', 'off']);

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
  const allowed = new Set(['mode', 'fallback', 'languages', 'generatedRoots', 'budgets', 'predicates', 'evidence']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`ast contains unknown field '${key}'.`);
  const mode = value.mode ?? 'auto';
  const fallback = value.fallback ?? 'host-and-text';
  if (!AST_MODES.includes(mode)) throw new SingularityFlowError(`ast.mode must be ${AST_MODES.join(' or ')}.`);
  if (!AST_FALLBACKS.includes(fallback)) throw new SingularityFlowError(`ast.fallback must be ${AST_FALLBACKS.join(' or ')}.`);

  const languages = {};
  for (const [language, policy] of Object.entries(value.languages ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(language)) throw new SingularityFlowError(`ast.languages key '${language}' must be lower-case kebab-case.`);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new SingularityFlowError(`ast.languages.${language} must be an object.`);
    for (const key of Object.keys(policy)) if (!['mode', 'minimumAssurance'].includes(key)) throw new SingularityFlowError(`ast.languages.${language} contains unknown field '${key}'.`);
    const languageMode = policy.mode ?? 'auto';
    const minimumAssurance = policy.minimumAssurance ?? 'text';
    if (!AST_MODES.includes(languageMode)) throw new SingularityFlowError(`ast.languages.${language}.mode must be auto or off.`);
    if (!AST_ASSURANCE.includes(minimumAssurance)) throw new SingularityFlowError(`ast.languages.${language}.minimumAssurance must be text, syntax, or semantic.`);
    languages[language] = { mode: languageMode, minimumAssurance };
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
    for (const key of Object.keys(predicate)) {
      if (!['id', 'mode', 'type', 'path', 'symbol', 'minimumAssurance'].includes(key)) throw new SingularityFlowError(`AST predicate '${predicate.id}' contains unknown field '${key}'.`);
    }
    if (!['path-exists', 'symbol-exists'].includes(predicate.type)) throw new SingularityFlowError(`AST predicate '${predicate.id}' type must be path-exists or symbol-exists.`);
    if (predicate.type === 'path-exists' && (typeof predicate.path !== 'string' || !predicate.path)) throw new SingularityFlowError(`AST predicate '${predicate.id}' requires path.`);
    if (predicate.type === 'symbol-exists' && (typeof predicate.symbol !== 'string' || !predicate.symbol)) throw new SingularityFlowError(`AST predicate '${predicate.id}' requires symbol.`);
    if (!AST_ASSURANCE.includes(predicate.minimumAssurance ?? 'text')) throw new SingularityFlowError(`AST predicate '${predicate.id}' minimumAssurance must be text, syntax, or semantic.`);
  }
  if (mode === 'off' && predicates.some((predicate) => predicate.mode === 'required')) {
    throw new SingularityFlowError('ast.mode off cannot be combined with a required structural predicate.');
  }
  const evidenceSource = value.evidence ?? {};
  if (!evidenceSource || typeof evidenceSource !== 'object' || Array.isArray(evidenceSource)) {
    throw new SingularityFlowError('ast.evidence must be an object.');
  }
  for (const key of Object.keys(evidenceSource)) {
    if (!['mode', 'store'].includes(key)) throw new SingularityFlowError(`ast.evidence contains unknown field '${key}'.`);
  }
  const hasRequiredPredicate = predicates.some((predicate) => predicate.mode === 'required');
  const evidenceMode = evidenceSource.mode ?? (hasRequiredPredicate ? 'replayable' : 'identified');
  const evidenceStore = evidenceSource.store ?? 'local-directory';
  if (!AST_EVIDENCE_MODES.includes(evidenceMode)) {
    throw new SingularityFlowError(`ast.evidence.mode must be ${AST_EVIDENCE_MODES.join(', ')}.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(evidenceStore)) {
    throw new SingularityFlowError('ast.evidence.store must be a lower-case logical store id.');
  }
  if (hasRequiredPredicate && evidenceMode !== 'replayable') {
    throw new SingularityFlowError('A required AST predicate requires ast.evidence.mode replayable.');
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
      minimumAssurance: predicate.minimumAssurance ?? 'text'
    }))),
    evidence: Object.freeze({ mode: evidenceMode, store: evidenceStore })
  });
}

export function assuranceSatisfies(actual, required) {
  return AST_ASSURANCE.indexOf(actual) >= AST_ASSURANCE.indexOf(required);
}

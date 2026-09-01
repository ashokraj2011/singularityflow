export const VIEW_STATUSES = Object.freeze(['active', 'revoked']);

export const FACT_STATUSES = Object.freeze([
  'available', 'partial', 'unavailable', 'contradicted', 'stale'
]);

export const ASSURANCE_LEVELS = Object.freeze([
  'source-exact',
  'structurally-derived',
  'deterministically-derived',
  'human-confirmed',
  'runtime-observed',
  'heuristic',
  'model-advisory',
  'not-applicable'
]);

export const GOVERNED_STRUCTURAL_ASSURANCE = Object.freeze([
  'source-exact',
  'structurally-derived',
  'deterministically-derived',
  'human-confirmed',
  'runtime-observed',
  'not-applicable'
]);

export const EVIDENCE_KINDS = Object.freeze([
  'file',
  'directory',
  'symbol',
  'signature',
  'export',
  'import',
  'dependency-edge',
  'call-edge',
  'reference-edge',
  'interface-implementation',
  'configuration-object',
  'rule-object',
  'condition-expression',
  'test-identity',
  'test-symbol-binding',
  'clause-binding',
  'decision-record',
  'runtime-observation',
  'human-confirmed-record',
  'unavailability-observation'
]);

export const FACT_TYPES = Object.freeze([
  'file-exists',
  'language-detected',
  'symbol-exists',
  'symbol-index',
  'signature',
  'export',
  'import-dependency',
  'dependency-edge',
  'dependency-analysis',
  'configuration-object',
  'changed-symbol',
  'contract-change',
  'test-impact',
  'structural-impact',
  'runtime-frequency',
  'interface',
  'implementation',
  'consumer-dependency',
  'schema-contract',
  'protocol-field',
  'runtime-guarantee',
  'change-frequency',
  'dependency-degree',
  'complexity-metric',
  'incident-mapping',
  'ownership-concentration',
  'rule-definition',
  'condition-expression',
  'clause-binding',
  'test-identity',
  'maintainer-record',
  'business-glossary',
  'business-meaning'
]);

export const SUBJECT_KINDS = Object.freeze([
  'repository', 'file', 'directory', 'symbol', 'contract', 'dependency-edge', 'test',
  'rule', 'configuration', 'analysis', 'runtime-observation', 'human-record'
]);

// A Scope Manifest may explicitly admit any registered Fact subject kind. The selected subset is
// enforced when Facts are registered; keeping a second, narrower vocabulary made valid synthetic
// unavailable analysis impossible to declare and tempted callers to bypass the manifest instead.
export const SCOPE_SUBJECT_KINDS = SUBJECT_KINDS;

export const DERIVATION_STATUSES = Object.freeze(['complete', 'partial', 'unavailable']);

export const UNAVAILABLE_REASON_CODES = Object.freeze([
  'UNSUPPORTED_LANGUAGE',
  'INVALID_UTF8',
  'PARSE_FAILURE',
  'FILE_UNREADABLE',
  'NO_BASELINE',
  'NO_RUNTIME_EVIDENCE',
  'NO_REGISTERED_PRODUCER',
  'OUT_OF_SCOPE',
  'ANALYSIS_NOT_REQUESTED'
]);

export const SECTION_KINDS = Object.freeze(['factual', 'unavailable', 'contradiction']);
export const MODEL_MODES = Object.freeze(['never', 'optional', 'required']);

export function vocabularyHas(vocabulary, value) {
  return vocabulary.includes(value);
}

export function assertVocabularyValue(label, value, vocabulary, code = 'WMB_VOCABULARY_INVALID') {
  if (!vocabularyHas(vocabulary, value)) {
    const error = new TypeError(`${label} must be one of ${vocabulary.join(', ')}.`);
    error.code = code;
    error.details = { label, value, allowed: [...vocabulary] };
    throw error;
  }
  return value;
}

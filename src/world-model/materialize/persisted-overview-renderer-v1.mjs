import { createHash } from 'node:crypto';

function contractFailure(message, code = 'WMB_CONTRACT_INVALID', details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, location = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) contractFailure(
      `Persisted overview canonical JSON cannot encode a non-finite number at ${location}.`
    );
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => {
    if (entry === undefined) contractFailure(
      `Persisted overview canonical JSON cannot encode undefined at ${location}[${index}].`
    );
    return canonicalValue(entry, `${location}[${index}]`);
  });
  if (!isPlainRecord(value)) contractFailure(
    `Persisted overview canonical JSON requires a plain object at ${location}.`
  );
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) contractFailure(
      `Persisted overview canonical JSON cannot encode undefined at ${location}.${key}.`
    );
    return [key, canonicalValue(value[key], `${location}.${key}`)];
  }));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(canonicalJson(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function compareText(left, right) {
  const first = String(left);
  const second = String(right);
  return first === second ? 0 : first < second ? -1 : 1;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) contractFailure(`${label} must be a plain object.`);
  return value;
}

function assertExactKeys(value, { required = [], optional = [], label }) {
  assertPlainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) {
    contractFailure(`${label} is missing required field '${key}'.`,
      'WMB_CONTRACT_FIELD_MISSING', { label, key });
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) {
    contractFailure(`${label} contains unknown field '${key}'.`,
      'WMB_CONTRACT_FIELD_UNKNOWN', { label, key });
  }
  return value;
}

function assertString(value, label, { pattern = null } = {}) {
  if (typeof value !== 'string' || !value.length) contractFailure(
    `${label} must be a non-empty string.`
  );
  if (pattern && !pattern.test(value)) contractFailure(`${label} has an invalid format.`,
    'WMB_CONTRACT_FORMAT_INVALID', { label, value });
  return value;
}

function assertSha256(value, label) {
  return assertString(value, label, { pattern: /^sha256:[a-f0-9]{64}$/u });
}

function assertSelfHash(value, hashField, label) {
  const copy = { ...value };
  delete copy[hashField];
  const expected = sha256(copy);
  if (value?.[hashField] !== expected) contractFailure(
    `${label} ${hashField} does not match its canonical content.`,
    'WMB_RECORD_HASH_MISMATCH', { hashField, expected, received: value?.[hashField] ?? null }
  );
  return value;
}

export {
  canonicalJson as persistedOverviewCanonicalJsonV1,
  contractFailure as persistedOverviewContractFailureV1,
  sha256 as persistedOverviewSha256V1
};

export const PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES = 64 * 1024;
export const PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES = 8 * 1024;

const VARIANTS = Object.freeze(['full', 'brief']);
const OUTPUT_FORMATS = Object.freeze(['md', 'json']);
const CAPTURE_GAP_STATUSES = Object.freeze(['unavailable', 'not-applicable']);
const CAPTURE_GAP_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VIEW_IDS = Object.freeze([
  'repository.architecture',
  'repository.business',
  'repository.development',
  'repository.security',
  'repository.testing'
]);

const VIEW_CAVEATS = deepFreeze({
  'repository.business': 'Business purpose and consumers are unverified unless supplied by captured declarations; structural symbols do not establish them.',
  'repository.architecture': 'An import graph is not runtime topology; declared-versus-observed differences require both captured inputs.',
  'repository.development': 'Hotspot claims require a captured metric and window; structure alone does not prove complexity, ownership risk, or runtime frequency.',
  'repository.security': 'This view is not a security verdict. A classified command or path does not prove that arbitrary application code has no other effects.',
  'repository.testing': 'Test references are not verification. No pass, coverage, or completeness claim exists without an admissible captured report.'
});

/*
 * This mapping is part of the renderer contract. A Fact is displayed once, in the first matching
 * section. Unavailable and contradicted Facts always go to the contract's typed limitation or
 * contradiction section so a missing input cannot be hidden by ordinary inventory.
 */
const SECTION_FACT_TYPES = deepFreeze({
  'repository.business': {
    'declared-purpose': ['business-glossary', 'business-meaning', 'rule-definition'],
    'documented-surfaces': ['export', 'interface', 'protocol-field', 'schema-contract'],
    'observed-entry-points': ['configuration-object', 'file-exists', 'language-detected'],
    'capability-and-consumer-references': ['consumer-dependency'],
    'input-provenance': []
  },
  'repository.architecture': {
    'modules-and-boundaries': ['configuration-object', 'file-exists', 'implementation', 'interface', 'symbol-index'],
    'imports-and-dependencies': ['consumer-dependency', 'dependency-analysis', 'dependency-edge', 'import-dependency'],
    'contracts-and-declarations': ['protocol-field', 'schema-contract', 'signature']
  },
  'repository.development': {
    'files-and-symbols': ['export', 'file-exists', 'symbol-exists', 'symbol-index'],
    'signatures-and-dependencies': ['dependency-edge', 'import-dependency', 'signature'],
    'change-and-history': [
      'change-frequency', 'changed-symbol', 'complexity-metric', 'dependency-degree',
      'ownership-concentration', 'structural-impact'
    ],
    'parser-coverage': ['language-detected']
  },
  'repository.security': {
    'policy-classification-and-ownership': [
      'configuration-object', 'maintainer-record', 'ownership-concentration', 'schema-contract'
    ],
    'dependencies-and-effects': ['consumer-dependency', 'dependency-edge', 'interface'],
    'admitted-security-observations': ['incident-mapping', 'runtime-frequency', 'runtime-guarantee']
  },
  'repository.testing': {
    'test-identities': ['test-identity'],
    'test-relationships': ['dependency-edge', 'structural-impact', 'test-impact'],
    'clause-bindings': ['clause-binding'],
    'execution-and-coverage': ['runtime-frequency']
  }
});

export const PERSISTED_OVERVIEW_RENDERER = deepFreeze({
  id: 'repository-overview-fixed-template',
  version: 1,
  model: 'never',
  input: 'verified-view-fact-ledger-and-captured-input-gaps',
  ordering: 'contract-section-then-fact-id-lexical',
  lineEndings: 'lf',
  markdown: 'escaped-inert-text',
  json: 'canonical-html-safe-json',
  briefSelection: 'limitations-then-fact-id-greedy-byte-fit-v1',
  caveats: VIEW_CAVEATS,
  sectionFactTypes: SECTION_FACT_TYPES,
  fullMaximumBytes: PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES,
  briefMaximumBytes: PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES
});
export const PERSISTED_OVERVIEW_RENDERER_SHA256 = sha256(PERSISTED_OVERVIEW_RENDERER);

function normalizedText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '\ufffd')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapedMarkdown(value) {
  return normalizedText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1')
    .replace(/\b(command|data|file|javascript|vscode):/giu, '$1&#58;');
}

function htmlSafeCanonicalJson(value) {
  return canonicalJson(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function normalizeCapturedInputGaps(values) {
  if (!Array.isArray(values)) {
    contractFailure('Captured input gaps must be an array.', 'WMP_VIEW_INPUT_GAP_INVALID');
  }
  const normalized = values.map((value, index) => {
    assertPlainRecord(value, `Captured input gap ${index}`);
    assertExactKeys(value, {
      required: ['id', 'status', 'reason'], optional: ['inputSha256'],
      label: `Captured input gap ${index}`
    });
    assertString(value.id, `Captured input gap ${index} id`, { pattern: CAPTURE_GAP_ID_PATTERN });
    if (!CAPTURE_GAP_STATUSES.includes(value.status)) {
      contractFailure(
        `Captured input gap '${value.id}' status must be unavailable or not-applicable.`,
        'WMP_VIEW_INPUT_GAP_INVALID'
      );
    }
    assertString(value.reason, `Captured input gap ${index} reason`);
    if (!normalizedText(value.reason)) {
      contractFailure(`Captured input gap '${value.id}' reason is empty.`, 'WMP_VIEW_INPUT_GAP_INVALID');
    }
    if (value.inputSha256 != null) assertSha256(value.inputSha256, `Captured input gap ${index} inputSha256`);
    return {
      id: value.id,
      source: 'captured-input',
      status: value.status,
      reason: normalizedText(value.reason),
      factId: null,
      inputSha256: value.inputSha256 ?? null
    };
  }).sort((left, right) => compareText(
    `${left.id}\u0000${left.status}\u0000${left.reason}\u0000${left.inputSha256 ?? ''}`,
    `${right.id}\u0000${right.status}\u0000${right.reason}\u0000${right.inputSha256 ?? ''}`
  ));
  const ids = normalized.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    contractFailure('Captured input gaps must not repeat an id.', 'WMP_VIEW_INPUT_GAP_INVALID');
  }
  return normalized;
}

function displayFact(fact) {
  return {
    id: fact.id,
    factType: fact.factType,
    status: fact.status,
    assurance: fact.assurance,
    subject: { kind: fact.subject.kind, id: normalizedText(fact.subject.id) },
    statement: normalizedText(fact.status === 'unavailable' ? fact.reason.detail : fact.claim),
    evidenceIds: [...fact.evidenceIds].sort(compareText),
    conflictsWith: [...fact.conflictsWith].sort(compareText)
  };
}

function factGaps(facts) {
  return facts.filter((fact) => fact.status === 'unavailable' || fact.status === 'contradicted')
    .map((fact) => ({
      id: `fact.${fact.id}`,
      source: 'view-fact-ledger',
      status: fact.status,
      reason: normalizedText(fact.status === 'unavailable' ? fact.reason.detail : fact.claim),
      factId: fact.id,
      inputSha256: null
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

function targetSection(contract, fact) {
  if (fact.status === 'unavailable') {
    const limitation = contract.sections.find((section) => section.sectionKind === 'unavailable');
    if (limitation) return limitation.id;
  }
  if (fact.status === 'contradicted') {
    const contradiction = contract.sections.find((section) => section.sectionKind === 'contradiction');
    if (contradiction) return contradiction.id;
    const limitation = contract.sections.find((section) => section.sectionKind === 'unavailable');
    if (limitation) return limitation.id;
  }
  const mapping = SECTION_FACT_TYPES[contract.id] ?? {};
  return Object.entries(mapping).find(([, factTypes]) => factTypes.includes(fact.factType))?.[0]
    ?? contract.sections.find((section) => section.sectionKind === 'factual')?.id
    ?? contract.sections[0].id;
}

function payloadFor({
  contract, ledger, selectedFacts, omittedFactIds, gaps, variant, outputFormat,
  modelPayloadSha256, viewInputsSha256, capturedInputGapsSha256, expansionHandle
}) {
  const sections = contract.sections.map((section) => ({
    id: section.id,
    title: section.title,
    sectionKind: section.sectionKind,
    facts: selectedFacts.filter((fact) => targetSection(contract, fact) === section.id)
      .map(displayFact)
      .sort((left, right) => compareText(left.id, right.id))
  }));
  return {
    format: outputFormat,
    renderer: {
      id: PERSISTED_OVERVIEW_RENDERER.id,
      version: PERSISTED_OVERVIEW_RENDERER.version,
      rendererSha256: PERSISTED_OVERVIEW_RENDERER_SHA256
    },
    selection: {
      capturedInputGapsSha256,
      expansionHandle,
      modelPayloadSha256,
      omittedFacts: omittedFactIds.length,
      selectedFacts: selectedFacts.length,
      totalFacts: ledger.facts.length,
      viewInputsSha256
    },
    variant,
    view: {
      contractSha256: contract.contractSha256,
      factLedgerSha256: ledger.ledgerSha256,
      id: contract.id,
      reference: `${contract.id}@${contract.version}`,
      title: contract.title,
      version: contract.version
    },
    caveat: VIEW_CAVEATS[contract.id],
    gaps,
    sections
  };
}

function factMarkdown(fact) {
  const evidence = fact.evidenceIds.length ? fact.evidenceIds.map(escapedMarkdown).join(', ') : 'none';
  const conflicts = fact.conflictsWith.length ? `; conflicts: ${fact.conflictsWith.map(escapedMarkdown).join(', ')}` : '';
  return `- ${escapedMarkdown(fact.id)} | ${escapedMarkdown(fact.factType)} | ${escapedMarkdown(fact.status)}`
    + ` | ${escapedMarkdown(fact.assurance)} | ${escapedMarkdown(fact.subject.kind)}:${escapedMarkdown(fact.subject.id)}`
    + ` | ${escapedMarkdown(fact.statement)} | evidence: ${evidence}${conflicts}`;
}

function markdownFor(payload) {
  const lines = [
    `# ${escapedMarkdown(payload.view.title)}`,
    '',
    `- View: ${escapedMarkdown(payload.view.reference)}`,
    `- Contract: ${escapedMarkdown(payload.view.contractSha256)}`,
    `- Fact ledger: ${escapedMarkdown(payload.view.factLedgerSha256)}`,
    `- Renderer: ${escapedMarkdown(`${payload.renderer.id}@${payload.renderer.version}`)}`,
    `- Variant: ${escapedMarkdown(payload.variant)}`,
    `- Facts: ${payload.selection.selectedFacts} selected, ${payload.selection.omittedFacts} omitted, ${payload.selection.totalFacts} total`,
    `- Expansion: ${escapedMarkdown(payload.selection.expansionHandle)}`,
    '',
    '## Interpretation boundary',
    '',
    escapedMarkdown(payload.caveat),
    ''
  ];
  for (const section of payload.sections) {
    lines.push(`## ${escapedMarkdown(section.title)}`, '');
    if (section.facts.length) lines.push(...section.facts.map(factMarkdown));
    else lines.push('- No selected facts.');
    lines.push('');
  }
  lines.push('## Captured limitations and contradictions', '');
  if (!payload.gaps.length) lines.push('- None captured.');
  else for (const gap of payload.gaps) {
    const reference = gap.factId ?? gap.inputSha256 ?? 'no retained reference supplied';
    lines.push(`- ${escapedMarkdown(gap.id)} | ${escapedMarkdown(gap.status)} | ${escapedMarkdown(gap.reason)}`
      + ` | reference: ${escapedMarkdown(reference)}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function serialize(payload, outputFormat) {
  return outputFormat === 'json' ? htmlSafeCanonicalJson(payload) : markdownFor(payload);
}

function byteLimit(variant, requested) {
  const hard = variant === 'brief'
    ? PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES
    : PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES;
  if (requested == null) return hard;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > hard) {
    contractFailure(
      `Persisted overview maximumBytes must be an integer from 1 through ${hard}.`,
      'WMP_VIEW_BYTE_BUDGET_INVALID',
      { variant, maximumBytes: requested, hardMaximumBytes: hard }
    );
  }
  return requested;
}

function budgetFailure({ contract, variant, maximumBytes, neededBytes }) {
  contractFailure(
    `Persisted overview '${contract.id}@${contract.version}' requires ${neededBytes} bytes; the ${variant} limit is ${maximumBytes}.`,
    'WMP_BUDGET_TOO_SMALL',
    { view: `${contract.id}@${contract.version}`, variant, maximumBytes, neededBytes }
  );
}

function validatePersistedOverviewViewContractV1(value) {
  assertPlainRecord(value, 'Persisted overview View Contract');
  if (value.schemaVersion !== 1 || value.kind !== 'world-model-view-contract'
      || value.version !== 1 || !VIEW_IDS.includes(value.id)) {
    contractFailure(
      'Persisted overview replay requires one exact retained v1 overview View Contract.',
      'WMP_VIEW_CONTRACT_INVALID',
      { id: value.id ?? null, version: value.version ?? null }
    );
  }
  assertString(value.title, 'Persisted overview View Contract title');
  assertSha256(value.contractSha256, 'Persisted overview View Contract contractSha256');
  assertSelfHash(value, 'contractSha256', 'Persisted overview View Contract');
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    contractFailure('Persisted overview View Contract sections must be a non-empty array.',
      'WMP_VIEW_CONTRACT_INVALID');
  }
  const sectionIds = new Set();
  for (const [index, section] of value.sections.entries()) {
    assertPlainRecord(section, `Persisted overview View Contract section ${index}`);
    assertString(section.id, `Persisted overview View Contract section ${index} id`);
    assertString(section.title, `Persisted overview View Contract section ${index} title`);
    if (!['factual', 'unavailable', 'contradiction'].includes(section.sectionKind)
        || sectionIds.has(section.id)) {
      contractFailure('Persisted overview View Contract contains an invalid section.',
        'WMP_VIEW_CONTRACT_INVALID', { sectionId: section.id ?? null });
    }
    sectionIds.add(section.id);
  }
  assertPlainRecord(value.factPolicy, 'Persisted overview View Contract factPolicy');
  for (const field of [
    'requiredFactTypes', 'optionalFactTypes', 'allowedStatus', 'allowedAssurance',
    'requiredUnavailableSubjects'
  ]) {
    if (!Array.isArray(value.factPolicy[field])
        || value.factPolicy[field].some((entry) => typeof entry !== 'string')) {
      contractFailure(`Persisted overview View Contract factPolicy.${field} must be a string array.`,
        'WMP_VIEW_CONTRACT_INVALID');
    }
  }
  assertPlainRecord(value.facts, 'Persisted overview View Contract facts');
  if (!Number.isSafeInteger(value.facts.maximumSelectedFacts)
      || value.facts.maximumSelectedFacts < 1) {
    contractFailure('Persisted overview View Contract maximumSelectedFacts is invalid.',
      'WMP_VIEW_CONTRACT_INVALID');
  }
  return value;
}

function validatePersistedViewFactLedgerV1(value, { sourceFactLedger, viewContract }) {
  assertPlainRecord(value, 'Persisted View Fact Ledger');
  assertSha256(value.ledgerSha256, 'Persisted View Fact Ledger ledgerSha256');
  assertSha256(value.sourceLedgerSha256, 'Persisted View Fact Ledger sourceLedgerSha256');
  assertSha256(value.viewSpecSha256, 'Persisted View Fact Ledger viewSpecSha256');
  assertSelfHash(value, 'ledgerSha256', 'Persisted View Fact Ledger');
  if (value.viewId !== viewContract.id || value.viewVersion !== viewContract.version
      || value.viewSpecSha256 !== viewContract.contractSha256) {
    contractFailure('Persisted View Fact Ledger contract binding is invalid.',
      'WMB_VIEW_CONTRACT_MISMATCH');
  }
  if (value.sourceLedgerSha256 !== sourceFactLedger.ledgerSha256) {
    contractFailure('Persisted View Fact Ledger source binding is invalid.',
      'WMP_FACT_SOURCE_MISMATCH');
  }
  if (!Array.isArray(value.facts) || !Array.isArray(sourceFactLedger.facts)) {
    contractFailure('Persisted View Fact Ledger facts must be arrays.',
      'WMP_VIEW_FACT_LEDGER_INVALID');
  }
  const sourceIds = new Set(sourceFactLedger.facts.map((fact) => fact.id));
  const selectedIds = new Set();
  for (const fact of value.facts) {
    if (!fact || typeof fact !== 'object' || typeof fact.id !== 'string'
        || selectedIds.has(fact.id) || !sourceIds.has(fact.id)) {
      contractFailure('Persisted View Fact Ledger contains an invalid or unregistered Fact.',
        'WMP_FACT_NOT_REGISTERED');
    }
    selectedIds.add(fact.id);
  }
  const eligibleTypes = new Set([
    ...viewContract.factPolicy.requiredFactTypes,
    ...viewContract.factPolicy.optionalFactTypes,
    ...viewContract.factPolicy.requiredUnavailableSubjects
  ]);
  const eligible = sourceFactLedger.facts.filter((fact) => eligibleTypes.has(fact.factType)
    && fact.status !== 'stale'
    && viewContract.factPolicy.allowedStatus.includes(fact.status)
    && viewContract.factPolicy.allowedAssurance.includes(fact.assurance));
  const required = eligible.filter((fact) => (
    viewContract.factPolicy.requiredFactTypes.includes(fact.factType)
  ));
  const requiredUnavailable = eligible.filter((fact) => fact.status === 'unavailable'
    && viewContract.factPolicy.requiredUnavailableSubjects.includes(fact.factType));
  const contradictions = eligible.filter((fact) => fact.status === 'contradicted');
  const mandatoryIds = new Set(
    [...required, ...requiredUnavailable, ...contradictions].map((fact) => fact.id)
  );
  const optional = eligible.filter((fact) => !mandatoryIds.has(fact.id))
    .sort((left, right) => compareText(left.id, right.id));
  const remaining = viewContract.facts.maximumSelectedFacts - mandatoryIds.size;
  const expectedIds = [...mandatoryIds, ...optional.slice(0, remaining).map((fact) => fact.id)]
    .sort(compareText);
  const exact = (left, right) => canonicalJson(left) === canonicalJson(right);
  if (!exact([...selectedIds].sort(compareText), expectedIds)
      || !exact(value.requiredFactIds, required.map((fact) => fact.id).sort(compareText))
      || !exact(value.requiredUnavailableFactIds,
        requiredUnavailable.map((fact) => fact.id).sort(compareText))
      || !exact(value.materialContradictionFactIds,
        contradictions.map((fact) => fact.id).sort(compareText))) {
    contractFailure('Persisted View Fact Ledger selection is not the deterministic v1 selection.',
      'WMB_SELECTION_INVALID');
  }
  return value;
}

/**
 * Pure deterministic renderer for the five WMP repository overview contracts. The caller supplies
 * an already captured ledger and explicit captured-input gaps; this function has no source,
 * filesystem, network, clock, random, model, cache, or publication dependency.
 */
export function renderPersistedOverviewViewV1({
  viewContract, sourceFactLedger, viewFactLedger, capturedInputGaps = [], variant = 'full', outputFormat = 'md',
  maximumBytes = null, modelPayloadSha256, viewInputsSha256
} = {}) {
  if (!VARIANTS.includes(variant)) {
    contractFailure(`Persisted overview variant must be ${VARIANTS.join(' or ')}.`, 'WMP_VIEW_VARIANT_INVALID');
  }
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    contractFailure(`Persisted overview output format must be ${OUTPUT_FORMATS.join(' or ')}.`, 'WMP_VIEW_OUTPUT_FORMAT_INVALID');
  }
  if (sourceFactLedger == null) {
    contractFailure(
      'Persisted overview rendering requires the exact source Fact Ledger.',
      'WMP_SOURCE_FACT_LEDGER_REQUIRED'
    );
  }
  assertSha256(modelPayloadSha256, 'Persisted overview modelPayloadSha256');
  assertSha256(viewInputsSha256, 'Persisted overview viewInputsSha256');
  const contract = validatePersistedOverviewViewContractV1(viewContract);
  const ledger = validatePersistedViewFactLedgerV1(viewFactLedger, {
    sourceFactLedger, viewContract: contract
  });
  const capturedGaps = normalizeCapturedInputGaps(capturedInputGaps);
  const capturedInputGapsSha256 = sha256({
    kind: 'wmp/captured-input-gaps', version: 1, gaps: capturedGaps
  });
  const expansionHandle = `wmp-view:${sha256({
    kind: 'wmp/overview-expansion-handle',
    version: 1,
    modelPayloadSha256,
    viewInputsSha256,
    capturedInputGapsSha256,
    viewContractSha256: contract.contractSha256,
    sourceFactLedgerSha256: sourceFactLedger.ledgerSha256,
    viewFactLedgerSha256: ledger.ledgerSha256,
    rendererSha256: PERSISTED_OVERVIEW_RENDERER_SHA256
  })}`;
  const facts = [...ledger.facts].sort((left, right) => compareText(left.id, right.id));
  const gaps = [...capturedGaps, ...factGaps(facts)]
    .sort((left, right) => compareText(`${left.source}\u0000${left.id}`, `${right.source}\u0000${right.id}`));
  const limit = byteLimit(variant, maximumBytes);

  const render = (selectedFacts) => {
    const selectedIds = new Set(selectedFacts.map((fact) => fact.id));
    const omittedFactIds = facts.filter((fact) => !selectedIds.has(fact.id)).map((fact) => fact.id);
    const payload = payloadFor({
      contract, ledger, selectedFacts, omittedFactIds, gaps, variant, outputFormat,
      modelPayloadSha256, viewInputsSha256, capturedInputGapsSha256, expansionHandle
    });
    const content = serialize(payload, outputFormat);
    return { content, payload, omittedFactIds, bytes: Buffer.byteLength(content, 'utf8') };
  };

  let rendered;
  if (variant === 'full') {
    rendered = render(facts);
    if (rendered.bytes > limit) budgetFailure({
      contract, variant, maximumBytes: limit, neededBytes: rendered.bytes
    });
  } else {
    const mandatoryIds = new Set([
      ...(ledger.requiredUnavailableFactIds ?? []),
      ...(ledger.materialContradictionFactIds ?? []),
      ...facts.filter((fact) => ['unavailable', 'contradicted'].includes(fact.status)).map((fact) => fact.id)
    ]);
    const selected = facts.filter((fact) => mandatoryIds.has(fact.id));
    rendered = render(selected);
    if (rendered.bytes > limit) budgetFailure({
      contract, variant, maximumBytes: limit, neededBytes: rendered.bytes
    });
    for (const fact of facts.filter((entry) => !mandatoryIds.has(entry.id))) {
      const candidate = render([...selected, fact].sort((left, right) => compareText(left.id, right.id)));
      if (candidate.bytes <= limit) {
        selected.push(fact);
        selected.sort((left, right) => compareText(left.id, right.id));
        rendered = candidate;
      }
    }
  }

  const selectedFactIds = rendered.payload.sections.flatMap((section) => section.facts.map((fact) => fact.id))
    .sort(compareText);
  return deepFreeze({
    content: rendered.content,
    bytes: rendered.bytes,
    payloadSha256: sha256(Buffer.from(rendered.content, 'utf8')),
    outputFormat,
    variant,
    maximumBytes: limit,
    measurement: { kind: 'exact-bytes', bytes: rendered.bytes, maximumBytes: limit },
    selectedFactIds,
    omittedFactIds: rendered.omittedFactIds,
    gaps: rendered.payload.gaps
  });
}

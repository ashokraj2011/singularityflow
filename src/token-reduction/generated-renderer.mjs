/**
 * Exact, versioned renderer for TKR-generated framing sections.
 *
 * This module is deliberately pure: it performs no I/O and accepts only normalized aliases or
 * omission records supplied by the composer. The machine-readable contract and its self-hash bind
 * the two supported algorithms and their byte format to one immutable renderer reference.
 */
import { SingularityFlowError } from '../util.mjs';
import {
  canonicalize, deepFreeze, sha256, withoutFields
} from '../world-model/canonicalize.mjs';

const CONTRACT_KEYS = new Set([
  'kind', 'version', 'owner', 'rendererId', 'format', 'generators', 'contractSha256'
]);
const FORMAT_KEYS = new Set([
  'encoding', 'jsonWhitespace', 'objectKeyOrder', 'arrayOrder', 'trailingNewline'
]);
const GENERATOR_KEYS = new Set([
  'id', 'outputKind', 'outputVersion', 'collectionField', 'scopeField', 'scopeRule',
  'itemFields', 'itemOrder'
]);
const RENDER_OPTION_KEYS = new Set(['rendererContract', 'rendererRef']);
const PAYLOAD_KEYS = new Set(['aliases', 'omissions']);
const ALIAS_KEYS = new Set(['id', 'namespace', 'scopeRef', 'targetRef']);
const OMISSION_KEYS = new Set([
  'sectionId', 'subjectRef', 'reason', 'originalRenderedRef', 'expansionRefs', 'limitations',
  // The composer retains these two owner fields in its structured omission record. They are
  // validated here even though the compact, contract-pinned notice does not repeat them.
  'evidenceRole', 'requirementRef'
]);
const OMISSION_REQUIRED_KEYS = new Set([
  'sectionId', 'subjectRef', 'reason', 'originalRenderedRef', 'expansionRefs', 'limitations'
]);
const SUBJECT_REF_KEYS = new Set(['owner', 'domain', 'kind', 'id', 'revision', 'sourceRef']);
const RENDERED_REF_KEYS = new Set(['sha256', 'bytes']);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ALIAS_ID = /^([A-Za-z]+)([1-9][0-9]*)$/u;
const SECTION_ID = /^[a-z][a-z0-9-]{0,63}$/u;

// Defensive processing ceilings mirror the registered v1 composer envelope. They bound this
// exported renderer independently so a caller cannot bypass the composer's earlier validation.
const MAXIMUM_ALIASES = 1024;
const MAXIMUM_OMISSIONS = 256;
const MAXIMUM_COLLECTION_ITEMS = 4096;
const MAXIMUM_STRING_BYTES = 64 * 1024;
const MAXIMUM_WORKING_METADATA_BYTES = 16 * 1024 * 1024;

function fail(message, details = {}, code = 'TKR_CONTRACT_UNSUPPORTED') {
  throw new SingularityFlowError(message, {
    code,
    details: {
      ...details,
      nextAction: details.nextAction
        ?? 'Use the exact packaged TKR generated renderer contract and reference.'
    }
  });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label, code = 'TKR_CONTRACT_UNSUPPORTED', required = keys) {
  if (!plain(value)) fail(`${label} must be a plain object.`, { subject: label }, code);
  const missing = [...required].filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (missing.length || unknown.length) fail(`${label} has an invalid field set.`, {
    subject: label, missing, unknown: unknown.sort()
  }, code);
  return value;
}

function limit(label, maximum, required) {
  fail(`${label} exceeds its registered processing limit.`, {
    limit: label,
    maximum,
    required,
    nextAction: 'Use an admitted narrower input or install a revised supported renderer contract.'
  }, 'TKR_LIMIT_EXCEEDED');
}

function charge(state, bytes, label) {
  state.bytes += bytes;
  if (state.bytes > MAXIMUM_WORKING_METADATA_BYTES) {
    limit(label, MAXIMUM_WORKING_METADATA_BYTES, state.bytes);
  }
}

function chargeItems(state, count, label) {
  state.items += count;
  if (state.items > MAXIMUM_COLLECTION_ITEMS) {
    limit(label, MAXIMUM_COLLECTION_ITEMS, state.items);
  }
}

function boundedText(value, label, {
  code = 'TKR_CONTRACT_UNSUPPORTED', pattern = null, state = null,
  maximumBytes = MAXIMUM_STRING_BYTES
} = {}) {
  if (typeof value !== 'string' || !value.trim().length) {
    fail(`${label} must be a non-whitespace string.`, { subject: label }, code);
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) {
    fail(`${label} is not a well-formed Unicode string.`, { subject: label }, code);
  }
  if (bytes.length > maximumBytes) limit(label, maximumBytes, bytes.length);
  if (pattern && !pattern.test(value)) {
    fail(`${label} is not in the registered format.`, { subject: label, value }, code);
  }
  if (state) charge(state, bytes.length, 'generated renderer working metadata bytes');
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`, { subject: label, received: value });
  }
  return value;
}

function exactSubjectRef(value, label, state, code = 'TKR_CONTRACT_UNSUPPORTED') {
  const source = exact(value, SUBJECT_REF_KEYS, label, code);
  return Object.fromEntries([...SUBJECT_REF_KEYS].map((field) => [
    field,
    boundedText(source[field], `${label}.${field}`, { code, state })
  ]));
}

function exactRenderedRef(value, label, state) {
  if (value === null) return null;
  const source = exact(value, RENDERED_REF_KEYS, label);
  const digest = boundedText(source.sha256, `${label}.sha256`, {
    pattern: SHA256, maximumBytes: 71, state
  });
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 0) {
    fail(`${label}.bytes must be a non-negative safe integer.`, {
      subject: `${label}.bytes`, received: source.bytes
    });
  }
  return { sha256: digest, bytes: source.bytes };
}

function stringArray(value, label, state, {
  code = 'TKR_CONTRACT_UNSUPPORTED', allowEmpty = true
} = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array of strings.`, {
      subject: label
    }, code);
  }
  if (value.length > MAXIMUM_COLLECTION_ITEMS) {
    limit(label, MAXIMUM_COLLECTION_ITEMS, value.length);
  }
  chargeItems(state, value.length, 'generated renderer collection items');
  const seen = new Set();
  return value.map((entry, index) => {
    const normalized = boundedText(entry, `${label}[${index}]`, { code, state });
    if (seen.has(normalized)) {
      fail(`${label} contains duplicate '${normalized}'.`, {
        subject: label, duplicate: normalized
      }, code);
    }
    seen.add(normalized);
    return normalized;
  });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeAliases(value, state) {
  if (!Array.isArray(value)) {
    fail('Generated renderer aliases must be an array.', { subject: 'aliases' },
      'TKR_ALIAS_INVALID');
  }
  if (value.length > MAXIMUM_ALIASES) limit('generated renderer aliases', MAXIMUM_ALIASES,
    value.length);
  chargeItems(state, value.length, 'generated renderer collection items');
  const ids = new Set();
  const targets = new Set();
  const scopes = new Set();
  const namespaceKinds = new Map();
  const kindNamespaces = new Map();
  const aliases = value.map((entry, index) => {
    const label = `aliases[${index}]`;
    const source = exact(entry, ALIAS_KEYS, label, 'TKR_ALIAS_INVALID');
    const id = boundedText(source.id, `${label}.id`, {
      code: 'TKR_ALIAS_INVALID', pattern: ALIAS_ID, maximumBytes: 128, state
    });
    const matched = ALIAS_ID.exec(id);
    const namespace = boundedText(source.namespace, `${label}.namespace`, {
      code: 'TKR_ALIAS_INVALID', maximumBytes: 64, state
    });
    if (namespace !== matched[1]) {
      fail(`Alias '${id}' does not match namespace '${namespace}'.`, {
        aliasId: id, namespace
      }, 'TKR_ALIAS_INVALID');
    }
    const scopeRef = boundedText(source.scopeRef, `${label}.scopeRef`, {
      code: 'TKR_ALIAS_INVALID', state
    });
    const targetRef = exactSubjectRef(
      source.targetRef, `${label}.targetRef`, state, 'TKR_ALIAS_INVALID'
    );
    const targetKey = stableJson(targetRef);
    if (ids.has(id)) fail(`Alias ID '${id}' is duplicated.`, { aliasId: id },
      'TKR_ALIAS_INVALID');
    if (targets.has(targetKey)) fail(`Alias target '${targetRef.id}' is duplicated.`, {
      aliasId: id, targetRef
    }, 'TKR_ALIAS_INVALID');
    const priorKind = namespaceKinds.get(namespace);
    if (priorKind && priorKind !== targetRef.kind) {
      fail(`Alias namespace '${namespace}' crosses target types.`, {
        namespace, targetKinds: [priorKind, targetRef.kind]
      }, 'TKR_ALIAS_INVALID');
    }
    const priorNamespace = kindNamespaces.get(targetRef.kind);
    if (priorNamespace && priorNamespace !== namespace) {
      fail(`Alias target type '${targetRef.kind}' uses ambiguous namespaces.`, {
        targetKind: targetRef.kind, namespaces: [priorNamespace, namespace]
      }, 'TKR_ALIAS_INVALID');
    }
    ids.add(id);
    targets.add(targetKey);
    scopes.add(scopeRef);
    namespaceKinds.set(namespace, targetRef.kind);
    kindNamespaces.set(targetRef.kind, namespace);
    return { id, namespace, sequence: Number(matched[2]), scopeRef, targetRef };
  });
  if (scopes.size > 1) fail('Alias mapping crosses retained block scopes.', {
    scopeRefs: [...scopes].sort(compareUtf8)
  }, 'TKR_ALIAS_INVALID');
  for (const entry of aliases) {
    if (ids.has(entry.targetRef.id)) fail(
      `Alias '${entry.id}' targets alias ID '${entry.targetRef.id}'.`,
      { aliasId: entry.id, targetAliasId: entry.targetRef.id }, 'TKR_ALIAS_INVALID'
    );
  }
  const expected = [...aliases].sort((left, right) => (
    compareUtf8(left.namespace, right.namespace) || left.sequence - right.sequence
  ));
  if (aliases.some((entry, index) => entry !== expected[index])) {
    fail('Aliases are not in validated namespace/sequence order.', {}, 'TKR_ALIAS_INVALID');
  }
  const groups = new Map();
  for (const entry of aliases) {
    const group = groups.get(entry.namespace) ?? [];
    group.push(entry);
    groups.set(entry.namespace, group);
  }
  for (const [namespace, entries] of groups) {
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index].sequence !== index + 1) fail(
        `Alias namespace '${namespace}' is not a contiguous positive sequence.`,
        { namespace, aliasId: entries[index].id, expectedId: `${namespace}${index + 1}` },
        'TKR_ALIAS_INVALID'
      );
      if (index > 0 && compareUtf8(
        stableJson(entries[index - 1].targetRef),
        stableJson(entries[index].targetRef)
      ) > 0) {
        fail(`Alias namespace '${namespace}' is not ordered by canonical target.`, {
          namespace, aliasId: entries[index].id
        }, 'TKR_ALIAS_INVALID');
      }
    }
  }
  return aliases.map(({ sequence, ...entry }) => entry);
}

function normalizeOmissions(value, state) {
  if (!Array.isArray(value)) {
    fail('Generated renderer omissions must be an array.', { subject: 'omissions' });
  }
  if (value.length > MAXIMUM_OMISSIONS) limit(
    'generated renderer omissions', MAXIMUM_OMISSIONS, value.length
  );
  chargeItems(state, value.length, 'generated renderer collection items');
  const sectionIds = new Set();
  return value.map((entry, index) => {
    const label = `omissions[${index}]`;
    const source = exact(entry, OMISSION_KEYS, label, 'TKR_CONTRACT_UNSUPPORTED',
      OMISSION_REQUIRED_KEYS);
    const sectionId = boundedText(source.sectionId, `${label}.sectionId`, {
      pattern: SECTION_ID, maximumBytes: 64, state
    });
    if (sectionIds.has(sectionId)) fail(`Omission section '${sectionId}' is duplicated.`, {
      sectionId
    }, 'TKR_RENDER_CONFLICT');
    sectionIds.add(sectionId);
    const subjectRef = exactSubjectRef(source.subjectRef, `${label}.subjectRef`, state);
    if (!['budget', 'unavailable'].includes(source.reason)) {
      fail(`${label}.reason must be budget or unavailable.`, {
        subject: `${label}.reason`, received: source.reason
      });
    }
    charge(state, source.reason.length, 'generated renderer working metadata bytes');
    const originalRenderedRef = exactRenderedRef(
      source.originalRenderedRef, `${label}.originalRenderedRef`, state
    );
    const expansionRefs = stringArray(source.expansionRefs, `${label}.expansionRefs`, state, {
      allowEmpty: source.reason === 'unavailable'
    });
    const limitations = stringArray(source.limitations, `${label}.limitations`, state);
    const hasEvidenceRole = Object.hasOwn(source, 'evidenceRole');
    const hasRequirementRef = Object.hasOwn(source, 'requirementRef');
    if (hasEvidenceRole !== hasRequirementRef) {
      fail(`${label} must provide evidenceRole and requirementRef together.`, { subject: label });
    }
    if (hasEvidenceRole) {
      boundedText(source.evidenceRole, `${label}.evidenceRole`, {
        maximumBytes: 128, state
      });
      boundedText(source.requirementRef, `${label}.requirementRef`, { state });
    }
    if (source.reason === 'budget' && originalRenderedRef === null) {
      fail(`${label}.originalRenderedRef is required for a budget omission.`, {
        subject: `${label}.originalRenderedRef`
      });
    }
    if (source.reason === 'unavailable' && originalRenderedRef !== null) {
      fail(`${label}.originalRenderedRef must be null when the representation is unavailable.`, {
        subject: `${label}.originalRenderedRef`
      });
    }
    return {
      sectionId, subjectRef, reason: source.reason, originalRenderedRef,
      expansionRefs, limitations
    };
  });
}

const RENDERER_CORE = {
  kind: 'tkr/generated-renderer-contract',
  version: 1,
  owner: 'sflow-core',
  rendererId: 'worldmodel-prompt-generated.exact-json-v1',
  format: {
    encoding: 'utf-8',
    jsonWhitespace: 'none',
    objectKeyOrder: 'unicode-code-point',
    arrayOrder: 'validated-input-order',
    trailingNewline: false
  },
  generators: [
    {
      id: 'alias-table',
      outputKind: 'tkr/alias-table',
      outputVersion: 1,
      collectionField: 'entries',
      scopeField: 'scopeRef',
      scopeRule: 'first-entry-scope-or-null',
      itemFields: ['id', 'namespace', 'scopeRef', 'targetRef'],
      itemOrder: 'validated-alias-order'
    },
    {
      id: 'omission-notices',
      outputKind: 'tkr/omission-notices',
      outputVersion: 1,
      collectionField: 'omissions',
      scopeField: null,
      scopeRule: 'none',
      itemFields: [
        'sectionId', 'subjectRef', 'reason', 'originalRenderedRef', 'expansionRefs',
        'limitations'
      ],
      itemOrder: 'composer-section-order'
    }
  ]
};

export const TKR_GENERATED_RENDERER_CONTRACT = deepFreeze({
  ...RENDERER_CORE,
  contractSha256: sha256(RENDERER_CORE)
});

export const TKR_GENERATED_RENDERER_REF = [
  `${TKR_GENERATED_RENDERER_CONTRACT.owner}/tkr/renderer/`,
  `${TKR_GENERATED_RENDERER_CONTRACT.rendererId}@${TKR_GENERATED_RENDERER_CONTRACT.version}`,
  `#${TKR_GENERATED_RENDERER_CONTRACT.contractSha256}`
].join('');

/** Validate that a value is byte-for-byte the packaged generated-renderer contract. */
export function validateTkrGeneratedRendererContract(value) {
  exact(value, CONTRACT_KEYS, 'generated renderer contract');
  exact(value.format, FORMAT_KEYS, 'generated renderer contract.format');
  boundedText(value.kind, 'generated renderer contract.kind', { maximumBytes: 128 });
  positiveInteger(value.version, 'generated renderer contract.version');
  boundedText(value.owner, 'generated renderer contract.owner', { maximumBytes: 128 });
  boundedText(value.rendererId, 'generated renderer contract.rendererId', {
    maximumBytes: 256
  });
  boundedText(value.format.encoding, 'generated renderer contract.format.encoding', {
    maximumBytes: 32
  });
  boundedText(value.format.jsonWhitespace,
    'generated renderer contract.format.jsonWhitespace', { maximumBytes: 32 });
  boundedText(value.format.objectKeyOrder,
    'generated renderer contract.format.objectKeyOrder', { maximumBytes: 64 });
  boundedText(value.format.arrayOrder,
    'generated renderer contract.format.arrayOrder', { maximumBytes: 64 });
  if (typeof value.format.trailingNewline !== 'boolean') fail(
    'generated renderer contract.format.trailingNewline must be a boolean.', {
      subject: 'generated renderer contract.format.trailingNewline'
    }
  );
  boundedText(value.contractSha256, 'generated renderer contract.contractSha256', {
    pattern: SHA256, maximumBytes: 71
  });
  if (!Array.isArray(value.generators) || value.generators.length !== 2) fail(
    'generated renderer contract.generators must contain the two packaged algorithms.',
    { subject: 'generated renderer contract.generators' }
  );
  value.generators.forEach((entry, index) => {
    const label = `generated renderer contract.generators[${index}]`;
    exact(entry, GENERATOR_KEYS, label);
    for (const field of ['id', 'outputKind', 'collectionField', 'scopeRule', 'itemOrder']) {
      boundedText(entry[field], `${label}.${field}`, { maximumBytes: 128 });
    }
    positiveInteger(entry.outputVersion, `${label}.outputVersion`);
    if (entry.scopeField !== null) {
      boundedText(entry.scopeField, `${label}.scopeField`, { maximumBytes: 128 });
    }
    if (!Array.isArray(entry.itemFields)) fail(
      `${label}.itemFields must be an array.`, { subject: `${label}.itemFields` }
    );
    if (entry.itemFields.length > 16) limit(`${label}.itemFields`, 16,
      entry.itemFields.length);
    const seen = new Set();
    entry.itemFields.forEach((field, fieldIndex) => {
      const normalized = boundedText(field, `${label}.itemFields[${fieldIndex}]`, {
        maximumBytes: 128
      });
      if (seen.has(normalized)) fail(`${label}.itemFields contains duplicate '${normalized}'.`, {
        subject: `${label}.itemFields`, duplicate: normalized
      });
      seen.add(normalized);
    });
  });
  const receivedCore = withoutFields(value, ['contractSha256']);
  const computed = sha256(receivedCore);
  if (value.contractSha256 !== computed) {
    throw new SingularityFlowError('Generated renderer contract failed its content-integrity check.', {
      code: 'TKR_RENDER_CONFLICT',
      details: { expected: computed, received: value.contractSha256 ?? null }
    });
  }
  if (JSON.stringify(canonicalize(receivedCore)) !== JSON.stringify(canonicalize(RENDERER_CORE))
      || value.contractSha256 !== TKR_GENERATED_RENDERER_CONTRACT.contractSha256) fail(
    'Generated renderer contract is not the exact packaged algorithm and format.',
    { receivedContractSha256: value.contractSha256 }
  );
  return TKR_GENERATED_RENDERER_CONTRACT;
}

function stableJson(value, label = 'generated renderer value') {
  try {
    return JSON.stringify(canonicalize(value));
  } catch (error) {
    fail(`${label} is not canonical JSON: ${error.message}`, {
      subject: label, cause: error.message
    });
  }
}

/** Render one of the two contract-bound generated sections to exact UTF-8 bytes. */
export function renderTkrGeneratedSection(generator, payload = {}, rendererOptions = {}) {
  exact(rendererOptions, RENDER_OPTION_KEYS, 'generated renderer options',
    'TKR_CONTRACT_UNSUPPORTED', new Set());
  const rendererContract = rendererOptions.rendererContract ?? TKR_GENERATED_RENDERER_CONTRACT;
  const rendererRef = rendererOptions.rendererRef ?? TKR_GENERATED_RENDERER_REF;
  validateTkrGeneratedRendererContract(rendererContract);
  boundedText(generator, 'generated renderer generator', { maximumBytes: 64 });
  if (rendererRef !== TKR_GENERATED_RENDERER_REF) fail(
    `Generated section '${generator}' names an unregistered renderer.`,
    { generator, rendererRef, expectedRendererRef: TKR_GENERATED_RENDERER_REF }
  );
  if (!['alias-table', 'omission-notices'].includes(generator)) {
    fail(`Unknown generated section '${generator}'.`, { generator });
  }
  const source = exact(payload, PAYLOAD_KEYS, 'generated renderer payload',
    'TKR_CONTRACT_UNSUPPORTED', new Set());
  const state = { bytes: 0, items: 0 };
  const aliases = normalizeAliases(source.aliases ?? [], state);
  const omissions = normalizeOmissions(source.omissions ?? [], state);
  const normalizedPayloadBytes = Buffer.byteLength(stableJson({ aliases, omissions }), 'utf8');
  if (normalizedPayloadBytes > MAXIMUM_WORKING_METADATA_BYTES) limit(
    'generated renderer working metadata bytes', MAXIMUM_WORKING_METADATA_BYTES,
    normalizedPayloadBytes
  );
  if (generator === 'alias-table') return Buffer.from(stableJson({
    kind: 'tkr/alias-table', version: 1,
    scopeRef: aliases[0]?.scopeRef ?? null,
    entries: aliases.map(({ id, namespace, scopeRef, targetRef }) => ({
      id, namespace, scopeRef, targetRef
    }))
  }, 'generated alias table'), 'utf8');
  if (generator === 'omission-notices') return Buffer.from(stableJson({
    kind: 'tkr/omission-notices', version: 1,
    omissions: omissions.map((entry) => ({
      sectionId: entry.sectionId,
      subjectRef: entry.subjectRef,
      reason: entry.reason,
      originalRenderedRef: entry.originalRenderedRef,
      expansionRefs: entry.expansionRefs,
      limitations: entry.limitations
    }))
  }, 'generated omission notices'), 'utf8');
}

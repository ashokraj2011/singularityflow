import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson, compareText, deepFreeze, sha256 } from '../canonicalize.mjs';
import {
  createWmpGroundingPacket, validateWmpGroundingPacket
} from './contracts.mjs';
import {
  worldModelGroundingPacketPath, worldModelGroundingPacketPayloadPath
} from './paths.mjs';
import {
  PERSISTED_GROUNDING_COMPOSER_CONTRACT,
  replayPersistedGroundingPacketV1
} from './persisted-grounding-owner.mjs';
import {
  parseExactRetainedObject, validateRetainedObjectReference
} from './retained-object.mjs';
import { validateRetainedWorldModelBindingGraph } from './store.mjs';

const DEFAULT_MAXIMUM_BYTES = 32_768;
const SAVED_VIEW_FIELDS = Object.freeze([
  'binding', 'bindingSha256', 'bytes', 'expansionHandle', 'format', 'reference',
  'renderedRef', 'variant', 'viewKey'
]);

function fail(message, code = 'WMP_GROUNDING_PACKET_INVALID', details = {}, cause) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function retained(record, role, family, mediaType = 'application/json') {
  const text = typeof record === 'string' ? record : canonicalJson(record);
  const bytes = Buffer.from(text, 'utf8');
  return deepFreeze({
    ref: { role, family, mediaType, sha256: sha256(bytes), bytes: bytes.length },
    bytes: text,
    record: typeof record === 'string' ? null : record
  });
}

function exactBytes(entry, label) {
  const value = entry?.bytes ?? entry?.canonicalBytes;
  if (!(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    fail(`${label} has no exact retained bytes.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    fail(`${label} is not exact UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED', {}, error);
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail(`${label} is not canonical UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  return { bytes, text };
}

function closureFrom(objects) {
  if (!Array.isArray(objects)) fail('Persisted grounding requires an exact retained closure.');
  const closure = new Map();
  for (const [index, entry] of objects.entries()) {
    const ref = validateRetainedObjectReference(entry?.ref);
    const exact = exactBytes(entry, `Persisted grounding object ${index}`);
    const record = parseExactRetainedObject(ref, exact.bytes);
    const prior = closure.get(ref.sha256);
    if (prior && (canonicalJson(prior.ref) !== canonicalJson(ref)
        || !prior.bytes.equals(exact.bytes))) {
      fail(`Persisted grounding closure contradicts object '${ref.sha256}'.`,
        'WMP_IDENTITY_CONFLICT');
    }
    closure.set(ref.sha256, { ref, bytes: exact.bytes, record });
  }
  return closure;
}

function bindingObject(binding, role, family) {
  return retained(binding, role, family);
}

function requiredClosureObject(closure, ref, label) {
  const object = closure.get(ref.sha256);
  if (!object || canonicalJson(object.ref) !== canonicalJson(ref)) {
    fail(`${label} is absent from the exact retained closure.`, 'WMP_INPUT_MISSING', {
      role: ref.role, sha256: ref.sha256
    });
  }
  return object;
}

function compose(entries) {
  try { return replayPersistedGroundingPacketV1(entries); }
  catch (error) {
    fail(error.message, error.code ?? 'WMP_GROUNDING_REPLAY_MISMATCH', {}, error);
  }
}

function exactOwnFields(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain record.`, 'WMP_GROUNDING_NOT_READY');
  }
  const received = Object.keys(value).sort(compareText);
  if (canonicalJson(received) !== canonicalJson([...expected].sort(compareText))) {
    fail(`${label} has an invalid closed shape.`, 'WMP_GROUNDING_NOT_READY', {
      expected: [...expected].sort(compareText), received
    });
  }
}

function canonicalMarkdownExpansionHandle(bytes, label) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const matches = [...text.matchAll(/^- Expansion: ([^\r\n]+)$/gmu)];
  if (matches.length !== 1) {
    fail(`${label} must contain exactly one governed expansion handle line.`,
      'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH', { matches: matches.length });
  }
  const handle = matches[0][1].replaceAll('&#58;', ':').replaceAll('\\-', '-');
  if (!/^wmp-view:sha256:[a-f0-9]{64}$/u.test(handle)) {
    fail(`${label} contains an invalid governed expansion handle.`,
      'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH');
  }
  return handle;
}

function requireExactViewModelBinding(closure, viewBinding, modelBindingRef, label) {
  const viewInputs = requiredClosureObject(
    closure, viewBinding.viewInputsRef, `${label} View Inputs`
  );
  if (viewInputs.record?.kind !== 'world-model-view-inputs') {
    fail(`${label} has no installed View Inputs owner.`, 'WMP_OBJECT_OWNER_UNAVAILABLE');
  }
  const captures = viewInputs.record.captures.filter(
    (entry) => entry.role === 'model-binding' && entry.status === 'available'
  );
  if (captures.length !== 1
      || canonicalJson(captures[0].objectRef) !== canonicalJson(modelBindingRef)) {
    fail(`${label} was not derived from the selected exact Model Binding.`,
      'WMP_GRAPH_MISMATCH', {
        relation: 'grounding-view.model-binding-capture',
        expected: modelBindingRef,
        received: captures.length === 1 ? captures[0].objectRef : null,
        captures: captures.length
      });
  }
}

function expectedViewReference(binding) {
  return `${binding.inputs.viewId}@${binding.inputs.viewVersion}`;
}

function preflightSavedViewMetadata(savedViews) {
  if (savedViews.modelKey !== savedViews.modelBinding.modelKey) {
    fail('Saved-view materialization model key differs from its retained binding.',
      'WMP_GRAPH_MISMATCH');
  }
  if (!savedViews.views.length || savedViews.views.length > 256
      || !Array.isArray(savedViews.bindings)
      || savedViews.bindings.length !== savedViews.views.length) {
    fail('Saved-view materialization binding roster is incomplete.',
      'WMP_GROUNDING_NOT_READY');
  }
  const roster = new Map();
  for (const [index, binding] of savedViews.bindings.entries()) {
    const digest = binding?.bindingSha256;
    if (typeof digest !== 'string' || roster.has(digest)) {
      fail(`Saved-view materialization binding roster entry ${index} is invalid or repeated.`,
        'WMP_IDENTITY_CONFLICT');
    }
    roster.set(digest, binding);
  }
  savedViews.views.forEach((entry, index) => {
    exactOwnFields(entry, SAVED_VIEW_FIELDS, `Saved-view materialization view ${index}`);
    if (!entry.binding || typeof entry.binding !== 'object' || Array.isArray(entry.binding)) {
      fail(`Saved-view materialization view ${index} has no retained binding.`,
        'WMP_GROUNDING_NOT_READY');
    }
  });
  const viewKeys = savedViews.views.map((entry) => entry?.viewKey);
  if (viewKeys.some((key) => typeof key !== 'string')
      || new Set(viewKeys).size !== viewKeys.length) {
    fail('Saved-view materialization repeats or omits a View Key.',
      'WMP_IDENTITY_CONFLICT');
  }
  return roster;
}

function validateSavedViewMetadata(savedViews, viewBindingObjects, closure, roster) {
  return savedViews.views.map((entry, index) => {
    const binding = entry.binding;
    const bindingObject = viewBindingObjects[index];
    const rosterBinding = roster.get(binding.bindingSha256);
    if (entry.viewKey !== binding.viewKey
        || entry.bindingSha256 !== binding.bindingSha256
        || !rosterBinding
        || canonicalJson(rosterBinding) !== canonicalJson(binding)
        || entry.reference !== expectedViewReference(binding)
        || entry.variant !== binding.inputs.variant
        || entry.format !== binding.inputs.format
        || binding.inputs.modelPayloadSha256 !== savedViews.modelBinding.modelPayloadSha256
        || canonicalJson(binding.rendered) !== canonicalJson(entry.renderedRef)
        || entry.bytes !== entry.renderedRef.bytes
        || entry.bytes !== binding.measurement.bytes) {
      fail(`Saved-view materialization view ${index} differs from its retained binding.`,
        'WMP_GRAPH_MISMATCH', { index, viewKey: entry.viewKey ?? null });
    }
    const rendered = requiredClosureObject(
      closure, binding.rendered, `Saved-view materialization rendered view ${index}`
    );
    const handle = canonicalMarkdownExpansionHandle(
      rendered.bytes, `Saved-view materialization rendered view ${index}`
    );
    if (entry.expansionHandle !== handle) {
      fail(`Saved-view materialization view ${index} expansion handle differs from its exact bytes.`,
        'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH', { index, viewKey: entry.viewKey });
    }
    return { ...entry, bindingObject, expansionHandle: handle };
  });
}

function exactAuthority(value) {
  if (!value || typeof value !== 'object') {
    fail('Persisted Story grounding composition requires one exact state-authority assertion.',
      'WMP_AUTHORITY_CUT_REQUIRED');
  }
  return {
    repositoryDomainSha256: value.repositoryDomainSha256,
    stateRef: value.stateRef ?? value.ref,
    authorityCommit: value.authorityCommit ?? value.commit,
    repositoryIdentitySha256: value.repositoryIdentitySha256 ?? null
  };
}

function exactSubject(value) {
  if (!value || typeof value !== 'object') {
    fail('Persisted Story grounding requires an immutable Story subject.');
  }
  return structuredClone(value);
}

/**
 * Default-off Story packet-composition primitive.
 *
 * `disabled` returns before inspecting any authority/model/view input. `story` accepts only a
 * fully materialized, already admitted saved-view closure and a caller-pinned authority assertion.
 * This function proves deterministic composition and replay; it does not prove that the supplied
 * closure came from the asserted authority cut. A lifecycle owner must re-resolve that cut before
 * automatic Story activation. This primitive never looks up, builds, renders, or publishes a
 * missing model/view, so a caller must surface preparation as a separate action.
 */
export function preparePersistedStoryGrounding(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('Persisted Story grounding options must be a plain object.');
  }
  const activationDescriptor = Object.getOwnPropertyDescriptor(options, 'activation');
  if (activationDescriptor && (!Object.hasOwn(activationDescriptor, 'value')
      || typeof activationDescriptor.get === 'function'
      || typeof activationDescriptor.set === 'function')) {
    fail('Persisted Story grounding activation cannot be an accessor.');
  }
  const selectedActivation = activationDescriptor?.value ?? 'disabled';
  // The default-off path deliberately returns before enumerating or reading any owner, authority,
  // model, or view option. This keeps existing Story start byte-for-byte free of history work.
  if (selectedActivation === 'disabled') {
    return deepFreeze({
      status: 'disabled', activation: 'disabled', files: [],
      execution: {
        modelReads: 0, viewReads: 0, renders: 0, modelCalls: 0, astCalls: 0, writes: 0
      }
    });
  }
  const {
    activation = selectedActivation,
    subject,
    authority,
    savedViews,
    viewKeys,
    maximumBytes = DEFAULT_MAXIMUM_BYTES,
    tokenizer = null,
    workItemRoot = 'singularity/work-items',
    ...unknown
  } = options;
  const unsupported = Object.keys(unknown).sort(compareText);
  if (unsupported.length) {
    fail(`Persisted Story grounding options contain unsupported field(s): ${unsupported.join(', ')}.`,
      'WMP_GROUNDING_PACKET_INVALID', { unsupported });
  }
  if (activation !== 'story') {
    fail("Persisted Story grounding activation must be 'disabled' or 'story'.",
      'WMP_GROUNDING_ACTIVATION_INVALID');
  }
  if (tokenizer !== null) {
    fail('Persisted grounding packet v1 is byte-measured; no exact tokenizer owner is installed.',
      'WMP_TOKENIZER_OWNER_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > 32 * 1024 * 1024) {
    fail('Persisted Story grounding maximumBytes is invalid.', 'WMP_CONTRACT_LIMIT');
  }
  if (savedViews?.status !== 'materialized'
      || savedViews.measurementPolicy !== 'exact-bytes-v1'
      || !savedViews.modelBinding || !savedViews.modelBindingRef
      || typeof savedViews.modelKey !== 'string'
      || !Array.isArray(savedViews.objects) || !Array.isArray(savedViews.views)) {
    fail(
      'Persisted Story grounding is not ready: an owned saved-view materialization is required.',
      'WMP_GROUNDING_NOT_READY', { next: 'materialize-persisted-views' }
    );
  }
  if (!Array.isArray(viewKeys) || !viewKeys.length || viewKeys.length > 256
      || new Set(viewKeys).size !== viewKeys.length) {
    fail('Persisted Story grounding requires 1 through 256 distinct ordered View Keys.',
      'WMP_GROUNDING_ORDER_INVALID');
  }
  const modelBindingObject = bindingObject(
    savedViews.modelBinding, 'model-binding', 'world-model-model-binding'
  );
  if (canonicalJson(modelBindingObject.ref) !== canonicalJson(savedViews.modelBindingRef)) {
    fail('Saved-view materialization model binding reference does not match its exact bytes.',
      'WMP_GRAPH_MISMATCH');
  }
  const bindingRoster = preflightSavedViewMetadata(savedViews);
  const viewBindingObjects = savedViews.views.map((entry) => bindingObject(
    entry.binding, 'view-binding', 'world-model-view-binding'
  ));
  const closure = closureFrom([
    ...savedViews.objects,
    modelBindingObject,
    ...viewBindingObjects
  ]);
  validateRetainedWorldModelBindingGraph(
    'model', savedViews.modelBinding, closure, { currentExtractorAdmission: false }
  );
  const exactStory = exactSubject(subject);
  const exactCut = exactAuthority(authority);
  if (savedViews.modelBinding.inputs.repositoryDomainSha256
      !== exactStory.repositoryDomainSha256
      || savedViews.modelBinding.inputs.repositoryDomainSha256
        !== exactCut.repositoryDomainSha256) {
    fail('Saved-view materialization repository domain differs from the Story authority cut.',
      'WMP_GRAPH_MISMATCH');
  }
  const acceptedViews = validateSavedViewMetadata(
    savedViews, viewBindingObjects, closure, bindingRoster
  );
  const byKey = new Map(acceptedViews.map((entry) => [entry.viewKey, entry]));
  const ordered = viewKeys.map((viewKey, order) => {
    const entry = byKey.get(viewKey);
    if (!entry) {
      fail(`Persisted Story grounding View Key '${viewKey}' is not materialized.`,
        'WMP_VIEW_MISSING', { viewKey, next: 'materialize-persisted-views' });
    }
    if (entry.format !== 'md') {
      fail('Persisted grounding packet v1 consumes Markdown saved views only.',
        'WMP_GROUNDING_PACKET_INVALID');
    }
    requireExactViewModelBinding(
      closure, entry.binding, modelBindingObject.ref,
      `Persisted grounding View Key '${viewKey}'`
    );
    validateRetainedWorldModelBindingGraph(
      'view', entry.binding, closure, { currentExtractorAdmission: false }
    );
    const rendered = requiredClosureObject(
      closure, entry.renderedRef, `Persisted grounding view '${viewKey}'`
    );
    return {
      order,
      viewKey,
      bindingRef: entry.bindingObject.ref,
      variant: entry.variant,
      format: entry.format,
      renderedRef: entry.renderedRef,
      expansionHandle: entry.expansionHandle,
      bytes: rendered.bytes
    };
  });
  const composed = compose(ordered.map((entry) => ({
    order: entry.order,
    renderedSha256: entry.renderedRef.sha256,
    expansionHandle: entry.expansionHandle,
    bytes: entry.bytes
  })));
  if (composed.bytes > maximumBytes) {
    fail('Persisted Story grounding exceeds its exact byte budget.', 'WMP_CONTRACT_LIMIT', {
      measured: composed.bytes, maximum: maximumBytes
    });
  }
  const renderedBlock = retained(
    composed.content, 'rendered-grounding', null, 'text/markdown'
  );
  const packet = createWmpGroundingPacket({
    subject: exactStory,
    model: {
      modelKey: savedViews.modelBinding.modelKey,
      bindingRef: modelBindingObject.ref,
      modelPayloadSha256: savedViews.modelBinding.modelPayloadSha256
    },
    views: ordered.map(({ bytes, ...entry }) => entry),
    composition: PERSISTED_GROUNDING_COMPOSER_CONTRACT,
    renderedBlock: renderedBlock.ref,
    budget: {
      mode: 'bytes', maximum: maximumBytes, measured: composed.bytes, tokenizerSha256: null
    },
    authority: exactCut
  });
  const packetObject = retained(
    packet, 'grounding-packet', 'world-model-grounding-packet'
  );
  const recordPath = worldModelGroundingPacketPath(
    packet.subject.workId, packet.groundingSha256, { workItemRoot }
  );
  const payloadPath = worldModelGroundingPacketPayloadPath(
    packet.subject.workId, packet.groundingSha256, { workItemRoot }
  );
  return deepFreeze({
    status: 'composed', activation: 'story', authorityProven: false, packet,
    packetRef: packetObject.ref, renderedBlock: renderedBlock.ref,
    files: [
      {
        path: recordPath, content: packetObject.bytes,
        bytes: packetObject.ref.bytes, sha256: packetObject.ref.sha256
      },
      {
        path: payloadPath, content: renderedBlock.bytes,
        bytes: renderedBlock.ref.bytes, sha256: renderedBlock.ref.sha256
      }
    ],
    objects: [
      ...savedViews.objects, modelBindingObject, ...viewBindingObjects, renderedBlock
    ],
    execution: { modelReads: 0, viewReads: 0, renders: 0, modelCalls: 0, astCalls: 0, writes: 0 }
  });
}

/** Replay a retained packet from exact original bytes; mutable current state is never consulted. */
export function replayPersistedStoryGrounding({ packet, objects } = {}) {
  let accepted;
  try { accepted = validateWmpGroundingPacket(packet); }
  catch (error) { fail(error.message, error.code ?? 'WMP_GROUNDING_PACKET_INVALID', {}, error); }
  const closure = closureFrom(objects);
  const model = requiredClosureObject(
    closure, accepted.model.bindingRef, 'Persisted grounding model binding'
  );
  if (model.record?.kind !== 'world-model-model-binding') {
    fail('Persisted grounding model binding has no installed semantic owner.',
      'WMP_OBJECT_OWNER_UNAVAILABLE');
  }
  validateRetainedWorldModelBindingGraph(
    'model', model.record, closure, { currentExtractorAdmission: false }
  );
  if (model.record.modelKey !== accepted.model.modelKey
      || model.record.modelPayloadSha256 !== accepted.model.modelPayloadSha256
      || model.record.inputs.repositoryDomainSha256
        !== accepted.subject.repositoryDomainSha256) {
    fail('Persisted grounding packet model identity does not match its retained binding.',
      'WMP_GRAPH_MISMATCH');
  }
  const entries = accepted.views.map((view, index) => {
    const binding = requiredClosureObject(
      closure, view.bindingRef, `Persisted grounding view binding ${index}`
    );
    if (binding.record?.kind !== 'world-model-view-binding') {
      fail(`Persisted grounding view ${index} has no installed binding owner.`,
        'WMP_OBJECT_OWNER_UNAVAILABLE');
    }
    requireExactViewModelBinding(
      closure, binding.record, accepted.model.bindingRef,
      `Persisted grounding view ${index}`
    );
    validateRetainedWorldModelBindingGraph(
      'view', binding.record, closure, { currentExtractorAdmission: false }
    );
    if (binding.record.viewKey !== view.viewKey
        || binding.record.inputs.variant !== view.variant
        || binding.record.inputs.format !== view.format
        || canonicalJson(binding.record.rendered) !== canonicalJson(view.renderedRef)) {
      fail(`Persisted grounding view ${index} differs from its retained binding.`,
        'WMP_GRAPH_MISMATCH');
    }
    const rendered = requiredClosureObject(
      closure, view.renderedRef, `Persisted grounding rendered view ${index}`
    );
    const expansionHandle = canonicalMarkdownExpansionHandle(
      rendered.bytes, `Persisted grounding rendered view ${index}`
    );
    if (view.expansionHandle !== expansionHandle) {
      fail(`Persisted grounding view ${index} expansion handle differs from its exact bytes.`,
        'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH', { index, viewKey: view.viewKey });
    }
    return {
      order: view.order,
      renderedSha256: view.renderedRef.sha256,
      expansionHandle,
      bytes: rendered.bytes
    };
  });
  const replayed = compose(entries);
  const retainedBlock = requiredClosureObject(
    closure, accepted.renderedBlock, 'Persisted grounding rendered packet'
  );
  if (replayed.sha256 !== accepted.renderedBlock.sha256
      || replayed.bytes !== accepted.renderedBlock.bytes
      || !retainedBlock.bytes.equals(Buffer.from(replayed.content, 'utf8'))
      || replayed.bytes !== accepted.budget.measured) {
    fail('Persisted grounding packet cannot replay its exact original bytes.',
      'WMP_GROUNDING_REPLAY_MISMATCH');
  }
  return deepFreeze({
    status: 'replayed', groundingSha256: accepted.groundingSha256,
    content: replayed.content, bytes: replayed.bytes, sha256: replayed.sha256,
    authority: accepted.authority, authorityProven: false, execution: {
      modelReads: 0, viewReads: accepted.views.length, renders: 0,
      modelCalls: 0, astCalls: 0, writes: 0
    }
  });
}

export const createPersistedStoryGroundingPacket = preparePersistedStoryGrounding;

export const PERSISTED_STORY_GROUNDING_POLICY = deepFreeze({
  schemaVersion: currentSchemaVersion('world-model-grounding-packet'),
  activationDefault: 'disabled',
  supportedActivation: ['disabled', 'story'],
  measurement: 'exact-bytes-v1',
  tokenizerSha256: null,
  authorityProof: 'required-from-lifecycle-history-resolution',
  automaticActivation: false
});

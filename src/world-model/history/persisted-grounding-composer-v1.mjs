import { createHash } from 'node:crypto';

// Frozen v1 packet syntax. Changing any byte or validation rule requires a new composer version;
// retained packets keep dispatching to this implementation.
export const PERSISTED_GROUNDING_SEPARATOR_V1 = '\n\n---\n\n';
export const PERSISTED_GROUNDING_COMPOSER_V1_ID = 'persisted-grounding-markdown';
export const PERSISTED_GROUNDING_COMPOSER_V1_VERSION = 1;
export const PERSISTED_GROUNDING_MAXIMUM_VIEWS_V1 = 256;
export const PERSISTED_GROUNDING_MAXIMUM_BYTES_V1 = 32 * 1024 * 1024;

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function invalid(message, code = 'WMP_GROUNDING_PACKET_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactUtf8(value, label) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    invalid(`${label} must be supplied as exact UTF-8 bytes.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    invalid(`${label} is not exact UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    invalid(`${label} is not canonical UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  return { bytes, text };
}

/**
 * Compose the exact Markdown packet consumed by a Story prompt.
 *
 * The caller supplies already admitted rendered-view bytes and their expected expansion handles.
 * V1 contributes no mutable labels, clocks, paths, or runtime prose: exact view order plus the
 * frozen separator fully determine the output.
 */
export function composePersistedGroundingPacketV1(entries) {
  if (!Array.isArray(entries) || !entries.length
      || entries.length > PERSISTED_GROUNDING_MAXIMUM_VIEWS_V1) {
    invalid('Persisted grounding v1 requires 1 through 256 ordered view entries.',
      'WMP_CONTRACT_LIMIT');
  }
  const texts = [];
  const separatorBytes = Buffer.byteLength(PERSISTED_GROUNDING_SEPARATOR_V1, 'utf8');
  let accumulatedBytes = 0;
  for (const [index, entry] of entries.entries()) {
    const expectedKeys = ['bytes', 'expansionHandle', 'order', 'renderedSha256'];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)) {
      invalid(`Persisted grounding view ${index} has an invalid closed input shape.`);
    }
    if (entry.order !== index) {
      invalid(`Persisted grounding view ${index} is out of explicit order.`,
        'WMP_GROUNDING_ORDER_INVALID');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(entry.renderedSha256 ?? '')) {
      invalid(`Persisted grounding view ${index} has no exact rendered digest.`);
    }
    if (!/^wmp-view:sha256:[a-f0-9]{64}$/u.test(entry.expansionHandle ?? '')) {
      invalid(`Persisted grounding view ${index} has no governed expansion handle.`);
    }
    const exact = exactUtf8(entry.bytes, `Persisted grounding view ${index}`);
    if (digest(exact.bytes) !== entry.renderedSha256) {
      invalid(`Persisted grounding view ${index} bytes differ from its exact reference.`,
        'WMP_GROUNDING_REPLAY_MISMATCH');
    }
    const visibleHandle = entry.expansionHandle.replaceAll('-', '\\-');
    if (!exact.text.includes(entry.expansionHandle) && !exact.text.includes(visibleHandle)) {
      invalid(`Persisted grounding view ${index} bytes omit their governed expansion handle.`,
        'WMP_GROUNDING_EXPANSION_HANDLE_MISMATCH');
    }
    const nextBytes = accumulatedBytes
      + (index === 0 ? 0 : separatorBytes)
      + exact.bytes.length;
    if (nextBytes + separatorBytes > PERSISTED_GROUNDING_MAXIMUM_BYTES_V1) {
      invalid('Persisted grounding v1 output exceeds its exact byte boundary.',
        'WMP_CONTRACT_LIMIT');
    }
    accumulatedBytes = nextBytes;
    texts.push(exact.text);
  }
  // The terminal separator is part of frozen v1 framing. Besides making truncation explicit, it
  // keeps a one-view packet object distinct from its rendered-view source object, preserving the
  // retained store's one-digest/one-semantic-reference invariant.
  const content = `${texts.join(PERSISTED_GROUNDING_SEPARATOR_V1)}${PERSISTED_GROUNDING_SEPARATOR_V1}`;
  const bytes = Buffer.from(content, 'utf8');
  if (!bytes.length || bytes.length !== accumulatedBytes + separatorBytes
      || bytes.length > PERSISTED_GROUNDING_MAXIMUM_BYTES_V1) {
    invalid('Persisted grounding v1 output exceeds its exact byte boundary.',
      'WMP_CONTRACT_LIMIT');
  }
  return Object.freeze({
    content,
    bytes: bytes.length,
    sha256: digest(bytes)
  });
}

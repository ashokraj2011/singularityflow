import { createHash } from 'node:crypto';

const CLASSES = new Set([
  'core-governing',
  'core-observational',
  'protocol-selector',
  'extension-observational'
]);
const STATUSES = new Set(['active', 'deprecated']);
const UNKNOWN_READ_POLICIES = new Set([
  'preserve-and-restrict',
  'preserve-opaque',
  'operation-unavailable'
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(`${JSON.stringify(canonical(value))}\n`).digest('hex')}`;
}

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

/**
 * Define one closed symbolic vocabulary and its content-addressed member manifest.
 *
 * Callers receive only immutable symbols, descriptors, values, and manifests. There is deliberately
 * no runtime registration API: adding a first-party member is a reviewed source-code change.
 */
export function defineVocabulary({ id, version, defaultClass, entries } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(id ?? ''))) throw new TypeError('Vocabulary id must be a lower-case symbolic identifier.');
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`Vocabulary '${id}' requires a positive integer version.`);
  if (!CLASSES.has(defaultClass)) throw new TypeError(`Vocabulary '${id}' has invalid default class '${defaultClass}'.`);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new TypeError(`Vocabulary '${id}' requires member entries.`);

  const symbols = {};
  const descriptors = {};
  const values = [];
  for (const symbol of Object.keys(entries).sort()) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(symbol)) throw new TypeError(`Vocabulary '${id}' has invalid symbol '${symbol}'.`);
    const candidate = entries[symbol] ?? {};
    const descriptor = {
      value: String(candidate.value ?? ''),
      class: candidate.class ?? defaultClass,
      since: candidate.since,
      status: candidate.status,
      writeAllowed: candidate.writeAllowed,
      unknownRead: candidate.unknownRead,
      description: String(candidate.description ?? '').trim(),
      ...(candidate.deprecatedSince != null ? { deprecatedSince: candidate.deprecatedSince } : {}),
      ...(candidate.replacement != null ? { replacement: candidate.replacement } : {}),
      ...(candidate.removalPolicy != null ? { removalPolicy: candidate.removalPolicy } : {})
    };
    if (!/^[a-z][a-z0-9-]*$/.test(descriptor.value)) throw new TypeError(`Vocabulary '${id}' symbol '${symbol}' has invalid value '${descriptor.value}'.`);
    if (Object.hasOwn(descriptors, descriptor.value)) throw new TypeError(`Vocabulary '${id}' owns duplicate value '${descriptor.value}'.`);
    if (!CLASSES.has(descriptor.class)) throw new TypeError(`Vocabulary '${id}' member '${descriptor.value}' has invalid class '${descriptor.class}'.`);
    if (!Number.isInteger(descriptor.since) || descriptor.since < 1 || descriptor.since > version) {
      throw new TypeError(`Vocabulary '${id}' member '${descriptor.value}' has invalid since version '${descriptor.since}'.`);
    }
    if (!STATUSES.has(descriptor.status)) throw new TypeError(`Vocabulary '${id}' member '${descriptor.value}' has invalid status '${descriptor.status}'.`);
    if (typeof descriptor.writeAllowed !== 'boolean') throw new TypeError(`Vocabulary '${id}' member '${descriptor.value}' must declare writeAllowed.`);
    if (!UNKNOWN_READ_POLICIES.has(descriptor.unknownRead)) {
      throw new TypeError(`Vocabulary '${id}' member '${descriptor.value}' has invalid unknownRead '${descriptor.unknownRead}'.`);
    }
    if (!descriptor.description) throw new TypeError(`Vocabulary '${id}' member '${descriptor.value}' requires a description.`);
    if (descriptor.status === 'deprecated' && (!Number.isInteger(descriptor.deprecatedSince) || descriptor.deprecatedSince < descriptor.since)) {
      throw new TypeError(`Vocabulary '${id}' deprecated member '${descriptor.value}' requires a valid deprecatedSince version.`);
    }
    if (descriptor.status === 'active' && descriptor.writeAllowed === false) {
      throw new TypeError(`Vocabulary '${id}' active member '${descriptor.value}' cannot disable writes; deprecate it first.`);
    }
    const owned = immutable({ ...descriptor, owner: id });
    symbols[symbol] = owned.value;
    descriptors[owned.value] = owned;
    values.push(owned.value);
  }

  const memberManifest = Object.fromEntries(values.slice().sort().map((value) => {
    const descriptor = descriptors[value];
    return [value, {
      descriptorSha256: digest(descriptor),
      class: descriptor.class,
      since: descriptor.since,
      status: descriptor.status,
      writeAllowed: descriptor.writeAllowed
    }];
  }));
  const manifestContent = { id, version, members: memberManifest };
  const manifest = immutable({ ...manifestContent, sha256: digest(manifestContent) });
  return immutable({
    id,
    version,
    defaultClass,
    symbols,
    values,
    descriptors,
    manifest
  });
}

export function vocabularyDescriptor(vocabulary, member) {
  return vocabulary?.descriptors?.[member] ?? null;
}


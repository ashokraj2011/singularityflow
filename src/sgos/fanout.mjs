import { SingularityFlowError } from '../util.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';

function fail(message, code = 'SGOS_FANOUT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

export function sgosFanoutItemSha256(value) {
  return `sha256:${recordSha256({ kind: 'sgos-fanout-item', value })}`;
}

/**
 * Normalize the installed finite fan-out profile. Items are part of approved Workflow IR, must
 * carry unique stable keys, and are expanded by the deterministic compiler (never by a model).
 */
export function normalizeSgosFanout({ taskId, items, maximumItems, maximumParallel }) {
  if (!Array.isArray(items)) fail(`Fan-out '${taskId}' requires an items array.`);
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 0
      || maximumItems > SGOS_INSTALLED_LIMITS.maximumFanoutItems) {
    fail(`Fan-out '${taskId}' maximumItems is outside the installed bound.`,
      'SGOS_FANOUT_LIMIT', { maximumItems, installed: SGOS_INSTALLED_LIMITS.maximumFanoutItems });
  }
  if (items.length > maximumItems) {
    fail(`Fan-out '${taskId}' contains more items than maximumItems.`,
      'SGOS_FANOUT_LIMIT', { actual: items.length, maximumItems });
  }
  if (!Number.isSafeInteger(maximumParallel) || maximumParallel < 1
      || maximumParallel > SGOS_INSTALLED_LIMITS.maximumFanoutParallel) {
    fail(`Fan-out '${taskId}' maximumParallel is outside the installed bound.`,
      'SGOS_FANOUT_PARALLEL_LIMIT', {
        maximumParallel, installed: SGOS_INSTALLED_LIMITS.maximumFanoutParallel
      });
  }
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.key !== 'string' || !item.key.trim()
        || !Object.hasOwn(item, 'value')) {
      fail(`Fan-out '${taskId}' item ${index} requires { key, value }.`);
    }
    const itemKey = item.key.trim();
    if (itemKey.includes('\0')) fail(`Fan-out '${taskId}' item keys cannot contain NUL.`);
    const value = structuredClone(item.value);
    return { itemKey, value, itemSha256: sgosFanoutItemSha256(value) };
  }).sort((left, right) => compareSgosCodePoints(left.itemKey, right.itemKey));
  if (new Set(normalized.map((item) => item.itemKey)).size !== normalized.length) {
    fail(`Fan-out '${taskId}' item keys must be unique.`);
  }
  const collectionSha256 = `sha256:${recordSha256({
    kind: 'sgos-fanout-collection',
    items: normalized.map(({ itemKey, itemSha256 }) => ({ itemKey, itemSha256 }))
  })}`;
  return Object.freeze({
    taskId,
    maximumItems,
    maximumParallel,
    collectionSha256,
    items: Object.freeze(normalized.map((item) => Object.freeze(item))),
    canonicalBytes: canonicalJson(normalized.map(({ itemKey, itemSha256 }) => ({ itemKey, itemSha256 })))
  });
}

export function sgosFanoutChildTemplateId(parentTaskId, itemKey, itemSha256) {
  return `${parentTaskId}:item:${recordSha256({ parentTaskId, itemKey, itemSha256 }).slice(0, 20)}`;
}

const DYNAMIC_SOURCE = /^\$tasks\.([A-Za-z0-9][A-Za-z0-9._:-]*)\.outputs\.([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const DYNAMIC_ITEM_KEY = /^\$\.([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** Parse the deliberately small installed selector grammar; arbitrary JSONPath is never evaluated. */
export function parseSgosDynamicFanoutSource(value) {
  const match = DYNAMIC_SOURCE.exec(String(value ?? ''));
  if (!match) {
    fail("Dynamic fan-out 'over' must use $tasks.<task-id>.outputs.<name>.",
      'SGOS_DYNAMIC_FANOUT_SELECTOR_INVALID', { selector: value ?? null });
  }
  return Object.freeze({ sourceTaskTemplateId: match[1], outputName: match[2] });
}

export function parseSgosDynamicFanoutItemKey(value) {
  if (value === '$') return Object.freeze({ selector: '$', field: null });
  const match = DYNAMIC_ITEM_KEY.exec(String(value ?? ''));
  if (!match) {
    fail("Dynamic fan-out 'itemKey' must be '$' or one top-level selector such as '$.id'.",
      'SGOS_DYNAMIC_FANOUT_SELECTOR_INVALID', { selector: value ?? null });
  }
  return Object.freeze({ selector: value, field: match[1] });
}

export function normalizeSgosDynamicFanoutDescriptor({
  taskId, over, itemKey, maximumItems, maximumParallel, bodyTaskTemplateId = null
}) {
  const source = parseSgosDynamicFanoutSource(over);
  const key = parseSgosDynamicFanoutItemKey(itemKey);
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 0
      || maximumItems > SGOS_INSTALLED_LIMITS.maximumFanoutItems) {
    fail(`Dynamic fan-out '${taskId}' maximumItems is outside the installed bound.`,
      'SGOS_FANOUT_LIMIT', { maximumItems, installed: SGOS_INSTALLED_LIMITS.maximumFanoutItems });
  }
  if (!Number.isSafeInteger(maximumParallel) || maximumParallel < 1
      || maximumParallel > SGOS_INSTALLED_LIMITS.maximumFanoutParallel) {
    fail(`Dynamic fan-out '${taskId}' maximumParallel is outside the installed bound.`,
      'SGOS_FANOUT_PARALLEL_LIMIT', {
        maximumParallel, installed: SGOS_INSTALLED_LIMITS.maximumFanoutParallel
      });
  }
  return Object.freeze({
    parentTaskId: taskId,
    sourceTaskTemplateId: source.sourceTaskTemplateId,
    outputName: source.outputName,
    itemKeySelector: key.selector,
    bodyTaskTemplateId: bodyTaskTemplateId ?? sgosDynamicFanoutBodyTemplateId(taskId),
    maximumItems,
    maximumParallel
  });
}

export function sgosDynamicFanoutBodyTemplateId(parentTaskId) {
  return `${parentTaskId}:dynamic-body`;
}

export function sgosDynamicFanoutChildInstanceId(
  processId, parentTaskId, itemKey, itemSha256
) {
  return `TSK-${recordSha256({
    processId, parentTaskId, itemKey, itemSha256
  }).slice(0, 24).toUpperCase()}`;
}

function dynamicItemKey(value, selector, index) {
  const parsed = parseSgosDynamicFanoutItemKey(selector);
  const selected = parsed.field == null
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? value[parsed.field] : undefined;
  if (!['string', 'number', 'boolean'].includes(typeof selected)
      || (typeof selected === 'string' && !selected.trim())) {
    fail(`Dynamic fan-out item ${index} has no scalar stable key at '${selector}'.`,
      'SGOS_DYNAMIC_FANOUT_ITEM_KEY_INVALID', { index, selector });
  }
  const itemKey = typeof selected === 'string' ? selected.trim() : String(selected);
  if (itemKey.includes('\0')) fail('Dynamic fan-out item keys cannot contain NUL.');
  return itemKey;
}

/** Normalize runtime data without allowing it to create or modify an executable task shape. */
export function normalizeSgosDynamicFanoutCollection({
  taskId, outputName, itemKeySelector, values, maximumItems
}) {
  if (!Array.isArray(values)) {
    fail(`Dynamic fan-out output '${outputName}' must be an array.`,
      'SGOS_DYNAMIC_FANOUT_COLLECTION_INVALID');
  }
  if (values.length > maximumItems) {
    fail(`Dynamic fan-out '${taskId}' produced more items than maximumItems.`,
      'SGOS_FANOUT_LIMIT', { actual: values.length, maximumItems });
  }
  const items = values.map((value, index) => {
    const cloned = structuredClone(value);
    return {
      itemKey: dynamicItemKey(cloned, itemKeySelector, index),
      itemSha256: sgosFanoutItemSha256(cloned),
      value: cloned
    };
  }).sort((left, right) => compareSgosCodePoints(left.itemKey, right.itemKey));
  if (new Set(items.map((entry) => entry.itemKey)).size !== items.length) {
    fail(`Dynamic fan-out '${taskId}' item keys must be unique.`,
      'SGOS_DYNAMIC_FANOUT_ITEM_KEY_DUPLICATE');
  }
  const collectionSha256 = `sha256:${recordSha256({
    kind: 'sgos-dynamic-fanout-collection', outputName, itemKeySelector,
    items: items.map(({ itemKey, itemSha256 }) => ({ itemKey, itemSha256 }))
  })}`;
  return Object.freeze({
    collectionSha256,
    items: Object.freeze(items.map((entry) => Object.freeze(entry)))
  });
}

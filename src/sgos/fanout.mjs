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

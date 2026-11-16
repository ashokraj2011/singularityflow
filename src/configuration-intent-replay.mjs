/** Recreate configuration intent, not a textual merge of historical YAML layouts. */
import YAML from 'yaml';
import { renderDataPreservingFormatting } from './yaml-formatting.mjs';
import { SingularityFlowError } from './util.mjs';

const ABSENT = Symbol('absent');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => a === b || (a !== ABSENT && b !== ABSENT
  && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)));
const copy = value => value === ABSENT ? ABSENT : structuredClone(value);

/** One side of a clash: `{ value }`, or null where that side has no value. */
const side = value => value === ABSENT ? null : { value: copy(value) };

/**
 * Explicit policy: changed proposal values win; unrelated current values survive.
 *
 * `conflictPolicy: 'reject'` refuses a value both sides changed differently; `'collect'` keeps the
 * current value there and returns the clash with both values, so a person can pick one
 * [SCF:REQ-007]. `choices` maps a clash's JSON pointer to `'proposal'` or `'current'`: the pick a
 * person made, which is part of the approval. A pick decides only its own clash.
 */
export function replayConfigurationIntent(base, proposed, current, { conflictPolicy = 'proposal-wins', choices = null } = {}) {
  if (!['proposal-wins', 'reject', 'collect'].includes(conflictPolicy)) throw new Error('Unknown configuration conflict policy.');
  const replacements = [];
  const clashes = [];
  const decided = [];
  const picked = pointer => (choices instanceof Map ? choices.get(pointer) : choices?.[pointer]) ?? null;
  function replay(before, after, now, pointer) {
    if (equal(before, after)) return copy(now);
    if (equal(now, after)) return copy(now);
    if (object(before) && object(after) && (object(now) || (now === ABSENT && conflictPolicy === 'proposal-wins'))) {
      const target = now === ABSENT ? {} : now;
      const entries = new Map(Object.entries(target));
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const child = `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
        const value = replay(Object.hasOwn(before, key) ? before[key] : ABSENT,
          Object.hasOwn(after, key) ? after[key] : ABSENT,
          Object.hasOwn(target, key) ? target[key] : ABSENT, child);
        if (value === ABSENT) entries.delete(key); else entries.set(key, value);
      }
      return Object.fromEntries(entries);
    }
    if (!equal(before, now)) {
      const at = pointer || '/';
      const pick = picked(at);
      if (pick) decided.push({ pointer: at, pick });
      if (pick === 'current') return copy(now);
      if (pick !== 'proposal') {
        replacements.push(at);
        if (conflictPolicy !== 'proposal-wins') clashes.push({ pointer: at, base: side(before), proposal: side(after), current: side(now) });
        if (conflictPolicy === 'collect') return copy(now);
      }
    }
    return copy(after);
  }
  const value = replay(base, proposed, current, '');
  if (conflictPolicy === 'reject' && replacements.length) {
    throw new SingularityFlowError('The same configuration values changed since this proposal was authored. Pick one of the two values for each of these fields; unrelated settings and the proposal remain preserved.', {
      code: 'CONFIGURATION_ENTITY_CONFLICT', details: { pointers: replacements, clashes }
    });
  }
  return { value, replacements, clashes, decided };
}

/**
 * Each value that differs between `before` and `after`, as `{ pointer, before, after }` with each side
 * `{ value }` or null where it has none: what a person reads before approving [SCF:REQ-008]. Objects
 * are walked key by key; a list, or a whole object only one side has, is one value.
 */
export function configurationFieldChanges(before, after, pointer = '', changes = []) {
  const left = before === undefined ? ABSENT : before;
  const right = after === undefined ? ABSENT : after;
  if (equal(left, right) || (left === ABSENT && right === ABSENT)) return changes;
  if (object(left) && object(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      configurationFieldChanges(Object.hasOwn(left, key) ? left[key] : ABSENT, Object.hasOwn(right, key) ? right[key] : ABSENT,
        `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`, changes);
    }
    return changes;
  }
  changes.push({ pointer: pointer || '/', before: side(left), after: side(right) });
  return changes;
}

/**
 * A file's Git mode, re-applied by the same rule as its values: the side that changed it wins, and
 * `null` means both sides changed it differently. A side without the file has no mode to keep.
 */
export function replayFileMode(baseMode, proposedMode, currentMode) {
  if (baseMode === proposedMode) return currentMode ?? proposedMode;
  if (currentMode == null || currentMode === baseMode || currentMode === proposedMode) return proposedMode;
  return null;
}

/** Formatting-only churn cannot roll current policy back to an older proposal's value. */
export function replayConfigurationYaml(baseText, proposedText, currentText, options = {}) {
  const parse = text => text == null ? {} : YAML.parse(text, { maxAliasCount: 100 });
  const current = parse(currentText);
  const result = replayConfigurationIntent(parse(baseText), parse(proposedText), current, options);
  return { ...result, text: renderDataPreservingFormatting(currentText, result.value, { before: current }) };
}

/** JSON assets remain JSON; YAML syntax must never be silently adopted as valid JSON. */
export function replayConfigurationJson(baseText, proposedText, currentText, options = {}) {
  const parse = text => text == null ? {} : JSON.parse(text);
  const result = replayConfigurationIntent(parse(baseText), parse(proposedText), parse(currentText), options);
  return { ...result, text: `${JSON.stringify(result.value, null, 2)}\n` };
}

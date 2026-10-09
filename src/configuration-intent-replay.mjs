/** Recreate configuration intent, not a textual merge of historical YAML layouts. */
import YAML from 'yaml';
import { renderDataPreservingFormatting } from './yaml-formatting.mjs';

const ABSENT = Symbol('absent');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => a === b || (a !== ABSENT && b !== ABSENT
  && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)));
const copy = value => value === ABSENT ? ABSENT : structuredClone(value);

/** Explicit policy: changed proposal values win; unrelated current values survive. */
export function replayConfigurationIntent(base, proposed, current) {
  const replacements = [];
  function replay(before, after, now, pointer) {
    if (equal(before, after)) return copy(now);
    if (equal(now, after)) return copy(now);
    if (object(before) && object(after) && (object(now) || now === ABSENT)) {
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
    if (!equal(before, now)) replacements.push(pointer || '/');
    return copy(after);
  }
  return { value: replay(base, proposed, current, ''), replacements };
}

/** Formatting-only churn cannot roll current policy back to an older proposal's value. */
export function replayConfigurationYaml(baseText, proposedText, currentText) {
  const parse = text => text == null ? {} : YAML.parse(text, { maxAliasCount: 100 });
  const current = parse(currentText);
  const result = replayConfigurationIntent(parse(baseText), parse(proposedText), current);
  return { ...result, text: renderDataPreservingFormatting(currentText, result.value, { before: current }) };
}

/** JSON assets remain JSON; YAML syntax must never be silently adopted as valid JSON. */
export function replayConfigurationJson(baseText, proposedText, currentText) {
  const parse = text => text == null ? {} : JSON.parse(text);
  const result = replayConfigurationIntent(parse(baseText), parse(proposedText), parse(currentText));
  return { ...result, text: `${JSON.stringify(result.value, null, 2)}\n` };
}

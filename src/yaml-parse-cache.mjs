/**
 * Parse the same configuration text once per process. `[perf]`
 *
 * A Story start spent about 460 ms parsing YAML, most of it the same `workflow.yml` and
 * `portfolio.yml` read again by the asset policy, the definition loader and the portfolio loader.
 * The read-scope memo cannot help there: `start` writes, so it never opens a read scope.
 *
 * The key is the text's SHA-256, so a file rewritten mid-command (bootstrap writes `workflow.yml`
 * and reads it back) is a different key and is parsed afresh. The first result stays private and
 * every caller receives its own structured clone, so a caller that normalizes a definition in
 * place cannot change what the next caller reads. A parse error is never remembered: it throws
 * every time, exactly as `YAML.parse` does.
 *
 * Only `YAML.parse(text)` with default options belongs here.
 */
import { createHash } from 'node:crypto';
import YAML from 'yaml';

const MAXIMUM_ENTRIES = 64;
const MAXIMUM_TEXT_LENGTH = 4 * 1024 * 1024;
const parsed = new Map();

/** `YAML.parse(text)`, answered from an earlier parse of identical text when there was one. */
export function parseYamlText(text) {
  if (typeof text !== 'string' || text.length > MAXIMUM_TEXT_LENGTH) return YAML.parse(text);
  const key = createHash('sha256').update(text).digest('hex');
  if (!parsed.has(key)) {
    const value = YAML.parse(text);
    if (parsed.size >= MAXIMUM_ENTRIES) parsed.clear();
    parsed.set(key, value);
  }
  const value = parsed.get(key);
  return value === null || typeof value !== 'object' ? value : structuredClone(value);
}

/**
 * Knowledge items: typed statements about a repository, each citing the source it came from.
 *
 * The registered-v4 World Model records what exists (a file, an export, an import). A knowledge
 * item records what the code does or means (a rule, a decision, an entry point, a test that
 * exercises a rule) and keeps the exact lines it was read from, with a hash of those lines, so a
 * reader can open the code and a later build can tell whether the item still holds.
 *
 * Levels: L0 inventory, L1 structure, L2 behaviour, L3 domain, L4 system, L5 change.
 * Assurance: `observed` (read from a cited span), `derived` (computed from observed items),
 * `inferred` (model-written and citation-checked), `confirmed` (reviewed by a person).
 */
import { createHash } from 'node:crypto';

/** The shape of a knowledge build. Machine-local and derived, so it is a format number, not a governed schema. */
export const KNOWLEDGE_FORMAT = 1;
export const KNOWLEDGE_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
export const KNOWLEDGE_ASSURANCE = Object.freeze(['observed', 'derived', 'inferred', 'confirmed']);
export const KNOWLEDGE_GRAINS = Object.freeze(['repository', 'area', 'component', 'unit']);
export const KNOWLEDGE_KINDS = Object.freeze([
  'language', 'manifest', 'command', 'area', 'layer', 'entity', 'module-dependency', 'entry-point',
  'decision', 'call', 'sink', 'error-path', 'rule', 'limit', 'message', 'concept', 'journey',
  'test-case', 'test-coverage', 'untested-rule', 'drift', 'requirement', 'requirement-link', 'interface',
  'external-dependency', 'configuration', 'hotspot', 'co-change', 'impact'
]);

const LEVEL_OF_KIND = Object.freeze({
  language: 'L0', manifest: 'L0', command: 'L0',
  area: 'L1', layer: 'L1', entity: 'L1', 'module-dependency': 'L1', 'entry-point': 'L1',
  decision: 'L2', call: 'L2', sink: 'L2', 'error-path': 'L2',
  rule: 'L3', limit: 'L3', message: 'L3', concept: 'L3', journey: 'L3', 'test-case': 'L3',
  'test-coverage': 'L3', 'untested-rule': 'L3', drift: 'L3', requirement: 'L3', 'requirement-link': 'L3',
  interface: 'L4', 'external-dependency': 'L4', configuration: 'L4',
  hotspot: 'L5', 'co-change': 'L5', impact: 'L5'
});

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** The hash a citation stores: the exact cited lines, joined by newlines. */
export function spanSha256(lines, start, end) {
  return `sha256:${sha256(lines.slice(start - 1, end).join('\n'))}`;
}

/** A citation of lines `start..end` (1-based, inclusive) of one file. */
export function citation(file, start, end = start) {
  const first = Math.max(1, Math.min(start, file.lines.length || 1));
  const last = Math.max(first, Math.min(end, file.lines.length || first));
  return Object.freeze({ path: file.path, lines: Object.freeze([first, last]), spanSha256: spanSha256(file.lines, first, last) });
}

/**
 * Build one item. The id depends only on the kind and a stable key, so the same rule keeps its id
 * across builds while its citation hash tells whether its code changed.
 */
export function knowledgeItem({
  kind, key, grain = 'unit', subject = {}, statement = {}, citations = [], relations = [],
  assurance = 'observed', producer, area = null
}) {
  if (!KNOWLEDGE_KINDS.includes(kind)) throw new TypeError(`Unknown knowledge kind '${kind}'.`);
  if (!KNOWLEDGE_GRAINS.includes(grain)) throw new TypeError(`Unknown knowledge grain '${grain}'.`);
  if (!KNOWLEDGE_ASSURANCE.includes(assurance)) throw new TypeError(`Unknown knowledge assurance '${assurance}'.`);
  if (assurance === 'observed' && !citations.length) throw new TypeError(`An observed ${kind} item needs a citation.`);
  return {
    id: `K-${kind}-${sha256(`${kind}\0${key}`).slice(0, 16)}`,
    level: LEVEL_OF_KIND[kind],
    grain,
    kind,
    area,
    subject,
    statement,
    citations,
    relations,
    assurance,
    producer
  };
}

/** Verify every citation against the files it names; returns the invalid ones. */
export function invalidCitations(items, filesByPath) {
  const invalid = [];
  for (const item of items) {
    for (const cited of item.citations) {
      const file = filesByPath.get(cited.path);
      if (!file || spanSha256(file.lines, cited.lines[0], cited.lines[1]) !== cited.spanSha256) {
        invalid.push({ item: item.id, path: cited.path, lines: cited.lines });
      }
    }
  }
  return invalid;
}

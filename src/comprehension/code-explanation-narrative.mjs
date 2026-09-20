/** Optional, citation-checked prose over the deterministic code-explanation projection. */
import { canonicalJson } from '../records.mjs';
import { unwrapProviderLineBreaks } from '../assisted-quality.mjs';
import { SingularityFlowError } from '../util.mjs';

const LENGTH_WORDS = Object.freeze({ brief: 100, standard: 250, long: 500 });
const CORRECTNESS_ASSERTION = /\b(?:proves?|passes?|satisf(?:y|ies|ied)|correct|complete|works?|meets?|verified|valid|secure|production[- ]ready)\b/iu;

function parseJson(output) {
  const text = String(output ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const payload = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(payload); }
  catch {
    try { return JSON.parse(unwrapProviderLineBreaks(payload)); }
    catch {
      throw new SingularityFlowError(
        'Code-explanation narration did not return the requested JSON. The computed explanation remains available.',
        { code: 'XPL_NARRATIVE_INVALID' }
      );
    }
  }
}

function recordText(value, fallback = 'unavailable', maximum = 500) {
  const normalized = String(value ?? fallback)
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const selected = normalized || fallback;
  return selected.length > maximum ? `${selected.slice(0, maximum - 1)}…` : selected;
}

function addCitation(catalog, id, sentence) {
  if (typeof id !== 'string' || !id.trim() || catalog.has(id)) return;
  catalog.set(id, recordText(sentence));
}

/**
 * Build a closed citation-to-sentence catalog from the computed record. The model may select and
 * order IDs, but it never supplies prose that crosses the display boundary.
 */
function citationCatalog(explanation) {
  const catalog = new Map();
  for (const unit of explanation?.whyEachChange ?? []) {
    const id = unit.unitId ?? unit.hunk?.hunkId;
    const path = recordText(unit.location?.pathAfter ?? unit.location?.pathBefore, 'unknown path');
    const operation = recordText(unit.operation, 'changed');
    const reason = recordText(unit.cause?.reason, 'hunk-cause-authority-unavailable');
    addCitation(catalog, id,
      `Change ${recordText(id)} records a ${operation} ${unit.unitKind === 'diff-hunk' ? 'text hunk' : 'opaque unit'} at ${path}; its hunk-level cause is unavailable (${reason}).`);
    for (const symbol of unit.declarations ?? []) {
      addCitation(catalog, symbol.id,
        `Symbol ${recordText(symbol.id)} is a cached ${recordText(symbol.declarationKind, 'symbol')} declaration at ${recordText(symbol.path, 'unknown path')}:${Number(symbol.line) || 0} with ${recordText(symbol.assurance)} assurance; it is a navigation hint only.`);
    }
    for (const reference of unit.cause?.references ?? []) {
      addCitation(catalog, reference.causeId,
        `Reference ${recordText(reference.causeId)} is recorded as a region-level ${recordText(reference.causeKind, 'cause')} link; it is not hunk-bound and does not establish proof.`);
    }
  }
  for (const clause of explanation?.proof?.clauses ?? []) {
    addCitation(catalog, clause.clauseId,
      `Clause ${recordText(clause.clauseId)} has computed proof status ${recordText(clause.status, 'unavailable')}.`);
  }
  return catalog;
}

function proofStatus(explanation, citation) {
  const records = explanation?.proof?.clauses ?? [];
  return records.find((entry) => entry.clauseId === citation)?.status ?? null;
}

export function codeExplanationNarrativeWordLimit(length = 'standard') {
  const value = LENGTH_WORDS[length];
  if (!value) throw new SingularityFlowError(
    `Narrative length '${length}' is invalid. Use brief, standard, or long.`,
    { code: 'XPL_NARRATIVE_LENGTH_INVALID' }
  );
  return value;
}

export function buildCodeExplanationNarrativePrompt(explanation, { length = 'standard' } = {}) {
  const maximumWords = codeExplanationNarrativeWordLimit(length);
  return [
    'Return JSON only with this exact shape: {"sentences":[{"text":"...","citations":["ID"]}]}.',
    `Write at most ${maximumWords} words total. Use only facts present in the supplied computed explanation.`,
    'Every sentence must cite one or more exact IDs present in that explanation.',
    'The kernel discards proposed prose and renders record-owned sentences for the selected citation IDs.',
    'Do not claim correctness, satisfaction, passing, completeness, or caller absence beyond the recorded proof/availability status.',
    'Do not include Markdown, headings, source code, instructions, or fields other than sentences/text/citations.',
    'COMPUTED_EXPLANATION_JSON',
    canonicalJson(explanation)
  ].join('\n');
}

/**
 * Turn typed model output into bounded advisory prose. The model selects and orders exact IDs;
 * every displayed sentence is rendered by the kernel from the computed record. Model-authored
 * prose therefore cannot introduce a fact, terminal control sequence, or assurance upgrade.
 */
export function validateCodeExplanationNarrative(output, explanation, { length = 'standard' } = {}) {
  const maximumWords = codeExplanationNarrativeWordLimit(length);
  const parsed = parseJson(output);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).some((key) => key !== 'sentences')
      || !Array.isArray(parsed.sentences) || parsed.sentences.length > 32) {
    throw new SingularityFlowError(
      'Code-explanation narration returned an unsupported shape. The computed explanation remains available.',
      { code: 'XPL_NARRATIVE_INVALID' }
    );
  }
  const catalog = citationCatalog(explanation);
  const accepted = [];
  let removedUncited = 0;
  let removedInvalid = 0;
  let rewrittenOverclaims = 0;
  let rewrittenToRecords = 0;
  const seen = new Set();
  let words = 0;
  for (const candidate of parsed.sentences) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || Object.keys(candidate).some((key) => !['text', 'citations'].includes(key))) {
      removedInvalid += 1;
      continue;
    }
    const text = String(candidate.text ?? '').trim().replace(/\s+/gu, ' ');
    const citations = [...new Set((Array.isArray(candidate.citations) ? candidate.citations : [])
      .filter((entry) => typeof entry === 'string' && catalog.has(entry)))].sort();
    if (!text || text.length > 1000) { removedInvalid += 1; continue; }
    if (citations.length === 0) { removedUncited += 1; continue; }
    if (CORRECTNESS_ASSERTION.test(text)
        && !citations.some((citation) => proofStatus(explanation, citation) === 'passed-current')) {
      rewrittenOverclaims += 1;
    }
    rewrittenToRecords += 1;
    for (const citation of citations) {
      const safeText = catalog.get(citation);
      const sentenceWords = safeText.split(/\s+/u).filter(Boolean).length;
      if (words + sentenceWords > maximumWords) break;
      const identity = `${safeText}\0${citation}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      words += sentenceWords;
      accepted.push({ text: safeText, citations: [citation] });
    }
    if (words >= maximumWords) break;
  }
  return Object.freeze({
    banner: 'Narrative — advisory, not a record',
    authority: 'none',
    stored: false,
    length,
    maximumWords,
    words,
    sentences: Object.freeze(accepted.map(Object.freeze)),
    text: accepted.map((entry) => `${entry.text}${entry.citations.length ? ` (${entry.citations.join(', ')})` : ''}`).join(' '),
    removedUncited,
    removedInvalid,
    rewrittenOverclaims,
    rewrittenToRecords
  });
}

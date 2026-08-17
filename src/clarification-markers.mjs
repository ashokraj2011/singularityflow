/**
 * Clarification markers. `[SPK:REQ-062]` … `[SPK:REQ-067]`
 *
 * A marker is how a specification says "I would be guessing here" in a way the kernel can act on:
 *
 *     [NEEDS CLARIFICATION: <one question grounded in the current Story evidence>]
 *
 * The value is entirely in what happens next. Under `block`, an unresolved marker stops publication
 * *before any state mutation* `[SPK:REQ-065]` — so the honest admission costs nothing except the
 * answer, which is the behaviour that makes people willing to write one instead of inventing a
 * plausible sentence.
 *
 * The part that is easy to get wrong is resolution. A marker is resolved only when a later
 * generation removes it **and** the answer is on record `[SPK:REQ-067]`. Text disappearing is not
 * an answer: deleting the question is exactly what someone does when they want the gate to stop
 * complaining, and treating that as resolution would turn the whole mechanism into a formality.
 */
import { ignoredRanges, isIgnored } from './specifications.mjs';
import { SingularityFlowError } from './util.mjs';

/** How a phase reacts to an unresolved marker. Pinned separately from the conversational mode. */
export const MARKER_MODES = Object.freeze(['off', 'warn', 'block']);

export const MARKER_LIMITS = Object.freeze({
  maxQuestionChars: 300,
  maxMarkersPerArtifact: 200
});

/**
 * The exact grammar `[SPK:REQ-062]`: a non-empty, single-line question.
 *
 * `[^\]\n]` rather than a lazy `.*?` so a marker cannot swallow a `]` or run past the end of its
 * line — an unterminated marker should read as malformed rather than quietly absorbing the rest of
 * the document.
 */
const MARKER = /\[NEEDS CLARIFICATION:([^\]\n]*)\]/g;

/** An opened marker that never closes on its line, so it can be reported rather than ignored. */
const MALFORMED = /\[NEEDS CLARIFICATION:(?![^\]\n]*\])/g;

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/**
 * A stable identity for a marker, so an answer can be bound to a question rather than to a line.
 *
 * Line numbers move when a paragraph is added above; the question text is what the human actually
 * answered. Normalized whitespace so reflowing the document does not orphan the answer.
 */
export function markerQuestionHash(question) {
  return normalizeQuestion(question);
}

function normalizeQuestion(question) {
  return String(question ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Every marker in a document, plus every malformed opener.
 *
 * Extraction ignores exactly the regions clause extraction ignores `[SPK:REQ-063]` — the same
 * exported function, not a second copy of the rules.
 */
export function extractMarkers(markdown, { limits = MARKER_LIMITS } = {}) {
  if (typeof markdown !== 'string') throw new SingularityFlowError('Specification artifact must be UTF-8 Markdown.');
  const ignored = ignoredRanges(markdown);
  const markers = [];
  const malformed = [];

  MARKER.lastIndex = 0;
  let match;
  while ((match = MARKER.exec(markdown))) {
    if (isIgnored(match.index, ignored)) continue;
    const question = normalizeQuestion(match[1]);
    const entry = {
      question,
      questionHash: markerQuestionHash(question),
      line: lineOf(markdown, match.index),
      raw: match[0]
    };
    // An empty question is a marker in shape only; it asks the reader nothing and cannot be
    // answered, so it is reported as malformed rather than counted as an open question.
    if (!question) malformed.push({ ...entry, reason: 'the question is empty' });
    else if (question.length > limits.maxQuestionChars) {
      malformed.push({ ...entry, reason: `the question is ${question.length} characters; the limit is ${limits.maxQuestionChars}` });
    } else markers.push(entry);
  }

  MALFORMED.lastIndex = 0;
  while ((match = MALFORMED.exec(markdown))) {
    if (isIgnored(match.index, ignored)) continue;
    malformed.push({
      question: null, questionHash: null, line: lineOf(markdown, match.index),
      raw: '[NEEDS CLARIFICATION:', reason: 'the marker is not closed on its line'
    });
  }

  if (markers.length > limits.maxMarkersPerArtifact) {
    throw new SingularityFlowError(`Specification contains ${markers.length} clarification markers; configured maximum is ${limits.maxMarkersPerArtifact}.`);
  }
  const order = (left, right) => left.line - right.line || String(left.question).localeCompare(String(right.question));
  return { markers: markers.sort(order), malformed: malformed.sort(order) };
}

/** Normalize a pinned marker policy. Absent means `off`, because a gate nobody asked for is a trap. */
export function markerPolicy(value) {
  const mode = typeof value === 'string' ? value : value?.mode ?? 'off';
  if (!MARKER_MODES.includes(mode)) {
    throw new SingularityFlowError(`clarification.markers.mode must be one of ${MARKER_MODES.join(', ')}; got '${mode}'.`);
  }
  return { mode };
}

/**
 * Which markers are still open, which were resolved, and which merely disappeared. `[SPK:REQ-067]`
 *
 * The clause is exact and worth following exactly: a marker is resolved only when a later artifact
 * generation **removes it** *and* the answer is on record. Both halves are load-bearing, in opposite
 * directions.
 *
 * Removal alone is not resolution — deleting the question is what someone does to quiet the gate.
 *
 * And an answer alone is not resolution either, which is the easier half to get wrong. Filing the
 * answer while leaving `[NEEDS CLARIFICATION: ...]` in the text publishes an artifact that still
 * *asks the question*, and the artifact is the thing people read. So a marker present in the current
 * text is open regardless of what has been filed against it: the answer has to reach the document.
 */
export function reconcileMarkers({ current = [], previous = [], answers = [] } = {}) {
  const answered = new Set(answers.map((entry) => markerQuestionHash(entry.questionHash ?? entry.question)));
  const currentHashes = new Set(current.map((marker) => marker.questionHash));
  const gone = previous.filter((marker) => !currentHashes.has(marker.questionHash));

  return {
    open: [...current],
    resolved: gone.filter((marker) => answered.has(marker.questionHash)),
    vanished: gone
      .filter((marker) => !answered.has(marker.questionHash))
      .map((marker) => ({ ...marker, reason: 'the marker was removed without a recorded clarification answer' }))
  };
}

/**
 * What a phase should do about the markers it has, given its pinned policy.
 *
 * Returns errors and warnings separately so the caller can apply them the way every other governed
 * check in this product does, rather than inventing a second severity vocabulary.
 */
export function evaluateMarkerPolicy(policy, { open = [], malformed = [], vanished = [] } = {}) {
  const mode = markerPolicy(policy).mode;
  const messages = [
    ...open.map((marker) => `unresolved clarification marker at line ${marker.line}: ${marker.question}`),
    ...malformed.map((marker) => `malformed clarification marker at line ${marker.line}: ${marker.reason}`),
    // A vanished marker is an integrity concern under every mode that is not `off`: it says the
    // document changed in a way the record does not explain.
    ...vanished.map((marker) => `clarification marker removed without an answer: ${marker.question}`)
  ];
  if (mode === 'off' || !messages.length) return { mode, errors: [], warnings: [] };
  return mode === 'block' ? { mode, errors: messages, warnings: [] } : { mode, errors: [], warnings: messages };
}

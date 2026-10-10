/**
 * Anchors: the parts of a statement that let a docs sentence, a code rule and a test be recognised
 * as the same rule. An exact message, a status code, an endpoint, a named constant and a bound
 * ("at most 20", read as `<= 20`) are anchors; so are the nouns a statement is about. Code and docs
 * are read into the same shape so they can be compared directly.
 */

export const HTTP_STATUS = Object.freeze({
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, CONFLICT: 409, GONE: 410, PRECONDITION_FAILED: 412, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_ENTITY: 422, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503
});

const NUMBER_WORDS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20, hundred: 100 });
const NUMBER = '(-?\\d+(?:[.,]\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|hundred)';
// Phrase → the bound it states on the thing being described.
const BOUND_PHRASES = Object.freeze([
  [new RegExp(`\\b(?:at least|no (?:less|fewer) than|minimum(?: of)?|min(?:imum)?\\.?|not below)\\s+${NUMBER}`, 'giu'), '>='],
  [new RegExp(`\\b(?:at most|no more than|not more than|maximum(?: of)?|max(?:imum)?\\.?|up to|not above|not exceed(?:ing)?)\\s+${NUMBER}`, 'giu'), '<='],
  [new RegExp(`\\b(?:more than|over|above|greater than|exceeds?|exceeding|longer than)\\s+${NUMBER}`, 'giu'), '>'],
  [new RegExp(`\\b(?:less than|fewer than|under|below|shorter than)\\s+${NUMBER}`, 'giu'), '<'],
  [new RegExp(`(?:≥|>=)\\s*${NUMBER}`, 'gu'), '>='],
  [new RegExp(`(?:≤|<=)\\s*${NUMBER}`, 'gu'), '<='],
  [new RegExp(`(?<![<>=-])>\\s*${NUMBER}`, 'gu'), '>'],
  [new RegExp(`(?<![<>=-])<\\s*${NUMBER}`, 'gu'), '<']
]);
// A sentence that says what is refused states the opposite of what is allowed.
const NEGATIVE = /\b(?:not (?:accepted|allowed|permitted|valid)|refused|rejected|denied|invalid|fails?|forbidden|cannot|can't|must not|may not|never)\b/iu;
const INVERSE = Object.freeze({ '>': '<=', '>=': '<', '<': '>=', '<=': '>' });
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'can', 'not', 'must', 'should', 'will', 'when', 'then', 'than', 'have', 'has',
  'least', 'most', 'more', 'less', 'only', 'each', 'every', 'any', 'into', 'from', 'its', 'their', 'there', 'which', 'was', 'were', 'been',
  'refuse', 'refuses', 'return', 'returns', 'show', 'shows', 'get', 'set', 'size', 'length', 'value', 'values', 'null', 'true', 'false',
  'new', 'throw', 'exception', 'error', 'http', 'status', 'request', 'response', 'over', 'under', 'above', 'below', 'maximum',
  'minimum', 'accepted', 'allowed', 'needs', 'need', 'required', 'requires', 'invalid', 'valid', 'one', 'two', 'case', 'also'
]);

function numberOf(token) {
  const word = NUMBER_WORDS[String(token).toLowerCase()];
  if (word != null) return word;
  const value = Number(String(token).replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function statusNumber(value) {
  const text = String(value ?? '').trim();
  if (/^[1-5]\d\d$/u.test(text)) return Number(text);
  return HTTP_STATUS[text.toUpperCase().replace(/[\s-]+/gu, '_')] ?? null;
}

export function normalizeMessage(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/gu, ' ').replace(/[.!\s]+$/u, '').trim();
}

export function normalizeEndpoint(method, route) {
  const path = String(route ?? '').replace(/\{[^}]+\}|:[A-Za-z_]\w*|<[^>]+>/gu, '{}').replace(/\/+$/u, '') || '/';
  return `${String(method).toUpperCase()} ${path}`;
}

/**
 * A crude stem, the same on both sides of a comparison: "cancelling", "cancelled" and "cancel" all
 * become "cancel"; "orders" becomes "order"; "entries" becomes "entry".
 */
function stem(word) {
  let value = word.replace(/ies$/u, 'y');
  if (value.length > 5) value = value.replace(/(?:ing|ed)$/u, '');
  value = value.replace(/(?<=[a-z]{3})(?:es|s)$/u, '');
  return value.replace(/([b-df-hj-np-tv-z])\1$/u, '$1');
}

/** The nouns a statement is about: words of three letters or more, camelCase split, simple plurals folded. */
export function subjectWords(text) {
  const split = String(text ?? '').replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/[_.]/gu, ' ').toLowerCase();
  return new Set((split.match(/[a-z][a-z0-9]{2,}/gu) ?? [])
    .filter((word) => !STOPWORDS.has(word))
    .map(stem)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word)));
}

/** Bounds a sentence states, as what is allowed. "Orders under 10.00 are not accepted" is `>= 10`. */
export function textBounds(text) {
  const value = String(text ?? '');
  const negative = NEGATIVE.test(value);
  const bounds = [];
  const taken = [];
  for (const [pattern, op] of BOUND_PHRASES) {
    for (const match of value.matchAll(pattern)) {
      if (taken.some(([start, end]) => match.index < end && match.index + match[0].length > start)) continue;
      const number = numberOf(match[1]);
      if (number == null) continue;
      taken.push([match.index, match.index + match[0].length]);
      bounds.push({ op: negative ? INVERSE[op] : op, value: number });
    }
  }
  return bounds;
}

/** Every anchor a docs statement (or any prose) carries. */
export function textAnchors(text) {
  const value = String(text ?? '');
  const messages = new Set();
  // A message is words a person reads: a quoted key or value in an example ("field", "a.b.c") is not one.
  for (const match of value.matchAll(/["“]([^"”]{3,200})["”]/gu)) if (/\s/u.test(match[1].trim())) messages.add(normalizeMessage(match[1]));
  for (const match of value.matchAll(/(?:^|\s)'([^']{6,200})'(?=[\s.,;:]|$)/gu)) if (/\s/u.test(match[1])) messages.add(normalizeMessage(match[1]));
  const identifiers = new Set();
  for (const match of value.matchAll(/`([^`]+)`/gu)) if (/^[A-Za-z_$][\w$.]*$/u.test(match[1])) identifiers.add(match[1].toLowerCase());
  const constants = new Set(value.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu) ?? []);
  const statuses = new Set();
  const statusContext = /\b(?:HTTP|status|returns?|responds?|response|code|error)\b/iu.test(value) || /^\s*[1-5]\d\d\b/u.test(value);
  if (statusContext) for (const match of value.matchAll(/(?<![\w.])([1-5]\d\d)(?![\w.])/gu)) statuses.add(Number(match[1]));
  for (const [name, code] of Object.entries(HTTP_STATUS)) {
    if (new RegExp(`\\b${name.replace(/_/gu, '[ _-]')}\\b`, 'iu').test(value)) statuses.add(code);
  }
  const endpoints = new Set();
  for (const match of value.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s`'")\],;]*)/gu)) endpoints.add(normalizeEndpoint(match[1], match[2]));
  // Plain numbers, with a percentage also read as a fraction ("5%" is 0.05).
  const numbers = new Set();
  for (const match of value.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?:(\s*%)|(?![\w.]))/gu)) {
    numbers.add(Number(match[1]));
    if (match[2]) numbers.add(Number(match[1]) / 100);
  }
  return { messages, identifiers, constants, statuses, endpoints, numbers, bounds: textBounds(value), words: subjectWords(value), normalized: normalizeMessage(value) };
}

/**
 * Redaction of bound secret values in a child process's output [RUN rule 3].
 *
 * Every bound `secret` value of four or more characters is replaced with `[redacted:NAME]` before
 * output is bounded, stored or printed. Streams are redacted chunk by chunk with a carry of one
 * character less than the longest value, so a value split across two chunks is still found. The
 * secrets live only in the closure of the redactor; nothing here serializes them.
 */
import { StringDecoder } from 'node:string_decoder';

export const MINIMUM_REDACTED_LENGTH = 4;

const XML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' });

/** The forms a value takes in output: as written, JSON-string escaped and XML escaped (reports). */
function encodedForms(value) {
  return [...new Set([value, JSON.stringify(value).slice(1, -1), value.replace(/[&<>"']/gu, (character) => XML_ESCAPES[character])])];
}

/** Longest first, so a value that contains another is replaced whole; short values are not secrets here. */
export function redactionEntries(entries = []) {
  const seen = new Set();
  return entries
    .filter((entry) => typeof entry?.value === 'string' && entry.value.length >= MINIMUM_REDACTED_LENGTH
      && /^[A-Z][A-Z0-9_]*$/u.test(String(entry.name ?? '')))
    .flatMap((entry) => encodedForms(entry.value).map((value) => ({ name: entry.name, value })))
    .sort((left, right) => right.value.length - left.value.length || left.name.localeCompare(right.name))
    .filter((entry) => !seen.has(entry.value) && seen.add(entry.value))
    .map((entry) => Object.freeze({ name: entry.name, value: entry.value }));
}

export function redactText(text, entries) {
  let output = String(text ?? '');
  for (const { name, value } of entries) {
    if (output.includes(value)) output = output.split(value).join(`[redacted:${name}]`);
  }
  return output;
}

/**
 * The longest tail of `text` that could still become a secret once more output arrives. Only that
 * tail is held back, so ordinary log lines are emitted at once and a value split across chunks is
 * never emitted half-way: any incomplete occurrence is a suffix that is a proper prefix of a value.
 */
function heldTail(text, entries) {
  const longest = Math.min(text.length, Math.max(0, ...entries.map((entry) => entry.value.length - 1)));
  for (let size = longest; size > 0; size -= 1) {
    const tail = text.slice(text.length - size);
    if (entries.some((entry) => entry.value.length > size && entry.value.startsWith(tail))) return size;
  }
  return 0;
}

/** A stream redactor: write(chunk) returns the text safe to emit now; end() returns the rest. */
export function createStreamRedactor(entries) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    write(chunk) {
      const redacted = redactText(pending + decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))), entries);
      const cut = redacted.length - heldTail(redacted, entries);
      pending = redacted.slice(cut);
      return redacted.slice(0, cut);
    },
    end() {
      const rest = redactText(pending + decoder.end(), entries);
      pending = '';
      return rest;
    }
  };
}

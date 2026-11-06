/**
 * A short failure message for each failed test case, for `tests summary` [RUN M2; VS Code Testing
 * view]. Read from the retained raw report bytes in the order the attempt keeps its occurrences,
 * with what each adapter already reports:
 *
 * - junit-xml: the `<failure>` or `<error>` element's `message` attribute and the first lines of its
 *   text (usually the stack);
 * - node-tap: the error message the repository's node:test observer writes, on its own line beside its
 *   occurrence record, for each failed case;
 * - jest-json and vitest-json: the assertion's `failureMessages`.
 *
 * Nothing here is part of an attempt: receipts and their occurrences are unchanged, so an older
 * attempt reads with no messages rather than differently. A message is bounded to about 2,000
 * characters, terminal colour codes are removed, and the caller redacts bound secrets before it is
 * shown. Any report that does not read gives no messages at all, never misaligned ones.
 */
import { parseXml } from './code-delivery-tests.mjs';

export const CASE_MESSAGE_LIMIT = 2_000;
const LINES = 12;
const NAMED = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gu, (whole, name) => {
    if (name[0] !== '#') return NAMED[name];
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** One bounded message: colour codes and other control characters (but newlines and tabs) removed. */
export function boundedCaseMessage(value) {
  const text = String(value ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\r\n?/gu, '\n').trim();
  if (!text) return null;
  return text.length > CASE_MESSAGE_LIMIT ? `${text.slice(0, CASE_MESSAGE_LIMIT - 1)}…` : text;
}

function descendants(node, localName, output = []) {
  if (node.localName === localName) output.push(node);
  for (const child of node.children) descendants(child, localName, output);
  return output;
}

/** The text inside one element, from its source: CDATA kept as written, entities decoded, tags dropped. */
function elementText(xml, node) {
  if (node.sourceEnd == null) return '';
  const source = xml.slice(node.sourceStart, node.sourceEnd);
  const open = source.indexOf('>');
  if (open === -1 || source.endsWith('/>')) return '';
  const inner = source.slice(open + 1, source.lastIndexOf('</'));
  return inner.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/u).map((part) => (part.startsWith('<![CDATA[')
    ? part.slice(9, -3) : decodeEntities(part.replace(/<[^>]*>/gu, '')))).join('');
}

function junitMessages(contents) {
  const messages = [];
  for (const content of contents) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
    for (const testcase of descendants(parseXml(xml), 'testcase')) {
      const failure = testcase.children.find((child) => child.localName === 'failure' || child.localName === 'error');
      if (!failure) { messages.push(null); continue; }
      const message = failure.attributes.message == null ? '' : decodeEntities(failure.attributes.message).trim();
      const lines = elementText(xml, failure).split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim());
      const body = lines.filter((line, index) => !(index === 0 && message && line.includes(message))).slice(0, LINES);
      messages.push(boundedCaseMessage([message, ...body].filter(Boolean).join('\n')));
    }
  }
  return messages;
}

function nodeTapMessages(text) {
  const messages = [];
  let held = null;
  let records = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('# sflow-node-messages-v1 ')) held = JSON.parse(line.slice('# sflow-node-messages-v1 '.length)).messages;
    else if (line.startsWith('# sflow-node-observation-v1 ')) {
      const occurrences = JSON.parse(line.slice('# sflow-node-observation-v1 '.length)).occurrences ?? [];
      // A report from before the observer wrote messages, or one that does not align, has none.
      const own = Array.isArray(held) && held.length === occurrences.length ? held : [];
      occurrences.forEach((occurrence, index) => messages.push(occurrence?.outcome === 'failed' ? boundedCaseMessage(own[index]) : null));
      held = null;
      records += 1;
    }
  }
  return records ? messages : null;
}

function javascriptJsonMessages(json) {
  const messages = [];
  for (const suite of json?.testResults ?? []) {
    for (const assertion of suite?.assertionResults ?? []) {
      const failed = String(assertion?.status ?? '').toLowerCase() === 'failed';
      const failures = Array.isArray(assertion?.failureMessages) ? assertion.failureMessages.filter((entry) => typeof entry === 'string') : [];
      messages.push(failed ? boundedCaseMessage(failures.join('\n\n')) : null);
    }
  }
  return messages;
}

const MAX_FAILED_SUITES = 50;

/**
 * The test files of a Vitest or Jest report that failed without a failed test: they did not load, so
 * none of their tests is counted. Each with its name and bounded message; none when the report does
 * not read or the adapter has no such level.
 */
export function failedSuiteMessages(adapter, contents) {
  if (!['jest-json', 'vitest-json'].includes(adapter) || !Array.isArray(contents) || !contents.length) return [];
  try {
    const { testResults } = JSON.parse(Buffer.concat(contents.map((content) => Buffer.from(content))).toString('utf8'));
    return testResults.filter((suite) => String(suite?.status ?? '').toLowerCase() === 'failed'
      && !(suite.assertionResults ?? []).some((assertion) => String(assertion?.status ?? '').toLowerCase() === 'failed'))
      .slice(0, MAX_FAILED_SUITES).map((suite) => ({ name: String(suite.name ?? ''), message: boundedCaseMessage(suite.message) }));
  } catch { return []; }
}

/**
 * The failure message of each occurrence of one command's report, aligned with its occurrences, or
 * null when the adapter gives totals only or the report does not read (or does not align).
 */
export function testCaseMessages(adapter, contents, occurrenceCount) {
  if (!Array.isArray(contents) || !contents.length) return null;
  let messages = null;
  try {
    const buffers = contents.map((content) => Buffer.from(content));
    if (adapter === 'junit-xml') messages = junitMessages(buffers);
    else if (adapter === 'node-tap') messages = nodeTapMessages(Buffer.concat(buffers.flatMap((content, index) => (index ? [Buffer.from('\n'), content] : [content]))).toString('utf8'));
    else if (adapter === 'jest-json' || adapter === 'vitest-json') {
      messages = javascriptJsonMessages(JSON.parse(Buffer.concat(buffers.flatMap((content, index) => (index ? [Buffer.from('\n'), content] : [content]))).toString('utf8')));
    }
  } catch { return null; }
  return messages && messages.length === occurrenceCount ? messages : null;
}

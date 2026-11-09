/** Deterministic report interpretation over explicit byte/hash syntax. No repository, process or provider. */
import {SingularityFlowError} from '../foundation/failures.mjs';
export const TEST_REPORT_BYTE_SYNTAX='sflow-test-report-bytes/v1';
export const TEST_REPORT_LIMITS=Object.freeze({maximumFiles:1000,maximumFileBytes:16*1024*1024,
  maximumTotalBytes:64*1024*1024,maximumOccurrences:100000});
const MAX_RESULT_FILES=TEST_REPORT_LIMITS.maximumFiles,MAX_RESULT_FILE_BYTES=TEST_REPORT_LIMITS.maximumFileBytes,
  MAX_RESULT_TOTAL_BYTES=TEST_REPORT_LIMITS.maximumTotalBytes,MAX_TESTCASE_OCCURRENCES=TEST_REPORT_LIMITS.maximumOccurrences;
const MAX_XML_ELEMENTS = 1_000_000;
const MAX_XML_DEPTH = 128;
const LOCAL_JUNIT_PARSER = Object.freeze({ id: 'sflow-junit-xml-observer', version: 1 });
const LAZY_REPORTS = new Set(['playwright-json', 'mocha-json', 'cargo-json']);
const tally = (outcomes) => ({ discovered: outcomes.length, passed: outcomes.filter((status) => status === 'passed').length,
  failed: outcomes.filter((status) => status === 'failed').length, skipped: outcomes.filter((status) => status === 'skipped').length });
const observed = (name, suitePath, framework, outcome, extra) => ({ suite: null, className: null, name, fullName: [...suitePath, name].join(' '),
  ancestorTitles: suitePath, framework, outcome, ...extra, verdict: 'inconclusive', logicalTestId: null, declarationSha256: null, exact: false,
  identityStatus: 'observed-name-only' });
function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function xmlFailure(message) {
  throw new SingularityFlowError(`Structured XML test result is invalid: ${message}`, {
    code: 'CODE_TEST_RESULT_REQUIRED'
  });
}

function tagEnd(xml, start, fail = xmlFailure) {
  let quote = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  fail('unterminated tag');
}

function parseAttributes(value, fail = xmlFailure) {
  const attributes = Object.create(null);
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? '')) index += 1;
    if (index >= value.length) break;
    const name = value.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) fail('malformed attribute name');
    index += name.length;
    while (/\s/.test(value[index] ?? '')) index += 1;
    if (value[index] !== '=') fail(`attribute '${name}' has no value`);
    index += 1;
    while (/\s/.test(value[index] ?? '')) index += 1;
    const quote = value[index];
    if (quote !== '"' && quote !== "'") fail(`attribute '${name}' is not quoted`);
    const end = value.indexOf(quote, index + 1);
    if (end === -1) fail(`attribute '${name}' is unterminated`);
    if (Object.hasOwn(attributes, name)) fail(`attribute '${name}' is duplicated`);
    attributes[name] = value.slice(index + 1, end);
    index = end + 1;
  }
  return attributes;
}

export function parseXml(xml, fail = xmlFailure) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('DOCTYPE and entity declarations are forbidden');
  let index = 0;
  let elements = 0;
  let root = null;
  const stack = [];
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      if (stack.length || xml.slice(index).trim()) fail('text exists outside the root element');
      break;
    }
    if (!stack.length && xml.slice(index, open).trim()) fail('text exists outside the root element');
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end === -1) fail('unterminated comment');
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end === -1) fail('unterminated processing instruction');
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      if (!stack.length) fail('CDATA exists outside the root element');
      const end = xml.indexOf(']]>', open + 9);
      if (end === -1) fail('unterminated CDATA section');
      index = end + 3;
      continue;
    }
    if (xml.startsWith('</', open)) {
      const end = tagEnd(xml, open + 2, fail);
      const name = xml.slice(open + 2, end).trim();
      const current = stack.pop();
      if (!current || current.name !== name) fail(`closing tag '${name}' does not match the open element`);
      current.sourceEnd = end + 1;
      index = end + 1;
      continue;
    }
    if (xml.startsWith('<!', open)) fail('unsupported declaration');
    const end = tagEnd(xml, open + 1, fail);
    let body = xml.slice(open + 1, end).trim();
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1).trim();
    const name = body.match(/^[A-Za-z_][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) fail('malformed element name');
    const node = { name, localName: name.split(':').at(-1), attributes: parseAttributes(body.slice(name.length), fail), children: [],
      sourceStart: open, sourceEnd: selfClosing ? end + 1 : null };
    if (++elements > MAX_XML_ELEMENTS) fail(`element count exceeds ${MAX_XML_ELEMENTS}`);
    if (stack.length >= MAX_XML_DEPTH) fail(`depth exceeds ${MAX_XML_DEPTH}`);
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) fail('document contains multiple root elements');
    else root = node;
    if (!selfClosing) stack.push(node);
    index = end + 1;
  }
  if (stack.length) fail(`element '${stack.at(-1).name}' is not closed`);
  if (!root) fail('document has no root element');
  return root;
}

function descendants(node, localName, output = []) {
  if (node.localName === localName) output.push(node);
  for (const child of node.children) descendants(child, localName, output);
  return output;
}

function integerAttribute(node, names, { required = false } = {}) {
  const name = names.find((candidate) => Object.hasOwn(node.attributes, candidate));
  if (!name) {
    if (required) xmlFailure(`element '${node.name}' has no '${names[0]}' count`);
    return null;
  }
  if (!/^\d+$/.test(node.attributes[name])) xmlFailure(`attribute '${name}' is not a non-negative integer`);
  return Number(node.attributes[name]);
}

function junitCaseState(node) {
  const failures = node.children.filter((child) => child.localName === 'failure').length;
  const errors = node.children.filter((child) => child.localName === 'error').length;
  const skippedElements = node.children.filter((child) => child.localName === 'skipped').length;
  const flakyElements = node.children.filter((child) => ['flakyFailure', 'flakyError'].includes(child.localName)).length;
  const rerunElements = node.children.filter((child) => ['rerunFailure', 'rerunError'].includes(child.localName)).length;
  if ((flakyElements && (failures || errors || skippedElements)) || (rerunElements && !(failures || errors))) {
    xmlFailure('testcase contains contradictory retry outcomes');
  }
  const disabled = ['disabled', 'notrun', 'notexecuted']
    .includes(String(node.attributes.status ?? '').toLowerCase());
  if (failures + errors > 1 || skippedElements > 1 || ((failures || errors) && (skippedElements || disabled))) {
    xmlFailure('testcase contains contradictory or repeated terminal outcomes');
  }
  return {
    failure: failures === 1,
    error: errors === 1,
    skipped: skippedElements === 1 || disabled,
    disabled,
    flaky: flakyElements > 0
  };
}

function declaredCount(node, names) {
  const present = names.find((candidate) => Object.hasOwn(node.attributes, candidate));
  return present ? { present, value: integerAttribute(node, [present]) } : null;
}

function validateJunitAggregate(node, cases) {
  const states = cases.map(junitCaseState);
  const actual = {
    tests: cases.length,
    failures: states.filter((state) => state.failure).length,
    errors: states.filter((state) => state.error).length,
    skipped: states.filter((state) => state.skipped).length,
    disabled: states.filter((state) => state.disabled).length
  };
  for (const [field, names] of Object.entries({
    tests: ['tests', 'total'], failures: ['failures', 'failed'], errors: ['errors'],
    skipped: ['skipped', 'notExecuted'], disabled: ['disabled']
  })) {
    const declared = declaredCount(node, names);
    if (declared && declared.value !== actual[field]) {
      xmlFailure(`JUnit aggregate '${declared.present}' count differs from testcase outcomes`);
    }
  }
}

function junitCases(node, suiteName = null, output = [], maximumOccurrences = MAX_TESTCASE_OCCURRENCES) {
  const currentSuite = node.localName === 'testsuite'
    ? (node.attributes.name ?? suiteName)
    : suiteName;
  if (node.localName === 'testcase') {
    if (output.length >= maximumOccurrences) {
      xmlFailure(`testcase occurrence count exceeds ${maximumOccurrences}`);
    }
    const state = junitCaseState(node);
    const seconds = Number(node.attributes.time);
    output.push({
      suite: currentSuite ?? null,
      className: node.attributes.classname ?? null,
      name: node.attributes.name ?? null,
      outcome: state.failure || state.error ? 'failed' : state.skipped ? 'skipped' : 'passed',
      ...(state.flaky ? { flaky: true } : {}),
      verdict: 'inconclusive',
      durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
      logicalTestId: null,
      declarationSha256: null,
      exact: false,
      identityStatus: 'observed-name-only'
    });
  }
  for (const child of node.children) junitCases(child, currentSuite, output, maximumOccurrences);
  return output;
}

function classifyDisplayIdentities(occurrences) {
  const displayIdentities = new Map();
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.className, occurrence.name]);
    displayIdentities.set(key, (displayIdentities.get(key) ?? 0) + 1);
  }
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.className, occurrence.name]);
    if (occurrence.className == null || occurrence.name == null) {
      occurrence.identityStatus = 'missing-display-identity';
    } else if (displayIdentities.get(key) > 1) {
      occurrence.identityStatus = 'ambiguous-display-identity';
    }
  }
  return occurrences;
}

function validateJunitStructure(node, insideTestcase = false) {
  const testcase = insideTestcase || node.localName === 'testcase';
  if (!testcase && ['failure', 'error', 'skipped', 'flakyFailure', 'flakyError', 'rerunFailure', 'rerunError'].includes(node.localName)) {
    xmlFailure(`suite-level '${node.localName}' outcome cannot produce a passing observation`);
  }
  for (const child of node.children) validateJunitStructure(child, testcase);
}

function emptySuites(root) {
  const suites = root.localName === 'testsuites' ? descendants(root, 'testsuite') : [];
  return suites.length > 0 && suites.every((suite) => integerAttribute(suite, ['tests', 'total'], { required: true }) === 0
    && [['failures', 'failed'], ['errors'], ['skipped', 'notExecuted'], ['disabled']].every((names) => !integerAttribute(suite, names)));
}

function junitObservation(xml, { maximumOccurrences = MAX_TESTCASE_OCCURRENCES } = {}) {
  const root = parseXml(xml);
  if (!['testsuite', 'testsuites'].includes(root.localName)) xmlFailure(`unrecognized JUnit root '${root.name}'`);
  validateJunitStructure(root);
  const cases = descendants(root, 'testcase');
  if (cases.length) {
    if (cases.length > maximumOccurrences) {
      xmlFailure(`testcase occurrence count exceeds ${maximumOccurrences}`);
    }
    const states = cases.map(junitCaseState);
    const failed = states.filter((state) => state.failure || state.error).length;
    const skipped = states.filter((state) => state.skipped).length;
    const counts = { discovered: cases.length, passed: cases.length - failed - skipped, failed, skipped };
    const aggregateNodes = root.localName === 'testsuite'
      ? [root]
      : [root, ...descendants(root, 'testsuite')];
    for (const aggregate of aggregateNodes) {
      validateJunitAggregate(aggregate, descendants(aggregate, 'testcase'));
    }
    return { tests: counts, occurrences: junitCases(root, null, [], maximumOccurrences) };
  }
  // A root with no count whose suites each declare zero tests: the empty companion SwiftPM writes beside
  // the report that holds its tests, or a pytest run that collected nothing. A suite that declares any
  // test or outcome no test case backs has no such reading and stays refused below.
  if (!['tests', 'total'].some((name) => Object.hasOwn(root.attributes, name)) && emptySuites(root)) {
    return { tests: { discovered: 0, passed: 0, failed: 0, skipped: 0 }, occurrences: [] };
  }
  const discovered = integerAttribute(root, ['tests', 'total'], { required: true });
  const failed = (integerAttribute(root, ['failures', 'failed']) ?? 0) + (integerAttribute(root, ['errors']) ?? 0);
  const declaredSkipped = integerAttribute(root, ['skipped', 'notExecuted']);
  const declaredDisabled = integerAttribute(root, ['disabled']);
  if (declaredSkipped != null && declaredDisabled != null && declaredDisabled > declaredSkipped) {
    xmlFailure('JUnit disabled count exceeds skipped count');
  }
  const skipped = declaredSkipped ?? declaredDisabled ?? 0;
  if (failed + skipped > discovered) xmlFailure('JUnit outcome counts exceed discovered tests');
  return {
    tests: { discovered, passed: discovered - failed - skipped, failed, skipped },
    occurrences: []
  };
}

function trxCounts(xml) {
  const root = parseXml(xml);
  if (root.localName !== 'TestRun') xmlFailure(`unrecognized TRX root '${root.name}'`);
  const counters = descendants(root, 'Counters');
  if (counters.length !== 1) xmlFailure('TRX must contain exactly one Counters element');
  const counter = counters[0];
  const discovered = integerAttribute(counter, ['total'], { required: true });
  const passed = integerAttribute(counter, ['passed']) ?? 0;
  const failed = ['failed', 'error', 'timeout', 'aborted', 'inconclusive', 'notRunnable', 'disconnected', 'warning']
    .reduce((sum, name) => sum + (integerAttribute(counter, [name]) ?? 0), 0);
  const skipped = integerAttribute(counter, ['notExecuted']) ?? 0;
  if (passed + failed + skipped !== discovered) xmlFailure('TRX outcome counts do not equal total tests');
  return { discovered, passed, failed, skipped };
}

function countsFromJson(adapter, parsed) {
  if (adapter === 'sflow-test-result-v1') return {
    discovered: number(parsed.tests?.discovered), passed: number(parsed.tests?.passed),
    failed: number(parsed.tests?.failed), skipped: number(parsed.tests?.skipped)
  };
  if (adapter === 'jest-json' || adapter === 'vitest-json') return {
    discovered: number(parsed.numTotalTests ?? parsed.testResults?.flatMap((suite) => suite.assertionResults ?? []).length),
    passed: number(parsed.numPassedTests), failed: number(parsed.numFailedTests), skipped: number(parsed.numPendingTests)
  };
  if (adapter === 'go-test-json') {
    const events = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    const tests = events.filter((event) => event.Test && ['pass', 'fail', 'skip'].includes(event.Action));
    return {
      discovered: new Set(tests.map((event) => `${event.Package}:${event.Test}`)).size,
      passed: tests.filter((event) => event.Action === 'pass').length,
      failed: tests.filter((event) => event.Action === 'fail').length,
      skipped: tests.filter((event) => event.Action === 'skip').length
    };
  }
  const summary = parsed.summary ?? parsed;
  return {
    discovered: number(summary.discovered ?? summary.total ?? summary.tests),
    passed: number(summary.passed), failed: number(summary.failed ?? summary.failures), skipped: number(summary.skipped)
  };
}

function javascriptJsonObservation(adapter, parsed) {
  const framework = adapter === 'jest-json' ? 'jest' : 'vitest';
  const occurrences = [];
  for (const suite of parsed?.testResults ?? []) {
    if (!Array.isArray(suite?.assertionResults)) {
      throw new SingularityFlowError(`${framework} JSON result contains a malformed assertion list.`, {
        code: 'CODE_TEST_RESULT_REQUIRED'
      });
    }
    for (const assertion of suite.assertionResults) {
      if (occurrences.length >= MAX_TESTCASE_OCCURRENCES) {
        throw new SingularityFlowError(`${framework} JSON result exceeds ${MAX_TESTCASE_OCCURRENCES} testcase occurrences.`, {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
      const name = assertion?.title ?? assertion?.name;
      const fullName = assertion?.fullName ?? null;
      const ancestorTitles = assertion?.ancestorTitles ?? [];
      if (typeof name !== 'string' || !name || (fullName != null && typeof fullName !== 'string')
          || !Array.isArray(ancestorTitles) || ancestorTitles.some((entry) => typeof entry !== 'string')) {
        throw new SingularityFlowError(`${framework} JSON result contains an invalid testcase identity.`, {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
      const state = String(assertion.status ?? '').toLowerCase();
      const outcome = state === 'passed' ? 'passed'
        : state === 'failed' ? 'failed'
          : ['pending', 'skipped', 'todo', 'disabled'].includes(state) ? 'skipped' : null;
      if (!outcome) {
        throw new SingularityFlowError(`${framework} JSON result contains unknown outcome '${state || 'absent'}'.`, {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
      const duration = Number(assertion.duration);
      const retried = (Number.isInteger(assertion.invocations) && assertion.invocations > 1)
        || (Array.isArray(assertion.retryReasons) && assertion.retryReasons.length > 0);
      occurrences.push({
        suite: null, className: null, name, fullName, ancestorTitles: [...ancestorTitles],
        framework, outcome, ...(outcome === 'passed' && retried ? { flaky: true } : {}), verdict: 'inconclusive',
        durationMs: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
        logicalTestId: null, declarationSha256: null, exact: false,
        identityStatus: 'observed-name-only'
      });
    }
  }
  const identities = new Map();
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.fullName, occurrence.name, occurrence.ancestorTitles]);
    identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  for (const occurrence of occurrences) {
    const key = JSON.stringify([occurrence.fullName, occurrence.name, occurrence.ancestorTitles]);
    if (!occurrence.fullName) occurrence.identityStatus = 'missing-display-identity';
    else if (identities.get(key) > 1) occurrence.identityStatus = 'ambiguous-display-identity';
  }
  return {
    occurrences,
    parser: { id: 'sflow-javascript-json-observer', version: 1, framework }
  };
}

export function nodeTapCounts(value) {
  const summaries = [];
  let summary = Object.create(null);
  for (const line of String(value).split(/\r?\n/)) {
    const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const match = plain.match(/^(?:#|ℹ)\s+(tests|pass|fail|cancelled|skipped|todo)\s+([0-9]+)\s*$/u);
    if (!match) continue;
    if (match[1] === 'tests' && Number.isInteger(summary.tests)) {
      summaries.push(summary);
      summary = Object.create(null);
    }
    summary[match[1]] = Number(match[2]);
  }
  if (Object.keys(summary).length) summaries.push(summary);
  if (!summaries.length || summaries.some((entry) =>
    !Number.isInteger(entry.tests) || !Number.isInteger(entry.pass) || !Number.isInteger(entry.fail))) {
    throw new SingularityFlowError('Structured Node test result is missing its final tests, pass, or fail summary.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const counts = summaries.reduce((total, entry) => ({
    discovered: total.discovered + entry.tests,
    passed: total.passed + entry.pass,
    failed: total.failed + entry.fail + (entry.cancelled ?? 0),
    skipped: total.skipped + (entry.skipped ?? 0) + (entry.todo ?? 0)
  }), { discovered: 0, passed: 0, failed: 0, skipped: 0 });
  if (counts.passed + counts.failed + counts.skipped > counts.discovered) {
    throw new SingularityFlowError('Structured Node test outcome counts exceed discovered tests.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  return counts;
}

function karmaTextCounts(value) {
  const summaries = String(value).split(/\r?\n/)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim())
    .map((line) => line.match(/^TOTAL:\s*(.+)$/i)?.[1] ?? null)
    .filter(Boolean);
  if (!summaries.length) {
    throw new SingularityFlowError('Structured Karma test result is missing its final TOTAL summary.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const summary = summaries.at(-1);
  const counts = { discovered: 0, passed: 0, failed: 0, skipped: 0 };
  const parts = [...summary.matchAll(/([0-9]+)\s+(SUCCESS|FAILED|SKIPPED)\b/gi)];
  const residue = summary.replace(/([0-9]+)\s+(SUCCESS|FAILED|SKIPPED)\b/gi, '')
    .replace(/[\s,]+/g, '');
  if (!parts.length || residue) {
    throw new SingularityFlowError('Structured Karma TOTAL summary is malformed.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  for (const part of parts) {
    const count = Number(part[1]);
    const outcome = part[2].toUpperCase();
    if (outcome === 'SUCCESS') counts.passed += count;
    else if (outcome === 'FAILED') counts.failed += count;
    else counts.skipped += count;
  }
  counts.discovered = counts.passed + counts.failed + counts.skipped;
  return counts;
}

function decodeXmlReport(contents, index) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch (error) {
    throw new SingularityFlowError(
      `Structured XML test result ${index + 1} is not valid UTF-8: ${error.message}`,
      { code: 'CODE_TEST_RESULT_REQUIRED', cause: error }
    );
  }
}

function addTestCounts(total, counts) {
  return {
    discovered: total.discovered + counts.discovered,
    passed: total.passed + counts.passed,
    failed: total.failed + counts.failed,
    skipped: total.skipped + counts.skipped
  };
}

export function persistedOccurrences(parsed) {
  const occurrences = parsed?.testcaseObservation?.occurrences ?? [];
  if (occurrences.length > MAX_TESTCASE_OCCURRENCES) {
    throw new SingularityFlowError(`A test report names more than ${MAX_TESTCASE_OCCURRENCES} occurrences.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  return occurrences.map((occurrence) => ({
    ...(Array.isArray(occurrence.ancestorTitles)
      ? { suitePath: [...occurrence.ancestorTitles] }
      : { className: occurrence.className ?? null }),
    name: occurrence.name ?? null,
    ...(occurrence.file ? { file: occurrence.file } : {}),
    ...(Number.isInteger(occurrence.line) ? { line: occurrence.line } : {}),
    ...(occurrence.project ? { project: occurrence.project } : {}),
    ...(occurrence.retries ? { retries: occurrence.retries } : {}),
    outcome: occurrence.outcome,
    ...(occurrence.flaky === true ? { flaky: true } : {}),
    durationMs: occurrence.durationMs ?? null
  }));
}

function consistentTestCounts(tests) {
  const discovered = number(tests?.discovered);
  const passed = number(tests?.passed);
  const failed = number(tests?.failed);
  const skipped = number(tests?.skipped);
  return [discovered, passed, failed, skipped].every(Number.isInteger)
    && [discovered, passed, failed, skipped].every((value) => value >= 0)
    && passed + failed + skipped === discovered;
}

export function testReceiptPassing(receipt, minimumDiscovered = 1, minimumPassed = 1) {
  return receipt?.status === 'passed'
    && receipt.exitCode === 0
    && receipt.timedOut === false
    && receipt.skipped === false
    && receipt.suppressed === false
    && consistentTestCounts(receipt.tests)
    && number(receipt.tests?.discovered) >= minimumDiscovered
    && number(receipt.tests?.passed) >= minimumPassed
    && number(receipt.tests?.failed) === 0;
}

function playwrightObservation(parsed) {
  const occurrences = [];
  const visitSuite = (suite, suitePath, depth = 0) => {
    if (depth > 128) throw new SingularityFlowError('Playwright result suite depth exceeds 128.', { code: 'CODE_TEST_RESULT_REQUIRED' });
    for (const spec of suite?.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const outcome = test.status;
        const execution = test.results?.at(-1)?.status ?? null;
        const state = outcome === 'skipped' || execution === 'skipped' ? 'skipped'
          : outcome === 'unexpected' || ['failed', 'timedOut', 'interrupted'].includes(execution) ? 'failed'
            : outcome === 'flaky' || outcome === 'expected' || execution === 'passed' ? 'passed' : null;
        if (!state) throw new SingularityFlowError(`Playwright result contains unknown outcome '${outcome ?? execution ?? 'absent'}'.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
        const duration = (test.results ?? []).reduce((total, result) => total + (Number(result?.duration) || 0), 0);
        occurrences.push(observed(String(spec.title ?? ''), suitePath, 'playwright', state, {
          ...(state === 'passed' && outcome === 'flaky' ? { flaky: true } : {}), file: spec.file ?? null, line: Number.isInteger(spec.line) ? spec.line : null,
          project: test.projectName || null, retries: Math.max(0, (test.results ?? []).length - 1), durationMs: Math.round(duration) }));
      }
    }
    // The outermost suites are files; the describe path starts below them.
    for (const child of suite?.suites ?? []) visitSuite(child, depth ? [...suitePath, String(child.title ?? '')] : [String(child.title ?? '')], depth + 1);
  };
  for (const suite of parsed.suites ?? []) visitSuite(suite, [], 0);
  const tests = tally(occurrences.map((occurrence) => occurrence.outcome));
  const stats = parsed.stats;
  if (stats && ['expected', 'unexpected', 'flaky', 'skipped'].every((key) => Number.isInteger(stats[key]))
      && (stats.expected + stats.unexpected + stats.flaky + stats.skipped !== tests.discovered || stats.expected + stats.flaky !== tests.passed
        || stats.unexpected !== tests.failed || stats.skipped !== tests.skipped)) {
    throw new SingularityFlowError('Playwright reporter statistics differ from recursively traversed test outcomes.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  return { tests, occurrences };
}

function cargoObservation(text) {
  const occurrences = [];
  const declared = { passed: 0, failed: 0, skipped: 0, suites: 0 };
  for (const line of text.split(/\r?\n/u).filter((entry) => entry.startsWith('{'))) {
    let event;
    try { event = JSON.parse(line); } catch { throw new SingularityFlowError('cargo JSON result has a malformed line.', { code: 'CODE_TEST_RESULT_REQUIRED' }); }
    if (event.type === 'suite' && ['ok', 'failed'].includes(event.event)) {
      declared.suites += 1;
      declared.passed += Number(event.passed) || 0; declared.failed += Number(event.failed) || 0; declared.skipped += Number(event.ignored) || 0;
    } else if (event.type === 'test' && ['ok', 'failed', 'ignored'].includes(event.event)) {
      occurrences.push(observed(String(event.name), [], 'cargo', event.event === 'ok' ? 'passed' : event.event === 'failed' ? 'failed' : 'skipped',
        { durationMs: Number.isFinite(event.exec_time) ? Math.round(event.exec_time * 1000) : null }));
    }
  }
  const tests = tally(occurrences.map((occurrence) => occurrence.outcome));
  if (!declared.suites || ['passed', 'failed', 'skipped'].some((key) => declared[key] !== tests[key])) {
    throw new SingularityFlowError('cargo JSON result has no finished suite, or its suite totals differ from its tests.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  return { tests, occurrences };
}

function mochaObservation(parsed) {
  const occurrences = [];
  for (const [list, outcome] of [['passes', 'passed'], ['failures', 'failed'], ['pending', 'skipped']]) {
    if (!Array.isArray(parsed?.[list])) throw new SingularityFlowError(`mocha JSON result has no ${list} list.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
    for (const test of parsed[list]) {
      const name = String(test?.title ?? '');
      const full = String(test?.fullTitle ?? name);
      occurrences.push(observed(name, full.endsWith(name) && full !== name ? [full.slice(0, -name.length).trim()] : [], 'mocha', outcome,
        { file: typeof test?.file === 'string' ? test.file : null, durationMs: Number.isFinite(test?.duration) ? Math.round(test.duration) : null }));
    }
  }
  return { tests: tally(occurrences.map((occurrence) => occurrence.outcome)), occurrences };
}

export function jsonTestReport(adapter, text) {
  const lines = adapter === 'cargo-json';
  if (lines && !/^\{\s*"type"\s*:\s*"suite"/mu.test(text)) return null;
  const { tests, occurrences } = (lines ? cargoObservation : adapter === 'mocha-json' ? mochaObservation : playwrightObservation)(lines ? text : JSON.parse(text));
  return { tests, testcaseObservation: { occurrences, parser: { id: 'sflow-json-observer', version: 1, framework: adapter.split('-')[0] } } };
}

export function nodeTestObservation(text, counts) {
  const records = String(text).split(/\r?\n/u).filter((line) => line.startsWith('# sflow-node-observation-v1 '));
  // Older TAP reports remain readable as counts, never as an exact test identity.
  if (!records.length) return null;
  const occurrences = records.flatMap((line) => {
    const record = JSON.parse(line.slice('# sflow-node-observation-v1 '.length));
    if (record.complete !== true || !Array.isArray(record.occurrences)) throw new SyntaxError('Node test identities are incomplete.');
    return record.occurrences;
  });
  if (occurrences.length > 100_000) throw new SyntaxError('Node test occurrence limit exceeded.');
  const observed = { passed: 0, failed: 0, skipped: 0 };
  for (const occurrence of occurrences) {
    if (!occurrence || typeof occurrence.file !== 'string' || !occurrence.file
        || /^(?:[\\/]|[a-z]:)/iu.test(occurrence.file)
        || occurrence.file.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')
        || !Number.isInteger(occurrence.line) || occurrence.line < 1
        || typeof occurrence.name !== 'string' || !Array.isArray(occurrence.ancestorTitles)
        || occurrence.ancestorTitles.some((value) => typeof value !== 'string')
        || !Object.hasOwn(observed, occurrence.outcome)) throw new SyntaxError('Invalid Node test identity.');
    observed[occurrence.outcome] += 1;
  }
  if (occurrences.length !== counts.discovered || Object.keys(observed).some((key) => observed[key] !== counts[key])) {
    throw new SyntaxError('Node test identity counts do not match the complete TAP summary.');
  }
  return { framework: 'node:test', occurrences };
}

/** Byte primitives are trusted constructor capabilities, never workflow/model inputs. */
export function createTestReportCodec(syntax) {
  const invalid=()=>{throw new SingularityFlowError('Report parsing requires a frozen explicit byte/hash syntax.',{code:'ENGINE_TEST_REPORT_SYNTAX_INVALID'});};
  if(!syntax||typeof syntax!=='object'||!Object.isFrozen(syntax)||![Object.prototype,null].includes(Object.getPrototypeOf(syntax)))invalid();
  const properties=Object.getOwnPropertyDescriptors(syntax),names=Reflect.ownKeys(properties);
  if(names.length!==5||names.some(name=>!['profile','from','alloc','concat','sha256'].includes(name)))invalid();
  for(const name of names)if(!properties[name].enumerable||!Object.hasOwn(properties[name],'value')
    ||(name==='profile'?properties[name].value!==TEST_REPORT_BYTE_SYNTAX:typeof properties[name].value!=='function'))invalid();
  const invoke=(name,args)=>Reflect.apply(properties[name].value,syntax,args);
  const Buffer=Object.freeze({from(...args){return invoke('from',args);},alloc(...args){return invoke('alloc',args);},concat(...args){return invoke('concat',args);}});
  const sha256=value=>{const result=invoke('sha256',[value]);if(typeof result!=='string'||!/^[a-f0-9]{64}$/u.test(result))invalid();return result;};
  let lazyReports=null;
  async function prepareTestReportReader(adapter) {
    if(LAZY_REPORTS.has(adapter))lazyReports??=await Promise.resolve({jsonTestReport});
  }
function replayLocalJavascriptJsonObservation(rawReports, adapter) {
  if (!['jest-json', 'vitest-json'].includes(adapter)
      || !Array.isArray(rawReports) || rawReports.length !== 1) {
    throw new SingularityFlowError('Local JavaScript replay requires one Jest or Vitest JSON report.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const contents = Buffer.from(rawReports[0]?.contents ?? Buffer.alloc(0));
  if (!contents.length || contents.length > MAX_RESULT_FILE_BYTES) {
    throw new SingularityFlowError('Local JavaScript replay exceeds the configured report byte limits.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
  catch {
    throw new SingularityFlowError('Local JavaScript report is not UTF-8.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    throw new SingularityFlowError('Local JavaScript report is not valid JSON.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const tests = countsFromJson(adapter, parsed);
  const testcaseObservation = javascriptJsonObservation(adapter, parsed);
  const observed = testcaseObservation.occurrences.reduce((total, occurrence) => {
    total[occurrence.outcome] += 1;
    return total;
  }, { passed: 0, failed: 0, skipped: 0 });
  if (testcaseObservation.occurrences.length !== tests.discovered
      || observed.passed !== tests.passed || observed.failed !== tests.failed
      || observed.skipped !== tests.skipped) {
    throw new SingularityFlowError('JavaScript testcase outcomes differ from the reporter aggregate.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  return {
    tests, testcaseObservation,
    result: {
      sha256: sha256(contents), bytes: contents.length,
      files: [{ sha256: sha256(contents), bytes: contents.length }]
    }
  };
}

function replayLocalJunitObservation(rawReports, {
  maximumOccurrences = MAX_TESTCASE_OCCURRENCES
} = {}) {
  if (!Array.isArray(rawReports) || !rawReports.length || rawReports.length > MAX_RESULT_FILES) {
    throw new SingularityFlowError('Local JUnit replay requires a bounded, non-empty raw report set.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  if (!Number.isInteger(maximumOccurrences) || maximumOccurrences < 1
      || maximumOccurrences > MAX_TESTCASE_OCCURRENCES) {
    throw new SingularityFlowError('Local JUnit replay occurrence limit is invalid.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const contents = rawReports.map((report) => Buffer.from(report.contents));
  if (contents.some((content) => content.length > MAX_RESULT_FILE_BYTES)
      || contents.reduce((total, content) => total + content.length, 0) > MAX_RESULT_TOTAL_BYTES) {
    throw new SingularityFlowError('Local JUnit replay exceeds the configured report byte limits.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const digests = contents.map(sha256);
  if (new Set(digests).size !== digests.length) {
    throw new SingularityFlowError('Local JUnit replay contains duplicate report bytes.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  let remainingOccurrences = maximumOccurrences;
  let tests = { discovered: 0, passed: 0, failed: 0, skipped: 0 };
  const occurrences = [];
  for (const [index, content] of contents.entries()) {
    const observation = junitObservation(decodeXmlReport(content, index), {
      maximumOccurrences: remainingOccurrences
    });
    remainingOccurrences -= observation.occurrences.length;
    tests = addTestCounts(tests, observation.tests);
    occurrences.push(...observation.occurrences);
  }
  classifyDisplayIdentities(occurrences);
  const combined = combinedReports(contents);
  return {
    tests,
    testcaseObservation: {
      occurrences,
      parser: structuredClone(LOCAL_JUNIT_PARSER)
    },
    result: {
      sha256: sha256(combined),
      bytes: combined.length,
      files: contents.map((content, index) => ({ sha256: digests[index], bytes: content.length }))
    }
  };
}

function junitCaseLocations(reports) {
  const locations = [];
  for (const [index, content] of reports.entries()) {
    for (const node of descendants(parseXml(decodeXmlReport(Buffer.from(content), index)), 'testcase')) {
      const file = typeof node.attributes.file === 'string' && node.attributes.file ? node.attributes.file : null;
      const line = /^\d+$/u.test(String(node.attributes.line ?? '')) ? Number(node.attributes.line) : null;
      locations.push({ file, line });
    }
  }
  return locations;
}

function parseNativeNodeJunitReport(bytes) {
  const contents = Buffer.from(bytes);
  if (contents.length > MAX_RESULT_FILE_BYTES) xmlFailure('native Node report exceeds its byte bound');
  const xml = decodeXmlReport(contents);
  const observed = junitObservation(xml, { maximumOccurrences: 10_000 });
  const root = parseXml(xml);
  if (root.name !== 'testsuites' || root.children.some(node => node.name !== 'testcase')) {
    xmlFailure('native Node risk evidence requires flat, non-nested test cases');
  }
  const decode = (value) => {
    if (typeof value !== 'string' || value.length > 4096) xmlFailure('native Node identity is missing or too long');
    return value.replace(/&(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);|&[^;\s]*;?/gu, entity => {
      const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (Object.hasOwn(named, entity)) return named[entity];
      if (!/^&#(?:x[0-9a-fA-F]+|\d+);$/u.test(entity)) xmlFailure('native Node identity contains an unknown entity');
      const code = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) xmlFailure('native Node identity contains an invalid character');
      return String.fromCodePoint(code);
    });
  };
  return { tests: observed.tests, cases: root.children.map(node => {
    const outcome = junitCaseState(node);
    const failure = node.children.find(child => ['failure', 'error'].includes(child.localName));
    if (node.attributes.classname !== 'test' || node.children.some(child => !['failure', 'error', 'skipped'].includes(child.name))) {
      xmlFailure('native Node test case has an unsupported shape');
    }
    return { file: node.attributes.file == null ? null : decode(node.attributes.file), name: decode(node.attributes.name),
      outcome: outcome.failure || outcome.error ? 'failed' : outcome.skipped ? 'skipped' : 'passed',
      causeSha256: failure ? `sha256:${sha256(xml.slice(failure.sourceStart, failure.sourceEnd))}` : null };
  }) };
}

function parseTrpJunitReport(bytes) {
  const contents = Buffer.from(bytes);
  if (contents.length > MAX_RESULT_FILE_BYTES) xmlFailure('TRP JUnit report exceeds its byte bound');
  const xml = decodeXmlReport(contents);
  const observed = junitObservation(xml, { maximumOccurrences: 10_000 });
  const root = parseXml(xml);
  if (!['testsuite', 'testsuites'].includes(root.name)) xmlFailure('TRP JUnit requires a testsuite or testsuites root');
  const decode = value => {
    if (typeof value !== 'string' || !value || value.length > 4096) xmlFailure('TRP JUnit identity is absent or oversized');
    return value.replace(/&(?:#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);|&[^;\s]*;?/gu, entity => {
      const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (Object.hasOwn(named, entity)) return named[entity];
      if (!/^&#(?:x[0-9a-fA-F]+|\d+);$/u.test(entity)) xmlFailure('TRP JUnit identity contains an unknown entity');
      const code = entity.startsWith('&#x') ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) xmlFailure('TRP JUnit identity contains an invalid character');
      return String.fromCodePoint(code);
    });
  };
  return { tests: observed.tests, cases: descendants(root, 'testcase').map(node => {
    const outcome = junitCaseState(node);
    if (node.children.some(child => !['failure', 'error', 'skipped', 'system-out', 'system-err', 'properties'].includes(child.name))) {
      xmlFailure('TRP JUnit testcase has unsupported nested content');
    }
    const failure = node.children.find(child => ['failure', 'error'].includes(child.name));
    return { file: node.attributes.file == null ? null : decode(node.attributes.file),
      className: decode(node.attributes.classname), name: decode(node.attributes.name),
      outcome: outcome.failure || outcome.error ? 'failed' : outcome.skipped ? 'skipped' : 'passed',
      causeSha256: failure ? `sha256:${sha256(xml.slice(failure.sourceStart, failure.sourceEnd))}` : null };
  }) };
}

function combinedReports(contents) {
  return Buffer.concat(contents.flatMap((content, index) => index ? [Buffer.from('\n'), content] : [content]));
}

function testReportFromContents(adapter, contents) {
  const bytes = combinedReports(contents);
  if (adapter === 'dotnet-trx') {
    const tests = contents.map(decodeXmlReport).map(trxCounts).reduce((totals, counts) => addTestCounts(totals, counts),
      { discovered: 0, passed: 0, failed: 0, skipped: 0 });
    return { tests, testcaseObservation: null };
  }
  if (adapter === 'junit-xml') {
    const replay = replayLocalJunitObservation(contents.map((content) => ({ contents: content })));
    return { tests: replay.tests, testcaseObservation: replay.testcaseObservation };
  }
  if (adapter === 'node-tap') {
    const text = bytes.toString('utf8');
    const tests = nodeTapCounts(text);
    return { tests, testcaseObservation: nodeTestObservation(text, tests) };
  }
  if (adapter === 'karma-text') return { tests: karmaTextCounts(bytes.toString('utf8')), testcaseObservation: null };
  if (adapter === 'go-test-json') {
    const events = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return { tests: countsFromJson(adapter, events), testcaseObservation: null };
  }
  if (LAZY_REPORTS.has(adapter)) {
    if (!lazyReports) throw new SingularityFlowError(`The ${adapter} reader is not loaded.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
    const report = lazyReports.jsonTestReport(adapter, bytes.toString('utf8'));
    if (report) return report;
  }
  const json = JSON.parse(bytes.toString('utf8'));
  return {
    tests: countsFromJson(adapter, json),
    testcaseObservation: ['jest-json', 'vitest-json'].includes(adapter) ? javascriptJsonObservation(adapter, json) : null
  };
}

function replayTestReports(adapter, rawReports) {
  if (!Array.isArray(rawReports) || !rawReports.length || rawReports.length > MAX_RESULT_FILES) {
    throw new SingularityFlowError('Test report replay requires a bounded, non-empty raw report set.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  const contents = rawReports.map((report) => Buffer.from(report.contents));
  if (contents.some((content) => content.length > MAX_RESULT_FILE_BYTES)
      || contents.reduce((total, content) => total + content.length, 0) > MAX_RESULT_TOTAL_BYTES) {
    throw new SingularityFlowError('Test report replay exceeds the configured report byte limits.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  const bytes = combinedReports(contents);
  return {
    adapter, ...testReportFromContents(adapter, contents),
    result: { sha256: sha256(bytes), bytes: bytes.length, files: contents.map((content) => ({ sha256: sha256(content), bytes: content.length })) }
  };
}
  return Object.freeze({parseXml,nodeTapCounts,replayLocalJavascriptJsonObservation,replayLocalJunitObservation,junitCaseLocations,parseNativeNodeJunitReport,parseTrpJunitReport,replayTestReports,persistedOccurrences,testReceiptPassing,prepareTestReportReader,number,combinedReports,testReportFromContents,consistentTestCounts,nodeTestObservation,jsonTestReport});
}

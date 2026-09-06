import { spec } from 'node:test/reporters';
import { Readable } from 'node:stream';

const MAX_RECORDED_TESTS_PER_OUTCOME = 20;
const TEST_NAME_PATTERN_EXCLUSION = 'test name does not match pattern';

function present(value) {
  return value !== undefined && value !== null && value !== false;
}

function cancelledFailure(event) {
  if (event?.type !== 'test:fail') return false;
  const error = event.data?.details?.error;
  const values = [
    error?.failureType,
    error?.cause?.failureType,
    error?.code,
    error?.cause?.code,
    error?.message,
    error?.cause?.message
  ];
  return values.some((value) => typeof value === 'string' && /cancel(?:led|ed|lation)/i.test(value));
}

function testNamePatterns(argv = process.execArgv) {
  const patterns = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    let source = null;
    if (argument === '--test-name-pattern') source = argv[index += 1];
    else if (argument.startsWith('--test-name-pattern=')) source = argument.slice(argument.indexOf('=') + 1);
    if (source == null) continue;
    try { patterns.push(new RegExp(source)); }
    catch { /* Node rejects an invalid pattern before the reporter can authorize a result. */ }
  }
  return patterns;
}

function testIdentity(event) {
  const data = event?.data ?? {};
  return JSON.stringify([data.file ?? '', data.line ?? 0, data.column ?? 0, data.nesting ?? 0, data.name ?? '']);
}

function normalizeSelectionDiagnostic(event, exclusions) {
  if (event?.type !== 'test:diagnostic' || exclusions === 0) return event;
  const match = String(event.data?.message ?? '').match(/^(tests|skipped) (\d+)$/u);
  if (!match) return event;
  return {
    ...event,
    data: { ...event.data, message: `${match[1]} ${Math.max(0, Number(match[2]) - exclusions)}` }
  };
}

/**
 * Node 20 emits every name-pattern exclusion as a skipped `test:pass`; newer supported Nodes omit
 * those selection events from their summary. A release selection is not a skipped test, but an
 * authored skip with the same text must still fail when its name matches the requested pattern.
 */
export function isTestNamePatternExclusion(event, argv = process.execArgv) {
  if (event?.data?.skip !== TEST_NAME_PATTERN_EXCLUSION) return false;
  const patterns = testNamePatterns(argv);
  if (!patterns.length) return false;
  const name = typeof event.data?.name === 'string' ? event.data.name : '';
  return !patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(name);
  });
}

function record(outcome, event) {
  outcome.count += 1;
  if (outcome.tests.length >= MAX_RECORDED_TESTS_PER_OUTCOME) return;
  const name = typeof event.data?.name === 'string' && event.data.name.trim()
    ? event.data.name.trim()
    : '<unnamed test>';
  const reasonValue = outcome.key === 'skipped' ? event.data?.skip : event.data?.todo;
  const reason = typeof reasonValue === 'string' && reasonValue.trim() ? ` — ${reasonValue.trim()}` : '';
  outcome.tests.push(`${name}${reason}`);
}

function violationSummary(outcomes) {
  const total = outcomes.reduce((sum, outcome) => sum + outcome.count, 0);
  if (total === 0) return null;
  const counts = outcomes.map((outcome) => `${outcome.count} ${outcome.key}`).join(', ');
  const lines = [
    '',
    `Release verification forbids skipped, cancelled, or todo tests (${counts}).`
  ];
  for (const outcome of outcomes) {
    for (const test of outcome.tests) lines.push(`  - ${outcome.key}: ${test}`);
    if (outcome.count > outcome.tests.length) {
      lines.push(`  - ${outcome.key}: ${outcome.count - outcome.tests.length} additional test(s)`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Release-only streaming reporter.
 *
 * It feeds every event into Node's built-in spec reporter, so ordinary test output remains readable,
 * while observing result metadata rather than scraping rendered text. Node treats skipped and todo
 * tests as a successful process by default; release verification cannot. Setting exitCode after the
 * event stream drains turns those outcomes into a genuine process failure without buffering the
 * suite or replacing the normal reporter output. A cancelled test normally already fails Node, but
 * is identified here as well so the release diagnostic names the actual outcome.
 */
export default async function* releaseTestReporter(source) {
  const outcomes = [
    { key: 'skipped', count: 0, tests: [] },
    { key: 'cancelled', count: 0, tests: [] },
    { key: 'todo', count: 0, tests: [] }
  ];
  const [skipped, cancelled, todo] = outcomes;
  const selectedOut = new Set();
  let selectionExclusions = 0;

  async function* inspect() {
    for await (const rawEvent of source) {
      // Normalize the supported Node runtimes before both policy evaluation and presentation.
      // Node 20 emits selected-out tests as synthetic skipped passes; forwarding those events would
      // make a one-test release stage print a misleading nonzero skip count even after the policy
      // correctly recognized that no runnable test was skipped.
      if (isTestNamePatternExclusion(rawEvent)) {
        const identity = testIdentity(rawEvent);
        if (!selectedOut.has(identity)) {
          selectedOut.add(identity);
          selectionExclusions += 1;
        }
        continue;
      }
      if (rawEvent?.type === 'test:start' && selectedOut.has(testIdentity(rawEvent))) continue;
      let event = normalizeSelectionDiagnostic(rawEvent, selectionExclusions);
      if (event?.type === 'test:plan' && event.data?.nesting === 0 && selectionExclusions) {
        event = { ...event, data: { ...event.data, count: Math.max(0, event.data.count - selectionExclusions) } };
      }
      if (event?.type === 'test:pass' || event?.type === 'test:fail') {
        if (present(event.data?.skip)) record(skipped, event);
        if (present(event.data?.todo)) record(todo, event);
      }
      if (cancelledFailure(event)) record(cancelled, event);
      yield event;
    }
  }

  const readableOutput = Readable.from(inspect(), { objectMode: true }).pipe(spec());
  for await (const chunk of readableOutput) yield chunk;

  const summary = violationSummary(outcomes);
  if (summary) {
    yield summary;
    process.exitCode = 1;
  }
}

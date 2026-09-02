import { spec } from 'node:test/reporters';
import { Readable } from 'node:stream';

const MAX_RECORDED_TESTS_PER_OUTCOME = 20;

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

  async function* inspect() {
    for await (const event of source) {
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

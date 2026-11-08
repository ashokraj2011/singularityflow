import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';

const reporterFlag = (token) => token === '--test-reporter' || token.startsWith('--test-reporter=');
const destinationFlag = (token) => token === '--test-reporter-destination' || token.startsWith('--test-reporter-destination=');

/** One run's flag values, `--flag=value` or `--flag value`. */
const flagValues = (tokens, test) => tokens.flatMap((token, index) => (!test(token) ? [] : token.includes('=') ? [token.slice(token.indexOf('=') + 1)] : [tokens[index + 1] ?? '']));
const lcovReportToFile = (tokens) => flagValues(tokens, reporterFlag).every((value) => value === 'lcov')
  && flagValues(tokens, destinationFlag).every((value) => value && !['stdout', 'stderr'].includes(value));

/** A native reporter is required for exact Node identities: ordinary TAP omits passing files. */
export async function nodeTestReporterEnvironment(environment, root, { argv = [], cwd = root } = {}) {
  const env = { ...environment };
  delete env.NODE_TEST_CONTEXT;
  env.SINGULARITY_FLOW_NODE_TEST_ROOT = root;
  const reporter = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'verification', 'node-test-reporter.mjs')).href;
  // Every `node --test` run the command reaches, through its npm run chain and workspaces, not only its outer script.
  const { runs, outer } = await (await import('../test-command-resolution.mjs')).nodeTestRunsAt(argv.map(String), cwd);
  // Each run's reporter and destination flags; a chain this reader cannot follow is read as its outer text, as before.
  const shape = (tokens) => ({ reporters: tokens.filter(reporterFlag).length, destinations: tokens.filter(destinationFlag).length });
  const textShape = (text) => ({ reporters: (text.match(/--test-reporter(?:=|\s)/gu) ?? []).length,
    destinations: (text.match(/--test-reporter-destination(?:=|\s)/gu) ?? []).length });
  const shapes = runs.length ? runs.map(shape) : [textShape(outer.join(' '))];
  const [{ reporters: existing, destinations }] = shapes;
  // A run whose one reporter writes Node's lcov to a file of its own reports no TAP: SFlow's reporter writes it,
  // so the coverage report the command already makes is kept beside it [CQF:REQ-030].
  const lcovToFile = existing === 1 && destinations === 1 && runs.length > 0 && runs.every(lcovReportToFile);
  // NODE_OPTIONS reaches every run, so the runs must agree on how many reporters they install.
  const conflicting = shapes.some((entry) => entry.reporters !== existing || entry.destinations !== destinations);
  if (existing > 1 || destinations > existing || conflicting || /--test-reporter(?:=|\s)/u.test(env.NODE_OPTIONS ?? '')) {
    throw Object.assign(new Error('Exact Node evidence supports one repository TAP reporter. Remove duplicate/ambient reporter flags or use a single node --test command; no test was launched.'), { code: 'NODE_TEST_REPORTER_UNSUPPORTED' });
  }
  // With an explicit TAP reporter, retain its output and add only the identity event record. Node
  // requires one destination per reporter when more than one is installed; both use the captured
  // stream unless the approved command explicitly supplied its own destination.
  env.SINGULARITY_FLOW_NODE_TEST_TAP = existing && !lcovToFile ? '0' : '1';
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --test-reporter=${reporter}${existing
    ? ' --test-reporter-destination=stdout' + (destinations ? '' : ' --test-reporter-destination=stdout') : ''}`.trim();
  return env;
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

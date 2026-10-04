import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';

/** A native reporter is required for exact Node identities: ordinary TAP omits passing files. */
export function nodeTestReporterEnvironment(environment, root, { argv = [], cwd = root } = {}) {
  const env = { ...environment };
  delete env.NODE_TEST_CONTEXT;
  env.SINGULARITY_FLOW_NODE_TEST_ROOT = root;
  const reporter = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'verification', 'node-test-reporter.mjs')).href;
  let options = argv.slice(1).join(' ');
  if (/^(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?$/iu.test(path.basename(argv[0] ?? ''))) {
    const script = argv[1] === 'run' || argv[1] === 'run-script' ? argv[2] : argv[1];
    const manifest = path.join(cwd, 'package.json');
    if (statSync(manifest).size > 1024 * 1024) throw new Error('Node test manifest exceeds the reporter inspection bound.');
    options = String(JSON.parse(readFileSync(manifest, 'utf8')).scripts?.[script] ?? options);
  }
  const existing = (options.match(/--test-reporter(?:=|\s)/gu) ?? []).length;
  const destinations = (options.match(/--test-reporter-destination(?:=|\s)/gu) ?? []).length;
  if (existing > 1 || destinations > existing || /--test-reporter(?:=|\s)/u.test(env.NODE_OPTIONS ?? '')) {
    throw Object.assign(new Error('Exact Node evidence supports one repository TAP reporter. Remove duplicate/ambient reporter flags or use a single node --test command; no test was launched.'), { code: 'NODE_TEST_REPORTER_UNSUPPORTED' });
  }
  // With an explicit TAP reporter, retain its output and add only the identity event record. Node
  // requires one destination per reporter when more than one is installed; both use the captured
  // stream unless the approved command explicitly supplied its own destination.
  env.SINGULARITY_FLOW_NODE_TEST_TAP = existing ? '0' : '1';
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
    if (record.complete !== true || !Array.isArray(record.occurrences)) throw new Error('Node test identities are incomplete.');
    return record.occurrences;
  });
  if (occurrences.length > 100_000) throw new Error('Node test occurrence limit exceeded.');
  const observed = { passed: 0, failed: 0, skipped: 0 };
  for (const occurrence of occurrences) {
    if (!occurrence || typeof occurrence.file !== 'string' || !occurrence.file
        || /^(?:[\\/]|[a-z]:)/iu.test(occurrence.file)
        || occurrence.file.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')
        || !Number.isInteger(occurrence.line) || occurrence.line < 1
        || typeof occurrence.name !== 'string' || !Array.isArray(occurrence.ancestorTitles)
        || occurrence.ancestorTitles.some((value) => typeof value !== 'string')
        || !Object.hasOwn(observed, occurrence.outcome)) throw new Error('Invalid Node test identity.');
    observed[occurrence.outcome] += 1;
  }
  if (occurrences.length !== counts.discovered || Object.keys(observed).some((key) => observed[key] !== counts[key])) {
    throw new Error('Node test identity counts do not match the complete TAP summary.');
  }
  return { framework: 'node:test', occurrences };
}

// A minimal Jest-compatible runner for a governed scratch repository: it runs `test/**/*.test.js`,
// supports describe/test/it with .skip and .todo, and writes Jest's JSON report to --outputFile.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const outputFile = args[args.indexOf('--outputFile') + 1];
const results = new Map();
let suites = [];
const pending = [];
const record = (file, entry) => results.set(file, [...(results.get(file) ?? []), entry]);
let currentFile = null;
const register = (title, fn, status) => pending.push({ file: currentFile, ancestors: [...suites], title, fn, status });
globalThis.describe = (title, fn) => { suites.push(title); fn(); suites.pop(); };
globalThis.test = globalThis.it = Object.assign((title, fn) => register(title, fn, 'run'), {
  skip: (title, fn) => register(title, fn, 'pending'),
  todo: (title) => register(title, null, 'todo')
});
globalThis.expect = (actual) => ({
  toBe(expected) { if (actual !== expected) throw new Error(`expected ${expected}, received ${actual}`); }
});
const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.test.js')) files.push(target);
  }
};
walk(path.resolve('test'));
for (const file of files.sort()) {
  currentFile = file;
  suites = [];
  await import(pathToFileURL(file).href);
}
for (const entry of pending) {
  let status = entry.status;
  if (status === 'run') {
    try { await entry.fn(); status = 'passed'; } catch { status = 'failed'; }
  }
  record(entry.file, {
    ancestorTitles: entry.ancestors, title: entry.title,
    fullName: [...entry.ancestors, entry.title].join(' '), status, duration: 1
  });
}
const all = [...results.values()].flat();
const count = (status) => all.filter((entry) => entry.status === status).length;
const report = {
  numTotalTests: all.length, numPassedTests: count('passed'), numFailedTests: count('failed'),
  numPendingTests: count('pending') + count('todo'), numTodoTests: count('todo'),
  testResults: [...results.entries()].map(([name, assertionResults]) => ({ name, assertionResults }))
};
mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
writeFileSync(outputFile, JSON.stringify(report));
process.exit(count('failed') ? 1 : 0);

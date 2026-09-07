#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const TEST_FILES = Object.freeze([
  'test/comprehension-contracts.test.mjs',
  'test/comprehension-brownfield.test.mjs',
  'test/comprehension-command.test.mjs',
  'test/comprehension-cached-symbols.test.mjs',
  'test/comprehension-diff-preview.test.mjs',
  'test/comprehension-evidence-projection.test.mjs',
  'test/comprehension-gateway.test.mjs',
  'test/comprehension-replay.test.mjs',
  'test/wel-junit5.test.mjs',
  'test/wel-javascript.test.mjs'
]);

function fail(message) {
  process.stderr.write(`CMP/WEL platform matrix preflight failed: ${message}\n`);
  process.exitCode = 1;
}

const java = spawnSync('java', ['--list-modules'], {
  encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024
});
if (java.error?.code === 'ENOENT') {
  fail('Java is not on PATH. Install a supported JDK and retry npm run test:platform:cmp-wel.');
} else if (java.error || java.status !== 0) {
  fail('Java could not be inspected. Install a supported JDK and ensure java --list-modules succeeds.');
} else if (!String(java.stdout).split(/\r?\n/u).some((line) => line.startsWith('jdk.compiler@'))) {
  fail('the active Java runtime does not provide jdk.compiler. Select a full supported JDK and retry.');
} else if (!process.argv.includes('--preflight-only')) {
  const result = spawnSync(process.execPath, [
    '--test', '--test-concurrency=2', ...TEST_FILES
  ], { stdio: 'inherit', windowsHide: true });
  if (result.error) fail(`the Node test runner could not start: ${result.error.message}`);
  else if (result.status !== 0) process.exitCode = result.status ?? 1;
}

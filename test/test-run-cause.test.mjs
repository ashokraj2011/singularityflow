/**
 * What stopped a test run [TCE:REQ-041]: real outputs of the environment failures a step approver may
 * accept, and of the code failures no decision ever covers. A code marker wins over an environment
 * one, and a run in which tests ran is an environment cause only when every failed test is one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTestRunCause, failedTestMessages, testRunCauseCategory, testRunCauseWords } from '../src/test-run-cause.mjs';

const failed = (stderr, extra = {}) => ({ status: 'failed', exitCode: 1, stdout: '', stderr, ...extra });
const classOf = (check, options = {}) => classifyTestRunCause({ check, ...options });

const ENVIRONMENT_OUTPUTS = [
  ['npm ERR! missing module', 'dependency-missing', failed('npm ERR! code ELSPROBLEMS\nnpm ERR! missing: jest@^29.7.0, required by app@1.0.0\n')],
  ['npm script binary not installed', 'dependency-missing', failed('> app@1.0.0 test\n> jest\n\nsh: 1: jest: not found\n', { exitCode: 127 })],
  ['node package not installed', 'dependency-missing', failed("node:internal/modules/run_main:123\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from /work/repo/src/db.mjs\n")],
  ['python package not installed', 'dependency-missing', failed('Traceback (most recent call last):\n  File "/work/repo/tests/conftest.py", line 1, in <module>\n    import psycopg2\nModuleNotFoundError: No module named \'psycopg2\'\n')],
  ['Maven cannot transfer an artifact', 'registry-unreachable', failed('[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project com.example:app:jar:1.0: '
    + 'Failed to collect dependencies at junit:junit:jar:4.13.2: Failed to read artifact descriptor for junit:junit:jar:4.13.2: '
    + 'Could not transfer artifact junit:junit:pom:4.13.2 from/to central (https://repo.maven.apache.org/maven2): Connect to repo.maven.apache.org:443 [repo.maven.apache.org/151.101.0.215] failed: Connection refused\n')],
  ['npm registry behind a proxy', 'registry-unreachable', failed('npm ERR! code ECONNRESET\nnpm ERR! network request to https://registry.npmjs.org/jest failed, reason: socket hang up\nnpm ERR! network This is a problem related to network connectivity.\n')],
  ['Gradle certificate chain', 'registry-unreachable', failed("> Could not resolve all files for configuration ':testRuntimeClasspath'.\n   > Could not GET 'https://repo.example.invalid/x.pom'.\n      > PKIX path building failed: unable to find valid certification path to requested target\n")],
  ['Playwright browser not installed', 'browser-missing', failed("Error: browserType.launch: Executable doesn't exist at /home/dev/.cache/ms-playwright/chromium-1091/chrome-linux/chrome\n"
    + '╔══════════╗\n║ Looks like Playwright Test or Playwright was just installed or updated. ║\n║ Please run the following command to download new browsers: ║\n║     npx playwright install ║\n╚══════════╝\n')],
  ['refused database connection', 'service-unreachable', failed('Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1607:16)\n')],
  ['JDK older than the build', 'toolchain-version', failed('Exception in thread "main" java.lang.UnsupportedClassVersionError: com/example/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), '
    + 'this version of the Java Runtime only recognizes class file versions up to 55.0\n')],
  ['Maven compiler target the JDK lacks', 'toolchain-version', failed('[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project app: Fatal error compiling: error: invalid target release: 21\n')],
  ['Docker daemon not running', 'docker-unavailable', failed('java.lang.IllegalStateException: Could not find a valid Docker environment. Please see logs and check configuration\n')],
  ['./gradlew not executable', 'launcher-unavailable', { status: 'blocked', exitCode: null, stdout: '', stderr: 'Unable to run quality command: spawn ./gradlew EACCES' }],
  ['launcher missing', 'launcher-unavailable', { status: 'blocked', exitCode: null, stdout: '', stderr: 'Unable to run quality command: spawn mvn ENOENT', infrastructureUnavailable: true }],
  ['shell cannot find the launcher', 'launcher-unavailable', failed('zsh: command not found: mvn\n', { exitCode: 127 })],
  ['cache directory not writable', 'permission-denied', failed("npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /root/.npm\nnpm ERR! Error: EACCES: permission denied, mkdir '/root/.npm'\n")]
];

test('environment failures before any test ran are read from the run output, one class each', () => {
  for (const [label, expected, check] of ENVIRONMENT_OUTPUTS) {
    const cause = classOf(check, { changedPaths: ['src/value.mjs'] });
    assert.equal(cause.class, expected, `${label}: ${JSON.stringify(cause)}`);
    assert.equal(cause.category, 'environment', label);
    assert.equal(cause.basis, 'process', label);
    assert.equal(typeof cause.signal, 'string', label);
  }
});

test('compile, syntax and import errors are code causes, even beside an environment marker', () => {
  const tsc = classOf(failed("src/value.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nnpm WARN config production Use `--omit=dev` instead.\n"),
    { changedPaths: ['src/value.ts'] });
  assert.deepEqual([tsc.category, tsc.class, tsc.file], ['code', 'compile-error', 'src/value.ts']);
  const python = classOf(failed('ImportError while loading conftest\n  File "/work/repo/src/app/models.py", line 12\n    def total(self:\n              ^\nSyntaxError: invalid syntax\n'),
    { changedPaths: ['src/app/models.py'] });
  assert.deepEqual([python.category, python.class, python.file], ['code', 'syntax-error', 'src/app/models.py']);
  const node = classOf(failed('/work/repo/src/value.mjs:2\nexport const value = ;\n                     ^\n\nSyntaxError: Unexpected token \';\'\n'), { changedPaths: ['src/value.mjs'] });
  assert.equal(node.class, 'syntax-error');
  const javac = classOf(failed('[ERROR] COMPILATION ERROR :\n[ERROR] /work/repo/src/main/java/App.java:[3,5] cannot find symbol\n[INFO] Could not transfer artifact x from/to central\n'));
  assert.equal(javac.class, 'compile-error', 'a code marker wins');
  // A package imported from a file the Story changed is the change's own import; one from a file
  // it did not change is a dependency not installed here; a repository path is always the code's.
  const changedImport = classOf(failed("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'lodash' imported from /work/repo/src/value.mjs\n"), { changedPaths: ['src/value.mjs'] });
  assert.deepEqual([changedImport.category, changedImport.class, changedImport.file], ['code', 'import-error', 'src/value.mjs']);
  assert.equal(classOf(failed("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/repo/src/gone.mjs' imported from /work/repo/test/a.test.mjs\n")).class, 'import-error');
  assert.equal(classOf(failed("ModuleNotFoundError: No module named 'app.billing'\n"), { changedPaths: ['src/app/billing/__init__.py'] }).class, 'import-error');
  assert.equal(classOf(failed("ImportError: cannot import name 'total' from 'app.models' (/work/repo/app/models.py)\n")).class, 'import-error');
  // A JSON parse error is not the code's syntax (a proxy answering a registry request with HTML).
  assert.equal(classOf(failed('npm ERR! Unexpected token < in JSON at position 0 while parsing near "<html>"\nSyntaxError: Unexpected token < in JSON at position 0\n')).category, 'unknown');
});

test('a run in which tests ran is an environment cause only when every failed test failed from one', () => {
  const tests = { discovered: 3, passed: 0, failed: 3, skipped: 0 };
  const refused = 'connect ECONNREFUSED 127.0.0.1:5432';
  const every = classOf(failed(''), { tests, failedMessages: [refused, refused, 'Error: connect ECONNREFUSED 127.0.0.1:6379'] });
  assert.deepEqual(every, { category: 'environment', class: 'service-unreachable', basis: 'tests', signal: 'ECONNREFUSED', failedTests: 3 });
  const assertion = classOf(failed(''), { tests, failedMessages: [refused, refused, 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n2 !== 3\n'] });
  assert.deepEqual([assertion.category, assertion.class, assertion.failedTests], ['code', 'assertion-failure', 3]);
  assert.equal(classOf(failed(''), { tests, failedMessages: [refused, refused, null] }).class, 'assertion-failure', 'a failure without a message is not known to be the environment');
  assert.equal(classOf(failed(''), { tests, failedMessages: [refused] }).class, 'assertion-failure', 'messages that do not cover every failure');
  assert.equal(classOf(failed(''), { tests, failedMessages: null }).class, 'assertion-failure', 'an adapter with totals only');
  assert.equal(classOf(failed(''), { tests: { ...tests, passed: 2, discovered: 5 }, failedMessages: [refused, refused, refused] }).class, 'service-unreachable',
    'passing tests beside them do not change what the failures were');
  const browsers = classOf(failed(''), { tests: { discovered: 2, passed: 0, failed: 2, skipped: 0 },
    failedMessages: ["browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1091/chrome-linux/chrome", 'connect ECONNREFUSED ::1:3000'] });
  assert.equal(browsers.class, 'browser-missing+service-unreachable');
  assert.equal(testRunCauseCategory(browsers.class), 'environment');
  assert.equal(testRunCauseWords(browsers.class), 'the browser the tests drive is not installed and a service the tests connect to is not reachable');
  const changedImport = classOf(failed(''), { tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 }, changedPaths: ['src/value.js'],
    failedMessages: ["Cannot find module 'lodash' from 'src/value.js'"] });
  assert.deepEqual([changedImport.class, changedImport.basis], ['import-error', 'tests']);
});

test('a hang, an unrecognised exit and passing tests in a failed run are never environment causes', () => {
  assert.equal(classOf({ status: 'blocked', exitCode: null, timedOut: true, stderr: 'Command exceeded its 600000ms timeout.' }).class, 'timeout');
  assert.equal(classOf({ status: 'blocked', exitCode: null, timedOut: true, stderr: 'connect ECONNREFUSED 127.0.0.1:5432' }).category, 'unknown');
  assert.deepEqual(classOf(failed('boom\n')), { category: 'unknown', class: 'unrecognised', basis: 'process', signal: 'no recognised marker' });
  assert.equal(classOf(failed('Error: connect ECONNREFUSED 127.0.0.1:9\n'), { tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 } }).class, 'unrecognised');
  assert.equal(classOf({ status: 'passed', exitCode: 0 }, { tests: { discovered: 3, passed: 0, failed: 0, skipped: 3 } }).class, 'all-tests-skipped');
  // A test that fails saying something was not found is not a shell that lacks a launcher.
  assert.equal(classOf(failed(''), { tests: { discovered: 1, passed: 0, failed: 1, skipped: 0 }, failedMessages: ['Error: user: not found'] }).class, 'assertion-failure');
  assert.equal(testRunCauseCategory('syntax-error+service-unreachable'), null, 'a code class never joins an environment one');
  assert.equal(testRunCauseCategory('service-unreachable+browser-missing'), null, 'joined classes are sorted');
  assert.equal(testRunCauseCategory('nonsense'), null);
});

test('each failed test of a Playwright report is read for its message', () => {
  const report = Buffer.from(JSON.stringify({ suites: [{ specs: [{ tests: [
    { status: 'unexpected', results: [{ status: 'failed', error: { message: "browserType.launch: Executable doesn't exist at /x/chrome" } }] },
    { status: 'expected', results: [{ status: 'passed' }] }] }],
  suites: [{ specs: [{ tests: [{ status: 'unexpected', results: [{ status: 'timedOut', errors: [{ message: 'Test timeout of 30000ms exceeded.' }] }] }] }] }] }] }));
  assert.deepEqual(failedTestMessages('playwright-json', [], null, [report]), ["browserType.launch: Executable doesn't exist at /x/chrome", 'Test timeout of 30000ms exceeded.']);
  assert.deepEqual(failedTestMessages('node-tap', [{ outcome: 'passed' }, { outcome: 'failed' }], [null, 'connect ECONNREFUSED'], []), ['connect ECONNREFUSED']);
  assert.equal(failedTestMessages('dotnet-trx', [], null, [Buffer.from('<x/>')]), null);
});

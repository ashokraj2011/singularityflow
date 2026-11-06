/**
 * What stopped a test run [TCE:REQ-041]: real outputs of the environment failures a step approver may
 * accept, and of the code failures no decision ever covers. A code marker wins over an environment
 * one, and a run in which tests ran is an environment cause only when every failed test is one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { failedSuiteMessages } from '../src/test-case-messages.mjs';
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
  ['Chromium refused a connection', 'service-unreachable', failed('Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4294/\nCall log:\n  - navigating to "http://127.0.0.1:4294/", waiting until "load"\n')],
  ['Firefox refused a connection', 'service-unreachable', failed('Error: page.goto: NS_ERROR_CONNECTION_REFUSED\n')],
  ['a Playwright webServer port already used', 'port-in-use', failed('Error: http://127.0.0.1:4293 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.\n')],
  ['a Vite strictPort already used', 'port-in-use', failed('error when starting dev server:\nError: Port 4173 is already in use\n')],
  ['a Node server already bound', 'port-in-use', failed('Error: listen EADDRINUSE: address already in use 127.0.0.1:4173\n')],
  ['a Python server already bound', 'port-in-use', failed('OSError: [Errno 48] Address already in use\n')],
  ['a JVM server already bound', 'port-in-use', failed('java.net.BindException: Address already in use\n')],
  ['python without pytest', 'dependency-missing', failed('/usr/bin/python3: No module named pytest\n')],
  ['JDK older than the build', 'toolchain-version', failed('Exception in thread "main" java.lang.UnsupportedClassVersionError: com/example/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), '
    + 'this version of the Java Runtime only recognizes class file versions up to 55.0\n')],
  ['Maven compiler target the JDK lacks', 'toolchain-version', failed('[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project app: Fatal error compiling: error: invalid target release: 21\n')],
  ['no Android emulator or device attached', 'device-unavailable', failed("> Task :app:connectedDebugAndroidTest FAILED\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\n"
    + "Execution failed for task ':app:connectedDebugAndroidTest'.\n> com.android.builder.testing.api.DeviceException: No connected devices!\n")],
  ['no iOS simulator for the destination', 'device-unavailable', failed('xcodebuild: error: Unable to find a destination matching the provided destination specifier:\n\t\t{ platform:iOS Simulator, name:iPhone 15 }\n')],
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

test('what widens a person\'s choice stays behind the code: a code marker or an assertion still wins, and a near miss stays unknown', () => {
  const tests = { discovered: 1, passed: 0, failed: 1, skipped: 0 };
  // Tests failing on a refused page are the environment; the same words beside an assertion are the code's.
  assert.equal(classOf(failed(''), { tests, failedMessages: ['Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4294/'] }).class, 'service-unreachable');
  assert.equal(classOf(failed(''), { tests, failedMessages: ['Error: expect(received).toBe(expected)\nnet::ERR_CONNECTION_REFUSED'] }).class, 'assertion-failure');
  // The whole message real Playwright writes: its quote of the test's source is no assertion of its own.
  const quoted = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4294/\nCall log:\n  - navigating to "http://127.0.0.1:4294/"\n\n\n  1 | import { test, expect } from \'@playwright/test\'\n'
    + "> 2 | test('home',async({page})=>{ await page.goto('/'); await expect(page.locator('h1')).toHaveText('hi') })\n    |                                         ^\n  3 |\n    at /work/repo/e2e/a.spec.js:2:41";
  assert.equal(classOf(failed(''), { tests, failedMessages: [quoted] }).class, 'service-unreachable');
  const failedExpect = 'Error: expect(locator).toHaveText(expected) failed\n\nLocator: locator(\'h1\')\nExpected: "hi"\n\n> 2 | await expect(page.locator(\'h1\')).toHaveText(\'hi\')\n    |                                 ^\n';
  assert.equal(classOf(failed(''), { tests, failedMessages: [failedExpect] }).class, 'assertion-failure');
  // Vitest's and Jest's quotes.
  assert.equal(classOf(failed(''), { tests, failedMessages: ['Error: connect ECONNREFUSED 127.0.0.1:5432\n  3|   expect(await query()).toBe(1)\n   |          ^'] }).class, 'service-unreachable');
  assert.equal(classOf(failed(''), { tests, failedMessages: ['Error: connect ECONNREFUSED 127.0.0.1:5432\n> 3 |   expect(await query()).toBe(1);\n    |          ^'] }).class, 'service-unreachable');
  assert.equal(classOf(failed('src/a.ts(1,1): error TS2322: nope\nError: Port 4173 is already in use\n')).category, 'code');
  assert.equal(classOf(failed('SyntaxError: Unexpected token\n/usr/bin/python3: No module named pytest\n')).category, 'code');
  assert.equal(classOf(failed("ModuleNotFoundError: No module named 'pytest_plugin'\n"), { changedPaths: ['tests/test_a.py', 'pytest_plugin/x.py'] }).category, 'code');
  for (const unknown of ['/usr/bin/python3: No module named mypkg.__main__\n', 'Port 4173 is free\n', 'ERR_CONNECTION\n']) {
    assert.deepEqual([classOf(failed(unknown)).category, classOf(failed(unknown)).class], ['unknown', 'unrecognised'], unknown);
  }
  // Tests passed and the run failed: a marker in its output is still not known to be the cause.
  assert.equal(classOf(failed('Error: Port 4173 is already in use\n'), { tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 } }).class, 'unrecognised');
});

// The report real Vitest 4 writes when it collects a Playwright spec: one suite with no tests, a message and no failed test.
const VITEST_LOAD_FAILURE = 'Playwright Test did not expect test() to be called here.\nMost common reasons include:\n- You are calling test() in a configuration file.\n';
const vitestReport = (...suites) => ({
  numTotalTestSuites: suites.length, numFailedTestSuites: suites.filter((suite) => suite.status === 'failed').length,
  numTotalTests: suites.flatMap((suite) => suite.assertionResults).length,
  numPassedTests: suites.flatMap((suite) => suite.assertionResults).filter((test) => test.status === 'passed').length,
  numFailedTests: suites.flatMap((suite) => suite.assertionResults).filter((test) => test.status === 'failed').length,
  numPendingTests: 0, success: false, testResults: suites
});
const passedSuite = { assertionResults: [{ ancestorTitles: [], fullName: 'ok', status: 'passed', title: 'ok', failureMessages: [] }], status: 'passed', message: '', name: '/work/repo/src/a.test.js' };
const loadFailure = (message, name = '/work/repo/e2e/a.spec.js') => ({ assertionResults: [], status: 'failed', message, name });
const reportBytes = (report) => [Buffer.from(JSON.stringify(report))];

test('a test file that failed to load is read from the report, and names the real cause when every test passed', () => {
  const contents = reportBytes(vitestReport(loadFailure(VITEST_LOAD_FAILURE), passedSuite));
  const failedSuites = failedSuiteMessages('vitest-json', contents);
  assert.deepEqual(failedSuites.map((suite) => suite.name), ['/work/repo/e2e/a.spec.js']);
  assert.match(failedSuites[0].message, /^Playwright Test did not expect test\(\)/u);
  const tests = { discovered: 1, passed: 1, failed: 0, skipped: 0 };
  assert.deepEqual(classOf(failed(''), { tests, failedSuites, changedPaths: ['e2e/a.spec.js'] }), { category: 'code', class: 'foreign-test-file', basis: 'tests',
    signal: 'Playwright spec under another runner', file: 'e2e/a.spec.js', failedSuites: 1 });
  assert.match(testRunCauseWords('foreign-test-file'), /another runner/u);
  // Jest's own wording of the same collision.
  const jest = failedSuiteMessages('jest-json', reportBytes({ numFailedTests: 0, testResults: [loadFailure('  ● Test suite failed to run\n\n    Playwright Test needs to be invoked via \'npx playwright test\' and excluded from Jest test runs.\n')] }));
  assert.equal(classOf(failed(''), { tests: { discovered: 0, passed: 0, failed: 0, skipped: 0 }, failedSuites: jest }).class, 'foreign-test-file');
  // Any other load failure is what its message names; when it names nothing it is the code's, never the environment's.
  const read = (message, changedPaths = []) => classOf(failed(''), { tests, failedSuites: [{ name: '/work/repo/src/b.test.js', message }], changedPaths });
  assert.deepEqual([read('SyntaxError: Unexpected token').category, read('SyntaxError: Unexpected token').class], ['code', 'syntax-error']);
  assert.equal(read('Failed to resolve import "./gone" from "src/b.test.js"').class, 'import-error');
  assert.deepEqual([read("Cannot find package 'pg' imported from /work/repo/src/b.test.js").category, read("Cannot find package 'pg' imported from /work/repo/src/b.test.js").class], ['environment', 'dependency-missing']);
  assert.equal(read("Cannot find package 'pg' imported from /work/repo/src/b.test.js", ['src/b.test.js']).class, 'import-error');
  const unknown = read('boom', ['src/b.test.js']);
  assert.deepEqual([unknown.category, unknown.class, unknown.file], ['code', 'suite-failure', 'src/b.test.js']);
  assert.equal(testRunCauseWords('suite-failure'), 'a test file failed outside its tests, usually while loading');
});

test('a failed suite cannot be hidden by failed tests that look like the environment, and only a suite with no failed test counts', () => {
  const tests = { discovered: 1, passed: 0, failed: 1, skipped: 0 };
  const refused = 'connect ECONNREFUSED 127.0.0.1:5432';
  assert.equal(classOf(failed(''), { tests, failedMessages: [refused] }).category, 'environment');
  assert.equal(classOf(failed(''), { tests, failedMessages: [refused], failedSuites: [{ name: 'a', message: 'boom' }] }).category, 'code');
  assert.equal(classOf(failed(''), { tests, failedMessages: [refused], failedSuites: [{ name: 'a', message: refused }] }).class, 'service-unreachable');
  // A suite with a failed test reports that test; its message is not a load failure.
  const failedTest = { assertionResults: [{ ancestorTitles: [], fullName: 'x', status: 'failed', title: 'x', failureMessages: ['AssertionError'] }], status: 'failed', message: '● x', name: '/work/repo/src/c.test.js' };
  assert.deepEqual(failedSuiteMessages('jest-json', reportBytes(vitestReport(failedTest, passedSuite))), []);
  for (const [adapter, contents] of [['playwright-json', reportBytes(vitestReport(loadFailure('x')))], ['vitest-json', [Buffer.from('not json')]], ['vitest-json', []]]) {
    assert.deepEqual(failedSuiteMessages(adapter, contents), [], adapter);
  }
});

test('a report that counts no tests says so, and is never an environment cause on that alone', () => {
  const none = { discovered: 0, passed: 0, failed: 0, skipped: 0 };
  // pytest's own exit 5, with the report it writes when it collects nothing.
  const collectedNothing = classOf(failed('collected 0 items\n\n============ no tests ran in 0.00s ============\n', { exitCode: 5 }), { tests: none });
  assert.deepEqual(collectedNothing, { category: 'unknown', class: 'no-tests', basis: 'tests', signal: 'report counts no tests' });
  assert.equal(testRunCauseWords('no-tests'), 'the run found no tests');
  assert.equal(classOf(failed('collected 0 items\n')).class, 'unrecognised', 'a report that could not be read counts nothing');
  assert.equal(classOf(failed('sh: 1: pytest: not found\n'), { tests: none }).category, 'environment', 'the output still names what stopped it');
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

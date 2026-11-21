/**
 * The runtime check of a batch job and of a mobile app (step intents spec §12.3), on self-contained fixture repositories.
 *
 * - A job: SFlow runs its start entry twice on the repository's sample input in a temporary copy of the project. A
 *   crash, a non-zero exit or different output on the second run is a breaks-use finding; a clean, repeatable job has
 *   none, and nothing it writes reaches the repository.
 * - A mobile app: SFlow launches the project's own build in an iOS Simulator or Android emulator and checks it is still
 *   running. The launcher is stubbed (no simulator or emulator in this lane): its `xcrun simctl` and `adb` answers are
 *   the fixture. Without one, or without a build, the check says what is missing with the command that provides it,
 *   and blocks nothing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeApplicationReview } from '../src/application-review-contract.mjs';
import { runRuntimeCheck, runtimeCheckWords, runtimeFindings, runtimeTryIt } from '../src/runtime-check.mjs';
import { comparableText, diagnosticTail, sampleInputs } from '../src/runtime-check-job.mjs';
import { emulatorSerials, mobileLauncher } from '../src/runtime-check-mobile.mjs';

const git = (root, ...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

/** A Git repository from `{ path: text }` at two commits, `base` then `head`; `untracked` is written after, uncommitted. */
async function repository(t, base, head = {}, untracked = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-runtime-job-mobile-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  const write = async (files) => { for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } };
  await write(base);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Runtime Tester', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  await write(head);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Runtime Tester', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'the change');
  await write(untracked);
  return { root, base: baseCommit };
}

const story = (base, sourcePaths) => ({ workItem: { id: 'RT-2', baseCommit: base }, currentPhase: 'implement', phaseOrder: ['implement'],
  phases: { implement: { id: 'implement', status: 'in_progress', generation: 1, generationPolicy: { task: 'code', requirement: 'required' }, deliveryEvidence: { sourcePaths } } },
  resolution: { applicationReview: normalizeApplicationReview({ mode: 'optional' }) } });
const breaking = (capture) => runtimeFindings(capture).filter((finding) => finding.class === 'breaks-use');

// ---------------------------------------------------------------------------------------------
// A job

const JOB_PACKAGE = JSON.stringify({ name: 'nightly-totals', private: true, type: 'module', dependencies: { 'node-cron': '3.0.0' } });
const ENTRY = { id: 'nightly', argv: ['node', 'job.mjs'], workingDirectory: '.', url: 'http://127.0.0.1:49999/', ready: { log: 'processed' } };
const capabilities = (entry) => JSON.stringify({ version: 1, capabilities: { app: { kind: 'delivery', repository: 'app', application: { start: entry ? [entry] : [] } } } });
const ORDERS = 'id,amount\n1,10\n2,15\n3,7\n';
// Reads the orders on its input, writes the total to out/total.json and says how long it took: the same on every run.
const CLEAN = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const rows = readFileSync(0, 'utf8').trim().split('\\n').slice(1).map((line) => Number(line.split(',')[1]));
mkdirSync('out', { recursive: true });
writeFileSync('out/total.json', JSON.stringify({ total: rows.reduce((sum, value) => sum + value, 0), at: new Date().toISOString() }));
console.log('processed ' + rows.length + ' rows in ' + (5 + Math.floor(Math.random() * 50)) + 'ms at ' + new Date().toISOString());
`;
// The defect: it adds to the total it finds, so a rerun after a failure doubles it.
const APPENDS = CLEAN.replace("writeFileSync('out/total.json', JSON.stringify({ total: rows.reduce((sum, value) => sum + value, 0), at: new Date().toISOString() }));",
  "let earlier = 0; try { earlier = JSON.parse(readFileSync('out/total.json', 'utf8')).total; } catch {}\nwriteFileSync('out/total.json', JSON.stringify({ total: earlier + rows.reduce((sum, value) => sum + value, 0) }));");
// The defect: a row it cannot read is a crash.
const CRASHES = CLEAN.replace("map((line) => Number(line.split(',')[1]))", "map((line) => { const value = Number(line.split(',')[1]); if (Number.isNaN(value)) throw new TypeError('bad amount: ' + line); return value; })");

async function jobRepository(t, script, { samples = { 'samples/orders.csv': ORDERS }, entry = ENTRY } = {}) {
  return repository(t, { 'package.json': JOB_PACKAGE, 'job.mjs': 'console.log("processed 0 rows");\n', 'singularity/capabilities.yml': capabilities(entry), ...samples },
    { 'job.mjs': script });
}

test('a repeatable job run twice on its sample input in a temporary copy: no finding, a command to try it, and the repository untouched', { timeout: 120_000 }, async (t) => {
  const { root, base } = await jobRepository(t, CLEAN);
  const capture = await runRuntimeCheck(root, {}, story(base, ['job.mjs']), 'implement');
  const [check] = capture.checks;
  assert.equal(check.kind, 'job');
  assert.equal(check.status, 'ran', JSON.stringify(check.missing));
  assert.deepEqual(runtimeFindings(capture), [], JSON.stringify(runtimeFindings(capture)));
  assert.deepEqual(check.ran, ['ran start entry nightly twice on samples/orders.csv in a temporary copy of the project']);
  assert.deepEqual(check.observed.runs, [{ code: 0, signal: null }, { code: 0, signal: null }]);
  assert.deepEqual(runtimeTryIt(capture), [{ kind: 'job', commands: ['node job.mjs < samples/orders.csv'] }]);
  assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', 'the job wrote nothing into the repository');
  assert.match(runtimeCheckWords(capture), /^Runtime check: ran job; 0 findings that break use, 0 advice\.$/u);
});

test('a job that gives a different total when run again on the same input is a breaks-use finding', { timeout: 120_000 }, async (t) => {
  const { root, base } = await jobRepository(t, APPENDS);
  const capture = await runRuntimeCheck(root, {}, story(base, ['job.mjs']), 'implement');
  assert.deepEqual(breaking(capture).map((finding) => [finding.type, finding.title]), [['job-not-repeatable', 'nightly gives different output when run again on the same input']]);
  assert.match(breaking(capture)[0].detail, /The second run changed out\/total\.json\./u);
  assert.equal(breaking(capture)[0].id, 'RT-001');
});

test('a job that crashes on its fixture input, or exits non-zero, is a breaks-use finding and is not run again', { timeout: 120_000 }, async (t) => {
  const crash = await jobRepository(t, CRASHES, { samples: { 'test/fixtures/orders.csv': 'id,amount\n1,10\n2,ten\n' } });
  const crashed = await runRuntimeCheck(crash.root, {}, story(crash.base, ['job.mjs']), 'implement');
  assert.deepEqual(breaking(crashed).map((finding) => [finding.type, finding.title]), [['job-crashed', 'nightly crashes on the first run with test/fixtures/orders.csv']]);
  assert.match(breaking(crashed)[0].evidence.stderr, /TypeError: bad amount: 2,ten/u);
  assert.deepEqual(crashed.checks[0].ran, ['ran start entry nightly once (it failed, so not again) on test/fixtures/orders.csv in a temporary copy of the project']);
  const exit = await jobRepository(t, `${CLEAN}console.error('the warehouse is unreachable');\nprocess.exit(3);\n`);
  const failed = await runRuntimeCheck(exit.root, {}, story(exit.base, ['job.mjs']), 'implement');
  assert.deepEqual(breaking(failed).map((finding) => [finding.type, finding.title, finding.detail]),
    [['job-failed', 'nightly exits 3 on the first run with samples/orders.csv', 'the warehouse is unreachable']]);
});

test('a job with no start entry, or one that does not finish in time, says what is missing and blocks nothing', { timeout: 120_000 }, async (t) => {
  const none = await jobRepository(t, CLEAN, { entry: null });
  const missing = await runRuntimeCheck(none.root, {}, story(none.base, ['job.mjs']), 'implement');
  assert.equal(missing.checks[0].status, 'not-available');
  assert.deepEqual(missing.checks[0].missing.map((entry) => [entry.what, entry.command]), [['a saved start entry', 'singularity-flow app suggest --json']]);
  const slow = await jobRepository(t, 'setTimeout(() => {}, 60_000);\n');
  const late = await runRuntimeCheck(slow.root, {}, story(slow.base, ['job.mjs']), 'implement', { deadlineMs: 15_000 });
  assert.equal(late.checks[0].status, 'not-available');
  assert.match(late.checks[0].missing[0].what, /^the job \(start entry nightly\) finishing in time$/u);
  assert.deepEqual(runtimeFindings(late), [], 'a slow run is not a finding');
});

test('what changes from run to run is left out of the comparison, and the sample input is found where repositories keep it', () => {
  assert.equal(comparableText('done in 12ms at 2026-11-21T09:00:01.123Z (pid 4242) in /tmp/x/out', '/tmp/x'),
    comparableText('done in 840 ms at 2026-11-21T09:00:03Z (pid 77) in /tmp/y/out', '/tmp/y'));
  assert.notEqual(comparableText('total 32'), comparableText('total 64'));
  assert.deepEqual(sampleInputs(['package.json', 'src/job.mjs', 'data/samples/orders.csv', 'test/fixtures/a.json', 'examples/input.txt', 'node_modules/x/fixtures/b.json', 'docs/notes.md']),
    ['examples/input.txt', 'data/samples/orders.csv', 'test/fixtures/a.json']);
  assert.deepEqual(sampleInputs(['jobs/a/samples/one.csv', 'jobs/b/samples/two.csv'], 'jobs/b'), ['jobs/b/samples/two.csv']);
});

// ---------------------------------------------------------------------------------------------
// A mobile app, with the launcher stubbed

const ANDROID = {
  'settings.gradle': "rootProject.name = 'shop'\ninclude ':app'\n",
  'app/build.gradle': "plugins { id 'com.android.application' }\nandroid {\n  namespace 'com.acme.shop'\n  defaultConfig { applicationId \"com.acme.shop\" }\n}\n",
  'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Shop"/></manifest>\n',
  'app/src/main/java/com/acme/shop/MainActivity.kt': 'class MainActivity\n'
};
const APK = { 'app/build/outputs/apk/debug/app-debug.apk': 'PK fake apk' };

/**
 * `adb` and `emulator` as a fixture: `running` says whether an emulator already runs, `alive` whether the app is
 * still running after launch. Every call is kept in `calls`.
 */
function androidTools({ running = true, alive = true, phone = false } = {}) {
  const calls = [];
  let booted = running;
  const background = [];
  const exec = (argv) => {
    calls.push(argv.join(' '));
    const [tool, ...rest] = argv;
    const words = rest.join(' ');
    if (tool === 'adb' && words === 'version') return { code: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '' };
    if (tool === 'emulator' && words === '-version') return { code: 0, stdout: 'Android emulator version 34.1\n', stderr: '' };
    if (tool === 'emulator' && words === '-list-avds') return { code: 0, stdout: 'Pixel_8_API_34\n', stderr: '' };
    if (tool === 'adb' && words === 'devices') {
      return { code: 0, stdout: `List of devices attached\n${phone ? 'R58M123ABC\tdevice\n' : ''}${booted ? 'emulator-5554\tdevice\n' : ''}`, stderr: '' };
    }
    if (tool === 'adb' && words === '-s emulator-5554 shell getprop sys.boot_completed') return { code: 0, stdout: '1\n', stderr: '' };
    if (tool === 'adb' && words.startsWith('-s emulator-5554 install -r ')) return { code: 0, stdout: 'Performing Streamed Install\nSuccess\n', stderr: '' };
    if (tool === 'adb' && words.startsWith('-s emulator-5554 shell monkey -p com.acme.shop')) return { code: 0, stdout: 'Events injected: 1\n', stderr: '' };
    if (tool === 'adb' && words === '-s emulator-5554 shell pidof com.acme.shop') return { code: alive ? 0 : 1, stdout: alive ? '4242\n' : '', stderr: '' };
    if (tool === 'adb' && words.startsWith('-s emulator-5554 logcat -d -b crash')) {
      return { code: 0, stdout: '--------- beginning of crash\nE AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: java.lang.IllegalStateException: no cart\n', stderr: '' };
    }
    if (tool === 'adb' && /^-s emulator-5554 (?:shell am force-stop|emu kill)/u.test(words)) return { code: 0, stdout: '', stderr: '' };
    return { code: null, stdout: '', stderr: `${tool}: not found` };
  };
  const spawnBackground = (argv) => { calls.push(`background: ${argv.join(' ')}`); booted = true; const handle = { stopped: false, stop() { handle.stopped = true; } }; background.push(handle); return handle; };
  return { calls, background, exec, spawnBackground };
}

async function launcherFor(t, tools, platform = 'linux') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-runtime-mobile-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return mobileLauncher({ exec: tools.exec, spawnBackground: tools.spawnBackground, platform, env: { PATH: process.env.PATH }, sleep: async () => {}, settleMs: 0, home });
}

test('an Android app that keeps running in a running emulator: no finding, and commands to try it', async (t) => {
  const { root, base } = await repository(t, ANDROID, { 'app/src/main/java/com/acme/shop/MainActivity.kt': 'class MainActivity { }\n' }, APK);
  const tools = androidTools({ phone: true });
  const capture = await runRuntimeCheck(root, {}, story(base, ['app/src/main/java/com/acme/shop/MainActivity.kt']), 'implement', { mobileLauncher: await launcherFor(t, tools) });
  const [check] = capture.checks;
  assert.equal(check.kind, 'mobile');
  assert.equal(check.status, 'ran', JSON.stringify(check.missing));
  assert.deepEqual(runtimeFindings(capture), []);
  assert.deepEqual(check.ran, ['installed app-debug.apk in the Android emulator and launched com.acme.shop', 'checked com.acme.shop is running 0 seconds after launch']);
  assert.ok(tools.calls.every((call) => !call.includes('R58M123ABC')), 'a connected phone is never used');
  assert.ok(!tools.calls.some((call) => call.startsWith('background:')), 'an emulator already runs: none is started');
  assert.ok(tools.calls.includes('adb -s emulator-5554 shell am force-stop com.acme.shop'), 'the app is stopped afterwards');
  assert.deepEqual(runtimeTryIt(capture)[0].commands, [`adb install -r '${path.join(root, 'app/build/outputs/apk/debug/app-debug.apk')}'`, 'adb shell monkey -p com.acme.shop -c android.intent.category.LAUNCHER 1']);
});

test('an Android app that crashes on launch is a breaks-use finding; SFlow starts an emulator without a window and stops it', async (t) => {
  const { root, base } = await repository(t, ANDROID, { 'app/src/main/java/com/acme/shop/MainActivity.kt': 'class MainActivity { val cart = null!! }\n' }, APK);
  const tools = androidTools({ running: false, alive: false });
  const capture = await runRuntimeCheck(root, {}, story(base, ['app/src/main/java/com/acme/shop/MainActivity.kt']), 'implement', { mobileLauncher: await launcherFor(t, tools) });
  assert.deepEqual(breaking(capture).map((finding) => [finding.type, finding.title]), [['mobile-crash-on-launch', 'com.acme.shop crashes on launch in the Android emulator']]);
  assert.match(breaking(capture)[0].evidence.log, /FATAL EXCEPTION: main/u);
  assert.equal(breaking(capture)[0].where.file, 'app/build/outputs/apk/debug/app-debug.apk');
  assert.ok(tools.calls.includes('background: emulator -avd Pixel_8_API_34 -no-window -no-audio -no-boot-anim -no-snapshot-save'));
  assert.ok(tools.calls.includes('adb -s emulator-5554 emu kill'));
  assert.equal(tools.background[0].stopped, true, 'the emulator SFlow started is stopped');
});

test('no emulator, no simulator or no build here: not available, with the command that provides it, and never a finding', async (t) => {
  // A React Native app: one project with an Android module under android/ and an Xcode project under ios/.
  const native = { 'package.json': JSON.stringify({ name: 'shop', private: true, dependencies: { 'react-native': '0.74.0' } }), 'App.tsx': 'export default function App() { return null; }\n',
    'android/settings.gradle': "include ':app'\n", 'android/app/build.gradle': ANDROID['app/build.gradle'], 'android/app/src/main/AndroidManifest.xml': ANDROID['app/src/main/AndroidManifest.xml'],
    'ios/Shop.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n' };
  const { root, base } = await repository(t, native, { 'App.tsx': 'export default function App() { return "Shop"; }\n' });
  const nothing = { calls: [], exec: () => ({ code: null, stdout: '', stderr: 'not found' }), spawnBackground: () => { throw new Error('never started'); } };
  const capture = await runRuntimeCheck(root, {}, story(base, ['App.tsx']), 'implement', { mobileLauncher: await launcherFor(t, nothing) });
  const [check] = capture.checks;
  assert.equal(check.status, 'not-available');
  assert.deepEqual(check.missing.map((entry) => [entry.what, entry.command ?? null]), [
    ['the Android emulator', 'sdkmanager --install "platform-tools" "emulator"'],
    ['the iOS Simulator', null]]);
  assert.match(check.missing[1].why, /runs only on macOS/u);
  assert.deepEqual(runtimeFindings(capture), []);
  assert.match(runtimeCheckWords(capture), /could not run here; .* missing here: the Android emulator, the iOS Simulator\./u);
  // With the emulator but no build: the build command.
  const unbuilt = await runRuntimeCheck(root, {}, story(base, ['App.tsx']), 'implement', { again: true, mobileLauncher: await launcherFor(t, androidTools()) });
  assert.deepEqual(unbuilt.checks[0].missing.map((entry) => [entry.what, entry.command ?? null]).slice(0, 1), [['a debug .apk of the app', 'cd android && ./gradlew :app:assembleDebug']]);
  assert.deepEqual(runtimeFindings(unbuilt), []);
});

test('an iOS app in a booted simulator: installed, launched, checked running; one that is gone after launch is a finding', async (t) => {
  const plist = '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.acme.shop</string></dict></plist>';
  const { root, base } = await repository(t, { 'ios/Shop.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'ios/Shop/ContentView.swift': 'struct ContentView {}\n' },
    { 'ios/Shop/ContentView.swift': 'struct ContentView { let title = "Shop" }\n' },
    { 'ios/build/Build/Products/Debug-iphonesimulator/Shop.app/Info.plist': plist });
  const simulator = (alive) => {
    const calls = [];
    const exec = (argv) => {
      calls.push(argv.join(' '));
      const words = argv.join(' ');
      if (words === 'xcrun simctl help') return { code: 0, stdout: 'usage: simctl', stderr: '' };
      if (words === 'xcrun simctl list devices booted --json') return { code: 0, stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ udid: 'SIM-1', name: 'iPhone 15', state: 'Booted' }] } }), stderr: '' };
      if (argv[0] === 'plutil') return { code: null, stdout: '', stderr: 'plutil: not here' };
      if (words.startsWith('xcrun simctl install SIM-1 ')) return { code: 0, stdout: '', stderr: '' };
      if (words === 'xcrun simctl launch SIM-1 com.acme.shop') return { code: 0, stdout: 'com.acme.shop: 777\n', stderr: '' };
      if (words === 'xcrun simctl spawn SIM-1 launchctl list') return { code: 0, stdout: `PID\tStatus\tLabel\n${alive ? '777' : '-'}\t${alive ? 0 : 11}\tUIKitApplication:com.acme.shop[3a1f][rb-legacy]\n`, stderr: '' };
      if (words === 'xcrun simctl terminate SIM-1 com.acme.shop') return { code: 0, stdout: '', stderr: '' };
      return { code: null, stdout: '', stderr: 'not found' };
    };
    return { calls, exec, spawnBackground: () => { throw new Error('never started'); } };
  };
  const ok = simulator(true);
  const capture = await runRuntimeCheck(root, {}, story(base, ['ios/Shop/ContentView.swift']), 'implement', { mobileLauncher: await launcherFor(t, ok, 'darwin') });
  assert.equal(capture.checks[0].status, 'ran', JSON.stringify(capture.checks[0].missing));
  assert.deepEqual(runtimeFindings(capture), []);
  assert.ok(!ok.calls.some((call) => / boot | shutdown /u.test(` ${call} `)), 'a simulator already runs: none is booted or shut down');
  assert.deepEqual(runtimeTryIt(capture)[0].commands.at(-1), 'xcrun simctl launch booted com.acme.shop');
  const gone = await runRuntimeCheck(root, {}, story(base, ['ios/Shop/ContentView.swift']), 'implement', { again: true, mobileLauncher: await launcherFor(t, simulator(false), 'darwin') });
  assert.deepEqual(breaking(gone).map((finding) => finding.title), ['com.acme.shop crashes on launch in the iOS Simulator']);
});

test('only emulators count as places to launch: a connected phone is not one', () => {
  assert.deepEqual(emulatorSerials('List of devices attached\nR58M123ABC\tdevice\nemulator-5556\toffline\nemulator-5554\tdevice\n'), ['emulator-5554']);
});

test('a crash keeps the line that says what went wrong, however long the stack trace after it is', () => {
  const frames = (count, frame) => Array.from({ length: count }, (_, index) => frame(index)).join('\n');
  // Node 26 prints more frames than Node 22, which pushed the error out of the last 12 lines.
  const node = `file:///job.mjs:2\nthrow new TypeError('bad amount: 2,ten');\n^\n\nTypeError: bad amount: 2,ten\n${frames(20, (index) => `    at step${index} (file:///job.mjs:${index}:1)`)}\n\nNode.js v26.12.0`;
  assert.match(diagnosticTail(node), /^TypeError: bad amount: 2,ten\n…\n/u);
  assert.equal(diagnosticTail(node).split('\n').length, 14, 'the error line, a gap, then the last 12 lines');
  const java = `Exception in thread "main" java.lang.IllegalStateException: run failed\n${frames(15, (index) => `\tat Job.step${index}(Job.java:${index})`)}\nCaused by: java.io.IOException: disk full\n${frames(15, (index) => `\tat Io.write${index}(Io.java:${index})`)}`;
  assert.match(diagnosticTail(java), /^Caused by: java\.io\.IOException: disk full\n…\n/u, 'the root cause');
  const android = frames(30, (index) => `11-22 04:00:00.000  1234  1234 E AndroidRuntime: \tat com.example.Step${index}.run(Step.java:${index})`)
    .replace(/^/u, '11-22 04:00:00.000  1234  1234 E AndroidRuntime: java.lang.RuntimeException: Unable to start activity\n');
  assert.match(diagnosticTail(android), /^11-22 .*AndroidRuntime: java\.lang\.RuntimeException: Unable to start activity\n…\n/u);
  // Python prints the error last, Go its panic first; a short output is returned as it is.
  const python = `Traceback (most recent call last):\n${frames(20, (index) => `  File "job.py", line ${index}, in step${index}`)}\nValueError: bad amount`;
  assert.equal(diagnosticTail(python), python.split('\n').slice(-12).join('\n'));
  assert.match(diagnosticTail(`panic: runtime error: index out of range\n\ngoroutine 1 [running]:\n${frames(20, (index) => `main.step${index}()\n\t/job.go:${index}`)}`), /^panic: runtime error: index out of range\n…\n/u);
  assert.equal(diagnosticTail('the warehouse is unreachable'), 'the warehouse is unreachable');
  assert.equal(diagnosticTail(''), '');
});

/**
 * The runtime check of a mobile app (step intents spec §12.3): when this laptop has an iOS Simulator (`xcrun simctl`)
 * or an Android emulator (`emulator` and `adb`), SFlow installs the app's own build in it, launches it, and checks it
 * is still running a few seconds later. An app that is not running then, or that the launcher says will not start,
 * is a breaks-use finding. Without a simulator or emulator, or without a build of the app, it says what is missing
 * here with the command that provides it, and blocks nothing.
 *
 * SFlow uses the build the project already made (an .apk under build/outputs/apk, a simulator .app under a build or
 * DerivedData folder); it never builds the app itself. It boots a simulator or starts an emulator only when none is
 * running, without a window, and shuts down what it started. On Android it uses emulators only, never a phone that
 * happens to be connected. Every command goes through `exec` and `spawnBackground`, which tests replace.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SETTLE_MS = 5_000;
const COMMAND_MS = 60_000;
const SKIPPED = new Set(['node_modules', '.git', '.gradle', 'Pods', 'intermediates', 'tmp']);

/** Run `argv` and wait: `{ code, stdout, stderr }`, code null when it could not start. */
export function execCommand(argv, { timeoutMs = COMMAND_MS, env = process.env } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return { code: result.error ? null : result.status, stdout: result.stdout ?? '', stderr: result.error ? String(result.error.message) : result.stderr ?? '' };
}

/** Start `argv` in the background (an emulator); `{ stop() }`. */
export function spawnBackgroundCommand(argv, { env = process.env } = {}) {
  const child = spawn(argv[0], argv.slice(1), { env, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return { stop() { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch { /* gone */ } } } };
}

// ---------------------------------------------------------------------------------------------
// What the project is, and its build

/** The platforms a mobile project builds for, read from its committed files: `{ android: [moduleFolder], ios: [projectName] }`. */
export function mobilePlatforms(tracked, folder = '', texts = new Map()) {
  const inProject = tracked.filter((file) => !folder || file.startsWith(`${folder}/`));
  const android = [...new Set(inProject.filter((file) => /(?:^|\/)build\.gradle(?:\.kts)?$/u.test(file) && /com\.android\.application/u.test(texts.get(file) ?? ''))
    .map((file) => path.posix.dirname(file)))];
  if (!android.length) {
    for (const file of inProject.filter((entry) => /(?:^|\/)src\/main\/AndroidManifest\.xml$/u.test(entry))) android.push(file.replace(/\/src\/main\/AndroidManifest\.xml$/u, '') || '.');
  }
  const ios = [...new Set(inProject.map((file) => /(?:^|\/)([^/]+)\.xcodeproj\//u.exec(file)?.[1]).filter(Boolean))];
  return { android: [...new Set(android)], ios };
}

/** The files whose text says the Android module and its application ID: build.gradle(.kts) and the main manifest. */
export const mobileTextFiles = (tracked, folder = '') => tracked.filter((file) => (!folder || file.startsWith(`${folder}/`))
  && /(?:^|\/)(?:build\.gradle(?:\.kts)?|src\/main\/AndroidManifest\.xml)$/u.test(file)).slice(0, 40);

/** An Android module's application ID: build.gradle's applicationId, else its namespace, else the manifest's package. */
export function androidApplicationId(module, texts) {
  const at = (name) => texts.get(module === '.' ? name : `${module}/${name}`) ?? '';
  const gradle = `${at('build.gradle')}\n${at('build.gradle.kts')}`;
  return /\bapplicationId\s*(?:=\s*)?["']([\w.]+)["']/u.exec(gradle)?.[1] ?? /\bnamespace\s*(?:=\s*)?["']([\w.]+)["']/u.exec(gradle)?.[1]
    ?? /<manifest\b[^>]*\bpackage\s*=\s*["']([\w.]+)["']/u.exec(at('src/main/AndroidManifest.xml'))?.[1] ?? null;
}

async function walk(directory, depth, visit) {
  if (depth < 0) return;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIPPED.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (await visit(full, entry) === false) continue;
    if (entry.isDirectory()) await walk(full, depth - 1, visit);
  }
}

async function newest(paths) {
  const dated = await Promise.all(paths.map(async (file) => ({ file, time: (await stat(file).catch(() => null))?.mtimeMs ?? 0 })));
  return dated.sort((left, right) => (/debug/iu.test(right.file) - /debug/iu.test(left.file)) || right.time - left.time)[0]?.file ?? null;
}

/** The newest .apk the module built (debug first), or null. */
export async function androidBuild(root, module) {
  const found = [];
  await walk(path.join(root, module === '.' ? '' : module, 'build', 'outputs', 'apk'), 3, (full, entry) => {
    if (entry.isFile() && full.endsWith('.apk') && !/-unsigned|androidTest/u.test(entry.name)) found.push(full);
  });
  return newest(found);
}

/** The newest simulator .app the project built: under the project's own folders, then Xcode's DerivedData. */
export async function iosBuild(root, folder, projectName, { home = os.homedir() } = {}) {
  const found = [];
  const collect = (full, entry) => {
    if (!entry.isDirectory() || !full.endsWith('.app')) return true;
    if (/-iphonesimulator(?:\/|\\)/u.test(full)) found.push(full);
    return false;
  };
  for (const start of [path.join(root, folder), path.join(root, folder, 'ios')]) {
    for (const name of ['build', 'DerivedData']) await walk(path.join(start, name), 6, collect);
  }
  if (!found.length && home) {
    const derived = path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData');
    let entries = [];
    try { entries = await readdir(derived, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith(`${projectName}-`)).slice(0, 5)) {
      await walk(path.join(derived, entry.name, 'Build', 'Products'), 2, collect);
    }
  }
  return newest(found);
}

/** A simulator .app's bundle ID: plutil reads any Info.plist; a plain XML one is read directly. */
export async function iosBundleId(app, exec) {
  const plist = path.join(app, 'Info.plist');
  const read = exec(['plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeoutMs: 10_000 });
  if (read.code === 0 && read.stdout.trim()) return read.stdout.trim();
  const text = await readFile(plist, 'utf8').catch(() => '');
  return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(text)?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------------------------
// The launchers

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Android SDK tool `name` (adb, emulator): on PATH, else under ANDROID_HOME or ANDROID_SDK_ROOT. */
function androidTool(name, { env, exec }) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || null;
  const candidates = [name, ...(sdk ? [path.join(sdk, name === 'adb' ? 'platform-tools' : 'emulator', name)] : [])];
  return candidates.find((candidate) => exec([candidate, name === 'adb' ? 'version' : '-version'], { timeoutMs: 15_000 }).code === 0) ?? null;
}

const SYSTEM_IMAGE = `system-images;android-34;google_apis;${os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64'}`;

/**
 * A launcher on this laptop: `available(platform)` says whether it can launch there (`{ available, tool }` or
 * `{ available: false, why, command }`), and `launch(platform, { build, appId, deadline })` installs and launches
 * the build and says whether it is still running (`{ started, crashed, detail, log, ran, tryIt }`, or `{ missing }`).
 * `home` is where Xcode's DerivedData is looked for. `exec`, `spawnBackground`, `platform`, `env`, `sleep` and `home`
 * are for tests.
 */
export function mobileLauncher({ exec = execCommand, spawnBackground = spawnBackgroundCommand, platform = process.platform, env = process.env, sleep = sleepFor, settleMs = SETTLE_MS,
  home = os.homedir() } = {}) {
  const tools = new Map();
  const tool = (name) => {
    if (!tools.has(name)) tools.set(name, androidTool(name, { env, exec }));
    return tools.get(name);
  };
  const invoke = (argv, timeoutMs = COMMAND_MS) => exec(argv, { timeoutMs, env });

  async function available(target) {
    if (target === 'ios') {
      if (platform !== 'darwin') return { available: false, why: 'The iOS Simulator runs only on macOS.' };
      if (invoke(['xcrun', 'simctl', 'help'], 15_000).code !== 0) {
        return { available: false, why: 'This Mac has no iOS Simulator (xcrun simctl): install Xcode, then its iOS platform.', command: 'xcodebuild -downloadPlatform iOS' };
      }
      return { available: true, tool: 'xcrun simctl' };
    }
    const adb = tool('adb');
    const emulator = tool('emulator');
    if (!adb || !emulator) {
      return { available: false, why: `This laptop has no Android ${!emulator ? 'emulator' : 'adb'} (the Android SDK's ${!emulator ? 'emulator' : 'platform-tools'}).`,
        command: 'sdkmanager --install "platform-tools" "emulator"' };
    }
    const running = emulatorSerials(invoke([adb, 'devices']).stdout);
    const avds = invoke([emulator, '-list-avds'], 15_000).stdout.split('\n').map((line) => line.trim()).filter((line) => line && !/^(?:INFO|WARNING|ERROR)\b/u.test(line));
    if (!running.length && !avds.length) {
      return { available: false, why: 'The Android emulator has no virtual device to start.',
        command: `sdkmanager --install "${SYSTEM_IMAGE}" && avdmanager create avd --name sflow --package "${SYSTEM_IMAGE}"` };
    }
    return { available: true, tool: 'emulator', adb, emulator, avd: avds[0] ?? null };
  }

  async function launchIos({ build, appId, deadline }) {
    const ran = [];
    const list = (filter) => { try { return Object.values(JSON.parse(invoke(['xcrun', 'simctl', 'list', 'devices', filter, '--json']).stdout || '{}').devices ?? {}).flat(); } catch { return []; } };
    let device = list('booted').find((entry) => entry.state === 'Booted') ?? null;
    let booted = false;
    if (!device) {
      device = list('available').find((entry) => /^iPhone/u.test(entry.name ?? '')) ?? list('available')[0] ?? null;
      if (!device) return { missing: { what: 'an iOS Simulator device', why: 'xcrun simctl lists no device to boot.', command: 'xcodebuild -downloadPlatform iOS' } };
      if (invoke(['xcrun', 'simctl', 'boot', device.udid]).code !== 0) return { missing: { what: `the iOS Simulator ${device.name ?? device.udid} booted`, why: 'xcrun simctl boot failed.' } };
      booted = true;
      invoke(['xcrun', 'simctl', 'bootstatus', device.udid, '-b'], Math.max(5_000, deadline - Date.now()));
      ran.push(`booted the iOS Simulator ${device.name ?? device.udid} without a window`);
    }
    try {
      const installed = invoke(['xcrun', 'simctl', 'install', device.udid, build]);
      if (installed.code !== 0) return { missing: { what: `${path.basename(build)} installed in the iOS Simulator`, why: (installed.stderr || installed.stdout).trim().split('\n')[0] || 'xcrun simctl install failed.' }, ran };
      const launched = invoke(['xcrun', 'simctl', 'launch', device.udid, appId]);
      ran.push(`installed ${path.basename(build)} in the iOS Simulator and launched ${appId}`);
      if (launched.code !== 0) return { started: false, crashed: false, detail: (launched.stderr || launched.stdout).trim().slice(0, 600) || 'xcrun simctl launch failed.', ran };
      await sleep(settleMs);
      const services = invoke(['xcrun', 'simctl', 'spawn', device.udid, 'launchctl', 'list']).stdout;
      const line = services.split('\n').find((entry) => entry.includes(`UIKitApplication:${appId}[`) || entry.trim().endsWith(appId));
      const pid = line?.trim().split(/\s+/u)[0];
      const running = Boolean(pid && /^\d+$/u.test(pid));
      ran.push(`checked ${appId} is running ${Math.round(settleMs / 1000)} seconds after launch`);
      return { started: true, crashed: !running, detail: running ? null : `${appId} was not running ${Math.round(settleMs / 1000)} seconds after launch.`, ran,
        tryIt: { kind: 'mobile', commands: [`xcrun simctl install booted '${build}'`, `xcrun simctl launch booted ${appId}`] } };
    } finally {
      invoke(['xcrun', 'simctl', 'terminate', device.udid, appId], 15_000);
      if (booted) invoke(['xcrun', 'simctl', 'shutdown', device.udid], 30_000);
    }
  }

  async function launchAndroid({ build, appId, deadline, adb, emulator, avd }) {
    const ran = [];
    let serial = emulatorSerials(invoke([adb, 'devices']).stdout)[0] ?? null;
    let started = null;
    if (!serial) {
      started = spawnBackground([emulator, '-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save'], { env });
      ran.push(`started the Android emulator ${avd} without a window`);
      while (!serial && Date.now() < deadline) {
        await sleep(2_000);
        serial = emulatorSerials(invoke([adb, 'devices']).stdout)[0] ?? null;
      }
      while (serial && Date.now() < deadline && invoke([adb, '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], 15_000).stdout.trim() !== '1') await sleep(2_000);
      if (!serial || Date.now() >= deadline) {
        started.stop();
        return { missing: { what: `the Android emulator ${avd} booted in time`, why: 'It did not finish booting before the check\'s time ran out.', command: `emulator -avd ${avd}` }, ran };
      }
    }
    try {
      const installed = invoke([adb, '-s', serial, 'install', '-r', build], 180_000);
      if (installed.code !== 0 || /Failure/u.test(installed.stdout)) {
        return { missing: { what: `${path.basename(build)} installed in the Android emulator`, why: (installed.stdout.match(/Failure[^\n]*/u)?.[0] ?? installed.stderr.trim().split('\n')[0]) || 'adb install failed.' }, ran };
      }
      const launched = invoke([adb, '-s', serial, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1']);
      ran.push(`installed ${path.basename(build)} in the Android emulator and launched ${appId}`);
      if (launched.code !== 0 || /No activities found|monkey aborted/iu.test(`${launched.stdout}\n${launched.stderr}`)) {
        return { started: false, crashed: false, detail: `${appId} has no activity the launcher can start: ${(launched.stdout || launched.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 400)}`, ran };
      }
      await sleep(settleMs);
      const pid = invoke([adb, '-s', serial, 'shell', 'pidof', appId], 15_000).stdout.trim();
      ran.push(`checked ${appId} is running ${Math.round(settleMs / 1000)} seconds after launch`);
      const crashLog = pid ? '' : invoke([adb, '-s', serial, 'logcat', '-d', '-b', 'crash', '-t', '40'], 15_000).stdout.trim();
      return { started: true, crashed: !pid, detail: pid ? null : `${appId} was not running ${Math.round(settleMs / 1000)} seconds after launch.`, log: crashLog.split('\n').slice(-12).join('\n'), ran,
        tryIt: { kind: 'mobile', commands: [`adb install -r '${build}'`, `adb shell monkey -p ${appId} -c android.intent.category.LAUNCHER 1`] } };
    } finally {
      invoke([adb, '-s', serial, 'shell', 'am', 'force-stop', appId], 15_000);
      if (started) { invoke([adb, '-s', serial, 'emu', 'kill'], 30_000); started.stop(); }
    }
  }

  return {
    available, home,
    exec: (argv, options = {}) => exec(argv, { env, ...options }),
    async launch(target, options) {
      return target === 'ios' ? launchIos(options) : launchAndroid(options);
    }
  };
}

/** The emulators `adb devices` lists as ready: `emulator-5554`, never a connected phone. */
export function emulatorSerials(text) {
  return String(text ?? '').split('\n').map((line) => line.trim().split(/\s+/u)).filter(([serial, state]) => /^emulator-\d+$/u.test(serial ?? '') && state === 'device').map(([serial]) => serial);
}

const PLATFORM_WORDS = { ios: 'the iOS Simulator', android: 'the Android emulator' };
/** The debug build of an Android module, run where its Gradle build starts (the folder of its settings.gradle or gradlew). */
function androidBuildCommand(tracked, module) {
  const folder = module === '.' ? '' : module;
  const roots = tracked.filter((file) => /(?:^|\/)(?:settings\.gradle(?:\.kts)?|gradlew)$/u.test(file)).map((file) => (file.includes('/') ? path.posix.dirname(file) : ''))
    .filter((dir) => !dir || folder === dir || folder.startsWith(`${dir}/`)).sort((left, right) => right.length - left.length);
  const start = roots[0] ?? '';
  const task = path.posix.relative(start || '.', folder || '.').split('/').filter((part) => part && part !== '.').join(':');
  return `${start ? `cd ${start} && ` : ''}./gradlew ${task ? `:${task}:` : ''}assembleDebug`;
}
const iosBuildCommand = (name) => `xcodebuild -scheme ${name} -sdk iphonesimulator -derivedDataPath build build`;

/**
 * Check the mobile project in `folder`: `{ status, ran, findings, missing, tryIt? }`. `texts` holds the committed text
 * of mobileTextFiles. Never throws for what the laptop lacks.
 */
export async function checkMobileApp(root, { tracked, folder = '', texts = new Map(), deadline, launcher = mobileLauncher(), home = os.homedir() }) {
  const platforms = mobilePlatforms(tracked, folder, texts);
  const targets = [...platforms.android.map((module) => ({ platform: 'android', module })), ...platforms.ios.map((name) => ({ platform: 'ios', name }))];
  if (!targets.length) {
    return { status: 'not-available', ran: [], findings: [], missing: [{ what: 'an Android module or an Xcode project',
      why: 'SFlow launches an Android app (a module with com.android.application) or an iOS app (an .xcodeproj); this project has neither it can read. Launch it in a simulator or emulator yourself and walk its main flow.' }] };
  }
  const ran = []; const findings = []; const missing = []; const tries = [];
  for (const target of targets.slice(0, 2)) {
    const words = PLATFORM_WORDS[target.platform];
    if (Date.now() > deadline) { missing.push({ what: 'time', why: `The check's time ran out before ${words}.` }); continue; }
    const ready = await launcher.available(target.platform);
    if (!ready.available) { missing.push({ what: words, why: ready.why, ...(ready.command ? { command: ready.command } : {}) }); continue; }
    const build = target.platform === 'android' ? await androidBuild(root, target.module) : await iosBuild(root, folder, target.name, { home });
    if (!build) {
      missing.push({ what: `a ${target.platform === 'android' ? 'debug .apk' : 'simulator build'} of the app`, why: `SFlow launches the build the project made, and finds none${target.platform === 'android' ? ` under ${target.module === '.' ? '' : `${target.module}/`}build/outputs/apk` : ' for the iOS Simulator'}.`,
        command: target.platform === 'android' ? androidBuildCommand(tracked, target.module) : iosBuildCommand(target.name) });
      continue;
    }
    const appId = target.platform === 'android' ? androidApplicationId(target.module, texts) : await iosBundleId(build, launcher.exec ?? execCommand);
    if (!appId) { missing.push({ what: `the app's ${target.platform === 'android' ? 'application ID' : 'bundle ID'}`, why: `SFlow could not read it from ${target.platform === 'android' ? 'build.gradle or AndroidManifest.xml' : 'the build\'s Info.plist'}.` }); continue; }
    const result = await launcher.launch(target.platform, { build, appId, deadline, ...ready });
    ran.push(...(result.ran ?? []));
    if (result.missing) { missing.push(result.missing); continue; }
    if (result.tryIt) tries.push(result.tryIt);
    const where = { file: path.relative(root, build) || build, command: appId };
    if (!result.started) {
      findings.push({ type: 'mobile-does-not-start', class: 'breaks-use', title: `${appId} does not start in ${words}`, detail: result.detail ?? 'The launcher could not start it.', where });
    } else if (result.crashed) {
      findings.push({ type: 'mobile-crash-on-launch', class: 'breaks-use', title: `${appId} crashes on launch in ${words}`, detail: result.detail ?? 'It was not running after launch.',
        ...(result.log ? { evidence: { log: result.log } } : {}), where });
    }
  }
  const launched = ran.length > 0 && (findings.length > 0 || tries.length > 0);
  return { status: launched ? (missing.length ? 'partial' : 'ran') : 'not-available', ran, findings, missing,
    ...(tries.length ? { tryIt: { kind: 'mobile', commands: tries.flatMap((entry) => entry.commands) } } : {}) };
}

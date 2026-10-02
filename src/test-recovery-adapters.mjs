/** Bounded, independently inventoried native test adapters. Configuration is not an execution receipt. */
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readTrpNodeCaseInventory, trpNodeExecutionEnvironment } from './test-recovery-node.mjs';
import { parseNativeNodeJunitReport, parseTrpJunitReport } from './code-delivery-tests.mjs';
import { normalizeTestSelectionPath } from './test-selection-policy.mjs';
import { trpDigest } from './test-recovery-policy.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

export const TRP_TEST_ADAPTERS = Object.freeze(['node-test-junit-v1', 'pytest-junit-v1', 'maven-surefire-junit-v1']);
const refuse = message => { throw new SingularityFlowError(message, { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' }); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const within = (root, filename) => filename === root || filename.startsWith(`${root}${path.sep}`);
const ordinary = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);

export function trpCaseInventoryDeclaration(workflow, phase, command) {
  const matches = (workflow.resolution?.testRecovery?.caseInventory ?? []).filter(entry => entry.phaseId === phase.id && entry.commandId === command.id);
  if (matches.length > 1) refuse('The independently approved testcase inventory is ambiguous.');
  return matches[0] ?? null;
}

export function trpExecutionEnvironment(declaration, environment = process.env, { cwd = null } = {}) {
  const result = trpNodeExecutionEnvironment(environment);
  if (declaration?.adapter === 'pytest-junit-v1') {
    for (const key of Object.keys(result)) if (/^(?:PYTEST|PYTHON)/iu.test(key)) delete result[key];
    result.PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1';
  }
  if (declaration?.adapter === 'maven-surefire-junit-v1') {
    for (const key of Object.keys(result)) if (/^(?:MAVEN.*|M2_HOME|CLASSWORLDS_LAUNCHER|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/iu.test(key)) delete result[key];
    result.MAVEN_SKIP_RC = 'true';
    if (cwd) result.MAVEN_BASEDIR = cwd;
  }
  return result;
}

export function trpNativeReportCapture(root, command, declaration) {
  if (!declaration || (declaration.adapter ?? 'node-test-junit-v1') === 'node-test-junit-v1') return null;
  return { root, command: { id: command.id, kind: 'test', argv: [...command.argv],
    workingDirectory: command.workingDirectory, affectedRoots: [...command.affectedRoots], result: { ...command.result } } };
}

async function executablePath(root, command) {
  const executable = command.argv?.[0];
  if (!ordinary(executable)) refuse('The native executable is invalid.');
  if (executable.includes('/') || executable.includes('\\')) return realpath(path.resolve(root, command.workingDirectory ?? '.', executable));
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    const filename = path.resolve(directory, executable);
    if (await lstat(filename).catch(() => null)) return realpath(filename);
  }
  refuse('The declared native runtime is unavailable.');
}

async function fileDigest(filename, { maximumBytes = 512 * 1024 * 1024 } = {}) {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(); const linked = await lstat(filename);
    if (!before.isFile() || linked.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes
      || linked.ino !== before.ino || linked.dev !== before.dev) refuse('A declared runtime/source file is unsafe or oversized.');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(128 * 1024); let total = 0;
    for (;;) { const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; total += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead)); }
    const after = await handle.stat(); const current = await lstat(filename);
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode
      || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) refuse('A declared runtime/source file changed while being hashed.');
    return { sha256: `sha256:${hash.digest('hex')}`, bytes: total, mode: before.mode & 0o7777 };
  } finally { await handle.close(); }
}

/** Root paths are explicitly approved, including external toolchains; no ambient cache is inferred. */
export async function snapshotTrpDeclaredRuntime(root, declaration, command) {
  if (!declaration || (declaration.adapter ?? 'node-test-junit-v1') === 'node-test-junit-v1') return null;
  if (declaration.dependencyScope !== 'repository-and-declared-runtime-only'
    || !/^sha256:[a-f0-9]{64}$/u.test(declaration.runtime?.executableSha256 ?? '')
    || !Array.isArray(declaration.runtime?.dependencyRoots) || !declaration.runtime.dependencyRoots.length
    || declaration.runtime.dependencyRoots.length > 8) refuse('This adapter requires explicit approved native executable and dependency roots.');
  const roots = [];
  for (const value of declaration.runtime.dependencyRoots) {
    if (!ordinary(value) || !path.isAbsolute(value) || path.parse(value).root === path.resolve(value)) refuse('Runtime dependency roots must be explicit non-root absolute paths.');
    roots.push(await realpath(value));
  }
  const executable = await executablePath(root, command);
  if (!roots.some(value => within(value, executable)) || (await fileDigest(executable)).sha256 !== declaration.runtime.executableSha256) {
    refuse('The native executable differs from its independently approved runtime identity.');
  }
  const manifest = []; let entries = 0; let bytes = 0;
  const visit = async (filename, rootIndex, relative, ancestors = new Set()) => {
    if (++entries > 100_000) refuse('Declared runtime dependency traversal exceeds 100000 entries.');
    const info = await lstat(filename);
    if (info.isSymbolicLink()) {
      const link = await readlink(filename); const target = await realpath(filename);
      if (!roots.some(value => within(value, target)) || ancestors.has(target)) refuse('A runtime symlink escapes the approved roots or forms a cycle.');
      manifest.push({ rootIndex, path: relative, type: 'runtime-symlink', target, link });
      await visit(target, rootIndex, `${relative}/@target`, new Set([...ancestors, filename]));
      const after = await lstat(filename);
      if (!after.isSymbolicLink() || after.ino !== info.ino || after.dev !== info.dev || await readlink(filename) !== link) refuse('A runtime symlink changed during capture.');
      return;
    }
    if (!info.isDirectory() && !info.isFile()) refuse('Declared runtime dependencies must be ordinary files and directories.');
    if (info.isDirectory()) {
      manifest.push({ rootIndex, path: relative, type: 'directory', mode: info.mode & 0o7777 });
      const next = new Set([...ancestors, filename]);
      for (const name of (await readdir(filename)).sort()) await visit(path.join(filename, name), rootIndex, relative === '.' ? name : `${relative}/${name}`, next);
      const after = await lstat(filename);
      if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== info.ino || after.dev !== info.dev
        || after.mode !== info.mode || after.mtimeMs !== info.mtimeMs) refuse('A declared runtime dependency directory changed during capture.');
    } else {
      const captured = await fileDigest(filename);
      if ((bytes += captured.bytes) > 2 * 1024 * 1024 * 1024) refuse('Declared runtime dependencies exceed 2 GiB.');
      manifest.push({ rootIndex, path: relative, type: 'file', ...captured });
    }
  };
  for (const [index, filename] of roots.entries()) await visit(filename, index, '.');
  return { executable, roots, sha256: trpDigest({ roots, manifest }), executableSha256: declaration.runtime.executableSha256 };
}

function relativeFile(value, cwd) {
  const normalized = normalizeTestSelectionPath(value);
  if (normalized !== value && value !== `./${normalized}`) refuse('Runner selectors must be literal canonical relative paths.');
  if (/[*?\[\]{}]/u.test(value)) refuse('Globbed test selection is not qualified.');
  return normalizeTestSelectionPath(path.posix.join(cwd, normalized));
}

export async function readTrpCaseInventory(root, workflow, phase, command, { selected = false } = {}) {
  const declaration = trpCaseInventoryDeclaration(workflow, phase, command);
  if (!declaration) return null;
  const adapter = declaration.adapter ?? 'node-test-junit-v1';
  if (!TRP_TEST_ADAPTERS.includes(adapter)) refuse('No qualified failure adapter is available for this runner.');
  if (adapter === 'node-test-junit-v1') return { ...await readTrpNodeCaseInventory(root, workflow, phase, command, { selected }), adapter, declaration };
  if (command.result?.adapter !== 'junit-xml' || !Array.isArray(command.argv)) refuse('Qualified native failure adapters require structured JUnit output.');
  const runtime = await snapshotTrpDeclaredRuntime(root, declaration, command);
  const cwd = normalizeTestSelectionPath(command.workingDirectory ?? '.', { allowRoot: true });
  let files;
  if (adapter === 'pytest-junit-v1') {
    const prefix = ['-I', '-B', '-m', 'pytest', '-p', 'no:cacheprovider'];
    if (JSON.stringify(command.argv.slice(1, 7)) !== JSON.stringify(prefix)) refuse('Pytest requires the isolated direct interpreter and disabled cache provider.');
    const args = command.argv.slice(7); if (args[0] === '-q') args.shift();
    if (args.shift() !== '--noconftest' || args.shift() !== '-c') refuse('Pytest requires disabled conftest and explicit repository-owned configuration.');
    const configuration = relativeFile(args.shift(), cwd);
    await secureRepositoryPath(root, configuration, { mustExist: true, type: 'file', label: 'Isolated pytest configuration' });
    if (args.shift() !== '--override-ini=addopts=' || args.shift() !== `--junitxml=${command.result.path}` || !args.length
      || args.some(value => value.startsWith('-') || value.includes('::'))) refuse('Pytest requires disabled addopts, its exact result path and explicit unfiltered source files.');
    files = args.map(value => relativeFile(value, cwd));
  } else {
    const argv = command.argv.slice(1);
    if (argv.length !== 10 || JSON.stringify(argv.slice(0, 3)) !== JSON.stringify(['-o', '-B', '-ntp'])
      || argv[3] !== '-s' || argv[5] !== '-gs' || argv[4] !== argv[6]
      || !argv[7].startsWith('-Dmaven.repo.local=') || argv[8] !== 'clean' || argv[9] !== 'test') refuse('Maven requires explicit repository-owned settings and the exact offline single-module clean test invocation.');
    await secureRepositoryPath(root, relativeFile(argv[4], cwd), { mustExist: true, type: 'file', label: 'Isolated Maven settings' });
    const javaHome = process.env.JAVA_HOME && await realpath(process.env.JAVA_HOME);
    if (!javaHome || !runtime.roots.some(value => within(value, javaHome))) refuse('Maven requires explicit JAVA_HOME inside its approved runtime roots.');
    const repository = await realpath(argv[7].slice('-Dmaven.repo.local='.length));
    if (!runtime.roots.some(value => within(value, repository))) refuse('The Maven local dependency repository is outside approved runtime roots.');
    if (normalizeTestSelectionPath(command.result.path) !== 'target/surefire-reports') refuse('Maven risk evidence must use the standard single-module Surefire report directory.');
    const pom = await secureRepositoryPath(root, path.posix.join(cwd, 'pom.xml'), { mustExist: true, type: 'file' });
    await fileDigest(pom.absolute, { maximumBytes: 1024 * 1024 });
    const handle = await open(pom.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let xml;
    try { xml = (await handle.readFile('utf8')).replace(/<!--[\s\S]*?-->/gu, ''); } finally { await handle.close(); }
    const customizedClean = [...xml.matchAll(/<plugin\b[^>]*>[\s\S]*?<\/plugin>/gu)].some(([plugin]) =>
      /<artifactId>\s*maven-clean-plugin\s*<\/artifactId>/u.test(plugin) && /<configuration\b/u.test(plugin));
    if (/<(?:parent|modules|profiles|directory|outputDirectory|testOutputDirectory|filesets?|skip|skipTests|excludeDefaultDirectories|fast|maven\.test\.skip|maven\.clean\.[\w.-]+)\b/u.test(xml)
      || /<!DOCTYPE|<!ENTITY|<\/?[A-Za-z_][\w.-]*:/u.test(xml) || customizedClean) {
      refuse('Maven cold-build evidence requires a parentless single module with standard target outputs and uncustomized clean behavior; custom output/clean/profile/skip contracts remain unqualified.');
    }
    if (await lstat(path.resolve(root, cwd, '.mvn')).catch(() => null)) refuse('Maven project launch extensions require a separate qualified adapter.');
    files = [...new Set(declaration.tests.map(entry => entry.path))];
  }
  if (!files.length || new Set(files).size !== files.length || files.length > 256) refuse('The configured native test-file inventory is empty, duplicated or oversized.');
  const ids = new Set(); const nativeIdentities = new Set();
  for (const entry of declaration.tests ?? []) {
    const identity = JSON.stringify([entry.className, entry.name]);
    if (!ordinary(entry.id) || !ordinary(entry.name) || !ordinary(entry.className) || normalizeTestSelectionPath(entry.path) !== entry.path
      || ids.has(entry.id) || nativeIdentities.has(identity)) refuse('Approved native IDs and classname/name pairs must be exact and unique.');
    ids.add(entry.id); nativeIdentities.add(identity);
  }
  const declaredFiles = new Set(declaration.tests.map(entry => entry.path));
  if (files.some(file => !declaredFiles.has(file)) || !selected && [...declaredFiles].some(file => !files.includes(file))) refuse('Selected files differ from the independently approved inventory.');
  const sourceDigests = new Map();
  for (const file of files) {
    const safe = await secureRepositoryPath(root, file, { mustExist: true, type: 'file', label: 'Approved native testcase source' });
    sourceDigests.set(file, (await fileDigest(safe.absolute, { maximumBytes: 1024 * 1024 })).sha256);
  }
  const tests = declaration.tests.filter(entry => files.includes(entry.path)).map(entry => ({ ...entry,
    semanticsSha256: trpDigest({ path: entry.path, className: entry.className, name: entry.name, sourceSha256: sourceDigests.get(entry.path) })
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (tests.length < (command.result.minimumDiscovered ?? 1)) refuse('Approved testcase inventory is below the required discovery minimum.');
  return { adapter, declaration, runtime, tests, files: [...files].sort(), inventorySha256: trpDigest(declaration), selectedSourceSha256: trpDigest([...sourceDigests].sort()) };
}

export async function matchTrpReports(root, inventory, rawReports, { allowSkipped = false, expectedOutcome = 'failed' } = {}) {
  if (!inventory || !Array.isArray(rawReports) || !rawReports.length || rawReports.length > 256) refuse('The exact native report set is unavailable or oversized.');
  const adapter = inventory.adapter ?? 'node-test-junit-v1';
  const parsed = rawReports.map(report => (adapter === 'node-test-junit-v1' ? parseNativeNodeJunitReport : parseTrpJunitReport)(report.contents ?? report));
  const cases = parsed.flatMap(report => report.cases);
  const counts = parsed.reduce((total, report) => Object.fromEntries(Object.keys(total).map(key => [key, total[key] + (report.tests[key] ?? 0)])),
    { discovered: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 });
  if (cases.length !== inventory.tests.length || counts.discovered !== inventory.tests.length || counts.notRun
    || !allowSkipped && counts.skipped || counts.passed + counts.failed < 1
    || expectedOutcome === 'failed' && counts.failed < 1 || expectedOutcome === 'passed' && counts.failed > 0) refuse('The native report does not execute the complete independently approved cohort.');
  const canonicalRoot = await realpath(root); const files = [...new Set(inventory.tests.map(entry => entry.path))]; const seen = new Set();
  const matched = cases.map(entry => {
    let expected;
    if (adapter === 'node-test-junit-v1') {
      if (entry.file != null && !path.isAbsolute(entry.file) || entry.file == null && files.length !== 1) refuse('Native Node report has no unambiguous source identity.');
      const relative = entry.file == null ? files[0] : path.relative(canonicalRoot, entry.file).split(path.sep).join('/');
      expected = inventory.tests.find(test => test.path === relative && test.name === entry.name);
    } else expected = inventory.tests.find(test => test.className === entry.className && test.name === entry.name);
    if (!expected || seen.has(expected.id) || !['passed', 'failed', ...(allowSkipped ? ['skipped'] : [])].includes(entry.outcome)) refuse('Native report identities differ from the independently approved cases.');
    seen.add(expected.id);
    return { id: expected.id, outcome: entry.outcome, semanticsSha256: expected.semanticsSha256, causeSha256: entry.causeSha256 };
  });
  const reportSha256s = rawReports.map(report => digest(report.contents ?? report));
  if (new Set(reportSha256s).size !== reportSha256s.length) refuse('Duplicate report bytes cannot count as independent tests.');
  return { cases: matched.sort((a, b) => a.id.localeCompare(b.id)), counts, reportSha256s };
}

/** Recheck independently captured semantics after execution, including the inventory/snapshot gap. */
export async function verifyTrpCaseInventorySources(root, inventory) {
  if (!inventory) return;
  const bindings = [];
  for (const file of inventory.files) {
    const safe = await secureRepositoryPath(root, file, { mustExist: true, type: 'file', label: 'Executed testcase source' });
    bindings.push([file, (await fileDigest(safe.absolute, { maximumBytes: 1024 * 1024 })).sha256]);
  }
  if (trpDigest(bindings.sort()) !== inventory.selectedSourceSha256) refuse('Executed testcase source differs from its independently captured semantics.');
}

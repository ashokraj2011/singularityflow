import {TEST_REPORT_LIMITS} from './kernel/test-report-codec.mjs';
import {parseXml,nodeTapCounts,replayLocalJavascriptJsonObservation,replayLocalJunitObservation,junitCaseLocations,parseNativeNodeJunitReport,parseTrpJunitReport,replayTestReports,persistedOccurrences,testReceiptPassing,prepareTestReportReader,number,combinedReports,testReportFromContents,consistentTestCounts} from './verification/test-report-reader.mjs';
export {parseXml,nodeTapCounts,replayLocalJavascriptJsonObservation,replayLocalJunitObservation,junitCaseLocations,parseNativeNodeJunitReport,parseTrpJunitReport,replayTestReports,persistedOccurrences,testReceiptPassing,prepareTestReportReader} from './verification/test-report-reader.mjs';
const MAX_RESULT_FILES=TEST_REPORT_LIMITS.maximumFiles,MAX_RESULT_FILE_BYTES=TEST_REPORT_LIMITS.maximumFileBytes,
  MAX_RESULT_TOTAL_BYTES=TEST_REPORT_LIMITS.maximumTotalBytes;
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeExternalCommand, TEST_COMMAND_ECOSYSTEMS } from "./engine-compatibility/node-configuration-path.mjs";
import { canonicalJson } from './foundation/record-schema.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { isTestAutomationPath } from './engine-compatibility/node-source-policy.mjs';
import { isConfigurationPath } from './engine-compatibility/node-source-policy.mjs';
import { exists, posix, secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { isDotnetManifest, selectDotnetManifest } from './dotnet-manifests.mjs';
import { gradleBuildKind } from './gradle-manifests.mjs';
import { SWIFT_TEST_ARGUMENTS, SWIFT_TEST_REPORT_DIRECTORY } from './swift-manifests.mjs';
import { readRepositoryManifest, repositoryManifestExists } from './repository-manifest.mjs';
import { ecosystemOfAdapter, ecosystemOfProgram } from './test-runners.mjs';

const SUPPORTING_SEGMENTS = new Set([
  '__fixtures__', '__mocks__', '__snapshots__', 'fixture', 'fixtures', 'page-object', 'page-objects', 'pageobjects',
  'reports', 'results', 'snapshots', 'test-data', 'testdata'
]);
const SUPPORTING_BASENAMES = /^(?:readme(?:\.[^.]+)?|(?:playwright|cypress|jest|vitest|pytest)\.config\.[^.]+)$/i;
const SUPPORTING_EXTENSIONS = /\.(?:snap|snapshot|golden|md|mdx|txt|csv|tsv|json|ya?ml|xml|toml|properties)$/i;
const TEST_SOURCE_NAMES = [
  /(?:^|[._-])(?:test|tests|spec|e2e)(?:[._-]|$)/i,
  /(?:Test|Tests|Spec)\.(?:java|kt|kts|scala|cs|fs|vb|swift|php)$/,
  /[a-z\d]IT(?:Case)?\.(?:java|kt|groovy|scala)$/,
  /^(?:test_.+|.+_test)\.py$/i,
  /_test\.go$/i,
  /(?:^|_)tests?\.rs$/i
];
const TEST_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.cts', '.cxx', '.fs', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.mts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.ts', '.tsx', '.vb'
]);
// Jest's default testMatch runs every script below a `__tests__` folder, whatever it is called
// (`__tests__/value.js`); its fixtures, mocks and snapshots are support, and a declaration file is not a test.
const JEST_TEST_SCRIPT = /\.[cm]?[jt]sx?$/iu;
const DECLARATION_FILE = /\.d\.[cm]?ts$/iu;
const MAX_RESULT_DEPTH = 8;

const MANIFESTS = Object.freeze({
  'pom.xml': 'maven',
  'settings.gradle': 'gradle', 'settings.gradle.kts': 'gradle',
  'build.gradle': 'gradle', 'build.gradle.kts': 'gradle',
  'package.json': 'node',
  'pyproject.toml': 'python', 'pytest.ini': 'python', 'tox.ini': 'python',
  'go.mod': 'go', 'Cargo.toml': 'rust', 'Package.swift': 'swift'
});
export const TEST_SETUP_COMMAND = 'singularity-flow capability test-setup --json';
const TEST_POLICY_AMEND_COMMAND = 'singularity-flow story test-policy amend --reason <why>';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(candidate) {
  return posix(String(candidate ?? '')).replace(/^\.\//, '');
}

/** Whether a script is a test by Jest's folder rule: below `__tests__`, outside its support folders. */
function jestTestFolderScript(relative) {
  const directories = relative.toLowerCase().split('/').slice(0, -1);
  return directories.includes('__tests__') && !directories.some((segment) => SUPPORTING_SEGMENTS.has(segment))
    && JEST_TEST_SCRIPT.test(relative) && !DECLARATION_FILE.test(relative);
}

/** Whether a source path's name marks it as a test: its own (`_test.go`, `test_x.py`, `FooTest.java`), or Jest's `__tests__` folder. */
function testNamed(relative) {
  return TEST_SOURCE_NAMES.some((pattern) => pattern.test(path.posix.basename(relative))) || jestTestFolderScript(relative);
}

/** Whether a file's name marks it as a test, in any directory: `_test.go`, `test_x.py`, `FooTest.java`, `__tests__/value.js`. */
export function isTestSourceName(candidate) {
  const relative = normalized(candidate);
  return TEST_SOURCE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) && testNamed(relative);
}

/**
 * Which changed paths a test command is evidence for [TCE:REQ-052, TCE:REQ-053].
 *
 * A command a person configured or accepted covers the affected roots they gave it. A command
 * Singularity Flow inferred runs one ecosystem's tests, so below its roots (the whole repository
 * included) it covers only that ecosystem's source and files of no language (configuration,
 * documents, assets, C and C++ that a package builds): `npm test` is never evidence for a `.py` or
 * `.swift` file, and pytest never for a `.ts` one. A command that names its `ecosystem` (a test
 * setup suggestion accepted as offered keeps its own) is read the same way, so a root `mvn test`
 * accepted with `affectedRoots: ['.']` never covers the `.js` beside it. Publication, submission,
 * recovery and witness discovery all ask this one question. A record that does not say where its
 * command came from (an older receipt) keeps its roots.
 */
const LANGUAGE = /\.(?:([cm]?[jt]sx?|vue|svelte)|(pyx?|pyi)|(java|kts?|scala|groovy)|(cs|fsx?|vb)|(go)|(rs)|(swift|mm?)|(rb|erb|rake)|(php)|(dart))$/iu;
// In LANGUAGE's group order; a command's `ecosystem` names one of them.
const ECOSYSTEMS = TEST_COMMAND_ECOSYSTEMS;
// A JUnit report's ecosystem is its launcher's: a package manager or Node, a Python interpreter or project tool, or a runner's own program.
const LAUNCHERS = [[/^(?:npm|npx|pnpm|yarn|bunx?|node)$/u, 'node'], [/^(?:py(?:thon[\d.]*)?|uv|poetry)$/u, 'python']];
const lastSegment = (value) => String(value ?? '').split(/[\\/]/u).at(-1);

/** The ecosystem whose source a file is, by its extension, or null for a file of no language. */
export function sourceEcosystem(candidate) {
  const match = LANGUAGE.exec(lastSegment(candidate));
  return match ? ECOSYSTEMS[match.slice(1).findIndex(Boolean)] : null;
}

/** The ecosystem an inferred command's runner tests: its report adapter, else its launcher. */
export function testCommandEcosystem(command) {
  const launcher = lastSegment(command?.argv?.[0]).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '');
  return ecosystemOfAdapter(command?.result?.adapter) ?? LAUNCHERS.find(([pattern]) => pattern.test(launcher))?.[1] ?? ecosystemOfProgram(launcher);
}

/** Whether `command` (with its `provenance` or declared `ecosystem`) covers a changed repository path. */
export function testCommandCoversPath(command, candidate) {
  const relative = String(candidate).replace(/^\.\//u, '');
  const below = (command?.affectedRoots ?? []).some((root) => {
    const prefix = String(root).replaceAll('\\', '/').replace(/^\.\/|\/+$/gu, '') || '.';
    return prefix === '.' || relative === prefix || relative.startsWith(`${prefix}/`);
  });
  const ecosystem = command?.ecosystem ?? (command?.provenance === 'inferred' && testCommandEcosystem(command));
  // An Android device test is run only by a connected (device) command [TCE:REQ-075].
  return below && (ecosystem === false || ([null, ecosystem].includes(sourceEcosystem(relative))
    && !(ecosystem === 'jvm' && /(?:^|\/)src\/androidTest\//u.test(relative) && !/AndroidTest$/u.test(command.argv?.at(-1)))));
}

export function isAllowedTestAutomationPath(candidate) {
  return isTestAutomationPath(candidate);
}

export function isSupportingTestResourcePath(candidate) {
  const relative = normalized(candidate);
  const segments = relative.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return isConfigurationPath(relative) || segments.some((segment) => SUPPORTING_SEGMENTS.has(segment))
    || SUPPORTING_BASENAMES.test(basename)
    || SUPPORTING_EXTENSIONS.test(basename)
    || /(?:^|[._-])(?:fixture|snapshot|page-object|pageobject)(?:[._-]|$)/i.test(basename);
}

export async function isExecutableTestSourcePath(root, candidate, { sourceExtensions = [] } = {}) {
  const relative = normalized(candidate);
  if (!isAllowedTestAutomationPath(relative) || isSupportingTestResourcePath(relative)) return false;
  const extension = path.posix.extname(relative).toLowerCase();
  if (!TEST_SOURCE_EXTENSIONS.has(extension) && !new Set(sourceExtensions.map((item) => item.toLowerCase())).has(extension)) return false;
  if (!testNamed(relative)) return false;
  try {
    const info = await lstat(path.join(root, relative));
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function parentDirectories(candidate) {
  let current = path.posix.dirname(normalized(candidate));
  const directories = [];
  while (true) {
    directories.push(current === '.' ? '' : current);
    if (!current || current === '.') break;
    current = path.posix.dirname(current);
  }
  return directories;
}

/** The supported build manifests in a directory, and its listing. */
async function manifestsAt(root, directory) {
  const found = [];
  for (const [name, system] of Object.entries(MANIFESTS)) {
    if (await exists(path.join(root, directory, name))) found.push({ name, system });
  }
  let names = [];
  try { names = (await readdir(path.join(root, directory || '.'))).sort(); }
  catch { /* Missing directory is handled by the caller's changed-path validation. */ }
  return { manifests: [...found, ...names.filter(isDotnetManifest).map((name) => ({ name, system: 'dotnet' }))], names };
}

/**
 * A build manifest's JSON, or a refusal naming the file and where the parser stopped. A malformed
 * package.json aborted test detection with a bare SyntaxError that named no file and no repair.
 */
export function parseTestManifest(text, relative) {
  try { return JSON.parse(text); }
  catch (error) {
    const at = /position (\d+)(?: \(line (\d+) column (\d+)\))?/u.exec(error.message);
    throw new SingularityFlowError(`${relative} is not valid JSON (${error.message}), so no test command can be inferred from it. `
      + `Fix the JSON in ${relative}, then run the command again.`,
    { code: 'TEST_MANIFEST_INVALID', details: { path: relative, position: at ? Number(at[1]) : null,
      line: at?.[2] ? Number(at[2]) : null, column: at?.[3] ? Number(at[3]) : null } });
  }
}

/** Where a test-configuration refusal goes next: inspect runner suggestions, then a reviewed amendment. */
export function testSetupRoute(extra = {}) {
  return { ...extra, nextAction: { command: TEST_SETUP_COMMAND }, recoveryCommands: [TEST_SETUP_COMMAND, TEST_POLICY_AMEND_COMMAND] };
}

/**
 * Approved configured test commands as module owners: each affected root (`.` is the whole
 * repository) owns the paths below it, so the command an approver configured decides coverage there
 * instead of a manifest guess. Only `kind: test` commands count.
 */
export function configuredTestModuleOverrides(commands = []) {
  const overrides = {};
  for (const command of commands ?? []) {
    if (!command || typeof command !== 'object' || Array.isArray(command) || command.kind !== 'test') continue;
    for (const candidate of command.affectedRoots ?? []) {
      const prefix = normalized(candidate).replace(/\/+$/u, '') || '.';
      overrides[prefix] ??= { root: prefix, system: 'configured', manifest: null };
    }
  }
  return overrides;
}

function overrideFor(relative, overrides) {
  const specificity = (prefix) => (prefix === '.' ? 0 : prefix.length + 1);
  return Object.entries(overrides ?? {})
    .map(([prefix, value]) => [normalized(prefix).replace(/\/+$/u, '') || '.', value])
    .filter(([prefix]) => prefix === '.' || relative === prefix || relative.startsWith(`${prefix}/`))
    .sort(([left], [right]) => specificity(right) - specificity(left) || left.localeCompare(right))[0] ?? null;
}

/** Resolve the nearest build owner; two build systems at that root are intentionally ambiguous. */
export async function resolveAffectedModule(root, candidate, { overrides = {} } = {}) {
  const relative = normalized(candidate);
  const explicit = overrideFor(relative, overrides);
  if (explicit) return { root: explicit[1].root ?? explicit[0], system: explicit[1].system, manifest: explicit[1].manifest ?? null, configured: true };
  for (const directory of parentDirectories(relative)) {
    const { manifests, names } = await manifestsAt(root, directory);
    // Another ecosystem's build file stops the walk: its Python module, or a refusal [TCE:REQ-051].
    const foreign = await (await import('./test-module-markers.mjs')).foreignBuildModule(root, directory, relative, names, manifests);
    if (foreign) return foreign;
    if (!manifests.length) {
      // An Nx project keeps its targets in project.json. One with a Jest or Vitest target, or tested by a
      // Playwright target (its own, or the e2e project's beside it), is a module; any other keeps the one above.
      const nx = await exists(path.join(root, directory, 'project.json'))
        ? await (await import('./nx-test-targets.mjs')).nxTestProjectDirectory(root, directory || '.') : null;
      if (nx) return { root: nx, system: 'nx', manifest: 'project.json', configured: false };
      continue;
    }
    const systems = [...new Set(manifests.map((entry) => entry.system))];
    if (systems.length > 1) {
      throw new SingularityFlowError(
        `Changed path '${relative}' maps to multiple build systems at '${directory || '.'}': ${systems.join(', ')}. `
        + 'No runner is guessed; an approved configured test command covering this path decides which one runs.',
        { code: 'TEST_MODULE_AMBIGUOUS', details: testSetupRoute({ path: relative, directory: directory || '.', systems }) }
      );
    }
    return { root: directory || '.', system: systems[0],
      manifest: systems[0] === 'dotnet' ? selectDotnetManifest(manifests.map((entry) => entry.name)) : manifests[0].name, configured: false };
  }
  throw new SingularityFlowError(`No supported build manifest owns changed path '${relative}'.`, {
    code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ path: relative })
  });
}

function executable(platform, unix, windows) {
  return platform === 'win32' ? windows : unix;
}

async function ordinaryDirectory(candidate) {
  try {
    const info = await lstat(candidate);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch { return false; }
}

async function pythonVenvMetadata(venv) {
  if (!await ordinaryDirectory(venv)) return false;
  const config = path.join(venv, 'pyvenv.cfg');
  try {
    const info = await lstat(config);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > 16 * 1024) return false;
    const contents = await readFile(config, 'utf8');
    return /^home\s*=\s*\S+/mu.test(contents)
      && /^(?:version|version_info|virtualenv|include-system-site-packages)\s*=\s*\S+/mu.test(contents);
  } catch { return false; }
}

async function usablePythonInterpreter(candidate, platform) {
  try {
    const link = await lstat(candidate);
    if (platform === 'win32' && link.isSymbolicLink()) return false;
    if (!link.isFile() && !link.isSymbolicLink()) return false;
    const target = await stat(candidate);
    if (!target.isFile()) return false;
    if (platform !== 'win32') {
      const canonical = await realpath(candidate);
      if (!/^python(?:\d+(?:\.\d+)*)?$/iu.test(path.basename(canonical))) return false;
      await access(candidate, fsConstants.X_OK);
    }
    return true;
  } catch { return false; }
}

async function projectPythonLauncher(root, moduleRoot, platform) {
  const repositoryRoot = path.resolve(root);
  const relativeModule = path.posix.normalize(posix(String(moduleRoot ?? '.')));
  if (path.posix.isAbsolute(relativeModule) || relativeModule === '..'
      || relativeModule.startsWith('../') || /^[a-z]:/iu.test(relativeModule)) {
    throw new SingularityFlowError(`Python module root '${moduleRoot}' escapes the repository.`, {
      code: 'TEST_MODULE_UNCOVERED'
    });
  }
  const owners = relativeModule === '.' ? ['.'] : [relativeModule, '.'];
  for (const owner of owners) {
    const securedOwner = await secureRepositoryPath(repositoryRoot, owner, {
      label: 'Python test module', mustExist: owner === '.', type: 'directory'
    });
    const ownerPath = securedOwner.absolute;
    const venv = path.join(ownerPath, '.venv');
    if (!await pythonVenvMetadata(venv)) continue;
    const scripts = platform === 'win32' ? 'Scripts' : 'bin';
    if (!await ordinaryDirectory(path.join(venv, scripts))) continue;
    const names = platform === 'win32' ? ['python.exe'] : ['python3', 'python'];
    for (const name of names) {
      const candidate = path.join(venv, scripts, name);
      if (!await usablePythonInterpreter(candidate, platform)) continue;
      // The Windows launcher verifies relative executables below its cwd. A repository-root
      // interpreter for a nested module is outside that boundary, so identify it absolutely.
      if (platform === 'win32' && owner === '.' && relativeModule !== '.') return candidate;
      const repositoryRelative = path.posix.join(owner === '.' ? '' : owner, '.venv', scripts, name);
      const fromModule = path.posix.relative(relativeModule, repositoryRelative);
      return fromModule.startsWith('../') ? fromModule : `./${fromModule}`;
    }
  }
  return null;
}

/** An Nx project's test target (src/nx-test-targets.mjs), loaded only for an Nx project. */
async function nxTestCommand(root, moduleRoot, options) {
  return (await import('./nx-test-targets.mjs')).nxTestCommand(root, moduleRoot, {
    ...options, packageManager: (workspace, manifest) => nodePackageManager(root, workspace, manifest)
  });
}

export async function nodePackageManager(root, moduleRoot, manifest) {
  const declared = String(manifest.packageManager ?? '').split('@')[0].toLowerCase();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  let current = moduleRoot === '.' ? '' : normalized(moduleRoot);
  while (true) {
    const at = (name) => exists(path.join(root, current, name));
    if (await at('pnpm-lock.yaml')) return 'pnpm';
    if (await at('yarn.lock')) return 'yarn';
    if (await at('bun.lockb') || await at('bun.lock')) return 'bun';
    if (await at('package-lock.json') || await at('npm-shrinkwrap.json')) return 'npm';
    if (!current) break;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
  return 'npm';
}

/** The nearest directory from a module up to the repository root that holds this wrapper, or null. */
export async function nearestWrapper(root, moduleRoot, name) {
  let current = moduleRoot === '.' ? '' : normalized(moduleRoot);
  while (true) {
    if (await repositoryManifestExists(root, path.posix.join(current, name))) return current || '.';
    if (!current) return null;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}

/** An ancestor wrapper run from the module directory: `../../mvnw`, or `..\..\mvnw.cmd`. */
function wrapperFrom(platform, upward, unix, windows) {
  return platform === 'win32' ? `${upward.replaceAll('/', '\\')}\\${windows}` : `${upward}/${unix}`;
}

/** Whether every POM from the reactor root down declares the next directory as a `<module>`. */
/** The modules a pom declares below itself, each as its path's parts. */
export function declaredMavenModules(pom) {
  return [...String(pom ?? '').replace(/<!--[\s\S]*?-->/gu, '').matchAll(/<module>\s*([^<]+?)\s*<\/module>/gu)]
    .map((match) => path.posix.normalize(match[1].replaceAll('\\', '/').replace(/\/pom\.xml$/u, '').replace(/\/+$/u, '')).split('/'))
    .filter((parts) => parts.length && !parts.includes('..') && parts[0] !== '.');
}

async function mavenReactorDeclares(root, reactorRoot, below) {
  let current = reactorRoot === '.' ? '' : reactorRoot;
  let remaining = below.split('/');
  while (remaining.length) {
    let pom;
    try { pom = (await readRepositoryManifest(root, path.posix.join(current, 'pom.xml'))).bytes.toString('utf8'); } catch { return false; }
    const declared = declaredMavenModules(pom)
      .filter((parts) => parts.every((part, index) => remaining[index] === part))
      .sort((left, right) => right.length - left.length)[0];
    if (!declared) return false;
    current = path.posix.join(current, ...declared);
    remaining = remaining.slice(declared.length);
  }
  return true;
}

export async function inferModuleTestCommand(root, module, {
  platform = process.platform,
  nodeScript = 'test',
  scriptAlone = false,
  unitOnly = false
} = {}) {
  const cwd = module.root === '.' ? '' : module.root;
  const at = (name) => repositoryManifestExists(root, path.posix.join(cwd, name));
  const resultBase = `.sflow/results/${module.system}-tests`;
  switch (module.system) {
    case 'maven': {
      const wrapperRoot = await nearestWrapper(root, module.root, platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
      const ancestor = wrapperRoot !== null && wrapperRoot !== module.root;
      const below = ancestor ? path.posix.relative(wrapperRoot === '.' ? '' : wrapperRoot, module.root) : null;
      // A multi-module build keeps one wrapper at its reactor root. Run that wrapper for this
      // module (and the modules it needs) when the reactor declares it; otherwise run it from here.
      const reactor = ancestor && await mavenReactorDeclares(root, wrapperRoot, below);
      const launcher = ancestor && !reactor
        ? wrapperFrom(platform, path.posix.relative(module.root, wrapperRoot === '.' ? '' : wrapperRoot), 'mvnw', 'mvnw.cmd')
        : executable(platform, './mvnw', '.\\mvnw.cmd');
      // With the failsafe plugin bound, `verify` runs the integration tests and its reports sit beside
      // surefire's. Readiness's unit-only run stays on `test`, which never starts them or their services.
      const goal = !unitOnly && await (await import('./test-module-markers.mjs')).mavenRunsIntegrationTests(root, module.root) ? 'verify' : 'test';
      const reports = `target/${goal === 'verify' ? 'failsafe' : 'surefire'}-reports`;
      return {
        id: `${module.root}-maven-tests`, kind: 'test',
        argv: wrapperRoot === null ? ['mvn', goal] : reactor ? [launcher, '-pl', below, '-am', goal] : [launcher, goal],
        workingDirectory: reactor ? wrapperRoot : module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: reactor ? `${below}/${reports}` : reports, minimumDiscovered: 1 }
      };
    }
    case 'gradle': {
      // A multi-project build keeps one wrapper at its root; `-p` runs this module's test task.
      const wrapperRoot = await nearestWrapper(root, module.root, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      for (const name of ['build.gradle', 'build.gradle.kts']) {
        if (!await at(name)) continue;
        const text = (await readRepositoryManifest(root, path.posix.join(cwd, name))).bytes.toString('utf8');
        const kind = gradleBuildKind(text);
        // An Android module runs its variant's unit tests, and its device tests (src/test-module-markers.mjs).
        if (kind.android || kind.requiresTestTarget) {
          return (await (await import('./test-module-markers.mjs')).androidTestCommands(root, module, { text, name, kind, wrapperRoot, platform }))[0];
        }
      }
      const ancestor = wrapperRoot !== null && wrapperRoot !== module.root;
      const below = ancestor ? path.posix.relative(wrapperRoot === '.' ? '' : wrapperRoot, module.root) : null;
      const launcher = executable(platform, './gradlew', '.\\gradlew.bat');
      return {
        id: `${module.root}-gradle-tests`, kind: 'test',
        argv: wrapperRoot === null ? ['gradle', 'test'] : ancestor ? [launcher, '-p', below, 'test'] : [launcher, 'test'],
        workingDirectory: ancestor ? wrapperRoot : module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: ancestor ? `${below}/build/test-results/test` : 'build/test-results/test', minimumDiscovered: 1 }
      };
    }
    case 'node': {
      // A package's scripts name several runners (src/test-module-markers.mjs); this is its first command.
      const manifestPath = path.posix.join(cwd, 'package.json');
      const manifest = parseTestManifest((await readRepositoryManifest(root, manifestPath)).bytes.toString('utf8'), manifestPath);
      const [command] = await (await import('./test-module-markers.mjs')).nodeTestCommands(root, module, {
        manager: await nodePackageManager(root, module.root, manifest), unitOnly, nodeScript, scriptAlone
      });
      // An Nx project with a package.json of its own still runs its tests through Nx.
      return command ?? (await exists(path.join(root, cwd, 'project.json')) ? nxTestCommand(root, module.root, { unitOnly, nodeScript }) : null);
    }
    case 'nx': return nxTestCommand(root, module.root, { unitOnly, nodeScript });
    case 'python': {
      const tool = await (await import('./test-module-markers.mjs')).pythonProjectLauncher(root, module.root);
      const projectPython = !tool && await projectPythonLauncher(root, module.root, platform);
      return {
        id: `${module.root}-python-tests`, kind: 'test',
        argv: tool ? [...tool, '-B', '-m', 'pytest', '-p', 'no:cacheprovider', `--junitxml=${resultBase}.xml`] : projectPython
          ? [projectPython, '-B', '-m', 'pytest', '-p', 'no:cacheprovider', `--junitxml=${resultBase}.xml`]
          : platform === 'win32'
            ? ['py', '-3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', `--junitxml=${resultBase}.xml`]
            : ['python3', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', `--junitxml=${resultBase}.xml`],
        workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: resultBase + '.xml', minimumDiscovered: 1 }
      };
    }
    case 'go': return {
      id: `${module.root}-go-tests`, kind: 'test', argv: ['go', 'test', '-json', './...'], workingDirectory: module.root,
      affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: 'go-test-json', path: resultBase + '.jsonl', minimumDiscovered: 1 }
    };
    case 'rust': {
      const { proposedRunner } = await import('./test-module-markers.mjs');
      const offered = await proposedRunner(root, module.root);
      throw new SingularityFlowError(
        `Rust module '${module.root}' requires an explicit argv-form test command with a structured result adapter; stable cargo test output does not provide testcase counts.${offered ? ` ${offered.words}` : ''}`,
        { code: 'RUST_TEST_ADAPTER_REQUIRED', ...(offered ? { details: { proposal: offered.proposal } } : {}) }
      );
    }
    case 'dotnet': {
      if (module.manifest && !await at(module.manifest)) throw new SingularityFlowError(
        `The selected .NET build manifest is missing: ${module.manifest}.`, { code: 'TEST_MODULE_UNCOVERED' }
      );
      // A project's tests are its own, or the test projects that reference it (src/test-module-markers.mjs).
      const [tests] = await (await import('./test-module-markers.mjs')).dotnetTestCommands(root, module) ?? [];
      return tests ?? {
        id: `${module.root}-dotnet-tests`, kind: 'test', argv: ['dotnet', 'test', ...(module.manifest ? [module.manifest] : []), '--logger', 'trx', '--results-directory', 'TestResults'], workingDirectory: module.root,
        affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'dotnet-trx', path: 'TestResults', minimumDiscovered: 1 }
      };
    }
    case 'swift': {
      if (!await at(module.manifest ?? 'Package.swift')) throw new SingularityFlowError(
        `The Swift package manifest is missing: ${module.manifest ?? 'Package.swift'}.`, { code: 'TEST_MODULE_UNCOVERED' }
      );
      return {
        id: `${module.root}-swift-tests`, kind: 'test',
        // XCTest XML needs parallel execution on older SwiftPM versions. Separate argv also
        // avoids versions that mis-handle --xunit-output=<path>. Swift Testing emits a companion
        // XML file; use a dedicated directory so neither framework's results are discarded.
        argv: ['swift', ...SWIFT_TEST_ARGUMENTS], workingDirectory: module.root,
        affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: SWIFT_TEST_REPORT_DIRECTORY, minimumDiscovered: 1 }
      };
    }
    case 'xcode': throw new SingularityFlowError(
      'Xcode tests require an explicit approved scheme, destination and structured result command; no simulator or test target was guessed.',
      { code: 'XCODE_TEST_TARGET_REQUIRED' }
    );
    default: throw new SingularityFlowError(`Unsupported build system '${module.system}'.`, { code: 'TEST_MODULE_UNCOVERED' });
  }
}

function lowerTokens(command) {
  return (command.argv ?? []).map((value) => String(value).toLowerCase());
}

export function testSuppression(command) {
  const normalizedCommand = normalizeExternalCommand(command);
  const tokens = lowerTokens(normalizedCommand);
  const joined = tokens.join(' ');
  const adapter = normalizedCommand.result?.adapter;
  const compact = (value) => value.replace(/[_.-]/g, '');
  if (tokens.some((token) => /^-d(?:maven\.test\.skip|skiptests)(?:=(?:true|1|yes|on))?$/i.test(token))) return 'Maven test execution is disabled.';
  const excludedTask = (value) => String(value ?? '').split('=').at(-1).split(':').filter(Boolean).at(-1) === 'test';
  if (tokens.some((token, index) => ['-x', '--exclude-task', '--exclude-task='].some((flag) => token === flag || token.startsWith(flag))
    && (excludedTask(token) || excludedTask(tokens[index + 1])))) return 'Gradle test execution is excluded.';
  if (tokens.some((token) => compact(token.replace(/^--/, '')) === 'passwithnotests')) return 'The command permits zero discovered tests.';
  if (tokens.some((token) => ['collectonly', 'co'].includes(compact(token.replace(/^-+/, ''))))) return 'Pytest is configured for collection only.';
  if (tokens.some((token) => ['list', 'listonly'].includes(compact(token.replace(/^-+/, '')))) && (adapter === 'playwright-json' || joined.includes('playwright'))) return 'Playwright is configured for list-only mode.';
  if (tokens.some((token) => ['dryrun', 'dry'].includes(compact(token.replace(/^-+/, ''))))) return 'The test command is configured as a dry run.';
  return null;
}

export function normalizeRequiredTestCommand(value, index = 0) {
  if (typeof value === 'string') {
    throw new SingularityFlowError(`qualityCommands[${index}] must use object argv form for required code-delivery testing.`, {
      code: 'CODE_TEST_RESULT_REQUIRED', details: { configurationDependency: true, commandIndex: index }
    });
  }
  let command;
  try {
    command = normalizeExternalCommand(value, index);
  } catch {
    // The validator may reject a malformed argv/result before the code-delivery check can
    // classify it. Do not expose configured argv in the refusal or misroute this as a source
    // authoring problem: the accepted test-command contract is a separate policy boundary.
    throw new SingularityFlowError(`qualityCommands[${index}] has invalid structured test configuration.`, {
      code: 'CODE_TEST_RESULT_REQUIRED', details: { configurationDependency: true, commandIndex: index }
    });
  }
  if (command.kind !== 'test' || !command.argv?.length || !command.workingDirectory
      || !command.affectedRoots?.length || !command.result) {
    throw new SingularityFlowError(
      `qualityCommands[${index}] must declare kind: test, argv, workingDirectory, affectedRoots, and a result adapter.`,
      { code: 'CODE_TEST_RESULT_REQUIRED', details: { configurationDependency: true, commandIndex: index } }
    );
  }
  const suppression = testSuppression(command);
  if (suppression) throw new SingularityFlowError(suppression, {
    code: 'CODE_TEST_SUPPRESSED', details: { configurationDependency: true, commandIndex: index }
  });
  return command;
}

export function structuredTestCommandRequiredError(phase, { workId = null, paths = [] } = {}) {
  return new SingularityFlowError(
    `Phase ${phase.id} has no structured repository test command and Singularity Flow could not infer one. `
    + 'An in-scope repository test script or runner declaration may be repaired in this Story, then '
    + 'phase recovery can be rechecked. Do not edit protected workflow configuration on the Story '
    + 'branch. If repository-owned runner repair is impossible, configure kind: test, argv, '
    + 'workingDirectory, affectedRoots, and a result adapter through approved configuration '
    + 'authority. An eligible current Story can preview story test-policy amend to adopt '
    + 'that exact approved command with live human review; configuration refresh alone '
    + 'does not change its pin. Unsupported Stories need the returned repair route or '
    + 'deterministic support for the native runner. A person who approves the step may instead accept '
    + 'a Story-only command requested with singularity-flow decision test-command.',
    {
      code: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED',
      details: {
        phase: phase.id, ...(workId ? { workId } : {}), paths: (paths ?? []).slice(0, 20),
        diagnosticAction: { command: `singularity-flow recover --phase ${phase.id} --json` },
        remediation: { action: 'repair-in-scope-repository-runner-or-review-test-command-amendment' }
      }
    }
  );
}

async function resultFiles(absolute, adapter, state = { files: 0 }, depth = 0) {
  if (depth > MAX_RESULT_DEPTH) {
    throw new SingularityFlowError(`Structured test result directory exceeds depth ${MAX_RESULT_DEPTH}.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  // Maven's verify writes unit reports beside the integration ones: a failsafe-reports result reads both [TCE:REQ-073].
  const beside = !depth && adapter === 'junit-xml' && path.basename(absolute) === 'failsafe-reports'
    ? await resultFiles(path.join(path.dirname(absolute), 'surefire-reports'), adapter, state, 1) : [];
  const info = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info || info.isSymbolicLink()) return beside;
  if (info.isFile()) {
    if (++state.files > MAX_RESULT_FILES) throw new SingularityFlowError(`Structured test results exceed ${MAX_RESULT_FILES} files.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
    return [{ absolute, info }];
  }
  if (!info.isDirectory() || !['junit-xml', 'dotnet-trx'].includes(adapter)) return [];
  const extension = adapter === 'dotnet-trx' ? /\.trx$/i : /\.xml$/i;
  const output = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const target = path.join(absolute, entry.name);
    if (entry.isDirectory()) output.push(...await resultFiles(target, adapter, state, depth + 1));
    else if (entry.isFile() && extension.test(entry.name) && entry.name !== 'failsafe-summary.xml') {
      if (++state.files > MAX_RESULT_FILES) throw new SingularityFlowError(`Structured test results exceed ${MAX_RESULT_FILES} files.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
      output.push({ absolute: target, info: await lstat(target) });
    }
  }
  return [...beside, ...output].sort((left, right) => left.absolute.localeCompare(right.absolute));
}

async function boundedDescriptorRead(handle, before, { label, code }) {
  const contents = Buffer.allocUnsafe(before.size);
  let offset = 0;
  while (offset < contents.length) {
    const { bytesRead } = await handle.read(
      contents, offset, Math.min(64 * 1024, contents.length - offset), offset
    );
    if (!bytesRead) break;
    offset += bytesRead;
  }
  const growthProbe = Buffer.allocUnsafe(1);
  const { bytesRead: grew } = await handle.read(growthProbe, 0, 1, before.size);
  const after = await handle.stat();
  if (grew || offset !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new SingularityFlowError(`${label} changed while it was being read.`, { code });
  }
  return contents;
}

async function readResultFile(root, file) {
  let handle;
  try {
    const relative = posix(path.relative(root, file.absolute));
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Structured test result', mustExist: true, type: 'file'
    });
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(secured.absolute, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw new SingularityFlowError(
        `Structured test result must be one regular, non-hard-linked file: ${path.basename(file.absolute)}`,
        { code: 'CODE_TEST_RESULT_REQUIRED' }
      );
    }
    if (before.size > MAX_RESULT_FILE_BYTES) {
      throw new SingularityFlowError(
        `Structured test result exceeds ${MAX_RESULT_FILE_BYTES} bytes: ${path.basename(file.absolute)}`,
        { code: 'CODE_TEST_RESULT_REQUIRED' }
      );
    }
    if ((file.info.ino && before.ino && file.info.ino !== before.ino)
        || (file.info.dev && before.dev && file.info.dev !== before.dev)) {
      throw new SingularityFlowError(
        `Structured test result changed while it was being opened: ${path.basename(file.absolute)}`,
        { code: 'CODE_TEST_RESULT_REQUIRED' }
      );
    }
    return await boundedDescriptorRead(handle, before, {
      label: `Structured test result '${path.basename(file.absolute)}'`,
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(
      `Structured test result could not be read safely: ${path.basename(file.absolute)}: ${error.message}`,
      { code: 'CODE_TEST_RESULT_REQUIRED', cause: error }
    );
  } finally {
    await handle?.close();
  }
}

/** Read a persisted local-observation artifact without following links or accepting mutable bytes. */
export async function readDurableTestObservation(root, relativePath, {
  expectedSha256 = null,
  expectedBytes = null
} = {}) {
  let handle;
  try {
    const secured = await secureRepositoryPath(root, relativePath, {
      label: 'Durable local test observation', mustExist: true, type: 'file'
    });
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(secured.absolute, flags);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_RESULT_FILE_BYTES) {
      throw new SingularityFlowError(
        `Durable local test observation must be one bounded, regular, non-hard-linked file: ${relativePath}`,
        { code: 'WEL_RESULT_TAMPERED' }
      );
    }
    if (Number.isInteger(expectedBytes) && before.size !== expectedBytes) {
      throw new SingularityFlowError(
        `Durable local test observation byte count differs from its reference: ${relativePath}`,
        { code: 'WEL_RESULT_TAMPERED' }
      );
    }
    const contents = await boundedDescriptorRead(handle, before, {
      label: `Durable local test observation '${relativePath}'`,
      code: 'WEL_RESULT_TAMPERED'
    });
    if (expectedSha256 && sha256(contents) !== expectedSha256) {
      throw new SingularityFlowError(
        `Durable local test observation differs from its content address: ${relativePath}`,
        { code: 'WEL_RESULT_TAMPERED' }
      );
    }
    return contents;
  } catch (error) {
    if (error instanceof SingularityFlowError && error.code === 'WEL_RESULT_TAMPERED') throw error;
    throw new SingularityFlowError(
      `Durable local test observation could not be read safely: ${relativePath}: ${error.message}`,
      { code: 'WEL_RESULT_TAMPERED', cause: error }
    );
  } finally {
    await handle?.close();
  }
}

/** A native capture never inherits parser-visible output from an earlier invocation. */
export async function assertTestReportTargetEmpty(root, command) {
  const normalized = normalizeRequiredTestCommand(command);
  const secured = await secureRepositoryPath(root, path.join(normalized.workingDirectory, normalized.result.path), {
    label: 'Native test report target', type: undefined
  });
  if (secured.exists && (await resultFiles(secured.absolute, normalized.result.adapter)).length) {
    throw new SingularityFlowError('Native report capture requires a freshly cleared output target.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
}

/**
 * Rewrite a command's fresh report files with every bound secret redacted, before anything reads,
 * stores or replays them [RUN rule 3]. Used only for a run that was given private environment
 * values; `redact` comes from that run's materialized binding. Returns how many files changed.
 */
export async function redactTestReportFiles(root, command, redact) {
  const normalized = normalizeRequiredTestCommand(command);
  const repositoryRoot = (await secureRepositoryPath(root, '.', { label: 'Repository root', mustExist: true, type: 'directory' })).absolute;
  const secured = await secureRepositoryPath(root, path.join(normalized.workingDirectory, normalized.result.path), {
    label: 'Structured test result', type: undefined
  });
  if (!secured.exists) return 0;
  let changed = 0;
  for (const file of await resultFiles(secured.absolute, normalized.result.adapter)) {
    const text = (await readResultFile(repositoryRoot, file)).toString('utf8');
    const redacted = redact(text);
    if (redacted !== text) {
      await writeFile(file.absolute, redacted);
      changed += 1;
    }
  }
  return changed;
}

export async function parseTestResult(root, command, { startedAt = null } = {}) {
  const normalizedCommand = normalizeRequiredTestCommand(command);
  const moduleRoot = normalizedCommand.workingDirectory === '.' ? '' : normalizedCommand.workingDirectory;
  const repositoryRoot = (await secureRepositoryPath(root, '.', {
    label: 'Repository root', mustExist: true, type: 'directory'
  })).absolute;
  // A bound failsafe plugin always writes its summary to failsafe-reports. A verify that wrote none ran
  // no integration tests (an inactive profile, a parent that binds nothing): its surefire reports beside
  // are the whole run, and resultFiles reads them.
  const failsafe = normalizedCommand.result.adapter === 'junit-xml' && path.basename(normalizedCommand.result.path) === 'failsafe-reports';
  const secured = await secureRepositoryPath(
    root,
    path.join(moduleRoot, normalizedCommand.result.path),
    { label: 'Structured test result', mustExist: !failsafe }
  ).then(async (target) => {
    if (!target.exists) await secureRepositoryPath(root, path.join(moduleRoot, path.dirname(normalizedCommand.result.path), 'surefire-reports'),
      { label: 'Structured test result', mustExist: true });
    return target;
  }).catch((error) => {
    throw new SingularityFlowError(`Structured test result is not securely repository-contained: ${error.message}`, {
      code: 'CODE_TEST_RESULT_REQUIRED', cause: error
    });
  });
  const absolute = secured.absolute;
  const adapter = normalizedCommand.result.adapter;
  let files = await resultFiles(absolute, adapter);
  if (!files.length) {
    throw new SingularityFlowError(`Required structured test result is unavailable: ${normalizedCommand.result.path}`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  const startMs = startedAt ? Date.parse(startedAt) : null;
  if (Number.isFinite(startMs)) files = files.filter((file) => file.info.mtimeMs + 1000 >= startMs);
  if (!files.length) {
    throw new SingularityFlowError(`Structured test result is stale: ${normalizedCommand.result.path}`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  const oversized = files.find((file) => file.info.size > MAX_RESULT_FILE_BYTES);
  if (oversized) throw new SingularityFlowError(`Structured test result exceeds ${MAX_RESULT_FILE_BYTES} bytes: ${path.basename(oversized.absolute)}`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  const declaredBytes = files.reduce((total, file) => total + file.info.size, 0);
  if (declaredBytes > MAX_RESULT_TOTAL_BYTES) throw new SingularityFlowError(`Structured test results exceed ${MAX_RESULT_TOTAL_BYTES} total bytes.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  const contents = await Promise.all(files.map((file) => readResultFile(repositoryRoot, file)));
  const actualBytes = contents.reduce((total, content) => total + content.length, 0);
  if (actualBytes > MAX_RESULT_TOTAL_BYTES) {
    throw new SingularityFlowError(`Structured test results exceed ${MAX_RESULT_TOTAL_BYTES} total bytes.`, {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const bytes = combinedReports(contents);
  await prepareTestReportReader(adapter);
  const { tests, testcaseObservation } = testReportFromContents(adapter, contents);
  return {
    adapter, tests, testcaseObservation,
    result: {
      path: normalizedCommand.result.path, sha256: sha256(bytes), bytes: bytes.length,
      files: files.map((file, index) => ({
        sourcePath: posix(path.relative(repositoryRoot, file.absolute)),
        sha256: sha256(contents[index]),
        bytes: contents[index].length
      }))
    },
    rawReports: files.map((file, index) => ({
      sourcePath: posix(path.relative(repositoryRoot, file.absolute)),
      sha256: sha256(contents[index]),
      bytes: contents[index].length,
      contents: contents[index]
    })),
    minimumDiscovered: normalizedCommand.result.minimumDiscovered,
    minimumPassed: normalizedCommand.result.minimumPassed
  };
}

/** Words for a run that does not count: "does not count for this step: it requires `qa`". */
export function environmentDoesNotCountWords(linked) {
  return `does not count for this step: it requires \`${linked}\``;
}

/**
 * The label every surface shows for a local-integration run [RUN evidence classes]: who ran it, in
 * which environment, on which commit, that values were never recorded, and when the run does not
 * count for the step because the step requires another environment.
 */
export function localIntegrationLabel({ ranBy = null, environment, commit = null, countsForStep = true, linked = null }) {
  return `Local integration run by ${ranBy ?? 'an unrecorded identity'}, environment \`${environment}\`, commit \`${String(commit ?? 'unknown').slice(0, 7)}\`; values never recorded`
    + (countsForStep || !linked ? '' : `; ${environmentDoesNotCountWords(linked)}`);
}

/** The label of one recorded attempt with the local-integration class, or null for any other. */
export function attemptLocalIntegrationLabel(attempt) {
  if (attempt?.evidenceClass !== 'local-integration') return null;
  return localIntegrationLabel({ ranBy: attempt.ranBy, environment: attempt.boundEnvironment?.name ?? 'unknown',
    commit: attempt.candidate?.commit, countsForStep: attempt.countsForStep !== false, linked: attempt.linkedEnvironment ?? null });
}

/**
 * One immutable test-execution attempt (test-execution v5) [E2G-016].
 *
 * The record keeps what the run proved and nothing it did not: the exact command, what it
 * selects, the host it ran on, the candidate tree it ran against, how the process ended, the
 * module counts, every occurrence the report names and the content-addressed raw reports. A run
 * that failed, was blocked or produced no usable report is recorded just the same; its status says
 * so. `testReceiptPassing` decides whether the module command passed; whether a criterion's own
 * test passed is the evaluator's join, never this record's.
 */
/** The digest of what shaped a run, as its attempt records it [TCE:REQ-033]; the CLI's own Node is left out. */
export function runEnvironmentSha256(runEnvironment) {
  return `sha256:${sha256(canonicalJson({ platform: process.platform, arch: process.arch, ...runEnvironment }))}`;
}

export function buildTestExecutionReceipt(command, check, parsed, {
  attemptId, nonce, parentAttemptId = null, purpose = 'submission', workId = null, phase = null,
  generation = null, epoch = null, rawReports = [], reportError = null, profile = null, selection = null,
  localRunId = null, uncommittedChanges = null
} = {}) {
  const countsValid = parsed ? consistentTestCounts(parsed.tests) : false;
  const processPassed = check?.status === 'passed' && check.exitCode === 0;
  const status = !check || check.status === 'skipped-warning' ? 'skipped'
    : check.status === 'blocked' ? 'blocked'
      : !processPassed ? 'failed'
        : !parsed ? 'unavailable'
          : (!countsValid || parsed.tests.discovered < parsed.minimumDiscovered
            || parsed.tests.passed < parsed.minimumPassed || parsed.tests.failed) ? 'failed' : 'passed';
  const commandCore = {
    argv: command.argv, workingDirectory: command.workingDirectory, affectedRoots: command.affectedRoots,
    result: { adapter: command.result?.adapter ?? null, path: command.result?.path ?? null },
    ...(command.env ? { env: command.env } : {})
  };
  // What shaped the run [TCE:REQ-033]; the digest covers all of it but the CLI's own Node.
  const ran = { platform: process.platform, arch: process.arch, ...check?.runEnvironment };
  return {
    schemaVersion: currentSchemaVersion('test-execution'), kind: 'test-execution',
    attemptId, nonce, parentAttemptId, purpose, workId, phase, generation, ...(epoch ? { epoch } : {}),
    // A local run's attempts share one run ID so a test summary reads them as one run [RUN M2].
    ...(localRunId ? { localRunId, uncommittedChanges: uncommittedChanges === true } : {}),
    commandId: command.id,
    commandSha256: `sha256:${sha256(canonicalJson(commandCore))}`,
    argvSha256: sha256(Buffer.from(JSON.stringify(command.argv))),
    selection: selection ? { ...selection, selectionSha256: `sha256:${sha256(canonicalJson({ profile, ...selection }))}` } : null,
    environment: { ...ran, host: `node ${process.versions.node}` },
    environmentSha256: runEnvironmentSha256(check?.runEnvironment),
    platform: process.platform,
    workingDirectory: command.workingDirectory,
    affectedRoots: command.affectedRoots,
    adapter: parsed?.adapter ?? command.result?.adapter ?? null,
    profile,
    candidate: { commit: check?.sourceCommit ?? null, treeSha256: check?.sourceTreeSha256 ?? null,
      ...(check?.testInputSha256 ? { testInputSha256: check.testInputSha256 } : {}) },
    process: {
      status: check?.status ?? 'not-run', exitCode: Number.isInteger(check?.exitCode) ? check.exitCode : null,
      signal: check?.signal ?? null, timedOut: check?.timedOut === true,
      infrastructureUnavailable: check?.infrastructureUnavailable === true,
      startedAt: check?.startedAt ?? null, completedAt: check?.completedAt ?? null
    },
    status,
    terminal: status !== 'skipped' && !(status === 'blocked' && check?.infrastructureUnavailable === true),
    exitCode: Number.isInteger(check?.exitCode) ? check.exitCode : null,
    timedOut: check?.timedOut === true || (check?.status === 'blocked' && /timeout|exceeded/i.test(check?.stderr ?? '')),
    skipped: check?.status === 'skipped-warning',
    suppressed: false,
    tests: parsed?.tests ?? null,
    result: parsed?.result ?? null,
    rawReports,
    occurrences: parsed ? persistedOccurrences(parsed) : [],
    reportError,
    assurance: 'module-executed',
    // A run given an environment's values [RUN M3]: its class, the environment's public metadata
    // (never a value), who ran it, and whether a run in that environment counts for the step.
    ...(check?.evidenceClass === 'local-integration' ? {
      evidenceClass: 'local-integration',
      boundEnvironment: check.environment ?? null,
      ranBy: check.ranBy ?? null,
      linkedEnvironment: check.linkedEnvironment ?? null,
      allowedEnvironments: [...(check.allowedEnvironments ?? [])],
      countsForStep: check.countsForStep !== false
    } : {})
  };
}

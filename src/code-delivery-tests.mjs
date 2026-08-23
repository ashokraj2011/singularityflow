import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeExternalCommand } from './external-command-policy.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { exists, posix, SingularityFlowError } from './util.mjs';

const SUPPORTING_SEGMENTS = new Set([
  '__snapshots__', 'fixture', 'fixtures', 'page-object', 'page-objects', 'pageobjects',
  'reports', 'results', 'snapshots', 'test-data', 'testdata'
]);
const SUPPORTING_BASENAMES = /^(?:readme(?:\.[^.]+)?|(?:playwright|cypress|jest|vitest|pytest)\.config\.[^.]+)$/i;
const SUPPORTING_EXTENSIONS = /\.(?:snap|snapshot|golden|md|mdx|txt|csv|tsv|json|ya?ml|xml|toml|properties)$/i;
const TEST_SOURCE_NAMES = [
  /(?:^|[._-])(?:test|tests|spec|e2e)(?:[._-]|$)/i,
  /(?:Test|Tests|Spec)\.(?:java|kt|kts|scala|cs|fs|vb|swift)$/,
  /^(?:test_.+|.+_test)\.py$/i,
  /_test\.go$/i,
  /(?:^|_)tests?\.rs$/i
];
const TEST_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.cxx', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.mts', '.py', '.rb', '.rs', '.scala', '.swift', '.ts', '.tsx'
]);
const MAX_RESULT_FILES = 1_000;
const MAX_RESULT_DEPTH = 8;
const MAX_RESULT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_TOTAL_BYTES = 64 * 1024 * 1024;

const MANIFESTS = Object.freeze({
  'pom.xml': 'maven',
  'settings.gradle': 'gradle', 'settings.gradle.kts': 'gradle',
  'build.gradle': 'gradle', 'build.gradle.kts': 'gradle',
  'package.json': 'node',
  'pyproject.toml': 'python', 'pytest.ini': 'python', 'tox.ini': 'python',
  'go.mod': 'go', 'Cargo.toml': 'rust', 'Package.swift': 'swift'
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(candidate) {
  return posix(String(candidate ?? '')).replace(/^\.\//, '');
}

export function isAllowedTestAutomationPath(candidate) {
  return isTestAutomationPath(candidate);
}

export function isSupportingTestResourcePath(candidate) {
  const relative = normalized(candidate);
  const segments = relative.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return segments.some((segment) => SUPPORTING_SEGMENTS.has(segment))
    || SUPPORTING_BASENAMES.test(basename)
    || SUPPORTING_EXTENSIONS.test(basename)
    || /(?:^|[._-])(?:fixture|snapshot|page-object|pageobject)(?:[._-]|$)/i.test(basename);
}

export async function isExecutableTestSourcePath(root, candidate) {
  const relative = normalized(candidate);
  if (!isAllowedTestAutomationPath(relative) || isSupportingTestResourcePath(relative)) return false;
  const extension = path.posix.extname(relative).toLowerCase();
  if (!TEST_SOURCE_EXTENSIONS.has(extension)) return false;
  if (!TEST_SOURCE_NAMES.some((pattern) => pattern.test(path.posix.basename(relative)))) return false;
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

async function manifestsAt(root, directory) {
  const found = [];
  for (const [name, system] of Object.entries(MANIFESTS)) {
    if (await exists(path.join(root, directory, name))) found.push({ name, system });
  }
  const dotnet = [];
  try {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(path.join(root, directory || '.'))) {
      if (/\.(?:sln|csproj)$/i.test(name)) dotnet.push({ name, system: 'dotnet' });
    }
  } catch { /* Missing directory is handled by the caller's changed-path validation. */ }
  return [...found, ...dotnet];
}

/** Resolve the nearest build owner; two build systems at that root are intentionally ambiguous. */
export async function resolveAffectedModule(root, candidate, { overrides = {} } = {}) {
  const relative = normalized(candidate);
  const explicit = Object.entries(overrides)
    .filter(([prefix]) => relative === prefix || relative.startsWith(`${prefix}/`))
    .sort(([left], [right]) => right.length - left.length || left.localeCompare(right))[0];
  if (explicit) return { root: explicit[1].root ?? explicit[0], system: explicit[1].system, manifest: explicit[1].manifest ?? null, configured: true };
  for (const directory of parentDirectories(relative)) {
    const manifests = await manifestsAt(root, directory);
    if (!manifests.length) continue;
    const systems = [...new Set(manifests.map((entry) => entry.system))];
    if (systems.length > 1) {
      throw new SingularityFlowError(
        `Changed path '${relative}' maps to multiple build systems at '${directory || '.'}': ${systems.join(', ')}.`,
        { code: 'TEST_MODULE_AMBIGUOUS' }
      );
    }
    return { root: directory || '.', system: systems[0], manifest: manifests[0].name, configured: false };
  }
  throw new SingularityFlowError(`No supported build manifest owns changed path '${relative}'.`, { code: 'TEST_MODULE_UNCOVERED' });
}

function executable(platform, unix, windows) {
  return platform === 'win32' ? windows : unix;
}

async function nodePackageManager(root, moduleRoot, manifest) {
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

export async function inferModuleTestCommand(root, module, { platform = process.platform } = {}) {
  const cwd = module.root === '.' ? '' : module.root;
  const at = (name) => exists(path.join(root, cwd, name));
  const resultBase = `.sflow/results/${module.system}-tests`;
  switch (module.system) {
    case 'maven': {
      const wrapper = await at(platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
      return {
        id: `${module.root}-maven-tests`, kind: 'test',
        argv: wrapper ? [executable(platform, './mvnw', 'mvnw.cmd'), 'test'] : ['mvn', 'test'],
        workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: 'target/surefire-reports', minimumDiscovered: 1 }
      };
    }
    case 'gradle': {
      const wrapper = await at(platform === 'win32' ? 'gradlew.bat' : 'gradlew');
      return {
        id: `${module.root}-gradle-tests`, kind: 'test',
        argv: wrapper ? [executable(platform, './gradlew', 'gradlew.bat'), 'test'] : ['gradle', 'test'],
        workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: 'build/test-results/test', minimumDiscovered: 1 }
      };
    }
    case 'node': {
      const manifest = JSON.parse(await readFile(path.join(root, cwd, 'package.json'), 'utf8'));
      const script = String(manifest.scripts?.test ?? '');
      const manager = await nodePackageManager(root, module.root, manifest);
      const testArgv = manager === 'npm' ? ['npm', 'test', '--']
        : manager === 'yarn' ? ['yarn', 'test']
          : manager === 'pnpm' ? ['pnpm', 'test', '--'] : ['bun', 'run', 'test', '--'];
      if (/\bjest\b/i.test(script)) return {
        id: `${module.root}-node-tests`, kind: 'test',
        argv: [...testArgv, '--json', '--outputFile', `${resultBase}.json`],
        workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'jest-json', path: `${resultBase}.json`, minimumDiscovered: 1 }
      };
      if (/\bvitest\b/i.test(script)) return {
        id: `${module.root}-node-tests`, kind: 'test',
        argv: [...testArgv, '--reporter=json', `--outputFile=${resultBase}.json`],
        workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'vitest-json', path: `${resultBase}.json`, minimumDiscovered: 1 }
      };
      if (/\bnode\b[^\n]*--test\b/i.test(script)) return {
        id: `${module.root}-node-tests`, kind: 'test',
        argv: ['node', '--test', '--test-reporter=junit'],
        workingDirectory: module.root, affectedRoots: [module.root], modelPolicy: 'never',
        result: { adapter: 'junit-xml', path: `${resultBase}.xml`, minimumDiscovered: 1 }
      };
      return null;
    }
    case 'python': return {
      id: `${module.root}-python-tests`, kind: 'test', argv: platform === 'win32'
        ? ['py', '-3', '-m', 'pytest', `--junitxml=${resultBase}.xml`]
        : ['python3', '-m', 'pytest', `--junitxml=${resultBase}.xml`], workingDirectory: module.root,
      affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: resultBase + '.xml', minimumDiscovered: 1 }
    };
    case 'go': return {
      id: `${module.root}-go-tests`, kind: 'test', argv: ['go', 'test', '-json', './...'], workingDirectory: module.root,
      affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: 'go-test-json', path: resultBase + '.jsonl', minimumDiscovered: 1 }
    };
    case 'rust': return null;
    case 'dotnet': return {
      id: `${module.root}-dotnet-tests`, kind: 'test', argv: ['dotnet', 'test', '--logger', 'trx'], workingDirectory: module.root,
      affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: 'dotnet-trx', path: 'TestResults', minimumDiscovered: 1 }
    };
    case 'swift': return {
      id: `${module.root}-swift-tests`, kind: 'test',
      argv: ['swift', 'test', `--xunit-output=${resultBase}.xml`], workingDirectory: module.root,
      affectedRoots: [module.root], modelPolicy: 'never',
      result: { adapter: 'junit-xml', path: resultBase + '.xml', minimumDiscovered: 1 }
    };
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
    throw new SingularityFlowError(`qualityCommands[${index}] must use object argv form for required code-delivery testing.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  const command = normalizeExternalCommand(value, index);
  if (command.kind !== 'test' || !command.argv?.length || !command.workingDirectory
      || !command.affectedRoots?.length || !command.result) {
    throw new SingularityFlowError(
      `qualityCommands[${index}] must declare kind: test, argv, workingDirectory, affectedRoots, and a result adapter.`,
      { code: 'CODE_TEST_RESULT_REQUIRED' }
    );
  }
  const suppression = testSuppression(command);
  if (suppression) throw new SingularityFlowError(suppression, { code: 'CODE_TEST_SUPPRESSED' });
  return command;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function attribute(xml, name) {
  return number(xml.match(new RegExp(`\\b${name}=["'](\\d+)["']`, 'i'))?.[1]);
}

function countsFromJson(adapter, parsed) {
  if (adapter === 'sflow-test-result-v1') return {
    discovered: number(parsed.tests?.discovered), passed: number(parsed.tests?.passed),
    failed: number(parsed.tests?.failed), skipped: number(parsed.tests?.skipped)
  };
  if (adapter === 'jest-json' || adapter === 'vitest-json') return {
    discovered: number(parsed.numTotalTests ?? parsed.testResults?.flatMap((suite) => suite.assertionResults ?? []).length),
    passed: number(parsed.numPassedTests), failed: number(parsed.numFailedTests), skipped: number(parsed.numPendingTests)
  };
  if (adapter === 'playwright-json') {
    const tests = (parsed.suites ?? []).flatMap((suite) => suite.specs ?? []).flatMap((spec) => spec.tests ?? []);
    const statuses = tests.map((test) => test.results?.at(-1)?.status ?? test.status);
    return {
      discovered: tests.length,
      passed: statuses.filter((status) => status === 'passed').length,
      failed: statuses.filter((status) => ['failed', 'timedOut', 'interrupted'].includes(status)).length,
      skipped: statuses.filter((status) => status === 'skipped').length
    };
  }
  if (adapter === 'go-test-json') {
    const events = Array.isArray(parsed) ? parsed : parsed.events ?? [];
    const tests = events.filter((event) => event.Test && ['pass', 'fail', 'skip'].includes(event.Action));
    return {
      discovered: new Set(tests.map((event) => `${event.Package}:${event.Test}`)).size,
      passed: tests.filter((event) => event.Action === 'pass').length,
      failed: tests.filter((event) => event.Action === 'fail').length,
      skipped: tests.filter((event) => event.Action === 'skip').length
    };
  }
  const summary = parsed.summary ?? parsed;
  return {
    discovered: number(summary.discovered ?? summary.total ?? summary.tests),
    passed: number(summary.passed), failed: number(summary.failed ?? summary.failures), skipped: number(summary.skipped)
  };
}

async function resultFiles(absolute, adapter, state = { files: 0 }, depth = 0) {
  if (depth > MAX_RESULT_DEPTH) {
    throw new SingularityFlowError(`Structured test result directory exceeds depth ${MAX_RESULT_DEPTH}.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
  const info = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info || info.isSymbolicLink()) return [];
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
    else if (entry.isFile() && extension.test(entry.name)) {
      if (++state.files > MAX_RESULT_FILES) throw new SingularityFlowError(`Structured test results exceed ${MAX_RESULT_FILES} files.`, { code: 'CODE_TEST_RESULT_REQUIRED' });
      output.push({ absolute: target, info: await lstat(target) });
    }
  }
  return output.sort((left, right) => left.absolute.localeCompare(right.absolute));
}

export async function parseTestResult(root, command, { startedAt = null } = {}) {
  const normalizedCommand = normalizeRequiredTestCommand(command);
  const moduleRoot = normalizedCommand.workingDirectory === '.' ? '' : normalizedCommand.workingDirectory;
  const absolute = path.resolve(root, moduleRoot, normalizedCommand.result.path);
  const repositoryRoot = path.resolve(root);
  if (absolute !== repositoryRoot && !absolute.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new SingularityFlowError('Test result path resolves outside the repository.', { code: 'CODE_TEST_RESULT_REQUIRED' });
  }
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
  const contents = await Promise.all(files.map((file) => readFile(file.absolute)));
  const bytes = Buffer.concat(contents.flatMap((content, index) => index ? [Buffer.from('\n'), content] : [content]));
  let tests;
  if (['junit-xml', 'dotnet-trx'].includes(adapter)) {
    const documents = contents.map((content) => content.toString('utf8'));
    if (adapter === 'dotnet-trx') {
      const counters = documents.reduce((totals, xml) => ({
        discovered: totals.discovered + attribute(xml, 'total'),
        passed: totals.passed + attribute(xml, 'passed'),
        failed: totals.failed + attribute(xml, 'failed') + attribute(xml, 'error')
          + attribute(xml, 'timeout') + attribute(xml, 'aborted'),
        skipped: totals.skipped + attribute(xml, 'notExecuted')
      }), { discovered: 0, passed: 0, failed: 0, skipped: 0 });
      tests = counters;
    } else {
      const discovered = documents.reduce((sum, xml) => sum
        + (attribute(xml, 'tests') || attribute(xml, 'total') || (xml.match(/<testcase\b/gi) ?? []).length), 0);
      const failed = documents.reduce((sum, xml) => {
        const summary = attribute(xml, 'failures') + attribute(xml, 'errors') + attribute(xml, 'failed');
        return sum + (summary || (xml.match(/<(?:failure|error)\b/gi) ?? []).length);
      }, 0);
      const skipped = documents.reduce((sum, xml) => {
        const summary = attribute(xml, 'skipped') + attribute(xml, 'disabled') + attribute(xml, 'notExecuted');
        return sum + (summary || (xml.match(/<skipped\b/gi) ?? []).length);
      }, 0);
      tests = { discovered, passed: Math.max(0, discovered - failed - skipped), failed, skipped };
    }
  } else if (adapter === 'go-test-json') {
    const events = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    tests = countsFromJson(adapter, events);
  } else {
    tests = countsFromJson(adapter, JSON.parse(bytes.toString('utf8')));
  }
  return {
    adapter, tests,
    result: { path: normalizedCommand.result.path, sha256: sha256(bytes), bytes: bytes.length },
    minimumDiscovered: normalizedCommand.result.minimumDiscovered
  };
}

export function testReceiptPassing(receipt, minimumDiscovered = 1) {
  return receipt?.status === 'passed'
    && receipt.exitCode === 0
    && receipt.timedOut === false
    && receipt.skipped === false
    && receipt.suppressed === false
    && number(receipt.tests?.discovered) >= minimumDiscovered
    && number(receipt.tests?.failed) === 0;
}

export function buildTestExecutionReceipt(command, check, parsed) {
  const status = check.status === 'passed'
    ? (parsed.tests.discovered < parsed.minimumDiscovered ? 'failed' : parsed.tests.failed ? 'failed' : 'passed')
    : check.status === 'skipped-warning' ? 'skipped' : check.status;
  const receipt = {
    schemaVersion: currentSchemaVersion('test-execution'), kind: 'test-execution',
    commandId: command.id,
    argvSha256: sha256(Buffer.from(JSON.stringify(command.argv))),
    platform: process.platform,
    workingDirectory: command.workingDirectory,
    affectedRoots: command.affectedRoots,
    adapter: parsed.adapter,
    status,
    exitCode: check.exitCode,
    timedOut: check.status === 'blocked' && /timeout|exceeded/i.test(check.stderr ?? ''),
    skipped: check.status === 'skipped-warning',
    suppressed: false,
    tests: parsed.tests,
    result: parsed.result,
    assurance: 'module-executed'
  };
  return receipt;
}

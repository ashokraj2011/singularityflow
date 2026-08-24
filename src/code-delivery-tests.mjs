import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeExternalCommand } from './external-command-policy.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';
import { exists, posix, secureRepositoryPath, SingularityFlowError } from './util.mjs';

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

export async function isExecutableTestSourcePath(root, candidate, { sourceExtensions = [] } = {}) {
  const relative = normalized(candidate);
  if (!isAllowedTestAutomationPath(relative) || isSupportingTestResourcePath(relative)) return false;
  const extension = path.posix.extname(relative).toLowerCase();
  if (!TEST_SOURCE_EXTENSIONS.has(extension) && !new Set(sourceExtensions.map((item) => item.toLowerCase())).has(extension)) return false;
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
    case 'rust': throw new SingularityFlowError(
      `Rust module '${module.root}' requires an explicit argv-form test command with a structured result adapter; stable cargo test output does not provide testcase counts.`,
      { code: 'RUST_TEST_ADAPTER_REQUIRED' }
    );
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

const MAX_XML_ELEMENTS = 1_000_000;
const MAX_XML_DEPTH = 128;

function xmlFailure(message) {
  throw new SingularityFlowError(`Structured XML test result is invalid: ${message}`, {
    code: 'CODE_TEST_RESULT_REQUIRED'
  });
}

function tagEnd(xml, start) {
  let quote = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  xmlFailure('unterminated tag');
}

function parseAttributes(value) {
  const attributes = Object.create(null);
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? '')) index += 1;
    if (index >= value.length) break;
    const name = value.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) xmlFailure('malformed attribute name');
    index += name.length;
    while (/\s/.test(value[index] ?? '')) index += 1;
    if (value[index] !== '=') xmlFailure(`attribute '${name}' has no value`);
    index += 1;
    while (/\s/.test(value[index] ?? '')) index += 1;
    const quote = value[index];
    if (quote !== '"' && quote !== "'") xmlFailure(`attribute '${name}' is not quoted`);
    const end = value.indexOf(quote, index + 1);
    if (end === -1) xmlFailure(`attribute '${name}' is unterminated`);
    if (Object.hasOwn(attributes, name)) xmlFailure(`attribute '${name}' is duplicated`);
    attributes[name] = value.slice(index + 1, end);
    index = end + 1;
  }
  return attributes;
}

function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) xmlFailure('DOCTYPE and entity declarations are forbidden');
  let index = 0;
  let elements = 0;
  let root = null;
  const stack = [];
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      if (stack.length || xml.slice(index).trim()) xmlFailure('text exists outside the root element');
      break;
    }
    if (!stack.length && xml.slice(index, open).trim()) xmlFailure('text exists outside the root element');
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end === -1) xmlFailure('unterminated comment');
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end === -1) xmlFailure('unterminated processing instruction');
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      if (!stack.length) xmlFailure('CDATA exists outside the root element');
      const end = xml.indexOf(']]>', open + 9);
      if (end === -1) xmlFailure('unterminated CDATA section');
      index = end + 3;
      continue;
    }
    if (xml.startsWith('</', open)) {
      const end = tagEnd(xml, open + 2);
      const name = xml.slice(open + 2, end).trim();
      const current = stack.pop();
      if (!current || current.name !== name) xmlFailure(`closing tag '${name}' does not match the open element`);
      index = end + 1;
      continue;
    }
    if (xml.startsWith('<!', open)) xmlFailure('unsupported declaration');
    const end = tagEnd(xml, open + 1);
    let body = xml.slice(open + 1, end).trim();
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1).trim();
    const name = body.match(/^[A-Za-z_][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) xmlFailure('malformed element name');
    const node = { name, localName: name.split(':').at(-1), attributes: parseAttributes(body.slice(name.length)), children: [] };
    if (++elements > MAX_XML_ELEMENTS) xmlFailure(`element count exceeds ${MAX_XML_ELEMENTS}`);
    if (stack.length >= MAX_XML_DEPTH) xmlFailure(`depth exceeds ${MAX_XML_DEPTH}`);
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) xmlFailure('document contains multiple root elements');
    else root = node;
    if (!selfClosing) stack.push(node);
    index = end + 1;
  }
  if (stack.length) xmlFailure(`element '${stack.at(-1).name}' is not closed`);
  if (!root) xmlFailure('document has no root element');
  return root;
}

function descendants(node, localName, output = []) {
  if (node.localName === localName) output.push(node);
  for (const child of node.children) descendants(child, localName, output);
  return output;
}

function integerAttribute(node, names, { required = false } = {}) {
  const name = names.find((candidate) => Object.hasOwn(node.attributes, candidate));
  if (!name) {
    if (required) xmlFailure(`element '${node.name}' has no '${names[0]}' count`);
    return null;
  }
  if (!/^\d+$/.test(node.attributes[name])) xmlFailure(`attribute '${name}' is not a non-negative integer`);
  return Number(node.attributes[name]);
}

function junitCounts(xml) {
  const root = parseXml(xml);
  if (!['testsuite', 'testsuites'].includes(root.localName)) xmlFailure(`unrecognized JUnit root '${root.name}'`);
  const cases = descendants(root, 'testcase');
  if (cases.length) {
    const failed = cases.filter((item) => item.children.some((child) => ['failure', 'error'].includes(child.localName))).length;
    const skipped = cases.filter((item) => item.children.some((child) => child.localName === 'skipped')
      || ['disabled', 'notrun', 'notexecuted'].includes(String(item.attributes.status ?? '').toLowerCase())).length;
    const counts = { discovered: cases.length, passed: cases.length - failed - skipped, failed, skipped };
    const declared = integerAttribute(root, ['tests', 'total']);
    if (declared != null && declared !== counts.discovered) xmlFailure('JUnit aggregate count differs from testcase elements');
    return counts;
  }
  const discovered = integerAttribute(root, ['tests', 'total'], { required: true });
  const failed = (integerAttribute(root, ['failures', 'failed']) ?? 0) + (integerAttribute(root, ['errors']) ?? 0);
  const skipped = (integerAttribute(root, ['skipped', 'notExecuted']) ?? 0) + (integerAttribute(root, ['disabled']) ?? 0);
  if (failed + skipped > discovered) xmlFailure('JUnit outcome counts exceed discovered tests');
  return { discovered, passed: discovered - failed - skipped, failed, skipped };
}

function trxCounts(xml) {
  const root = parseXml(xml);
  if (root.localName !== 'TestRun') xmlFailure(`unrecognized TRX root '${root.name}'`);
  const counters = descendants(root, 'Counters');
  if (counters.length !== 1) xmlFailure('TRX must contain exactly one Counters element');
  const counter = counters[0];
  const discovered = integerAttribute(counter, ['total'], { required: true });
  const passed = integerAttribute(counter, ['passed']) ?? 0;
  const failed = ['failed', 'error', 'timeout', 'aborted', 'inconclusive', 'notRunnable', 'disconnected', 'warning']
    .reduce((sum, name) => sum + (integerAttribute(counter, [name]) ?? 0), 0);
  const skipped = integerAttribute(counter, ['notExecuted']) ?? 0;
  if (passed + failed + skipped !== discovered) xmlFailure('TRX outcome counts do not equal total tests');
  return { discovered, passed, failed, skipped };
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
    const tests = [];
    const visitSuite = (suite, depth = 0) => {
      if (depth > 128) throw new SingularityFlowError('Playwright result suite depth exceeds 128.', { code: 'CODE_TEST_RESULT_REQUIRED' });
      for (const spec of suite?.specs ?? []) tests.push(...(spec.tests ?? []));
      for (const child of suite?.suites ?? []) visitSuite(child, depth + 1);
    };
    for (const suite of parsed.suites ?? []) visitSuite(suite);
    const outcomes = tests.map((test) => {
      const outcome = test.status;
      const execution = test.results?.at(-1)?.status ?? null;
      if (outcome === 'skipped' || execution === 'skipped') return 'skipped';
      if (outcome === 'unexpected' || ['failed', 'timedOut', 'interrupted'].includes(execution)) return 'failed';
      if (outcome === 'flaky' || outcome === 'expected' || execution === 'passed') return 'passed';
      throw new SingularityFlowError(`Playwright result contains unknown outcome '${outcome ?? execution ?? 'absent'}'.`, {
        code: 'CODE_TEST_RESULT_REQUIRED'
      });
    });
    const counts = {
      discovered: tests.length,
      passed: outcomes.filter((status) => status === 'passed').length,
      failed: outcomes.filter((status) => status === 'failed').length,
      skipped: outcomes.filter((status) => status === 'skipped').length
    };
    const stats = parsed.stats;
    if (stats && ['expected', 'unexpected', 'flaky', 'skipped'].every((key) => Number.isInteger(stats[key]))) {
      const declared = {
        discovered: stats.expected + stats.unexpected + stats.flaky + stats.skipped,
        passed: stats.expected + stats.flaky,
        failed: stats.unexpected,
        skipped: stats.skipped
      };
      if (Object.keys(declared).some((key) => declared[key] !== counts[key])) {
        throw new SingularityFlowError('Playwright reporter statistics differ from recursively traversed test outcomes.', {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
    }
    return counts;
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
  const secured = await secureRepositoryPath(
    root,
    path.join(moduleRoot, normalizedCommand.result.path),
    { label: 'Structured test result', mustExist: true }
  ).catch((error) => {
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
  const contents = await Promise.all(files.map((file) => readFile(file.absolute)));
  const bytes = Buffer.concat(contents.flatMap((content, index) => index ? [Buffer.from('\n'), content] : [content]));
  let tests;
  if (['junit-xml', 'dotnet-trx'].includes(adapter)) {
    const documents = contents.map((content) => content.toString('utf8'));
    if (adapter === 'dotnet-trx') {
      tests = documents.map(trxCounts).reduce((totals, counts) => ({
        discovered: totals.discovered + counts.discovered,
        passed: totals.passed + counts.passed,
        failed: totals.failed + counts.failed,
        skipped: totals.skipped + counts.skipped
      }), { discovered: 0, passed: 0, failed: 0, skipped: 0 });
    } else {
      tests = documents.map(junitCounts).reduce((totals, counts) => ({
        discovered: totals.discovered + counts.discovered,
        passed: totals.passed + counts.passed,
        failed: totals.failed + counts.failed,
        skipped: totals.skipped + counts.skipped
      }), { discovered: 0, passed: 0, failed: 0, skipped: 0 });
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
    minimumDiscovered: normalizedCommand.result.minimumDiscovered,
    minimumPassed: normalizedCommand.result.minimumPassed
  };
}

function consistentTestCounts(tests) {
  const discovered = number(tests?.discovered);
  const passed = number(tests?.passed);
  const failed = number(tests?.failed);
  const skipped = number(tests?.skipped);
  return [discovered, passed, failed, skipped].every(Number.isInteger)
    && [discovered, passed, failed, skipped].every((value) => value >= 0)
    && passed + failed + skipped === discovered;
}

export function testReceiptPassing(receipt, minimumDiscovered = 1, minimumPassed = 1) {
  return receipt?.status === 'passed'
    && receipt.exitCode === 0
    && receipt.timedOut === false
    && receipt.skipped === false
    && receipt.suppressed === false
    && consistentTestCounts(receipt.tests)
    && number(receipt.tests?.discovered) >= minimumDiscovered
    && number(receipt.tests?.passed) >= minimumPassed
    && number(receipt.tests?.failed) === 0;
}

export function buildTestExecutionReceipt(command, check, parsed) {
  const countsValid = consistentTestCounts(parsed.tests);
  const status = check.status === 'passed'
    ? (!countsValid
      || parsed.tests.discovered < parsed.minimumDiscovered
      || parsed.tests.passed < parsed.minimumPassed
      || parsed.tests.failed ? 'failed' : 'passed')
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
    assurance: 'module-executed',
    testcaseExecutionProven: false,
    assuranceNotice: 'module executed; tagged test execution not independently proven'
  };
  return receipt;
}

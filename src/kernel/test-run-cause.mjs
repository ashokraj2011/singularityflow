/** Test failure and report-message values. Byte normalization is an explicit memory-only host binding. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {parseXml} from './test-report-codec.mjs';
export function testRunCausePolicies({toBytes}={}){
  if(typeof toBytes!=='function')throw new SingularityFlowError('Test-cause values require an explicit byte normalization capability.',{code:'ENGINE_INPUT_INVALID'});
  const normalize=toBytes;
  function bytes(value){const found=normalize(value);if(!(found instanceof Uint8Array))throw new SingularityFlowError(
    'The byte capability returned another value.',{code:'ENGINE_PORT_RESULT_INVALID'});return found;}
  function joinUtf8(chunks,separator=''){
    const delimiter=new TextEncoder().encode(separator),length=chunks.reduce((total,chunk)=>total+chunk.byteLength,Math.max(0,chunks.length-1)*delimiter.byteLength),
      joined=new Uint8Array(length);let offset=0;
    for(const [index,chunk]of chunks.entries()){if(index){joined.set(delimiter,offset);offset+=delimiter.byteLength;}joined.set(chunk,offset);offset+=chunk.byteLength;}
    return new TextDecoder('utf-8',{ignoreBOM:true}).decode(joined);
  }
/**
 * A short failure message for each failed test case, for `tests summary` [RUN M2; VS Code Testing
 * view]. Read from the retained raw report bytes in the order the attempt keeps its occurrences,
 * with what each adapter already reports:
 *
 * - junit-xml: the `<failure>` or `<error>` element's `message` attribute and the first lines of its
 *   text (usually the stack);
 * - node-tap: the error message the repository's node:test observer writes, on its own line beside its
 *   occurrence record, for each failed case;
 * - jest-json and vitest-json: the assertion's `failureMessages`.
 *
 * Nothing here is part of an attempt: receipts and their occurrences are unchanged, so an older
 * attempt reads with no messages rather than differently. A message is bounded to about 2,000
 * characters, terminal colour codes are removed, and the caller redacts bound secrets before it is
 * shown. Any report that does not read gives no messages at all, never misaligned ones.
 */

const CASE_MESSAGE_LIMIT = 2_000;
const LINES = 12;
const NAMED = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gu, (whole, name) => {
    if (name[0] !== '#') return NAMED[name];
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/** One bounded message: colour codes and other control characters (but newlines and tabs) removed. */
function boundedCaseMessage(value) {
  const text = String(value ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\r\n?/gu, '\n').trim();
  if (!text) return null;
  return text.length > CASE_MESSAGE_LIMIT ? `${text.slice(0, CASE_MESSAGE_LIMIT - 1)}…` : text;
}

function descendants(node, localName, output = []) {
  if (node.localName === localName) output.push(node);
  for (const child of node.children) descendants(child, localName, output);
  return output;
}

/** The text inside one element, from its source: CDATA kept as written, entities decoded, tags dropped. */
function elementText(xml, node) {
  if (node.sourceEnd == null) return '';
  const source = xml.slice(node.sourceStart, node.sourceEnd);
  const open = source.indexOf('>');
  if (open === -1 || source.endsWith('/>')) return '';
  const inner = source.slice(open + 1, source.lastIndexOf('</'));
  return inner.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/u).map((part) => (part.startsWith('<![CDATA[')
    ? part.slice(9, -3) : decodeEntities(part.replace(/<[^>]*>/gu, '')))).join('');
}

function junitMessages(contents) {
  const messages = [];
  for (const content of contents) {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
    for (const testcase of descendants(parseXml(xml), 'testcase')) {
      const failure = testcase.children.find((child) => child.localName === 'failure' || child.localName === 'error');
      if (!failure) { messages.push(null); continue; }
      const message = failure.attributes.message == null ? '' : decodeEntities(failure.attributes.message).trim();
      const lines = elementText(xml, failure).split(/\r?\n/u).map((line) => line.trimEnd()).filter((line) => line.trim());
      const body = lines.filter((line, index) => !(index === 0 && message && line.includes(message))).slice(0, LINES);
      messages.push(boundedCaseMessage([message, ...body].filter(Boolean).join('\n')));
    }
  }
  return messages;
}

function nodeTapMessages(text) {
  const messages = [];
  let held = null;
  let records = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('# sflow-node-messages-v1 ')) held = JSON.parse(line.slice('# sflow-node-messages-v1 '.length)).messages;
    else if (line.startsWith('# sflow-node-observation-v1 ')) {
      const occurrences = JSON.parse(line.slice('# sflow-node-observation-v1 '.length)).occurrences ?? [];
      // A report from before the observer wrote messages, or one that does not align, has none.
      const own = Array.isArray(held) && held.length === occurrences.length ? held : [];
      occurrences.forEach((occurrence, index) => messages.push(occurrence?.outcome === 'failed' ? boundedCaseMessage(own[index]) : null));
      held = null;
      records += 1;
    }
  }
  return records ? messages : null;
}

function javascriptJsonMessages(json) {
  const messages = [];
  for (const suite of json?.testResults ?? []) {
    for (const assertion of suite?.assertionResults ?? []) {
      const failed = String(assertion?.status ?? '').toLowerCase() === 'failed';
      const failures = Array.isArray(assertion?.failureMessages) ? assertion.failureMessages.filter((entry) => typeof entry === 'string') : [];
      messages.push(failed ? boundedCaseMessage(failures.join('\n\n')) : null);
    }
  }
  return messages;
}

const MAX_FAILED_SUITES = 50;

/**
 * The test files of a Vitest or Jest report that failed without a failed test: one that did not load
 * (none of its tests is counted), or a hook that threw. Each with its name and bounded message; none
 * when the report does not read or the adapter has no such level.
 */
function failedSuiteMessages(adapter, contents) {
  if (!['jest-json', 'vitest-json'].includes(adapter) || !Array.isArray(contents) || !contents.length) return [];
  try {
    const { testResults } = JSON.parse(joinUtf8(contents.map(bytes)));
    return testResults.filter((suite) => String(suite?.status ?? '').toLowerCase() === 'failed'
      && !(suite.assertionResults ?? []).some((assertion) => String(assertion?.status ?? '').toLowerCase() === 'failed'))
      .slice(0, MAX_FAILED_SUITES).map((suite) => ({ name: String(suite.name ?? ''), message: boundedCaseMessage(suite.message) }));
  } catch { return []; }
}

/**
 * The failure message of each occurrence of one command's report, aligned with its occurrences, or
 * null when the adapter gives totals only or the report does not read (or does not align).
 */
function testCaseMessages(adapter, contents, occurrenceCount) {
  if (!Array.isArray(contents) || !contents.length) return null;
  let messages = null;
  try {
    const buffers = contents.map(bytes);
    if (adapter === 'junit-xml') messages = junitMessages(buffers);
    else if (adapter === 'node-tap') messages = nodeTapMessages(joinUtf8(buffers,'\n'));
    else if (adapter === 'jest-json' || adapter === 'vitest-json') {
      messages = javascriptJsonMessages(JSON.parse(joinUtf8(buffers,'\n')));
    }
  } catch { return null; }
  return messages && messages.length === occurrenceCount ? messages : null;
}

/**
 * What stopped a test run that failed or was blocked: the environment, or the code [TCE:REQ-041].
 *
 * A test-run risk decision (src/test-run-risk.mjs) lets a step through only while the environment
 * stops its tests, never when the change does. So every failed or blocked run is classified from
 * what the run itself shows: the error its launch gave, its timeout, its bounded stdout and stderr,
 * and the failure message of each failed test its report names.
 *
 * - Environment: the launcher is missing or not executable, a dependency is not installed, a
 *   registry, the network or a proxy cannot be reached, the toolchain is the wrong version, a
 *   browser is missing, a service the tests connect to is not reachable, a port they need is taken,
 *   Docker is not available, permission was denied, or every discovered test skipped itself.
 * - Code: a compile error, a syntax error, an import that does not resolve (a repository path, or
 *   a package imported from a file the Story changed), a test file that failed outside its tests
 *   (it did not load, or a hook threw), or tests that ran and failed.
 * - Unknown: the run timed out (a hang the change caused looks like a slow machine), its report
 *   counts no tests, or its output names nothing recognised here.
 *
 * A code marker wins over an environment one, and an unknown cause is never an environment cause:
 * a wrong reading can only refuse a run a person might have accepted, never accept a code fault. A
 * run in which tests executed is an environment cause only when every failed test failed from one
 * [TCE:REQ-043]. Deterministic; the record holds this module's own class and marker names and a
 * path the Story changed, never the run's output.
 */

const ENVIRONMENT = 'environment';
const CODE = 'code';
const UNKNOWN = 'unknown';

/** Every cause class, with its category and the words a person reads. */
const TEST_RUN_CAUSES = Object.freeze({
  'launcher-unavailable': [ENVIRONMENT, 'the test launcher is missing or not executable'],
  'dependency-missing': [ENVIRONMENT, 'a dependency the tests need is not installed'],
  'registry-unreachable': [ENVIRONMENT, 'a package registry, the network or a proxy cannot be reached'],
  'toolchain-version': [ENVIRONMENT, 'the toolchain here is not the version the build needs'],
  'browser-missing': [ENVIRONMENT, 'the browser the tests drive is not installed'],
  'device-unavailable': [ENVIRONMENT, 'no emulator, simulator or device is attached'],
  'service-unreachable': [ENVIRONMENT, 'a service the tests connect to is not reachable'],
  'port-in-use': [ENVIRONMENT, 'a port the tests need is already in use'],
  'docker-unavailable': [ENVIRONMENT, 'Docker is not available'],
  'permission-denied': [ENVIRONMENT, 'the run was denied access to a file or directory'],
  'all-tests-skipped': [ENVIRONMENT, 'every discovered test skipped itself'],
  'compile-error': [CODE, 'the code does not compile'],
  'syntax-error': [CODE, 'a syntax error'],
  'import-error': [CODE, 'an import that does not resolve'],
  'foreign-test-file': [CODE, 'this runner collected a test file written for another runner'],
  'suite-failure': [CODE, 'a test file failed outside its tests, usually while loading'],
  'assertion-failure': [CODE, 'tests ran and failed'],
  'source-mutation': [CODE, 'the run changed application source or test inputs'],
  timeout: [UNKNOWN, 'the run timed out'],
  'no-tests': [UNKNOWN, 'the run found no tests'],
  unrecognised: [UNKNOWN, 'the output names no cause recognised here']
});

// Package binaries a package script runs from node_modules: missing means not installed.
const PACKAGE_BINARIES = 'jest|vitest|mocha|playwright|cypress|tsc|ts-node|tsx|react-scripts|ng|karma|jasmine|ava|nyc|c8|nx|turbo';
// A shell reporting a command it could not run: `sh: 1: mvn: not found`, `zsh: command not found: mvn`.
const SHELL = '^(?:/bin/)?(?:sh|bash|zsh|dash)(?:: line \\d+)?: (?:\\d+: )?';

/** Environment markers, most specific first: [class, marker name, pattern]. */
const ENVIRONMENT_MARKERS = Object.freeze([
  // Instrumented Android and Apple tests need a running emulator, simulator or device; SFlow never starts one.
  ['device-unavailable', 'no device', /ANDROID_DEVICE_UNAVAILABLE|No connected devices!|com\.android\.builder\.testing\.api\.DeviceException|No online devices found|adb: (?:no devices\/emulators found|device offline)|error: no devices\/emulators found|Unable to find a destination matching|Unable to boot (?:the )?[Ss]imulator|No available simulators/u],
  ['docker-unavailable', 'Docker daemon', /Cannot connect to the Docker daemon|Is the docker daemon running|Could not find a valid Docker environment|Could not find a working container runtime strategy|docker\.sock[^\n]*(?:permission denied|no such file|ECONNREFUSED|ENOENT)|\bdocker: (?:command )?not found/iu],
  ['browser-missing', 'browser executable', /Executable doesn't exist at|download new browsers|npx playwright install|Could not find (?:Chrome|Chromium|Firefox)\b|Failed to launch the browser process|Cypress binary is missing|ChromeDriver only supports Chrome version/iu],
  ['toolchain-version', 'Java runtime version', /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime|Unsupported class file major version|invalid (?:target|source) release|release version \d+ not supported|No compiler is provided in this environment|JAVA_HOME is (?:not set|set to an invalid)/u],
  ['toolchain-version', 'Node version file', /asks for Node \S+, and no installed Node matches/u],
  ['toolchain-version', 'engine version', /The engine "node" is incompatible|npm ERR! code EBADENGINE|requires a different Python|requires Node(?:\.js)? (?:version )?[>=^~v]*\d|requires rustc \d|does not support targeting \.NET|go\.mod requires go >=/iu],
  ['registry-unreachable', 'artifact transfer', /Could not transfer artifact|Could not (?:GET|HEAD) '?https?:|Cannot access \S+ \([^)]*\) in offline mode|Could not resolve all (?:files|dependencies|artifacts) for configuration/u],
  ['registry-unreachable', 'network or proxy', /npm ERR! (?:network|code (?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|E407|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY))|\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|Temporary failure in name resolution|Could not resolve host|nodename nor servname provided|Network is unreachable|No route to host|Proxy Authentication Required|tunneling socket could not be established|PKIX path building failed|unable to find valid certification path|self[- ]signed certificate in certificate chain|unable to get local issuer certificate|CERTIFICATE_VERIFY_FAILED|NewConnectionError|Max retries exceeded with url/iu],
  ['service-unreachable', 'ECONNREFUSED', /\bECONNREFUSED\b|Connection refused|\bnet::ERR_CONNECTION_REFUSED\b|\bNS_ERROR_CONNECTION_REFUSED\b|connect ETIMEDOUT \S+:\d+|Communications link failure|Is the server running on host|could not connect to server|Can't connect to (?:local )?MySQL server|MongoServerSelectionError|MongoNetworkError|Connection to \S+:\d+ refused/iu],
  ['port-in-use', 'address in use', /\bEADDRINUSE\b|\baddress already in use\b|\bPort \d+ is already in use\b|\bis already used, make sure that nothing is running on the port/iu],
  ['dependency-missing', 'missing package', new RegExp(`npm ERR! missing|Could not resolve dependencies|Could not find artifact|No matching distribution found|Could not find a version that satisfies the requirement|or one of its dependencies could not be resolved|\\bNo module named pytest\\b|${SHELL}(?:${PACKAGE_BINARIES}): (?:command )?not found|${SHELL}command not found: (?:${PACKAGE_BINARIES})\\b`, 'mu')],
  ['launcher-unavailable', 'command not found', new RegExp(`${SHELL}(?:\\S+: (?:command )?not found|command not found: \\S+|\\S+: Permission denied)|is not recognized as an internal or external command|^(?:/usr/bin/)?env: [^\\n]*No such file or directory`, 'mu')],
  ['permission-denied', 'EACCES', /\b(?:EACCES|EPERM)\b|PermissionError: \[Errno 13\]|AccessDeniedException|Operation not permitted/u]
]);

/** Code markers: [class, marker name, pattern]. Import errors are read separately. */
const CODE_MARKERS = Object.freeze([
  ['compile-error', 'error TS', /\berror TS\d{4,5}\b/u],
  ['compile-error', 'compiler error', /COMPILATION ERROR|^(?:\[ERROR\] )?\S+\.(?:java|kt|kts|scala|groovy):\[\d+,\d+\]|^\S+\.(?:java|scala|groovy|cs|swift|c|cc|cpp|cxx|h|hpp|m|mm|go):\d+(?::\d+)?: (?:fatal )?error\b|^e: (?:file:\/\/)?\S+\.kts?:|Compilation failed; see the compiler error output|Execution failed for task '[^']*:compile\w*'|\berror\[E\d{4}\]|^error: could not compile `|\berror (?:CS|FS|BC)\d{4}\b|\[(?:build|setup) failed\]/mu],
  ['syntax-error', 'SyntaxError', /^(?![^\n]*\bJSON\b)[^\n]*\b(?:SyntaxError|IndentationError|TabError)\b|Jest encountered an unexpected token/mu]
]);

// Playwright refusing to load under Vitest or Jest, which collected its spec.
const FOREIGN_TEST_FILE = /Playwright Test did not expect test\(\) to be called here|Playwright Test needs to be invoked via/u;

// An assertion in a failed test's message: the test ran and checked something.
const ASSERTION = /AssertionError|ERR_ASSERTION|AssertionFailedError|ComparisonFailure|opentest4j|expect\(|Expected values to be|Expected[^\n]*(?:Received|but (?:was|got))|^E\s+assert\b|\bassert(?:ion)? failed\b/mu;

// What failed to import, and from where: [pattern, specifier group, importer group].
const IMPORT_ERRORS = Object.freeze([
  [/Cannot find (?:package|module) '([^'\n]+)' imported from (\S+)/gu, 1, 2],
  [/Cannot find module '([^'\n]+)'(?: from '([^'\n]+)')?(?:[^\n]*\n+Require stack:\n- (\S+))?/gu, 1, 2, 3],
  [/Failed to resolve import "([^"\n]+)" from "([^"\n]+)"/gu, 1, 2],
  [/Can't resolve '([^'\n]+)' in '([^'\n]+)'/gu, 1, 2],
  [/(?:ModuleNotFoundError: No module named|ImportError: No module named) '?([\w.]+)'?/gu, 1, 0]
]);
const PYTHON_FILE = /File "([^"\n]+)", line \d+|importing test module '([^'\n]+)'|^(\S+\.py):\d+: in /gmu;

/** The category of a cause class, or null for none: one class, or environment classes joined by `+`. */
function testRunCauseCategory(causeClass) {
  const parts = String(causeClass ?? '').split('+');
  const categories = new Set(parts.map((part) => TEST_RUN_CAUSES[part]?.[0] ?? null));
  if (categories.has(null) || !parts[0]) return null;
  if (parts.length === 1) return [...categories][0];
  return categories.size === 1 && categories.has(ENVIRONMENT) && parts.join('+') === [...new Set(parts)].sort().join('+') ? ENVIRONMENT : null;
}

/** The words of a cause class, for refusals, decisions and the review. */
function testRunCauseWords(causeClass) {
  return String(causeClass ?? '').split('+').map((part) => TEST_RUN_CAUSES[part]?.[1] ?? part).join(' and ');
}

function cause(causeClass, signal, basis, extra = {}) {
  return { category: TEST_RUN_CAUSES[causeClass][0], class: causeClass, basis, signal, ...extra };
}

/** The first path the Story changed that `text` names as a path, or null. */
function namedChangedPath(text, changedPaths) {
  const normalized = String(text ?? '').replaceAll('\\', '/');
  return changedPaths.find((candidate) => {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`(?:^|[\\s/'"(\`:=[])${escaped}(?=$|[\\s'"():,\`[\\]])`, 'mu').test(normalized);
  }) ?? null;
}

/**
 * Each import error in `text`: code when the target is a repository path, a module under a
 * directory the Story changed, a name a module lacks, or a package imported from a file the Story
 * changed; otherwise a dependency not installed here.
 */
function importCauses(text, changedPaths) {
  const found = [];
  if (/ImportError: cannot import name '[^'\n]+' from|does not provide an export named|no required module provides package/u.test(text)) {
    found.push(cause('import-error', 'missing export', 'process'));
  }
  const pythonFiles = [...text.matchAll(PYTHON_FILE)].map((match) => match[1] ?? match[2] ?? match[3]);
  for (const [pattern, specifierGroup, ...importerGroups] of IMPORT_ERRORS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[specifierGroup];
      const importer = importerGroups.map((group) => (group ? match[group] : null)).find(Boolean)
        ?? (importerGroups[0] === 0 ? pythonFiles.filter((file) => file && text.indexOf(file) < match.index).at(-1) : null);
      const changedImporter = importer ? namedChangedPath(importer, changedPaths) : null;
      const top = importerGroups[0] === 0 ? specifier.split('.')[0] : null;
      const repositoryPath = /^(?:\.{1,2}(?:[/\\]|$)|[/\\~]|[A-Za-z]:[/\\])/u.test(specifier)
        || (top && changedPaths.some((candidate) => `/${candidate}`.includes(`/${top}/`)));
      found.push(repositoryPath || changedImporter
        ? cause('import-error', 'module not found', 'process', changedImporter ? { file: changedImporter } : {})
        : cause('dependency-missing', 'module not found', 'process'));
    }
  }
  return found;
}

/** A code cause named in `text`, or null. */
function codeCause(text, changedPaths) {
  for (const [causeClass, signal, pattern] of CODE_MARKERS) {
    if (!pattern.test(text)) continue;
    const file = namedChangedPath(text, changedPaths);
    return cause(causeClass, signal, 'process', file ? { file } : {});
  }
  return importCauses(text, changedPaths).find((entry) => entry.category === CODE) ?? null;
}

/** An environment cause named in `text`, or null; a package import that fails is a missing dependency. */
function environmentCause(text, changedPaths) {
  const imported = importCauses(text, changedPaths).find((entry) => entry.category === ENVIRONMENT) ?? null;
  for (const [causeClass, signal, pattern] of ENVIRONMENT_MARKERS) {
    if (imported && causeClass === 'dependency-missing') return imported;
    if (pattern.test(text)) return cause(causeClass, signal, 'process');
  }
  return imported;
}

// A runner's quote of the test's own source (`> 2 | await expect(…)`), which says what the test goes on to
// do, not what stopped it: a refused page.goto above an expect() is not an assertion that failed.
const SOURCE_QUOTE = /^[ \t]*>?[ \t]*\d+[ \t]*\|.*$|^[ \t]*\|[ \t]*\^[ \t]*$/gmu;

/** One failed test's message: its code or environment cause, or null when it names neither. */
function failedTestCause(message, changedPaths) {
  const told = message.replace(SOURCE_QUOTE, '');
  return codeCause(told, changedPaths)
    ?? (ASSERTION.test(told) ? cause('assertion-failure', 'assertion', 'tests') : null)
    ?? environmentCause(told, changedPaths);
}

/**
 * A test file that failed outside its tests (`{ name, message }`): what its message names. One that names
 * nothing is the code's, never the environment's: the report says the file failed, and not why.
 */
function failedSuiteCause({ name, message }, changedPaths) {
  const text = String(message ?? '').slice(0, 4_000);
  const file = namedChangedPath(name, changedPaths);
  const where = file ? { file } : {};
  if (FOREIGN_TEST_FILE.test(text)) return cause('foreign-test-file', 'Playwright spec under another runner', 'tests', where);
  const named = codeCause(text, changedPaths) ?? environmentCause(text, changedPaths);
  return named ? { ...named, basis: 'tests' } : cause('suite-failure', 'suite failed with no failed test', 'tests', where);
}

/** Environment causes read together: their classes joined, sorted, in one cause. */
function joinedEnvironment(causes, extra) {
  return { category: ENVIRONMENT, class: [...new Set(causes.map((entry) => entry.class))].sort().join('+'), basis: 'tests',
    signal: [...new Set(causes.map((entry) => entry.signal))].sort().join(', '), ...extra };
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Classify one failed or blocked run. `check` is the run (status, timedOut, infrastructureUnavailable,
 * bounded stdout and stderr), `tests` its report's counts, `failedMessages` the failure message of
 * each failed test in report order (null when the adapter gives none), `failedSuites` the test files
 * that failed outside their tests (src/test-case-messages.mjs), `changedPaths` the paths the Story changed.
 * Returns `{ category, class, basis, signal }`, with `failedTests` or `failedSuites` when read from
 * them and `file` when a code cause names a changed path.
 */
function classifyTestRunCause({ check = null, tests = null, failedMessages = null, failedSuites = null, changedPaths = [] } = {}) {
  const changed = [...new Set((changedPaths ?? []).filter((entry) => typeof entry === 'string' && entry))];
  const output = `${String(check?.stderr ?? '')}\n${String(check?.stdout ?? '')}`.slice(0, 32_000);
  if (check?.sourceMutation === true) return cause('source-mutation', 'source changed during the run', 'process');
  const failed = count(tests?.failed);
  const executed = count(tests?.passed) + failed;
  if (check?.infrastructureUnavailable === true) return cause('launcher-unavailable', 'spawn ENOENT', 'process');
  const launch = check?.status === 'blocked' ? /Unable to run quality command:[^\n]*?\b(ENOENT|EACCES|EPERM|ENOEXEC)\b/u.exec(output) : null;
  if (launch) return cause('launcher-unavailable', `spawn ${launch[1]}`, 'process');
  if (check?.timedOut === true) return cause('timeout', 'timeout', 'process');
  const code = codeCause(output, changed);
  if (code) return code;
  // A file that failed outside its tests: the tests beside it passing or failing says nothing of it.
  const suites = (failedSuites ?? []).map((suite) => failedSuiteCause(suite, changed));
  if (failed > 0) {
    const messages = Array.isArray(failedMessages) && failedMessages.length === failed ? failedMessages : null;
    // Identical messages read once: a suite whose every test hit the same refused port is one reading.
    const read = new Map();
    for (const message of messages ?? []) {
      const text = String(message ?? '').slice(0, 4_000);
      if (!read.has(text)) read.set(text, text ? failedTestCause(text, changed) : null);
    }
    const causes = [...(messages && read.size <= 2_000 ? read.values() : [null]), ...suites];
    if (causes.every((entry) => entry?.category === ENVIRONMENT)) return joinedEnvironment(causes, { failedTests: failed });
    const named = causes.find((entry) => entry?.category === CODE && entry.class !== 'assertion-failure');
    return named ? { ...named, basis: 'tests', failedTests: failed }
      : cause('assertion-failure', messages ? 'failed test' : 'failed tests without messages', 'tests', { failedTests: failed });
  }
  if (suites.length) {
    return suites.every((entry) => entry.category === ENVIRONMENT) ? joinedEnvironment(suites, { failedSuites: suites.length })
      : { ...suites.find((entry) => entry.category === CODE), failedSuites: suites.length };
  }
  // Tests ran and none failed, yet the run did: nothing here says the environment did it.
  if (executed > 0) return cause('unrecognised', 'tests passed, run failed', 'process');
  const discovered = count(tests?.discovered);
  if (discovered > 0 && count(tests?.skipped) === discovered) return cause('all-tests-skipped', 'every test skipped', 'tests');
  return environmentCause(output, changed)
    ?? (tests && discovered === 0 ? cause('no-tests', 'report counts no tests', 'tests') : cause('unrecognised', 'no recognised marker', 'process'));
}

function playwrightFailureMessages(contents) {
  try {
    const parsed = JSON.parse(joinUtf8(contents.map(bytes)));
    const messages = [];
    const visit = (suite, depth) => {
      if (depth > 128) throw new Error('too deep');
      for (const spec of suite?.specs ?? []) {
        for (const test of spec?.tests ?? []) {
          const last = test?.results?.at(-1) ?? null;
          if (test?.status === 'skipped' || last?.status === 'skipped') continue;
          if (test?.status !== 'unexpected' && !['failed', 'timedOut', 'interrupted'].includes(last?.status)) continue;
          const errors = [last?.error, ...(last?.errors ?? [])].filter((entry) => typeof entry?.message === 'string');
          messages.push(errors.length ? errors.map((entry) => entry.message).join('\n') : null);
        }
      }
      for (const child of suite?.suites ?? []) visit(child, depth + 1);
    };
    for (const suite of parsed?.suites ?? []) visit(suite, 0);
    return messages;
  } catch { return null; }
}

/**
 * The failure message of each failed test of a run, in report order: from the messages aligned with
 * its occurrences (src/test-case-messages.mjs), or read from a Playwright report; null when the
 * adapter gives none.
 */
function failedTestMessages(adapter, occurrences, caseMessages, contents) {
  if (Array.isArray(caseMessages) && Array.isArray(occurrences) && caseMessages.length === occurrences.length && occurrences.length) {
    return occurrences.flatMap((occurrence, index) => (occurrence?.outcome === 'failed' ? [caseMessages[index]] : []));
  }
  return adapter === 'playwright-json' && contents?.length ? playwrightFailureMessages(contents) : null;
}

/**
 * What stopped one recorded run, kept on its attempt as `cause` when the attempt is written: `check`
 * is the run, `parsed` its report (with raw bytes), `attempt` the receipt built from them and
 * `delivery` the Story's delivery evidence, whose source and test paths are what it changed.
 */
function attemptRunCause({ check, parsed, attempt, delivery }) {
  const contents = (parsed?.rawReports ?? []).map((report) => report.contents);
  const occurrences = attempt.occurrences ?? [];
  const failedMessages = attempt.tests?.failed > 0
    ? failedTestMessages(attempt.adapter, occurrences, testCaseMessages(attempt.adapter, contents, occurrences.length), contents) : null;
  return classifyTestRunCause({ check, tests: attempt.tests, failedMessages, failedSuites: failedSuiteMessages(attempt.adapter, contents),
    changedPaths: [...(delivery?.sourcePaths ?? []), ...(delivery?.testPaths ?? [])] });
}

return Object.freeze({CASE_MESSAGE_LIMIT,boundedCaseMessage,failedSuiteMessages,testCaseMessages,TEST_RUN_CAUSES,testRunCauseCategory,testRunCauseWords,classifyTestRunCause,failedTestMessages,attemptRunCause});
}

import path from 'node:path';
import { SingularityFlowError, posix } from './util.mjs';

export const SOURCE_BOUNDARIES = Object.freeze(['unrestricted', 'test-automation']);

export function normalizeSourceBoundary(value = 'unrestricted', phaseId = 'unknown') {
  const boundary = value ?? 'unrestricted';
  if (!SOURCE_BOUNDARIES.includes(boundary)) {
    throw new SingularityFlowError(
      `Phase '${phaseId}' sourceBoundary must be ${SOURCE_BOUNDARIES.join(' or ')}.`
    );
  }
  return boundary;
}

const TEST_DIRECTORY_SEGMENTS = new Set([
  '__tests__', 'e2e', 'fixture', 'fixtures', 'integration-tests', 'page-object',
  'page-objects', 'pageobjects', 'playwright', 'pom', 'snapshot', 'snapshots',
  'spec', 'specs', 'test', 'tests', 'test-utils'
]);

/**
 * Native test layouts whose folders are not named like the set above.
 *
 * An Android instrumented test lives in `src/androidTest/`, a Gradle integration or variant test in
 * `src/integrationTest/` or `src/testDebug/`, an Xcode test target in `MyAppTests/` or
 * `MyAppUITests/`, a .NET test project in `MyApp.Tests/`; Go and pytest mark the file, not the
 * folder. Their tests were classified as product source, so a delivered acceptance test was "not
 * available", every owed @ac tag read as missing, and no edit the author could make satisfied the
 * gate. Case carries the meaning: `Tests` needs a capital T after a lowercase letter or digit, so
 * a product folder such as `contests/` stays product code.
 */
const GRADLE_TEST_SOURCE_SET = /^(?:[a-z][A-Za-z0-9]*Test|test[A-Z][A-Za-z0-9]*)$/u;
const TEST_TARGET_DIRECTORY = /(?:[a-z0-9](?:UI|Unit|Integration|Functional|Snapshot)?Tests|\.(?:[A-Z][A-Za-z]*)?Tests?)$/u;
const NAMED_TEST_FILE = /(?:_test\.go|^test_.+\.py|_test\.py)$/u;

function isNativeTestPath(relative) {
  const segments = relative.split('/');
  const directories = segments.slice(0, -1);
  return directories.some((segment, index) => TEST_TARGET_DIRECTORY.test(segment)
    || (index > 0 && directories[index - 1].toLowerCase() === 'src' && GRADLE_TEST_SOURCE_SET.test(segment)))
    || NAMED_TEST_FILE.test(segments.at(-1) ?? '');
}

// A test case names itself by its file; whatever else sits beside it may support it.
const TEST_CASE_FILE = /(?:\.(?:spec|test|e2e)\.[a-z0-9]+|_test\.(?:go|py)|^test_.+\.py|(?:Test|Tests|IT|Spec)\.(?:java|kt|kts|scala|cs|swift|groovy))$/u;
const TEST_SUPPORT_DIRECTORIES = new Set(['__mocks__', 'mocks', 'mock', 'fixture', 'fixtures', 'support', 'helpers', 'helper',
  'stubs', 'stub', 'factories', 'page-object', 'page-objects', 'pageobjects', 'pom', 'test-utils', 'setup']);
const TEST_SUPPORT_FILE = /(?:^|[._-])(?:mocks?|fixtures?|setup|teardown|helpers?|stubs?|factor(?:y|ies)|support|utils?)(?:[._-][a-z0-9]+)*\.[a-z0-9]+$/iu;

/**
 * A test-support module: a mock, fixture, setup, helper or page object, which a test uses but which proves nothing by
 * running. A plan listed three E2E setup and mock modules as an AC's planned tests; only the reviewer said so
 * (office, 2026-11-11). Narrow on purpose: a file named like a test case is never support, and an ordinary file in
 * a test folder (test/calculator.js) is not either.
 */
export function isTestSupportPath(candidate) {
  const relative = posix(String(candidate ?? '')).replace(/^\.\//, '');
  if (!relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) return false;
  const segments = relative.split('/');
  const basename = segments.at(-1) ?? '';
  if (TEST_CASE_FILE.test(basename)) return false;
  if (basename === 'conftest.py' || /\.page\.[a-z0-9]+$/iu.test(basename)) return true;
  if (segments.slice(0, -1).some((segment) => TEST_SUPPORT_DIRECTORIES.has(segment.toLowerCase()))) return true;
  return TEST_SUPPORT_FILE.test(basename);
}

/**
 * A deliberately narrow repository-independent boundary for generated browser automation.
 * Product directories such as `src/pages` are not accepted merely because they contain the word
 * "page". Teams with another convention can change the governed policy after human review.
 */
export function isTestAutomationPath(candidate) {
  const relative = posix(String(candidate ?? '')).replace(/^\.\//, '');
  if (!relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) return false;
  const segments = relative.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  if (segments.some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) return true;
  if (/^(?:playwright|cypress)\.config\.[a-z0-9]+$/.test(basename)) return true;
  if (/\.(?:spec|test|e2e)\.[a-z0-9]+$/.test(basename)) return true;
  if (/\.page\.[a-z0-9]+$/.test(basename)) return true;
  return isNativeTestPath(relative);
}

export function assertSourceBoundary(boundary, files, { phaseId = 'unknown' } = {}) {
  const normalized = normalizeSourceBoundary(boundary, phaseId);
  if (normalized === 'unrestricted') return;
  const outside = [...new Set(files ?? [])].filter((file) => !isTestAutomationPath(file));
  if (outside.length) {
    throw new SingularityFlowError(
      `Phase ${phaseId} may change test automation only; product-source changes are outside its boundary: ${outside.join(', ')}`,
      { code: 'SOURCE_BOUNDARY_VIOLATION' }
    );
  }
}

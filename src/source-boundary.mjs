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
      `Phase ${phaseId} may change test automation only; product-source changes are outside its governed boundary: ${outside.join(', ')}`,
      { code: 'SOURCE_BOUNDARY_VIOLATION' }
    );
  }
}

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
  return false;
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

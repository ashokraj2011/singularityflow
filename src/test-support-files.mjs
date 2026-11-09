/**
 * Test setup as one change, so a person decides it once.
 *
 * Adding a runner touches its configuration, the setup file, the manifest and the lockfile. In bin-opr that was one
 * fact and cost a person one plan decision and three adjudications, each read alone. These words only group what a
 * person is asked: every file is still recorded by name, nothing here settles a file, and a test or application
 * source is never one of them.
 */
import path from 'node:path';

import { configurationPathKind } from './engine-compatibility/node-source-policy.mjs';
import { isRunnerConfigurationName } from './test-runners.mjs';
import { posix } from './util.mjs';

// What a runner loads around the tests rather than as one.
const SETUP_FILE = /^(?:setup-?tests?|test-?setup|tests?\.setup|(?:vitest|jest|playwright)\.setup|global-?(?:setup|teardown))\.[cm]?[jt]sx?$/iu;
const SETUP_IN_TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__|e2e|spec)\/(?:[^/]+\/)*(?:setup|helpers?|utils?|support)(?:\.[cm]?[jt]sx?$|\/)/iu;
const TEST_NAME = /\.(?:test|spec|e2e|cy|pw)\.[cm]?[jt]sx?$/u;
const PACKAGE_MANIFEST = /^(?:package\.json|requirements(?:[-_.][\w-]+)?\.txt|composer\.json|gemfile)$/iu;

const isRunnerConfiguration = (file) => isRunnerConfigurationName(path.posix.basename(file));
const isSetupFile = (file) => !TEST_NAME.test(file) && (SETUP_FILE.test(path.posix.basename(file)) || SETUP_IN_TEST_FOLDER.test(file));
const isDependencyFile = (file) => PACKAGE_MANIFEST.test(path.posix.basename(file)) || configurationPathKind(file) === 'dependency-lock';

/**
 * The files among `paths` that are one test setup: a runner's configuration or setup file, with the manifest and
 * lockfile that change with it. Empty unless at least one of those is there and there are two to group: a manifest
 * and its lockfile alone are a dependency change, which may have nothing to do with tests.
 */
export function testSetupFiles(paths) {
  const files = [...new Set((paths ?? []).map((file) => posix(String(file))))];
  const anchors = files.filter((file) => isRunnerConfiguration(file) || isSetupFile(file));
  if (!anchors.length) return [];
  const members = files.filter((file) => anchors.includes(file) || isDependencyFile(file));
  return members.length >= 2 ? members : [];
}

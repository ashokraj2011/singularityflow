/**
 * The build files of ecosystems a changed path's walk to its module must stop at [TCE:REQ-051], and
 * the `node --test` fallback's own runner check [TCE:REQ-054]. Loaded only where a code-delivery gate,
 * its recovery preview or test setup maps a changed path to the command that tests it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sourceEcosystem, testSetupRoute } from './code-delivery-tests.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { exists, secureRepositoryPath, SingularityFlowError } from './util.mjs';

// [name, the ecosystem it builds, what it is]. Alone in a directory one owns everything below it; beside
// a supported manifest of another ecosystem it owns its ecosystem's files, and a native build owns none
// (the package beside it builds and tests that code). Either way the walk stops there, so an unrelated
// root manifest's tests never count as their coverage. Python's own build files infer pytest; the
// others have no structured test adapter.
const FOREIGN_MARKERS = Object.freeze([
  [/^Podfile$/u, 'swift', 'a CocoaPods'], [/^Gemfile$/u, 'ruby', 'a Ruby'], [/^composer\.json$/u, 'php', 'a PHP Composer'],
  [/^pubspec\.yaml$/u, 'dart', 'a Dart/Flutter'], [/^(?:requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile)$/u, 'python'],
  [/^(?:environment\.yml|noxfile\.py)$/u, 'python', 'a conda or nox Python'], [/\.(?:xcodeproj|xcworkspace)$/u, 'swift', 'an Xcode'],
  [/^(?:CMakeLists\.txt|meson\.build)$/u, 'native', 'a CMake or Meson']
]);
const NODE_TEST_IMPORT = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*['"]node:test['"]/u;

async function markerHolds(root, directory, name) {
  const at = path.join(root, directory, name);
  if (/\.xcodeproj$/u.test(name)) return exists(path.join(at, 'project.pbxproj'));
  if (/\.xcworkspace$/u.test(name)) return exists(path.join(at, 'contents.xcworkspacedata'));
  // A conda environment declares top-level dependencies; any other environment.yml is not a build.
  if (name === 'environment.yml') {
    const manifest = await readRepositoryManifest(root, path.posix.join(directory, name)).catch(() => null);
    return /^dependencies\s*:/mu.test(manifest?.bytes.toString('utf8') ?? '');
  }
  return exists(at);
}

/**
 * The module another ecosystem's build file in `directory` makes of `relative`, beside the supported
 * `manifests` there: a Python module, a refusal naming a build no structured runner supports, or null
 * when no such build file owns the path. `names` is the directory's listing.
 */
export async function foreignBuildModule(root, directory, relative, names, manifests) {
  for (const [pattern, ecosystem, label] of FOREIGN_MARKERS) {
    if ((manifests.length && sourceEcosystem(relative) !== ecosystem) || manifests.some((entry) => entry.system === ecosystem)) continue;
    const name = names.find((entry) => pattern.test(entry));
    if (!name || !await markerHolds(root, directory, name)) continue;
    if (!label) return { root: directory || '.', system: 'python', manifest: name, configured: false };
    const manifest = directory ? `${directory}/${name}` : name;
    throw new SingularityFlowError(
      `Changed path '${relative}' belongs to ${manifest}, ${label} build with no supported structured test runner, `
      + 'so no inferred test command covers it; an unrelated manifest\'s tests never count as its coverage. '
      + 'Configure an approved test command for it (kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
      { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ path: relative, manifest, nativeManifest: name, system: ecosystem }) }
    );
  }
  return null;
}

/**
 * Refuse the `node --test` fallback for test files that do not import node:test: it would run a mocha,
 * jasmine or tap file with the wrong runner. A planned test not written yet does not decide.
 */
export async function assertNodeTestFiles(root, tests) {
  const others = [];
  for (const candidate of tests) {
    const secured = await secureRepositoryPath(root, candidate, { label: 'Test source', type: 'file' });
    if (secured.exists && !NODE_TEST_IMPORT.test(await readFile(secured.absolute, 'utf8'))) others.push(candidate);
  }
  if (others.length) {
    throw new SingularityFlowError(`Test files ${others.join(', ')} do not import node:test, and node --test would run them `
      + 'with the wrong runner, so no test command was inferred for them. Configure an approved test command for their runner '
      + '(kind: test, argv, workingDirectory, affectedRoots and a result adapter).',
    { code: 'TEST_MODULE_UNCOVERED', details: testSetupRoute({ paths: others }) });
  }
}

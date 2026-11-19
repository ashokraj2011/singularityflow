/**
 * Which person's question a changed file outside the plan is, by its path alone, with the words the card says it in
 * [owner, 2026-11-19, C3]: a dependency, how the product is built, shipped or tested, or who governs the repository. A
 * leaf the decision list reads; out-of-plan-classes.mjs holds the rest of the rule.
 */
import path from 'node:path';

import { configurationPathKind } from './configuration-paths.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';

export const IGNORE_FILES = new Set(['.gitignore', '.dockerignore', '.npmignore', '.prettierignore', '.eslintignore']);
// A dependency manifest: what third-party code the product runs (lock files are configurationPathKind's dependency-lock).
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'go.mod', 'go.work', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'gemfile', 'composer.json', 'pipfile', 'setup.py', 'setup.cfg', 'directory.packages.props', 'packages.config', 'podfile', 'package.swift', 'pubspec.yaml']);
const MANIFEST_PATTERNS = [/^requirements(?:[-_.][\w-]+)?\.txt$/u, /\.(?:cs|fs|vb)proj$/u, /\.gemspec$/u];
/**
 * What class of person's question a file is, by its path alone, with the words the card says it in; null for a file that is
 * none of the named ones (behaviour, unless a settle class takes it). Read by the card for every file departure.
 */
export function personClass(file) {
  const relative = String(file ?? '');
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  const kind = configurationPathKind(relative);
  if (kind === 'dependency-lock' || MANIFESTS.has(base) || MANIFEST_PATTERNS.some((pattern) => pattern.test(base))) {
    return { class: 'dependency', words: 'It can add or change the third-party code the product runs, so a person decides it.' };
  }
  if (kind === 'build-configuration' || kind === 'ci-configuration' || classifySupportingChange(relative).class === 'ci-configuration') {
    return { class: 'build', words: 'It changes how the product is built, shipped or tested (a test runner\'s configuration can narrow which tests run), so a person decides it.' };
  }
  if (kind === 'repository-metadata' && !IGNORE_FILES.has(base)) {
    return { class: 'governance', words: 'It changes who reviews the repository, what is marked generated, or what runs when it is opened, so a person decides it.' };
  }
  return null;
}


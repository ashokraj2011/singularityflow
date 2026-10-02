/**
 * What a plan may list under `## Supporting files`: changes the code needs that no requirement
 * claims and that cannot carry a `@clause` tag. Each entry must belong to one of a closed set of
 * classes and state why it changes. Application source, test source and migrations never qualify:
 * listing them as supporting would let behaviour escape requirement accounting, so they belong in
 * a clause row of the plan instead.
 */
import path from 'node:path';
import { posix } from './util.mjs';
import { isTestAutomationPath } from './source-boundary.mjs';

export const SUPPORTING_CHANGE_CLASSES = Object.freeze([
  'dependency-lock', 'build-configuration', 'ci-configuration', 'repository-metadata', 'documentation'
]);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'cargo.lock', 'go.sum', 'go.work.sum',
  'composer.lock', 'gradle.lockfile', 'packages.lock.json', 'podfile.lock', 'pubspec.lock', 'mix.lock',
  'flake.lock', 'package.resolved', 'conan.lock'
]);

const BUILD_FILES = new Set([
  'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'gradle.properties', 'gradlew', 'gradlew.bat', 'mvnw', 'mvnw.cmd', 'pyproject.toml', 'setup.cfg', 'setup.py',
  'pipfile', 'tox.ini', 'go.mod', 'go.work', 'cargo.toml', 'gemfile', 'composer.json', 'directory.build.props',
  'directory.build.targets', 'directory.packages.props', 'global.json', 'nuget.config', 'jsconfig.json',
  '.babelrc', 'karma.conf.js', '.editorconfig', 'makefile', 'cmakelists.txt', 'dockerfile', 'compose.yml',
  'compose.yaml', '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions', '.npmrc',
  '.yarnrc', '.yarnrc.yml', 'angular.json', 'nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml',
  'podfile', 'build.sbt', 'pubspec.yaml', 'analysis_options.yaml', 'mkdocs.yml', 'build.properties'
]);
const BUILD_PATTERNS = [
  /^requirements(?:[-_.][\w-]+)?\.txt$/u, /^tsconfig(?:\.[\w-]+)?\.json$/u, /\.gemspec$/u, /\.(?:cs|fs|vb)proj$/u, /\.sln$/u,
  /^(?:babel|webpack|vite|rollup|esbuild|jest|vitest|prettier|postcss|tailwind|svelte|next|nuxt|astro)\.config\.[cm]?[jt]s$/u,
  /^(?:babel|jest)\.config\.json$/u, /^\.eslintrc(?:\.[a-z]+)?$/u, /^eslint\.config\.[cm]?[jt]s$/u, /^\.prettierrc(?:\.[a-z]+)?$/u,
  /^\.stylelintrc(?:\.[a-z]+)?$/u, /\.cmake$/u, /\.dockerfile$/u, /^docker-compose(?:\.[\w-]+)?\.ya?ml$/u
];
const BUILD_PATHS = [/^gradle\/wrapper\//u, /^\.mvn\/wrapper\//u];

const CI_PATHS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/u, /^\.github\/actions\//u, /^\.gitlab-ci\.yml$/u, /^\.gitlab\/ci\//u,
  /^jenkinsfile$/u, /^azure-pipelines\.ya?ml$/u, /^\.azure-pipelines\//u, /^\.circleci\//u, /^bitbucket-pipelines\.yml$/u,
  /^\.travis\.yml$/u, /^\.buildkite\//u, /^\.drone\.yml$/u, /^cloudbuild\.ya?ml$/u, /^buildspec\.ya?ml$/u
];

const METADATA_FILES = new Set([
  '.gitignore', '.gitattributes', 'codeowners', '.dockerignore', '.npmignore', '.prettierignore', '.eslintignore',
  '.mailmap', 'renovate.json'
]);
const METADATA_PATHS = [/^\.github\/dependabot\.ya?ml$/u, /^\.github\/renovate\.json$/u, /^\.github\/pull_request_template\.md$/u, /^\.github\/issue_template\//u];

const DOCUMENT_EXTENSIONS = /\.(?:md|markdown|mdx|rst|adoc|txt)$/u;
const MIGRATION_SEGMENT = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/u;

/**
 * Classify one exact repository path for the supporting-files list.
 * Returns `{ class }` for an allowed class, or `{ refused, reason }` when the path cannot be one.
 */
export function classifySupportingChange(candidate) {
  const relative = posix(String(candidate ?? '')).replace(/^\.\//u, '');
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  const atRoot = !lower.includes('/');
  if (MIGRATION_SEGMENT.test(lower)) {
    return { refused: 'migration', reason: 'a migration changes data or schema behaviour' };
  }
  if (isTestAutomationPath(relative)) {
    return { refused: 'test-source', reason: 'a test belongs in the Planned tests column of its clause row' };
  }
  if (LOCKFILES.has(base) || /^gradle\/dependency-locks\//u.test(lower)) return { class: 'dependency-lock' };
  if (CI_PATHS.some((pattern) => pattern.test(lower))) return { class: 'ci-configuration' };
  if (METADATA_FILES.has(base) || METADATA_PATHS.some((pattern) => pattern.test(lower))) return { class: 'repository-metadata' };
  if (BUILD_FILES.has(base) || BUILD_PATTERNS.some((pattern) => pattern.test(base)) || BUILD_PATHS.some((pattern) => pattern.test(lower))) {
    return { class: 'build-configuration' };
  }
  if (DOCUMENT_EXTENSIONS.test(base) && (atRoot || /^docs?\//u.test(lower))) return { class: 'documentation' };
  return { refused: 'application-source', reason: 'it can carry application behaviour, so a clause must claim it' };
}

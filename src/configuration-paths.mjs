/**
 * Repository configuration is a reviewed input, not product source or an executable test.
 * One path policy is shared by planning, delivery, documentation and repair. This classification
 * never excludes bytes from candidate hashing, tests, protected-path checks or scope accounting.
 */
import path from 'node:path';

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'gemfile.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'pdm.lock', 'cargo.lock', 'go.sum', 'go.work.sum',
  'composer.lock', 'gradle.lockfile', 'packages.lock.json', 'podfile.lock', 'pubspec.lock', 'mix.lock',
  'flake.lock', 'package.resolved', 'conan.lock'
]);
const BUILD_FILES = new Set([
  'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'gradle.properties', 'gradlew', 'gradlew.bat', 'mvnw', 'mvnw.cmd', 'pyproject.toml', 'setup.cfg', 'setup.py',
  'pipfile', 'tox.ini', 'pytest.ini', '.coveragerc', '.pylintrc', 'ruff.toml', '.ruff.toml', 'go.mod', 'go.work',
  'cargo.toml', 'gemfile', 'composer.json', 'directory.build.props', 'directory.build.targets',
  'directory.packages.props', 'global.json', 'nuget.config', 'jsconfig.json', '.babelrc', 'karma.conf.js',
  '.editorconfig', 'makefile', 'cmakelists.txt', 'dockerfile', 'compose.yml', 'compose.yaml', '.nvmrc',
  '.node-version', '.python-version', '.ruby-version', '.tool-versions', '.npmrc', '.yarnrc', '.yarnrc.yml',
  'angular.json', 'nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml', 'podfile', 'package.swift',
  'build.sbt', 'pubspec.yaml', 'analysis_options.yaml', 'mkdocs.yml', 'build.properties',
  'androidmanifest.xml', 'info.plist', '.terraform.lock.hcl'
]);
const BUILD_PATTERNS = [
  /^requirements(?:[-_.][\w-]+)?\.txt$/u, /^tsconfig(?:\.[\w-]+)?\.json$/u, /\.gemspec$/u,
  /\.(?:cs|fs|vb)proj$/u, /\.slnx?$/u, /\.(?:xcconfig|pbxproj|entitlements)$/u,
  /^(?:babel|webpack|vite|rollup|esbuild|jest|vitest|playwright|cypress|pytest|prettier|postcss|tailwind|svelte|next|nuxt|astro)\.config\.[cm]?[jt]sx?$/u,
  /^(?:babel|jest)\.config\.json$/u, /^\.babelrc(?:\.[a-z]+)?$/u, /^\.eslintrc(?:\.[a-z]+)?$/u, /^eslint\.config\.[cm]?[jt]s$/u,
  /^\.prettierrc(?:\.[a-z]+)?$/u, /^\.stylelintrc(?:\.[a-z]+)?$/u, /\.cmake$/u, /\.dockerfile$/u,
  /^docker-compose(?:\.[\w-]+)?\.ya?ml$/u
];
const BUILD_PATHS = [/(?:^|\/)gradle\/(?:wrapper|dependency-locks)\//u, /(?:^|\/)\.mvn\/wrapper\//u];
const CI_PATHS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/u, /^\.github\/actions\/.+\/action\.ya?ml$/u, /^\.gitlab-ci\.yml$/u, /^\.gitlab\/ci\/.+\.ya?ml$/u,
  /^jenkinsfile$/u, /^azure-pipelines\.ya?ml$/u, /^\.azure-pipelines\/.+\.ya?ml$/u, /^\.circleci\/.+\.ya?ml$/u,
  /^bitbucket-pipelines\.yml$/u, /^\.travis\.yml$/u, /^\.buildkite\/.+\.ya?ml$/u, /^\.drone\.yml$/u,
  /^cloudbuild\.ya?ml$/u, /^buildspec\.ya?ml$/u
];
const METADATA_FILES = new Set([
  '.gitignore', '.gitattributes', 'codeowners', '.dockerignore', '.npmignore', '.prettierignore', '.eslintignore',
  '.mailmap', 'renovate.json'
]);
const METADATA_PATHS = [
  /^\.github\/dependabot\.ya?ml$/u, /^\.github\/renovate\.json$/u,
  /^\.github\/pull_request_template\.md$/u, /^\.github\/issue_template\//u,
  /^\.vscode\/[^/]+\.json$/u, /\.code-workspace$/u
];
const RUNTIME_NAMES = [
  /^(?:appsettings|application|bootstrap)(?:[.-][\w-]+)?\.(?:json|ya?ml|properties)$/u,
  /^(?:app|web)\.config$/u, /^\.env(?:\.[\w-]+)?$/u,
  /^[\w-]+\.config\.(?:[cm]?[jt]s|json|ya?ml|toml)$/u,
  /^(?:config|settings)(?:\.[\w-]+)?\.(?:[cm]?[jt]s|py|rb|json|ya?ml|toml|ini|xml|properties)$/u
];
const RUNTIME_DIRECTORY = /(?:^|\/)(?:config|configuration|settings)\/[^/]+\.(?:json|ya?ml|toml|ini|xml|properties)$/u;

/** Exact role for a conventional configuration path; unknown/data/source paths remain null. */
export function configurationPathKind(candidate) {
  const relative = String(candidate ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!relative || relative !== relative.trim() || relative.startsWith('/') || /^[a-z]:/iu.test(relative)
      || /[\u0000-\u001f\u007f]/u.test(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  const lower = relative.toLowerCase();
  // Naming a migration config must never disguise a schema/data migration as supporting work.
  if (/(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/u.test(lower)) return null;
  const base = path.posix.basename(lower);
  if (/\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/u.test(base) || /^(?:test_.+|.+_test)\.py$/u.test(base)) return null;
  if (LOCKFILES.has(base) || /(?:^|\/)gradle\/dependency-locks\//u.test(lower)) return 'dependency-lock';
  if (CI_PATHS.some(pattern => pattern.test(lower))) return 'ci-configuration';
  if (METADATA_FILES.has(base) || METADATA_PATHS.some(pattern => pattern.test(lower))) return 'repository-metadata';
  if (BUILD_FILES.has(base) || BUILD_PATTERNS.some(pattern => pattern.test(base)) || BUILD_PATHS.some(pattern => pattern.test(lower))) return 'build-configuration';
  if (RUNTIME_NAMES.some(pattern => pattern.test(base)) || RUNTIME_DIRECTORY.test(lower)) return 'runtime-configuration';
  return null;
}

export function isConfigurationPath(candidate) {
  return configurationPathKind(candidate) !== null;
}

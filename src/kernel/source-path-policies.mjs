/** Source path, change-set and delivery value rules over explicit primitives. No repository or file access. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,REPOSITORY_CHANGE_SET_SCHEMA,admitRecordSchemaVersion} from '../foundation/record-schema.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {isAgentOutputPath} from '../foundation/agent-output-paths.mjs';
import {configurationPathSyntax} from './configuration-path-policies.mjs';
import {normalizeSourceBoundary} from './configuration-declarations.mjs';
import {SOURCE_CHANGING_FULFILLMENT,sortedUnique} from './specification-policy.mjs';

export function configurationFilePolicies(port) {
  const {path}=configurationPathSyntax(port);
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
function configurationPathKind(candidate) {
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

function isConfigurationPath(candidate) {
  return configurationPathKind(candidate) !== null;
}
  return Object.freeze({configurationPathKind,isConfigurationPath});
}

export function sourceBoundaryPolicies(port) {
  const {path,posix}=configurationPathSyntax(port);
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
function isTestAutomationPath(candidate) {
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

function assertSourceBoundary(boundary, files, { phaseId = 'unknown' } = {}) {
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
  return Object.freeze({isTestAutomationPath,assertSourceBoundary});
}

export function supportingChangePolicies(port) {
  const {path,posix}=configurationPathSyntax(port);
  const {configurationPathKind}=configurationFilePolicies(port);
  const {isTestAutomationPath}=sourceBoundaryPolicies(port);
const SUPPORTING_CHANGE_CLASSES = Object.freeze([
  'dependency-lock', 'build-configuration', 'ci-configuration', 'repository-metadata', 'documentation'
]);

const DOCUMENT_EXTENSIONS = /\.(?:md|markdown|mdx|rst|adoc|txt)$/u;
const MIGRATION_SEGMENT = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/u;
// CI helper scripts were already permitted supporting assets. Keep that exact scope policy:
// they do not become configuration merely by living next to a YAML file, and approved plans
// must not fail to load because the configuration/source roles are now separated.
const CI_SUPPORT_PATHS = [/^\.github\/actions\//u, /^\.gitlab\/ci\//u, /^\.azure-pipelines\//u, /^\.circleci\//u, /^\.buildkite\//u];

/**
 * Classify one exact repository path for the supporting-files list.
 * Returns `{ class }` for an allowed class, or `{ refused, reason }` when the path cannot be one.
 */
function classifySupportingChange(candidate) {
  const relative = posix(String(candidate ?? '')).replace(/^\.\//u, '');
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  const atRoot = !lower.includes('/');
  if (MIGRATION_SEGMENT.test(lower)) {
    return { refused: 'migration', reason: 'a migration changes data or schema behaviour' };
  }
  const configuration = configurationPathKind(relative);
  if (configuration === 'runtime-configuration') {
    return { refused: 'configuration', reason: 'runtime configuration belongs in a clause with fulfillment configuration, not unclaimed supporting files' };
  }
  if (configuration) return { class: configuration };
  if (isTestAutomationPath(relative)) {
    return { refused: 'test-source', reason: 'a test belongs in the Planned tests column of its clause row' };
  }
  if (CI_SUPPORT_PATHS.some(pattern => pattern.test(lower))) return { class: 'ci-configuration' };
  if (DOCUMENT_EXTENSIONS.test(base) && (atRoot || /^docs?\//u.test(lower))) return { class: 'documentation' };
  return { refused: 'application-source', reason: 'it can carry application behaviour, so a clause must claim it' };
}
  return Object.freeze({SUPPORTING_CHANGE_CLASSES,classifySupportingChange});
}

export function applicationPathPolicies(roots) {
  if(!Array.isArray(roots)||roots.length>128||Reflect.ownKeys(roots).length!==roots.length+1
    ||Array.from({length:roots.length},(_,index)=>Object.getOwnPropertyDescriptor(roots,String(index)))
      .some(property=>!property?.enumerable||!Object.hasOwn(property,'value')))
    throw new SingularityFlowError('Application path policy needs bounded declared roots.',{code:'ENGINE_SOURCE_PATH_POLICY_INVALID'});
  const GOVERNED_ROOTS=Object.freeze(roots.map(value=>sourceRelativePath(value)));

function safeGovernedRoot(value) {
  const portable = String(value ?? '').trim().replaceAll('\\', '/');
  if (!portable || /[\u0000-\u001f\u007f]/.test(portable)
      || portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) return null;
  const normalized = pathNormalize(portable.replace(/^\.\/+/, '').replace(/\/+$/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) return null;
  return normalized;
}

function pathNormalize(value) {
  const segments = [];
  for (const segment of String(value).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Git emits repository paths with forward slashes on every platform. Treat any other spelling as
 * invalid instead of normalizing it into a different file: a durable evidence record must have one
 * portable identity on Windows, macOS, and Linux.
 */
function portableRepositoryPath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
      || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)
      || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const normalized = pathNormalize(value);
  return normalized === value ? normalized : null;
}

function requiredRepositoryPath(value) {
  const normalized = portableRepositoryPath(value);
  if (!normalized) {
    throw new SingularityFlowError(
      `Repository path '${String(value ?? '')}' is not a canonical portable path.`,
      { code: 'REPOSITORY_PATH_INVALID' }
    );
  }
  return normalized;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function configuredRoots(source) {
  const direct = object(source);
  const resolution = object(direct.resolution);
  return [direct, resolution].flatMap((owner) => [
    owner.workItemRoot,
    owner.initiativeRoot,
    owner.templatesRoot,
    owner.agentPromptsRoot,
    owner.worldModelOutputDir,
    owner.outputDir,
    object(owner.worldModel).outputDir,
    ...(Array.isArray(owner.governedRoots) ? owner.governedRoots : [])
  ]);
}

function configuredPaths(source) {
  const direct = object(source);
  const resolution = object(direct.resolution);
  return [direct, resolution].flatMap((owner) => {
    const configurationSource = object(owner.configurationSource);
    return [
      ...(Array.isArray(owner.governedPaths) ? owner.governedPaths : []),
      ...Object.keys(object(configurationSource.files)),
      ...Object.keys(object(configurationSource.assets)),
      ...Object.keys(object(configurationSource.removed)),
      ...Object.values(object(owner.templates)).map((template) => object(template).path),
      object(owner.worldModel).promptSource === 'builtin' ? null : object(owner.worldModel).promptSource
    ];
  });
}

function caseInsensitiveSource(source) {
  const direct = object(source);
  return direct.caseInsensitivePaths === true
    || object(direct.target).caseInsensitivePaths === true
    || object(direct.resolution).caseInsensitivePaths === true;
}

function uniquePaths(values, { caseInsensitivePaths = false } = {}) {
  const selected = new Map();
  for (const value of values) {
    const normalized = safeGovernedRoot(value);
    if (!normalized) continue;
    const key = caseInsensitivePaths ? normalized.toLocaleLowerCase('en-US') : normalized;
    if (!selected.has(key)) selected.set(key, normalized);
  }
  return [...selected.values()].sort();
}

/**
 * Build the complete governance boundary from immutable lifecycle resolution plus live policy.
 *
 * The starter locations are always governed. Repositories may move Story and Initiative state
 * outside `singularity/`; those configured roots must follow the same ownership rule everywhere
 * application paths are hashed, counted, adopted, or checked for scope expansion.
 */
function applicationPathContext(...sources) {
  const caseInsensitivePaths = sources.some(caseInsensitiveSource);
  return Object.freeze({
    caseInsensitivePaths,
    governedRoots: Object.freeze(uniquePaths([
      ...GOVERNED_ROOTS, ...sources.flatMap(configuredRoots)
    ], { caseInsensitivePaths })),
    governedPaths: Object.freeze(uniquePaths(
      sources.flatMap(configuredPaths), { caseInsensitivePaths }
    ))
  });
}

function pathContext(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return applicationPathContext();
  }
  if (typeof options.caseInsensitivePaths === 'boolean'
      && Array.isArray(options.governedRoots) && Array.isArray(options.governedPaths)) return options;
  return applicationPathContext(options);
}

function comparisonPath(value, caseInsensitivePaths) {
  return caseInsensitivePaths ? value.toLocaleLowerCase('en-US') : value;
}

/**
 * SFlow-owned structured command results are transport state, not product source: test reports
 * under `.sflow/results`, and agent results in the checkout's `.sflow/out`.
 */
function isTransientTestResultPath(candidate, options = null) {
  const normalized = portableRepositoryPath(candidate);
  if (!normalized) return false;
  const context = pathContext(options);
  const compared = comparisonPath(normalized, context.caseInsensitivePaths);
  return /(?:^|\/)\.sflow\/results(?:\/|$)/.test(compared) || isAgentOutputPath(compared);
}

// The folders a test runner writes each run's results into by default: Playwright's results, HTML and
// blob reports (test-results/.last-run.json after every run). A repository that never ignored them
// showed each run's results as a change nobody made, at every approval. Coverage reports are not
// here: an untracked coverage folder stays for a person to look at, as any other output directory.
const TEST_RUNNER_OUTPUT_SEGMENTS = Object.freeze(['test-results', 'playwright-report', 'blob-report']);

/** A test runner's own output folder; disposable only when Git says the file is untracked. */
function isTestRunnerOutputPath(candidate, options = null) {
  const normalized = portableRepositoryPath(candidate);
  if (!normalized) return false;
  const compared = comparisonPath(normalized, pathContext(options).caseInsensitivePaths);
  return compared.split('/').slice(0, -1).some((segment) => TEST_RUNNER_OUTPUT_SEGMENTS.includes(segment));
}

/** Generic generated trees are excluded only when their Git provenance says they are untracked. */
function isGeneratedOutputPath(candidate, options = null) {
  const normalized = portableRepositoryPath(candidate);
  if (!normalized) return false;
  const context = pathContext(options);
  const compared = comparisonPath(normalized, context.caseInsensitivePaths);
  return isTransientTestResultPath(normalized, context) || isTestRunnerOutputPath(normalized, context)
    || compared.split('/').some((segment) => ['node_modules', 'vendor', 'target', 'build', 'coverage'].includes(segment));
}

/** The single ownership boundary shared by lifecycle, review, specification, WM, and Auto. */
function isApplicationPath(candidate, options = null) {
  const normalized = requiredRepositoryPath(candidate);
  const context = pathContext(options);
  const compared = comparisonPath(normalized, context.caseInsensitivePaths);
  if (compared === '.git' || compared.startsWith('.git/')
      || isTransientTestResultPath(normalized, context)) return false;
  const roots = context.governedRoots.map((root) => comparisonPath(root, context.caseInsensitivePaths));
  const paths = context.governedPaths.map((file) => comparisonPath(file, context.caseInsensitivePaths));
  return !roots.some((root) => compared === root || compared.startsWith(`${root}/`))
    && !paths.includes(compared);
}

function isApplicationChangePath(candidate, supplied = {}) {
  const settings = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
  const { untracked = false, ...options } = settings;
  if (isTransientTestResultPath(candidate, options)) return false;
  return isApplicationPath(candidate, options) && !(untracked && isGeneratedOutputPath(candidate, options));
}

function isApplicationChangeEntry(entry, options = null) {
  return [entry?.oldPath, entry?.newPath].filter(Boolean).some((candidate) =>
    isApplicationChangePath(candidate, {
      ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
      untracked: entry?.untracked === true && candidate === entry?.newPath
    }));
}
  return Object.freeze({applicationPathContext,isTransientTestResultPath,isTestRunnerOutputPath,isGeneratedOutputPath,isApplicationPath,isApplicationChangePath,isApplicationChangeEntry});
}

export function changeScopePolicies(port) {
  const {posix}=configurationPathSyntax(port);
function changeSetPaths(changeSet, { bothEndpoints = true } = {}) {
  const paths = [];
  for (const entry of changeSet?.entries ?? []) {
    if (bothEndpoints && entry.oldPath) paths.push(entry.oldPath);
    if (entry.newPath) paths.push(entry.newPath);
  }
  return [...new Set(paths)].sort();
}

function pathMatches(candidate, guard, { caseInsensitive = false } = {}) {
  const pathValue = posix(candidate);
  const guardValue = posix(guard).replace(/\/$/, '');
  const [left, right] = caseInsensitive
    ? [pathValue.toLocaleLowerCase('en-US'), guardValue.toLocaleLowerCase('en-US')]
    : [pathValue, guardValue];
  return left === right || left.startsWith(`${right}/`);
}

function evaluateProtectedPaths(changeSet, guards = [], options = {}) {
  const comparison = {
    caseInsensitive: options.caseInsensitive ?? changeSet?.target?.caseInsensitivePaths ?? false
  };
  const violations = [];
  for (const entry of changeSet?.entries ?? []) {
    for (const endpoint of ['oldPath', 'newPath']) {
      const candidate = entry[endpoint];
      const guard = candidate && guards.find((value) => pathMatches(candidate, value, comparison));
      if (guard) violations.push({ changeId: entry.changeId, endpoint, path: candidate, guard, status: entry.status });
    }
  }
  return { valid: violations.length === 0, violations };
}

function evaluateSourceBoundary(changeSet, boundary, {
  allowedPath = () => true,
  phaseId = 'unknown'
} = {}) {
  if (boundary === 'unrestricted') return { valid: true, violations: [] };
  if (boundary !== 'test-automation') {
    throw new SingularityFlowError(`Unknown source boundary '${boundary}' for phase '${phaseId}'.`);
  }
  const violations = [];
  for (const entry of changeSet?.entries ?? []) {
    for (const endpoint of ['oldPath', 'newPath']) {
      const candidate = entry[endpoint];
      if (candidate && !allowedPath(candidate)) {
        violations.push({ changeId: entry.changeId, endpoint, path: candidate, status: entry.status });
      }
    }
  }
  return { valid: violations.length === 0, violations };
}
  return Object.freeze({changeSetPaths,evaluateProtectedPaths,evaluateSourceBoundary});
}

export function deliveryClassificationPolicies(port, roots) {
  const {posix}=configurationPathSyntax(port);
  const {configurationPathKind}=configurationFilePolicies(port);
  const {isTestAutomationPath:isAllowedTestAutomationPath}=sourceBoundaryPolicies(port);
  const {isApplicationChangeEntry,isGeneratedOutputPath}=applicationPathPolicies(roots);
function pathInside(candidate, root) {
  const value = posix(candidate ?? '');
  const prefix = posix(root ?? '').replace(/\/$/, '');
  return Boolean(value && prefix && (value === prefix || value.startsWith(`${prefix}/`)));
}

// Documentation may accompany a code delivery, but it cannot itself satisfy the product-source
// requirement. Keep this intentionally narrow: a Markdown file under docs/ or a nested README
// may be executable product input in a documentation application. Only conventional top-level
// project notes get this special classification.
function isDocumentationPath(candidate) {
  const relative = posix(candidate ?? '');
  return /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE)(?:\.(?:md|markdown|mdx|rst|adoc|txt))?$/iu.test(relative);
}

/**
 * Describe what each changed path is for without pretending path names prove who authored bytes.
 * Explicit authorship/change-origin declarations live on the generation receipt; this projection
 * only supplies deterministic repository roles and clearly labels its path-policy inference.
 */
function classifyDeliveryChanges(changeSet, {
  generatedRoots = [], declaredOrigins = [], pathContext = null
} = {}) {
  const roots = [...new Set(generatedRoots.map(posix).filter(Boolean))];
  const entries = (changeSet?.entries ?? [])
    .filter((entry) => isApplicationChangeEntry(entry, pathContext)).map((entry) => {
    const candidate = entry.newPath ?? entry.oldPath;
    const configuredGenerated = roots.some((root) => pathInside(candidate, root));
    const testOutput = /(?:^|\/)(?:\.sflow\/results|coverage|test-results|surefire-reports)(?:\/|$)/i.test(candidate ?? '');
    const compilerOutput = /(?:^|\/)(?:target|build|dist|out)(?:\/(?:classes|generated|resources))?(?:\/|$)/i.test(candidate ?? '');
    const migration = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/i.test(candidate ?? '');
    const test = isAllowedTestAutomationPath(candidate ?? '');
    const configuration = configurationPathKind(candidate);
    const documentation = isDocumentationPath(candidate);
    const generated = configuredGenerated || isGeneratedOutputPath(candidate ?? '');
    const role = configuration ? configuration : configuredGenerated ? 'generated-source'
      : testOutput ? 'test-output'
        : compilerOutput ? 'compiler-output'
          : migration ? 'migration'
            : test ? 'test-source'
                : documentation ? 'documentation'
                  : generated ? 'generated-output' : 'product-source';
    const likelyOrigin = configuredGenerated ? 'code-generator'
      : testOutput ? 'test-runner'
        : compilerOutput ? 'compiler'
          : migration ? 'migration-tool-or-human'
            : 'authorship-declared';
    return {
      changeId: entry.changeId, status: entry.status,
      oldPath: entry.oldPath, newPath: entry.newPath,
      role, generated, likelyOrigin, inference: 'path-policy'
    };
  });
  const counts = Object.fromEntries([...new Set(entries.map((entry) => entry.role))]
    .sort().map((role) => [role, entries.filter((entry) => entry.role === role).length]));
  return {
    schemaVersion: 1, inference: 'path-policy', declaredOrigins: [...declaredOrigins],
    generatedRoots: roots, counts, entries
  };
}
  return Object.freeze({pathInside,isDocumentationPath,classifyDeliveryChanges});
}

/** Source observations remain facts: this projection neither authorizes edits nor publishes. */
export function sourceChangeInspectionPolicies(port, roots) {
  const {applicationPathContext,isApplicationChangeEntry}=applicationPathPolicies(roots);
  const {classifyDeliveryChanges}=deliveryClassificationPolicies(port,roots);
  const {evaluateProtectedPaths,evaluateSourceBoundary}=changeScopePolicies(port);
  const {isTestAutomationPath}=sourceBoundaryPolicies(port);
  function inspectSourceChanges(changes,{definition,workflow,phase,applicationOnly=false}) {
    const context=applicationPathContext(definition,workflow.resolution);
    const selected=applicationOnly?{...changes,entries:changes.entries.filter(entry=>isApplicationChangeEntry(entry,context))}:changes;
    const guards=[...new Set([...(definition.governance?.protectedPaths??[]),...(workflow.resolution.governance?.protectedPaths??[]),
      ...(workflow.resolution.capability?.policy?.protectedPaths??[])])];
    const boundary=normalizeSourceBoundary(phase.sourceBoundary,phase.id);
    const roles=new Map(classifyDeliveryChanges(selected,{pathContext:context}).entries.map(entry=>[entry.changeId,entry.role]));
    const protectedSet=new Set(evaluateProtectedPaths(selected,guards,{caseInsensitive:true}).violations.map(entry=>entry.changeId));
    const outside=new Set(evaluateSourceBoundary(selected,boundary,{allowedPath:isTestAutomationPath,phaseId:phase.id}).violations.map(entry=>entry.changeId));
    const counts={},totals={added:0,modified:0,removed:0,changes:selected.entries.length};
    const entries=selected.entries.map(entry=>{const role=roles.get(entry.changeId)??'engine-owned';counts[role]=(counts[role]??0)+1;
      totals[entry.status==='A'?'added':entry.status==='D'?'removed':'modified']++;
      return {...entry,role,protected:protectedSet.has(entry.changeId),sourceBoundaryAllowed:!outside.has(entry.changeId)};});
    return {policy:{sourceBoundary:boundary,classificationComparison:context.caseInsensitivePaths?'pinned-case-insensitive':'case-sensitive-portable',
      protectedComparison:'portable-case-insensitive',tracking:'not-observed',renameDetection:'not-observed'},
      totals,roles:counts,protectedChanges:protectedSet.size,boundaryViolations:outside.size,entries};
  }
  return Object.freeze({inspectSourceChanges});
}

/** Baselines describe existing application files, without treating them as phase edits. */
export function sourceBaselineInventoryPolicies(port,roots) {
  const {applicationPathContext,isApplicationChangeEntry}=applicationPathPolicies(roots);
  const {classifyDeliveryChanges}=deliveryClassificationPolicies(port,roots);
  function sourceBaselineInventory(snapshot,{definition,workflow}) {
    const context=applicationPathContext(definition,workflow.resolution);
    const changes={entries:snapshot.entries.map((entry,index)=>({changeId:'baseline-'+index,status:'A',oldPath:null,newPath:entry.path}))};
    changes.entries=changes.entries.filter(entry=>isApplicationChangeEntry(entry,context));
    const roles=new Map(classifyDeliveryChanges(changes,{pathContext:context}).entries.map(entry=>[entry.newPath,entry.role]));
    const counts={},entries=snapshot.entries.filter(entry=>roles.has(entry.path)).map(entry=>{
      const role=roles.get(entry.path);counts[role]=(counts[role]??0)+1;return {...entry,role};});
    return {selection:'baseline-application-paths/v1',roles:counts,entries};
  }
  return Object.freeze({sourceBaselineInventory});
}

/** Logical origin/content consistency. Git execution and byte decoding are adapter responsibilities. */
export function sourceControlObservationPolicies(port,roots,values){
  const codec=createRepositoryChangeSetCodec(values),{sourceBaselineInventory}=sourceBaselineInventoryPolicies(port,roots);
  const same=(a,b)=>canonicalJson(a)===canonicalJson(b),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
  const exact=(v,keys,optional=[])=>object(v)&&Object.keys(v).every(key=>keys.includes(key)||optional.includes(key))&&keys.every(key=>Object.hasOwn(v,key));
  const oid=v=>typeof v==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
  const fail=reason=>{throw new SingularityFlowError('Source-control observations do not match their retained source binding.',{
    code:'ENGINE_SOURCE_CONTROL_BINDING_INVALID',details:{reason}});};
  function verifySourceControlObservation(observation,{descriptor,subject,baseline,current,definition,workflow}){
    if(descriptor.profile!=='git-selected-worktree-change-set/v1')throw new SingularityFlowError('The source-control profile needs its own evidence verifier.',{code:'ENGINE_SOURCE_CONTROL_PROFILE_UNSUPPORTED'});
    const c=observation.control;
    if(!same(observation.subject,subject)||!same(observation.current.snapshot,current)||observation.baseline.revision!==descriptor.baselineRevision)fail('subject-or-current-source');
    const inventory=snapshot=>sourceBaselineInventory(snapshot,{definition,workflow}).entries;
    // Filesystem executable bits and repository file modes are distinct facts (notably on Windows).
    const contents=rows=>rows.map(({path,sha256,bytes})=>({path,sha256,bytes}));
    if(!same(contents(inventory(baseline)),contents(inventory({entries:observation.baseline.entries}))))fail('baseline-source');
    if(!exact(c,['schemaVersion','kind','subject','base','target','entries','digest']))fail('control-record');
    admitRecordSchemaVersion(REPOSITORY_CHANGE_SET_SCHEMA,c);
    if(c.kind!=='repository-change-set'
      ||!same(c.subject,subject)||!exact(c.base,['commit','tree'])||c.base.commit!==descriptor.baselineRevision||![c.base.commit,c.base.tree].every(oid)
      ||!exact(c.target,['head','includesIndex','includesWorktree','includesUntracked','caseInsensitivePaths'])||!oid(c.target.head)
      ||!['includesIndex','includesWorktree','includesUntracked'].every(key=>c.target[key]===true)||typeof c.target.caseInsensitivePaths!=='boolean'
      ||!Array.isArray(c.entries)||!c.entries.every(object)||!codec.verifyRepositoryChangeSetIntegrity(c).valid)fail('control-record');
    const before=new Map(observation.baseline.entries.map(row=>[row.path,row])),after=new Map(current.entries.map(row=>[row.path,row])),paths=new Set(),ids=new Set();let previous=null;
    for(const row of c.entries){
      if(!exact(row,['status','similarity','oldPath','newPath','oldMode','newMode','oldObject','newObject','newContent','changeId'],['untracked'])
        ||!['added','copied','deleted','modified','renamed','type-changed'].includes(row.status)||ids.has(row.changeId)
        ||previous!==null&&codec.entryOrder(previous,row)>=0||row.similarity!==null&&(!Number.isSafeInteger(row.similarity)||row.similarity<0||row.similarity>100)
        ||![row.oldObject,row.newObject].every(value=>value===null||oid(value))||Object.hasOwn(row,'untracked')&&(row.untracked!==true||row.status!=='added'))fail('change-entry');
      ids.add(row.changeId);previous=row;
      for(const relative of [row.oldPath,row.newPath])if(relative!==null){sourceRelativePath(relative);
        if(descriptor.source.selection.excludePaths.some(exclude=>relative===exclude||relative.startsWith(exclude+'/')))fail('excluded-path');paths.add(relative);}
      if(row.status==='added'?(row.oldPath!==null||row.newPath===null):row.status==='deleted'?(row.newPath!==null||row.oldPath===null)
        :row.oldPath===null||row.newPath===null||(['renamed','copied'].includes(row.status)?row.oldPath===row.newPath:row.oldPath!==row.newPath))fail('change-endpoints');
      const old=row.oldPath===null?null:before.get(row.oldPath),next=row.newPath===null?null:after.get(row.newPath);
      if(row.oldPath!==null&&!old||row.newPath!==null&&!next)fail('change-source-member');
      if(old?(row.oldMode!==(old.executable?'100755':'100644')||row.oldObject===null):(row.oldMode!=='000000'||row.oldObject!==null))fail('baseline-mode');
      if(next?(!['100644','100755'].includes(row.newMode)||!same(row.newContent,{kind:'regular-file',sha256:'sha256:'+next.sha256,bytes:next.bytes}))
        :(row.newMode!=='000000'||row.newObject!==null||row.newContent!==null))fail('current-content');
    }
    const a=new Map(inventory(baseline).map(row=>[row.path,row])),b=new Map(inventory(current).map(row=>[row.path,row]));
    for(const relative of new Set([...a.keys(),...b.keys()])){const old=a.get(relative),next=b.get(relative);
      if((!old||!next||old.sha256!==next.sha256||old.bytes!==next.bytes)&&!paths.has(relative))fail('unreported-application-change');}
    return {changes:c.entries.length};
  }
  return Object.freeze({verifySourceControlObservation});
}


export const TEST_DELIVERY_POLICY_FACTS='sflow-test-delivery-policy-facts/v1';
/** Shared executable-test names and module/runner coverage. Fact and path bindings are explicit. */
export function testDeliveryPolicies(port,facts) {
  const syntax=configurationPathSyntax(port);
  const keys=['profile','ecosystems','posixExtname','ecosystemOfAdapter','ecosystemOfProgram'];
  if(!facts||!Object.isFrozen(facts)||Reflect.ownKeys(facts).length!==keys.length||keys.some(key=>{
    const d=Object.getOwnPropertyDescriptor(facts,key);return !d?.enumerable||!Object.hasOwn(d,'value');
  })||facts.profile!==TEST_DELIVERY_POLICY_FACTS||!Array.isArray(facts.ecosystems)||facts.ecosystems.length!==10
    ||facts.ecosystems.some(value=>typeof value!=='string'||!value||value.length>128)
    ||['posixExtname','ecosystemOfAdapter','ecosystemOfProgram'].some(key=>typeof facts[key]!=='function')) {
    throw new SingularityFlowError('Test-delivery rules need an explicit frozen runner/path-facts port.',{code:'ENGINE_TEST_DELIVERY_FACTS_INVALID'});
  }
  const path=Object.freeze({posix:Object.freeze({basename:syntax.path.posix.basename,extname:facts.posixExtname.bind(facts)})}),posix=syntax.posix;
  const TEST_COMMAND_ECOSYSTEMS=Object.freeze([...facts.ecosystems]);
  const ecosystemOfAdapter=facts.ecosystemOfAdapter.bind(facts),ecosystemOfProgram=facts.ecosystemOfProgram.bind(facts);
  const {isTestAutomationPath}=sourceBoundaryPolicies(port),{isConfigurationPath,configurationPathKind}=configurationFilePolicies(port);
  const {isDocumentationPath}=deliveryClassificationPolicies(port,[]);
const SUPPORTING_SEGMENTS = new Set([
  '__fixtures__', '__mocks__', '__snapshots__', 'fixture', 'fixtures', 'page-object', 'page-objects', 'pageobjects',
  'reports', 'results', 'snapshots', 'test-data', 'testdata'
]);
const SUPPORTING_BASENAMES = /^(?:readme(?:\.[^.]+)?|(?:playwright|cypress|jest|vitest|pytest)\.config\.[^.]+)$/i;
const SUPPORTING_EXTENSIONS = /\.(?:snap|snapshot|golden|md|mdx|txt|csv|tsv|json|ya?ml|xml|toml|properties)$/i;
const TEST_SOURCE_NAMES = [
  /(?:^|[._-])(?:test|tests|spec|e2e)(?:[._-]|$)/i,
  /(?:Test|Tests|Spec)\.(?:java|kt|kts|scala|cs|fs|vb|swift|php)$/,
  /[a-z\d]IT(?:Case)?\.(?:java|kt|groovy|scala)$/,
  /^(?:test_.+|.+_test)\.py$/i,
  /_test\.go$/i,
  /(?:^|_)tests?\.rs$/i
];
const TEST_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.cts', '.cxx', '.fs', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.mts', '.php', '.py', '.rb', '.rs', '.scala', '.swift', '.ts', '.tsx', '.vb'
]);
// Jest's default testMatch runs every script below a `__tests__` folder, whatever it is called
// (`__tests__/value.js`); its fixtures, mocks and snapshots are support, and a declaration file is not a test.
const JEST_TEST_SCRIPT = /\.[cm]?[jt]sx?$/iu;
const DECLARATION_FILE = /\.d\.[cm]?ts$/iu;

const LANGUAGE = /\.(?:([cm]?[jt]sx?|vue|svelte)|(pyx?|pyi)|(java|kts?|scala|groovy)|(cs|fsx?|vb)|(go)|(rs)|(swift|mm?)|(rb|erb|rake)|(php)|(dart))$/iu;
// In LANGUAGE's group order; a command's `ecosystem` names one of them.
const ECOSYSTEMS = TEST_COMMAND_ECOSYSTEMS;
// A JUnit report's ecosystem is its launcher's: a package manager or Node, a Python interpreter or project tool, or a runner's own program.
const LAUNCHERS = [[/^(?:npm|npx|pnpm|yarn|bunx?|node)$/u, 'node'], [/^(?:py(?:thon[\d.]*)?|uv|poetry)$/u, 'python']];
const lastSegment = (value) => String(value ?? '').split(/[\\/]/u).at(-1);


function normalized(candidate) {
  return posix(String(candidate ?? '')).replace(/^\.\//, '');
}

function jestTestFolderScript(relative) {
  const directories = relative.toLowerCase().split('/').slice(0, -1);
  return directories.includes('__tests__') && !directories.some((segment) => SUPPORTING_SEGMENTS.has(segment))
    && JEST_TEST_SCRIPT.test(relative) && !DECLARATION_FILE.test(relative);
}

function testNamed(relative) {
  return TEST_SOURCE_NAMES.some((pattern) => pattern.test(path.posix.basename(relative))) || jestTestFolderScript(relative);
}

function isTestSourceName(candidate) {
  const relative = normalized(candidate);
  return TEST_SOURCE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) && testNamed(relative);
}

function sourceEcosystem(candidate) {
  const match = LANGUAGE.exec(lastSegment(candidate));
  return match ? ECOSYSTEMS[match.slice(1).findIndex(Boolean)] : null;
}

function testCommandEcosystem(command) {
  const launcher = lastSegment(command?.argv?.[0]).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '');
  return ecosystemOfAdapter(command?.result?.adapter) ?? LAUNCHERS.find(([pattern]) => pattern.test(launcher))?.[1] ?? ecosystemOfProgram(launcher);
}

/**
 * Which changed paths a test command is evidence for [TCE:REQ-052, TCE:REQ-053].
 *
 * A command a person configured or accepted covers the affected roots they gave it. A command
 * Singularity Flow inferred runs one ecosystem's tests, so below its roots (the whole repository
 * included) it covers only that ecosystem's source and files of no language (configuration,
 * documents, assets, C and C++ that a package builds): `npm test` is never evidence for a `.py` or
 * `.swift` file, and pytest never for a `.ts` one. A command that names its `ecosystem` (a test
 * setup suggestion accepted as offered keeps its own) is read the same way, so a root `mvn test`
 * accepted with `affectedRoots: ['.']` never covers the `.js` beside it. Publication, submission,
 * recovery and witness discovery all ask this one question. A record that does not say where its
 * command came from (an older receipt) keeps its roots.
 */
function testCommandCoversPath(command, candidate) {
  const relative = String(candidate).replace(/^\.\//u, '');
  const below = (command?.affectedRoots ?? []).some((root) => {
    const prefix = String(root).replaceAll('\\', '/').replace(/^\.\/|\/+$/gu, '') || '.';
    return prefix === '.' || relative === prefix || relative.startsWith(`${prefix}/`);
  });
  const ecosystem = command?.ecosystem ?? (command?.provenance === 'inferred' && testCommandEcosystem(command));
  // An Android device test is run only by a connected (device) command [TCE:REQ-075].
  return below && (ecosystem === false || ([null, ecosystem].includes(sourceEcosystem(relative))
    && !(ecosystem === 'jvm' && /(?:^|\/)src\/androidTest\//u.test(relative) && !/AndroidTest$/u.test(command.argv?.at(-1)))));
}

function isAllowedTestAutomationPath(candidate) {
  return isTestAutomationPath(candidate);
}

function isSupportingTestResourcePath(candidate) {
  const relative = normalized(candidate);
  const segments = relative.toLowerCase().split('/');
  const basename = segments.at(-1) ?? '';
  return isConfigurationPath(relative) || segments.some((segment) => SUPPORTING_SEGMENTS.has(segment))
    || SUPPORTING_BASENAMES.test(basename)
    || SUPPORTING_EXTENSIONS.test(basename)
    || /(?:^|[._-])(?:fixture|snapshot|page-object|pageobject)(?:[._-]|$)/i.test(basename);
}

function affectedDeliveryPaths(delivery = {}, sourceBoundary = 'unrestricted') {
  return [...new Set([
    ...(sourceBoundary === 'test-automation' ? delivery.testPaths ?? [] : delivery.sourcePaths ?? []),
    ...(delivery.configurationPaths ?? [])
  ])].sort();
}

function testCoverageExemptPath(candidate) {
  const kind = configurationPathKind(candidate);
  return kind === 'repository-metadata' || kind === 'ci-configuration';
}

function testCoverageDeliveryPaths(delivery = {}, sourceBoundary = 'unrestricted') {
  return affectedDeliveryPaths(delivery, sourceBoundary).filter((candidate) => !testCoverageExemptPath(candidate));
}

function uncoveredTestDeliveryPaths(delivery, sourceBoundary, commands = []) {
  return testCoverageDeliveryPaths(delivery, sourceBoundary).filter((candidate) =>
    !commands.some((command) => testCommandCoversPath(command, candidate)));
}

function isExecutableTestSourceCandidate(candidate, { sourceExtensions = [] } = {}) {
  const relative = normalized(candidate);
  if (!isAllowedTestAutomationPath(relative) || isSupportingTestResourcePath(relative)) return false;
  const extension = path.posix.extname(relative).toLowerCase();
  if (!TEST_SOURCE_EXTENSIONS.has(extension) && !new Set(sourceExtensions.map((item) => item.toLowerCase())).has(extension)) return false;
  return testNamed(relative);
}
function deliveryPathCohorts(applicationEntries) {
const currentPaths = applicationEntries
    .filter((entry) => entry.status !== 'deleted' && entry.newPath
      && (entry.newContent?.kind === 'regular-file' || entry.newMode === '160000'))
    .map((entry) => entry.newPath);
const changedPaths = [...new Set(currentPaths)].sort();
const changedTestCandidates = changedPaths.filter(isAllowedTestAutomationPath);
const deletedPaths = applicationEntries
    .filter((entry) => entry.oldPath && entry.oldPath !== entry.newPath)
    .map((entry) => entry.oldPath);
const deletedSourcePaths = deletedPaths.filter(candidate =>
    !isAllowedTestAutomationPath(candidate) && !isDocumentationPath(candidate) && !isConfigurationPath(candidate));
const configurationPaths = [...new Set([...changedPaths, ...deletedPaths].filter(isConfigurationPath))].sort();
const changedSourcePaths = [...new Set([
    ...changedPaths.filter((candidate) => !isAllowedTestAutomationPath(candidate)
      && !isDocumentationPath(candidate) && !isConfigurationPath(candidate)),
    ...deletedSourcePaths
  ])].sort();
return {changedPaths,changedTestCandidates,deletedPaths,deletedSourcePaths,configurationPaths,changedSourcePaths};
}
  return Object.freeze({isTestSourceName,sourceEcosystem,testCommandEcosystem,testCommandCoversPath,isAllowedTestAutomationPath,isSupportingTestResourcePath,isExecutableTestSourceCandidate,deliveryPathCohorts,affectedDeliveryPaths,testCoverageExemptPath,testCoverageDeliveryPaths,uncoveredTestDeliveryPaths});
}

/** Provider-neutral change-record identities; source-control execution and wire decoding stay in adapters. */
export const REPOSITORY_CHANGE_SET_VALUES='sflow-repository-change-set-values/v1';
export function createRepositoryChangeSetCodec(values) {
  const keys=['profile','sha256Text','compareUtf8'];
  if(!values||typeof values!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(values))||!Object.isFrozen(values)
    ||Reflect.ownKeys(values).length!==keys.length||keys.some(key=>{const d=Object.getOwnPropertyDescriptor(values,key);
      return !d?.enumerable||!Object.hasOwn(d,'value')||(key==='profile'?d.value!==REPOSITORY_CHANGE_SET_VALUES:typeof d.value!=='function');})) {
    throw new SingularityFlowError('Repository change-set rules need explicit frozen digest and UTF-8 ordering primitives.',{code:'ENGINE_CHANGE_SET_VALUES_INVALID'});
  }
  const sha256=values.sha256Text.bind(values),compareUtf8=values.compareUtf8.bind(values);
  function compareRepositoryIdentity(left,right) {return compareUtf8(String(left),String(right));}
  function entryOrder(left, right) {
    return compareRepositoryIdentity(left.oldPath ?? '', right.oldPath ?? '')
      || compareRepositoryIdentity(left.newPath ?? '', right.newPath ?? '')
      || compareRepositoryIdentity(left.status, right.status);
  }
  function entryCore(entry) {
    const { changeId, ...core } = entry;
    return core;
  }
  function withEntryIdentity(entry) {
    return { ...entry, changeId: sha256(canonicalJson(entryCore(entry))) };
  }
  function repositoryChangeSetDigest(changeSet) {
    const { digest: _digest, ...core } = changeSet ?? {};
    return sha256(canonicalJson(core));
  }
  function verifyRepositoryChangeSetIntegrity(changeSet) {
    const entryFailures = (changeSet?.entries ?? []).filter((entry) =>
      entry.changeId !== sha256(canonicalJson(entryCore(entry))));
    return {
      valid: Boolean(changeSet)
        && changeSet.digest === repositoryChangeSetDigest(changeSet)
        && entryFailures.length === 0,
      digest: repositoryChangeSetDigest(changeSet),
      entryFailures: entryFailures.map((entry) => entry.changeId ?? null)
    };
  }
  return Object.freeze({compareRepositoryIdentity,entryOrder,withEntryIdentity,repositoryChangeSetDigest,verifyRepositoryChangeSetIntegrity});
}

/** Exact immutable configuration projections are input, never an exemption for changed bytes. */
export function configurationMaterializationPolicies(port) {
  const {evaluateProtectedPaths}=changeScopePolicies(port);
function configurationFiles(subject) {
  return subject?.resolution?.configurationSource?.files
    ?? subject?.configurationSource?.files
    ?? subject?.files
    ?? {};
}

function configurationAssets(subject) {
  const source = subject?.resolution?.configurationSource
    ?? subject?.configurationSource
    ?? subject
    ?? {};
  return source.assets ?? Object.fromEntries(Object.entries(configurationFiles(subject))
    .map(([relative, sha256]) => [relative, { sha256, object: null, mode: null }]));
}

function configurationRemovals(subject) {
  return subject?.resolution?.configurationSource?.removed
    ?? subject?.configurationSource?.removed
    ?? subject?.removed
    ?? {};
}

/**
 * Return configuration paths whose current change-set bytes exactly match the immutable
 * configuration snapshot selected when the Story started.
 *
 * These files are Story input projected from `sflow/config`, not application output. The match is
 * intentionally exact: only the pinned object/bytes and mode, or the pinned removed object and
 * mode, qualify. A changed or unbound configuration file is never approved by its name alone.
 */
function approvedConfigurationMaterializations(changeSet, workflowOrConfigurationSource) {
  const pinned = configurationAssets(workflowOrConfigurationSource);
  const removals = configurationRemovals(workflowOrConfigurationSource);
  return new Set((changeSet?.entries ?? []).flatMap((entry) => {
    const accepted = [];
    const expected = entry.newPath ? pinned[entry.newPath] : null;
    const expectedSha256 = expected?.sha256 ?? expected;
    const modeMatches = !expected?.mode || entry.newMode === expected.mode;
    const objectMatches = Boolean(expected?.object && entry.newObject === expected.object);
    const bytesMatch = entry.newContent?.kind === 'regular-file'
      && entry.newContent.sha256 === `sha256:${expectedSha256}`;
    if (expected && modeMatches && (objectMatches || bytesMatch)) accepted.push(entry.newPath);
    const removed = entry.oldPath ? removals[entry.oldPath] : null;
    if (removed && entry.oldObject === removed.object && entry.oldMode === removed.mode) {
      accepted.push(entry.oldPath);
    }
    return accepted;
  }));
}

/** Apply protected-path policy while classifying exact Story configuration projection as input. */
function evaluateStoryProtectedPaths(changeSet, guards, workflowOrConfigurationSource) {
  const evaluated = evaluateProtectedPaths(changeSet, guards);
  const approvedMaterializations = approvedConfigurationMaterializations(
    changeSet, workflowOrConfigurationSource
  );
  const acceptedProtectedPaths = new Set();
  const violations = evaluated.violations.filter((violation) => {
    if (!approvedMaterializations.has(violation.path)) return true;
    acceptedProtectedPaths.add(violation.path);
    return false;
  });
  return {
    valid: violations.length === 0,
    violations,
    approvedMaterializations,
    acceptedProtectedPaths
  };
}

  return Object.freeze({approvedConfigurationMaterializations,evaluateStoryProtectedPaths});
}

/** Exact planned source/test/supporting roles shared by native delivery and portable claim projection. */
export function plannedClaimPathPolicies(pathSyntax) {
const {isTestAutomationPath}=sourceBoundaryPolicies(pathSyntax);
const {isConfigurationPath}=configurationFilePolicies(pathSyntax);
const {classifySupportingChange}=supportingChangePolicies(pathSyntax);
function plannedImplementationPaths(claim = {}) {
  const tests = new Set(claim.tests ?? []);
  return (claim.expectedPaths ?? []).filter(candidate =>
    !(tests.has(candidate) && isTestAutomationPath(candidate)));
}
function plannedProductSourcePaths(claim = {}) {
  return plannedImplementationPaths(claim).filter(candidate => !isConfigurationPath(candidate));
}
function plannedSupportingFiles(maps = []) {
  return sortedUnique(maps.flatMap((map) => map?.supportingFiles ?? []))
    .filter((candidate) => !classifySupportingChange(candidate).refused);
}
function changesProductSource(claim) {
  return (claim.fulfillment == null || SOURCE_CHANGING_FULFILLMENT.includes(claim.fulfillment))
    && plannedProductSourcePaths(claim).length > 0;
}
return Object.freeze({plannedImplementationPaths,plannedProductSourcePaths,plannedSupportingFiles,changesProductSource});
}

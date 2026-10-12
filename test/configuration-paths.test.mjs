import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationPathKind, isConfigurationPath } from '../src/configuration-paths.mjs';
import { classifySupportingChange } from '../src/supporting-changes.mjs';
import { classifyDeliveryChanges } from '../src/delivery-evidence.mjs';
import { isApplicationPath } from '../src/application-paths.mjs';

const configurations = {
  'package.json': 'build-configuration', 'packages/web/package-lock.json': 'dependency-lock',
  'packages/web/pnpm-lock.yaml': 'dependency-lock', 'angular.json': 'build-configuration',
  'apps/web/tsconfig.app.json': 'build-configuration', 'apps/web/vite.config.ts': 'build-configuration',
  'playwright.config.ts': 'build-configuration', 'tests/vitest.config.mts': 'build-configuration',
  'eslint.config.mjs': 'build-configuration', '.github/workflows/test.yml': 'ci-configuration',
  '.github/actions/check/action.yml': 'ci-configuration', '.vscode/settings.json': 'repository-metadata',
  'services/python/pyproject.toml': 'build-configuration', 'services/python/pytest.ini': 'build-configuration',
  'services/python/setup.py': 'build-configuration', 'services/python/settings.py': 'runtime-configuration',
  'services/kotlin/settings.gradle.kts': 'build-configuration', 'services/kotlin/build.gradle.kts': 'build-configuration',
  'services/kotlin/gradle/dependency-locks/runtime.lockfile': 'dependency-lock',
  'services/dotnet/Product.csproj': 'build-configuration', 'services/dotnet/Directory.Build.props': 'build-configuration',
  'services/dotnet/appsettings.Development.json': 'runtime-configuration', 'services/dotnet/Web.config': 'runtime-configuration',
  'clients/swift/Package.swift': 'build-configuration', 'clients/swift/Package.resolved': 'dependency-lock',
  'clients/swift/Info.plist': 'build-configuration', 'clients/swift/App.xcodeproj/project.pbxproj': 'build-configuration',
  'src/config.js': 'runtime-configuration', 'config/app.json': 'runtime-configuration',
  'config/service.yaml': 'runtime-configuration', 'src/main/resources/application-prod.yml': 'runtime-configuration',
  '.env.example': 'runtime-configuration', 'go.mod': 'build-configuration', 'Cargo.toml': 'build-configuration'
};

test('one configuration role is used by delivery and supporting scope across languages and monorepo roots', () => {
  for (const [candidate, kind] of Object.entries(configurations)) {
    assert.equal(configurationPathKind(candidate), kind, candidate);
    assert.equal(configurationPathKind(candidate.replaceAll('/', '\\')), kind, 'Windows spelling');
    assert.equal(configurationPathKind(candidate.toUpperCase()), kind, 'portable conventional name');
    const entry = classifyDeliveryChanges({ entries: [{ newPath: candidate, status: 'added' }] }).entries[0];
    assert.equal(entry.role, kind, candidate);
    assert.notEqual(entry.role, 'product-source');
    assert.notEqual(entry.role, 'test-source');
    // Repository config does not become SFlow-owned or disappear from scope/integrity checks.
    if (!candidate.startsWith('.github/') && !candidate.startsWith('.vscode/')) assert.equal(isApplicationPath(candidate), true, candidate);
    if (kind === 'runtime-configuration') assert.equal(classifySupportingChange(candidate).refused, 'configuration');
    else assert.equal(classifySupportingChange(candidate).class, kind, candidate);
  }
});

test('source, actual tests, application data and migrations cannot disappear into configuration', () => {
  for (const candidate of ['src/App.jsx', 'src/config-service.js', 'src/config/helper.js',
    'src/data/catalog.json', 'tests/config.test.ts', 'src/config.spec.js', 'tests/test_settings.py',
    '.github/actions/check/main.js', '.circleci/build.sh', 'db/migrate/settings.json', 'migrations/config.py']) {
    assert.equal(isConfigurationPath(candidate), false, candidate);
  }
  for (const candidate of ['', '../package.json', '/package.json', 'C:\\repo\\package.json',
    'repo/../package.json', 'repo//package.json', ' package.json', 'package.json\0']) {
    assert.equal(isConfigurationPath(candidate), false, candidate);
  }
  assert.equal(classifySupportingChange('tests/config.test.ts').refused, 'test-source');
  assert.equal(classifySupportingChange('migrations/config.py').refused, 'migration');
  assert.equal(classifySupportingChange('.github/actions/check/main.js').class, 'ci-configuration',
    'existing approved CI supporting scopes remain readable without relabeling the helper as configuration');
  const generated = classifyDeliveryChanges({ entries: [{ newPath: 'generated/package.json', status: 'added' }] },
    { generatedRoots: ['generated'] }).entries[0];
  assert.equal(generated.role, 'build-configuration', 'generated configuration is not generated source');
  assert.equal(generated.generated, true, 'provenance stays separate from file role');
});

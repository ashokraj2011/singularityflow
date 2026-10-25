import { readdir } from 'node:fs/promises';

import { inferModuleTestCommand } from './code-delivery-tests.mjs';
import { repositoryManifestExists } from './repository-manifest.mjs';
import { isDotnetManifest, selectDotnetManifest } from './dotnet-manifests.mjs';

/** Repository-native, deterministic defaults. No model is needed to identify a build manifest. */
export async function inferRepositoryTestCommands(root, { unitOnly = false, platform = process.platform } = {}) {
  // SwiftPM may coexist with another root build (for example a Node tooling package). Never
  // let that build's early return hide Swift tests from the intake readiness contract.
  const swift = await repositoryManifestExists(root, 'Package.swift')
    ? [await inferModuleTestCommand(root, { root: '.', system: 'swift', manifest: 'Package.swift' }, { platform })]
    : [];
  return [...await inferOtherRepositoryTestCommands(root, { unitOnly, platform }), ...swift];
}

async function inferOtherRepositoryTestCommands(root, { unitOnly, platform }) {
  const regular = (relative) => repositoryManifestExists(root, relative);
  const inferred = async (system, manifest, options = {}) => {
    const command = await inferModuleTestCommand(root, { root: '.', system, manifest }, {
      unitOnly,
      platform,
      ...options
    });
    const legacyRootIds = {
      maven: 'maven-tests', gradle: 'gradle-tests', go: 'go-tests', rust: 'cargo-tests',
      python: 'python-tests', node: 'node-tests', dotnet: 'dotnet-tests'
    };
    return command ? [{
      ...command,
      id: command.result?.adapter === 'playwright-json'
        ? command.id : legacyRootIds[system] ?? command.id
    }] : [];
  };
  if (await regular('mvnw') || await regular('pom.xml')) return inferred('maven', 'pom.xml');
  if (await regular('gradlew') || await regular('build.gradle') || await regular('build.gradle.kts')) {
    return inferred('gradle', await regular('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle');
  }
  if (await regular('go.mod')) return inferred('go', 'go.mod');
  if (await regular('Cargo.toml')) return inferred('rust', 'Cargo.toml');
  if (await regular('pyproject.toml') || await regular('pytest.ini')) {
    return inferred('python', await regular('pyproject.toml') ? 'pyproject.toml' : 'pytest.ini');
  }
  if (await regular('package.json')) {
    // The package's commands by the module rule: one for each runner and level its scripts declare.
    const module = { root: '.', system: 'node', manifest: 'package.json' };
    const commands = unitOnly ? [await inferModuleTestCommand(root, module, { unitOnly, platform })].filter(Boolean)
      : await (await import('./test-module-markers.mjs')).moduleTestCommands(root, module, { platform });
    // The package's first unit command keeps the whole-repository name; browser and other runs keep their own.
    if (commands.length) return commands.map((command, index) => ({ ...command,
      id: index || /(?:playwright|cypress)(?:-ct|-component)?-tests$/u.test(command.id) ? command.id : 'node-tests' }));
  }
  const dotnet = (await readdir(root)).filter(isDotnetManifest);
  // Validate all candidates before selecting; a dangling/escaping peer cannot be guessed away.
  for (const name of dotnet) await regular(name);
  const selected = selectDotnetManifest(dotnet);
  if (selected) {
    // A product project runs the test projects that reference it, as the module rule does [TCE:REQ-072].
    const commands = await (await import('./test-module-markers.mjs')).moduleTestCommands(root, { root: '.', system: 'dotnet', manifest: selected }, { platform });
    return commands.map((command) => ({ ...command, id: command.id === '.-dotnet-tests' ? 'dotnet-tests' : command.id }));
  }
  // A Python project without pyproject.toml or pytest.ini is still a pytest module, as a changed path's is [TCE:REQ-074].
  const python = (await readdir(root)).find((name) => /^(?:requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile|tox\.ini|noxfile\.py)$/u.test(name));
  return python ? inferred('python', python) : [];
}

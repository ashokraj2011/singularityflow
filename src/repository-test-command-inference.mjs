import { readdir } from 'node:fs/promises';

import { inferModuleTestCommand } from './code-delivery-tests.mjs';
import { repositoryManifestExists } from './repository-manifest.mjs';
import { isDotnetManifest, selectDotnetManifest } from './dotnet-manifests.mjs';

const NOT_UNIT_PROJECT = /(?:^|[^a-z])(?:integration|e2e|end-?to-?end|acceptance|functional)(?:tests?|[^a-z]|$)/iu;

/**
 * Repository-native, deterministic defaults. No model is needed to identify a build manifest.
 *
 * Every build system at the root contributes its commands, in the order a single one used to be
 * chosen (Maven, Gradle, Go, Cargo, Python, Node, .NET): a root `pom.xml` beside a `package.json`
 * with tests is two suites, and returning only `mvn test` hid the JavaScript one. Each inferred
 * command covers only its own language's files. The first system's refusals stop inference as they
 * always did; a later one's is reported in `diagnostics` (when the caller passes an array) and that
 * system has no root command, as before. A root with more than one system is reported there too.
 */
export async function inferRepositoryTestCommands(root, { unitOnly = false, platform = process.platform, diagnostics = null } = {}) {
  // SwiftPM may coexist with another root build (for example a Node tooling package). Never
  // let that build's early return hide Swift tests from the intake readiness contract.
  const swift = await repositoryManifestExists(root, 'Package.swift')
    ? [await inferModuleTestCommand(root, { root: '.', system: 'swift', manifest: 'Package.swift' }, { platform })]
    : [];
  return [...await inferOtherRepositoryTestCommands(root, { unitOnly, platform, diagnostics }), ...swift];
}

const LEGACY_ROOT_IDS = Object.freeze({
  maven: 'maven-tests', gradle: 'gradle-tests', go: 'go-tests', rust: 'cargo-tests',
  python: 'python-tests', node: 'node-tests', dotnet: 'dotnet-tests'
});

async function inferOtherRepositoryTestCommands(root, { unitOnly, platform, diagnostics }) {
  const regular = (relative) => repositoryManifestExists(root, relative);
  const inferred = async (system, manifest, options = {}) => {
    // A reactor or multi-project root runs each module, as the gate does: one root command's report path reads nothing.
    const aggregated = ['maven', 'gradle'].includes(system)
      ? await (await import('./test-module-markers.mjs')).aggregatedTestCommands(root, { root: '.', system, manifest }, { platform, unitOnly }) : null;
    if (aggregated) return aggregated;
    const command = await inferModuleTestCommand(root, { root: '.', system, manifest }, {
      unitOnly,
      platform,
      ...options
    });
    return command ? [{
      ...command,
      id: command.result?.adapter === 'playwright-json'
        ? command.id : LEGACY_ROOT_IDS[system] ?? command.id
    }] : [];
  };
  // Each root build system: whether its build file is there, and its commands.
  const systems = [
    ['maven', async () => (await regular('mvnw') || await regular('pom.xml')) && (() => inferred('maven', 'pom.xml'))],
    ['gradle', async () => (await regular('gradlew') || await regular('build.gradle') || await regular('build.gradle.kts') || await regular('settings.gradle') || await regular('settings.gradle.kts'))
      && (async () => inferred('gradle', await regular('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'))],
    ['go', async () => await regular('go.mod') && (() => inferred('go', 'go.mod'))],
    ['rust', async () => await regular('Cargo.toml') && (() => inferred('rust', 'Cargo.toml'))],
    ['python', async () => (await regular('pyproject.toml') || await regular('pytest.ini'))
      && (async () => inferred('python', await regular('pyproject.toml') ? 'pyproject.toml' : 'pytest.ini'))],
    ['node', async () => await regular('package.json') && (async () => {
      // The package's commands by the module rule: one for each runner and level its scripts declare.
      const module = { root: '.', system: 'node', manifest: 'package.json' };
      const commands = unitOnly ? [await inferModuleTestCommand(root, module, { unitOnly, platform })].filter(Boolean)
        : await (await import('./test-module-markers.mjs')).moduleTestCommands(root, module, { platform });
      // The package's first unit command keeps the whole-repository name; browser and other runs keep their own.
      return commands.map((command, index) => ({ ...command,
        id: index || /(?:playwright|cypress)(?:-ct|-component)?-tests$/u.test(command.id) ? command.id : 'node-tests' }));
    })],
    ['dotnet', async () => {
      const dotnet = (await readdir(root)).filter(isDotnetManifest);
      // Validate all candidates before selecting; a dangling/escaping peer cannot be guessed away.
      for (const name of dotnet) await regular(name);
      const selected = selectDotnetManifest(dotnet);
      return selected && (async () => {
        // A product project runs the test projects that reference it, as the module rule does [TCE:REQ-072].
        const commands = await (await import('./test-module-markers.mjs')).moduleTestCommands(root, { root: '.', system: 'dotnet', manifest: selected }, { platform });
        // Readiness's unit-only run never starts a test project named for integration, end-to-end or acceptance tests.
        return commands.filter((command) => !unitOnly || !NOT_UNIT_PROJECT.test(`${command.workingDirectory}/${command.argv[2] ?? ''}`))
          .map((command) => ({ ...command, id: command.id === '.-dotnet-tests' ? 'dotnet-tests' : command.id }));
      });
    }]
  ];
  const found = [];
  // The systems with tests to run: a command, or a refusal to say why there is none (a tooling package.json is neither).
  const suites = [];
  const commands = [];
  const skipped = (system, error) => {
    suites.push(system);
    diagnostics?.push({ path: '.', system, code: error?.code ?? 'TEST_INFERENCE_FAILED',
      message: `The root ${system} build was not inferred: ${error?.message ?? error}` });
  };
  for (const [system, detect] of systems) {
    let infer;
    try { infer = await detect(); } catch (error) { if (!found.length) throw error; skipped(system, error); continue; }
    if (!infer) continue;
    found.push(system);
    let inferredHere;
    try { inferredHere = await infer(); } catch (error) { if (found.length === 1) throw error; skipped(system, error); continue; }
    if (inferredHere.length) suites.push(system);
    commands.push(...inferredHere);
  }
  if (suites.length > 1) {
    diagnostics?.push({ path: '.', code: 'TEST_ROOT_BUILD_SYSTEMS', systems: [...suites],
      message: `The repository root has ${suites.slice(0, -1).join(', ')} and ${suites.at(-1)} builds. Each suggested command runs one of them and covers only its own `
        + 'language\'s files; propose a command for each suite the step must run.' });
  }
  // A package with no test runner left the other build systems to decide; a Python project without
  // pyproject.toml or pytest.ini is still a pytest module, as a changed path's is [TCE:REQ-074].
  if (commands.length || found.some((system) => system !== 'node')) return commands;
  const python = (await readdir(root)).find((name) => /^(?:requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile|tox\.ini|noxfile\.py)$/u.test(name));
  return python ? inferred('python', python) : [];
}

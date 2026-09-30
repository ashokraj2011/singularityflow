import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { inferModuleTestCommand } from './code-delivery-tests.mjs';
import { secureRepositoryPath } from './util.mjs';

/** Repository-native, deterministic defaults. No model is needed to identify a build manifest. */
export async function inferRepositoryTestCommands(root, { unitOnly = false } = {}) {
  const regular = async (relative) => (await secureRepositoryPath(root, relative, {
    label: 'Repository test manifest', type: 'file'
  })).exists;
  const inferred = async (system, manifest, options = {}) => {
    const command = await inferModuleTestCommand(root, { root: '.', system, manifest }, {
      unitOnly,
      ...options
    });
    const legacyRootIds = {
      maven: 'maven-tests', gradle: 'gradle-tests', go: 'go-tests', rust: 'cargo-tests',
      python: 'python-tests', node: 'node-tests'
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
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const candidates = unitOnly ? ['test:unit', 'unit', 'test']
      : ['test', 'test:e2e', 'test:playwright', 'e2e'];
    const commands = [];
    for (const nodeScript of candidates) {
      const script = String(manifest.scripts?.[nodeScript] ?? '').trim();
      if (!script || /no test specified/i.test(script)) continue;
      const found = await inferred('node', 'package.json', { nodeScript });
      if (!found.length) continue;
      if (unitOnly) return found;
      if (nodeScript === 'test' || found[0].result?.adapter === 'playwright-json') {
        commands.push(...found);
      }
      if (found[0].result?.adapter === 'playwright-json') break;
    }
    if (commands.length) return commands;
  }
  return [];
}

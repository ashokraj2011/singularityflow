/** Read-only, bounded runner suggestions. Inspection never executes repository commands. */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { inferRepositoryTestCommands } from './repository-test-command-inference.mjs';
import { resolveAffectedModule, sourceEcosystem, testCommandEcosystem } from './code-delivery-tests.mjs';
import { moduleTestCommands } from './test-module-markers.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'coverage', 'venv', '__pycache__', 'bin', 'obj']);
const MAX_SCANNED_ENTRIES = 2_000;

/** The source languages in a directory, bounded: the files a command suggested for it would have to cover. */
async function directoryEcosystems(root, directory) {
  const found = new Set();
  let budget = MAX_SCANNED_ENTRIES;
  const walk = async (relative, depth) => {
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (--budget < 0) return;
      const child = path.posix.join(relative, entry.name);
      if (entry.isFile() && sourceEcosystem(child)) found.add(sourceEcosystem(child));
      else if (entry.isDirectory() && depth < 6 && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) await walk(child, depth + 1);
    }
  };
  await walk(directory, 0);
  return [...found].sort();
}

export async function inspectRepositoryTestSetup(root, { sourceRoots = ['.'], platform = process.platform } = {}) {
  if (!Array.isArray(sourceRoots) || !sourceRoots.length || sourceRoots.length > 20) {
    throw new SingularityFlowError('Choose from 1 to 20 explicit module directories.', { code: 'TEST_SETUP_SCOPE_INVALID' });
  }
  const roots = [...new Set(sourceRoots.map(value => {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':')
        || value.includes('\0') || path.posix.isAbsolute(value)
        || value.split('/').some(part => part === '..' || !part)) {
      throw new SingularityFlowError('Test setup requires repository-relative module directories, not URLs or globs.', { code: 'TEST_SETUP_SCOPE_INVALID' });
    }
    if (/[*?\[\]]/.test(value)) throw new SingularityFlowError('Choose an exact module directory, not a glob.', { code: 'TEST_SETUP_SCOPE_INVALID' });
    return path.posix.normalize(value);
  }))];
  const suggestions = []; const diagnostics = [];
  for (const directory of roots) {
    // Validate scopes before inference; never convert an unsafe path into an innocent omission.
    if (directory !== '.') await secureRepositoryPath(root, directory, { mustExist: true, type: 'directory', label: 'Test module' });
    try {
      const module = directory === '.' ? null : await resolveAffectedModule(root, `${directory}/__sflow_test_setup__`);
      let commands = module ? await moduleTestCommands(root, module, { platform }) : await inferRepositoryTestCommands(root, { platform });
      if (module && module.root !== directory && commands.length) {
        // A directory with no build file of its own borrows a command inferred for another module, and
        // publication counts it only for that command's own ecosystem [TCE:REQ-052]. Never suggest it for
        // a directory that holds another language's source.
        const languages = await directoryEcosystems(root, directory);
        const foreign = commands.filter((command) => languages.some((language) => language !== testCommandEcosystem(command)));
        if (foreign.length) {
          diagnostics.push({ path: directory, code: 'TEST_MODULE_UNCOVERED', message: `${directory} holds ${languages.join(' and ')} source, `
            + `which ${foreign.map((command) => command.id).join(' and ')} (inferred for ${module.root}) does not cover. `
            + 'Provide the command and reporter that run its tests.' });
          commands = commands.filter((command) => !foreign.includes(command));
          if (!commands.length) continue;
        }
      }
      for (const command of commands) {
        if (!suggestions.some(entry => JSON.stringify(entry.argv) === JSON.stringify(command.argv)
            && entry.workingDirectory === command.workingDirectory)) suggestions.push(command);
      }
      if (!commands.length) diagnostics.push({ path: directory, code: 'TEST_CONFIGURATION_PENDING', message: 'No supported structured runner inferred. Provide the command and reporter, or select the exact nested application directory.' });
    } catch (error) {
      if (!['TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS', 'GRADLE_TEST_TARGET_REQUIRED', 'RUST_TEST_ADAPTER_REQUIRED', 'XCODE_TEST_TARGET_REQUIRED'].includes(error.code)) throw error;
      // A runner that needs a device or a scheme comes with the command to complete [TCE:REQ-075].
      diagnostics.push({ path: directory, code: error.code, message: error.message, ...(error.details?.proposal ? { proposal: error.details.proposal } : {}) });
    }
  }
  return { repositoryPath: path.resolve(root), sourceRoots: roots, suggestions, diagnostics,
    testsExecuted: false, baseline: 'not-observed', status: suggestions.length ? 'suggestions-available' : 'pending-configuration' };
}

/** Read-only, bounded runner suggestions. Inspection never executes repository commands. */
import path from 'node:path';
import { inferRepositoryTestCommands } from './repository-test-command-inference.mjs';
import { inferModuleTestCommand, resolveAffectedModule } from './code-delivery-tests.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

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
      const commands = directory === '.' ? await inferRepositoryTestCommands(root, { platform })
        : [await inferModuleTestCommand(root, await resolveAffectedModule(root, `${directory}/__sflow_test_setup__`), { platform })].filter(Boolean);
      for (const command of commands) {
        if (!suggestions.some(entry => JSON.stringify(entry.argv) === JSON.stringify(command.argv)
            && entry.workingDirectory === command.workingDirectory)) suggestions.push(command);
      }
      if (!commands.length) diagnostics.push({ path: directory, code: 'TEST_CONFIGURATION_PENDING', message: 'No supported structured runner inferred. Provide the command and reporter, or select the exact nested application directory.' });
    } catch (error) {
      if (!['TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS', 'GRADLE_TEST_TARGET_REQUIRED', 'RUST_TEST_ADAPTER_REQUIRED'].includes(error.code)) throw error;
      diagnostics.push({ path: directory, code: error.code, message: error.message });
    }
  }
  return { repositoryPath: path.resolve(root), sourceRoots: roots, suggestions, diagnostics,
    testsExecuted: false, baseline: 'not-observed', status: suggestions.length ? 'suggestions-available' : 'pending-configuration' };
}

/** Read-only, bounded runner suggestions. Inspection never executes repository commands. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inferRepositoryTestCommands } from './repository-test-command-inference.mjs';
import { inferModuleTestCommand, resolveAffectedModule, sourceEcosystem, testCommandEcosystem } from './code-delivery-tests.mjs';
import { moduleTestCommands, proposedRunner, unreadRunnerOfPackage } from './test-module-markers.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'coverage', 'venv', '__pycache__', 'bin', 'obj']);
const MAX_SCANNED_ENTRIES = 2_000;

/**
 * The level of a command inferred for a Node package, as its runner says [TCE:REQ-071]: Playwright and
 * Cypress run end-to-end, their component runners component, the others unit. Null for any other
 * module: SFlow finds no level there, and the person may give one.
 */
export function inferredTestLevel(command) {
  const id = command?.id ?? '';
  if (/(?:^|-)(?:playwright-ct|cypress-component)-tests$/u.test(id)) return 'component';
  if (/(?:^|-)(?:playwright|cypress)-tests$/u.test(id) || command?.result?.adapter === 'playwright-json') return 'e2e';
  return ['node-tap', 'jest-json', 'vitest-json', 'mocha-json', 'karma-text'].includes(command?.result?.adapter) ? 'unit' : null;
}

const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs', 'playwright.config.mts', 'playwright.config.cts'];
// `baseURL: process.env.BASE_URL ?? …`, `wsEndpoint: process.env['PW_WS']`: where a suite reads its target.
const TARGET_VARIABLE = /\b(?:baseURL|wsEndpoint|connectOptions|cdpEndpoint)\b\s*:[^,\n}]*?process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/gu;

/**
 * The variables a Playwright suite's config reads its base URL or remote-browser endpoint from, so the
 * person can set them per setup (a local server, a relay URL) [RTC:REQ-011]. Only the config's text is
 * read, bounded; it is never run.
 */
async function playwrightTargetVariables(root, command) {
  if (command.result?.adapter !== 'playwright-json') return [];
  const found = new Set();
  // An Nx target runs from the workspace root; its config sits in the project the command covers.
  for (const directory of new Set([command.workingDirectory, ...(command.affectedRoots ?? [])])) {
    for (const name of PLAYWRIGHT_CONFIGS) {
      let text;
      try { text = await readFile(path.join(root, directory === '.' ? '' : directory, name), 'utf8'); } catch { continue; }
      for (const match of text.slice(0, 65_536).matchAll(TARGET_VARIABLE)) found.add(match[1] ?? match[2]);
    }
  }
  return [...found].sort();
}

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
      // A command a person configures owns what is below its roots, so one for a module of a reactor or
      // multi-project build names that module alone; only the gate's own also answers for the root's files.
      let commands = (module ? await moduleTestCommands(root, module, { platform }) : await inferRepositoryTestCommands(root, { platform, diagnostics }))
        .map((command) => (/-(?:maven|gradle)-tests$/u.test(command.id) ? { ...command, affectedRoots: [command.affectedRoots[0]] } : command));
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
      if (!commands.length) {
        // A runner SFlow can name and cannot complete alone: the command, and what a person must add or choose.
        const offered = await proposedRunner(root, directory);
        if (offered) { diagnostics.push({ path: directory, code: 'TEST_RUNNER_PROPOSED', message: `I found ${offered.runner} (${offered.file}). ${offered.words} Nothing was run. The command to complete: ${offered.proposal.argv.join(' ')}.`, proposal: offered.proposal }); continue; }
        const named = await unreadRunnerOfPackage(root, directory);
        diagnostics.push({ path: directory, code: 'TEST_CONFIGURATION_PENDING', message: named
          ? `${named.words}, whose results SFlow cannot read yet. Provide the command and a reporter SFlow reads, or select the exact nested application directory.`
          : 'No supported structured runner inferred. Provide the command and reporter, or select the exact nested application directory.' });
      }
    } catch (error) {
      if (!['TEST_MODULE_UNCOVERED', 'TEST_MODULE_AMBIGUOUS', 'TEST_MANIFEST_INVALID', 'GRADLE_TEST_TARGET_REQUIRED', 'RUST_TEST_ADAPTER_REQUIRED', 'XCODE_TEST_TARGET_REQUIRED'].includes(error.code)) throw error;
      // A runner that needs a device or a scheme comes with the command to complete [TCE:REQ-075].
      diagnostics.push({ path: directory, code: error.code, message: error.message, ...(error.details?.proposal ? { proposal: error.details.proposal } : {}) });
      // Several runners with different configurations: suggest each script's own command, so the person
      // proposes every one the gate should run (a step may run several) instead of finding none.
      if (error.code === 'TEST_MODULE_AMBIGUOUS') {
        const moduleRoot = error.details?.directory ?? directory;
        for (const script of error.details?.scripts ?? []) {
          let command = null;
          try { command = await inferModuleTestCommand(root, { root: moduleRoot, system: 'node', manifest: 'package.json' }, { platform, nodeScript: script, scriptAlone: true }); }
          catch { /* that script alone cannot be inferred either; the diagnostic says why */ }
          if (!command) continue;
          const id = `${moduleRoot === '.' ? '' : `${moduleRoot.replaceAll('/', '-')}-`}${script}-tests`;
          if (!suggestions.some(entry => JSON.stringify(entry.argv) === JSON.stringify(command.argv)
              && entry.workingDirectory === command.workingDirectory)) suggestions.push({ ...command, id });
        }
      }
    }
  }
  // Test commands the team wrote down, completed and kept with their file and line [TCE:REQ-061..063];
  // one that is the same as an inferred suggestion is that suggestion, unless it needs a secret the
  // suggestion does not say (`API_TOKEN=… npm test`): its note to declare it is kept.
  const { readInstructionTestCommands } = await import('./instruction-test-commands.mjs');
  const written = await readInstructionTestCommands(root, { sourceRoots: roots, platform });
  const same = (left, right) => JSON.stringify([left.argv, left.env ?? {}, left.workingDirectory]) === JSON.stringify([right.argv, right.env ?? {}, right.workingDirectory]);
  const instructionCandidates = written.candidates.filter(entry => !entry.command || entry.secrets?.length || !suggestions.some(suggestion => same(suggestion, entry.command)))
    .map(entry => (suggestions.some(suggestion => suggestion.id === entry.id) ? { ...entry, id: `${entry.id}-written`, ...(entry.command ? { command: { ...entry.command, id: `${entry.id}-written` } } : {}) } : entry));
  const proposable = suggestions.length || instructionCandidates.some(entry => entry.status === 'complete');
  // Each suggestion keeps the language its runner tests, so accepting it as offered never makes it
  // evidence for another language's files below the same roots (a root `mvn test` for `.js`).
  // It keeps the level SFlow found for it too, and names the variables its suite's target is read from.
  const scoped = await Promise.all(suggestions.map(async (command) => {
    const ecosystem = command.ecosystem ?? testCommandEcosystem(command);
    const level = command.level ?? inferredTestLevel(command);
    const targetVariables = await playwrightTargetVariables(root, command);
    return { ...command, ...(level ? { level } : {}), ...(ecosystem ? { ecosystem } : {}), ...(targetVariables.length ? { targetVariables } : {}) };
  }));
  return { repositoryPath: path.resolve(root), sourceRoots: roots, suggestions: scoped, instructionCandidates,
    instructionSources: written.sources, ...(written.truncated ? { instructionSourcesTruncated: true } : {}), diagnostics,
    testsExecuted: false, baseline: 'not-observed', status: proposable ? 'suggestions-available' : 'pending-configuration' };
}

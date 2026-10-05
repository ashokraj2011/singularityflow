/**
 * Resources the IntelliJ client reads instead of importing the engine.
 *
 * The client is a Kotlin process that only sees `sflow home --json`. Three decisions it makes need
 * engine knowledge, so the engine writes that knowledge down and `npm run check` keeps it current:
 * - `messages.json`: the wording for every message and reason code (`src/gateway/messages.mjs`).
 * - `home-commands.json`: every command a home choice can fall back to, classified by
 *   `resolveOperation`. The client runs a fallback only when it matches a `read` template exactly.
 * - the test fixture `command-guidance.json`: the engine's own answers for command validation and
 *   per-shell quoting, so the Kotlin port is tested against them rather than against itself.
 *
 * Usage: `node scripts/generate-intellij-resources.mjs` checks; add `--write` to regenerate.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandDefinition, resolveOperation } from '../src/command-registry.mjs';
import { RESULT_MESSAGES } from '../src/gateway/messages.mjs';
import { HOME_COMMAND_TEMPLATES } from '../src/gateway/planners/home-overview.mjs';
import {
  renderChangeDirectoryCommand, renderCommandPromptCommand, renderPlatformCommand, validateSafeSflowCommand
} from '../src/safe-command-guidance.mjs';
import { parseArgs } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'apps', 'intellij', 'src', 'main', 'resources', 'sflow');
const fixtures = path.join(root, 'apps', 'intellij', 'src', 'test', 'resources', 'fixtures');
const GENERATED_BY = 'scripts/generate-intellij-resources.mjs';
const PLACEHOLDER = /^<[A-Z][A-Z0-9-]*>$/u;
const SAMPLES = Object.freeze({
  '<WORK-ID>': 'FIX-1',
  '<GOAL-ID>': 'GOAL-1',
  '<BOOTSTRAP-ID>': 'bst_sample',
  '<FAULT-ID>': 'FLT-1',
  '<DIRECTORY>': 'repository',
  '<ID>': 'sample'
});

function classify(argv) {
  const sample = argv.map((token) => {
    if (!PLACEHOLDER.test(token)) return token;
    if (!SAMPLES[token]) throw new Error(`No sample value for placeholder ${token}.`);
    return SAMPLES[token];
  });
  const { positionals, options } = parseArgs(sample);
  const definition = commandDefinition(positionals[0]);
  return resolveOperation({
    requestedCommand: positionals[0],
    positionals: [definition.name, ...positionals.slice(1)],
    options,
    context: {}
  }).classification;
}

function homeCommands() {
  const templates = Object.entries(HOME_COMMAND_TEMPLATES)
    .map(([id, command]) => {
      const validated = validateSafeSflowCommand(command);
      if (!validated) throw new Error(`Home fallback '${id}' is not a safe sflow command: ${command}`);
      return { id, argv: [...validated.argv], classification: classify(validated.argv) };
    })
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  return { schemaVersion: 1, generatedBy: GENERATED_BY, templates };
}

function messages() {
  const entries = Object.keys(RESULT_MESSAGES).sort((left, right) => left.localeCompare(right, 'en'))
    .map((code) => {
      const { label, detail } = RESULT_MESSAGES[code];
      return [code, detail ? { label, detail } : { label }];
    });
  return { schemaVersion: 1, generatedBy: GENERATED_BY, messages: Object.fromEntries(entries) };
}

const VALIDATION_CASES = Object.freeze([
  'singularity-flow status',
  'sflow status',
  'singularity-flow --version',
  'singularity-flow story return FIX-1',
  "singularity-flow story return 'A B'",
  'singularity-flow story return "A B"',
  'singularity-flow story return C:\\work\\repo',
  'singularity-flow story return a\\ b',
  'singularity-flow session candidates --table',
  'singularity-flow fix FLT-1 --diagnose-only',
  'singularity-flow resume <WORK-ID>',
  'singularity-flow workspace adopt <DIRECTORY> --id <ID> --dry-run',
  'singularity-flow approve FIX-1 [--phase <PHASE>]',
  'singularity-flow approve FIX-1 --reason "..."',
  'singularity-flow status; rm -rf ~',
  'singularity-flow status && echo done',
  'singularity-flow status | tee out',
  'singularity-flow status $(whoami)',
  'singularity-flow status `id`',
  'singularity-flow story return "$HOME"',
  'singularity-flow story return ~',
  'singularity-flow --token abc status',
  'singularity-flow login https://user:secret@example.invalid',
  'singularity-flow status\nsflow resume FIX-1',
  'singularity-flow story return \'unterminated',
  'rm -rf ~',
  'node singularity-flow status',
  ''
]);

const RENDER_CASES = Object.freeze([
  ['singularity-flow', 'status'],
  ['singularity-flow', 'story', 'return', 'FIX-1'],
  ['singularity-flow', 'story', 'return', 'A B'],
  ['singularity-flow', 'story', 'return', "it's"],
  ['singularity-flow', 'story', 'return', 'C:\\work\\repo'],
  ['singularity-flow', 'story', 'return', '$HOME'],
  ['/opt/homebrew/bin/node', '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs', 'status'],
  ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\singularity-flow\\bin\\singularity-flow.mjs', 'status']
]);

const DIRECTORY_CASES = Object.freeze([
  '/work/repository',
  '/work/my repository',
  "/work/it's here",
  'C:\\work\\repository'
]);

function commandGuidance() {
  return {
    schemaVersion: 1,
    generatedBy: GENERATED_BY,
    validation: VALIDATION_CASES.map((command) => {
      const validated = validateSafeSflowCommand(command);
      return validated
        ? { command, accepted: true, argv: [...validated.argv], copyable: validated.copyable }
        : { command, accepted: false };
    }),
    rendering: RENDER_CASES.map((argv) => ({
      argv: [...argv],
      posix: renderPlatformCommand(argv, 'darwin'),
      powershell: renderPlatformCommand(argv, 'win32'),
      commandPrompt: renderCommandPromptCommand(argv)
    })),
    changeDirectory: DIRECTORY_CASES.map((directory) => ({
      directory,
      posix: renderChangeDirectoryCommand(directory, 'darwin'),
      powershell: renderChangeDirectoryCommand(directory, 'win32')
    }))
  };
}

const outputs = [
  [path.join(resources, 'messages.json'), messages()],
  [path.join(resources, 'home-commands.json'), homeCommands()],
  [path.join(fixtures, 'command-guidance.json'), commandGuidance()]
];

if (process.argv.includes('--write')) {
  for (const [file, value] of outputs) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${path.relative(root, file)}.`);
  }
} else {
  const stale = [];
  for (const [file, value] of outputs) {
    const current = await readFile(file, 'utf8').catch(() => '');
    if (current !== `${JSON.stringify(value, null, 2)}\n`) stale.push(path.relative(root, file));
  }
  if (stale.length) {
    console.error(`IntelliJ client resources are stale: ${stale.join(', ')}. Run node scripts/generate-intellij-resources.mjs --write.`);
    process.exitCode = 1;
  } else console.log('IntelliJ client resources are current.');
}

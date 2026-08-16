import { readdir, readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = process.argv[2] ?? 'all';
const SUITES = ['all', 'cli', 'vscode'];
if (!SUITES.includes(suite)) throw new Error(`Test suite must be one of: ${SUITES.join(', ')}.`);

/**
 * The VS Code extension is TypeScript, and its tests import the sources directly under
 * `--experimental-strip-types` rather than a built bundle — so they test what ships. Type stripping
 * arrived in Node 22.6, while this package supports Node 20, so the flag is added only when a
 * stripping test is actually selected and the running Node can do it.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
const canStripTypes = major > 22 || (major === 22 && minor >= 6);

const files = (await readdir(path.join(root, 'test')))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

/**
 * Whether a test file needs `--experimental-strip-types`, from what it actually does.
 *
 * Separate from which suite it belongs to, and that separation is the fix. The runner used one
 * string test — does the source contain `apps/vscode` — to answer **both** questions, so a file's
 * suite decided whether type stripping was switched on. Six files build that path as
 * `path.join(root, 'apps', 'vscode', …)` and matched zero times: they were selected into `cli`,
 * ran without the flag, and failed with `ERR_UNKNOWN_FILE_EXTENSION` the moment they imported a
 * `.ts` module. `npm run test:cli` was red on its own while `npm run test:all` stayed green,
 * because some *other* selected file happened to switch the flag on for the whole run.
 *
 * Suite membership is left exactly as it was. Widening it would move twenty files out of `cli`,
 * which fixes the error by deleting the coverage that hit it.
 *
 * A `.ts` string literal anywhere is deliberately enough here. It over-matches a file that only
 * *reads* a `.ts` source without importing it, and running that one with the flag costs nothing —
 * where missing one costs a red suite nobody can explain. Under-inclusion is the failure mode.
 */
function needsTypeStripping(source) {
  return /['"`][^'"`]*\.ts['"`]/.test(source) || source.includes('apps/vscode');
}

const selected = [];
const skipped = [];
let needsStripping = false;
for (const name of files) {
  const relative = path.posix.join('test', name);
  const source = await readFile(path.join(root, relative), 'utf8');
  const kind = source.includes('apps/vscode') ? 'vscode' : 'cli';
  if (suite !== 'all' && suite !== kind) continue;
  /**
   * Asked of every selected file, whatever suite it is in.
   *
   * This was `if (kind === 'vscode')`, which is how the flag came to depend on the bucket.
   */
  const stripping = needsTypeStripping(source);
  if (stripping && !canStripTypes) { skipped.push(relative); continue; }
  if (stripping) needsStripping = true;
  selected.push(relative);
}

if (skipped.length) {
  // Reported rather than silently dropped: a suite that quietly covers less than it claims is how a
  // regression ships green.
  console.warn(`Skipping ${skipped.length} VS Code test file(s) on Node ${process.versions.node}; type stripping needs Node 22.6 or newer: ${skipped.join(', ')}`);
}
if (!selected.length) {
  if (skipped.length) process.exit(0);
  throw new Error(`No ${suite} tests were discovered.`);
}

const flags = needsStripping ? ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'] : [];

/**
 * Run against a throwaway machine-state root, never the developer's own.
 *
 * These three pointers live in `~/.singularity-flow` and are read by any repository the CLI is
 * pointed at. Each already has an environment override, added — as the comment on
 * `leadRegistryFile` says — "so tests never touch a real machine's list"; the suite simply never set
 * them. The consequence was not a test touching the developer's files but the reverse: selecting a
 * workspace in the extension made that workspace's capability policy resolve inside every temporary
 * fixture repository, overriding each one's own `git.publish: off` and pushing to an `origin` that
 * fixtures deliberately do not have. Fifteen unrelated tests failed, on unchanged code, because of a
 * file outside the repository.
 *
 * Isolating the runner is enough: every fixture spawns the CLI with `{ ...process.env }`, so the
 * children inherit these.
 */
const machineState = mkdtempSync(path.join(tmpdir(), 'sflow-test-machine-state-'));
const isolated = {
  ...process.env,
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
  SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'leads.json')
};

/**
 * npm sets these for the children of a lifecycle script when its own output is a terminal, so
 * `npm test` behaved differently in a terminal than in a pipe — which is the worst way for a test
 * suite to differ. `colorEnabled` no longer honours FORCE_COLOR, but clearing it here means no
 * other tool in the tree can reintroduce the difference either.
 */
delete isolated.FORCE_COLOR;
delete isolated.SINGULARITY_FLOW_COLOR;

try {
  const result = spawnSync(process.execPath, [...flags, '--test', ...selected], {
    cwd: root,
    stdio: 'inherit',
    env: isolated
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(machineState, { recursive: true, force: true });
}

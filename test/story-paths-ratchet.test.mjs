// SSB M1 [SSB:REQ-009]: nothing but src/story-paths.mjs joins a Story's paths. This counts each old spelling of a
// Story's folder (docs/plans/SSB-M1-PLAN.md §2) outside an allow-list and fails when a count rises above its ceiling.
// Each batch of M1 lowers the ceilings by hand in its own commit; the test never rewrites them. A spelling that other
// work lands on main meanwhile fails here at the next rebase: join through storyLocation() instead.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCOPES = ['src', 'apps/vscode/src', 'plugin'];
const SOURCE = /\.(?:mjs|cjs|js|ts|md)$/u;

// Keys as the plan's §2. Each pattern counts one spelling per match.
const SPELLINGS = {
  W: { what: 'workDir(root, config, id) calls', pattern: /(?<![\w$])workDir\(/gu },
  R: { what: 'workDirRelative(config, id) calls', pattern: /(?<![\w$])workDirRelative\(/gu },
  P: { what: 'workflowPath( calls', pattern: /(?<![\w$])workflowPath\(/gu },
  I: { what: "inline `workItemRoot ?? 'singularity/work-items'` joins", pattern: /workItemRoot\s*\?\?\s*['"`]singularity\/work-items['"`]/gu },
  B: { what: 'joins on a bare .workItemRoot', pattern: /(?:path(?:\.posix)?\.join\([^;\n]*?|\$\{\s*)[\w?.]*\.workItemRoot\b(?!\s*\?\?)/gu },
  X: { what: 'path patterns that spell singularity\\/work-items', pattern: /singularity\\\/work-items/gu },
  // workItemWorkflowRelative is not counted: it validates the ID, then asks the resolver.
  H: { what: 'uses of DEFAULT_WORK_ITEM_ROOT outside the resolver: storiesRoot() names the default', pattern: /\bDEFAULT_WORK_ITEM_ROOT\b/gu },
  L: { what: 'other singularity/work-items literals: one-off joins, help text, comments', pattern: /(?<!\?\?\s*['"`])singularity\/work-items/gu },
  S: { what: "'work-items' as a path segment", pattern: /['"`]work-items['"`]/gu },
  F: { what: 'configuration-source.json and CONFIGURATION_SOURCE_PATH', pattern: /configuration-source\.json|CONFIGURATION_SOURCE_PATH/gu },
  E: { what: 'Epic paths (M6)', pattern: /singularity\/initiatives|initiativeRoot\s*\?\?/gu }
};

// The places that may spell a Story's folder: the resolver itself, the definition's default and validation, the
// location module's normalization, and the configuration assets' runtime roots. A file entry allows every line; a
// line entry allows the lines that match it.
const ALLOWED = [
  { file: 'src/story-paths.mjs' },
  { file: 'src/work-item-location.mjs', keys: ['H', 'L'] },
  { file: 'src/config.mjs', line: /^\s*workItemRoot: definition\.workItemRoot \?\? 'singularity\/work-items',$/u },
  { file: 'src/config.mjs', line: /initiativeRoot/u, keys: ['E'] },
  { file: 'src/configuration-assets.mjs', line: /^\s*'singularity\/(?:work-items|initiatives)',$/u },
  { file: 'src/configuration-assets.mjs', line: /^\s*: 'singularity\/(?:work-items|initiatives)'$/u },
  { file: 'src/configuration-assets.mjs', line: /^export const CONFIGURATION_SOURCE_PATH = /u, keys: ['F'] }
];

// Ceilings: lowered by each batch of M1, never raised. At M1's end W, R, P, I, B, X and H are 0; L keeps only help
// text and comments; E stays for M6.
const CEILINGS = {
  W: 50, R: 20, P: 4, I: 42, B: 7, X: 95, H: 8, L: 33, S: 7, F: 45, E: 34
};

async function* sourceFiles(directory) {
  let entries;
  try { entries = await readdir(path.join(ROOT, directory), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') yield* sourceFiles(relative);
    } else if (SOURCE.test(entry.name)) yield relative;
  }
}

const allowed = (file, line, key) => ALLOWED.some((entry) => entry.file === file
  && (!entry.keys || entry.keys.includes(key)) && (!entry.line || entry.line.test(line)));

async function countSpellings() {
  const counts = Object.fromEntries(Object.keys(SPELLINGS).map((key) => [key, 0]));
  const sites = Object.fromEntries(Object.keys(SPELLINGS).map((key) => [key, {}]));
  for (const scope of SCOPES) {
    for await (const file of sourceFiles(scope)) {
      const lines = (await readFile(path.join(ROOT, file), 'utf8')).split('\n');
      for (const line of lines) {
        for (const [key, { pattern }] of Object.entries(SPELLINGS)) {
          // A definition is not a use: `function workDir(`.
          const found = [...line.matchAll(pattern)].filter((match) => !/function\s+$/u.test(line.slice(0, match.index))).length;
          if (!found || allowed(file, line, key)) continue;
          counts[key] += found;
          sites[key][file] = (sites[key][file] ?? 0) + found;
        }
      }
    }
  }
  return { counts, sites };
}

test('no spelling of a Story\'s folder rises above its ceiling: join through storyLocation() [SSB:REQ-009]', async () => {
  const { counts, sites } = await countSpellings();
  const risen = Object.entries(counts).filter(([key, count]) => count > CEILINGS[key]);
  assert.deepEqual(risen, [], risen.map(([key, count]) => `${key} (${SPELLINGS[key].what}): ${count} > ${CEILINGS[key]}; `
    + Object.entries(sites[key]).map(([file, n]) => `${file} ${n}`).join(', ')).join('\n'));
});

test('the ratchet counts what it says: each pattern finds its own spelling', () => {
  const sample = {
    W: "workDir(root, config, id)", R: "workDirRelative(config, id)", P: "workflowPath(root, config, id)",
    I: "path.join(root, config.workItemRoot ?? 'singularity/work-items', id)",
    B: "path.join(root, config.workItemRoot, id)", X: "/^singularity\\/work-items\\/[^/]+\\/gdp\\//u",
    H: 'DEFAULT_WORK_ITEM_ROOT', L: "'singularity/work-items/<ID>'", S: "path.join(root, 'singularity', 'work-items')",
    F: 'singularity/configuration-source.json', E: "'singularity/initiatives'"
  };
  for (const [key, text] of Object.entries(sample)) {
    assert.equal([...text.matchAll(SPELLINGS[key].pattern)].length > 0, true, key);
  }
  assert.equal([..."config.workItemRoot ?? 'singularity/work-items'".matchAll(SPELLINGS.L.pattern)].length, 0,
    'an inline join is counted once, as I');
  assert.equal([...'dependencies.workDir(root, config, id)'.matchAll(SPELLINGS.W.pattern)].length, 1, 'a member call counts');
  assert.equal([...'storyLocation(root, config, id).directory'.matchAll(SPELLINGS.W.pattern)].length, 0);
});

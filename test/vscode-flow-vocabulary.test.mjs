/**
 * "Governed" is retired from what people read (docs/GLOSSARY.md): everything in Singularity Flow is
 * governed, so the adjective tells the reader nothing. This keeps it out of VS Code prose. Machine
 * names keep the word — goal modes, record fields, topic IDs, CSS classes — and are listed below
 * by exact value, so a new sentence cannot hide behind a pattern.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sources(path.join(directory, entry.name))
    : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []));
  return nested.flat();
}

/** Quoted and template strings on code lines; comment lines are skipped. */
function strings(text) {
  const code = text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n');
  return [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/gu)].map((match) => match[2]);
}

// Exact strings that are machine names or seeded example data, never sentences.
const MACHINE_NAMES = new Set([
  'governed', 'ungoverned', 'governance', 'governed-agent', 'Governed', 'governance-warning',
  'Governed AI delivery'
]);

test('VS Code prose never says "governed" or "governance"', async () => {
  const offenders = [];
  for (const file of await sources(path.join(root, 'apps/vscode/src'))) {
    for (const value of strings(await readFile(file, 'utf8'))) {
      if (!/\b(?:un)?govern(?:ed|ance)\b/iu.test(value)) continue;
      // A value with no space is an identifier, key, path or class list.
      if (!/\s/u.test(value) || MACHINE_NAMES.has(value.trim())) continue;
      // Words inside class/id/data attributes and code spans are names, not prose.
      const prose = value.replace(/\$\{[^}]*\}?|class="[^"]*"|data-[\w-]+="[^"]*"|<code>[^<]*<\/code>|[\w.-]*govern[\w.-]*-[\w.-]+|[\w.-]+-govern[\w.-]*/giu, '');
      if (/\b(?:un)?govern(?:ed|ance)\b/iu.test(prose)) offenders.push(`${path.relative(root, file)}: ${value.slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], 'say the thing instead: a Story, a repository, an agent, a Flow Gate (see docs/GLOSSARY.md)');
});

test('the three Flow names are the only Flow-prefixed nouns in VS Code prose', async () => {
  // Flow Impact is the impact-study feature, named before this vocabulary and kept (docs/GLOSSARY.md).
  const allowed = new Set(['Flow Gate', 'Flow Gates', 'Flow Ledger', 'Flow Policy', 'Flow Policies', 'Flow agent', 'Flow agents', 'Flow Impact']);
  const found = new Set();
  for (const file of await sources(path.join(root, 'apps/vscode/src'))) {
    for (const value of strings(await readFile(file, 'utf8'))) {
      for (const match of value.matchAll(/(?<!Singularity )\bFlow (?:[A-Z][a-z]+|agents?)\b/gu)) found.add(match[0]);
    }
  }
  assert.deepEqual([...found].filter((name) => !allowed.has(name)), [],
    'only Flow Gate, Flow Ledger and Flow Policy take the prefix (and Flow agent beside other Copilot agents)');
});

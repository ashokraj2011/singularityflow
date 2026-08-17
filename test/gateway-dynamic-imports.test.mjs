/**
 * Every name a planner destructures from a deferred import actually exists. `[INT:CON-041]`
 *
 * The gateway defers expensive modules — `state.mjs` and `work-intervals.mjs` pull in the
 * publication kernel and the ledger, and a briefing nobody asked for should cost nothing. The cost
 * of that shape is that the names come from a string at runtime, so a renamed export is not a
 * missing import anybody can see. `work-return.mjs` destructured `loadConfig`, which
 * `config.mjs` has never exported — it is `loadDefinition` — and then called it.
 *
 * What made that survive is the shape around it: the call sits inside `try { … } catch { return
 * null; }`, written for genuinely absent facts (no open interval, no baseline). A `TypeError` for
 * calling `undefined` looks exactly like an absent fact from outside, so reconciliation reported
 * "nothing to reconcile" every single time and the suite stayed green.
 *
 * Static analysis rather than execution: these planners want a governed repository, and this needs
 * to hold for every planner rather than the ones a fixture happens to reach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gateway = path.join(root, 'src', 'gateway');
const sourceRoot = path.join(root, 'src');

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(target));
    else if (entry.name.endsWith('.mjs')) found.push(target);
  }
  return found;
}

/**
 * `const [{ a }, { b, c }] = await Promise.all([import('x'), import('y')])`, and the single-import
 * form. Deliberately narrow: a pattern this reads wrongly would assert against names that were
 * never destructured, which is worse than not covering the line at all.
 */
function destructuredImports(source) {
  const claims = [];
  for (const match of source.matchAll(
    /const\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\[([^\]]+)\]\)/g)) {
    const names = [...match[1].matchAll(/\{([^}]*)\}/g)].map((entry) => entry[1]);
    const specifiers = [...match[2].matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((entry) => entry[1]);
    if (names.length !== specifiers.length) continue;
    for (const [index, specifier] of specifiers.entries()) {
      claims.push({ specifier, names: names[index].split(',').map((name) => name.trim().split(':')[0].trim()).filter(Boolean) });
    }
  }
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    claims.push({
      specifier: match[2],
      names: match[1].split(',').map((name) => name.trim().split(':')[0].trim()).filter(Boolean)
    });
  }
  return claims;
}

test('every name a gateway module destructures from a deferred import is exported', async () => {
  const files = await sourceFiles(gateway);
  const missing = [];
  let checked = 0;

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const { specifier, names } of destructuredImports(source)) {
      if (!specifier.startsWith('.')) continue;
      const module = await import(path.resolve(path.dirname(file), specifier));
      for (const name of names) {
        checked += 1;
        if (!(name in module)) {
          missing.push(`${path.relative(root, file)} destructures '${name}' from '${specifier}', which does not export it`);
        }
      }
    }
  }

  // A pattern that stops matching would otherwise turn this into a green check over nothing.
  assert.ok(checked >= 3, `expected deferred imports to check, found ${checked}`);
  assert.deepEqual(missing, [], `deferred imports naming exports that do not exist:\n  ${missing.join('\n  ')}`);
});

test('package-root values use the shared uppercase resolver and never an ambiguous packageRoot binding', async () => {
  const violations = [];
  const ambiguousBindings = [
    /\b(?:const|let|var)\s+packageRoot\b/,
    /\bfunction\s+\w+\s*\([^)]*\bpackageRoot\b/,
    /\([^)]*\bpackageRoot\b[^)]*\)\s*=>/,
    /\bpackageRoot\s*=>/
  ];
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, 'utf8');
    if (ambiguousBindings.some((pattern) => pattern.test(source))) {
      violations.push(path.relative(root, file));
    }
  }
  assert.deepEqual(violations, [],
    `lower-camel packageRoot bindings obscure whether the value is the installed package root or a local directory:\n  ${violations.join('\n  ')}`);
});

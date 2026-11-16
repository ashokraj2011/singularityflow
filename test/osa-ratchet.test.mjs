/**
 * SPEC-OSA v1.1 AC-020, started in Stage 1: the AST and dependency ratchet. Per module, the counts of raw lifecycle
 * reads and writes, lifecycle predicate and chooser calls, version arithmetic, step routes built in place, lifecycle
 * command literals and route skill literals (scripts/osa-inventory.mjs FAMILIES) may only fall.
 *
 * benchmarks/osa/ratchet.json holds the current ceilings and the named exceptions; benchmarks/osa/inventory.json is the
 * Stage 0 baseline the ceilings are held to. An approved normalizer, record validator or renderer above its Stage 0 count
 * is an exception with an owner and a deletion target, never a silent rise [plan section 3, "Ratchet"].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAMILIES, familyCounts, ratchetCeilings, scanSources } from '../scripts/osa-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const ratchet = json('benchmarks/osa/ratchet.json');
const stage0 = new Map(json('benchmarks/osa/inventory.json').modules.map((entry) => [entry.module, familyCounts(entry)]));

test('no module\'s competing lifecycle decisions grow, and every fall is locked in [OSA:AC-020]', async () => {
  const current = ratchetCeilings(await scanSources(root));
  const rises = [], falls = [];
  for (const module of new Set([...Object.keys(current), ...Object.keys(ratchet.ceilings)])) {
    for (const family of FAMILIES) {
      const now = current[module]?.[family] ?? 0, ceiling = ratchet.ceilings[module]?.[family] ?? 0;
      if (now > ceiling) rises.push(`${module} ${family} ${ceiling} -> ${now}`);
      if (now < ceiling) falls.push(`${module} ${family} ${ceiling} -> ${now}`);
    }
  }
  assert.deepEqual(rises, [], 'a new competing decision: move it to the kernel, or name an exception with an owner and a deletion target');
  assert.deepEqual(falls, [], 'lock the fall in with: node scripts/osa-inventory.mjs --ratchet');
});

test('every ceiling is at or under Stage 0, or a named exception with an owner and a deletion target [OSA:AC-020]', () => {
  const exceptions = new Map(ratchet.exceptions.map((entry) => [`${entry.module} ${entry.family}`, entry]));
  for (const entry of ratchet.exceptions) {
    assert.ok(FAMILIES.includes(entry.family), `${entry.module}: ${entry.family}`);
    assert.ok(['normalizer', 'validator', 'renderer'].includes(entry.kind), `${entry.module}: an exception is a normalizer, validator or renderer, never policy`);
    for (const field of ['owner', 'deletion', 'why']) assert.ok(typeof entry[field] === 'string' && entry[field].length > 10, `${entry.module} ${entry.family}: ${field}`);
    assert.equal(entry.stage0, stage0.get(entry.module)?.[entry.family] ?? 0, `${entry.module} ${entry.family}: its Stage 0 count`);
  }
  for (const [module, families] of Object.entries(ratchet.ceilings)) {
    assert.ok(!module.startsWith('kernel/'), `${module}: the kernel holds no counted site`);
    for (const [family, ceiling] of Object.entries(families)) {
      const allowed = exceptions.get(`${module} ${family}`)?.ceiling ?? stage0.get(module)?.[family] ?? 0;
      assert.ok(ceiling <= allowed, `${module} ${family}: ${ceiling} above ${allowed} (Stage 0 ${stage0.get(module)?.[family] ?? 0}) with no exception`);
    }
  }
  // An exception no longer needed is removed with its rise: none outlives the count it explains.
  for (const entry of ratchet.exceptions) {
    assert.ok((ratchet.ceilings[entry.module]?.[entry.family] ?? 0) > entry.stage0, `${entry.module} ${entry.family}: delete the exception, the count fell back`);
  }
});

test('the ratchet\'s totals fell from Stage 0 where Stage 1 moved decisions into the kernel', () => {
  const sum = (map, family) => [...map.values()].reduce((total, entry) => total + (entry[family] ?? 0), 0);
  const now = new Map(Object.entries(ratchet.ceilings));
  for (const family of ['intentReads', 'predicateCalls', 'versionArithmetic']) {
    assert.ok(sum(now, family) < sum(stage0, family), `${family}: ${sum(now, family)} is not below Stage 0's ${sum(stage0, family)}`);
  }
});

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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { FAMILIES, STAGE5_FAMILIES, familyCounts, moduleCounts, ratchetCeilings, scanModule, scanSources, stage5Ceilings, stage5Counts } from '../scripts/osa-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const ratchet = json('benchmarks/osa/ratchet.json');
const stage0 = new Map(json('benchmarks/osa/inventory.json').modules.map((entry) => [entry.module, familyCounts(entry)]));

const scanned = scanSources(root);

test('no module\'s competing lifecycle decisions grow, and every fall is locked in [OSA:AC-020]', async () => {
  const current = ratchetCeilings(await scanned);
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
    // Stage 5 [plan section 7]: every exception left is a member of the final owner set, none waits for a later stage.
    assert.equal(entry.final, true, `${entry.module} ${entry.family}: an exception left after Stage 5 belongs to the final owner set`);
    assert.doesNotMatch(entry.deletion, /\bStage [0-9]\b/u, `${entry.module} ${entry.family}: no deletion target is left to a stage`);
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

// ---------------------------------------------------------------------------------------------------- Stage 5

test('the Stage 5 families only fall, and every fall is locked in [OSA:AC-020, plan section 7 "Ratchet"]', async () => {
  const current = stage5Ceilings(await scanned);
  assert.deepEqual(ratchet.stage5.families, [...STAGE5_FAMILIES]);
  const rises = [], falls = [];
  for (const module of new Set([...Object.keys(current), ...Object.keys(ratchet.stage5.ceilings)])) {
    for (const family of STAGE5_FAMILIES) {
      const now = current[module]?.[family] ?? 0, ceiling = ratchet.stage5.ceilings[module]?.[family] ?? 0;
      if (now > ceiling) rises.push(`${module} ${family} ${ceiling} -> ${now}`);
      if (now < ceiling) falls.push(`${module} ${family} ${ceiling} -> ${now}`);
    }
  }
  assert.deepEqual(rises, [], 'a new decider in another spelling: read the decision through step-decision.mjs, or render the map in its owner');
  assert.deepEqual(falls, [], 'lock the fall in with: node scripts/osa-inventory.mjs --ratchet');
});

test('only the final owner set imports the reducer; every other surface reads the decision through step-decision.mjs [OSA:REQ-001, REQ-020]', async () => {
  const readers = Object.keys(ratchet.owners.reducerReaders).sort();
  const importing = Object.entries(stage5Ceilings(await scanned)).filter(([, counts]) => counts.kernelImports).map(([module]) => module).sort();
  assert.deepEqual(importing, readers, 'a module that runs the reducer itself is a new decision owner');
  for (const module of [...ratchet.owners.decision, ...ratchet.owners.adapter, ...ratchet.owners.map, ...ratchet.owners.validator]) {
    assert.ok(existsSync(path.join(root, 'src', module)), `${module}: a final owner that no longer exists`);
  }
});

/** One module's Stage 5 counts from source text, as the scanner reads it. */
const counts = (text, name = 'probe.mjs') => stage5Counts(moduleCounts(name, scanModule(name, text, ts.ScriptKind.JS)));
const old = (text, name = 'probe.mjs') => familyCounts(moduleCounts(name, scanModule(name, text, ts.ScriptKind.JS)));

test('the ratchet sees a decider in its other spellings: computed routes, renamed fields, bare skill ids and kernel imports [plan section 7]', () => {
  // A command line whose verb is computed, by template or concatenation.
  assert.equal(counts('const verb = "recover"; export const c = `singularity-flow ${verb} US-1`;').computedCommands, 1);
  assert.equal(counts('export const c = (verb) => "singularity-flow " + verb;').computedCommands, 1);
  // A route built as argv, never a command literal.
  assert.equal(counts('export const r = (id) => route(["recover", id, "--json"]);').argvRoutes, 1);
  assert.equal(counts('export const r = (id) => route(["phase", "rollover", id, "--json"]);').argvRoutes, 1);
  assert.equal(counts('export const r = ["phase", "list"];').argvRoutes, 0, 'not a lifecycle command');
  // A step skill in its bare spelling, any case.
  assert.equal(counts('export const s = { skill: "sf-recover" }; export const t = "SFLOW-CODE";').altSkillLiterals, 2);
  // A renamed route field holding a lifecycle command or a step skill.
  assert.equal(counts('export const a = { recoveryCommand: `singularity-flow recover ${"US-1"}`, authoringSkill: "/sf-code" };').routeFields, 2);
  // The Stage 0 families do not see those spellings; the Stage 5 ones do.
  assert.equal(old('export const r = (id) => route(["recover", id, "--json"]);').lifecycleCommands, 0);
  // The reducer imported or called, statically or dynamically; a kernel predicate called by any path.
  assert.equal(counts('import { stepState } from "./kernel/step-state.mjs"; export const d = (s) => stepState(s);').kernelImports, 2);
  assert.equal(counts('export const d = async (s) => (await import("../kernel/step-state.mjs")).stepState(s);').kernelImports, 2);
  assert.equal(counts('import { versionNumbers as v } from "./kernel/step-versions.mjs"; export const n = (f) => versionNumbers(f);').kernelPredicateCalls, 1);
  // A route chosen from the map's forms outside its owners; a same-named table of another module is not the map.
  assert.equal(counts('import { actionCommandLine, ACTION_SKILLS } from "./action-command-map.mjs"; export const r = { command: actionCommandLine("recover-operation", "recover", {}), skill: ACTION_SKILLS.recover };').mapRoutes, 2);
  assert.equal(counts('const ACTION_COMMANDS = { a: "b" }; export const c = ACTION_COMMANDS.a;').mapRoutes, 0);
});

test('a new module with a decider fails the ratchet: its ceiling is 0 in every family [OSA:AC-020]', () => {
  const probe = 'export const next = (id) => ({ command: `singularity-flow recover ${id} --json`, skill: "/sf-recover" });';
  const families = old(probe, 'new-planner.mjs');
  assert.ok(families.lifecycleCommands > 0 && families.routeObjects > 0 && families.skillLiterals > 0);
  assert.equal(ratchet.ceilings['new-planner.mjs'], undefined, 'a module the ratchet has never seen has no ceiling, so any count is a rise');
  const spelled = counts('export const next = (id, verb) => ({ shell: ["recover", id], line: "singularity-flow " + verb });', 'new-planner.mjs');
  assert.ok(spelled.argvRoutes > 0 && spelled.computedCommands > 0);
  assert.equal(ratchet.stage5.ceilings['new-planner.mjs'], undefined);
});

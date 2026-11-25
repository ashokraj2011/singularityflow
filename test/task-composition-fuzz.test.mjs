/**
 * The task fuzzer (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md A10): seeded draws of a kind, a person's added and skipped steps,
 * the team's rules and the files a task touches. Every draw is either refused with a TASK_ code and its next action, or
 * composes a plan that starts and walks to its end, and holds what a task promises:
 * - the intake comes first, and a code task keeps its tests; an investigation, a review and a document change no code;
 * - every step a rule adds is there, and a skip of one is refused with the rule's words;
 * - a person approves at least two things, and each step a rule gives a person;
 * - the same draw gives the same plan.
 * A failure names its seed, so it replays exactly. SINGULARITY_FLOW_TASK_FUZZ_SEEDS widens the run.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { taskPlan } from '../src/commands/work.mjs';
import { composeTask, TASK_KINDS } from '../src/task-composition.mjs';
import { seeded } from './helpers/story-fuzzer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const STEPS = ['intake', 'requirements', 'design', 'plan', 'code', 'test', 'review'];
const FILES = ['src/auth/login.js', 'src/orders/export.js', 'db/migrations/001.sql', 'docs/guide.md'];
const CODE_FREE = ['investigate', 'review', 'docs'];
const SEEDS = Number(process.env.SINGULARITY_FLOW_TASK_FUZZ_SEEDS ?? 120);

function draw(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const some = (list, chance) => list.filter(() => random() < chance);
  const rule = () => ({ kinds: random() < 0.5 ? ['all'] : some(TASK_KINDS, 0.3), steps: some(['requirements', 'design', 'plan', 'test', 'review'], 0.25),
    personApproves: some(['intake', 'test', 'review'], 0.2), because: 'The team asks for it.' });
  const tasks = random() < 0.6 ? {
    ...(random() < 0.5 ? { always: [rule()] } : {}),
    ...(random() < 0.5 ? { paths: [{ ...rule(), paths: [pick(['src/auth/**', 'db/migrations/*.sql', 'docs/**'])] }] } : {})
  } : undefined;
  return { kind: pick(TASK_KINDS), add: some(['requirements', 'design', 'plan', 'review'], 0.2), skip: some(STEPS, 0.12),
    touchedPaths: some(FILES, 0.3), tasks };
}

test(`ITW A10: ${SEEDS} seeded task drafts either refuse with their way on or compose a plan that walks to its end`, async () => {
  let composed = 0, refused = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const random = seeded(20261125 + seed).next;
    const d = draw(random);
    const definition = structuredClone(BASE);
    if (d.tasks) definition.tasks = d.tasks;
    const where = `seed ${20261125 + seed}: ${JSON.stringify(d)}`;
    let composition;
    try {
      composition = composeTask(definition, { kind: d.kind, add: d.add, skip: d.skip, touchedPaths: d.touchedPaths });
    } catch (error) {
      assert.match(error.code ?? '', /^TASK_/u, `${where}: ${error.message}`);
      assert.ok(error.details?.nextAction?.command, `${where}: a refusal names its way on`);
      refused += 1;
      continue;
    }
    const plan = await taskPlan(definition, { kind: d.kind, add: d.add, skip: d.skip, touchedPaths: d.touchedPaths });
    assert.equal(plan.walk, 'completed', where);
    assert.deepEqual(await taskPlan(definition, { kind: d.kind, add: d.add, skip: d.skip, touchedPaths: d.touchedPaths }), plan, `${where}: the same draw, the same plan`);
    const intents = composition.steps.map((step) => step.intent);
    assert.equal(intents[0], 'intake', where);
    if (intents.includes('code')) assert.ok(intents.includes('test'), `${where}: a code task keeps its tests`);
    if (CODE_FREE.includes(d.kind)) assert.ok(!intents.includes('code'), `${where}: no code`);
    for (const added of composition.added) assert.ok(intents.includes(added.intent), where);
    for (const skipped of d.skip) {
      if (composition.added.some((entry) => entry.intent === skipped)) assert.fail(`${where}: a rule's ${skipped} step was skipped`);
    }
    const person = plan.steps.filter((step) => step.approvedBy === 'person');
    assert.ok(person.length >= 2, `${where}: ${JSON.stringify(plan.steps)}`);
    for (const intent of composition.personApproves) {
      assert.ok(plan.steps.some((step) => step.intent === intent && step.approvedBy === 'person'), `${where}: a rule gives ${intent} to a person`);
    }
    composed += 1;
  }
  assert.ok(composed > SEEDS / 3 && refused > 0, `composed ${composed}, refused ${refused}: the draws reach both ends`);
});

/**
 * Routing by task. `[ADP:REQ-010]` `[ADP:REQ-011]` `[ADP:REQ-012]` `[ADP:CON-001]`
 *
 * The property under test is not "the right model is chosen" — it is that *nothing but
 * configuration chooses*. Task assignment is a lookup from pinned context, so the same phase and the
 * same contract class must produce the same task every time, with no prompt, classifier or model
 * output anywhere in the path.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DUAL_INTENT_CONTRACT_CLASS, generationTaskForPhase, mappedContractClasses, MODEL_TASKS,
  taskForContractClass
} from '../src/model-tasks.mjs';

test('task-resolves-from-pinned-phase', () => {
  /**
   * `[ADP:AC-001]`. The phase declares the task; the fold pins it; resolution reads the pin.
   *
   * The default matters as much as the declaration. A phase that says nothing routes as `reason`
   * rather than as the cheapest tier, because generation is drafting and drafting is where an
   * under-served task shows up as a worse artifact rather than as an error anyone would notice.
   */
  const definition = {
    phases: {
      specification: { generation: { requirement: 'required', task: 'reason' } },
      implementation: { generation: { requirement: 'required', task: 'code' } },
      release: { generation: { requirement: 'required' } }
    }
  };
  assert.equal(generationTaskForPhase(definition, 'specification'), 'reason');
  assert.equal(generationTaskForPhase(definition, 'implementation'), 'code');
  assert.equal(generationTaskForPhase(definition, 'release'), 'reason', 'an undeclared phase fell back to something other than reason');
  assert.equal(generationTaskForPhase(definition, 'no-such-phase'), 'reason');

  // A task outside the closed enum is refused where it is written, not where it is used.
  assert.throws(() => generationTaskForPhase({ phases: { x: { generation: { task: 'vibes' } } } }, 'x'),
    /'vibes' is not one of/);
});

test('every shipped contract class routes somewhere', async () => {
  /**
   * `[ADP:REQ-011]`. Dispatch classes resolve to `relay`; the artifact class asks questions before
   * it drafts and needs to be told which it is doing.
   *
   * This test exists because the specification's own list of classes was short by one.
   * `deterministic-mutation` appears in the shipped registry and in none of the spec's mappings, so
   * every skill of that class would have routed nowhere — the single failure the taxonomy is for.
   * The assertion is therefore against the registry, not against the spec's prose.
   */
  // The classes live in a build script rather than a module export, so they are read from source.
  const source = await readFile(new URL('../scripts/skill-policy.mjs', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('const CONTRACT_TEXT'), source.indexOf('});', source.indexOf('const CONTRACT_TEXT')));
  const shipped = [...block.matchAll(/^\s*'([a-z-]+)':/gm)].map((match) => match[1]).sort();
  assert.ok(shipped.length >= 6, `expected the shipped contract classes, found ${shipped.length}`);
  assert.deepEqual(mappedContractClasses(), shipped,
    'a shipped contract class has no task, so work of that class routes nowhere');

  for (const contractClass of shipped) {
    if (contractClass === DUAL_INTENT_CONTRACT_CLASS) continue;
    assert.equal(taskForContractClass(contractClass), 'relay', `${contractClass} is dispatch and should relay`);
  }
  for (const contractClass of ['governed-review', 'clarification-and-artifact']) {
    const line = block.match(new RegExp(`'${contractClass}': ([^\\n]+)`))?.[1] ?? '';
    assert.match(line, /singularity\/work-items\/<WORK-ID>\//);
    assert.match(line, /never search outside it/);
  }
});

test('the class that both asks and drafts is told which it is doing', () => {
  // Questions are `clarify` whatever the phase is. Drafting takes the phase's declared task, so a
  // skill never gets its own opinion about how hard its phase's drafting is.
  assert.equal(taskForContractClass(DUAL_INTENT_CONTRACT_CLASS, { intent: 'questions' }), 'clarify');
  assert.equal(taskForContractClass(DUAL_INTENT_CONTRACT_CLASS, { intent: 'draft', generationTask: 'code' }), 'code');
  assert.throws(() => taskForContractClass(DUAL_INTENT_CONTRACT_CLASS, { intent: 'draft' }),
    /needs the phase's declared generation task/);
  assert.throws(() => taskForContractClass('not-a-class'), /declares no model task/);
});

test('the enum is closed, and nothing in the routing path consults a model', async () => {
  /**
   * `[ADP:CON-005]` and `[ADP:CON-001]`. Six tasks, and the modules that assign them must contain no
   * provider call, no prompt, and no model invocation — resolution is lookup, not judgment. Asserted
   * against the source because the guarantee is structural: a classifier added later would still
   * pass every behavioural test above.
   */
  assert.deepEqual([...MODEL_TASKS], ['relay', 'clarify', 'reason', 'code', 'analyze', 'summarize']);
  assert.equal(new Set(MODEL_TASKS).size, MODEL_TASKS.length);

  for (const name of ['model-tasks.mjs', 'model-tiers.mjs']) {
    const text = (await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of ['invokeModel', 'modelProvider', 'prompt', 'spawn']) {
      assert.ok(!text.includes(forbidden), `${name} reaches for ${forbidden}; routing must be a lookup`);
    }
  }
});

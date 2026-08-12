import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clarificationRecordRelative,
  normalizeClarificationPolicy,
  recordClarificationResponses,
  renderClarificationProtocol,
  verifyClarificationRecord
} from '../src/clarifications.mjs';
import { snapshot } from '../src/util.mjs';

async function clarificationFixture(mode = 'required') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-clarification-'));
  const definition = {
    workItemRoot: 'singularity/work-items',
    phases: { requirements: { clarification: { mode, maxQuestions: 3, topics: ['scope'] } } }
  };
  const phase = { id: 'requirements', generation: 0 };
  const workflow = {
    workItem: { id: 'WORK-1' },
    resolution: { phases: [{ id: 'requirements', clarification: definition.phases.requirements.clarification }] }
  };
  const context = path.join(root, 'singularity/work-items/WORK-1/context');
  await mkdir(context, { recursive: true });
  const promptPath = 'singularity/work-items/WORK-1/context/prompt-requirements-gen1.md';
  await writeFile(path.join(root, promptPath), '# Governed prompt\n\nAsk the human.\n');
  const prompt = await snapshot(path.join(root, promptPath));
  const groundingPath = 'singularity/work-items/WORK-1/context/requirements-gen1.json';
  await writeFile(path.join(root, groundingPath), `${JSON.stringify({
    promptPath,
    renderedSha256: prompt.sha256,
    agent: 'product-owner'
  }, null, 2)}\n`);
  return { root, definition, workflow, phase, promptPath };
}

test('phase clarification policies are configurable and bounded', () => {
  // The marker policy is normalized alongside the conversational mode and defaults to `off`,
  // so a repository that never heard of markers is unchanged [SPK:REQ-064].
  assert.deepEqual(normalizeClarificationPolicy(), { mode: 'off', maxQuestions: 5, topics: [], markers: { mode: 'off' } });
  assert.deepEqual(normalizeClarificationPolicy('required'), { mode: 'required', maxQuestions: 5, topics: [], markers: { mode: 'off' } });
  assert.deepEqual(normalizeClarificationPolicy({
    mode: 'when-needed', maxQuestions: 3, topics: ['scope', 'risk']
  }), { mode: 'when-needed', maxQuestions: 3, topics: ['scope', 'risk'], markers: { mode: 'off' } });
  assert.throws(() => normalizeClarificationPolicy({ mode: 'always' }), /off, when-needed, or required/);
  assert.throws(() => normalizeClarificationPolicy({ maxQuestions: 11 }), /1 through 10/);
  assert.throws(() => normalizeClarificationPolicy({ topics: ['scope', 'scope'] }), /must not contain duplicates/);
  assert.throws(() => normalizeClarificationPolicy({ hidden: true }), /unknown field 'hidden'/);
});

test('required clarification produces an explicit interactive stop before authoring', () => {
  const rendered = renderClarificationProtocol({
    mode: 'required', maxQuestions: 4, topics: ['scope', 'acceptance criteria']
  }, 'requirements');
  assert.match(rendered, /Human clarification checkpoint/);
  assert.match(rendered, /requirements.*required/);
  assert.match(rendered, /Pause for at least one human response/);
  assert.match(rendered, /no more than 4 questions/);
  assert.match(rendered, /interactive `ask_user` tool/);
  assert.match(rendered, /Do not author or publish/);
  assert.match(rendered, /scope, acceptance criteria/);
});

test('off clarification adds no prompt instructions and when-needed may explicitly continue', () => {
  assert.equal(renderClarificationProtocol({ mode: 'off' }, 'implementation'), '');
  const rendered = renderClarificationProtocol({ mode: 'when-needed' }, 'design');
  assert.match(rendered, /Ask only when a material ambiguity remains/);
  assert.match(rendered, /found no material ambiguity and continue/);
});

test('required clarification is bound to the exact prompt and prospective generation', async () => {
  const value = await clarificationFixture();
  const missing = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
  assert.match(missing.errors[0], /clarification response is missing/);

  const recorded = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, {
    actor: { name: 'Product Owner', email: 'owner@example.com' },
    agent: 'product-owner',
    responses: [{ question: 'Is the described scope correct?', answer: 'Yes; exclude account migration.' }]
  });
  assert.equal(recorded.path, clarificationRecordRelative(value.definition, value.workflow, value.phase));
  assert.equal(recorded.record.generation, 1);
  assert.equal(recorded.record.completed, true);

  const verified = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
  assert.deepEqual(verified.errors, []);
  assert.match(verified.passes[0], /1 human response/);

  await writeFile(path.join(value.root, value.promptPath), '# Changed governed prompt\n');
  const stale = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
  assert.match(stale.errors.join('\n'), /prompt snapshot hash differs/);
});

test('materially deferred clarification remains a hard publication blocker', async () => {
  const value = await clarificationFixture();
  const recorded = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, {
    actor: { name: 'Product Owner', email: 'owner@example.com' },
    agent: 'product-owner',
    responses: [{
      question: 'What is the retention period?',
      answer: 'Security owner must decide.',
      status: 'deferred',
      blocking: true,
      owner: 'Security',
      impact: 'The specification cannot define storage lifecycle.'
    }]
  });
  assert.equal(recorded.record.completed, false);
  const verified = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
  assert.match(verified.errors.join('\n'), /material unresolved decision/);
  assert.match(verified.errors.join('\n'), /not complete/);
});

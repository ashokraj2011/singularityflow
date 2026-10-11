import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertClarificationRecordingAllowed,
  clarificationRecordRelative,
  normalizeClarificationPolicy,
  recordClarificationResponses,
  renderClarificationProtocol,
  verifyClarificationRecord
} from '../src/clarifications.mjs';
import { snapshot } from '../src/util.mjs';

async function clarificationFixture(mode = 'required', phaseId = 'requirements') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-clarification-'));
  const definition = {
    workItemRoot: 'singularity/work-items',
    phases: { [phaseId]: { clarification: { mode, maxQuestions: 3, topics: ['scope'] } } }
  };
  const phase = { id: phaseId, generation: 0 };
  const workflow = {
    workItem: { id: 'WORK-1' },
    resolution: { phases: [{ id: phaseId, clarification: definition.phases[phaseId].clarification }] }
  };
  const context = path.join(root, 'singularity/work-items/WORK-1/context');
  await mkdir(path.join(context, 'prompts'), { recursive: true });
  const promptPath = `singularity/work-items/WORK-1/context/prompts/${phaseId}-gen1.md`;
  await writeFile(path.join(root, promptPath), '# Governed prompt\n\nAsk the human.\n');
  const prompt = await snapshot(path.join(root, promptPath));
  const groundingPath = `singularity/work-items/WORK-1/context/${phaseId}-gen1.json`;
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
  assert.match(rendered, /Derive every question only from the current Story/);
  assert.match(rendered, /Never reuse example questions or placeholder text from templates/);
  assert.match(rendered, /git rev-parse --git-path singularity-flow\/clarification-responses\/requirements-gen<N>\.json/);
  assert.match(rendered, /Never write response input to the CLI-owned `singularity\/work-items\/\*\*\/context\/clarifications-\*\.json` durable path/);
  assert.match(rendered, /Do not author or publish/);
  assert.match(rendered, /scope, acceptance criteria/);
});

test('off clarification adds no prompt instructions and when-needed may explicitly continue', () => {
  assert.equal(renderClarificationProtocol({ mode: 'off' }, 'implementation'), '');
  const rendered = renderClarificationProtocol({ mode: 'when-needed' }, 'design');
  assert.match(rendered, /Ask only when a material ambiguity remains/);
  assert.match(rendered, /found no material ambiguity and continue/);
});

test('composed clarification refers to the verified source recovery route while standalone use keeps it', () => {
  const standalone = renderClarificationProtocol('required', 'implementation');
  const composed = renderClarificationProtocol('required', 'implementation', { intentRecoveryInSource: true });
  assert.match(standalone, /story intent-amendment propose/);
  assert.doesNotMatch(composed, /story intent-amendment propose/);
  assert.match(composed, /follow Conflict recovery in the Pinned Story source/);
  for (const contract of [/Pause for at least one human response/, /Never rewrite|never silently overwrite/, /CLI-owned/, /Material unresolved decisions block/, /ask_user.*unavailable/, /Do not author or publish/]) {
    assert.match(composed, contract);
  }
  assert.ok(Buffer.byteLength(composed) < Buffer.byteLength(standalone));
});

test('off clarification refuses recording with a stable recovery contract', async () => {
  const value = await clarificationFixture('off');
  assert.throws(
    () => assertClarificationRecordingAllowed(value.definition, value.workflow, value.phase),
    (error) => {
      assert.equal(error.code, 'CLARIFICATION_MODE_OFF');
      assert.deepEqual(error.details, {
        phase: 'requirements',
        mode: 'off',
        nextAction: {
          command: 'singularity-flow clarification status requirements --json',
          kind: 'diagnostic'
        },
        remediation: {
          action: 'continue-without-clarification',
          instruction: 'Do not ask or record phase clarification. Continue from the approved sources and governed repository evidence.',
          command: 'singularity-flow prepare requirements',
          // The step's own drafting skill, so recovery never names the generic one.
          skill: '/sf-phase'
        }
      });
      return true;
    }
  );

  await assert.rejects(
    recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, {
      actor: { name: 'Product Owner' },
      agent: 'product-owner',
      responses: [{ question: 'Should this be persisted?', answer: 'No.' }]
    }),
    (error) => error.code === 'CLARIFICATION_MODE_OFF'
      && error.details?.remediation?.action === 'continue-without-clarification'
  );
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

test('clarification verification rejects an unbound prompt path without opening it', async () => {
  const value = await clarificationFixture();
  const recorded = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, {
    actor: { name: 'Product Owner' }, agent: 'product-owner',
    responses: [{ question: 'Is the scope correct?', answer: 'Yes.' }]
  });
  // Opening a directory as a snapshot would throw instead of returning a governed finding.
  // A record-controlled pointer must never be opened merely to diagnose its invalid binding.
  recorded.record.promptPath = '..';
  await writeFile(path.join(value.root, recorded.path), JSON.stringify(recorded.record));
  const verified = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
  assert.match(verified.errors.join('\n'), /prompt snapshot path differs/);
  assert.deepEqual(verified.passes, []);
});

test('a raw response envelope staged at the durable path is atomically adopted and schema-stamped', async () => {
  const value = await clarificationFixture();
  const relative = clarificationRecordRelative(value.definition, value.workflow, value.phase);
  const destination = path.join(value.root, relative);
  const responses = [{ question: 'Is the described scope correct?', answer: 'Yes; exclude account migration.' }];
  await writeFile(destination, `${JSON.stringify({ responses }, null, 2)}\n`);

  const recorded = await recordClarificationResponses(
    value.root, value.definition, value.workflow, value.phase, {
      actor: { name: 'Product Owner', email: 'owner@example.com' },
      agent: 'product-owner',
      responses,
      responseFile: destination
    }
  );

  const persisted = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.workId, 'WORK-1');
  assert.equal(persisted.phase, 'requirements');
  assert.equal(persisted.generation, 1);
  assert.deepEqual(persisted.responses, recorded.record.responses);
  assert.equal((await verifyClarificationRecord(
    value.root, value.definition, value.workflow, value.phase
  )).errors.length, 0);
});

test('same-path response adoption refuses changed input without overwriting its bytes', async () => {
  const value = await clarificationFixture();
  const relative = clarificationRecordRelative(value.definition, value.workflow, value.phase);
  const destination = path.join(value.root, relative);
  const staged = {
    responses: [{ question: 'Which boundary applies?', answer: 'The public API only.' }]
  };
  await writeFile(destination, `${JSON.stringify(staged, null, 2)}\n`);
  const before = await readFile(destination, 'utf8');

  await assert.rejects(
    recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, {
      actor: { name: 'Product Owner', email: 'owner@example.com' },
      agent: 'product-owner',
      responses: [{ question: 'Which boundary applies?', answer: 'A changed answer.' }],
      responseFile: destination
    }),
    (error) => error.code === 'CLARIFICATION_RESPONSE_FILE_CHANGED'
  );
  assert.equal(await readFile(destination, 'utf8'), before);
});

test('a versioned durable clarification record is never mistaken for same-path staging', async () => {
  const value = await clarificationFixture();
  const first = await recordClarificationResponses(
    value.root, value.definition, value.workflow, value.phase, {
      actor: { name: 'Product Owner', email: 'owner@example.com' },
      agent: 'product-owner',
      responses: [{ question: 'Is the scope correct?', answer: 'Yes.' }]
    }
  );
  const destination = path.join(value.root, first.path);
  const before = await readFile(destination, 'utf8');

  const retry = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, {
      actor: { name: 'Product Owner', email: 'owner@example.com' },
      agent: 'product-owner',
      responses: first.record.responses,
      responseFile: destination
    });
  assert.equal(retry.reused, true, 'a durable receipt is reused, never adopted as raw staging');
  assert.equal(retry.sha256, first.sha256);
  assert.equal(await readFile(destination, 'utf8'), before);
});

test('exact recording retries reuse bytes and IDs across seeded and future custom phase names', async t => {
  for (const phaseId of ['specification', 'planning', 'implementation', 'verification', 'release', 'team-custom']) {
    await t.test(phaseId, async t => {
      const value = await clarificationFixture('required', phaseId);
      t.after(() => rm(value.root, { recursive: true, force: true }));
      const args = { actor: { name: 'Human Reviewer' }, agent: 'phase-author',
        responses: [{ question: 'Which inputs?', answer: 'Non-negative integers.' }, { question: 'Which output?', answer: 'Lowercase.' }] };
      const first = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, args);
      const before = await readFile(path.join(value.root, first.path), 'utf8');
      for (const responses of [args.responses, first.record.responses, [args.responses[1]], [...args.responses, ...args.responses]]) {
        const result = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, { ...args, responses });
        assert.equal(result.reused, true); assert.equal(result.sha256, first.sha256);
        assert.equal(await readFile(path.join(value.root, first.path), 'utf8'), before);
      }
      const verified = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
      assert.equal(verified.checkpoint.stage, 'complete');
      assert.equal(verified.checkpoint.questioningAllowed, false);
      assert.match(verified.checkpoint.instruction, /do not re-ask settled questions/);
      const extended = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase,
        { ...args, responses: [{ question: 'Remote calls?', answer: 'None.' }] });
      assert.deepEqual(extended.record.responses.map(row => row.id), ['Q-001', 'Q-002', 'Q-003']);
    });
  }
});

test('conflicting replies and changed checkpoint bindings never silently reuse accepted answers', async t => {
  const value = await clarificationFixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const args = { actor: { name: 'Human Reviewer' }, agent: 'product-owner',
    responses: [{ question: 'Which inputs?', answer: 'Non-negative integers.' }] };
  const first = await recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, args);
  const file = path.join(value.root, first.path), before = await readFile(file, 'utf8');
  for (const response of [{ question: 'Which inputs?', answer: 'Negative integers too.' },
    { id: 'Q-001', question: 'A different question?', answer: 'Yes.' }]) {
    await assert.rejects(recordClarificationResponses(value.root, value.definition, value.workflow, value.phase,
      { ...args, responses: [response] }), error => error.code === 'CLARIFICATION_RESPONSE_CONFLICT');
    assert.equal(await readFile(file, 'utf8'), before);
  }
  await writeFile(file, JSON.stringify({ ...first.record, workId: 'OTHER-STORY' }));
  await assert.rejects(recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, args),
    error => error.code === 'CLARIFICATION_RECORD_BINDING_MISMATCH');
  await writeFile(file, before);
  const groundingFile = path.join(value.root, first.record.groundingRecordPath);
  const grounding = JSON.parse(await readFile(groundingFile, 'utf8'));
  await writeFile(value.root + '/' + value.promptPath, '# Changed scope\n');
  grounding.renderedSha256 = (await snapshot(path.join(value.root, value.promptPath))).sha256;
  await writeFile(groundingFile, JSON.stringify(grounding));
  await assert.rejects(recordClarificationResponses(value.root, value.definition, value.workflow, value.phase, args), /older prompt/);
  assert.equal(await readFile(file, 'utf8'), before);
  const verification = await verifyClarificationRecord(value.root, value.definition, value.workflow, value.phase);
  assert.equal(verification.checkpoint.stage, 'inspect-binding');
  assert.equal(verification.checkpoint.questioningAllowed, false);
  assert.match(verification.checkpoint.instruction, /Preserve prior answers/);
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

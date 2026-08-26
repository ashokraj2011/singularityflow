import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveHelp } from '../src/help-service.mjs';
import { classifyHelpIntent } from '../src/help-intents.mjs';

const corpus = JSON.parse(await readFile(new URL('./fixtures/help-utterances.json', import.meta.url), 'utf8'));

test('reviewed help utterances route deterministically with citations and bounded answers', async () => {
  let expectedResolved = 0;
  let correctlyResolved = 0;
  let ambiguous = 0;
  let noMatch = 0;
  for (const entry of corpus.cases) {
    const result = await resolveHelp(entry.question, { maxBytes: 4000 });
    assert.equal(result.status, entry.status, entry.question);
    assert.equal(result.helpIntent, entry.intent, `${entry.question} intent`);
    if (entry.status === 'resolved') {
      expectedResolved += 1;
      if (result.topic?.id === entry.topic) correctlyResolved += 1;
      assert.equal(result.topic?.id, entry.topic, entry.question);
      assert.match(result.citation, new RegExp(`topic ${entry.topic} v\\d+`), `${entry.question} citation`);
      assert.ok(result.served.bytes <= 4000, `${entry.question} exceeded the answer ceiling`);
      assert.ok(result.handoff?.command.startsWith('singularity-flow '), `${entry.question} lacks a safe CLI handoff`);
      assert.ok(result.handoff?.skill.startsWith('/sf-'), `${entry.question} lacks a safe Copilot handoff`);
    } else {
      if (entry.status === 'ambiguous') ambiguous += 1;
      if (entry.status === 'not-found') noMatch += 1;
      if (entry.candidate) {
        assert.ok(result.candidates.some((candidate) => candidate.id === entry.candidate),
          `${entry.question} did not suggest ${entry.candidate}`);
      }
    }
  }
  assert.equal(correctlyResolved / expectedResolved, 1, 'correct-topic precision regressed');
  assert.equal(ambiguous, 1, 'ambiguity corpus changed unexpectedly');
  assert.equal(noMatch, 2, 'no-match corpus changed unexpectedly');
});

test('action imperatives never become help or lifecycle execution', () => {
  for (const imperative of corpus.actionImperatives) {
    assert.equal(classifyHelpIntent(imperative), null, imperative);
  }
});

test('the shared resolver has no model or host execution dependency', async () => {
  const source = await readFile(new URL('../src/help-service.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /request\.model|model-runner|model-provider|child_process|executeCommand|spawn\s*\(/);
});

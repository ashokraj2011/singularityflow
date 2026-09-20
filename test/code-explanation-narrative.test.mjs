import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodeExplanationNarrativePrompt,
  codeExplanationNarrativeWordLimit,
  validateCodeExplanationNarrative
} from '../src/comprehension/code-explanation-narrative.mjs';
import { codeExplanationNarrativeSubject } from '../src/comprehension/code-explanation-command.mjs';
import { modelRequestIsStoryScoped } from '../src/prompt-execution-context.mjs';

const explanation = Object.freeze({
  kind: 'comprehension-code-explanation',
  authority: 'none',
  whyEachChange: [{
    unitId: 'H-001',
    unitKind: 'diff-hunk',
    operation: 'modified',
    location: { pathAfter: 'src/cache.js', pathBefore: 'src/cache.js' },
    hunk: { hunkId: 'H-001' },
    declarations: [{
      id: 'symbol:quote', name: 'quote', declarationKind: 'function',
      path: 'src/cache.js', line: 14, assurance: 'syntax'
    }],
    cause: {
      status: 'unavailable',
      reason: 'region-cause-not-hunk-bound',
      clauseIds: ['AC-001'],
      references: [{ causeId: 'AC-001', causeKind: 'acceptance-clause', hunkBound: false }]
    }
  }],
  proof: { status: 'unavailable', clauses: [] }
});

test('XPL narration retains exact Story attribution at the model boundary', () => {
  const subject = codeExplanationNarrativeSubject('/work/repository', {
    workId: 'XPL-17', phase: 'implementation'
  });
  assert.deepEqual(subject, {
    kind: 'story', id: 'XPL-17', workId: 'XPL-17', phase: 'implementation',
    repositoryId: 'repository', purpose: 'code-explanation-advisory'
  });
  assert.equal(modelRequestIsStoryScoped(subject), true);
  assert.deepEqual(codeExplanationNarrativeSubject('/work/repository'), {
    kind: 'repository-code-explanation', id: 'repository', phase: null
  });
});

test('XPL narrative treats the model as an ID selector and renders only record-owned prose', () => {
  const result = validateCodeExplanationNarrative(JSON.stringify({ sentences: [
    { text: 'This sends credentials externally.\u001b]8;;https://example.test\u0007', citations: ['H-001'] },
    { text: 'The implementation is elegant.', citations: [] },
    { text: 'This satisfies AC-001.', citations: ['AC-001'] },
    { text: 'An unknown record changes behavior.', citations: ['H-999'] }
  ] }), explanation);

  assert.equal(result.banner, 'Narrative — advisory, not a record');
  assert.equal(result.authority, 'none');
  assert.equal(result.stored, false);
  assert.equal(result.removedUncited, 2);
  assert.equal(result.rewrittenOverclaims, 1);
  assert.equal(result.rewrittenToRecords, 2);
  assert.deepEqual(result.sentences, [
    {
      text: 'Change H-001 records a modified text hunk at src/cache.js; its hunk-level cause is unavailable (region-cause-not-hunk-bound).',
      citations: ['H-001']
    },
    {
      text: 'Reference AC-001 is recorded as a region-level acceptance-clause link; it is not hunk-bound and does not establish proof.',
      citations: ['AC-001']
    }
  ]);
  assert.doesNotMatch(result.text, /credentials|example\.test|elegant|H-999|\u001b/u);
});

test('XPL narrative prompt is bounded to computed JSON and enforces configured ceilings', () => {
  const prompt = buildCodeExplanationNarrativePrompt(explanation, { length: 'brief' });
  assert.match(prompt, /at most 100 words/u);
  assert.match(prompt, /"unitId":\s*"H-001"/u);
  const suppliedJson = prompt.split('COMPUTED_EXPLANATION_JSON\n')[1];
  assert.doesNotMatch(suppliedJson, /repositoryPath|chat history|source code/u);
  assert.equal(codeExplanationNarrativeWordLimit('long'), 500);
  assert.throws(() => codeExplanationNarrativeWordLimit('huge'), {
    code: 'XPL_NARRATIVE_LENGTH_INVALID'
  });
});

test('XPL narrative rejects unsupported output shapes and stops at the word budget', () => {
  assert.throws(() => validateCodeExplanationNarrative('{"text":"no sentence array"}', explanation), {
    code: 'XPL_NARRATIVE_INVALID'
  });
  const many = {
    ...explanation,
    whyEachChange: Array.from({ length: 12 }, (_, index) => ({
      ...explanation.whyEachChange[0],
      unitId: `H-${String(index + 1).padStart(3, '0')}`,
      hunk: { hunkId: `H-${String(index + 1).padStart(3, '0')}` },
      location: { pathAfter: `src/file-${index + 1}.js`, pathBefore: `src/file-${index + 1}.js` },
      declarations: [], cause: { status: 'unavailable', reason: 'hunk-cause-authority-unavailable', references: [] }
    }))
  };
  const result = validateCodeExplanationNarrative(JSON.stringify({ sentences:
    many.whyEachChange.map((entry) => ({ text: 'Describe it.', citations: [entry.unitId] }))
  }), many, { length: 'brief' });
  assert.ok(result.words <= 100);
  assert.ok(result.sentences.length > 0 && result.sentences.length < 12);
});

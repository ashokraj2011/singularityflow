import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_SCHEMA_VERSION,
  DEVELOPER_INTENTS,
  planDeveloperConversation
} from '../src/gateway/conversation.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';

const examples = [
  ['Could you tell me what I am working on today?', 'orient', 'developer.next', true],
  ['Please continue my current Story', 'continue', 'work.continue', false],
  ['Start a new bug fix', 'start', 'work.start.intake', false],
  ['What is blocking this Story?', 'inspect', 'work.readiness', true],
  ['Where did I stop yesterday?', 'inspect', 'work.return', true],
  ['Generate the active phase', 'act', 'work.continue', false],
  ['The publication push is stuck', 'recover', 'work.continue', true]
];

test('ordinary developer language maps to the six closed intents', () => {
  assert.equal(CONVERSATION_SCHEMA_VERSION, 2);
  assert.deepEqual(DEVELOPER_INTENTS, ['orient', 'continue', 'start', 'inspect', 'act', 'recover']);
  for (const [utterance, intent, operationId, automatic] of examples) {
    const result = planDeveloperConversation(utterance);
    assert.equal(result.intent, intent, utterance);
    assert.equal(result.route.operationId, operationId, utterance);
    assert.equal(result.route.automatic, automatic, utterance);
    assert.equal(result.stateSource, 'durable-records');
    assert.equal(Object.values(result.effects).every((value) => value === false), true);
    assert.equal(Object.hasOwn(result, 'utterance'), false, 'raw developer prose is not retained');
  }
});

test('start language infers only a bounded work shape and category', () => {
  const result = planDeveloperConversation('Start a new bug fix for payment retries');
  assert.deepEqual(result.route.work, {
    shape: 'story', category: 'bug-fix', source: 'manual',
    requiredInputs: ['work description', 'definition of done', 'remote base branch']
  });
  const initiative = planDeveloperConversation('Begin a new initiative');
  assert.equal(initiative.route.work.shape, 'initiative');
  assert.equal(Object.hasOwn(result, 'utterance'), false);
});

test('conversation routes only to registered read planners', () => {
  const registry = gatewayRegistry();
  for (const [utterance] of examples) {
    const planned = planDeveloperConversation(utterance);
    const operation = registry.operations.find((entry) => entry.id === planned.route.operationId);
    assert.ok(operation, `${planned.route.operationId} is registered`);
    assert.equal(operation.classification, 'read', `${planned.route.id} cannot route straight to a mutation`);
  }
});

test('ambiguous and unknown language never silently selects an action', () => {
  const ambiguous = planDeveloperConversation('Generate and submit the current phase');
  assert.equal(ambiguous.confidence, 'ambiguous');
  assert.equal(ambiguous.route, null);
  assert.deepEqual(ambiguous.choices.map((choice) => choice.id), ['act-submit', 'act-generate']);

  const unknown = planDeveloperConversation('Please just sort it out somehow');
  assert.equal(unknown.confidence, 'none');
  assert.equal(unknown.route, null);
  assert.deepEqual(unknown.choices, []);
});

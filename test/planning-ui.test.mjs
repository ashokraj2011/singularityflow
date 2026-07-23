import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCopilotQuestions,
  parseStoryPlan,
  planningLogEntry
} from '../apps/desktop/src/planning-ui.mjs';

test('planning UI extracts decision questions without treating prose as an artifact', () => {
  const questions = extractCopilotQuestions(`
I need two decisions before finalizing.
1. Should the mobile story block on the API implementation specification?
2. Which repository owns the customer schema?
After that I can produce the complete story plan.
`);
  assert.deepEqual(questions, [
    'Should the mobile story block on the API implementation specification?',
    'Which repository owns the customer schema?'
  ]);
});

test('planning UI parses epic and story identities for pre-promotion analysis', () => {
  const analysis = parseStoryPlan(`
version: 1
initiativeId: INIT-42
epics:
  - id: EPIC-ONBOARD
    title: Customer onboarding
    stories:
      - id: API-201
        title: Create onboarding API
        repository: api
        acceptanceCriteria:
          - POST request returns the created onboarding resource
      - id: MOB-101
        title: Build onboarding screen
        repository: mobile
        dependsOn:
          - story: API-201
            requiredPhase: implementation-spec
`);
  assert.equal(analysis.valid, true);
  assert.equal(analysis.epics[0].id, 'EPIC-ONBOARD');
  assert.equal(analysis.stories[1].workId, 'MOB-101');
  assert.equal(analysis.stories[1].jiraKey, null);
  assert.equal(analysis.stories[0].acceptanceCriteria.length, 1);
  assert.equal(analysis.repositories.join(','), 'api,mobile');
  assert.equal(analysis.dependencies, 1);
});

test('planning UI reports invalid story dependencies and classifies diagnostic logs', () => {
  const analysis = parseStoryPlan(`
version: 1
epics:
  - id: EPIC-1
    stories:
      - id: MOB-1
        repository: mobile
        dependsOn: [API-404]
`);
  assert.equal(analysis.valid, false);
  assert.match(analysis.error, /unknown story API-404/);
  assert.equal(planningLogEntry({ type: 'diagnostic', text: 'stderr output' }, '2026-01-01T00:00:00.000Z').level, 'warning');
  assert.equal(planningLogEntry({ type: 'permission-denied', title: 'write file' }).level, 'error');
});

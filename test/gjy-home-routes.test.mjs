import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  GOLDEN_JOURNEY_INTENTS, GOLDEN_JOURNEY_OPERATION_IDS, planDeveloperConversation
} from '../src/gateway/conversation.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { problemInvestigate } from '../src/gateway/planners/problem-investigate.mjs';
import { repositoryExplore } from '../src/gateway/planners/repository-explore.mjs';
import { run } from '../src/util.mjs';

const journeys = [
  ['What am I working on today?', 'orient', 'developer.next'],
  ['Continue my current work', 'continue', 'work.continue'],
  ['Start from Jira', 'start', 'work.start.intake'],
  ['Describe new work', 'start', 'work.start.intake'],
  ['Investigate a bug where checkout fails', 'investigate', 'problem.investigate'],
  ['Replace the payment retry implementation', 'impact', 'impact.what-if'],
  ['Add Kotlin support to the AST adapter', 'impact', 'impact.what-if'],
  ['What if I change payment notification to an event?', 'impact', 'impact.what-if'],
  ['Assess impact of my changes', 'impact', 'impact.quick'],
  ['Explore this repository', 'orient', 'repository.explore']
];

test('the five golden goals have deterministic natural-language routes', () => {
  assert.deepEqual(GOLDEN_JOURNEY_INTENTS, ['continue', 'start', 'investigate', 'impact', 'orient']);
  for (const [utterance, intent, operationId] of journeys) {
    const planned = planDeveloperConversation(utterance);
    assert.equal(planned.confidence, 'strong', utterance);
    assert.equal(planned.intent, intent, utterance);
    assert.equal(planned.route.operationId, operationId, utterance);
  }
  assert.equal(planDeveloperConversation('Start from Jira').route.work.source, 'jira');
  assert.equal(planDeveloperConversation('Start from GitHub').route.work.source, 'github-issue');
  assert.equal(planDeveloperConversation('Start a new Story from GitHub issue').route.work.source, 'github-issue');
  assert.equal(planDeveloperConversation('Describe new work').route.work.source, 'manual');
});

test('every advertised golden operation is registered and has a shipped planner', () => {
  const operations = new Map(gatewayRegistry().operations.map((entry) => [entry.id, entry]));
  const planners = gatewayPlanners();
  for (const operationId of GOLDEN_JOURNEY_OPERATION_IDS) {
    const operation = operations.get(operationId);
    assert.ok(operation, `${operationId} is registered`);
    assert.equal(typeof planners.get(operation.gateway.planner), 'function',
      `${operationId} planner '${operation.gateway.planner}' is shipped`);
  }
});

test('repository orientation and investigation return bounded facts without source or host paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-routes-'));
  run('git', ['init', '-q', '-b', 'main', root]);
  run('git', ['config', 'user.name', 'Golden Journey'], { cwd: root });
  run('git', ['config', 'user.email', 'golden@example.com'], { cwd: root });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'checkout.js'), 'export function retryCheckout() { return true; }\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });

  const explored = await repositoryExplore({ root, arguments: { question: 'private exploration prompt' } });
  assert.equal(explored.operation.id, 'repository.explore');
  assert.equal(explored.data.bounds.sourceBodiesIncluded, false);
  assert.equal(explored.data.overview.commands.some((entry) => JSON.stringify(entry).includes('node --test')), true);
  assert.doesNotMatch(JSON.stringify(explored), /private exploration prompt/);

  const investigated = await problemInvestigate({ root, arguments: { symptom: 'checkout retry fails privatephrase' } });
  assert.equal(investigated.operation.id, 'problem.investigate');
  assert.equal(investigated.data.observations.textMatches[0].path, 'checkout.js');
  assert.equal(investigated.data.conclusion, null);
  assert.equal(investigated.data.bounds.sourceBodiesIncluded, false);
  assert.doesNotMatch(JSON.stringify(investigated), /privatephrase/);
  assert.doesNotMatch(JSON.stringify(investigated), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

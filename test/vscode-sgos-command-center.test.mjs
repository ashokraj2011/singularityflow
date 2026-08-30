import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  buildSgosCommandCenter, sgosHumanRequestChoices
} = await import('../apps/vscode/src/views/sgos-command-center-model.ts');
const { sgosCommandCenterBody, SGOS_COMMAND_CENTER_SCRIPT } =
  await import('../apps/vscode/src/views/sgos-command-center-page.ts');
const { buildSgosProcessGraph } = await import('../apps/vscode/src/views/sgos-process-graph-model.ts');

const hash = (digit) => `sha256:${digit.repeat(64)}`;
const card = {
  kind: 'sgos-process-card', processId: 'PROC-UI', processRevision: 4,
  processSha256: hash('a'), programSha256: hash('b'), status: 'waiting-human', statusLabel: 'Needs you',
  subject: { kind: 'story', id: 'WRK-UI', branch: 'WRK-UI', baselineRevision: '1'.repeat(40) },
  taskCounts: { 'waiting-human': 1 },
  currentTask: { taskInstanceId: 'TASK-1', taskTemplateId: 'approve', state: 'waiting-human', revision: 2, receiptSha256: null },
  taskCount: 1, evidenceReady: 0, openRequestCount: 1, currentCheckpointSha256: hash('c'),
  updatedAt: '2026-08-30T00:00:00.000Z', available: true, successClaimed: false, resumable: false,
  actions: []
};
const workObject = {
  schemaVersion: 1, kind: 'work-object', objectId: 'WKO-UI', objectSha256: hash('d'),
  processId: 'PROC-UI', taskInstanceId: 'TASK-1', createdAt: '2026-08-30T00:00:00.000Z',
  view: {
    type: 'form', dataRef: `sfref:sgos-human-request:${hash('e')}`,
    schema: {
      title: 'Approve UI output', description: 'Review exact evidence.',
      'x-sgos': {
        requestType: 'approval', authorityRequired: { kind: 'role', id: 'reviewer' },
        options: [{ id: 'approved', label: 'Approve' }], expiresAt: null
      }
    },
    actions: [{ id: 'request.respond', label: 'Respond', operation: 'request.respond', inputSchema: {} }]
  }
};
const snapshot = {
  workItems: [], initiatives: [], selectedWorkId: null, selectedInitiativeId: null,
  initiative: null, workflow: null,
  sgos: {
    projectionVersion: 1, kind: 'sgos-command-center', contentSha256: hash('f'), counts: { 'waiting-human': 1 },
    processes: [card], needsYou: [workObject], unavailable: [],
    runtimeProfile: { id: 'bounded-static-parallel-lineage', capabilities: {
      commandCenter: { status: 'available', reason: 'Installed.' },
      parallelExecution: { status: 'available', reason: 'One bounded ready wave is installed.' },
      replay: { status: 'available', reason: 'Pure suffix replay is installed.' },
      fork: { status: 'available', reason: 'Genesis-only fork is installed.' },
      taskRetry: { status: 'staged', reason: 'Task retry is not installed.' }
    } }
  }
};

test('Command Center groups only authoritative states and renders staged capabilities disabled', () => {
  const model = buildSgosCommandCenter(snapshot, { selectedProcessId: 'PROC-UI' });
  assert.deepEqual(model.lanes.map((lane) => lane.label), ['Needs you']);
  assert.equal(model.selected.processSha256, hash('a'));
  const html = sgosCommandCenterBody(model);
  assert.match(html, /Projection-only view/);
  assert.match(html, /Approve UI output/);
  assert.match(html, /role · reviewer/);
  assert.match(html, /Pure suffix replay is installed/);
  assert.match(html, /Genesis-only fork is installed/);
  assert.match(html, /Task retry is not installed/);
  assert.match(html, /One bounded ready wave is installed/);
  assert.match(html, /disabled aria-disabled="true">Not installed/);
  assert.doesNotMatch(html, /Ready for review|>Verified</);
});

test('an exact graph renders accessibly and a stale graph is refused', () => {
  const raw = {
    processId: 'PROC-UI', processRevision: 4, processSha256: hash('a'),
    programId: 'PRG-UI', programSha256: hash('b'),
    tasks: [
      { taskInstanceId: 'TASK-1', taskTemplateId: 'approve', state: 'waiting-human', revision: 2, receiptSha256: null },
      { taskInstanceId: 'TASK-2', taskTemplateId: 'finish', state: 'planned', revision: 1, receiptSha256: null }
    ], edges: [{ from: 'approve', to: 'finish' }]
  };
  const graph = buildSgosProcessGraph(raw, card);
  assert.ok(graph);
  const model = buildSgosCommandCenter(snapshot, { selectedProcessId: 'PROC-UI', graph });
  const html = sgosCommandCenterBody(model);
  assert.match(html, /role="img" aria-labelledby="sgos-graph-title sgos-graph-description"/);
  assert.match(html, /A complete text table follows/);
  assert.match(html, /aria-label="Exact Process tasks"/);
  assert.match(html, /<td>approve<\/td>/);
  assert.equal(buildSgosProcessGraph({ ...raw, processSha256: hash('9') }, card), null);
});

test('webview posts identifiers rather than commands and the command is fully wired', async () => {
  assert.match(SGOS_COMMAND_CENTER_SCRIPT, /objectId:target\.dataset\.respond/);
  assert.match(SGOS_COMMAND_CENTER_SCRIPT, /processId:target\.dataset\.graph/);
  assert.doesNotMatch(SGOS_COMMAND_CENTER_SCRIPT, /command\s*:/);
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.openCommandCenter'));
  const extension = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.openCommandCenter': async/);
  const sidebar = await readFile(path.join(root, 'apps/vscode/src/views/sidebar.ts'), 'utf8');
  assert.match(sidebar, /id: 'command-center'.*Command Center/);
});

test('Command Center maps each Human Request to decisions accepted by the kernel', () => {
  const approval = sgosHumanRequestChoices({
    requestType: 'approval', inputSchema: null, sensitiveMode: 'none',
    options: [{ id: 'approve', label: 'Approve this exact result' }]
  });
  assert.deepEqual(approval.map((choice) => choice.args), [
    ['--decision', 'approved'],
    ['--decision', 'rejected'],
    ['--decision', 'cancelled']
  ]);
  assert.equal(approval.some((choice) => choice.args.includes('--option')), false,
    'approval labels must not be sent as the invalid selected decision');

  const policyChoice = sgosHumanRequestChoices({
    requestType: 'policy-choice', inputSchema: null, sensitiveMode: 'none',
    options: [{ id: 'bounded', label: 'Use bounded execution' }]
  });
  assert.deepEqual(policyChoice.map((choice) => choice.args), [
    ['--option', 'bounded'],
    ['--decision', 'cancelled']
  ]);

  assert.deepEqual(sgosHumanRequestChoices({
    requestType: 'credential', inputSchema: { type: 'object' }, sensitiveMode: 'secret-broker'
  }).map((choice) => choice.args), [['--decision', 'cancelled']],
  'the UI must never solicit or forward a credential value');
  assert.deepEqual(sgosHumanRequestChoices({ requestType: 'future-request' }), [],
    'unknown request types fail closed');
});

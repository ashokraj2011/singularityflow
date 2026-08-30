import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  buildSgosCommandCenter, sgosEnabledProcessAction, sgosHumanRequestChoices
} = await import('../apps/vscode/src/views/sgos-command-center-model.ts');
const {
  renderSgosWorkObject, sgosCommandCenterBody, sgosRenderDescriptor,
  SGOS_COMMAND_CENTER_SCRIPT
} =
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
  actions: [
    'process.stop', 'process.recover.plan', 'process.replay.plan', 'process.fork.plan'
  ].map((operation) => ({
    id: operation, operation, enabled: true, reason: null,
    source: { processId: 'PROC-UI', processRevision: 4, processSha256: hash('a') }
  }))
};
const workObject = {
  schemaVersion: 1, kind: 'work-object', objectId: 'WKO-UI', objectSha256: hash('d'),
  processId: 'PROC-UI', taskInstanceId: 'TASK-1', createdAt: '2026-08-30T00:00:00.000Z',
  view: {
    type: 'approval', dataRef: `sfref:sgos-human-request:${hash('e')}`,
    schema: {
      title: 'Approve UI output', description: 'Review exact evidence.',
      'x-sgos': {
        requestType: 'approval', authorityRequired: { kind: 'role', id: 'reviewer' },
        why: 'Review exact evidence.',
        exactSubject: {
          processId: 'PROC-UI', processSha256: hash('a'), taskInstanceId: 'TASK-1',
          requestSha256: hash('e'), subjectSha256: hash('7'), checkpointSha256: hash('c'),
          policySnapshotSha256: hash('6'), evidenceRefs: [hash('8')]
        },
        choices: [{ id: 'approved', label: 'Approve', consequence: 'The exact task may continue.' }],
        whatRemainsRunning: 'No execution remains active in this Process; unrelated Processes are unaffected.',
        resumeBehavior: 'The kernel rechecks the exact revision and request before continuing.',
        expiresAt: null
      },
      'x-sgos-render': {
        descriptorVersion: 1, viewType: 'approval', title: 'Approval request',
        summary: 'Approval request for PROC-UI at revision 4.',
        accessibility: { role: 'form', label: 'Approval request for PROC-UI', keyboard: 'Use Tab.' },
        delivery: { mode: 'inline', slice: 'sgos', release: 'panel-dispose' },
        fields: [{ id: 'choice', label: 'Choice' }, { id: 'consequence', label: 'Consequence' }],
        rows: [{ id: 'approved', cells: ['Approve', 'The exact task may continue.'] }],
        edges: [], notes: [], truncated: false
      }
    },
    actions: [{
      id: 'request.respond', label: 'Respond', operation: 'request.respond', inputSchema: {
        properties: {
          processId: { const: 'PROC-UI' }, processSha256: { const: hash('a') },
          requestId: { const: 'HRQ-UI' }, requestSha256: { const: hash('e') },
          expectedRevision: { const: 4 }
        }
      }
    }]
  }
};
const viewTypes = [
  'overview', 'graph', 'board', 'timeline', 'table', 'document', 'form', 'evidence',
  'diff', 'matrix', 'chart', 'log', 'metrics', 'simulation', 'approval'
];
const projectedViews = viewTypes.map((type, index) => ({
  ...workObject,
  objectId: `WKO-VIEW-${index}`,
  objectSha256: hash(index.toString(16)),
  view: {
    type, dataRef: `sfref:sgos-process:${hash('a')}`, actions: [],
    schema: {
      'x-sgos-render': {
        descriptorVersion: 1, viewType: type, title: `${type} view`,
        summary: `${type} for PROC-UI`,
        accessibility: {
          role: type === 'form' || type === 'approval' ? 'form'
            : type === 'document' ? 'document' : type === 'log' ? 'log' : 'region',
          label: `${type} view for PROC-UI`, keyboard: 'Use native Tab and Shift+Tab.'
        },
        delivery: {
          mode: ['graph', 'document', 'evidence', 'diff', 'matrix', 'chart', 'log', 'metrics', 'simulation'].includes(type)
            ? 'lazy' : 'inline',
          slice: 'sgos', release: 'panel-dispose'
        },
        fields: [{ id: 'value', label: 'Value' }],
        rows: [{ id: 'row', cells: [type === 'document' ? '<script>alert(1)</script>' : type] }],
        edges: [], notes: [], truncated: false
      }
    }
  }
}));
const snapshot = {
  workItems: [], initiatives: [], selectedWorkId: null, selectedInitiativeId: null,
  initiative: null, workflow: null,
  sgos: {
    projectionVersion: 1, kind: 'sgos-command-center', contentSha256: hash('f'), counts: { 'waiting-human': 1 },
    processes: [card], needsYou: [workObject], views: projectedViews, unavailable: [],
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
  assert.match(html, /Why this needs you/);
  assert.match(html, /Choices and consequences/);
  assert.match(html, /The exact task may continue/);
  assert.match(html, /What remains running/);
  assert.match(html, /Resume behavior/);
  assert.match(html, /no expiry declared/);
  assert.match(html, /Pure suffix replay is installed/);
  assert.match(html, /Genesis-only fork is installed/);
  assert.match(html, /Task retry is not installed/);
  assert.match(html, /One bounded ready wave is installed/);
  assert.match(html, /disabled aria-disabled="true">Not installed/);
  assert.match(html, /data-stop="PROC-UI">Stop…<\/button>/);
  assert.match(html, /data-recovery="PROC-UI">Recover…<\/button>/);
  assert.match(html, /data-replay="PROC-UI">Replay…<\/button>/);
  assert.match(html, /data-fork="PROC-UI">Fork…<\/button>/);
  assert.doesNotMatch(html, /Ready for review|>Verified</);
});

test('all canonical projection views render through a closed escaped accessible descriptor', () => {
  const model = buildSgosCommandCenter(snapshot, { selectedProcessId: 'PROC-UI' });
  assert.deepEqual(model.views.map((entry) => entry.view.type), viewTypes);
  const html = sgosCommandCenterBody(model);
  for (const type of viewTypes) {
    assert.match(html, new RegExp(`data-view-type="${type}"`), type);
    assert.match(html, new RegExp(`aria-label="${type} view for PROC-UI"`), type);
  }
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Bounded heavy view/);
  const poisoned = structuredClone(projectedViews[0]);
  poisoned.view.schema['x-sgos-render'].html = '<img src=x onerror=alert(1)>';
  assert.equal(sgosRenderDescriptor(poisoned), null,
    'unknown schema-driven renderer fields must fail closed');
  assert.doesNotMatch(renderSgosWorkObject(poisoned), /onerror|<img/);
});

test('actions are exposed only when enabled and bound to the exact Process revision and digest', () => {
  assert.equal(sgosEnabledProcessAction(card, 'process.stop')?.id, 'process.stop');
  const disabled = { ...card, actions: card.actions.map((entry) => ({ ...entry, enabled: false })) };
  const wrongRevision = {
    ...card,
    actions: card.actions.map((entry) => ({
      ...entry, source: { ...entry.source, processRevision: 3 }
    }))
  };
  const wrongDigest = {
    ...card,
    actions: card.actions.map((entry) => ({
      ...entry, source: { ...entry.source, processSha256: hash('9') }
    }))
  };
  for (const process of [disabled, wrongRevision, wrongDigest]) {
    assert.equal(sgosEnabledProcessAction(process, 'process.stop'), null);
    const html = sgosCommandCenterBody(buildSgosCommandCenter({
      ...snapshot,
      sgos: { ...snapshot.sgos, processes: [process] }
    }));
    assert.doesNotMatch(html, /data-stop=/);
    assert.doesNotMatch(html, /data-replay=/);
    assert.doesNotMatch(html, /data-fork=/);
  }
});

test('an exact graph renders accessibly and a stale graph is refused', () => {
  const raw = {
    processId: 'PROC-UI', processRevision: 4, processSha256: hash('a'),
    programId: 'PRG-UI', programSha256: hash('b'),
    tasks: [
      { taskInstanceId: 'TASK-1', taskTemplateId: 'approve', state: 'succeeded', revision: 2, receiptSha256: hash('8') },
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
  assert.match(html, /data-evidence-process="PROC-UI"/);
  assert.match(html, /data-evidence-task="TASK-1"/);
  assert.equal(buildSgosProcessGraph({ ...raw, processSha256: hash('9') }, card), null);
});

test('Command Center renders pause, resume, step, and bounded run only from projected actions', () => {
  const source = { processId: 'PROC-UI', processRevision: 4, processSha256: hash('a') };
  const action = (operation) => ({ id: operation, operation, enabled: true, reason: null, source });
  const running = {
    ...card, status: 'running', statusLabel: 'Running', openRequestCount: 0,
    actions: ['process.pause', 'process.stop', 'process.step', 'process.run']
      .map(action)
  };
  const runningHtml = sgosCommandCenterBody(buildSgosCommandCenter({
    ...snapshot, sgos: { ...snapshot.sgos, processes: [running], needsYou: [] }
  }));
  assert.match(runningHtml, /data-pause="PROC-UI">Pause…<\/button>/);
  assert.match(runningHtml, /data-step="PROC-UI">Step…<\/button>/);
  assert.match(runningHtml, /data-run="PROC-UI">Run wave…<\/button>/);
  assert.doesNotMatch(runningHtml, /data-resume=/);

  const paused = {
    ...card, status: 'paused', statusLabel: 'Paused', resumable: true,
    actions: ['process.stop', 'process.resume'].map(action)
  };
  const pausedHtml = sgosCommandCenterBody(buildSgosCommandCenter({
    ...snapshot, sgos: { ...snapshot.sgos, processes: [paused], needsYou: [] }
  }));
  assert.match(pausedHtml, /data-resume="PROC-UI">Resume…<\/button>/);
  assert.doesNotMatch(pausedHtml, /data-step=|data-run=|data-pause=/);
});

test('webview posts identifiers rather than commands and the command is fully wired', async () => {
  assert.match(SGOS_COMMAND_CENTER_SCRIPT, /objectId:target\.dataset\.respond/);
  assert.match(SGOS_COMMAND_CENTER_SCRIPT, /processId:target\.dataset\.graph/);
  assert.match(SGOS_COMMAND_CENTER_SCRIPT, /processId:target\.dataset\.stop/);
  for (const type of ['pause', 'resume', 'step', 'run', 'replay', 'fork']) {
    assert.match(SGOS_COMMAND_CENTER_SCRIPT, new RegExp(`type:'${type}'`));
  }
  assert.match(SGOS_COMMAND_CENTER_SCRIPT, /type:'evidence'.*taskInstanceId:target\.dataset\.evidenceTask/);
  assert.doesNotMatch(SGOS_COMMAND_CENTER_SCRIPT, /command\s*:/);
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.openCommandCenter'));
  const extension = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.openCommandCenter': async/);
  const sidebar = await readFile(path.join(root, 'apps/vscode/src/views/sidebar.ts'), 'utf8');
  assert.match(sidebar, /id: 'command-center'.*Command Center/);
  const panel = await readFile(path.join(root, 'apps/vscode/src/views/sgos-command-center.ts'), 'utf8');
  assert.match(panel, /modal: true,[\s\S]*?'Stop Process'/);
  assert.match(panel, /'process', 'list', '--json'/,
    'mutations must reload the engine-owned exact action projection');
  assert.match(panel, /'process', 'stop', processId,[\s\S]*?'--expected-revision', String\(current\.action\.source\.processRevision\), '--json'/);
  assert.match(panel, /'process', 'pause', processId,[\s\S]*?'--expected-revision', String\(shown\.action\.source\.processRevision\), '--json'/);
  assert.match(panel, /'process', 'resume', processId,[\s\S]*?'--expected-revision', String\(fresh\.action\.source\.processRevision\), '--json'/);
  assert.match(panel, /'process', 'step', processId,[\s\S]*?'--expected-revision', String\(shown\.action\.source\.processRevision\), '--json'/);
  assert.match(panel, /'process', 'run', processId,[\s\S]*?'--expected-revision', String\(shown\.action\.source\.processRevision\), '--json'/);
  assert.match(panel, /result\.quiescent[\s\S]*?paused and quiescent[\s\S]*?quiescing/);
  assert.match(panel, /refreshedAction[\s\S]*?refreshedAction\.confirmationSha256/,
    'recovery must re-plan and apply only the exact projected confirmation');
  assert.match(panel, /'process', 'replay', processId, '--confirm', plan\.replayPlanSha256/);
  assert.match(panel, /'process', 'fork', processId, '--confirm', plan\.forkPlanSha256/);
  assert.match(panel, /'process', 'quarantine', processId,[\s\S]*?'--confirm', refreshed\.confirmationSha256/);
  assert.match(panel, /'task', 'evidence', processId, taskInstanceId, '--json'/);
  assert.match(panel, /processSha256 !== binding\.processSha256/,
    'Human Request projection must bind the exact Process digest');
  assert.match(panel, /const current = resultOf<HumanRequestInspection>[\s\S]*?'request', 'show'/,
    'the request must be re-resolved after confirmation and before mutation');
  assert.match(panel, /current\.process\.processRevision !== found\.process\.processRevision[\s\S]*?Nothing was sent/);
  assert.match(panel, /'request', 'respond', current\.request\.requestId[\s\S]*?'--expected-revision', String\(current\.process\.processRevision\)[\s\S]*?'--expected-process-sha256', current\.process\.processSha256/,
    'Human Response mutation must carry the exact reviewed Process revision and digest to the CLI');
  assert.match(panel, /acquireSlices\(\['sgos'\]\)/,
    'the heavy SGOS slice is lazy and panel-scoped');
  assert.match(panel, /this\.lease\?\.dispose\(\)/,
    'disposing the panel releases the heavy slice lease');
  assert.match(panel, /revision === this\.lastSliceRevision[\s\S]*?revisionChanged === false[\s\S]*?return;/,
    'an unchanged slice revision must not rebuild the webview');
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

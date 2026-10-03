/**
 * After-step deliveries in VS Code: read only for Stories that send actions, after a step moved;
 * a delivery that did not go out is announced once; Journey lists each one and retries by key.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  StepActionDeliveryMonitor, deliveryDetail, deliveryState, heldBy, pinnedActionLine, pinnedStepActions,
  stepActionRecordArgs, stepActionRetryArgs, stepActionStatusArgs, storyUsesStepActions, transitionFingerprint, undeliveredNotice,
  unrecordedDeliveries
} from '../apps/vscode/src/step-action-deliveries.ts';
import { deliveriesHtml } from '../apps/vscode/src/views/journey-deliveries.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (digit) => `sad_${String(digit).repeat(40)}`;

function story({ intake = 'approved', generation = 1, actions = true } = {}) {
  return {
    workItem: { id: 'STORY-7', title: 'Announce approvals' },
    currentPhase: 'design',
    phaseOrder: ['intake', 'design'],
    phases: { intake: { status: intake, generation }, design: { status: 'in_progress', generation: 1 } },
    resolution: {
      phases: [
        { id: 'intake', label: 'Intake', afterStep: actions ? [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events', send: 'event', targetSpec: { kind: 'webhook', url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_SECRET_TEAM_EVENTS_KEY' } }] : [] },
        { id: 'design', label: 'Design' }
      ]
    }
  };
}

const delivered = { key: key(1), status: 'delivered', workId: 'STORY-7', phaseId: 'intake', trigger: 'submitted', action: 'announce', target: 'team-events', kind: 'webhook', attempts: 1, deliveredAt: '2026-10-03T10:00:00.000Z', lastAttempt: { at: '2026-10-03T10:00:00.000Z', outcome: 'delivered', status: 200 } };
const retrying = { key: key(2), status: 'pending', workId: 'STORY-7', phaseId: 'intake', trigger: 'approved', action: 'announce', target: 'team-events', kind: 'webhook', attempts: 1, lastAttempt: { at: '2026-10-03T10:05:00.000Z', outcome: 'retry', status: 503, detail: 'Service Unavailable' } };
const notReady = { key: key(3), status: 'pending', workId: 'STORY-7', phaseId: 'intake', trigger: 'approved', action: 'log', target: 'audit-log', attempts: 1, lastAttempt: { at: '2026-10-03T10:05:00.000Z', outcome: 'unavailable', code: 'STEP_ACTION_SECRET_MISSING', detail: 'Secret SFLOW_SECRET_AUDIT_TOKEN is not set on this machine.' } };
const failed = { key: key(4), status: 'failed', workId: 'STORY-7', phaseId: 'intake', trigger: 'approved', action: 'notify', target: 'team-channel', attempts: 1, lastAttempt: { at: '2026-10-03T10:05:00.000Z', outcome: 'failed', status: 404, detail: 'Not Found' } };
const untried = { key: key(5), status: 'pending', workId: 'STORY-7', phaseId: 'intake', trigger: 'approved', action: 'announce', target: 'team-events', attempts: 0, lastAttempt: null };
const waiting = { key: key(6), status: 'waiting', workId: 'STORY-7', phaseId: 'intake', trigger: 'approved', action: 'announce', target: 'team-events', attempts: 0, lastAttempt: null };

test('what a Story pinned and where each delivery stands, in words', () => {
  const pinned = pinnedStepActions(story());
  assert.deepEqual(pinned, [{ phaseId: 'intake', label: 'Intake', actions: [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events', send: 'event', kind: 'webhook', required: false }] }]);
  assert.equal(pinnedActionLine(pinned[0].actions[0]), 'On submitted or approved, sends the event to team-events');
  assert.equal(storyUsesStepActions(story({ actions: false })), false);
  assert.equal(storyUsesStepActions(null), false);
  assert.deepEqual(pinnedStepActions({ resolution: { phases: [{ id: 'x', afterStep: [{ id: 1, on: 'approved' }] }] } }), [], 'malformed actions are left out');

  assert.deepEqual([delivered, retrying, notReady, failed, untried, waiting].map((entry) => [deliveryState(entry).label, deliveryState(entry).retryable]), [
    ['Delivered', false], ['Will retry', true], ['Not ready on this machine', true], ['Not delivered', true], ['Sending', true], ['Waits for the commit to be pushed', false]
  ]);
  assert.equal(deliveryState({ key: key(7), status: 'tampered' }).retryable, false, 'a record changed on disk is never sent');
  assert.equal(deliveryDetail(retrying), 'HTTP 503: Service Unavailable');
  assert.equal(deliveryDetail(delivered), 'HTTP 200');
  assert.equal(deliveryDetail(untried), null);
  assert.deepEqual(stepActionStatusArgs('STORY-7'), ['integrations', 'status', '--work-id', 'STORY-7', '--all', '--json']);
  assert.deepEqual(stepActionRetryArgs([key(2), 'sad_bad; rm -rf /', '--all']), ['integrations', 'retry', key(2), '--json'], 'only delivery keys reach the command');
});

test('a transition is a change in a step\'s status or generation, and a delivery is announced once', () => {
  const before = transitionFingerprint(story({ intake: 'awaiting_approval' }));
  assert.notEqual(before, transitionFingerprint(story({ intake: 'approved' })));
  assert.notEqual(transitionFingerprint(story({ generation: 1 })), transitionFingerprint(story({ generation: 2 })));
  const unrelated = story(); unrelated.workItem.title = 'Renamed';
  assert.equal(transitionFingerprint(story()), transitionFingerprint(unrelated));

  assert.equal(undeliveredNotice([delivered, untried, waiting], new Set()), null, 'delivered, untried and waiting deliveries say nothing');
  const notice = undeliveredNotice([delivered, retrying, failed], new Set());
  assert.deepEqual(notice.keys, [key(2), key(4)]);
  assert.equal(notice.message, '2 after-step actions were not delivered (announce → team-events: HTTP 503: Service Unavailable). Fix the target, then retry.');
  assert.equal(undeliveredNotice([retrying], new Set([key(2)])), null);
  assert.match(undeliveredNotice([notReady], new Set()).message, /^1 after-step action was not delivered \(log → audit-log: Secret SFLOW_SECRET_AUDIT_TOKEN is not set on this machine\.\)\. It is retried later; you can retry now\.$/);
});

test('the monitor reads only for Stories that send actions, after a step moved, and retries only keys it listed', async () => {
  const calls = [];
  let answer = { data: { deliveries: [untried] } };
  const client = { async run(args) { calls.push(args); return args[1] === 'retry' ? { data: { report: { delivered: [{}], retrying: [], failed: [], unavailable: [] } } } : structuredClone(answer); } };
  const notices = []; const scheduled = []; let updates = 0;
  const monitor = new StepActionDeliveryMonitor(client, (notice, workId) => notices.push([workId, notice.keys]), (callback, ms) => scheduled.push([callback, ms]));
  monitor.onDidUpdate(() => { updates += 1; });

  monitor.observe(story({ actions: false }));
  monitor.observe(null);
  assert.equal(calls.length, 0, 'a Story without actions costs nothing');

  monitor.observe(story({ intake: 'awaiting_approval' }));
  await monitor.refresh('STORY-7');
  assert.deepEqual(calls, [stepActionStatusArgs('STORY-7')]);
  assert.equal(updates, 1);
  assert.deepEqual(monitor.deliveriesFor('STORY-7'), { deliveries: [untried], loaded: true, error: null });
  assert.equal(scheduled.length, 1, 'an untried delivery is looked at once more after the delivery budget');
  assert.equal(scheduled[0][1], 20_000);

  monitor.observe(story({ intake: 'awaiting_approval' }));
  assert.equal(calls.length, 1, 'a refresh that moved no step reads nothing');

  answer = { data: { deliveries: [retrying, delivered, { key: 'not-a-key', status: 'failed' }, { ...failed, workId: 'OTHER-1' }] } };
  monitor.observe(story({ intake: 'approved' }));
  await monitor.refresh('STORY-7');
  assert.equal(calls.length, 2);
  assert.deepEqual(monitor.deliveriesFor('STORY-7').deliveries.map((entry) => entry.key), [key(2), key(1)], 'malformed rows and other Stories are dropped');
  assert.deepEqual(notices, [['STORY-7', [key(2)]]]);
  scheduled[0][0]();
  await monitor.refresh('STORY-7');
  assert.deepEqual(notices, [['STORY-7', [key(2)]]], 'the same delivery is announced once');

  assert.equal(await monitor.retry('STORY-7', [key(9), 'sad_bad']), 'There is nothing to retry for this Story.');
  assert.ok(!calls.some((args) => args[1] === 'retry'), 'a key this Story did not list is never retried');
  assert.equal(await monitor.retry('STORY-7', [key(2)]), 'Delivered.');
  assert.deepEqual(calls.find((args) => args[1] === 'retry'), ['integrations', 'retry', key(2), '--json']);

  const broken = new StepActionDeliveryMonitor({ async run() { throw new Error('integrations status is not available'); } }, () => {}, () => {});
  await broken.refresh('STORY-7');
  assert.deepEqual(broken.deliveriesFor('STORY-7'), { deliveries: [], loaded: true, error: 'integrations status is not available' });
});

test('Journey lists each delivery with its reason, escapes what the outbox says, and offers Retry only where it helps', () => {
  const journey = { kind: 'story' };
  const hostile = { ...failed, target: '<img src=x onerror=alert(1)>', lastAttempt: { ...failed.lastAttempt, detail: '<script>bad()</script>' } };
  const html = deliveriesHtml({ pinned: pinnedStepActions(story()), deliveries: [delivered, retrying, hostile, waiting], holds: [], loaded: true, error: null }, journey);
  assert.match(html, /After-step actions/);
  assert.match(html, /<strong>Intake<\/strong>: On submitted or approved, sends the event to team-events/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.equal((html.match(/data-retry="/g) ?? []).length, 2, 'retry is offered for the retrying and the failed delivery only');
  assert.match(html, new RegExp(`data-retry="${key(2)}"`));
  assert.doesNotMatch(html, new RegExp(`data-retry="${key(1)}"`));
  assert.match(html, /data-retry-all/);
  assert.match(html, /Waits for the commit to be pushed/);

  assert.equal(deliveriesHtml({ pinned: [], deliveries: [], loaded: true, error: null }, journey), '', 'a Story without actions shows nothing');
  assert.equal(deliveriesHtml({ pinned: pinnedStepActions(story()), deliveries: [], loaded: true, error: null }, { kind: 'initiative' }), '');
  assert.match(deliveriesHtml({ pinned: pinnedStepActions(story()), deliveries: [], loaded: false, error: null }, journey), /Reading the deliveries on this machine/);
  assert.match(deliveriesHtml({ pinned: pinnedStepActions(story()), deliveries: [], loaded: true, error: null }, journey), /Nothing has been sent yet/);
});

test('the Journey retries only a delivery key, and the window announces deliveries from confirmed snapshots', async () => {
  const journey = await readFile(path.join(packageRoot, 'apps/vscode/src/views/journey.ts'), 'utf8');
  assert.match(journey, /retryDelivery: \(message\) => \{\s*const key = stringField\(message, 'key'\);\s*if \(isDeliveryKey\(key\)\) void this\.retryDeliveries\(\[key\]\);/);
  assert.match(journey, /else if \(target\.dataset\.retry\) \{ target\.disabled = true; vscode\.postMessage\(\{ type: 'retryDelivery', key: target\.dataset\.retry \}\); \}/);
  const extension = await readFile(path.join(packageRoot, 'apps/vscode/src/extension.ts'), 'utf8');
  assert.match(extension, /if \(state\.snapshot && !state\.stale\) stepActionDeliveries\.observe\(state\.snapshot\.workflow \?\? null, state\.snapshot\.submissionReadiness\?\.reasonCode \?\? ''\);/);
  assert.match(extension, /showWarningMessage\(notice\.message, 'Show deliveries', 'Retry now'\)/);
  assert.match(extension, /JourneyPanel\.show\(context, store, onJourneyMessage, stepActionDeliveries\)/);
});

test('a required action is shown as holding the next step until its approved delivery is delivered and recorded', async () => {
  const required = story();
  required.resolution.phases[0].afterStep[0].required = true;
  const [pinnedRequired] = pinnedStepActions(required);
  assert.equal(pinnedRequired.actions[0].required, true);
  assert.equal(pinnedActionLine(pinnedRequired.actions[0]), 'On submitted or approved, sends the event to team-events; the next step waits for it');

  const approvedRecorded = { ...delivered, key: key(7), trigger: 'approved', generation: 1, required: true, recorded: true };
  const approvedUnrecorded = { ...approvedRecorded, key: key(8), recorded: false };
  const approvedFailed = { ...failed, generation: 1, required: true, recorded: false };
  const older = { ...approvedFailed, key: key(9), generation: 0 };
  assert.equal(deliveryState(approvedRecorded).label, 'Delivered and recorded');
  assert.equal(deliveryState(approvedUnrecorded).label, 'Delivered');
  assert.deepEqual(unrecordedDeliveries([delivered, approvedRecorded, approvedUnrecorded, { ...delivered, key: key(5), recorded: null }]).map((entry) => entry.key), [key(8)],
    'only a receipt this checkout could hold and does not is missing');
  assert.deepEqual(heldBy([approvedRecorded, approvedUnrecorded, approvedFailed, older, { ...delivered, required: true, recorded: false }], required).map((entry) => entry.key), [key(8), key(4)],
    'the submitted delivery and an older generation hold nothing');
  assert.deepEqual(heldBy([approvedUnrecorded], story({ intake: 'in_progress' })), [], 'a step that is not approved holds nothing');
  assert.match(undeliveredNotice([approvedFailed], new Set()).message, /Fix the target, then retry. The next step waits for it.$/);

  const journey = { kind: 'story' };
  const html = deliveriesHtml({ pinned: pinnedStepActions(required), deliveries: [approvedRecorded, approvedUnrecorded, approvedFailed], holds: heldBy([approvedUnrecorded, approvedFailed], required), loaded: true, error: null }, journey);
  assert.match(html, /The next step waits for 2 required deliveries: announce → team-events \(Intake\), notify → team-channel \(Intake\)\. Retry it once its target is fixed/);
  assert.match(html, /webhook · required/);
  assert.match(html, /Delivered and recorded/);
  assert.match(html, /<button class="secondary" data-record-receipts>Record its receipt<\/button>/);
  assert.match(html, /Only a required action holds the Story/);
  const quiet = deliveriesHtml({ pinned: pinnedStepActions(story()), deliveries: [delivered], holds: [], loaded: true, error: null }, journey);
  assert.doesNotMatch(quiet, /data-record-receipts|The next step waits/);

  const calls = [];
  const client = { async run(args) {
    calls.push(args);
    if (args[1] === 'record') return { data: { receipts: [{}, {}], skipped: [] } };
    if (args[1] === 'retry') return { data: { report: { delivered: [{}], retrying: [], failed: [], unavailable: [] }, receipts: { count: 1, commit: 'c'.repeat(40), pushed: true } } };
    return { data: { deliveries: [approvedFailed] } };
  } };
  const monitor = new StepActionDeliveryMonitor(client, () => {}, () => {});
  await monitor.refresh('STORY-7');
  assert.equal(await monitor.retry('STORY-7', [key(4)]), 'Delivered. Its receipt is recorded, so the next step can start.');
  assert.equal(await monitor.record('STORY-7'), 'Recorded 2 receipts in the Story.');
  assert.deepEqual(calls.find((args) => args[1] === 'record'), stepActionRecordArgs());
  assert.deepEqual(stepActionRecordArgs(), ['integrations', 'record', '--json']);
  const journeySource = await readFile(path.join(packageRoot, 'apps/vscode/src/views/journey.ts'), 'utf8');
  assert.match(journeySource, /else if \(target\.hasAttribute\('data-record-receipts'\)\) \{ target\.disabled = true; vscode\.postMessage\(\{ type: 'recordReceipts' \}\); \}/);
  assert.match(journeySource, /recordReceipts: \(\) => \{ void this\.recordReceipts\(\); \}/);
});

test('a held step shows the required delivery as its next action, in the Journey and the tree', async () => {
  const { buildJourney } = await import('../apps/vscode/src/views/journey-model.ts');
  const { buildTree } = await import('../apps/vscode/src/views/tree-model.ts');
  const { phaseSubmissionPresentation, stepActionHoldLabel } = await import('../apps/vscode/src/views/submission-presentation.ts');
  const held = (nextCommand, runnableHere = true) => {
    const workflow = story();
    workflow.resolution.phases[0].afterStep[0].required = true;
    workflow.phases.design = { id: 'design', label: 'Design', status: 'in_progress', generation: 0, artifacts: [], approvals: [] };
    workflow.phases.intake = { id: 'intake', label: 'Intake', status: 'approved', generation: 1, artifacts: [], approvals: [] };
    workflow.workItem.branch = 'STORY-7';
    return {
      initiative: null, initiatives: [], selectedInitiativeId: null, selectedWorkId: 'STORY-7', workItems: [{ id: 'STORY-7', title: 'Announce approvals' }],
      identities: { git: { email: 'reviewer@example.com' } }, workflow,
      submissionReadiness: {
        phaseId: 'design', phaseStatus: 'in_progress', classification: 'step-action-required', lifecycleReady: false,
        currentGeneration: 0, publishedGeneration: null, draftExists: false, draftModified: false, publicationRecorded: false,
        nextSkill: '/sf-integrations', nextCommand, reasonCode: 'STEP_ACTION_REQUIRED_UNRECORDED',
        stepActionHold: { reason: 'The next step waits: the required after-step action announce → team-events has no receipt in the Story.', runnableHere,
          missing: [{ key: key(4), phaseId: 'intake', generation: 1, action: 'announce', target: 'team-events', here: 'failed' }] }
      }
    };
  };
  const snapshot = held(`singularity-flow integrations retry ${key(4)}`);
  const presentation = phaseSubmissionPresentation(snapshot.workflow.phases.design, snapshot.submissionReadiness);
  assert.deepEqual([presentation.kind, presentation.statusLabel], ['step-action-required', 'Waits for a required after-step delivery']);
  assert.match(presentation.detail, /^The next step waits: /);
  const journey = buildJourney(snapshot);
  assert.deepEqual([journey.nextAction.label, journey.nextAction.execution, journey.nextAction.argv], ['Deliver the required action now', 'run', ['integrations', 'retry', key(4)]]);
  assert.match(journey.nextAction.reason, /^The next step waits: /);
  assert.equal(stepActionHoldLabel('singularity-flow integrations record'), 'Record its receipt');
  assert.equal(stepActionHoldLabel('singularity-flow sync'), 'Publish the step first');
  assert.equal(stepActionHoldLabel('singularity-flow integrations status --work-id STORY-7 --all'), 'See the required delivery');

  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
  const nodes = flatten(buildTree(snapshot));
  assert.ok(nodes.some((node) => node.id === 'story:design:step-action-hold' && node.label === 'Waits for a required after-step delivery'));
  const run = nodes.find((node) => node.id === 'story:design:step-action-hold-run');
  assert.deepEqual([run.label, run.command], ['Deliver the required action now', ['integrations', 'retry', key(4)]]);
  assert.equal(nodes.some((node) => node.id === 'story:design:generate'), false, 'a held step offers no generation');

  // A hold that clears changes no step's status, so the monitor reads again when readiness changes.
  const calls = [];
  const monitor = new StepActionDeliveryMonitor({ async run(args) { calls.push(args); return { data: { deliveries: [] } }; } }, () => {}, () => {});
  monitor.observe(snapshot.workflow, 'STEP_ACTION_REQUIRED_UNRECORDED');
  await monitor.refresh('STORY-7');
  monitor.observe(snapshot.workflow, 'STEP_ACTION_REQUIRED_UNRECORDED');
  monitor.observe(snapshot.workflow, 'PHASE_GENERATION_REQUIRED');
  await monitor.refresh('STORY-7');
  assert.equal(calls.length, 2);
});

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
  StepActionDeliveryMonitor, deliveryDetail, deliveryState, pinnedActionLine, pinnedStepActions,
  stepActionRetryArgs, stepActionStatusArgs, storyUsesStepActions, transitionFingerprint, undeliveredNotice
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
  assert.deepEqual(pinned, [{ phaseId: 'intake', label: 'Intake', actions: [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events', send: 'event', kind: 'webhook' }] }]);
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
  const html = deliveriesHtml({ pinned: pinnedStepActions(story()), deliveries: [delivered, retrying, hostile, waiting], loaded: true, error: null }, journey);
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
  assert.match(extension, /if \(state\.snapshot && !state\.stale\) stepActionDeliveries\.observe\(state\.snapshot\.workflow \?\? null\);/);
  assert.match(extension, /showWarningMessage\(notice\.message, 'Show deliveries', 'Retry now'\)/);
  assert.match(extension, /JourneyPanel\.show\(context, store, onJourneyMessage, stepActionDeliveries\)/);
});

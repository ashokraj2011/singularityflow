import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverLifecycleNotifications, lifecycleNotificationText } from '../src/notifications.mjs';

const event = {
  type: 'approval-requested', phaseId: 'design', generation: 2,
  subject: { kind: 'story', id: 'TEAM-1', branch: 'TEAM-1' }
};

test('Teams notification carries the exact published lifecycle subject without exposing its secret', async () => {
  let request;
  const results = await deliverLifecycleNotifications({
    channels: ['teams-webhook'], event,
    environment: { SINGULARITY_FLOW_TEAMS_WEBHOOK_URL: 'https://hooks.example.test/private-secret' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; }
  });
  assert.deepEqual(results, [{ channel: 'teams-webhook', delivered: true }]);
  assert.equal(request.url, 'https://hooks.example.test/private-secret');
  assert.match(JSON.parse(request.options.body).text, /TEAM-1.*design.*generation 2/s);
  assert.doesNotMatch(lifecycleNotificationText(event), /private-secret/);
});

test('notification delivery failures stay warnings rather than lifecycle authority', async () => {
  const missing = await deliverLifecycleNotifications({ channels: ['teams-webhook'], event, environment: {} });
  assert.equal(missing[0].delivered, false);
  assert.match(missing[0].error, /No Teams webhook/);
  const failed = await deliverLifecycleNotifications({
    channels: ['teams-webhook'], event,
    environment: { SINGULARITY_FLOW_TEAMS_WEBHOOK_URL: 'https://hooks.example.test/value' },
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.equal(failed[0].delivered, false);
  assert.match(failed[0].error, /HTTP 503/);
});

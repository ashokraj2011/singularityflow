/**
 * Jira after-step actions: a comment (and, when asked, the approved artifact and a transition) on
 * the Story's issue, written once per delivery however often it is retried.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { deliverStepActions, enqueueStepActions, listStepActionDeliveries } from '../src/step-action-delivery.mjs';
import {
  deliverToJira, jiraAttachmentName, jiraAttemptResult, jiraCommentText, jiraDeliveryProperty, jiraIssueFor
} from '../src/step-action-writers.mjs';
import { jiraTransitionFor, normalizeIntegrations, normalizeStepActions, pinStepActions } from '../src/step-actions.mjs';
import { jiraCredentialSnapshot } from '../src/jira-doctor.mjs';

const ENV = { JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_USERNAME: 'flow@example.com', JIRA_PAT: 'jira-token' };
const KEY = `sad_${'a'.repeat(40)}`;

/** A small Jira: one issue with status, comments, attachments, properties and transitions. */
function fakeJira({ status = 'In Review', failNextPropertyWrite = false } = {}) {
  const issue = { key: 'OPS-12', status, comments: [], attachments: [], properties: {} };
  const calls = [];
  const transitions = [{ id: '31', name: 'Approve', to: { name: 'Done', statusCategory: { name: 'Done' } }, fields: {} }];
  let refuseNextPropertyWrite = failNextPropertyWrite;
  let script = [];
  const reply = (code, body) => new Response(body === undefined ? null : JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${target.pathname}`);
    if (script.length) { const next = script.shift(); if (next) return reply(next, { errorMessages: [`scripted ${next}`] }); }
    const base = '/rest/api/3/issue/OPS-12';
    if (target.pathname === '/rest/api/3/myself') return reply(200, { displayName: 'Flow Bot' });
    if (!target.pathname.startsWith(base)) return reply(404, { errorMessages: ['Issue does not exist'] });
    const rest = target.pathname.slice(base.length);
    if (rest.startsWith('/properties/')) {
      const name = decodeURIComponent(rest.slice('/properties/'.length));
      if (method === 'PUT') {
        if (refuseNextPropertyWrite) { refuseNextPropertyWrite = false; return reply(500, { errorMessages: ['property store down'] }); }
        issue.properties[name] = JSON.parse(init.body);
        return reply(200, {});
      }
      return issue.properties[name] ? reply(200, { key: name, value: issue.properties[name] }) : reply(404, { errorMessages: ['No property'] });
    }
    if (rest === '' && method === 'GET') return reply(200, { key: 'OPS-12', fields: { status: { name: issue.status }, attachment: issue.attachments } });
    if (rest === '/comment' && method === 'GET') return reply(200, { comments: issue.comments.map((body, index) => ({ id: String(index + 1), body })) });
    if (rest === '/comment' && method === 'POST') { issue.comments.push(JSON.parse(init.body).body); return reply(201, { id: String(issue.comments.length), created: '2026-10-03T10:00:00.000Z' }); }
    if (rest === '/attachments' && method === 'POST') {
      const file = init.body.get('file');
      issue.attachments.push({ id: String(issue.attachments.length + 10), filename: file.name, size: file.size });
      return reply(200, [{ id: String(issue.attachments.length + 10), filename: file.name, size: file.size }]);
    }
    if (rest === '/transitions' && method === 'GET') return reply(200, { transitions });
    if (rest === '/transitions' && method === 'POST') { issue.status = transitions.find((item) => item.id === JSON.parse(init.body).transition.id).to.name; return reply(204); }
    return reply(404, { errorMessages: ['Unknown route'] });
  };
  return { issue, calls, fetchImpl, script: (codes) => { script = [...codes]; } };
}

function commentText(body) {
  return body.content.map((paragraph) => paragraph.content.map((node) => node.text).join('')).join('\n');
}

function jiraRecord({ target = { kind: 'jira', transition: { approved: 'Done' } }, send = 'summary', jiraKey = 'OPS-12', trigger = 'approved', artifact } = {}) {
  const integrations = normalizeIntegrations({ targets: { 'team-jira': target } });
  const [action] = pinStepActions(normalizeStepActions([{ id: 'tell-jira', on: [trigger], target: 'team-jira', send }], integrations, 'intake'), integrations);
  return {
    key: KEY, workId: 'STORY-9', phaseId: 'intake', generation: 1, trigger, action,
    event: {
      schema: 'sflow-step-action@1', delivery: { key: KEY, action: 'tell-jira', target: 'team-jira', trigger, send },
      story: { id: 'STORY-9', title: 'Checkout retry', workflow: 'feature', branch: 'STORY-9', jiraKey },
      step: { id: 'intake', label: 'Intake', generation: 1, status: 'approved' },
      actor: 'ada', at: '2026-10-03T10:00:00.000Z', commit: { sha: 'c'.repeat(40), remote: null },
      artifacts: [{ path: 'singularity/work-items/STORY-9/artifacts/intake/intake.md', sha256: 'b'.repeat(64) }], decision: null,
      summary: send === 'summary' ? { title: 'Checkout retry', acceptanceCriteria: ['A failed charge is retried once.'] } : undefined
    },
    ...(artifact ? { artifact } : {})
  };
}

test('a jira target names an optional issue and a status per trigger, and needs no address or secret', () => {
  const { targets } = normalizeIntegrations({ targets: {
    story: { kind: 'jira', transition: { submitted: 'In Review', approved: 'Done' } },
    ops: { kind: 'jira', issue: 'OPS-12', transition: 'Done', label: 'Ops log' }
  } });
  assert.deepEqual(targets.story, { id: 'story', kind: 'jira', timeoutSeconds: 10, transition: { submitted: 'In Review', approved: 'Done' } });
  assert.equal(jiraTransitionFor(targets.story, 'rejected'), null);
  assert.equal(jiraTransitionFor(targets.ops, 'rejected'), 'Done');
  const code = (target) => { try { normalizeIntegrations({ targets: { one: target } }); return null; } catch (error) { return error.code; } };
  for (const target of [
    { kind: 'jira', issue: 'ops-12' }, { kind: 'jira', issue: 'OPS-0' }, { kind: 'jira', transition: { merged: 'Done' } },
    { kind: 'jira', transition: '' }, { kind: 'jira', network: 'private' }, { kind: 'jira', transition: { approved: 'x'.repeat(81) } }
  ]) assert.equal(code(target), 'INTEGRATION_TARGET_INVALID', JSON.stringify(target));
  assert.equal(code({ kind: 'jira', url: 'https://jira.example.com' }), 'INTEGRATION_TARGET_FIELD_UNKNOWN', 'the address comes from the Jira connection, never the configuration');
  assert.equal(code({ kind: 'jira', token: 'abc' }), 'INTEGRATION_SECRET_INLINE');
});

test('a jira delivery comments, moves the issue and records itself, then a retry writes nothing', async () => {
  const jira = fakeJira();
  const record = jiraRecord();
  const first = await deliverToJira(record, { env: ENV, fetchImpl: jira.fetchImpl });
  assert.equal(first.outcome, 'delivered', first.detail);
  assert.equal(first.detail, 'commented on OPS-12; moved to Done');
  assert.equal(jira.issue.status, 'Done');
  assert.equal(jira.issue.comments.length, 1);
  const text = commentText(jira.issue.comments[0]);
  assert.match(text, /^Singularity Flow — Intake approved\nSTORY-9 Checkout retry · generation 1/);
  assert.match(text, /• A failed charge is retried once\./);
  assert.match(text, /Artifact singularity\/work-items\/STORY-9\/artifacts\/intake\/intake\.md · SHA-256 bbbbbbbbbbbb/);
  assert.match(text, new RegExp(`Delivery ${KEY}$`));
  assert.deepEqual(jira.issue.properties[jiraDeliveryProperty(KEY)], { delivery: KEY, workId: 'STORY-9', step: 'intake', generation: 1, trigger: 'approved' });

  const calls = jira.calls.length;
  const again = await deliverToJira(record, { env: ENV, fetchImpl: jira.fetchImpl });
  assert.deepEqual([again.outcome, again.detail], ['delivered', 'Already on OPS-12.']);
  assert.equal(jira.issue.comments.length, 1);
  assert.equal(jira.calls.length, calls + 1, 'a delivered record costs one property read');
});

test('a comment that went out before the record was marked is found by its key, and the artifact is attached once', async () => {
  const jira = fakeJira({ failNextPropertyWrite: true });
  const bytes = Buffer.from('# Intake\n\nApproved scope.\n');
  const record = jiraRecord({ send: 'artifact', target: { kind: 'jira' }, artifact: { path: 'singularity/work-items/STORY-9/artifacts/intake/intake.md', sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'text/markdown', base64: bytes.toString('base64') } });
  const first = await deliverToJira(record, { env: ENV, fetchImpl: jira.fetchImpl });
  assert.equal(first.outcome, 'retry', 'the property store failed after the writes');
  assert.equal(first.status, 500);
  assert.equal(jira.issue.comments.length, 1);
  assert.deepEqual(jira.issue.attachments.map((item) => item.filename), [jiraAttachmentName(record)]);
  assert.equal(jiraAttachmentName(record), 'intake-STORY-9-intake-g1-aaaaaaaa.md');

  const second = await deliverToJira(record, { env: ENV, fetchImpl: jira.fetchImpl });
  assert.equal(second.outcome, 'delivered', second.detail);
  assert.equal(jira.issue.comments.length, 1, 'the comment carrying this delivery key is not posted again');
  assert.equal(jira.issue.attachments.length, 1, 'nor the attachment with its name');
  assert.match(commentText(jira.issue.comments[0]), /Attached intake-STORY-9-intake-g1-aaaaaaaa\.md\./);
});

test('a jira delivery says what a person has to do, and retries only what may pass by itself', async () => {
  const jira = fakeJira();
  assert.deepEqual(await deliverToJira(jiraRecord(), { env: {}, fetchImpl: jira.fetchImpl }), {
    outcome: 'unavailable', code: 'STEP_ACTION_JIRA_NOT_CONNECTED',
    detail: 'Jira is not connected on this machine: connect Jira in VS Code, or set JIRA_BASE_URL with JIRA_USERNAME and JIRA_PAT.'
  });
  const unlinked = await deliverToJira(jiraRecord({ jiraKey: null }), { env: ENV, fetchImpl: jira.fetchImpl });
  assert.equal(unlinked.code, 'STEP_ACTION_JIRA_ISSUE_UNKNOWN');
  assert.match(unlinked.detail, /STORY-9 was not started from a Jira issue/);
  assert.equal(jiraIssueFor(jiraRecord({ jiraKey: null, target: { kind: 'jira', issue: 'OPS-12' } })), 'OPS-12', 'a target can name its own issue');

  jira.script([503]);
  assert.equal((await deliverToJira(jiraRecord(), { env: ENV, fetchImpl: jira.fetchImpl })).outcome, 'retry');
  jira.script([401]);
  const refused = await deliverToJira(jiraRecord(), { env: ENV, fetchImpl: jira.fetchImpl });
  assert.deepEqual([refused.outcome, refused.code, refused.status], ['failed', 'STEP_ACTION_JIRA_REFUSED', 401]);

  const stuck = await deliverToJira(jiraRecord({ target: { kind: 'jira', transition: { approved: 'Released' } } }), { env: ENV, fetchImpl: jira.fetchImpl });
  assert.equal(stuck.outcome, 'failed');
  assert.match(stuck.detail, /OPS-12 cannot move to 'Released' now\. Available: Approve → Done\./);

  const missing = await deliverToJira(jiraRecord({ send: 'artifact', target: { kind: 'jira' }, artifact: { path: 'a.md', sha256: null, problem: 'a.md no longer matches the hash the step recorded, so it is not sent.' } }), { env: ENV, fetchImpl: fakeJira().fetchImpl });
  assert.deepEqual([missing.outcome, missing.code], ['failed', 'STEP_ACTION_ARTIFACT_UNAVAILABLE']);

  assert.equal(jiraAttemptResult(Object.assign(new Error('slow'), { category: 'timeout' })).outcome, 'retry');
  assert.equal(jiraAttemptResult(Object.assign(new Error('gone'), { category: 'not-found', status: 404 })).code, 'STEP_ACTION_JIRA_NOT_FOUND');
});

test('the repository\'s Jira policy decides which issues a delivery may write to, and an unreadable policy refuses', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/portfolio.yml'), 'version: 1\njira:\n  enabled: true\n  allowedProjects: [PAY]\n');
  const outside = await deliverToJira(jiraRecord(), { root, env: ENV, fetchImpl: fakeJira().fetchImpl });
  assert.deepEqual([outside.outcome, outside.code], ['failed', 'STEP_ACTION_JIRA_POLICY']);
  assert.match(outside.detail, /OPS is outside the configured allowedProjects/);
  const inside = await deliverToJira(jiraRecord({ target: { kind: 'jira', issue: 'PAY-7' } }), { root, env: ENV, fetchImpl: fakeJira().fetchImpl });
  assert.equal(inside.code, 'STEP_ACTION_JIRA_NOT_FOUND', 'an allowed project goes through to Jira (this fake knows only OPS-12)');

  await writeFile(path.join(root, 'singularity/portfolio.yml'), 'version: 1\njira: [unclosed\n');
  const unreadable = await deliverToJira(jiraRecord(), { root, env: ENV, fetchImpl: fakeJira().fetchImpl });
  assert.deepEqual([unreadable.outcome, unreadable.code], ['failed', 'STEP_ACTION_JIRA_POLICY'], 'a policy that cannot be read is never skipped');
});

test('an artifact action records the approved bytes when the step moves, and the outbox delivers them to Jira', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-jira-outbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const relative = 'singularity/work-items/STORY-9/artifacts/intake/intake.md';
  const bytes = Buffer.from('# Intake\n\n## Acceptance criteria\n\n- A failed charge is retried once.\n');
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), bytes);
  const integrations = normalizeIntegrations({ targets: { 'team-jira': { kind: 'jira', transition: { approved: 'Done' } } } });
  const workflow = (sha256) => ({
    workItem: { id: 'STORY-9', title: 'Checkout retry', branch: 'STORY-9' },
    lineage: { currentJiraKey: 'OPS-12' },
    resolution: { workType: 'feature', phases: [{ id: 'intake', label: 'Intake', afterStep: pinStepActions(normalizeStepActions([{ id: 'tell-jira', on: ['approved'], target: 'team-jira', send: 'artifact' }], integrations, 'intake'), integrations) }] },
    phases: { intake: { status: 'approved', generation: 1, artifacts: [{ path: relative, sha256 }] } }
  });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const event = { type: 'phase-approved', phaseId: 'intake', generation: 1, actor: 'ada', createdAt: '2026-10-03T10:00:00.000Z' };
  const [queued] = await enqueueStepActions(root, workflow(sha256), { event, commit: 'c'.repeat(40) });
  assert.equal(queued.event.story.jiraKey, 'OPS-12', 'the Story\'s issue travels with the event');
  assert.equal(Buffer.from(queued.artifact.base64, 'base64').toString(), bytes.toString());
  assert.equal(queued.artifact.sha256, sha256);

  // Edited after approval: the delivery still sends the approved bytes it sealed.
  await writeFile(path.join(root, relative), '# Edited later\n');
  const jira = fakeJira();
  const report = await deliverStepActions(root, { env: ENV, writers: { jira: (record, context) => deliverToJira(record, { ...context, fetchImpl: jira.fetchImpl }) } });
  assert.equal(report.delivered.length, 1, JSON.stringify(report));
  assert.equal(jira.issue.status, 'Done');
  assert.deepEqual(jira.issue.attachments.map((item) => item.filename), [jiraAttachmentName(queued)]);
  const [listed] = await listStepActionDeliveries(root, {});
  assert.equal(listed.status, 'delivered');
  assert.equal(JSON.stringify(listed).includes(queued.artifact.base64), false, 'a listing never carries the artifact bytes');

  // A hash that no longer matches is never sent.
  const other = { ...event, generation: 2 };
  const changed = workflow('d'.repeat(64)); changed.phases.intake.generation = 2;
  const [mismatched] = await enqueueStepActions(root, changed, { event: other, commit: 'e'.repeat(40) });
  assert.match(mismatched.artifact.problem, /no longer matches the hash the step recorded/);
  assert.equal(mismatched.artifact.base64, undefined);
});

test('jira doctor accepts the credential names the client and VS Code use', () => {
  assert.deepEqual(jiraCredentialSnapshot({ JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_USERNAME: 'a@example.com', JIRA_PAT: 't' }).missing, []);
  assert.deepEqual(jiraCredentialSnapshot({ JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'a@example.com', JIRA_API_TOKEN: 't' }).missing, []);
  assert.deepEqual(jiraCredentialSnapshot({ JIRA_DEPLOYMENT: 'data-center', JIRA_BASE_URL: 'https://jira.example.com', JIRA_PAT: 't' }).missing, []);
  assert.deepEqual(jiraCredentialSnapshot({}).missing, ['JIRA_BASE_URL', 'JIRA_USERNAME or JIRA_EMAIL', 'JIRA_PAT or JIRA_API_TOKEN']);
  assert.equal(jiraCommentText(jiraRecord()).split('\n').at(-1), `Delivery ${KEY}`);
});

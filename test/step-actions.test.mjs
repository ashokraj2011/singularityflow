import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  INTEGRATION_TARGET_KINDS, actionsForTrigger, buildStepActionEvent, normalizeIntegrations, normalizeStepActions,
  pinStepActions, stepActionDeliveryKey, stepActionTriggers
} from '../src/step-actions.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starter = () => YAML.parse(readFileSync(path.join(packageRoot, 'templates', 'workflow.yml'), 'utf8'));
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };

const TARGETS = {
  'team-events': { kind: 'webhook', url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_EVENTS_SIGNING_KEY' },
  'audit-log': { kind: 'http-log', format: 'splunk-hec', url: 'https://logs.example.com/services/collector', tokenSecret: 'SPLUNK_HEC_TOKEN', labels: { service: 'sflow' } },
  teams: { kind: 'teams', urlSecret: 'SINGULARITY_FLOW_TEAMS_WEBHOOK_URL' }
};

test('integration targets are named connections that hold addresses and secret names, never secrets', () => {
  const normalized = normalizeIntegrations({ targets: TARGETS });
  assert.deepEqual(Object.keys(normalized.targets), ['team-events', 'audit-log', 'teams']);
  assert.deepEqual(normalized.targets['team-events'], {
    id: 'team-events', kind: 'webhook', network: 'public', timeoutSeconds: 10,
    url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_EVENTS_SIGNING_KEY'
  });
  assert.equal(normalized.targets['audit-log'].format, 'splunk-hec');
  assert.deepEqual(normalizeIntegrations(normalized), normalized, 'normalizing twice changes nothing');
  assert.deepEqual(normalizeIntegrations(undefined), { targets: {} });
  assert.equal(normalizeIntegrations({ targets: { local: { kind: 'webhook', url: 'http://127.0.0.1:8787/hook' } } }).targets.local.url,
    'http://127.0.0.1:8787/hook', 'plain http is allowed to this machine');

  const refusals = [
    [{ kind: 'webhook', url: 'https://hooks.example.com', token: 'abc' }, 'INTEGRATION_SECRET_INLINE'],
    [{ kind: 'webhook', url: 'https://user:pass@hooks.example.com' }, 'INTEGRATION_SECRET_INLINE'],
    [{ kind: 'webhook', url: 'https://hooks.example.com/x?sig=abc' }, 'INTEGRATION_SECRET_INLINE'],
    [{ kind: 'webhook', url: 'http://hooks.example.com/x' }, 'INTEGRATION_TARGET_URL_INVALID'],
    [{ kind: 'webhook', url: 'https://hooks.example.com/#x' }, 'INTEGRATION_TARGET_URL_INVALID'],
    [{ kind: 'webhook', url: 'https://hooks.example.com', signingSecret: 'lower-case' }, 'INTEGRATION_SECRET_NAME_INVALID'],
    [{ kind: 'webhook', url: 'https://hooks.example.com', retries: 3 }, 'INTEGRATION_TARGET_FIELD_UNKNOWN'],
    [{ kind: 'webhook', url: 'https://hooks.example.com', timeoutSeconds: 60 }, 'INTEGRATION_TARGET_INVALID'],
    [{ kind: 'http-log', url: 'https://logs.example.com', format: 'syslog' }, 'INTEGRATION_TARGET_INVALID'],
    [{ kind: 'teams' }, 'INTEGRATION_TARGET_INVALID'],
    [{ kind: 'teams', urlSecret: 'TEAMS_URL', network: 'private' }, 'INTEGRATION_TARGET_INVALID'],
    [{ kind: 'pager' }, 'INTEGRATION_TARGET_KIND_UNKNOWN']
  ];
  for (const [target, expected] of refusals) {
    assert.equal(code(() => normalizeIntegrations({ targets: { one: target } })), expected, JSON.stringify(target));
  }
  for (const [kind, entry] of Object.entries(INTEGRATION_TARGET_KINDS)) {
    if (entry.available) continue;
    assert.equal(code(() => normalizeIntegrations({ targets: { one: { kind } } })), 'INTEGRATION_TARGET_KIND_UNAVAILABLE',
      `${kind} is refused until this build can deliver to it`);
  }
  assert.equal(code(() => normalizeIntegrations({ targets: { One: TARGETS.teams } })), 'INTEGRATION_TARGET_INVALID');
  assert.equal(code(() => normalizeIntegrations({ hooks: {} })), 'INTEGRATION_TARGET_FIELD_UNKNOWN');
});

test('a step lists actions against declared targets, and each is pinned with its target', () => {
  const integrations = normalizeIntegrations({ targets: TARGETS });
  const actions = normalizeStepActions([
    { id: 'announce', on: ['rejected', 'submitted', 'approved'], target: 'team-events' },
    { id: 'record', on: ['approved'], target: 'audit-log', send: 'summary' }
  ], integrations, "Phase 'requirements'");
  assert.deepEqual(actions[0], { id: 'announce', on: ['submitted', 'approved', 'rejected'], target: 'team-events', send: 'event' },
    'triggers are kept in lifecycle order and the default send is the event');
  const pinned = pinStepActions(actions, integrations);
  assert.equal(pinned[1].targetSpec.tokenSecret, 'SPLUNK_HEC_TOKEN', 'the pinned target names its secret, nothing more');
  pinned[1].targetSpec.url = 'https://changed.example.com';
  assert.equal(integrations.targets['audit-log'].url, 'https://logs.example.com/services/collector', 'pinning copies the target');
  assert.deepEqual(normalizeStepActions(null, integrations, 'x'), []);

  const refusals = [
    [[{ id: 'a', on: ['approved'], target: 'ghost' }], 'STEP_ACTION_TARGET_UNKNOWN'],
    [[{ id: 'a', on: [], target: 'teams' }], 'STEP_ACTION_INVALID'],
    [[{ id: 'a', on: ['merged'], target: 'teams' }], 'STEP_ACTION_INVALID'],
    [[{ id: 'a', on: ['approved', 'approved'], target: 'teams' }], 'STEP_ACTION_INVALID'],
    [[{ id: 'a', on: ['approved'], target: 'teams' }, { id: 'a', on: ['rejected'], target: 'teams' }], 'STEP_ACTION_INVALID'],
    [[{ id: 'a', on: ['approved'], target: 'teams', send: 'artifact' }], 'STEP_ACTION_SEND_UNSUPPORTED'],
    [[{ id: 'a', on: ['approved'], target: 'teams', when: 'always' }], 'STEP_ACTION_FIELD_UNKNOWN'],
    [[{ id: 'A', on: ['approved'], target: 'teams' }], 'STEP_ACTION_INVALID'],
    [{ id: 'a' }, 'STEP_ACTION_INVALID']
  ];
  for (const [raw, expected] of refusals) {
    assert.equal(code(() => normalizeStepActions(raw, integrations, "Phase 'requirements'")), expected, JSON.stringify(raw));
  }
});

test('workflow configuration validates actions on steps and overrides, and a Story resolution pins them', () => {
  // intake is shared by several packaged workflows, so one of them can override its list.
  const definition = starter();
  definition.integrations = { targets: TARGETS };
  definition.phases.intake.afterStep = [{ id: 'announce', on: ['approved'], target: 'team-events' }];
  definition.workTypes.bugfix.phaseOverrides ??= {};
  definition.workTypes.bugfix.phaseOverrides.intake = {
    ...(definition.workTypes.bugfix.phaseOverrides.intake ?? {}),
    afterStep: [{ id: 'record', on: ['approved', 'rejected'], target: 'audit-log' }]
  };
  const validated = validateDefinition(definition);
  const overridden = resolveWorkType(validated, 'bugfix').phases.find((phase) => phase.id === 'intake');
  assert.deepEqual(overridden.afterStep.map((action) => action.id), ['record'], "a workflow's override replaces the step's list");
  assert.equal(overridden.afterStep[0].targetSpec.kind, 'http-log');
  const shared = resolveWorkType(validated, 'feature').phases;
  assert.deepEqual(shared.find((phase) => phase.id === 'intake').afterStep.map((action) => action.id), ['announce']);
  assert.equal(Object.hasOwn(shared.find((phase) => phase.id === 'requirements'), 'afterStep'), false, 'a step without actions keeps its resolved shape');

  for (const [mutate, expected] of [
    [(raw) => { raw.phases.design.afterStep = [{ id: 'x', on: ['approved'], target: 'missing' }]; }, 'STEP_ACTION_TARGET_UNKNOWN'],
    [(raw) => { raw.integrations = { targets: { bad: { kind: 'webhook', url: 'https://x.example.com', password: 'p' } } }; }, 'INTEGRATION_SECRET_INLINE'],
    [(raw) => { raw.workTypes.bugfix.phaseOverrides.intake.afterStep = [{ id: 'x', on: ['done'], target: 'teams' }]; }, 'STEP_ACTION_INVALID']
  ]) {
    const raw = starter();
    raw.integrations = { targets: TARGETS };
    raw.workTypes.bugfix.phaseOverrides ??= {};
    raw.workTypes.bugfix.phaseOverrides.intake ??= {};
    mutate(raw);
    assert.equal(code(() => validateDefinition(raw)), expected);
  }
});

test('triggers follow the step state after the transition, not the event name', () => {
  assert.deepEqual(stepActionTriggers('approval-requested', { status: 'awaiting_approval' }), ['submitted']);
  assert.deepEqual(stepActionTriggers('approval-requested', { status: 'approved' }), ['approved'], 'a submit that approved itself fires approved');
  assert.deepEqual(stepActionTriggers('phase-approved', { status: 'awaiting_approval' }), [], 'a partial approval fires nothing');
  assert.deepEqual(stepActionTriggers('phase-approved', { status: 'approved' }), ['approved']);
  assert.deepEqual(stepActionTriggers('phase-rejected', { status: 'in_progress' }), ['rejected']);
  assert.deepEqual(stepActionTriggers('work-cancelled', { status: 'in_progress' }), []);
  assert.deepEqual(stepActionTriggers('phase-approved', null), []);
  const phase = { afterStep: [{ id: 'a', on: ['approved'] }, { id: 'b', on: ['submitted', 'approved'] }, { id: 'c', on: ['rejected'] }] };
  assert.deepEqual(actionsForTrigger(phase, 'approved').map((action) => action.id), ['a', 'b']);
  assert.deepEqual(actionsForTrigger({}, 'approved'), []);
});

test('a delivery key names one Story, step, generation, trigger and action', () => {
  const base = { workId: 'STORY-1', phaseId: 'requirements', generation: 2, trigger: 'approved', actionId: 'announce' };
  const key = stepActionDeliveryKey(base);
  assert.match(key, /^sad_[0-9a-f]{40}$/);
  assert.equal(stepActionDeliveryKey({ ...base }), key, 'stable');
  for (const change of [{ generation: 3 }, { trigger: 'rejected' }, { actionId: 'record' }, { phaseId: 'design' }, { workId: 'STORY-2' }]) {
    assert.notEqual(stepActionDeliveryKey({ ...base, ...change }), key, JSON.stringify(change));
  }
  assert.throws(() => stepActionDeliveryKey({ ...base, generation: -1 }), /generation/);
  assert.throws(() => stepActionDeliveryKey({ ...base, actionId: '' }), /actionId/);
});

test('the event carries what happened and where it is recorded, and nothing from anyone\'s machine', () => {
  const workflow = {
    workItem: { id: 'STORY-1', title: 'Checkout retry', branch: 'STORY-1' },
    resolution: { workType: 'feature', phases: [{ id: 'requirements', label: 'Requirements' }] },
    phases: {
      requirements: {
        status: 'approved', generation: 2,
        artifacts: [
          { path: 'singularity/work-items/STORY-1/artifacts/requirements.md', sha256: 'a'.repeat(64) },
          { path: '/Users/someone/elsewhere.md', sha256: 'b'.repeat(64) },
          { path: '../outside.md', sha256: 'c'.repeat(64) }
        ]
      }
    }
  };
  const action = { id: 'announce', target: 'team-events', send: 'event', targetSpec: { signingSecret: 'SFLOW_EVENTS_SIGNING_KEY' } };
  const event = buildStepActionEvent({
    workflow, phaseId: 'requirements', trigger: 'approved', action, deliveryKey: 'sad_x',
    event: { actor: 'Ada <ada@example.com>', createdAt: '2026-10-03T10:00:00.000Z' }, commit: 'f'.repeat(40), remote: 'https://github.com/acme/app.git'
  });
  assert.equal(event.schema, 'sflow-step-action@1');
  assert.deepEqual(event.delivery, { key: 'sad_x', action: 'announce', target: 'team-events', trigger: 'approved', send: 'event' });
  assert.deepEqual(event.story, { id: 'STORY-1', title: 'Checkout retry', workflow: 'feature', branch: 'STORY-1' });
  assert.deepEqual(event.step, { id: 'requirements', label: 'Requirements', generation: 2, status: 'approved' });
  assert.deepEqual(event.artifacts.map((artifact) => artifact.path), ['singularity/work-items/STORY-1/artifacts/requirements.md'],
    'machine paths and paths outside the repository are never sent');
  assert.equal(JSON.stringify(event).includes('SFLOW_EVENTS_SIGNING_KEY'), false, 'not even the name of a secret');
  assert.equal(event.commit.sha, 'f'.repeat(40));
});

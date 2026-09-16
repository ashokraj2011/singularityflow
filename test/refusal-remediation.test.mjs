import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  refusalEnvelope, refusalRemediationPlan, renderRefusalPlan
} from '../src/refusal-remediation.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

test('an Auto policy refusal gives a capability-aware bounded plan without executing it', () => {
  const error = Object.assign(new Error('Auto mode is disabled by repository policy.'), {
    code: 'AUTO_DISABLED'
  });
  const plan = refusalRemediationPlan(error, [
    'auto', 'plan', 'add sin operator', '--capability', 'rule-engine'
  ]);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps.every((entry) => entry.execution === 'user-reviewed'));
  assert.equal(plan.retry.automatic, false);
  assert.match(plan.steps[0].label, /Configuration Center → Auto mode/);
  assert.deepEqual(plan.steps.map((entry) => entry.command), [
    'singularity-flow explain auto-mode',
    'singularity-flow configuration explain --pointer /auto --json',
    'singularity-flow capability show rule-engine --verbose --json'
  ]);
  assert.deepEqual(plan.steps.map((entry) => entry.skill), [
    '/sf-docs', '/sf-configuration', '/sf-capabilities'
  ]);
  assert.deepEqual(plan.steps.map((entry) => entry.copilotCommand), [
    '/sf-docs', '/sf-configuration', '/sf-capabilities'
  ]);
  const rendered = renderRefusalPlan(plan);
  assert.match(rendered, /Recovery plan:/);
  assert.match(rendered, /Shell: singularity-flow explain auto-mode/);
  assert.match(rendered, /Copilot: \/sf-docs/);
});

test('producer recovery guidance is accepted only as a bounded credential-free SFlow command', () => {
  const accepted = refusalRemediationPlan(Object.assign(new Error('blocked'), {
    details: { diagnosticAction: { command: 'singularity-flow workspace doctor --network --json' } }
  }), ['workspace']);
  assert.equal(accepted.steps[0].command, 'singularity-flow workspace doctor --network --json');

  const rejected = refusalRemediationPlan(Object.assign(new Error('blocked'), {
    details: { diagnosticAction: { command: 'singularity-flow retry --token office-secret' } }
  }), ['workspace']);
  assert.doesNotMatch(JSON.stringify(rejected), /office-secret/);
  assert.ok(rejected.steps.length <= 3);
});

test('the public CLI turns an otherwise plain refusal into one parseable recovery envelope', () => {
  const result = spawnSync(process.execPath, [cli, 'definitely-not-a-command', '--json'], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.resultType, 'sflow-refusal-plan');
  assert.equal(envelope.error.code, 'UNKNOWN_COMMAND');
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  assert.deepEqual(envelope.remediationPlan.steps.slice(0, 2).map((entry) => entry.command), [
    'singularity-flow --help', 'singularity-flow quickstart'
  ]);
});

test('the refusal envelope pairs every bounded transport diagnostic with a Copilot command', () => {
  const diagnosticAction = { command: 'singularity-flow workspace doctor --network --json' };
  const remoteFailure = { classification: 'authentication', retryable: true };
  const envelope = refusalEnvelope(Object.assign(new Error('Git access failed.'), {
    code: 'REMOTE_AUTHENTICATION', details: { diagnosticAction, remoteFailure }
  }), ['capability', 'proposals']);
  assert.equal(envelope.error.diagnosticAction.command, diagnosticAction.command);
  assert.equal(envelope.error.diagnosticAction.executable, 'singularity-flow');
  assert.deepEqual(envelope.error.diagnosticAction.argv,
    ['workspace', 'doctor', '--network', '--json']);
  assert.equal(envelope.error.diagnosticAction.skill, '/sf-workspace-bootstrap');
  assert.equal(envelope.error.diagnosticAction.copilotCommand, '/sf-workspace-bootstrap');
  assert.deepEqual(envelope.error.remoteFailure, remoteFailure);
  assert.equal(envelope.remediationPlan.steps[0].command, diagnosticAction.command);
});

test('the refusal envelope preserves a safe full Copilot relay and drops unsafe diagnostics', () => {
  const relayed = refusalEnvelope(Object.assign(new Error('SGOS check failed.'), {
    details: { diagnosticAction: {
      command: 'singularity-flow process inspect process.json --json',
      copilotCommand: '/sf-sgos process inspect process.json --json'
    } }
  }), ['process']);
  assert.equal(relayed.error.diagnosticAction.skill, '/sf-sgos');
  assert.equal(relayed.error.diagnosticAction.copilotCommand,
    '/sf-sgos process inspect process.json --json');

  const unsafe = refusalEnvelope(Object.assign(new Error('Blocked.'), {
    details: { diagnosticAction: {
      command: 'singularity-flow retry --token office-secret'
    } }
  }), ['retry']);
  assert.equal(unsafe.error.diagnosticAction, undefined);
  assert.doesNotMatch(JSON.stringify(unsafe), /office-secret/);
});

test('the refusal envelope rejects unknown, hostile, and crosswalk-mismatched diagnostics', () => {
  for (const diagnosticAction of [
    { command: 'singularity-flow definitely-unknown --json' },
    { command: 'singularity-flow status --json; touch escaped' },
    { command: 'singularity-flow status --json', skill: '/sf-docs' },
    { command: 'singularity-flow status --json', copilotCommand: '/sf-docs' },
    { command: 'singularity-flow status --json', skill: '/sf-does-not-exist' }
  ]) {
    const envelope = refusalEnvelope(Object.assign(new Error('Blocked.'), {
      details: { diagnosticAction }
    }), ['status']);
    assert.equal(envelope.error.diagnosticAction, undefined, JSON.stringify(diagnosticAction));
  }
});

test('the refusal envelope derives missing routes and preserves valid Auto relays', () => {
  const derived = refusalEnvelope(Object.assign(new Error('Blocked.'), {
    details: { diagnosticAction: { command: 'singularity-flow status --json' } }
  }), ['status']);
  assert.equal(derived.error.diagnosticAction.command, 'singularity-flow status --json');
  assert.deepEqual(derived.error.diagnosticAction.argv, ['status', '--json']);
  assert.equal(derived.error.diagnosticAction.skill, '/sf-status');
  assert.equal(derived.error.diagnosticAction.copilotCommand, '/sf-status');

  const auto = refusalEnvelope(Object.assign(new Error('Paused.'), {
    details: { diagnosticAction: {
      command: 'singularity-flow auto pause AFL-1 --json',
      skill: '/sf-auto',
      copilotCommand: '/sf-auto pause AFL-1 --json'
    } }
  }), ['auto']);
  assert.equal(auto.error.diagnosticAction.command,
    'singularity-flow auto pause AFL-1 --json');
  assert.deepEqual(auto.error.diagnosticAction.argv,
    ['auto', 'pause', 'AFL-1', '--json']);
  assert.equal(auto.error.diagnosticAction.skill, '/sf-auto');
  assert.equal(auto.error.diagnosticAction.copilotCommand,
    '/sf-auto pause AFL-1 --json');
});

test('FOS:AC-044 FOS refusals provide bounded real commands without executing recovery', () => {
  const cases = new Map([
    ['AUTHORITY_ROUTE_AMBIGUOUS', 'singularity-flow onboard <LOCAL-PATH> --remote <NAME>'],
    ['AUTHORITY_REBIND_REQUIRED', 'singularity-flow explain fast-onboarding'],
    ['AUTHORITY_PIN_INVALID', 'singularity-flow doctor --json'],
    ['FOS_CACHE_PATH_INVALID', 'singularity-flow doctor --json'],
    ['OBJECT_SERVICE_UNAVAILABLE', 'singularity-flow doctor --git-speed --json'],
    ['WORK_PRESERVATION_FAILED', 'singularity-flow workspace list --json']
  ]);
  for (const [code, command] of cases) {
    const plan = refusalRemediationPlan(Object.assign(new Error('hostile path /tmp/a b/δ'), { code }), ['onboard']);
    assert.equal(plan.steps[0].command, command, code);
    assert.equal(plan.steps[0].execution, 'user-reviewed', code);
    assert.equal(plan.retry.automatic, false, code);
    assert.doesNotMatch(JSON.stringify(plan), /Error:|\n\s+at /, code);
  }
});

test('an agent that names a missing phase points capability users to configuration recovery, not command help', () => {
  const error = Object.assign(
    new Error("Agent 'poc-analyst' references unknown phase 'poc-intake'."),
    {
      code: 'AGENT_PHASE_UNKNOWN',
      details: {
        agentId: 'poc-analyst',
        phaseId: 'poc-intake',
        source: '.github/agents/poc-analyst.agent.md'
      }
    }
  );
  const plan = refusalRemediationPlan(error, ['capability', 'tree', '--json']);

  assert.deepEqual(plan.steps.map((entry) => entry.command), [
    'singularity-flow workspace refresh-configuration --dry-run',
    'singularity-flow factory-reset --dry-run --json',
    'singularity-flow init --check --json'
  ]);
  assert.doesNotMatch(JSON.stringify(plan), /singularity-flow capability --help/);
  assert.match(plan.steps[0].label, /Repair missing or outdated agents/);
  assert.match(plan.steps[1].label, /old Singularity Flow data may be discarded/);
  assert.ok(plan.steps.every((entry) => entry.execution === 'user-reviewed'));
  assert.equal(plan.retry.automatic, false);
});

test('an imported capability-map bootstrap refusal preserves the map and gives the reviewed next action', () => {
  const plan = refusalRemediationPlan(Object.assign(
    new Error("The imported capability map does not define requested capability 'payments'."),
    { code: 'CONFIGURATION_BOOTSTRAP_CAPABILITY_REVIEW_REQUIRED' }
  ), ['bootstrap']);

  assert.equal(plan.steps[0].command,
    'singularity-flow capability map <CAPABILITY-ID> --lead <LEAD-URL> --json');
  assert.equal(plan.steps[0].execution, 'user-reviewed');
  assert.equal(plan.retry.automatic, false);
});

test('off-mode clarification refusal gives a read-only check and the legal phase continuation', () => {
  const error = Object.assign(new Error("Phase 'planning' has clarification mode off."), {
    code: 'CLARIFICATION_MODE_OFF',
    details: {
      phase: 'planning',
      mode: 'off',
      nextAction: {
        command: 'singularity-flow clarification status planning --json',
        kind: 'diagnostic'
      },
      remediation: { action: 'continue-without-clarification' }
    }
  });
  const envelope = refusalEnvelope(error, ['clarification', 'record', 'planning', '--json']);

  assert.equal(envelope.error.code, 'CLARIFICATION_MODE_OFF');
  assert.deepEqual(envelope.remediationPlan.steps.slice(0, 2).map((entry) => entry.command), [
    'singularity-flow clarification status planning --json',
    'singularity-flow prepare planning'
  ]);
  assert.match(envelope.remediationPlan.steps[1].label, /Skip clarification questions and recording/);
  assert.ok(envelope.remediationPlan.steps.every((entry) => entry.execution === 'user-reviewed'));
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  assert.match(envelope.remediationPlan.retry.label, /Do not retry clarification recording/);
});

test('code-delivery configuration refusals keep protected workflow changes outside the Story', () => {
  const missing = refusalRemediationPlan(Object.assign(
    new Error('No structured test command was found.'),
    { code: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED', details: { phase: 'implementation' } }
  ), ['phase', 'publish', 'implementation']);
  assert.equal(missing.steps[0].command,
    'singularity-flow workflow validate --json');
  assert.match(missing.steps[0].label, /Do not add a test wrapper or edit protected workflow files/);

  const protectedPath = refusalRemediationPlan(Object.assign(
    new Error('Generation cannot modify protected process paths.'),
    {
      code: 'CHANGE_SET_POLICY_VIOLATION',
      details: {
        violationKind: 'protected-process-path',
        diagnosticAction: {
          command: 'singularity-flow recover FILTER-APP --phase implementation --json'
        }
      }
    }
  ), ['phase', 'publish', 'implementation']);
  assert.deepEqual(protectedPath.steps.slice(0, 3).map((entry) => entry.command), [
    'singularity-flow recover FILTER-APP --phase implementation --json',
    'singularity-flow explain workflow-authoring',
    'singularity-flow configuration validate --json'
  ]);
  assert.match(protectedPath.steps[1].label, /Restore every listed protected path/);
  assert.ok(protectedPath.steps.every((entry) => entry.execution === 'user-reviewed'));
});

test('incomplete authoring refusals lead with a read-only draft check and bounded correction guidance', () => {
  const error = Object.assign(new Error("Phase planning contains unresolved placeholder 'TODO'."), {
    code: 'ARTIFACT_AUTHORING_INCOMPLETE',
    details: {
      phase: 'planning',
      diagnosticAction: { command: 'singularity-flow doctor --json' }
    }
  });
  const plan = refusalRemediationPlan(error, ['phase', 'publish', 'planning', '--json']);

  assert.equal(plan.steps[0].id, 'inspect-authored-draft');
  assert.equal(plan.steps[0].command, 'singularity-flow phase draft-check planning --json');
  assert.deepEqual(plan.steps[0].argv, ['phase', 'draft-check', 'planning', '--json']);
  assert.equal(plan.steps[0].kind, 'diagnostic');
  assert.equal(plan.steps[0].skill, '/sf-phase');
  assert.equal(plan.steps[0].copyable, true);
  assert.match(plan.steps[0].label, /without changing repository or lifecycle state/);
  assert.equal(plan.steps[1].id, 'correct-authored-draft');
  assert.equal(plan.steps[1].command, null);
  assert.match(plan.steps[1].label, /correct every reported finding/);
  assert.match(plan.steps[1].label, /Do not .*invoke another model, publish, submit, or approve/);
  assert.ok(plan.steps.every((entry) => entry.execution === 'user-reviewed'));
  assert.equal(plan.retry.automatic, false);
  assert.match(plan.retry.label, /draft check reports ready/);
  assert.equal(plan.steps[2].command, 'singularity-flow doctor --json');
});

test('incomplete code authoring preserves the engine-selected code correction route', () => {
  const error = Object.assign(new Error("Phase implementation contains unresolved placeholder 'TODO'."), {
    code: 'ARTIFACT_AUTHORING_INCOMPLETE',
    details: {
      phase: 'implementation',
      retry: { skill: '/sf-code', maximumAttempts: 1, requiresFingerprintChange: true }
    }
  });
  const plan = refusalRemediationPlan(error, ['phase', 'publish', 'implementation', '--json']);
  assert.equal(plan.steps[0].command,
    'singularity-flow phase draft-check implementation --json');
  assert.equal(plan.steps[0].skill, '/sf-code');
  assert.equal(plan.steps[0].copilotCommand, '/sf-code');
});

test('incomplete authoring remediation derives a safe phase from lifecycle argv forms', () => {
  const forms = [
    [['phase', 'publish', 'implementation'], 'implementation'],
    [['phase', 'approve', 'verification'], 'verification'],
    [['phase', 'submit', 'convergence'], 'convergence'],
    [['approve', 'release'], 'release'],
    [['submit', '--phase', 'specification'], 'specification']
  ];
  for (const [argv, phase] of forms) {
    const plan = refusalRemediationPlan(Object.assign(new Error('Draft is incomplete.'), {
      code: 'ARTIFACT_AUTHORING_INCOMPLETE'
    }), argv);
    assert.equal(plan.steps[0].command,
      `singularity-flow phase draft-check ${phase} --json`, argv.join(' '));
    assert.equal(plan.steps[0].copyable, true, argv.join(' '));
  }
});

test('incomplete authoring remediation rejects unsafe phase metadata and preserves generic fallback', () => {
  const plan = refusalRemediationPlan(Object.assign(new Error('Draft is incomplete.'), {
    code: 'ARTIFACT_AUTHORING_INCOMPLETE',
    details: { phase: 'planning; publish release' }
  }), ['phase', 'publish']);

  assert.equal(plan.steps[0].command, 'singularity-flow phase --help');
  assert.equal(plan.steps[1].command, 'singularity-flow doctor --json');
  assert.equal(plan.steps[2].command, 'singularity-flow recommend --json');
  assert.doesNotMatch(JSON.stringify(plan), /planning; publish release|draft-check/);
  assert.equal(plan.retry.automatic, false);
});

test('initiative authoring refusals route to the initiative draft check', () => {
  const error = Object.assign(new Error('Initiative output is incomplete.'), {
    code: 'ARTIFACT_AUTHORING_INCOMPLETE',
    details: { subjectKind: 'initiative', initiativeId: 'INIT-1', phase: 'epic-planning' }
  });
  const plan = refusalRemediationPlan(error, ['initiative', 'phase', 'publish', 'epic-planning']);
  assert.equal(plan.steps[0].command,
    'singularity-flow initiative phase draft-check epic-planning --json');
  assert.deepEqual(plan.steps[0].argv,
    ['initiative', 'phase', 'draft-check', 'epic-planning', '--json']);
});

test('FOS:AC-033 recovery remains registered and shell-safe on macOS Linux and Windows with hostile context', () => {
  const secret = 'https://person:office-secret@example.test/repo.git';
  const error = Object.assign(new Error(`hostile path /tmp/a b/δ; touch escaped ${secret}`), {
    code: 'AUTHORITY_PIN_INVALID',
    details: {
      diagnosticAction: { command: 'singularity-flow doctor --json; touch escaped' },
      recoveryCommand: 'singularity-flow doctor --json'
    }
  });
  const envelope = refusalEnvelope(error, ['onboard']);
  const plan = envelope.remediationPlan;
  assert.equal(plan.retry.automatic, false);
  assert.ok(plan.steps.length > 0 && plan.steps.length <= 3);
  assert.ok(plan.steps.every((step) => step.execution === 'user-reviewed'));
  assert.ok(plan.steps.every((step) => /^singularity-flow [a-z][a-z0-9-]*(?: |$)/.test(step.command)));
  assert.ok(plan.steps.every((step) => Array.isArray(step.argv)));
  for (const step of plan.steps.filter((entry) => entry.copyable)) {
    assert.deepEqual(Object.keys(step.platformCommands), ['darwin', 'linux', 'win32']);
    assert.match(step.platformCommands.darwin, /^'singularity-flow'/);
    assert.match(step.platformCommands.linux, /^'singularity-flow'/);
    assert.match(step.platformCommands.win32, /^& 'singularity-flow'/);
    assert.doesNotMatch(JSON.stringify(step.platformCommands), /touch escaped|office-secret/);
  }
  assert.doesNotMatch(JSON.stringify(envelope), /office-secret|\n\s+at /);
  assert.match(envelope.error.message, /REDACTED/);
});

test('every published executable routes its own refusal through the shared planner', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const executables = [...new Set(Object.values(manifest.bin))];
  for (const relative of executables) {
    const source = await readFile(path.resolve(relative), 'utf8');
    assert.match(source, /reportCliFailure/, relative);
  }
});

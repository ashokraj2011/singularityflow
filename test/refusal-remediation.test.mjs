import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  refusalEnvelope, refusalRemediationPlan, renderRefusalPlan
} from '../src/refusal-remediation.mjs';
import { structuredTestCommandRequiredError } from '../src/code-delivery-tests.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

test('unavailable-runner refusal names exact risk inspection without accepting or retrying it', () => {
  const error = Object.assign(new Error('Required runner unavailable'), { code: 'TRP_PHASE_GATE_BLOCKED',
    details: { workId: 'Story-1', phase: 'implementation', operation: 'submit' } });
  const plan = refusalRemediationPlan(error, ['submit', 'implementation']);
  const inspection = plan.steps.find(item => item.id === 'inspect-exact-phase-risks');
  assert.equal(inspection.command, 'singularity-flow story test-policy risks --work-id Story-1 --phase implementation --operation submit --json');
  assert.equal(inspection.execution, 'user-reviewed');
  assert.equal(plan.retry.automatic, false);
  assert.doesNotMatch(JSON.stringify(plan.steps), /accept-risk|--apply|--skip/u);
  const hostile = refusalRemediationPlan(Object.assign(new Error('Unavailable'), { code: error.code,
    details: { workId: 'a;sh', phase: '--unsafe', operation: 'publish;sh' } }), ['phase', 'publish', 'implementation']);
  assert.doesNotMatch(JSON.stringify(hostile.steps), /a;sh|--unsafe|publish;sh/u);
});

test('pending risk publication and unsupported adapters preserve exact recovery boundaries', () => {
  const pending = refusalRemediationPlan(Object.assign(new Error('Pending'), { code: 'TRP_PUBLICATION_PENDING' }), ['story', 'test-policy', 'accept-risk']);
  assert.equal(pending.steps[0].command, 'singularity-flow recover --json');
  assert.match(pending.steps[0].label, /existing pending/u);
  const unsupported = refusalRemediationPlan(Object.assign(new Error('Unsupported'), { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' }), ['phase', 'publish', 'implementation']);
  assert.match(unsupported.steps[0].label, /do not reinterpret a failed test as unavailable/u);
  assert.equal(unsupported.steps[0].command, 'singularity-flow explain test-recovery');
});

test('approval-stage risk refusal preserves the exact inspection and ends approval without a retry loop', () => {
  const error = Object.assign(new Error('Approval requires its own risk decision'), { code: 'TRP_PHASE_GATE_BLOCKED',
    details: { workId: 'Story-1', phase: 'implementation', operation: 'approve' } });
  const plan = refusalRemediationPlan(error, ['approve', 'implementation']);
  assert.equal(plan.steps[0].id, 'inspect-exact-phase-risks');
  assert.match(plan.steps[0].command, /--operation approve --json$/u);
  assert.ok(plan.steps.some(step => step.id === 'leave-approval-turn'));
  assert.equal(plan.retry.automatic, false);
  assert.equal(plan.retry.command, null);
  assert.match(plan.retry.label, /normal phase approval stays separate/u);
  assert.doesNotMatch(JSON.stringify(plan.steps), /accept-risk|--apply|--skip/u);
});

test('skill-host refusal distinguishes an external prerequisite from repairable Story content', () => {
  for (const code of ['SKP_HOST_ENFORCEMENT_UNAVAILABLE', 'SKP_HOST_DELIVERY_UNCONFIRMED']) {
    const error = Object.assign(new Error('Host unavailable'), { code,
      details: { skillId: 'notes-writer', workId: 'team-notes', phase: 'write-note',
        retry: { command: 'singularity-flow phase publish write-note' } } });
    const plan = refusalRemediationPlan(error, ['phase', 'publish', 'write-note']);
    assert.equal(plan.context.strategy, 'external-host-prerequisite');
    assert.equal(plan.steps[0].command,
      'singularity-flow skill doctor notes-writer --story team-notes --phase write-note --json');
    assert.deepEqual(plan.steps[0].argv, ['skill', 'doctor', 'notes-writer', '--story', 'team-notes', '--phase', 'write-note', '--json']);
    assert.equal(plan.steps[0].copilotCommand, '/sf-skill');
    assert.equal(plan.steps[1].kind, 'external-prerequisite');
    assert.equal(plan.steps[1].command, null);
    assert.equal(plan.retry.automatic, false); assert.equal(plan.retry.command, null);
    assert.match(plan.retry.label, /Diagnostics cannot enable execution/u);
    const rendered = renderRefusalPlan(plan);
    assert.match(rendered, /Shell: singularity-flow skill doctor/u);
    assert.match(rendered, /Copilot: \/sf-skill/u);
    assert.doesNotMatch(rendered, /repair in place|singularity-flow recover|phase publish/u);
  }
});

test('skill-host approval and invalid selectors cannot suggest evidence edits, approval retries or injected commands', () => {
  const error = Object.assign(new Error('Host unavailable'), { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE',
    details: { skillId: 'notes-writer;evil', workId: 'team-notes', phase: 'write-note',
      diagnosticAction: { command: 'singularity-flow phase publish write-note' } } });
  const plan = refusalRemediationPlan(error, ['approve', 'write-note']);
  assert.equal(plan.steps[0].command, 'singularity-flow skill --help');
  assert.equal(plan.steps.length, 3); assert.match(plan.steps[2].label, /End this approval-only turn/u);
  assert.equal(plan.retry.command, null);
  assert.doesNotMatch(JSON.stringify(plan), /evil|phase publish|sf-reject|singularity-flow recover/u);
});

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

test('an unreadable enterprise Git snapshot never advises a blind credential reset', () => {
  const error = Object.assign(new Error('Git configuration snapshot unavailable.'), {
    code: 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE',
    details: { scope: 'global', reason: 'timeout' }
  });
  const plan = refusalRemediationPlan(error, ['capability', 'map']);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.steps[0].command,
    'singularity-flow workspace doctor --network --json');
  assert.match(plan.steps[0].label, /did not probe the remote/);
  assert.match(plan.steps[1].label, /do not put credentials/);
  assert.equal(plan.retry.automatic, false);
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
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.resultType, 'sflow-refusal-plan');
  assert.equal(envelope.error.code, 'UNKNOWN_COMMAND');
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  assert.deepEqual(envelope.remediationPlan.steps.slice(0, 2).map((entry) => entry.command), [
    'singularity-flow --help', 'singularity-flow quickstart'
  ]);
});

test('capability and workspace entry-point refusals remain structured with --json', () => {
  for (const args of [
    ['capability', 'map'],
    ['capability', 'activate'],
    ['workspace', 'create', '--local'],
    ['workspace', 'status'],
    ['workspace', 'repair']
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0, `${args.join(' ')} must refuse without required inputs`);
    assert.equal(result.stderr, '', `${args.join(' ')} must keep the JSON refusal on stdout`);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.resultType, 'sflow-refusal-plan', args.join(' '));
    assert.equal(refusal.status, 'failed', args.join(' '));
    assert.ok(refusal.error.code, `${args.join(' ')} must identify its refusal`);
    assert.ok(Array.isArray(refusal.remediationPlan.steps), args.join(' '));
  }
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

test('required test refusals relay bounded execution evidence without exposing configured argv', () => {
  const execution = {
    commandId: 'fixture-tests', argv: ['node', 'test-runner.mjs', 'unknown-positional-secret'],
    provenance: 'configured', cwd: '/repo', workingDirectory: '.', exitCode: 23, status: 'failed',
    resultPath: '/repo/.sflow/results/unit.json', configuredResultPath: '.sflow/results/unit.json',
    resultAdapter: 'sflow-test-result-v1',
    stdout: { text: `token=office-secret ${'x'.repeat(5000)}`, bytes: 5020, truncated: true },
    stderr: { text: 'test failed', bytes: 11, truncated: false }
  };
  const configured = refusalEnvelope(Object.assign(new Error('Required test failed.'), {
    code: 'CODE_TEST_FAILED', details: { requiredTestExecution: execution }
  }), ['phase', 'publish', 'implementation', '--json']);
  const relayed = configured.error.requiredTestExecution;
  assert.equal(configured.error.code, 'CODE_TEST_FAILED');
  assert.equal(relayed.argv, null);
  assert.equal(relayed.argvWithheld, true);
  assert.equal(relayed.cwd, '/repo');
  assert.equal(relayed.resultPath, '/repo/.sflow/results/unit.json');
  assert.equal(relayed.exitCode, 23);
  assert.ok(relayed.stdout.text.length <= 2012);
  assert.equal(relayed.stdout.truncated, true);
  assert.doesNotMatch(JSON.stringify(configured), /office-secret|unknown-positional-secret/u);

  const inferred = refusalEnvelope(Object.assign(new Error('Required test failed.'), {
    code: 'CODE_TEST_FAILED', details: { requiredTestExecution: {
      ...execution, provenance: 'inferred', argv: ['mvn', 'test'],
      stdout: { text: 'build failed', bytes: 12, truncated: false }
    } }
  }), ['phase', 'publish', 'implementation', '--json']);
  assert.deepEqual(inferred.error.requiredTestExecution.argv, ['mvn', 'test']);
  assert.equal(inferred.error.requiredTestExecution.argvWithheld, false);
  assert.equal(inferred.error.requiredTestExecution.stdout.text, 'build failed');
});

test('failed-test refusal points to saved diagnostics and permits same source only after runtime repair', () => {
  const error = Object.assign(new Error('Required tests failed'), {
    code: 'CODE_TEST_FAILED', details: { phase: 'implementation', workId: 'STORY-1',
      requiredTestExecution: {
        commandId: 'unit', provenance: 'configured', argv: ['pytest', '--token', 'private-argv'],
        cwd: '/repo', resultPath: '/repo/report.xml', status: 'blocked',
        stderr: { text: 'No module named pytest' }, stdout: { text: '' },
        failure: { kind: 'missing-dependency' },
        report: { status: 'unavailable', reason: 'No report was written.' }
      },
      arbitrary: 'private-details'
    }
  });
  const envelope = refusalEnvelope(error, ['phase', 'publish', 'implementation', '--json']);
  const plan = envelope.remediationPlan;
  assert.equal(plan.steps[0].command, 'singularity-flow recover STORY-1 --phase implementation --json');
  assert.equal(plan.steps[1].command, 'singularity-flow logs --level error --tail 20');
  assert.match(plan.steps[2].label, /Install the repository-declared test dependencies/u);
  assert.match(plan.retry.label, /same source may then be rechecked/u);
  assert.equal(plan.retry.automatic, false);
  assert.equal(envelope.error.requiredTestExecution.report.gateEligible, false);
  assert.equal(envelope.error.requiredTestExecution.failure.retryCondition, 'runtime-changed');
  assert.doesNotMatch(JSON.stringify(envelope), /private-/u);

  const approvalPlan = refusalRemediationPlan(error, ['approve', 'implementation', '--json']);
  assert.match(approvalPlan.retry.label, /Do not retry approval in this turn/u);
  assert.equal(approvalPlan.context.turn, 'new-turn');
});

test('source mutation diagnostic is projected and never presented as passing evidence', () => {
  const error = Object.assign(new Error('Source changed'), {
    code: 'QUALITY_COMMAND_SOURCE_MUTATION', details: { phase: 'implementation',
      requiredTestExecution: { commandId: 'unit', provenance: 'configured',
        argv: ['private-argv'], cwd: '/repo', resultPath: '/repo/report.xml',
        stdout: { text: 'changed source' }, stderr: { text: 'mutation' },
        report: { status: 'observed', tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 } },
        failure: { kind: 'source-mutation' } }
    }
  });
  const envelope = refusalEnvelope(error, ['phase', 'submit', 'implementation', '--json']);
  assert.equal(envelope.error.requiredTestExecution.failure.kind, 'source-mutation');
  assert.equal(envelope.error.requiredTestExecution.report.gateEligible, false);
  assert.match(envelope.remediationPlan.steps[2].label, /Review the exact source or test changes/u);
  assert.doesNotMatch(JSON.stringify(envelope), /private-argv/u);
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

test('an incomplete Story configuration authority exposes the reviewed seeded repair on both surfaces', () => {
  const error = Object.assign(new Error('Approved configuration is incomplete.'), {
    code: 'STORY_CONFIGURATION_WORKFLOW_MISSING',
    details: {
      recoveryCommand: {
        command: 'singularity-flow workspace reinitialize --dry-run --json',
        skill: '/sf-admin'
      }
    }
  });
  const envelope = refusalEnvelope(error, ['workspace', 'branches', '--json', '--intake']);
  assert.equal(envelope.error.code, 'STORY_CONFIGURATION_WORKFLOW_MISSING');
  assert.equal(envelope.remediationPlan.steps[0].command,
    'singularity-flow workspace reinitialize --dry-run --json');
  assert.equal(envelope.remediationPlan.steps[0].copilotCommand, '/sf-admin');
  assert.deepEqual(envelope.remediationPlan.steps[0].argv,
    ['workspace', 'reinitialize', '--dry-run', '--json']);
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
    'singularity-flow phase show implementation --json');
  assert.equal(missing.steps[0].skill, '/sf-code');
  assert.equal(missing.steps[1].command, null);
  assert.match(missing.steps[1].label, /in-scope test script or runner declaration/);
  assert.match(missing.steps[1].label, /story test-policy amend --reason TEXT/);
  assert.match(missing.steps[1].label, /refresh alone does not change its pin/);
  assert.equal(missing.steps[2].command,
    'singularity-flow phase prepublish implementation --json');
  assert.match(missing.retry.label, /in-scope repository runner repair/);
  assert.equal(missing.retry.command, null);
  assert.doesNotMatch(JSON.stringify(missing), /workflow validate|refresh it, then resume this same phase|phase publish implementation/);

  const malformed = refusalRemediationPlan(Object.assign(
    new Error('Configured structured test command is malformed.'),
    { code: 'CODE_TEST_RESULT_REQUIRED', details: {
      phase: 'implementation', configurationDependency: true
    } }
  ), ['phase', 'publish', 'implementation']);
  assert.equal(malformed.context.strategy, 'pinned-test-policy-prerequisite');
  assert.equal(malformed.steps[0].command, 'singularity-flow recover --json');
  assert.equal(malformed.steps[1].command, 'singularity-flow explain test-recovery');
  assert.match(malformed.steps[1].label, /active published phase retains its publication/);
  assert.match(malformed.steps[1].label, /story test-policy amend --reason TEXT/);
  assert.match(malformed.steps[1].label, /Completed Stories, legacy string runners and unrelated policy changes are not supported/);
  assert.equal(malformed.retry.command, null);

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

test('missing inferred runner explains reviewed existing-Story adoption without claiming automatic migration', () => {
  const error = structuredTestCommandRequiredError({ id: 'implementation' });
  assert.equal(error.code, 'CODE_DELIVERY_TEST_COMMAND_REQUIRED');
  assert.equal(error.details.remediation.action, 'repair-in-scope-repository-runner-or-review-test-command-amendment');
  assert.match(error.message, /eligible current Story.*story test-policy amend.*live human review/);
  assert.match(error.message, /refresh alone does not change its pin/);
  assert.match(error.message, /Do not edit protected workflow configuration/);
});

test('amended epoch refusal preserves publication and separates fresh validation from old approval', () => {
  const plan = refusalRemediationPlan(Object.assign(new Error('Epoch validation required.'), {
    code: 'TCA_EPOCH_VALIDATION_REQUIRED', details: { phase: 'implementation' }
  }), ['submit', 'implementation', '--json']);
  assert.equal(plan.steps[0].command, 'singularity-flow phase show implementation --json');
  assert.match(plan.steps[0].label, /old publication is preserved/);
  assert.match(plan.steps[0].label, /submit again to run fresh tests/);
  assert.match(plan.steps[0].label, /do not republish unchanged code or reuse the old approval packet/);
  assert.equal(plan.steps[1].command, 'singularity-flow explain test-recovery');
  assert.equal(plan.retry.automatic, false);
  assert.ok(plan.steps.slice(0, 2).every(entry => entry.kind === 'diagnostic'));
  assert.equal(plan.steps[2].command, 'singularity-flow recover --phase implementation --json');
  assert.ok(plan.steps.every(entry => !entry.argv.includes('--apply')));
});

test('incomplete authoring refusals lead with a read-only prepublish check and bounded correction guidance', () => {
  const error = Object.assign(new Error("Phase planning contains unresolved placeholder 'TODO'."), {
    code: 'ARTIFACT_AUTHORING_INCOMPLETE',
    details: {
      phase: 'planning',
      diagnosticAction: { command: 'singularity-flow doctor --json' }
    }
  });
  const plan = refusalRemediationPlan(error, ['phase', 'publish', 'planning', '--json']);

  assert.equal(plan.steps[0].id, 'inspect-authored-draft');
  assert.equal(plan.steps[0].command, 'singularity-flow phase prepublish planning --json');
  assert.deepEqual(plan.steps[0].argv, ['phase', 'prepublish', 'planning', '--json']);
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
  assert.match(plan.retry.label, /prepublish check reports ready/);
  assert.equal(plan.steps[2].command, 'singularity-flow recover --phase planning --json');
  assert.equal(plan.steps[2].skill, '/sf-recover');
  assert.equal(plan.context.scope, 'phase');
  assert.equal(plan.context.strategy, 'repair-current-phase');
  assert.equal(plan.context.historyRewrite, false);
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
    'singularity-flow phase prepublish implementation --json');
  assert.equal(plan.steps[0].skill, '/sf-code');
  assert.equal(plan.steps[0].copilotCommand, '/sf-code');
  assert.equal(plan.retry.command, null);
});

test('phase remediation preserves an exact safe producer retry without replacing phase recovery', () => {
  const retry = 'singularity-flow phase publish implementation --authored governed-agent --channel copilot-host';
  const plan = refusalRemediationPlan(Object.assign(new Error('Implementation needs correction.'), {
    code: 'ARTIFACT_AUTHORING_INCOMPLETE',
    details: {
      phase: 'implementation',
      workId: 'CODE-9',
      retry: { command: retry, skill: '/sf-code', maximumAttempts: 1 }
    }
  }), ['phase', 'publish', 'implementation']);
  assert.equal(plan.retry.command, retry);
  assert.equal(plan.retry.skill, '/sf-code');
  assert.equal(plan.steps[0].skill, '/sf-code');
  assert.ok(plan.steps.some((entry) => entry.command ===
    'singularity-flow recover CODE-9 --phase implementation --json'));
});

test('incomplete authoring remediation derives a safe phase from lifecycle argv forms', () => {
  const forms = [
    [['phase', 'begin', 'implementation'], 'implementation'],
    [['phase', 'rollover', 'implementation'], 'implementation'],
    [['phase', 'draft-check', 'planning'], 'planning'],
    [['phase', 'publish', 'implementation'], 'implementation'],
    [['phase', 'submit', 'convergence'], 'convergence'],
    [['submit', '--phase', 'specification'], 'specification']
  ];
  for (const [argv, phase] of forms) {
    const plan = refusalRemediationPlan(Object.assign(new Error('Draft is incomplete.'), {
      code: 'ARTIFACT_AUTHORING_INCOMPLETE'
    }), argv);
    assert.equal(plan.steps[0].command,
      `singularity-flow phase prepublish ${phase} --json`, argv.join(' '));
    assert.equal(plan.steps[0].copyable, true, argv.join(' '));
  }
});

test('approval authoring failures end the approval turn and route to governed phase repair', () => {
  for (const argv of [
    ['phase', 'approve', 'verification'],
    ['approve', 'release', '--work-id', 'WORK-7']
  ]) {
    const phase = argv.includes('verification') ? 'verification' : 'release';
    const plan = refusalRemediationPlan(Object.assign(new Error('Submitted evidence is incomplete.'), {
      code: 'ARTIFACT_AUTHORING_INCOMPLETE'
    }), argv);
    assert.equal(plan.context.strategy, 'new-turn-repair');
    assert.equal(plan.retry.turn, 'new-turn');
    assert.match(plan.retry.label, /Do not retry approval in this turn/);
    assert.equal(plan.steps[0].command,
      `singularity-flow recover${argv.includes('WORK-7') ? ' WORK-7' : ''} --phase ${phase} --json`);
    assert.equal(plan.steps[0].turn, 'new-turn');
    assert.equal(plan.steps[1].command, null);
    assert.match(plan.steps[1].label, /use \/sf-reject in a new turn/);
    assert.ok(plan.steps.every((entry) => !String(entry.command).startsWith('singularity-flow approve')));
  }
});

test('approval containment rejects stale approval retries and cannot be displaced by producer steps', () => {
  const plan = refusalRemediationPlan(Object.assign(new Error('Approval evidence changed.'), {
    code: 'APPROVAL_EVIDENCE_STALE',
    details: {
      phase: 'verification',
      workId: 'WORK-9',
      retry: { command: 'singularity-flow approve verification', skill: '/sf-approve' },
      recoveryCommands: [
        'singularity-flow doctor --json',
        'singularity-flow recommend --json',
        'singularity-flow phase show verification --json'
      ]
    }
  }), ['approve', 'verification', '--work-id', 'WORK-9']);

  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].command,
    'singularity-flow recover WORK-9 --phase verification --json');
  assert.equal(plan.steps[1].command, null);
  assert.match(plan.steps[1].label, /use \/sf-reject in a new turn/);
  assert.equal(plan.steps[2].command, 'singularity-flow phase show verification --json');
  assert.doesNotMatch(JSON.stringify(plan), /singularity-flow approve verification/);
  assert.doesNotMatch(JSON.stringify(plan.steps), /doctor|recommend/);
});

test('an uncoded phase refusal receives bounded phase-local recovery instead of generic doctor guidance', () => {
  const plan = refusalRemediationPlan(Object.assign(new Error('Future phase validator refused.'), {
    code: 'FUTURE_PHASE_VALIDATOR',
    details: { phase: 'planning', workId: 'WORK-8' }
  }), ['phase', 'publish', 'planning']);
  assert.deepEqual(plan.steps.map((entry) => entry.command), [
    'singularity-flow recover WORK-8 --phase planning --json',
    'singularity-flow phase show planning --json'
  ]);
  assert.equal(plan.context.scope, 'phase');
  assert.doesNotMatch(JSON.stringify(plan), /doctor|recommend/);
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

test('a JSON refusal carries its findings, obligations and coverage gaps, and nothing else', async () => {
  const { refusalEnvelope: envelopeOf } = await import('../src/refusal-remediation.mjs');
  const { SingularityFlowError: FlowError } = await import('../src/util.mjs');
  const trp = envelopeOf(new FlowError('Required validation remains failed or unavailable.', {
    code: 'TRP_PHASE_GATE_BLOCKED',
    details: {
      workId: 'W-1', phase: 'code', operation: 'publish', internalNote: 'private-detail',
      evaluation: { issues: [{ id: 'issue-x', obligationId: 'unit', category: 'new-test-failure', severity: 'noncritical',
        riskEligible: true, repairRoute: 'repair-obligation', message: 'Required check failed' }] }
    }
  }), ['phase', 'publish', 'code']);
  assert.deepEqual(trp.error.details, {
    workId: 'W-1', phase: 'code', operation: 'publish',
    obligations: [{ obligation: 'unit', category: 'new-test-failure', severity: 'noncritical', riskEligible: true, repairRoute: 'repair-obligation' }]
  });
  assert.doesNotMatch(JSON.stringify(trp), /private-detail/);

  const gate = envelopeOf(new FlowError('Governance gate failed', {
    code: 'GOVERNANCE_GATE_FAILED',
    details: { findings: [{ code: 'STORY_PHASE_INCOMPLETE', category: 'lifecycle', phase: 'code',
      details: { message: 'terminal: phase code is not approved' }, recovery: { command: 'singularity-flow recover W-1' } }],
    coverage: { unimplemented: ['W-1:AC-001'], unclaimedChangedPaths: ['src/x.mjs'], ignored: ['nope'] } }
  }));
  assert.deepEqual(gate.error.details.findings, [{ code: 'STORY_PHASE_INCOMPLETE', category: 'lifecycle', phase: 'code',
    message: 'terminal: phase code is not approved', recovery: 'singularity-flow recover W-1' }]);
  assert.deepEqual(gate.error.details.coverage, { unimplemented: ['W-1:AC-001'], unclaimedChangedPaths: ['src/x.mjs'] });

  const quiet = envelopeOf(new FlowError('Nope', { code: 'X', details: { arbitrary: 'value' } }));
  assert.equal(Object.hasOwn(quiet.error, 'details'), false, 'a refusal with no projected facts carries no details');
});

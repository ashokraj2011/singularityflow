/**
 * `decision evidence-reuse` through a whole quick-fix Story, from the terminal.
 *
 * The implement step records a passing run at submission. The verify step records none of its own
 * (its packet would say no-governed-tests-in-this-packet). A person who approves verify reuses the
 * recorded run; an approver of another step cannot; a source change refuses a new decision and
 * lapses the one recorded; a revocation ends it. Every surface says whose run it is.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('a verify approver reuses the run implement recorded, and it always reads as implement\'s run', slowLane({ timeout: 300_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-reuse-flow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Reuse Flow Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Reuse Flow Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'reuse.flow@example.invalid' };
  const run = (command, args, { cwd = root, as = null } = {}) => spawnSync(command, args, { cwd, encoding: 'utf8', timeout: childTimeout(180_000),
    env: as ? { ...env, SINGULARITY_FLOW_GITHUB_ACTOR: as } : env });
  const must = (command, args, options) => {
    const result = run(command, args, options);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const sflowAs = (as, ...args) => must(process.execPath, [cli, '--no-model', ...args], { as });
  const refused = (as, ...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json'], { as });
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };

  must('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Only a named person approves verify (quality-reviewers); anyone may approve the other steps.
  config.approvalAuthorities['quality-reviewers'] = { label: 'Quality reviewers', allowAnyGitIdentity: false,
    members: [{ githubLogin: 'release-reviewer' }] };
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Evidence reuse fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], { cwd: base });
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');

  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  const tested = '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n';
  await writeFile(path.join(root, 'src/value.mjs'), tested);
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n// @ac:QF-1:AC-001\ntest('value', () => assert.equal(value, 2));\n");
  sflow('prepare', 'implement');
  sflow('phase', 'publish', 'implement');
  sflow('submit', 'implement');
  const workflowPath = path.join(root, 'singularity/work-items/QF-1/workflow.json');
  const submitted = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(submitted.phases.implement.status, 'approved');
  const recorded = submitted.phases.implement.deliveryEvidence.testExecutions[0];
  assert.equal(recorded.status, 'passed');
  const attemptId = recorded.attemptId;
  const reuse = (...extra) => ['decision', 'evidence-reuse', 'QF-1', '--phase', 'verify', '--from-attempt', attemptId,
    '--reason', 'Implement recorded this suite on the same source; verify adds no source change.', ...extra];

  // An approver of another step may not decide it; the consuming step's approver may.
  const outsider = refused('other-engineer', ...reuse());
  assert.equal(outsider.error.code, 'APPROVAL_IDENTITY_NOT_AUTHORIZED');
  assert.match(outsider.error.message, /quality-reviewers/u);
  const beforeDecision = must('git', ['rev-parse', 'HEAD']).trim();
  const accepted = JSON.parse(sflowAs('release-reviewer', ...reuse(), '--json'));
  const record = accepted.data.record;
  assert.equal(record.id, 'ERU-001');
  assert.equal(record.phase, 'verify');
  assert.equal(record.attempt.id, attemptId);
  assert.equal(record.attempt.phase, 'implement');
  assert.equal(record.attempt.sha256, recorded.receiptSha256);
  assert.match(record.source.commit, /^[0-9a-f]{40}$/u);
  assert.match(record.source.treeSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(record.clauses, ['QF-1:AC-001']);
  assert.equal(record.actor, 'release-reviewer');
  assert.equal(record.authorityGroup, 'quality-reviewers');
  const label = `reused: ${attemptId} recorded by implement at ${record.source.commit.slice(0, 12)}; approved for verify by release-reviewer (ERU-001), not a run by verify`;
  assert.equal(accepted.data.label, label);
  const stored = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.deepEqual(stored.evidenceReuses, [record], 'recorded append-only in workflow.json');
  assert.equal(stored.history.at(-1).event, 'evidence_reuse_decided');
  assert.equal(must('git', ['status', '--porcelain', '--', 'singularity']).trim(), '', 'the decision is committed');
  assert.match(must('git', ['log', '-1', '--format=%s']), /^\[QF-1\]\[evidence-reuse:accept\] verify TA-/u);
  // The decision commit is one person's decision, like the other decision kinds, so it may sit between a
  // step's submission and its approval, and Auto stops at it rather than treating it as foreign work.
  const decisionCommit = must('git', ['rev-parse', 'HEAD']).trim();
  const { onlyHumanDecisionCommits } = await import('../src/state.mjs');
  assert.deepEqual(await onlyHumanDecisionCommits(root, YAML.parse(await readFile(configPath, 'utf8')), stored, beforeDecision, decisionCommit), [decisionCommit]);

  // The consuming step's evidence: its own run is absent, the reuse names whose run it is.
  const entry = JSON.parse(sflow('phase', 'enter', 'verify', '--json'));
  const evidence = entry.retainedExecutionEvidence;
  assert.equal(evidence.reusedTestEvidence.length, 1);
  assert.equal(evidence.reusedTestEvidence[0].label, label);
  assert.equal(evidence.reusedTestEvidence[0].runByThisStep, false);
  assert.ok(!evidence.entries.some((packet) => packet.phase === 'verify' && packet.checks?.length), 'verify retains no run of its own');
  const review = JSON.parse(sflow('phase', 'show', 'verify', '--json'));
  assert.equal(review.reusedTestEvidence[0].label, label);
  assert.equal(review.reusedTestEvidence[0].state, 'active');
  const shown = run(process.execPath, [cli, '--no-model', 'phase', 'show', 'verify']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.includes(`Reused test evidence: ${label}`), shown.stdout);
  for (const text of [JSON.stringify(entry), JSON.stringify(review), shown.stdout, shown.stderr]) {
    assert.doesNotMatch(text, /verify (?:ran|executed|passed) (?:the )?tests?/u, 'never says the reusing step ran tests');
  }

  // A source change: the recorded decision lapses on read, and a new one is refused with routes.
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2; // edited\n');
  const lapsed = JSON.parse(sflow('phase', 'show', 'verify', '--json')).reusedTestEvidence[0];
  assert.equal(lapsed.state, 'source-changed');
  assert.match(lapsed.label, /^ERU-001 no longer applies \(the application source or its test inputs changed after that run\)/u);
  sflowAs('release-reviewer', 'decision', 'evidence-reuse', 'QF-1', '--revoke', 'ERU-001', '--reason', 'Replaced by a decision on the edited source, if any.');
  const changed = refused('release-reviewer', ...reuse());
  assert.equal(changed.error.code, 'EVIDENCE_REUSE_SOURCE_CHANGED');
  assert.deepEqual(changed.error.details.paths, ['src/value.mjs']);
  assert.match(changed.error.message, /changed after implement recorded it at [0-9a-f]{12}: src\/value\.mjs\./u);
  assert.match(changed.error.message, /Repair: /u);
  assert.match(changed.error.message, /Fresh recorded run: /u);
  assert.ok(changed.remediationPlan.steps.some((step) => typeof step.command === 'string'), JSON.stringify(changed.remediationPlan));

  // Restored bytes bind again; the revoked decision stays revoked, and a new one is ERU-002.
  await writeFile(path.join(root, 'src/value.mjs'), tested);
  assert.equal(JSON.parse(sflow('phase', 'show', 'verify', '--json')).reusedTestEvidence[0].state, 'revoked');
  const again = JSON.parse(sflowAs('release-reviewer', ...reuse(), '--json'));
  assert.equal(again.data.record.id, 'ERU-002');
  sflowAs('release-reviewer', 'decision', 'evidence-reuse', 'QF-1', '--revoke', 'ERU-002', '--reason', 'Verify will record a run of its own instead.');
  const ended = JSON.parse(sflow('phase', 'show', 'verify', '--json')).reusedTestEvidence;
  assert.deepEqual(ended.map((item) => [item.id, item.state]), [['ERU-002', 'revoked']], 'only the latest decision on the same run governs');
  const final = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.deepEqual(final.evidenceReuses.map((item) => item.id ?? `revokes ${item.revokes}`),
    ['ERU-001', 'revokes ERU-001', 'ERU-002', 'revokes ERU-002']);
});

/**
 * Decision 11, absolute [CQF:REQ-054]: a scanner or advisory database that is missing or offline is
 * recorded and never blocks, in every mode. A finding command that cannot run is unavailable under
 * enforce too; a plain lint, static-analysis or security command whose program is not here is
 * unavailable, not failed. Tests, builds and formatters keep their rule.
 * test/findings-dependency-hold.test.mjs walks the same through the real CLI.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishCheckFindings, submitCheckFindings } from '../src/findings/code-step.mjs';
import { scannerUnavailableCheck } from '../src/state.mjs';
import { normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { qualityValidationVerdict } from '../src/lifecycle-evidence-policy.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-unavailable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: root }).status, 0);
  git('init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'package.json'), '{}\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return root;
}

/** The loop's kernel: every command's run is one that could not start. */
const missingKernel = (offline = false) => ({
  generation: 1, sourceTreeHash: async () => 'tree-1', testInputTreeHash: async () => null,
  qualityChecks: async (root, phase, config, workflow, commands) => Promise.all(commands.map(async (command) => {
    const at = new Date().toISOString();
    if (offline) {
      // The audit ran and printed npm's own error: its registry could not be reached.
      await mkdir(path.join(root, '.sflow/results'), { recursive: true });
      await writeFile(path.join(root, command.result.path), JSON.stringify({ message: 'request to https://registry.example.test failed, reason: getaddrinfo ENOTFOUND', error: { summary: '', detail: '' } }));
      return { id: command.id, status: 'failed', exitCode: 1, startedAt: at, completedAt: at };
    }
    return { id: command.id, status: 'blocked', exitCode: null, infrastructureUnavailable: true, stderr: 'Unable to run quality command: spawn ENOENT', startedAt: at, completedAt: at };
  }))
});

test('under enforce a scanner that cannot run, or an audit that cannot reach its database, is recorded and blocks nothing [decision 11]', async (t) => {
  const root = await repository(t);
  const semgrep = { id: 'semgrep', kind: 'security', modelPolicy: 'never', argv: ['sflow-test-scanner-that-is-not-installed'], result: { adapter: 'sarif', path: '.sflow/results/semgrep.sarif' } };
  const audit = { id: 'npm-audit', kind: 'security', modelPolicy: 'never', argv: ['npm', 'audit', '--json'], result: { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json' } };
  const phase = { id: 'implementation', qualityCommands: [semgrep, audit] };
  const workflow = { workItem: { id: 'U-1' }, phaseOrder: ['implementation'], phases: { implementation: phase },
    resolution: { approvalAuthorities: {}, codeDelivery: { staticAnalysis: { mode: 'enforce' } } } };
  const delivery = { changeSet: { entries: [{ newPath: 'package.json', oldPath: 'package.json', status: 'modified' }] } };
  const published = await publishCheckFindings(root, {}, workflow, phase, delivery, missingKernel());
  assert.deepEqual([published.mode, published.outcome, published.unavailable.map((entry) => entry.commandId)], ['enforce', 'passed', ['semgrep', 'npm-audit']]);
  const offline = await publishCheckFindings(root, {}, workflow, phase, delivery, missingKernel(true));
  assert.match(offline.unavailable.find((entry) => entry.commandId === 'npm-audit').reason, /its report could not be read: npm audit could not read its advisories: .*ENOTFOUND/u);
  // At submit each is an advisory check, so the verdict never counts it as a required check missing.
  const submitted = await submitCheckFindings(root, {}, workflow, { ...phase, deliveryEvidence: delivery }, [semgrep, audit], missingKernel());
  assert.deepEqual(submitted.checks.map((check) => [check.id, check.status, check.requirement]), [['semgrep', 'unavailable', 'advisory'], ['npm-audit', 'unavailable', 'advisory']]);
  assert.deepEqual(qualityValidationVerdict(submitted.checks).unavailableRequired, []);
});

test('a plain lint, static-analysis or security command whose program is not here is unavailable, not failed; tests and builds keep their rule [decision 11]', () => {
  const check = (fields) => ({ id: 'x', command: 'x', requirement: 'required', status: 'failed', exitCode: 1, stderr: '', ...fields });
  const policy = (kind, extra = {}) => normalizeExternalCommand({ id: 'x', kind, modelPolicy: 'never', argv: ['x'], ...extra });
  for (const kind of ['lint', 'static-analysis', 'security']) {
    for (const [fields, why] of [[{ status: 'blocked', infrastructureUnavailable: true, exitCode: null, stderr: 'Unable to run quality command: spawn x ENOENT' }, 'not installed'],
      [{ status: 'failed', exitCode: 127, stderr: 'sh: x: command not found' }, "the shell's 127"],
      [{ status: 'blocked', errorCode: 'ENVIRONMENT_BINDING_UNAVAILABLE', exitCode: null, stderr: "Environment 'sonar' is unavailable." }, 'no bound environment'],
      [{ status: 'blocked', timedOut: true, exitCode: null, stderr: 'Command exceeded its 1000ms timeout.' }, 'past its timeout']]) {
      const marked = scannerUnavailableCheck(check(fields), policy(kind));
      assert.deepEqual([marked.status, marked.requirement, marked.configuredRequirement, marked.scannerUnavailable], ['unavailable', 'advisory', 'required', true], `${kind}: ${why}`);
      assert.match(marked.stderr, /^Not run here: .+ A scanner that cannot run is recorded and blocks nothing\.$/u);
    }
    // It ran and reported problems: that is a failure, as before.
    assert.equal(scannerUnavailableCheck(check({ exitCode: 1 }), policy(kind)).status, 'failed', `${kind} that ran`);
  }
  for (const kind of ['test', 'compile', 'format']) {
    assert.equal(scannerUnavailableCheck(check({ status: 'blocked', infrastructureUnavailable: true }), policy(kind)).status, 'blocked', `${kind} keeps today's rule`);
    assert.equal(scannerUnavailableCheck(check({ exitCode: 127 }), policy(kind)).status, 'failed', kind);
  }
  // A finding command's own run is the findings loop's to judge.
  const reader = policy('security', { result: { adapter: 'sarif', path: '.sflow/results/s.sarif' } });
  assert.equal(scannerUnavailableCheck(check({ status: 'blocked', infrastructureUnavailable: true }), reader).status, 'blocked');
  const verdict = qualityValidationVerdict([scannerUnavailableCheck(check({ exitCode: 127 }), policy('lint')), { id: 'unit', status: 'passed', requirement: 'required' }]);
  assert.deepEqual([verdict.failed, verdict.unavailableRequired, verdict.verdict], [[], [], 'partial']);
});

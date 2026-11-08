/**
 * Imported scanners read their findings [CQF decision 6]: when team import (or Build with Copilot)
 * brings in npm audit, pnpm audit, pip-audit, osv-scanner, semgrep or ESLint, the check is given its
 * finding reader, so only findings on the Story's new code count. A scanner no reader fits is
 * imported as advisory: it warns and never fails submit on findings in existing code.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { importedScannerCommand, scannerCheck } from '../src/findings/ci-scanners.mjs';
import { findingCommand, normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { qualityValidationVerdict } from '../src/lifecycle-evidence-policy.mjs';
import { scannerUnavailableCheck } from '../src/state.mjs';
import { inspectTeamDirectory } from '../src/team-import/inspect.mjs';
import { compileTeamImport } from '../src/team-import/compile.mjs';
import { fixtureCandidate, teamFixture, writeCandidate } from './helpers/team-import-fixture.mjs';

test('each scanner a reader reads is asked for its machine report, which SFlow writes from what it prints', () => {
  const read = (argv) => importedScannerCommand(argv, 'scan');
  assert.deepEqual(read(['npm', 'audit', '--omit=dev']), { argv: ['npm', 'audit', '--omit=dev', '--json'], result: { adapter: 'npm-audit', path: '.sflow/results/scan.json', from: 'stdout' } });
  assert.deepEqual(read(['pnpm', 'audit', '--prod']).result.adapter, 'pnpm-audit');
  assert.deepEqual(read(['pip-audit', '-r', 'requirements.txt']).argv, ['pip-audit', '-r', 'requirements.txt', '--format', 'json']);
  assert.deepEqual(read(['pip-audit', '-f', 'markdown']).argv, ['pip-audit', '-f', 'json'], 'a format the reader cannot read is set to the one it reads');
  assert.deepEqual(read(['python', '-m', 'pip_audit']).result.adapter, 'pip-audit');
  assert.deepEqual(read(['osv-scanner', '--format=table', '-r', '.']).argv, ['osv-scanner', '--format=json', '-r', '.']);
  assert.deepEqual(read(['semgrep', 'scan', '--config', '.semgrep/', '--json']), { argv: ['semgrep', 'scan', '--config', '.semgrep/', '--sarif'],
    result: { adapter: 'sarif', path: '.sflow/results/scan.sarif', from: 'stdout' } });
  assert.deepEqual(read(['npx', 'eslint', 'src']).argv, ['npx', 'eslint', 'src', '--format', 'json']);
  assert.deepEqual(read(['pnpm', 'exec', 'eslint', '.', '--format', 'stylish']).argv, ['pnpm', 'exec', 'eslint', '.', '--format', 'json']);
  // A report sent to a file of the tool's own, or a scanner no reader reads: none fits.
  for (const argv of [['pip-audit', '-o', 'audit.json'], ['semgrep', '--config', 'p/ci', '-o', 'out.sarif'], ['eslint', '.', '--output-file', 'lint.json'],
    ['osv-scanner', '--output', 'osv.json', '.'], ['yarn', 'audit'], ['bandit', '-r', 'src'], ['dependency-check.sh', '--scan', '.'], ['npm', 'run', 'lint'], ['ruff', 'check', '.']]) {
    assert.equal(read(argv), null, argv.join(' '));
  }
  // Each one SFlow writes is a finding command the loop reads.
  for (const argv of [['npm', 'audit'], ['pip-audit'], ['osv-scanner', '-r', '.'], ['semgrep', '--config', '.semgrep/'], ['npx', 'eslint', 'src']]) {
    const command = normalizeExternalCommand({ id: 'scan', kind: 'security', modelPolicy: 'never', ...read(argv) });
    assert.equal(findingCommand(command), true, argv.join(' '));
    assert.equal(command.result.from, 'stdout');
  }
});

test('a scanner no reader fits is advisory, and when it fails it warns and fails nothing; a type check or build keeps its rule', () => {
  assert.deepEqual(scannerCheck({ id: 'lint', modelPolicy: 'never', argv: ['npm', 'run', 'lint'], kind: 'lint' }, 'lint'),
    { id: 'lint', modelPolicy: 'never', argv: ['npm', 'run', 'lint'], kind: 'lint', requirement: 'advisory' });
  assert.equal(scannerCheck({ id: 'bandit', argv: ['bandit', '-r', 'src'], kind: 'security' }, 'security').requirement, 'advisory');
  assert.equal(scannerCheck({ id: 'lint', argv: ['npm', 'run', 'lint'], kind: 'lint', requirement: 'required' }, 'lint').requirement, 'required', 'a requirement the source names stays');
  assert.equal(scannerCheck({ id: 'tsc', argv: ['npx', 'tsc', '--noEmit'], kind: 'static-analysis' }, 'typecheck').requirement, undefined, 'a type check is no scanner');
  assert.equal(scannerCheck({ id: 'build', argv: ['npm', 'run', 'build'], kind: 'compile' }, 'build', { requirement: 'required' }).requirement, 'required');
  const eslint = scannerCheck({ id: 'eslint', modelPolicy: 'never', argv: ['npx', 'eslint', 'src'], kind: 'lint' }, 'lint');
  assert.deepEqual([eslint.result, eslint.requirement], [{ adapter: 'eslint-json', path: '.sflow/results/eslint.json', from: 'stdout' }, undefined]);
  // At submit an advisory scanner that reported problems is warned: shown, never a failure. A required one still fails.
  const policy = normalizeExternalCommand({ id: 'lint', kind: 'lint', modelPolicy: 'never', argv: ['npm', 'run', 'lint'], requirement: 'advisory' });
  const ran = scannerUnavailableCheck({ id: 'lint', command: 'npm run lint', requirement: 'advisory', status: 'failed', exitCode: 1, stderr: '3 problems' }, policy);
  assert.equal(ran.status, 'warned');
  assert.match(ran.stderr, /^Advisory scanner reported problems \(exit 1\); it reads no findings, so it warns and fails nothing\. 3 problems$/u);
  const verdict = qualityValidationVerdict([ran, { id: 'unit', status: 'passed', requirement: 'required' }]);
  assert.deepEqual([verdict.failed.length, verdict.unavailableRequired.length, verdict.warned.map((check) => check.id), verdict.verdict], [0, 0, ['lint'], 'partial']);
  const required = normalizeExternalCommand({ id: 'lint', kind: 'lint', modelPolicy: 'never', argv: ['npm', 'run', 'lint'] });
  assert.equal(scannerUnavailableCheck({ id: 'lint', requirement: 'required', status: 'failed', exitCode: 1 }, required).status, 'failed');
  const compile = normalizeExternalCommand({ id: 'build', kind: 'compile', modelPolicy: 'never', argv: ['npm', 'run', 'build'], requirement: 'advisory' });
  assert.equal(scannerUnavailableCheck({ id: 'build', requirement: 'advisory', status: 'failed', exitCode: 1 }, compile).status, 'failed', 'a build is no scanner');
});

const SECURITY = ['# Security checks', '', 'Before review, run:', '', '```sh', 'npm audit', 'npx eslint src', 'semgrep --config .semgrep/ --error', 'bandit -r src', '```', ''].join('\n');

test('team import gives each scanner its reader, and imports one no reader fits as advisory [CQF decision 6]', async (t) => {
  // The lead agent links the delivery process, which holds the team's security checks.
  const f = await teamFixture(t, { 'docs/process.md': SECURITY });
  const inspection = await inspectTeamDirectory(f.team, { env: f.env, issue: f.issue, entries: [] });
  const file = inspection.closure.find((entry) => entry.path === 'docs/process.md');
  const ev = (line) => [{ path: 'docs/process.md', sha256: file.sha256, startLine: line, endLine: line }];
  await writeCandidate(inspection, fixtureCandidate(inspection, (candidate) => {
    candidate.phases[1].qualityCommands.push({ argv: ['npm', 'audit'], evidence: ev(6) }, { argv: ['npx', 'eslint', 'src'], evidence: ev(7) },
      { argv: ['semgrep', '--config', '.semgrep/', '--error'], evidence: ev(8) }, { argv: ['bandit', '-r', 'src'], evidence: ev(9) });
  }));
  const result = await compileTeamImport(inspection.session.id, { env: f.env, dryRun: true });
  assert.equal(result.state, 'portable-ready', JSON.stringify(result.findings, null, 2));
  const staged = YAML.parse(await readFile(path.join(path.dirname(inspection.session.candidatePath), 'stage', 'singularity', 'workflow.yml'), 'utf8'));
  const checks = Object.fromEntries(staged.phases['delivery-build'].qualityCommands.map((command) => [command.id, command]));
  assert.deepEqual(checks['npm-audit'], { id: 'npm-audit', modelPolicy: 'never', argv: ['npm', 'audit', '--json'], kind: 'security',
    result: { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json', from: 'stdout' } });
  assert.deepEqual([checks['npx-eslint-src'].kind, checks['npx-eslint-src'].argv, checks['npx-eslint-src'].result.adapter], ['lint', ['npx', 'eslint', 'src', '--format', 'json'], 'eslint-json']);
  assert.deepEqual([checks['semgrep-config-semgrep-error'].argv.at(-1), checks['semgrep-config-semgrep-error'].result.adapter], ['--sarif', 'sarif']);
  assert.deepEqual([checks['bandit-r-src'].requirement, checks['bandit-r-src'].result], ['advisory', undefined], 'no reader fits bandit: it warns, never fails submit');
  assert.equal(checks['npm-test'].requirement, undefined, 'a test command keeps its rule');
  for (const command of Object.values(checks)) assert.doesNotThrow(() => normalizeExternalCommand(command), command.id);
});

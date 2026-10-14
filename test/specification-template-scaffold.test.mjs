/**
 * A repository keeps its own specification template. One written before the scenario-coverage
 * rule (2026-10-12) still prepared a specification with no Scenario coverage table, while the
 * repository's workflow required one; the author had to invent the section, and sometimes did not.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

test('a Story on a repository with an older specification template still gets the Scenario coverage table', { timeout: 300_000 }, async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-scaffold-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'app');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), SINGULARITY_FLOW_TEST_IDENTITY: 'Scaffold Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Scaffold Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'scaffold@example.invalid' };
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }).status, 0, args.join(' '));
  const sflow = (...args) => spawnSync(process.execPath, [bin, '--no-model', ...args], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { env }).status, 0);
  await writeFile(path.join(repo, 'README.md'), '# App\n');
  assert.equal(sflow('init').status, 0);
  const template = path.join(repo, 'singularity', 'templates', 'spec-code-test-loop', 'specification.md');
  const current = await readFile(template, 'utf8');
  const start = current.indexOf('## Scenario coverage');
  await writeFile(template, current.slice(0, start) + current.slice(current.indexOf('## Verification intent')));
  git('add', '-A');
  git('commit', '-qm', 'repository with a specification template from before scenario coverage');
  git('init', '-q', '--bare', '-b', 'main', path.join(base, 'app.git'));
  git('remote', 'add', 'origin', path.join(base, 'app.git'));
  git('push', '-q', '-u', 'origin', 'main');

  // doctor names the template, and how to bring it up to date.
  const doctor = sflow('doctor', '--offline', '--json');
  const report = JSON.parse(doctor.stdout.slice(doctor.stdout.indexOf('{')));
  const gap = report.checks.find((entry) => entry.id === 'artifact-template-sections');
  assert.equal(gap?.status, 'warn', JSON.stringify(gap));
  assert.match(gap.message, /spec-code-test-loop\/specification\.md \(Scenario coverage\)/u);
  assert.match(gap.fix, /workspace reinitialize/u);

  const started = sflow('start', 'SPEC-1', '--title', 'Add an order note', '--description', 'Orders may carry an optional note.',
    '--acceptance-criteria', 'A note up to 200 characters is stored with the order.', '--work-type', 'spec-code-test-loop',
    '--from-branch', 'main', '--readiness-baseline', 'defer');
  assert.equal(started.status, 0, started.stderr);
  const spec = await readFile(path.join(repo, 'singularity', 'work-items', 'SPEC-1', 'artifacts', 'specification', 'spec.md'), 'utf8');
  assert.match(spec, /^## Scenario coverage$/mu);
  assert.match(spec, /^\| `SPEC-1:REQ-001` \| S1 \| TODO \|$/mu);
  assert.ok(spec.indexOf('## Scenario coverage') < spec.indexOf('## Verification intent'));

  const prepublish = sflow('phase', 'prepublish', 'specification', '--json');
  const result = JSON.parse(prepublish.stdout.slice(prepublish.stdout.indexOf('{')));
  const codes = (result.findings ?? []).map((finding) => finding.code);
  assert.ok(!codes.includes('specification.scenario-coverage-required'), 'the author fills a table instead of inventing a section');
  assert.ok(codes.includes('artifact.placeholder.unresolved'), 'an unfilled draft is still refused for its TODO cells');
});

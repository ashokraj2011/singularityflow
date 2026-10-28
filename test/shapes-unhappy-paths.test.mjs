import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Story shapes other than a normal feature, each of which stopped at a check that did not apply
// to it (unhappy-paths audit, 2026-10-28).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Shape Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A classic-delivery Story whose intake plan is `rows`, approved and ready for its code step. */
async function story(t, id, { files, outcome, rows }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-shape-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Shape Tester'], root);
  run('git', ['config', 'user.email', 'shape@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  // The readiness check runs the repository's tests, so the baseline has one.
  await write('test/baseline.test.mjs', "import test from 'node:test';\ntest('baseline', () => {});\n");
  for (const [relative, contents] of Object.entries(files)) await write(relative, contents);
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the shape fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', id, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Shape', '--description', outcome);
  const item = path.join(root, 'singularity/work-items', id);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${id} — intake`, '', '## Request and outcome', '', outcome, '',
    '## Scope and constraints', '', 'Only the listed paths change.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    ...rows.map((row) => `| [${row.clause}] | ${row.outcome} |`), '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    ...rows.map((row) => `| \`${row.clause}\` | ${row.paths} | ${row.tests} | ${row.fulfillment} |`), '',
    '## Initial evidence', '', 'The baseline at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is the plan right?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The planned change is made.'));
  return { root, item, cli, attempt, write };
}

test('a document row whose tests the plan reviewed as not applicable publishes without a test', async (t) => {
  const id = 'DOCS-1';
  const AC = `${id}:AC-001`;
  const { cli, attempt, write } = await story(t, id, {
    files: { 'docs/usage.md': '# Usage\n\nCall value().\n' },
    outcome: 'The usage page explains what value() returns.',
    rows: [{ clause: AC, outcome: 'The usage page says value() returns the approved value.', paths: '`docs/usage.md`',
      tests: 'not-applicable: A documentation change, reviewed by reading the page.', fulfillment: 'document' }]
  });
  await write('docs/usage.md', '# Usage\n\nCall value() to read the approved value.\n');
  const published = attempt('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  assert.doesNotMatch(published.stdout + published.stderr, /no acceptance test is available/u);
  assert.equal(published.status, 0, published.stdout + published.stderr);
  cli('submit', 'implementation');
});

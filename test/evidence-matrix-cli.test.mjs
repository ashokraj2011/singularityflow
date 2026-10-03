import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Evidence Matrix Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

test('the evidence matrix shows each criterion at its real assurance through a real Story', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-matrix-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const workId = 'MATRIX-1';
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const matrix = (...args) => JSON.parse(cli('evidence', 'matrix', ...args, '--json').stdout).data.matrix;
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Evidence Matrix Tester'], root);
  run('git', ['config', 'user.email', 'matrix@example.test'], root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 1));", ''
  ].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize evidence matrix fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const plan = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');

  cli('start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Change the value', '--description', 'Show the evidence matrix.');
  const item = path.join(root, 'singularity/work-items', workId);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${workId} — intake`, '', '## Request and outcome', '',
    'Return the approved new value 2 to every caller; retain the exported API.', '',
    '## Scope and constraints', '', 'Change only the value module and its executable unit test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${workId}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${workId}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and executable test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is the new value 2 the approved outcome?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  // Planned, nothing delivered yet: pending, and the view says the Story is not complete.
  const planned = matrix();
  assert.equal(planned.page.total, 1);
  const [plannedRow] = planned.page.rows;
  assert.equal(plannedRow.id, `${workId}:AC-001`);
  assert.equal(plannedRow.result, 'pending', JSON.stringify(planned.evaluation.findings));
  assert.equal(plannedRow.obligations.find((entry) => entry.responsibility === 'plan').status, 'met');
  assert.equal(planned.evaluation.completion.label, 'Incomplete — verification pending or insufficient');
  assert.equal(planned.evaluation.lifecycle.words, 'In progress at Code');

  cli('prepare', 'implementation');
  await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${workId}:AC-001 returns the approved value 2\nexport const value = 2;\n`);
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    `// @ac:${workId}:AC-001`, "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value, 2));", ''
  ].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The clause-tagged value module and acceptance-tagged unit test now prove the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');

  // Delivered, tested and approved: satisfied at module-observed assurance and no higher.
  const delivered = matrix();
  const [row] = delivered.page.rows;
  assert.equal(row.result, 'satisfied');
  assert.equal(row.assurance, 'module-observed');
  assert.deepEqual(row.verification.tests, ['test/value.test.mjs']);
  // The same identity delivered and approved the code, and the matrix says so rather than 'reviewed'.
  assert.deepEqual(row.obligations.find((entry) => entry.responsibility === 'verify').facets, {
    coverage: 'linked', execution: 'passed', assurance: 'module-observed', review: 'self-approved', freshness: 'current', exception: 'none'
  });
  assert.equal(delivered.evaluation.decision.gate, 'allow');
  assert.equal(delivered.evaluation.summary.testCaseResults, 'not joined to criteria yet');

  const human = cli('evidence', 'matrix').stdout;
  assert.match(human, /Evidence matrix — MATRIX-1: Change the value/);
  assert.match(human, /satisfied \(module-observed\)/);
  assert.match(human, /no test-case result is joined to a criterion yet/);
  const csv = cli('evidence', 'matrix', '--format', 'csv').stdout.trim().split('\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /^"MATRIX-1:AC-001","AC",/);
  assert.equal(matrix('--row', 'AC-001').page.rows.length, 1);

  const badFacet = run(process.execPath, [CLI, '--no-model', 'evidence', 'matrix', '--facet', 'colour', '--json'], root, { allowFailure: true });
  assert.notEqual(badFacet.status, 0);
  assert.match(badFacet.stdout + badFacet.stderr, /EVIDENCE_MATRIX_FILTER_INVALID/);
  const unknownOption = run(process.execPath, [CLI, '--no-model', 'evidence', 'matrix', '--colour', 'red'], root, { allowFailure: true });
  assert.notEqual(unknownOption.status, 0);
  assert.match(unknownOption.stdout + unknownOption.stderr, /SGOS_UNKNOWN_OPTION|colour/);

  // The pull request description carries the same evaluation, in its own words.
  const description = JSON.parse(cli('pr', 'describe', '--format', 'json').stdout);
  assert.match(description.body, /### Evidence\n\n- Completion: \*\*Incomplete — verification pending or insufficient\*\*/);
  assert.match(description.body, /- Rows: 1 — 1 satisfied/);

  // A view runs nothing: the Story's files and history are exactly as they were.
  const head = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  matrix();
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
});

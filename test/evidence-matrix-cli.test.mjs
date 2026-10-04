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
// 26 subprocesses measured for each evidence view on this fixture (2026-10-03); growth past the
// budget is a regression to explain, not a number to raise quietly.
const EVIDENCE_VIEW_GIT_BUDGET = 40;

function run(command, args, cwd, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Evidence Matrix Tester', ...env }
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
    "import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${workId}:AC-001`, "test('value', () => assert.equal(value, 2));", ''
  ].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The clause-tagged value module and acceptance-tagged unit test now prove the approved value 2.'));
  const sourceFile = path.join(root, 'src/value.mjs');
  const approvedSource = await readFile(sourceFile, 'utf8');
  await writeFile(sourceFile, `${approvedSource}// @clause:${workId}:AC-009 unapproved requirement\n`);
  const orphan = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation',
    '--authored', 'human', '--channel', 'manual-in-place', '--json'], root, { allowFailure: true });
  assert.notEqual(orphan.status, 0);
  assert.match(orphan.stdout, /EVIDENCE_CLAUSE_UNAPPROVED/);
  await writeFile(sourceFile, approvedSource);
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const submitted = cli('submit', 'implementation');
  assert.doesNotMatch(submitted.stdout + submitted.stderr, /document preview unavailable|outside work item/);
  const review = JSON.parse(cli('phase', 'show', 'implementation', '--json').stdout);
  assert.ok(review.reviewBinding, 'source artifact previews must not disable the approval binding');
  const approved = cli('approve', 'implementation', '--yes');
  assert.doesNotMatch(approved.stdout + approved.stderr, /document preview unavailable|outside work item/);

  // Native Node identities now bind the criterion to the actual passing declaration.
  const delivered = matrix();
  const [row] = delivered.page.rows;
  assert.equal(row.result, 'satisfied');
  assert.equal(row.assurance, 'exact-local-observed');
  assert.deepEqual(row.verification.tests, ['test/value.test.mjs']);
  // The same identity delivered and approved the code, and the matrix says so rather than 'reviewed'.
  assert.deepEqual(row.obligations.find((entry) => entry.responsibility === 'verify').facets, {
    coverage: 'linked', execution: 'passed', assurance: 'exact-local-observed', review: 'self-approved', freshness: 'current', exception: 'none'
  });
  assert.equal(delivered.evaluation.decision.gate, 'allow');
  assert.equal(delivered.evaluation.summary.testCaseResults, '1 criterion row(s) joined to an exact test result; 0 rest on a module test command');
  assert.deepEqual(row.obligations.find((entry) => entry.responsibility === 'verify').assuranceFacets, { identity: 'source-bound', execution: 'exact-local-observed' });

  const human = cli('evidence', 'matrix').stdout;
  assert.match(human, /Evidence matrix — MATRIX-1: Change the value/);
  assert.match(human, /satisfied \(exact-local-observed\)/);
  assert.match(human, /"module-observed" means the test command covering a criterion's tagged test file passed/);
  assert.match(human, /exact test · passed/);
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
  assert.equal(delivered.evaluation.provenance.evaluatedCommit, head);
  assert.equal(delivered.evaluation.provenance.worktree, 'clean');
  assert.ok(delivered.evaluation.provenance.candidates.some((entry) => entry.phaseId === 'implementation'));
  await writeFile(sourceFile, `${approvedSource}\n// unpublished change\n`);
  const dirty = matrix();
  assert.equal(dirty.evaluation.provenance.worktree, 'dirty');
  assert.match(dirty.evaluation.provenance.warnings.join(' '), /Uncommitted changes are not covered/);
  assert.equal(dirty.page.rows[0].result, row.result, 'historical evidence remains separate from live drift');
  await writeFile(sourceFile, approvedSource);
  matrix();
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), head);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');

  // Parity [E2G criterion 16]: the VS Code panel is built from this same JSON and carries every
  // machine field unchanged, so the editor can never show other findings or actions than the CLI.
  const { evidenceView } = await import('../apps/vscode/src/views/evidence-matrix-model.ts');
  const json = JSON.parse(cli('evidence', 'matrix', '--json').stdout);
  const view = evidenceView(json);
  const source = json.data.matrix;
  assert.equal(view.completion, source.evaluation.completion.label);
  assert.equal(view.lifecycle, source.evaluation.lifecycle.words);
  assert.equal(view.total, source.page.total);
  for (const [index, row] of source.page.rows.entries()) {
    const shown = view.rows.find((entry) => entry.id === row.id);
    assert.ok(shown, `the panel dropped ${row.id}`);
    assert.deepEqual([shown.result, shown.assurance], [row.result, row.assurance ?? null], `row ${index}`);
    assert.deepEqual(shown.actions, row.actions.map((action) => action.command));
    assert.deepEqual(shown.findings, row.findings.map((finding) => finding.message));
    assert.deepEqual(shown.obligations.map((entry) => [entry.id, entry.status, entry.owningSteps, entry.facets]).sort(),
      row.obligations.map((entry) => [entry.id, entry.status, entry.owningSteps, entry.facets]).sort());
  }
  // And the terminal shows each row's result and its first action.
  const text = cli('evidence', 'matrix').stdout;
  for (const row of source.page.rows) {
    assert.match(text, new RegExp(row.result));
    if (row.actions[0]) assert.ok(text.includes(row.actions[0].command), `the terminal omits ${row.actions[0].command}`);
  }

  // Latency budget [E2G-033]: an evidence view reaches no network, runs no test, and its Git reads
  // stay bounded, measured by the product's own subprocess probe.
  for (const view of [['evidence', 'matrix', '--json'], ['evidence', 'scope', '--json']]) {
    const probed = run(process.execPath, [CLI, '--no-model', ...view], root, { env: { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' } });
    const report = probed.stderr.slice(probed.stderr.lastIndexOf('subprocesses:'));
    const rows = [...report.matchAll(/^\s+(\d+)x\s+\d+ ms\s+(.+)$/gmu)].map((match) => ({ calls: Number(match[1]), key: match[2].trim() }));
    const label = view.join(' ');
    process.stderr.write(`${label}: ${report.split('\n')[0]}\n`);
    for (const { key } of rows) {
      assert.doesNotMatch(key, /^(?:gh|curl|wget)\b|^git (?:fetch|pull|push|ls-remote|remote update|clone)\b/u, `${label} reached the network: ${key}`);
      assert.doesNotMatch(key, /^(?:npm|npx|pnpm|yarn|mvn|gradle|pytest|python3?|cargo|go)\b|--test\b/u, `${label} ran a test or build tool: ${key}`);
    }
    const git = rows.filter((entry) => entry.key.startsWith('git ')).reduce((sum, entry) => sum + entry.calls, 0);
    assert.ok(git <= EVIDENCE_VIEW_GIT_BUDGET, `${label} made ${git} Git calls; the budget is ${EVIDENCE_VIEW_GIT_BUDGET}\n${report}`);
  }
});

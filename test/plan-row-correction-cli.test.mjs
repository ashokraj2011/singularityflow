import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'CORRECT-1';
const AC = `${W}:AC-001`;
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Correction Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

// The live terminal ceremony needs a real TTY; this stands in for the reviewed confirmation only.
const RUNNER = `
import { randomUUID } from 'node:crypto';
import { loadAcceptedStoryExecution } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/accepted-story-execution.mjs')).href)};
import { runPlanCorrection } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/commands/plan-correction.mjs')).href)};
const accepted = await loadAcceptedStoryExecution(process.cwd());
const seen = [];
await runPlanCorrection({ root: process.cwd(), config: accepted.definition, workflow: accepted.workflow, options: JSON.parse(process.argv[1]) }, {
  capture: async (root, plan, action) => { seen.push(plan.rowsBefore); return { token: 'live-review' }; },
  consume: async () => ({ authorizationId: randomUUID() })
});
process.stderr.write('REVIEWED ' + JSON.stringify(seen) + '\\n');
`;

test('a wrong plan path is corrected by the plan approvers and the code step continues with no step reset', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-plan-correction-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Correction Tester'], root);
  run('git', ['config', 'user.email', 'correct@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('src/legacy.mjs', 'export const legacy = true;\n');
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the correction fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  cli('prepare', 'intake');
  // The plan names the wrong module: the value lives in src/value.mjs, not src/legacy.mjs.
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/legacy.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value, 2));", ''].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  const refused = attempt('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  assert.notEqual(refused.status, 0, 'the plan does not name the module the change lives in');
  assert.match(refused.stdout + refused.stderr, /src\/value\.mjs/u);

  const reason = 'The plan named src/legacy.mjs, but the approved value lives in src/value.mjs.';
  const replace = `${AC}=src/legacy.mjs:src/value.mjs`;
  // A preview records nothing.
  const preview = JSON.parse(cli('decision', 'plan', '--replace-location', replace, '--reason', reason, '--dry-run', '--json').stdout);
  assert.equal(preview.data.dryRun, true);
  assert.equal(preview.data.ownerPhase, 'intake');
  assert.deepEqual(preview.data.operations.map((operation) => [operation.op, operation.from, operation.to]),
    [['replace-location', 'src/legacy.mjs', 'src/value.mjs']]);
  // Recording needs a person's live terminal review; a script or agent cannot record it.
  const unattended = attempt('decision', 'plan', '--replace-location', replace, '--reason', reason, '--json');
  assert.notEqual(unattended.status, 0);
  assert.match(unattended.stdout + unattended.stderr, /direct terminal review/u);
  const mixed = attempt('decision', 'plan', '--replace-location', replace, '--add-location', `${AC}=src/x.mjs`, '--reason', reason);
  assert.match(mixed.stdout + mixed.stderr, /two decisions/u);
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).planAmendments, undefined, 'nothing was recorded');

  const reviewed = run(process.execPath, ['--input-type=module', '-e', RUNNER,
    JSON.stringify({ 'replace-location': replace, reason, json: true })], root);
  assert.match(reviewed.stderr, /REVIEWED \[\{"CORRECT-1:AC-001":\{"expectedPaths":\["src\/legacy\.mjs"\]/u, 'the reviewer saw the row before');
  const state = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.deepEqual(state.planAmendments.map((entry) => [entry.id, entry.kind, entry.ownerPhase]), [['PRC-001', 'plan-row-correction', 'intake']]);
  assert.equal(state.phases.intake.status, 'approved', 'the plan keeps its approval');
  assert.equal(state.phases.implementation.status, 'in_progress', 'the code step keeps its draft');
  assert.match(state.history.find((entry) => entry.event === 'plan_amended').detail, /^PRC-001 corrects intake: replace-location CORRECT-1:AC-001/u);
  assert.equal(run('git', ['status', '--porcelain', '--', 'src/value.mjs'], root).stdout.trim(), 'M src/value.mjs', 'the draft code is untouched');

  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  const after = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(after.phases.implementation.status, 'awaiting_approval');
  assert.equal(after.phases.intake.generation, 1, 'no step was reset');
});

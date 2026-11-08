/**
 * Spec–code sync M1 through a whole Story, from the terminal [SCS:REQ-010 to REQ-012]: a conformance row
 * marked deviated must say what differs, publishes as written, and holds the step's approval until a
 * person decides it on the decision list (fix the code, update the spec, accept it for now, or dismiss
 * it). Accepting it for now, recorded once, lets the step be approved.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { slowLane } from './helpers/slow-lane.mjs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { completeAgentResult } from '../src/agent-output.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false, as = null } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Decision Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
      SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(cwd, '.git/fixture-mode.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(cwd, '.git/fixture-selection.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(cwd, '.git/fixture-registry.json'),
      ...(as ? { SINGULARITY_FLOW_GITHUB_ACTOR: as } : {}) }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('a deviated conformance row says what differs, holds approval, and is decided once on the decision list', slowLane({ timeout: 900_000 }), async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scs-differences-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const W = 'DIFF-1';
  const [AC1, AC2] = [`${W}:AC-001`, `${W}:AC-002`];
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const cliAs = (as, ...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { as });
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const attemptAs = (as, ...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true, as });
  const json = (result) => JSON.parse(result.stdout);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const source = (value) => `// @clause:${AC1} returns the approved value\n// @clause:${AC2} keeps the module export named value\nexport const value = ${value};\n`;
  const check = (value, tagged) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", ...(tagged ? [`// @ac:${AC1}`, `// @ac:${AC2}`] : []),
    `test('value', () => assert.equal(value, ${value}));`, ''].join('\n');
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Decision Tester'], root);
  run('git', ['config', 'user.email', 'decider@example.invalid'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', check(1, false));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Only a named person approves Testing (and so may reuse a run for it); anyone approves the rest.
  config.approvalAuthorities['quality-reviewers'] = { label: 'Quality reviewers', allowAnyGitIdentity: false,
    members: [{ githubLogin: 'release-reviewer' }] };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the decision list fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const plan = completeAgentResult(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Change the value', '--description', 'Return the approved value 2.');
  const item = path.join(root, 'singularity/work-items', W);
  const workflow = () => readFile(path.join(item, 'workflow.json'), 'utf8').then(JSON.parse);

  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — Classic delivery intake`, '', '## Request and outcome', '',
    'Return the approved new value 2 to every caller; retain the exported API.', '',
    '## Scope and constraints', '', 'Change only the value module and its executable unit test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${AC1}] | The exported value equals 2. |`, `| [${AC2}] | The module still exports a binding named value. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${AC1}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${AC2}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and executable test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is the new value 2 the approved outcome?',
    '--answer', 'Yes; keep the exported interface and add the matching unit test.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await write('src/value.mjs', source(2));
  await write('test/value.test.mjs', check(2, true));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The clause-tagged value module and acceptance-tagged unit test now prove the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const recorded = (await workflow()).phases.implementation.deliveryEvidence.testExecutions.find((entry) => entry.attemptId);
  assert.equal(recorded.status, 'passed');

  cli('prepare', 'testing');
  const testing = path.join(item, (await workflow()).phases.testing.requiredArtifact.path);
  await writeFile(testing, (await readFile(testing, 'utf8')).replace(/TODO:[^\n]*/gu,
    `Verified ${AC1} and ${AC2}: 15 tests passed when run by hand.`).replace(/\bTODO\b/gu, 'matched'));
  cli('phase', 'publish', 'testing', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'testing');
  cliAs('release-reviewer', 'approve', 'testing', '--yes');

  cli('prepare', 'conformance');
  const report = path.join(item, (await workflow()).phases.conformance.requiredArtifact.path);
  const sampleRow = `| \`${AC1}\` | TODO | TODO | TODO | TODO: matched/partial/missing/deviated/unplanned | TODO |`;
  const base = await readFile(report, 'utf8');
  assert.ok(base.includes(sampleRow), 'the report template provides the sample clause row');
  const written = (deviation) => base.replace(sampleRow, [
    `| \`${AC1}\` | Exported value equals 2 | \`src/value.mjs\` @clause:${AC1} | \`test/value.test.mjs\` @ac:${AC1} | deviated | ${deviation} |`,
    `| \`${AC2}\` | Export keeps its name | \`src/value.mjs\` @clause:${AC2} | \`test/value.test.mjs\` @ac:${AC2} | matched | none |`
  ].join('\n')).replace(/TODO:[^\n]*/gu, `Compared ${AC1} and ${AC2} against the approved Code generation and its committed receipt.`)
    .replace(/\bTODO\b/gu, 'none');

  // A deviated row that does not say what differs is the author's to repair before publishing.
  await writeFile(report, written(''));
  const unstated = json(attempt('phase', 'draft-check', 'conformance', '--json'));
  assert.ok(JSON.stringify(unstated).includes('conformance.deviation-unstated'), 'the draft check names the row with no difference');
  await writeFile(report, written('the module exports 3 for callers in the legacy path; the clause says 2 everywhere'));
  cli('prepare', 'conformance');
  cli('phase', 'publish', 'conformance', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'conformance');

  // Approval waits on a person's decision for the deviated row, as it would for a partial one.
  const refusal = json(attempt('approve', 'conformance', '--yes', '--json'));
  assert.equal(refusal.error.code, 'CONFORMANCE_BLOCKING_VERDICTS');
  assert.match(refusal.error.message, /decides each partial, missing, deviated or unplanned clause/u);
  const packet = json(cli('decisions', W, '--json')).data;
  const item0 = packet.items.find((entry) => entry.kind === 'conformance-gap');
  assert.match(item0.title, /AC-001 is deviated in the Conformance report|AC-001 is deviated in the .* report/u);
  assert.match(item0.why, /the module exports 3 for callers in the legacy path/u);
  assert.deepEqual(item0.options.map((entry) => entry.id), ['fix-code', 'update-spec', 'accept-risk', 'dismiss']);
  assert.match(item0.options.find((entry) => entry.id === 'update-spec').action.command, new RegExp(`story intent-amendment draft --clause ${AC1}`, 'u'));
  assert.match(item0.options.find((entry) => entry.id === 'fix-code').action.command, /reject conformance .*--to implementation/u);

  // Accepted for now, recorded once from the list, the step can be approved.
  const done = json(cli('decisions', 'record', W, '--choose', 'd1=accept-risk', '--confirm', packet.packetSha256, '--json'));
  assert.ok(done.ok !== false, JSON.stringify(done).slice(0, 400));
  assert.equal(json(cli('decisions', W, '--json')).data.items.some((entry) => entry.kind === 'conformance-gap'), false);
  cli('approve', 'conformance', '--yes');
  assert.equal((await workflow()).phases.conformance.status, 'approved');
});

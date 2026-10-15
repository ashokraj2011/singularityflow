/**
 * A finding the author cannot fix is disputed, accepted live by the step's approvers, and honoured
 * as an exception for exactly that candidate. `[recoverable-findings M2]`
 *
 * An Android Story looped on CODE_DELIVERY_EVIDENCE_REQUIRED: its tests ran, but the check did not
 * recognise them, so no edit could pass. Owner decision (2026-10-15): the step's approvers may accept
 * the exact finding on evidence, as an exception, never a pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Dispute Tester' };
delete ENV.SINGULARITY_FLOW_NO_MODEL;
const W = 'DISPUTE-1'; const AC = `${W}:AC-001`;
// A correct test in a folder the gate does not recognise: the finding cannot be fixed by editing.
const TEST_PATH = 'checks/value-test.mjs';

async function story(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dispute-'));
  const remote = `${root}.git`;
  const removed = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  t.after(() => Promise.all([rm(root, removed), rm(remote, removed)]));
  const run = (command, args, extra = {}) => spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...ENV, ...extra } });
  const must = (command, args) => {
    const result = run(command, args);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const cli = (...args) => must(process.execPath, [CLI, '--no-model', ...args]);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args]);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const testSource = (expected, tagged) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", ...(tagged ? [`// @ac:${AC}`] : []),
    `test('value', () => assert.equal(value, ${expected}));`, ''].join('\n');
  must('git', ['init', '-q', '-b', 'main']);
  must('git', ['config', 'user.name', 'Dispute Tester']);
  must('git', ['config', 'user.email', 'dispute@example.test']);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: `node --test ${TEST_PATH}` } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write(TEST_PATH, testSource(1, false));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-qm', 'Initialize the dispute fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  must('git', ['remote', 'add', 'origin', remote]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — intake`, '', '## Request and outcome', '',
    'Return the approved value 2 to every caller.', '', '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`${TEST_PATH}\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write(TEST_PATH, testSource(2, true));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  // The evidence a person would attach: the test ran and passed.
  // Outside this test runner's own child protocol, so the output is the ordinary report.
  const plain = { ...ENV }; delete plain.NODE_TEST_CONTEXT;
  const output = spawnSync(process.execPath, ['--test', TEST_PATH], { cwd: root, encoding: 'utf8', env: plain });
  assert.equal(output.status, 0, output.stdout + output.stderr);
  await write('.sflow/dispute/test-output.txt', output.stdout);
  return { root, run, cli, attempt, write, testSource };
}

const EXPIRES = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
const REASON = 'The acceptance test exists and passes; the gate does not recognise the checks folder.';
const disputeArgs = ['--phase', 'implementation', '--finding', 'CODE_DELIVERY_EVIDENCE_REQUIRED',
  '--evidence-file', '.sflow/dispute/test-output.txt', '--evidence-file', TEST_PATH, '--expires', EXPIRES, '--reason', REASON];

/** One of the step's approvers accepts the exact packet in a live terminal. */
function acceptLive(root, id, confirm) {
  const script = `set timeout 60\nspawn -noecho {*}$env(DISPUTE_COMMAND)\nexpect "Type Accept risk ${id} to confirm this exact action, or Enter to cancel:"\nsend -- "Accept risk ${id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`;
  const command = [process.execPath, CLI, '--no-model', 'appeal', 'risk-accept', ...disputeArgs, '--confirm', confirm, '--json']
    .map((value) => `{${value}}`).join(' ');
  return spawnSync('/usr/bin/expect', ['-c', script], { cwd: root, encoding: 'utf8', env: { ...ENV, DISPUTE_COMMAND: command } });
}

test('a disputed code-delivery finding is accepted live and honoured for exactly that candidate', { skip: !existsSync('/usr/bin/expect') }, async (t) => {
  const { root, cli, attempt, write, testSource } = await story(t);
  const publish = () => attempt('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');

  const refused = publish();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /no acceptance test is available for the implementation/u);
  assert.match(refused.stdout + refused.stderr, /Documentation: singularity-flow explain findings --section CODE_DELIVERY_EVIDENCE_REQUIRED/u);
  const preflight = JSON.parse(attempt('phase', 'prepublish', 'implementation', '--for-agent', '--json').stdout);
  const issue = JSON.stringify(preflight);
  assert.match(issue, /appeal risk-prepare --work-id DISPUTE-1 --phase implementation --finding CODE_DELIVERY_EVIDENCE_REQUIRED --evidence-file <PATH>/u,
    'the recovery routes offer the dispute to the step\'s approvers');

  const prepared = JSON.parse(cli('appeal', 'risk-prepare', ...disputeArgs, '--json').stdout).data.packet;
  assert.equal(prepared.gateMode, 'dispute');
  assert.equal(prepared.gate, 'CODE_DELIVERY_EVIDENCE_REQUIRED');
  assert.ok(prepared.problems.some((problem) => /no acceptance test is available/u.test(problem)));
  assert.deepEqual(prepared.evidence.map((item) => item.path), ['.sflow/dispute/test-output.txt', TEST_PATH]);
  assert.match(prepared.evidence[0].excerpt, /pass 1/u);
  const id = `PQR-${prepared.packetSha256.slice(7, 31)}`;

  const accepted = acceptLive(root, id, prepared.packetSha256);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /risk-accepted/u);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
  const record = workflow.qualityRiskDecisions.find((entry) => entry.id === id);
  assert.equal(record.testsWaived, false);
  assert.equal(record.phaseApproved, false);

  // A changed candidate is not covered: the exception binds the exact bytes a person reviewed.
  await write('src/value.mjs', `// @clause:${AC} returns the approved value, changed after review\nexport const value = 2;\n`);
  const changed = publish();
  assert.notEqual(changed.status, 0, 'a changed candidate needs a fresh dispute');
  assert.match(changed.stdout + changed.stderr, /no acceptance test is available/u);
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write(TEST_PATH, testSource(2, true));

  const published = publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const gate = attempt('gate', '--json');
  assert.match(gate.stdout + gate.stderr, new RegExp(`Accepted disputed finding ${id}: CODE_DELIVERY_EVIDENCE_REQUIRED in implementation generation 1`, 'u'));
  assert.match(gate.stdout + gate.stderr, /This is an exception, not passing evidence\./u);
});

test('a dispute covers only a code-delivery finding, and needs evidence and a real reason', async (t) => {
  const { attempt } = await story(t);
  const without = attempt('appeal', 'risk-prepare', '--phase', 'implementation', '--finding', 'CODE_DELIVERY_EVIDENCE_REQUIRED',
    '--expires', EXPIRES, '--reason', REASON, '--json');
  assert.notEqual(without.status, 0);
  assert.match(without.stdout + without.stderr, /--evidence-file/u);
  const short = attempt('appeal', 'risk-prepare', ...disputeArgs.slice(0, -1), 'too short', '--json');
  assert.notEqual(short.status, 0);
  assert.match(short.stdout + short.stderr, /at least 20 characters/u);
  const elsewhere = attempt('appeal', 'risk-prepare', '--phase', 'implementation', '--finding', 'CODE_DELIVERY_EVIDENCE_REQUIRED',
    '--evidence-file', '../outside.txt', '--expires', EXPIRES, '--reason', REASON, '--json');
  assert.notEqual(elsewhere.status, 0);
});

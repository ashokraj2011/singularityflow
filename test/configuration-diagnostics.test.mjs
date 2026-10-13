import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyWorkflowCompatibility, initializeDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { isAgentTemplateReference } from '../src/agents.mjs';
import { diagnoseWorkflowText, formatConfigurationProblems, locateMessage, plainConfigurationMessage } from '../src/configuration-diagnostics.mjs';
import YAML from 'yaml';

const packaged = await readFile(fileURLToPath(new URL('../templates/workflow.yml', import.meta.url)), 'utf8');
const swap = (text, from, to) => { assert.ok(text.includes(from), `fixture anchor missing: ${from}`); return text.replace(from, () => to); };
const TYPO = ['phases: [intake, requirements, design, implementation-spec, implementation, verification, conformance]',
  'phases: [intake, requirments, design, implementation-spec, implementation, verification, conformance]'];
const INPUT = ['      requirements: { inputs: [intake] }', '      requirements: { inputs: [intak] }'];
const TEMPLATE = ['      intake: feature/intake.md', '      intake: feature/intake-missing.md'];
const INDENT = ['  feature:\n    label: Feature\n', '  feature:\n     label: Feature\n'];
const lineOf = (text, fragment) => text.split('\n').findIndex(line => line.includes(fragment)) + 1;

async function diagnose(text, root = null) {
  return diagnoseWorkflowText(text, { root, validate: definition => validateDefinition(definition), prepare: applyWorkflowCompatibility,
    resolveWorkType, isAgentTemplateReference });
}

test('the packaged workflow has no problems', async () => {
  assert.deepEqual(await diagnose(packaged), []);
});

test('every problem is reported at once, at its line, with a did-you-mean and one concrete fix', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  let text = packaged;
  for (const [from, to] of [TYPO, INPUT, TEMPLATE]) text = swap(text, from, to);
  const problems = await diagnose(text, root);
  assert.deepEqual(problems.map(problem => problem.line), [lineOf(text, 'requirments'), lineOf(text, 'intake-missing'), lineOf(text, '[intak]')]);
  const [typo, template, input] = problems;
  assert.match(typo.message, /lists phase 'requirments', but no phase with that ID is defined under phases\. Did you mean 'requirements'\?/);
  assert.equal(typo.fix, "Change 'requirments' to 'requirements'.");
  assert.deepEqual(typo.path, ['workTypes', 'feature', 'phases', 1]);
  assert.match(input.message, /takes input from 'intak', which is not one of the phases this work type lists\. Did you mean 'intake'\?/);
  assert.equal(input.validatorMessage, "Work type 'feature' phase 'requirements' input references inactive phase 'intak'.");
  assert.equal(template.code, 'WORKFLOW_TEMPLATE_MISSING');
  assert.match(template.fix, /feature\/intake\.md/);
  // One misspelled phase is one problem: the overrides and inputs that name the real phase are not repeated.
  assert.equal(problems.filter(problem => /requirements/.test(problem.validatorMessage ?? '') && problem !== input).length, 0);
});

test('a misindented line is one problem with the indentation it belongs at, not a cascade', async () => {
  const text = swap(packaged, ...INDENT);
  const problems = await diagnose(text);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, lineOf(text, '     label: Feature'));
  assert.match(problems[0].fix, /indented 5 spaces; it belongs with lines indented 4/);
  assert.match(problems[0].code, /^YAML_/);
});

test('YAML mistakes are explained in plain words: tabs, duplicates and enumerated values', async () => {
  const tab = await diagnose('version: 2\nauto:\n\tenabled: false\n');
  assert.match(tab[0].message, /tab/i);
  const duplicate = await diagnose('a: 1\nb: 2\na: 3\n');
  assert.equal(duplicate[0].line, 3);
  assert.match(duplicate[0].fix, /first is on line 1/);
  const enumerated = await diagnose(swap(packaged, 'assignmentMode: suggested', 'assignmentMode: sugested'));
  assert.equal(enumerated.length, 1);
  assert.match(enumerated[0].message, /Did you mean 'suggested'\?/);
});

test('validator messages are located under the names they mention and reworded without jargon', () => {
  const document = YAML.parseDocument('workTypes:\n  a:\n    phases: [x]\n  b:\n    phases: [x]\n');
  assert.deepEqual(locateMessage(document, "Work type 'b' references unknown phase 'x'.").path, ['workTypes', 'b', 'phases', 0]);
  assert.equal(locateMessage(document, "Nothing named 'zzz'."), null);
  assert.doesNotMatch(plainConfigurationMessage("Work type 'a' has an override for inactive phase 'x'."), /inactive/);
  const lines = formatConfigurationProblems([{ file: 'singularity/workflow.yml', line: 3, message: 'Bad.', source: '    phases: [x]', fix: 'Do this.' }]);
  assert.deepEqual(lines, ['singularity/workflow.yml has 1 problem:', '  singularity/workflow.yml, line 3: Bad.', '    | phases: [x]', '    Fix: Do this.']);
});

test('the CLI lists every problem with its line, a plan to fix the first, and the same problems in JSON', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-diagnostics-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await initializeDefinition(root);
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['-c', 'user.name=Config Tester', '-c', 'user.email=config@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1' };
  const valid = spawnSync(process.execPath, [cli, 'configuration', 'validate'], { cwd: root, encoding: 'utf8', env, timeout: 60000 });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^Configuration is valid: \d+ work type\(s\), \d+ phase\(s\), \d+ agent\(s\)\.\n$/);
  const file = path.join(root, 'singularity/workflow.yml');
  let text = await readFile(file, 'utf8');
  for (const [from, to] of [TYPO, INPUT]) text = swap(text, from, to);
  await writeFile(file, text);
  const refused = spawnSync(process.execPath, [cli, 'configuration', 'validate'], { cwd: root, encoding: 'utf8', env, timeout: 60000 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /singularity\/workflow\.yml has 2 problems:/);
  assert.match(refused.stderr, new RegExp(`singularity/workflow\\.yml, line ${lineOf(text, 'requirments')}: .*Did you mean 'requirements'\\?`));
  assert.match(refused.stderr, /Fix: Change 'intak' to 'intake'\./);
  assert.match(refused.stderr, /1\. Fix singularity\/workflow\.yml, line \d+: Change 'requirments' to 'requirements'\. Then fix the other problem listed above\./);
  assert.match(refused.stderr, /Shell: singularity-flow configuration validate/);
  assert.doesNotMatch(refused.stderr, /factory-reset|configuration --help/);
  const json = spawnSync(process.execPath, [cli, 'configuration', 'validate', '--json'], { cwd: root, encoding: 'utf8', env, timeout: 60000 });
  const envelope = JSON.parse(json.stdout);
  assert.deepEqual(envelope.error.details.configurationProblems.map(problem => [problem.line, problem.suggestion]),
    [[lineOf(text, 'requirments'), 'requirements'], [lineOf(text, '[intak]'), 'intake']]);
  const doctor = spawnSync(process.execPath, [cli, 'doctor'], { cwd: root, encoding: 'utf8', env, timeout: 120000 });
  assert.match(doctor.stdout + doctor.stderr, /initialization-assets: All packaged initialization assets are present, but the workflow configuration does not load/);
  assert.doesNotMatch(doctor.stdout + doctor.stderr, /0 packaged initialization asset\(s\) are missing/);
});

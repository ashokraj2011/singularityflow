/**
 * Targeted spec → code: an approved intent amendment keeps the approvals it cannot have touched
 * (rule E8), and a clause it removes leaves no unnoticed tags behind.
 *
 * The fixture adds an approved fix-design step between quick-fix's intake (the scope) and implement.
 * The design cites QN-n:AC-002 only, so an amendment of AC-001 cannot have changed what it decided.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { EQUIVALENCE_RULES } from '../src/evidence/equivalence-rules.mjs';
import { currentlyRemovedClauses } from '../src/spec-drift.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-amendment-retention-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'E8 Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'E8 Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'e8@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  // An earlier note still tags QN-3:AC-002; QN-3's amendment removes that clause.
  await writeFile(path.join(root, 'src/legacy.mjs'), '// @clause:QN-3:AC-002 the module keeps one export\nexport const legacy = true;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  delete config.phases['fix-design'].clarification;
  config.workTypes['quick-design'] = { ...config.workTypes['quick-fix'], phases: ['intake', 'fix-design', 'implement', 'verify'] };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Amendment retention fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const itemPath = (id, ...parts) => path.join(root, 'singularity/work-items', id, ...parts);
  const workflow = async (id) => JSON.parse(await readFile(itemPath(id, 'workflow.json'), 'utf8'));
  const intake = (id) => [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${id}:AC-001] | The exported value equals 2. |`, `| [${id}:AC-002] | The value module stays a single export. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
    `| \`${id}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  // A Story through intake and an approved fix-design that cites only AC-002.
  const designed = async (id) => {
    sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake');
    await writeFile(itemPath(id, 'artifacts/intake/intake.md'), intake(id));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'intake');
    sflow('approve', 'intake', '--yes');
    sflow('prepare', 'fix-design');
    await writeFile(itemPath(id, 'artifacts/fix-design/fix-design.md'), [`# ${id} — Fix Design`, '', '## Root cause', '',
      'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
      `Change the literal in src/value.mjs only. ${id}:AC-002 keeps the module to a single export, so no import changes.`, '',
      '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'fix-design');
    sflow('approve', 'fix-design', '--yes');
    assert.equal((await workflow(id)).currentPhase, 'implement');
  };
  const amend = async (id, transform, reason) => {
    const file = path.join(base, `${id}-amended.md`);
    await writeFile(file, transform(await readFile(itemPath(id, 'artifacts/intake/intake.md'), 'utf8')));
    const proposed = JSON.parse(sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', reason, '--json'));
    return { proposed, decided: sflow('story', 'intent-amendment', 'decide', proposed.proposal.id, '--decision', 'approve', '--confirm', proposed.proposal.id) };
  };
  return { root, sflow, run, workflow, designed, amend };
}

test('rule E8 is in the closed set and says what it keeps', () => {
  assert.deepEqual(Object.keys(EQUIVALENCE_RULES), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);
  assert.equal(EQUIVALENCE_RULES.E8.name, 'unaffected by an intent amendment');
});

test('a removal followed by a re-addition leaves the clause in place', () => {
  assert.deepEqual(currentlyRemovedClauses({ scopeRevisions: [
    { changes: { removed: ['A:AC-002', 'A:AC-003'], added: [] } },
    { changes: { removed: [], added: ['A:AC-003'] } }
  ] }), ['A:AC-002']);
});

test('an amendment keeps the approval of a step it cites nothing of, refreshes one it cites, and the Story still closes', { timeout: 300_000 }, async (t) => {
  const f = await fixture(t);

  // QN-1: AC-001 changes; fix-design cites only AC-002, so its approval stands (rule E8).
  await f.designed('QN-1');
  const { decided } = await f.amend('QN-1', (text) => text.replace('The exported value equals 2.', 'The exported value equals 2 and is a number.'), 'Say the value is numeric.');
  assert.match(decided, /Kept the approval of fix-design \(rule E8\): the amendment changed none of the clauses its artifacts cite/u);
  const kept = await f.workflow('QN-1');
  assert.equal(kept.phases['fix-design'].status, 'approved');
  assert.equal(kept.phases['fix-design'].retention.rule, 'E8');
  assert.equal(kept.phases['fix-design'].approvals.filter((approval) => !approval.invalidatedAt).length, 1, 'its approval was never invalidated');
  assert.equal(kept.currentPhase, 'implement');
  assert.equal(kept.phases.implement.status, 'in_progress');
  assert.deepEqual(kept.intentAmendments[0].retainedPhases, ['fix-design']);
  assert.ok(kept.history.some((entry) => entry.event === 'phase_retained' && entry.phase === 'fix-design' && /rule E8/u.test(entry.detail)));

  // The retained step carries the Story to its end: every later gate accepts it.
  f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  f.sflow('resume', 'QN-1');
  f.sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(f.root, 'src/value.mjs'), '// @clause:QN-1:AC-001 the exported value is the number 2\n// @clause:QN-1:AC-002 the single export stays\nexport const value = 2;\n');
  await writeFile(path.join(f.root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n"
    + "// @ac:QN-1:AC-001\ntest('value', () => assert.equal(value, 2));\n// @ac:QN-1:AC-002\ntest('one export', async () => assert.deepEqual(Object.keys(await import('../src/value.mjs')), ['value']));\n");
  f.sflow('prepare', 'implement');
  f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
  f.sflow('submit', 'implement');
  f.sflow('prepare', 'verify');
  f.sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
  f.sflow('submit', 'verify');
  if ((await f.workflow('QN-1')).phases.verify.status !== 'approved') assert.match(f.sflow('approve', 'verify', '--yes'), /Final Flow Gate passed/u);
  assert.equal((await f.workflow('QN-1')).status, 'closed');

  // QN-2: AC-002 changes; fix-design cites it, so it runs again as before.
  await f.designed('QN-2');
  const cited = await f.amend('QN-2', (text) => text.replace('The value module stays a single export.', 'The value module keeps exactly one named export.'), 'Tighten the export clause.');
  assert.doesNotMatch(cited.decided, /rule E8/u);
  const refreshed = await f.workflow('QN-2');
  assert.equal(refreshed.phases['fix-design'].status, 'in_progress');
  assert.equal(refreshed.phases['fix-design'].retention ?? null, null);
  assert.equal(refreshed.currentPhase, 'fix-design');
});

test('a clause an amendment removes is named wherever a tag still claims it', { timeout: 300_000 }, async (t) => {
  const f = await fixture(t);
  await f.designed('QN-3');
  await f.amend('QN-3', (text) => text.split('\n').filter((line) => !line.includes('QN-3:AC-002')).join('\n')
    .replace(/QN-3:AC-002 keeps/u, 'The module keeps'), 'The single-export rule is no longer a requirement.');
  f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  f.sflow('resume', 'QN-3');
  // The amendment invalidated fix-design (it cited AC-002); it is revalidated before code.
  const story = await f.workflow('QN-3');
  assert.deepEqual(story.scopeRevisions.at(-1).changes.removed, ['QN-3:AC-002']);
  if (story.currentPhase === 'fix-design') {
    f.sflow('prepare', 'fix-design');
    const design = path.join(f.root, 'singularity/work-items/QN-3/artifacts/fix-design/fix-design.md');
    await writeFile(design, (await readFile(design, 'utf8')).replace('QN-3:AC-002 keeps the module to a single export, so no import changes.', 'No import changes.'));
    f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    f.sflow('submit', 'fix-design');
    f.sflow('approve', 'fix-design', '--yes');
  }
  f.sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(f.root, 'src/value.mjs'), '// @clause:QN-3:AC-001 the exported value is 2\nexport const value = 2;\n');
  const prepublish = JSON.parse(f.sflow('phase', 'prepublish', 'implement', '--json'));
  const advisories = (prepublish.advisories ?? []).filter((advisory) => advisory.code === 'spec.removed-clause-tag');
  assert.equal(advisories.length, 1, JSON.stringify((prepublish.advisories ?? []).map((advisory) => advisory.code)));
  assert.match(advisories[0].message, /^@clause:QN-3:AC-002 at src\/legacy\.mjs:1 names a clause the specification removed; .*Advisory only\.$/u);
  assert.equal(advisories[0].blocking, false);
});

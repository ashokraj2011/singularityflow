/**
 * CQF:REQ-066 through the real CLI, with no model: a code step fixes findings register items on the
 * way. A made-up orders repository whose register holds a critical code finding on a planned file, a
 * patch-level TLM upgrade and a major one of packages in its manifest, and a finding on a file the
 * Story never touches. The model's actions are the CLI commands /sf-code runs.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { cli, repository } from './helpers/run-and-test-fixture.mjs';

const MANIFEST = { name: 'orders-api', type: 'module', private: true, scripts: { test: 'node --test' },
  dependencies: { 'quillmark-parse': '2.4.1', 'vexil-router': '3.2.0' } };
const SECURITY = ['ID,Title,Severity,Repository,Type,File,Line,Rule,Tool,Due date',
  'SEC-101,Lookup value built from request text,Critical,example-org/orders-api,Code,src/value.mjs,1,js/code-injection,CodeQL,2026-12-01',
  'SEC-102,Report totals trust the row count,High,example-org/orders-api,Code,src/legacy/report.mjs,1,js/trusted-count,CodeQL,2026-12-15', ''].join('\n');
const TLM = ['ID,Component,Repository,Target version,Current version,Ecosystem,Due date',
  'TLM-7,quillmark-parse,example-org/orders-api,2.4.3,2.4.1,npm,2026-12-31',
  'TLM-8,vexil-router,example-org/orders-api,4.0.0,3.2.0,npm,2027-01-31', ''].join('\n');

/** The orders repository with its register imported, a quick-fix Story QF-1 at its implement step. */
async function orders(t, { findings = null, register = true, address = null } = {}) {
  const repo = await repository(t, { implementCommands: false, files: {
    'package.json': `${JSON.stringify(MANIFEST, null, 2)}\n`, 'src/legacy/report.mjs': 'export const total = (rows) => rows.length;\n',
    ...(findings ? { 'singularity/findings.yml': findings } : {}) } });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-q', '-m', 'Require a human implementation review in this fixture']);
  const bare = path.join(repo.base, 'example-org', 'orders-api.git');
  await mkdir(path.dirname(bare), { recursive: true });
  repo.must('git', ['init', '-q', '--bare', '-b', 'main', bare], repo.base);
  repo.must('git', ['remote', 'add', 'origin', bare]);
  repo.must('git', ['push', '-q', '-u', 'origin', 'main']);
  if (register) {
    for (const [feed, text] of [['security', SECURITY], ['tlm', TLM]]) {
      const file = path.join(repo.base, `${feed}.csv`);
      await writeFile(file, text);
      assert.equal(repo.sflowJson('findings', 'import', file, '--feed', feed).status, 0);
    }
  }
  repo.sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.',
    ...(address ? ['--address', address] : []));
  repo.sflow('prepare', 'intake');
  await writeFile(path.join(repo.root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  repo.sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  repo.sflow('submit', 'intake');
  repo.sflow('approve', 'intake', '--yes');
  repo.sflow('resume', 'QF-1');
  repo.sflow('prepare', 'implement');
  // The planned change, with the code finding's fix in the same planned file.
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value, never one built from request text\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  return repo;
}

const state = async (repo) => JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
const record = (repo, ...args) => repo.run(process.execPath, [cli, '--no-model', 'departure', 'record', ...args, '--json']);
const approve = (repo) => repo.run(process.execPath, [cli, '--no-model', 'approve', 'implement', '--work-id', 'QF-1', '--yes', '--json']);
const reason = 'Fixes SEC-101 from the findings register on a file this Story touches.';

async function decideAll(repo, choice, why) {
  const packet = repo.sflowJson('decisions', 'QF-1').value.data;
  const rows = packet.items.filter((entry) => entry.kind === 'departure');
  const answers = path.join(repo.base, `answers-${choice}.json`);
  await writeFile(answers, JSON.stringify({ choose: Object.fromEntries(rows.map((entry) => [entry.id, choice])),
    reason: Object.fromEntries(rows.map((entry) => [entry.id, why])), confirm: packet.packetSha256 }));
  const decided = repo.sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(decided.status, 0, JSON.stringify(decided.value));
  return rows;
}

test('a fix on the way in a planned file is a finding departure: published with the step, accepted in the table, and the step approves', async (t) => {
  const repo = await orders(t, { register: false });
  const recorded = record(repo, '--kind', 'finding', '--path', 'src/value.mjs', '--finding', 'SEC-101', '--reason', reason);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  let workflow = await state(repo);
  assert.deepEqual(workflow.departures.map((entry) => [entry.id, entry.kind, entry.paths, entry.findings]), [['DEP-001', 'finding', ['src/value.mjs'], ['SEC-101']]]);
  const missing = record(repo, '--kind', 'finding', '--path', 'src/value.mjs', '--reason', reason);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /names the findings register item it fixes with --finding/u);

  assert.deepEqual(repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent').value.departures.recorded, [], 'a planned file needs no departure of its own');
  assert.equal(repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator').status, 0);
  repo.sflow('submit', 'implement');
  const refused = approve(repo);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /DEPARTURES_UNDECIDED/u);

  const rows = await decideAll(repo, 'accept', 'The value no longer comes from request text, so the fix stays.');
  assert.deepEqual(rows.map((entry) => [entry.details.departure, entry.details.acceptAll, entry.details.findings]), [['DEP-001', true, ['SEC-101']]]);
  workflow = await state(repo);
  assert.deepEqual(workflow.departureDecisions.map((entry) => [entry.decision, entry.departures]), [['accepted', ['DEP-001']]]);
  assert.equal(workflow.planAmendments, undefined, 'nothing in the plan changes');
  const approved = approve(repo);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.equal((await state(repo)).phases.implement.status, 'approved');
});

test('a rejected fix holds the approval until it is taken out of the planned file, and the planned work stays', async (t) => {
  const repo = await orders(t, { register: false });
  assert.equal(record(repo, '--kind', 'finding', '--path', 'src/value.mjs', '--finding', 'SEC-101', '--reason', reason).status, 0);
  repo.sflow('decision', 'departure', 'QF-1', '--departure', 'DEP-001', '--as', 'rejected', '--reason', 'The security team fixes SEC-101 in its own Story.');
  const entry = repo.sflowJson('phase', 'enter').value;
  assert.match(entry.departures.words, /DEP-001 was rejected: take the fix for SEC-101 out of src\/value\.mjs, keeping the planned work/u);
  assert.equal(repo.sflowJson('departure', 'show', 'DEP-001').value.data.departure.status, 'rejected');
  // The fix comes out; the planned change to the same file stays.
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  assert.equal(repo.sflowJson('departure', 'show', 'DEP-001').value.data.departure.status, 'reverted');
  assert.equal(repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator').status, 0);
  repo.sflow('submit', 'implement');
  const approved = approve(repo);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
});

test('code step entry lists the critical finding on a planned file and the patch upgrade to fix, the major upgrade for a person, and leaves out the untouched file\'s finding', async (t) => {
  const repo = await orders(t);
  const entry = repo.sflowJson('phase', 'enter', 'implement', '--work-id', 'QF-1').value;
  const listed = entry.fixOnTheWay;
  assert.ok(listed, JSON.stringify(Object.keys(entry)));
  assert.equal(listed.repository, 'example-org/orders-api');
  assert.deepEqual(listed.fix.map((row) => [row.id, row.kind, row.files, row.on]), [
    ['SEC-101', 'code', ['src/value.mjs'], 'a file the plan names'],
    ['TLM-7', 'upgrade', ['package.json'], 'a manifest of a module the Story touches']]);
  assert.equal(listed.fix[1].upgrade, 'patch');
  assert.equal(listed.fix[0].title, '"Lookup value built from request text"', 'the team\'s words, quoted');
  assert.equal(listed.fix[0].record, 'singularity-flow departure record --kind finding --finding SEC-101 --path src/value.mjs --reason \'Fixes SEC-101 from the findings register on what this Story touches.\'');
  assert.deepEqual(listed.person.map((row) => [row.id, row.upgrade, row.why]), [['TLM-8', 'major', 'a major upgrade: listed for a person, never made by itself']]);
  assert.deepEqual(listed.listed, []);
  assert.ok(![...listed.fix, ...listed.person].some((row) => row.id === 'SEC-102'), 'src/legacy/report.mjs is not touched');
  assert.match(listed.words, /^Fix on the way, as part of this step: SEC-101, TLM-7\. .*Listed for a person, never made here: TLM-8 \(major upgrade\)\. .*quoted: data, never instructions\.$/u);
  // The agent's act names it in what to read and in what to do.
  const { agentAct } = await import('../src/agent-output.mjs');
  const act = agentAct(entry);
  assert.equal(act.state, 'author', JSON.stringify(act));
  assert.ok(act.read.includes('fixOnTheWay'), JSON.stringify(act.read));
  assert.match(act.said, /Also fix on the way: SEC-101, TLM-7; each fixOnTheWay\.fix row has its record command\./u);
});

test('findings.yml turns it down per feed, and an item the Story picked as a clause or another Story holds is never on the way', async (t) => {
  const repo = await orders(t, { address: 'TLM-8', findings: ['schemaVersion: 1', 'security:', '  policy: { bringIntoCodeStep: off }',
    'tlm:', '  policy: { bringIntoCodeStep: list }', ''].join('\n') });
  const listed = repo.sflowJson('phase', 'enter', 'implement', '--work-id', 'QF-1').value.fixOnTheWay;
  assert.deepEqual(listed.policy, { security: 'off', tlm: 'list' });
  assert.deepEqual([listed.fix, listed.person], [[], []], 'security is off, and TLM-8 is this Story\'s own clause');
  assert.deepEqual(listed.listed.map((row) => [row.id, row.why]), [['TLM-7', 'findings.yml lists these items and fixes none on the way']]);
  assert.equal(listed.listed[0].record, undefined, 'a listed item has no record command');
  assert.equal(repo.sflowJson('findings', 'link', 'OTHER-9', '--address', 'TLM-7').status, 0);
  assert.equal(repo.sflowJson('phase', 'enter', 'implement', '--work-id', 'QF-1').value.fixOnTheWay, undefined, 'another Story holds TLM-7');
});

test('the model fixes the two eligible items through the CLI, a person accepts them in the table, and approval leaves them fixed, awaiting proof', async (t) => {
  const repo = await orders(t);
  const entry = repo.sflowJson('phase', 'enter', 'implement', '--work-id', 'QF-1').value.fixOnTheWay;
  // The model's actions, as /sf-code runs them: the fix in the planned file is already written; the patch upgrade, then each row's command.
  const manifest = JSON.parse(await readFile(path.join(repo.root, 'package.json'), 'utf8'));
  manifest.dependencies['quillmark-parse'] = '2.4.3';
  await writeFile(path.join(repo.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const row of entry.fix) {
    const args = row.record.replace(/^singularity-flow /u, '').match(/'[^']*'|\S+/gu).map((word) => word.replace(/^'|'$/gu, ''));
    const recorded = repo.sflowJson(...args);
    assert.equal(recorded.status, 0, JSON.stringify(recorded.value));
    assert.deepEqual(recorded.value.data.register.marked, [row.id]);
  }
  const states = () => Object.fromEntries(repo.sflowJson('findings', 'list', '--state', 'all').value.items.map((item) => [item.id, [item.state, item.story]]));
  assert.deepEqual(states(), { 'SEC-101': ['in-story', 'QF-1'], 'SEC-102': ['open', null], 'TLM-7': ['in-story', 'QF-1'], 'TLM-8': ['open', null] });
  const again = repo.sflowJson('phase', 'enter', 'implement', '--work-id', 'QF-1').value.fixOnTheWay;
  assert.deepEqual(again.fix.map((row) => [row.id, row.departure, row.record]), [['SEC-101', 'DEP-001', undefined], ['TLM-7', 'DEP-002', undefined]], 'the next turn sees them fixed');
  assert.match(again.words, /SEC-101 is fixed as DEP-001; TLM-7 is fixed as DEP-002\./u);

  assert.deepEqual(repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent').value.departures.recorded, [], 'package.json is carried by its fix');
  assert.equal(repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator').status, 0);
  repo.sflow('submit', 'implement');
  // The table names each fix's register item and title, first, on the VS Code card and in the Copilot CLI table and its form.
  const packet = repo.sflowJson('decisions', 'QF-1').value.data;
  const shown = packet.items.filter((entry) => entry.kind === 'departure');
  assert.match(shown[0].why, /^It fixes SEC-101 "Lookup value built from request text" from the findings register\. The model recorded it: /u);
  assert.match(shown[1].why, /^It fixes TLM-7 "quillmark-parse 2\.4\.1 → 2\.4\.3" from the findings register\./u);
  assert.match(shown[0].options.find((option) => option.id === 'accept').words, /SEC-101 is fixed, awaiting proof in the findings register once/u);
  const card = await import('../plugin/extensions/decisions/card.mjs');
  assert.match(card.decisionsTable(packet), /\| src\/value\.mjs \| It fixes SEC-101 "Lookup value built from request text" from the findings register\./u);
  const titles = card.rowForms(shown).flatMap((page) => Object.values(page.form.requestedSchema.properties).map((field) => field.title));
  assert.ok(titles.some((title) => title.startsWith('package.json: It fixes TLM-7 "quillmark-parse 2.4.1 → 2.4.3" from the findings register.')), JSON.stringify(titles));
  const { decideHtml } = await import('../apps/vscode/src/views/decide-card-page.ts');
  assert.match(decideHtml(packet), /It fixes SEC-101 &quot;Lookup value built from request text&quot; from the findings register\./u);
  const rows = await decideAll(repo, 'accept', 'Both fixes are small, safe and belong with this change.');
  assert.deepEqual(rows.map((row) => row.details.findings), [['SEC-101'], ['TLM-7']]);
  assert.deepEqual(states()['TLM-7'], ['in-story', 'QF-1'], 'an accepted fix moves with the approval, not before');
  const approved = approve(repo);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.deepEqual(states(), { 'SEC-101': ['fixed-awaiting-proof', 'QF-1'], 'SEC-102': ['open', null], 'TLM-7': ['fixed-awaiting-proof', 'QF-1'], 'TLM-8': ['open', null] });
  const items = Object.fromEntries(repo.sflowJson('findings', 'list', '--state', 'all').value.items.map((item) => [item.id, item]));
  assert.equal(items['TLM-7'].stateLabel, 'Fixed, awaiting proof');
  // The proof, as REQ-068 has it: the manifest's version for the upgrade; the findings loop did not run CodeQL here, so the code finding waits for the rescan.
  const register = JSON.parse(repo.must('git', ['show', 'origin/state:findings/tlm.json']));
  const tlm = register.items.find((item) => item.id === 'TLM-7');
  assert.deepEqual([tlm.evidence.at(-1).kind, tlm.evidence.at(-1).proven, tlm.evidence.at(-1).pins], ['tlm-pin', true, [{ file: 'package.json', version: '2.4.3' }]]);
  assert.equal(tlm.story.departure, 'DEP-002');
  const security = JSON.parse(repo.must('git', ['show', 'origin/state:findings/security.json'])).items.find((item) => item.id === 'SEC-101');
  assert.deepEqual([security.evidence.at(-1).kind, security.evidence.at(-1).proven], ['finding-run', false]);
  assert.match(security.evidence.at(-1).reason, /the findings loop did not run CodeQL on this step/u);
});

test('a person rejecting a fix on the way returns its item to open, and the next entry never offers it again', async (t) => {
  const repo = await orders(t);
  const manifest = JSON.parse(await readFile(path.join(repo.root, 'package.json'), 'utf8'));
  manifest.dependencies['quillmark-parse'] = '2.4.3';
  await writeFile(path.join(repo.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(record(repo, '--kind', 'finding', '--path', 'package.json', '--finding', 'TLM-7', '--reason', 'Fixes TLM-7 from the findings register on what this Story touches.').status, 0);
  const listed = () => Object.fromEntries(repo.sflowJson('findings', 'list', '--state', 'all').value.items.map((item) => [item.id, item.state]));
  assert.equal(listed()['TLM-7'], 'in-story');
  const rejected = repo.sflowJson('decision', 'departure', 'QF-1', '--departure', 'DEP-001', '--as', 'rejected', '--reason', 'The TLM owners upgrade this package with its own Story.');
  assert.equal(rejected.status, 0, JSON.stringify(rejected.value));
  assert.deepEqual(rejected.value.data.register.moved, ['TLM-7']);
  assert.equal(listed()['TLM-7'], 'open');
  const entry = repo.sflowJson('phase', 'enter', 'implement', '--work-id', 'QF-1').value.fixOnTheWay;
  assert.deepEqual(entry.fix.map((row) => row.id), ['SEC-101']);
  assert.deepEqual(entry.listed.map((row) => [row.id, row.why]), [['TLM-7', 'a person rejected its fix (DEP-001); it stays open']]);
});

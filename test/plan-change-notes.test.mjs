/**
 * The next turn hears what a plan amendment changed, from the record, through the real CLI [bin-opr2]: after PAM-001
 * the next /sf-code still said "the approved plan has no amendment", and moved only when a person typed a sentence.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { planChangeNotes } from '../src/plan-amendment-notes.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

test('each amendment is named with what it still needs, read from the record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-plan-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'there.txt'), 'x');
  const workflow = { planAmendments: [
    { id: 'PAM-001', changes: [{ kind: 'add-supporting', path: '.nvmrc', class: 'build-configuration', reason: 'r' }] },
    { id: 'PAM-002', changes: [{ kind: 'add-location', clauseId: 'W-1:REQ-001', path: 'there.txt' }] }
  ] };
  const notes = await planChangeNotes(root, workflow);
  assert.equal(notes[0].words, 'PAM-001 added .nvmrc as a supporting change (build-configuration); .nvmrc does not exist yet, so create it.');
  assert.deepEqual(notes[0].missing, ['.nvmrc']);
  assert.equal(notes[1].words, 'PAM-002 added there.txt to W-1:REQ-001.');
  assert.deepEqual(notes[1].missing, []);
  assert.deepEqual(await planChangeNotes(root, {}), []);
});

test('phase enter says what the amendment added, and the file it still needs', slowLane({ timeout: 300_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow, sflowJson } = repo;
  await startQuickFix(repo);
  sflow('phase', 'begin', 'implement', '--json');
  const silent = sflowJson('phase', 'enter', '--compose', '--for-agent');
  assert.equal(silent.value.planChanges, undefined, 'a plan never amended says nothing');
  const reason = 'Tests here need Node 22, so the repository pins it.';
  sflow('decision', 'plan', 'QF-1', '--add-supporting', '.nvmrc=build-configuration', '--supporting-reason', reason, '--reason', reason);
  const entered = sflowJson('phase', 'enter', '--compose', '--for-agent');
  assert.equal(entered.status, 0, JSON.stringify(entered.value).slice(0, 2000));
  assert.equal(entered.value.planChanges[0].id, 'PAM-001');
  assert.deepEqual(entered.value.planChanges[0].missing, ['.nvmrc']);
  const told = /The plan changed: PAM-001 added \.nvmrc as a supporting change \(build-configuration\); \.nvmrc does not exist yet, so create it\./u;
  assert.match(agentAct(entered.value).said, told);
  // What a model really reads: the bounded result's first word, not a field it may never open.
  const bounded = spawnSync(process.execPath, [cli, '--no-model', 'phase', 'enter', '--compose', '--for-agent', '--json'], { cwd: root, encoding: 'utf8', timeout: childTimeout(120_000),
    env: { ...repo.env, SINGULARITY_FLOW_AGENT_OUTPUT: 'bounded' } });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.match(JSON.parse(bounded.stdout.slice(bounded.stdout.indexOf('{'))).act.said, told);
  await writeFile(path.join(root, '.nvmrc'), '22\n');
  const created = sflowJson('phase', 'enter', '--compose', '--for-agent');
  assert.deepEqual(created.value.planChanges[0].missing, [], 'read fresh on every entry');
  assert.doesNotMatch(agentAct(created.value).said, /create it/u);
  assert.match(agentAct(created.value).said, /The plan changed: PAM-001 added \.nvmrc/u, 'the change is still said; only what it needs has gone');
});

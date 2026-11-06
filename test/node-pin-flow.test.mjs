/**
 * The Node-version failure offers one real choice, through the real CLI [bin-opr2]. The Nodes here are small
 * scripts, as in project-node-version.test.mjs: they answer --version as a Node would and run the real one
 * for anything else, and only a script sets FAKE_NODE, so a test can fail on one and pass on another.
 *
 * The route must really change the state: the refused gate leads to one choice, the choice creates the file
 * and the amendment with the person's reason, and the same gate then passes on the pinned Node.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { childTimeout } from './helpers/child-timeout.mjs';
import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

async function fakeNode(directory, version) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'node');
  await writeFile(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nFAKE_NODE=${version} exec '${process.execPath}' "$@"\n`);
  await chmod(file, 0o755);
  return directory;
}

const posix = process.platform === 'win32' ? { skip: 'the fake Nodes are shell scripts' } : {};

async function failingOnThisNode(t) {
  const repo = await repository(t, { files: { 'package.json': JSON.stringify({ type: 'module', private: true, engines: { node: '>=20 <25' }, scripts: { test: 'node --test' } }) },
    implementCommands: false });
  const { root, sflow } = repo;
  const home = path.join(repo.base, 'home');
  await fakeNode(path.join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), '22.14.0');
  await startQuickFix(repo);
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n\n"
    + "test('runs on the Node the package asks for', () => assert.equal(process.env.FAKE_NODE, '22.14.0'));\n");
  sflow('prepare', 'implement');
  const bin = await fakeNode(path.join(repo.base, 'bin'), '26.1.0');
  const env = { ...repo.env, HOME: home, NVM_DIR: path.join(home, '.nvm'), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = (...args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env, encoding: 'utf8', timeout: childTimeout(240_000) });
  const json = (...args) => { const result = run(...args, '--json'); return { status: result.status, value: JSON.parse(result.stdout), stderr: result.stderr }; };
  return { ...repo, run, json };
}

test('a failed run on the wrong Node leads to one choice, and choosing it clears the gate', { ...posix, ...slowLane({ timeout: 480_000 }) }, async (t) => {
  const { root, run, json } = await failingOnThisNode(t);

  // Early: the choice is listed, and nothing waits on it.
  const early = json('decisions', 'QF-1').value.data;
  const offered = early.items.find((item) => item.kind === 'node-pin');
  assert.ok(offered, 'listed before any run');
  assert.equal(offered.details.stage, 'early');
  assert.equal(offered.holdsApproval, false);
  assert.match(early.headline, /has 1 open decision; none holds its approval\./u, 'it stops nothing');
  assert.equal(offered.options.length, 1, 'one choice');
  assert.equal(offered.options[0].id, 'pin-node');
  assert.match(offered.options[0].label, /^Pin Node 22: create \.nvmrc and amend the plan$/u);
  assert.match(offered.options[0].words, /Creates \.nvmrc holding 22 in this checkout and lists it in the plan as a supporting change \(build-configuration\) with your reason/u, 'names what it does before they confirm');
  const recovered = json('recover', 'QF-1', '--phase', 'implement').value;
  assert.equal(recovered.actions[0].id, 'pin-node-version:implement', 'recovery leads with it, not a read');
  assert.equal(recovered.actions[0].skill, '/sf-decide');

  // The gate refuses, and its first route is the person's choice from this exact state.
  const refused = json('phase', 'publish', 'implement');
  assert.notEqual(refused.status, 0);
  assert.equal(refused.value.error.code, 'CODE_TEST_FAILED');
  assert.equal(refused.value.error.details.nodePin.version, '22');
  const steps = refused.value.remediationPlan.steps;
  assert.equal(steps[0].id, 'pin-node-version');
  assert.equal(steps[0].command, 'singularity-flow decisions QF-1');
  assert.match(steps[0].copilotCommand, /^\/sf-decide/u);
  const listed = json('decisions', 'QF-1').value.data;
  const item = listed.items.find((entry) => entry.kind === 'node-pin');
  assert.equal(item.details.stage, 'failed', 'after the failed run the step waits on it');
  assert.match(listed.headline, /needs 1 decision/u);
  // Counted wherever a person looks, on the read paths that resolve no test command unless a run failed.
  const nextSteps = json('nextsteps').value;
  assert.match(JSON.stringify(nextSteps), /\/sf-decide QF-1|singularity-flow decisions QF-1/u, 'next steps lead to it');

  // Whether it passes can be asked, with nothing recorded and the checkout as it was.
  const tried = json('tests', 'node', '--work-id', 'QF-1', '--phase', 'implement', '--node', '22');
  assert.equal(tried.status, 0, tried.stderr);
  assert.equal(tried.value.passed, true, JSON.stringify(tried.value));
  assert.match(tried.value.words, /It passes on Node 22\.14\.0/u);
  await assert.rejects(stat(path.join(root, '.nvmrc')), 'trying it creates nothing');
  const after = json('decisions', 'QF-1').value.data;
  assert.match(after.items.find((entry) => entry.kind === 'node-pin').why, /It passes on Node 22\.14\.0/u);
  // Not installed, or not a version: refused, and nothing runs.
  assert.equal(json('tests', 'node', '--work-id', 'QF-1', '--node', '18').value.error.code, 'TESTS_NODE_NOT_INSTALLED');
  assert.equal(json('tests', 'node', '--work-id', 'QF-1', '--node', '../../bin/sh').value.error.code, 'TESTS_COMMAND_INVALID');

  // The reason is theirs: with none, nothing is written.
  const fresh = json('decisions', 'QF-1').value.data;
  const id = fresh.items.find((entry) => entry.kind === 'node-pin').id;
  const blank = json('decisions', 'record', 'QF-1', '--choose', `${id}=pin-node`, '--confirm', fresh.packetSha256);
  assert.equal(blank.value.error.code, 'DECISIONS_ANSWER_INVALID');
  await assert.rejects(stat(path.join(root, '.nvmrc')));

  // One action: the file and the amendment, with their reason.
  const reason = 'The Vitest suite needs Node 22; the code does not change.';
  const recorded = json('decisions', 'record', 'QF-1', '--choose', `${id}=pin-node`, '--reason', `${id}=${reason}`, '--confirm', fresh.packetSha256);
  assert.equal(recorded.status, 0, JSON.stringify(recorded.value));
  assert.equal(await readFile(path.join(root, '.nvmrc'), 'utf8'), '22\n');
  const shown = json('decisions', 'QF-1').value.data;
  assert.ok(shown.recorded.some((entry) => /\.nvmrc accounted for/u.test(entry.summary)), JSON.stringify(shown.recorded));
  assert.equal(shown.items.some((entry) => entry.kind === 'node-pin'), false, 'the choice is gone once made');

  // The same gate now runs on the pinned Node and passes.
  const published = run('phase', 'publish', 'implement');
  assert.equal(published.status, 0, published.stdout + published.stderr);
  assert.match(published.stderr, /Using Node 22\.14\.0 from nvm for this run: \.nvmrc asks for 22\./u);
});

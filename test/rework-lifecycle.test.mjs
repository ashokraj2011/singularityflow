import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { phaseNeedsGeneration } from '../src/sequence.mjs';
import { verifiedAbandonedGenerations } from '../src/governance.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const verify = 'poc-lite-verify';
const final = 'poc-lite-finalize';

async function fixture(t, id, { code = false, minimum = 1 } = {}) {
  const producer = code ? 'poc-lite-act' : verify;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-rework-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  const machine = path.join(directory, 'machine');
  await mkdir(root); await mkdir(machine);
  const env = { ...process.env, HOME: machine, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Rework Tester' };
  const execute = (command, args, allowFailure = false, actor = 'Rework Tester') => {
    const result = spawnSync(command, args, { cwd: root, env: { ...env, SINGULARITY_FLOW_TEST_IDENTITY: actor }, encoding: 'utf8' });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (...args) => execute('git', args).stdout.trim();
  const flow = (args, allowFailure = false, actor = 'Rework Tester') => execute(process.execPath, [bin, ...args, '--no-model'], allowFailure, actor);
  git('init', '-b', 'main'); git('config', 'user.name', 'Rework Tester'); git('config', 'user.email', 'rework@example.test');
  await writeFile(path.join(root, 'README.md'), '# Local lifecycle fixture\n');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/example.mjs'), 'export const value = 1;\n');
  const changeSource = async (value) => {
    await writeFile(path.join(root, 'src/example.mjs'), `export const value = ${value};\n`);
    await writeFile(path.join(root, 'tests/example.test.mjs'),
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/example.mjs';\n// @ac:${id}:AC-001\ntest('exact value', () => assert.equal(value, ${value}));\n`);
  };
  if (code) {
    await mkdir(path.join(root, 'tests'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }));
    await changeSource(1);
  }
  flow(['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['rework-regression'] = {
    ...config.workTypes['poc-lite'], phases: [producer, final],
    omits: ['scope', 'plan', 'implement'].map((responsibility) => ({ responsibility, reason: 'Rework regression fixture that runs two steps of POC Lite and nothing else.', authority: 'quality-reviewers' })),
    templateOverrides: { [producer]: code ? 'poc-lite/act.md' : 'poc-lite/verify.md', [final]: 'poc-lite/finalize.md' },
    phaseOverrides: {
      [producer]: { inputs: [] },
      [final]: { inputs: [producer], approval: { authorities: ['quality-reviewers'], requiredAuthorities: ['quality-reviewers'], minimum, rejectTo: [producer, final] } }
    }
  };
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.'); git('commit', '-m', 'Local regression configuration');
  git('init', '--bare', '-b', 'main', path.join(directory, 'remote.git'));
  git('remote', 'add', 'origin', path.join(directory, 'remote.git')); git('push', '-u', 'origin', 'main');
  flow(['start', id, '--from-branch', 'main', '--work-type', 'rework-regression', '--agent', 'qa', '--title', 'Rework lifecycle regression', '--description', 'Exercise exact evidence restoration and fresh downstream review.']);
  // The route leaves these responsibilities out, so the Story can finish only once someone in the
  // omission's group has said why they do not apply; say it once, before any review begins.
  for (const responsibility of ['scope', 'plan', 'implement']) {
    flow(['decision', 'applicability', '--responsibility', responsibility, '--reason', 'This regression fixture exercises rework and review only.']);
  }
  const state = async () => JSON.parse(await readFile(path.join(root, 'singularity/work-items', id, 'workflow.json'), 'utf8'));
  const publish = (phase) => { flow(['prepare', phase]); flow(['phase', 'publish', phase]); };
  if (code) await changeSource(2);
  publish(producer); flow(['submit', producer]); publish(final); flow(['submit', final]);
  const rollForward = () => {
    flow(['resume', id, '--agent', 'qa']);
    const preview = JSON.parse(flow(['story', 'rework', 'roll-forward', '--work-id', id, '--json']).stdout);
    return JSON.parse(flow(['story', 'rework', 'roll-forward', '--work-id', id, '--confirm', preview.confirmation, '--json']).stdout);
  };
  return { root, git, flow, state, publish, rollForward, producer, changeSource };
}

test('published abandoned rework restores an approvable review without reusing generation identities', async (t) => {
  const { root, git, flow, state, publish, rollForward } = await fixture(t, 'REWORK-ORDINAL');
  const before = await state();
  const originalPacket = before.lineage.submissions.at(-1);
  const originalBytes = await readFile(path.join(root, originalPacket.path), 'utf8');
  flow(['reject', final, '--to', verify, '--reason', 'Inspect an alternative verification report.']);
  publish(verify);
  assert.equal((await state()).phases[verify].generation, 2);
  rollForward();
  let workflow = await state();
  assert.equal(workflow.phases[verify].generation, 1);
  assert.equal(workflow.phases[verify].generationHighWatermark, 2);
  assert.deepEqual(workflow.changeRequests[0].resolution.abandonedGenerations, [{ phase: verify, generation: 2 }]);
  assert.equal(workflow.phases[final].status, 'awaiting_approval');
  assert.notEqual(workflow.lineage.submissions.at(-1).packetSha256, originalPacket.packetSha256);
  assert.equal(await readFile(path.join(root, originalPacket.path), 'utf8'), originalBytes, 'the original review packet remains immutable');
  flow(['approve', final, '--yes']);
  assert.equal((await state()).status, 'closed', 'restored review can be approved despite the abandoned publication remaining in history');

  flow(['reopen', '--to', verify, '--reason', 'Recheck completion with new evidence.']);
  publish(verify);
  workflow = await state();
  assert.equal(workflow.phases[verify].generation, 3, 'generation 2 remains reserved by its historical publication');
  flow(['submit', verify]);
  workflow = await state();
  assert.equal(workflow.changeRequests.at(-1).status, 'resolved', 'approval:none completion resolves the authorized return');
  assert.equal(workflow.changeRequests.at(-1).resolution.generation, 3);
  assert.equal(phaseNeedsGeneration(workflow, workflow.phases[final]), true, 'downstream evidence is stale even though its old generation is retained');
  const staleSubmit = flow(['submit', final], true);
  assert.notEqual(staleSubmit.status, 0);
  publish(final); flow(['submit', final]); flow(['approve', final, '--yes']);
  workflow = await state();
  assert.equal(workflow.phases[final].generation, 2);
  assert.equal(workflow.status, 'closed');
  assert.equal(workflow.changeRequests.filter((request) => request.status === 'open').length, 0);
  assert.deepEqual([...verifiedAbandonedGenerations(root, {}, workflow)], [`${verify}:2`]);
  for (const tamper of [
    (value) => { value.changeRequests[0].resolution.confirmation = `sha256:${'0'.repeat(64)}`; },
    (value) => { value.changeRequests[0].resolution.abandonedGenerations[0].generation = 3; },
    (value) => { value.publicationProjections = value.publicationProjections.filter((entry) => entry.event.type !== 'rework-rolled-forward'); },
    (value) => { value.publicationProjections.find((entry) => entry.event.type === 'rework-rolled-forward').event.actor.email = 'forged@example.test'; }
  ]) {
    const forged = structuredClone(workflow); tamper(forged);
    assert.deepEqual([...verifiedAbandonedGenerations(root, {}, forged)], [], 'mutable abandonment cannot exempt historical evidence');
  }
  // One request whose verification fails is reported for itself; the others are still verified.
  const unreadable = structuredClone(workflow);
  const rolledForward = unreadable.publicationProjections.find((entry) => entry.event.type === 'rework-rolled-forward').event;
  unreadable.changeRequests.push({ ...structuredClone(unreadable.changeRequests[0]), id: 'CR-999' });
  unreadable.publicationProjections.push({ event: { ...structuredClone(rolledForward),
    payload: { ...structuredClone(rolledForward.payload), changeRequestId: 'CR-999', unhashable: 1n } } });
  const errors = [];
  assert.deepEqual([...verifiedAbandonedGenerations(root, {}, unreadable, { errors })], [`${verify}:2`]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^abandoned rework CR-999 could not be verified: /);
  // A rollback commit absent from history, with bounds outside it, costs one bounded Git walk rather
  // than reading the identity of every commit down to the root.
  const unanchored = structuredClone(workflow);
  unanchored.publicationProjections.find((entry) => entry.event.type === 'rework-rolled-forward').event.sourceCommit = 'f'.repeat(40);
  unanchored.changeRequests[0].forwardCheckpoint.sourceCommit = 'e'.repeat(40);
  const timer = commandTimer('abandoned-generation-walk', { commandClass: 'read' });
  assert.deepEqual([...withCommandTiming(timer, () => verifiedAbandonedGenerations(root, {}, unanchored))], []);
  const spawns = timer.finish().counters['git.spawns'] ?? 0;
  assert.ok(spawns <= 3, `the walk spawned ${spawns} Git processes for ${git('rev-list', '--count', 'HEAD')} commits`);
  // A build that reads at most Story v12 ignores the high-water mark, so it must refuse this Story.
  assert.ok(workflow.schemaVersion >= 13, `Story recorded a generation high-water mark at v${workflow.schemaVersion}`);
  flow(['gate', '--terminal']);
  const staleRollback = flow(['story', 'rework', 'roll-forward', '--work-id', 'REWORK-ORDINAL', '--json'], true);
  assert.notEqual(staleRollback.status, 0, 'completed rework cannot later be abandoned via a stale open request');
  assert.match(git('log', '--format=%s'), /rework:roll-forward/);
});

test('roll-forward preserves dirty checkpoint bytes without authenticating them as submitted review', async (t) => {
  const { root, flow, state, rollForward } = await fixture(t, 'REWORK-DIRTY');
  const original = (await state()).lineage.submissions.at(-1).packetSha256;
  const source = path.join(root, 'src/example.mjs');
  await writeFile(source, 'export const value = 2;\n');
  flow(['reject', final, '--to', verify, '--reason', 'Inspect an alternative without losing local source.']);
  await writeFile(source, 'export const value = 3;\n');
  rollForward();
  assert.equal(await readFile(source, 'utf8'), 'export const value = 2;\n');
  assert.equal((await state()).lineage.submissions.at(-1).packetSha256, original);
  const approval = flow(['approve', final, '--yes'], true);
  assert.notEqual(approval.status, 0);
  assert.match(approval.stderr, /source or tests changed|STORY_REVIEW_SOURCE_CHANGED/);
});

test('Code rework after abandonment retains tested source and passes terminal audit at generation three', async (t) => {
  const { root, flow, state, publish, rollForward, producer, changeSource } = await fixture(t, 'REWORK-CODE', { code: true });
  flow(['reject', final, '--to', producer, '--reason', 'Consider an alternative tested implementation.']);
  flow(['prepare', producer]);
  await changeSource(3); publish(producer);
  assert.equal((await state()).phases[producer].generation, 2);
  rollForward();
  assert.equal(await readFile(path.join(root, 'src/example.mjs'), 'utf8'), 'export const value = 2;\n');
  flow(['approve', final, '--yes']);
  flow(['reopen', '--to', producer, '--reason', 'Implement a new tested value.']);
  flow(['prepare', producer]);
  await changeSource(4); publish(producer); flow(['submit', producer]);
  let workflow = await state();
  assert.equal(workflow.phases[producer].generation, 3);
  assert.equal(workflow.phases[producer].deliveryEvidence.status, 'ready');
  assert.ok(workflow.phases[producer].deliveryEvidence.testExecutions.length > 0);
  assert.ok(workflow.phases[producer].deliveryEvidence.testExecutions.every((entry) => entry.status === 'passed'));
  assert.equal(workflow.changeRequests.at(-1).status, 'resolved');
  publish(final); flow(['submit', final]); flow(['approve', final, '--yes']);
  workflow = await state();
  assert.equal(workflow.status, 'closed');
  flow(['gate', '--terminal']);
});

test('restored review invalidates partial approvals and requires the full fresh threshold', async (t) => {
  const { flow, state, publish, rollForward } = await fixture(t, 'REWORK-THRESHOLD', { minimum: 2 });
  flow(['approve', final, '--yes']);
  let workflow = await state();
  assert.equal(workflow.phases[final].status, 'awaiting_approval');
  assert.equal(workflow.phases[final].approvals.filter((entry) => entry.decision === 'approved' && !entry.invalidatedAt).length, 1);
  flow(['reject', final, '--to', verify, '--reason', 'Review an alternative before finishing the threshold.']);
  publish(verify); rollForward();
  workflow = await state();
  assert.equal(workflow.phases[final].approvals.filter((entry) => entry.decision === 'approved' && !entry.invalidatedAt).length, 0);
  assert.ok(workflow.phases[final].approvals.some((entry) => entry.decision === 'approved' && entry.invalidatedAt));
  flow(['approve', final, '--yes']);
  assert.equal((await state()).phases[final].status, 'awaiting_approval');
  flow(['approve', final, '--yes'], false, 'Second Reviewer');
  assert.equal((await state()).status, 'closed');
});

test('governed repairs and later Code publications are not stale evidence; out-of-band edits are', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-rework-governed-chain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  const machine = path.join(directory, 'machine');
  await mkdir(root); await mkdir(machine);
  const env = { ...process.env, HOME: machine, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Rework Tester' };
  const execute = (command, args, allowFailure = false) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (...args) => execute('git', args).stdout.trim();
  const flow = (args, allowFailure = false) => execute(process.execPath, [bin, ...args, '--no-model'], allowFailure);
  const write = (relative, text) => writeFile(path.join(root, relative), text);
  const module = async (name, value) => {
    await write(`src/${name}.mjs`, `export const ${name} = ${value};\n`);
    await write(`tests/${name}.test.mjs`, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${name} } from '../src/${name}.mjs';\n// @ac:CHAIN-1:AC-001\ntest('${name}', () => assert.equal(${name}, ${value}));\n`);
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Rework Tester'); git('config', 'user.email', 'rework@example.test');
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'tests'));
  await write('package.json', JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }));
  await module('first', 1); await module('second', 1);
  flow(['init']);
  // code -> a review confined to test automation -> review -> second code step -> final review
  for (const [packaged, id, phase] of [['poc-lite-implementer', 'second-implementer', 'act-two'],
    ['poc-lite-verifier', 'test-repair-verifier', 'test-repair']]) {
    const text = await readFile(path.join(root, `.github/agents/${packaged}.agent.md`), 'utf8');
    const original = /sflow-default-for: "([^"]+)"/u.exec(text)[1];
    await write(`.github/agents/${id}.agent.md`, text.replace(`name: ${packaged}`, `name: ${id}`).replaceAll(`"${original}"`, `"${phase}"`));
  }
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  const own = (base, id, extra) => ({ ...config.phases[base], ...extra, artifact: {
    ...config.phases[base].artifact, path: `artifacts/${id}/${path.basename(config.phases[base].artifact.path)}` } });
  config.phases['act-two'] = own('poc-lite-act', 'act-two', { label: 'Second code step' });
  config.phases['test-repair'] = own(verify, 'test-repair', { label: 'Test repair review',
    writeScope: 'source-and-artifact', sourceBoundary: 'test-automation' });
  const order = ['poc-lite-act', 'test-repair', verify, 'act-two', final];
  config.workTypes['governed-chain'] = {
    ...config.workTypes['poc-lite'], label: 'Governed chain', phases: order,
    omits: ['scope', 'plan'].map((responsibility) => ({ responsibility, reason: 'Governed chain fixture of code and test steps with no specification or plan step.', authority: 'quality-reviewers' })),
    templateOverrides: { 'poc-lite-act': 'poc-lite/act.md', 'test-repair': 'poc-lite/verify.md', [verify]: 'poc-lite/verify.md',
      'act-two': 'poc-lite/act.md', [final]: 'poc-lite/finalize.md' },
    phaseOverrides: Object.fromEntries(order.map((id) => [id, id === final
      ? { inputs: [], approval: { authorities: ['quality-reviewers'], requiredAuthorities: ['quality-reviewers'], minimum: 1, rejectTo: order } }
      : { inputs: [] }]))
  };
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.'); git('commit', '-m', 'Governed chain configuration');
  git('init', '--bare', '-b', 'main', path.join(directory, 'remote.git'));
  git('remote', 'add', 'origin', path.join(directory, 'remote.git')); git('push', '-u', 'origin', 'main');
  flow(['start', 'CHAIN-1', '--from-branch', 'main', '--work-type', 'governed-chain', '--agent', 'qa',
    '--title', 'Governed chain', '--description', 'Governed repairs across two code steps stay fresh evidence.']);
  const draft = async () => JSON.parse(flow(['phase', 'draft-check', verify, '--json']).stdout);
  const stale = (result) => `${result.stdout}\n${result.stderr}`.match(/changed after their approved execution: ([^\n]*?)\. Return/u)?.[1];

  await module('first', 2); flow(['prepare', 'poc-lite-act']); flow(['phase', 'publish', 'poc-lite-act']); flow(['submit', 'poc-lite-act']);
  flow(['prepare', 'test-repair']);
  await write('src/first.mjs', 'export const first = 2; // untested\n');
  assert.equal(stale(flow(['phase', 'publish', 'test-repair'], true)), 'src/first.mjs', 'product source stays outside the repair boundary');
  await write('src/first.mjs', 'export const first = 2;\n');
  const repairedTest = path.join(root, 'tests/first.test.mjs');
  await writeFile(repairedTest, `${await readFile(repairedTest, 'utf8')}// Stabilised by the bounded review repair.\n`);
  flow(['phase', 'publish', 'test-repair']); flow(['submit', 'test-repair']);
  // The next review relies on the first code step, yet the governed repair is not an untested edit.
  flow(['prepare', verify]); flow(['phase', 'publish', verify]); flow(['submit', verify]);
  flow(['prepare', 'act-two']); await module('second', 2); flow(['phase', 'publish', 'act-two']); flow(['submit', 'act-two']);
  flow(['prepare', final]); flow(['phase', 'publish', final]); flow(['submit', final]);

  // Returning to the first review leaves the second code step's governed bytes in the tree.
  flow(['reject', final, '--to', verify, '--reason', 'Recheck the first review with the second step in place.']);
  flow(['prepare', verify]);
  assert.equal((await draft()).status, 'ready');
  await write('src/first.mjs', 'export const first = 2; // out of band\n');
  const outOfBand = await draft();
  const finding = outOfBand.findings.find((entry) => entry.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE');
  assert.match(finding?.message ?? '', /approved execution: src\/first\.mjs\. Return/u, 'only the out-of-band edit is stale');
  git('add', 'src/first.mjs'); git('commit', '-m', 'Commit an out-of-band source edit');
  assert.equal(stale(flow(['phase', 'publish', verify], true)), 'src/first.mjs');
  await write('src/first.mjs', 'export const first = 2;\n');
  git('add', 'src/first.mjs'); git('commit', '-m', 'Restore the tested source');
  flow(['phase', 'publish', verify]);
});

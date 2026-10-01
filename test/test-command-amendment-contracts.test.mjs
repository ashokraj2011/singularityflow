import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { issueActionAuthorization } from '../src/action-authorization.mjs';
import { canonicalJson } from '../src/records.mjs';
import { familyForStoredPath, readRecord } from '../src/schema-migrations.mjs';
import { assertTestCommandAmendmentPolicyScope, testCommandAmendmentDigest,
  TEST_COMMAND_AMENDMENT_SCHEMAS, validateTestCommandAmendmentRecord } from '../src/test-command-amendment-contracts.mjs';
import { consumeTestCommandReviewAuthorization, testCommandReviewAuthorization,
  testCommandReviewReattestationAuthorization, reattestTestCommandReviewOrigin,
  verifyTestCommandReviewOrigin } from '../src/test-command-amendment-origin.mjs';
import { run } from '../src/util.mjs';
import { TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const hash = `sha256:${'1'.repeat(64)}`;
const oldCommit = 'a'.repeat(40); const newCommit = 'b'.repeat(40);
const commands = [{ id: 'node-test', kind: 'test', argv: ['node', '--test', 'test/missing.test.mjs'],
  modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/test.tap', minimumDiscovered: 1, minimumPassed: 1 } }];
function policy() {
  return { configurationSource: { repository: 'https://example.invalid/config.git', commit: oldCommit, filesSha256: hash },
    phases: [{ id: 'implementation', generation: { task: 'code' }, qualityCommands: commands, sourceBoundary: { mode: 'strict' },
      approval: { mode: 'required', minimum: 1, authorities: ['engineering-reviewers'], requiredAuthorities: [], allowSelfApproval: false } },
    { id: 'review', qualityCommands: [], status: 'approved' }],
    testRecovery: { enabled: true, enabledRiskCategories: [] }, approvalAuthorities: { 'engineering-reviewers': { members: [] } } };
}
function nextPolicy() {
  const value = structuredClone(policy()); value.configurationSource.commit = newCommit;
  value.testRecoveryValidationEpoch = 2; value.phases[0].qualityCommands[0].argv[2] = 'test/existing.test.mjs';
  return value;
}
function reviewCore() {
  return { schemaVersion: 1, kind: 'test-command-adoption-review', id: 'TCA-001', workId: 'STORY-1', phaseId: 'implementation',
    decision: 'approve', at: '2026-10-02T00:00:00.000Z', planSha256: hash,
    from: { revision: 1, snapshotHash: hash, policySha256: hash, configurationCommit: oldCommit, commandInventorySha256: hash, validationEpoch: 1 },
    to: { revision: 2, policySha256: hash, configurationCommit: newCommit, commandInventorySha256: hash, validationEpoch: 2 },
    actor: { name: 'Reviewer', email: 'reviewer@example.invalid', login: null },
    originalAuthority: { authorityGroup: 'engineering-reviewers', identityAssurance: 'configured-local' },
    candidateAuthority: { authorityGroup: 'engineering-reviewers', identityAssurance: 'configured-local' },
    preserved: { intentSha256: hash, sourceBaseCommit: oldCommit, sourceTreeSha256: hash, draftSha256: hash } };
}
function publicReview() {
  const core = reviewCore(); const card = testCommandReviewAuthorization(core);
  return { ...core, authorization: { authorizationId: 'public-json-is-not-authority', questionId: 'question', answerReceipt: 'answer',
    assurance: 'configured-local-review', planSha256: card.plan.planHash, actionId: card.action.actionId } };
}
test('bounded test-command policy delta advances only one epoch and leaves original policy untouched', () => {
  const before = policy(); const bytes = canonicalJson(before); const after = nextPolicy();
  assert.equal(assertTestCommandAmendmentPolicyScope(before, after, 'implementation').beforeEpoch, 1);
  assert.equal(canonicalJson(before), bytes);
});
for (const [label, mutate] of [
  ['source boundary', value => { value.phases[0].sourceBoundary.mode = 'off'; }],
  ['approval policy', value => { value.phases[0].approval.minimum = 0; }],
  ['authority catalog', value => { value.approvalAuthorities.other = {}; }],
  ['risk enablement', value => { value.testRecovery.enabledRiskCategories.push('new-test-failure'); }],
  ['preserved phase', value => { value.phases[1].status = 'open'; }],
  ['phase topology', value => { value.phases.reverse(); }],
  ['non-test command', value => { value.phases[0].qualityCommands.push({ kind: 'lint', argv: ['eslint'] }); }],
  ['epoch jump', value => { value.testRecoveryValidationEpoch = 4; }],
  ['configuration authority', value => { value.configurationSource.repository = 'https://example.invalid/attacker.git'; }],
  ['unstructured test', value => { value.phases[0].qualityCommands[0] = { kind: 'test', command: 'node --test' }; }]
]) test(`command amendment refuses unrelated ${label} change`, () => {
  const after = nextPolicy(); mutate(after);
  assert.throws(() => assertTestCommandAmendmentPolicyScope(policy(), after, 'implementation'), { code: 'WFA_AMENDMENT_INVALID' });
});
test('TCA review is a closed registered record and authority remains separate from JSON', async () => {
  const value = publicReview(); assert.equal(validateTestCommandAmendmentRecord(value), value);
  assert.equal(readRecord(value.kind, value).storedVersion, 1);
  assert.equal(familyForStoredPath('singularity/work-items/STORY-1/context/test-recovery/command-amendments/TCA-001-review-001.json').id, value.kind);
  for (const mutated of [{ ...value, authorized: true }, { ...value, actor: { ...value.actor, trusted: true } },
    { ...value, preserved: { ...value.preserved, skippedPaths: [] } }]) {
    assert.throws(() => validateTestCommandAmendmentRecord(mutated), { code: 'WFA_AMENDMENT_INVALID' });
  }
  assert.equal(await verifyTestCommandReviewOrigin('/not-a-repository', '/not-a-repository/story', value), false);
});
test('materialized TCA JSON schemas exactly match their runtime closed contracts', async () => {
  for (const [kind, schema] of Object.entries(TEST_COMMAND_AMENDMENT_SCHEMAS)) {
    const stored = JSON.parse(await readFile(new URL(`../schemas/${kind}.schema.json`, import.meta.url), 'utf8'));
    delete stored.$schema; delete stored.$id; delete stored.title;
    assert.deepEqual(stored, schema);
  }
});
test('ordinary local authorization JSON cannot mint or re-attest a TCA origin', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tca-origin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Reviewer'], { cwd: root });
  run('git', ['config', 'user.email', 'reviewer@example.invalid'], { cwd: root });
  const workRoot = path.join(root, 'singularity/work-items/STORY-1'); await mkdir(workRoot, { recursive: true });
  const core = reviewCore(); const card = testCommandReviewAuthorization(core);
  const issued = await issueActionAuthorization(root, card.plan, card.action, { confirmation: card.action.actionId });
  await assert.rejects(consumeTestCommandReviewAuthorization(root, workRoot, { review: core, token: issued.token }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  const review = publicReview(); const reattest = testCommandReviewReattestationAuthorization(review);
  assert.notEqual(reattest.plan.planHash, testCommandAmendmentDigest(review));
  const second = await issueActionAuthorization(root, reattest.plan, reattest.action, { confirmation: reattest.action.actionId });
  await assert.rejects(reattestTestCommandReviewOrigin(root, workRoot, { review, token: second.token }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
  assert.equal(await verifyTestCommandReviewOrigin(root, workRoot, review), false);
});

async function reattestInTerminal(root, workRoot, review) {
  const code = `
    import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
    import {testCommandReviewReattestationAuthorization,reattestTestCommandReviewOrigin} from ${JSON.stringify(new URL('../src/test-command-amendment-origin.mjs', import.meta.url).href)};
    const {root,workRoot,review}=${JSON.stringify({ root, workRoot, review })};
    try {
      const card=testCommandReviewReattestationAuthorization(review);
      const grant=await captureTerminalActionAuthorization(root,card.plan,card.action,{label:'Attest retained review'});
      const result=await reattestTestCommandReviewOrigin(root,workRoot,{review,token:grant.token});
      console.log('TCA_ORIGIN_RESULT:'+JSON.stringify({ok:true,...result}));
    } catch(error) {console.log('TCA_ORIGIN_RESULT:'+JSON.stringify({ok:false,message:error.message,stack:error.stack}));}
  `;
  const script = `
    set timeout 25
    log_user 1
    spawn -noecho $env(SF_TCA_NODE) --input-type=module -e $env(SF_TCA_CODE)
    expect {
      "Type Attest retained review to confirm this exact action, or Enter to cancel:" { send -- "Attest retained review\\r" }
      timeout { exit 124 }
      eof { exit 125 }
    }
    expect eof
    catch wait result
    exit [lindex $result 3]
  `;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const output = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: root,
      env: { ...environment, SF_TCA_NODE: process.execPath, SF_TCA_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('TCA origin PTY timed out')); }, 30_000);
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); status === 0 ? resolve(stdout) : reject(new Error(`${stdout}\n${stderr}`)); });
  });
  const result = output.match(/TCA_ORIGIN_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(result, output.slice(-2000)); const parsed = JSON.parse(result[1]);
  assert.equal(parsed.ok, true, parsed.stack ?? parsed.message);
}

test('explicit retained-review reattestation recovers after private key loss without overwriting old proof',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tca-key-recovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    run('git', ['init', '-q', '-b', 'main'], { cwd: root });
    run('git', ['config', 'user.name', 'Reviewer'], { cwd: root });
    run('git', ['config', 'user.email', 'reviewer@example.invalid'], { cwd: root });
    const workRoot = path.join(root, 'singularity/work-items/STORY-1'); await mkdir(workRoot, { recursive: true });
    const review = publicReview(); const reviewBytes = canonicalJson(review);
    await reattestInTerminal(root, workRoot, review);
    assert.equal(await verifyTestCommandReviewOrigin(root, workRoot, review), true);
    const directory = path.join(root, '.git/singularity-flow/test-command-review-origins');
    const original = (await readdir(directory)).find(name => name.endsWith('.origin'));
    const originalBytes = await readFile(path.join(directory, original), 'utf8');
    await rm(path.join(directory, 'origin.key'));
    assert.equal(await verifyTestCommandReviewOrigin(root, workRoot, review), false);
    await reattestInTerminal(root, workRoot, review);
    assert.equal(await verifyTestCommandReviewOrigin(root, workRoot, review), true);
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.origin')).length, 2);
    assert.equal(await readFile(path.join(directory, original), 'utf8'), originalBytes);
    assert.equal(canonicalJson(review), reviewBytes);
  });

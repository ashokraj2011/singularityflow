import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { revisionDirectory } from '../src/spec-library/ids.mjs';
import { revisionFiles } from '../src/spec-library/library.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { CLI, JOURNEY_IDENTITY, journeyRepository } from './helpers/route-follower.mjs';

const SPEC = 'SPEC-TASK-FIXTURE';
const CLAUSE = SPEC + ':REQ-001';
const evidenceText = revision => `# Evidence retention\n\nSave the original receipt for revision ${revision}. [${CLAUSE}]\n`;
const exec = promisify(execFile);
const toJson = output => JSON.parse(output);

async function fixture(t) {
  const repo = await journeyRepository(t);
  const publish = async revision => {
    const built = revisionFiles({ specId: SPEC, revision, reviewState: 'reviewed', operationId: 'itw-fixture-' + revision,
      actor: JOURNEY_IDENTITY, recordedAt: '2026-11-05T10:15:00Z',
      head: { sequence: revision, snapshotSha256: 'sha256:' + 'a'.repeat(64), draft: {
        title: 'Task fixture revision ' + revision, kind: 'business', spec: evidenceText(revision), gaps: [], research: []
      } }, report: { counts: { d: 0, a: 0, h: 0 }, blocking: [] } });
    for (const [name, bytes] of Object.entries(built.files)) await repo.write(revisionDirectory(SPEC, revision) + '/' + name, bytes);
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'Publish fixture revision ' + revision);
    repo.git('push', '-q', '-u', 'origin', 'state');
    return { commit: repo.git('rev-parse', 'HEAD'), contentSha256: built.manifest.files['spec.md'] };
  };
  repo.git('switch', '-qc', 'state');
  const first = await publish(1);
  repo.git('switch', '-q', 'main');
  const ask = (...args) => toJson(repo.cli('ask', ...args, '--for-person', '--json'));
  const handoff = (...args) => toJson(repo.cli('work', 'handoff', ...args, '--for-person', '--json'));
  const choices = shown => ['--conversation=' + shown.conversation.id, '--revision=' + shown.conversation.revision, '--clause=' + CLAUSE];
  return { repo, publish, first, ask, handoff, choices };
}

test('R4 pins the selected specification and supporting evidence and reconciles one real ITW admission after concurrent retry and a crash', { timeout: 90_000 }, async t => {
  const { repo, publish, first, ask, handoff, choices } = await fixture(t);
  const query = ask(SPEC, '--remember');
  const observed = query.specifications[0];
  const sourcePath = 'singularity/work-items/ASK-ORIGIN/workflow.json';
  await repo.write(sourcePath, JSON.stringify({ schemaVersion: 1, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress', generation: 0 } }, workItem: {
      id: 'ASK-ORIGIN', title: 'Origin of the selected specification', source: { specification: [{ ...observed, revision: observed.reference }] }
    } }));
  repo.git('add', sourcePath);
  repo.git('commit', '-qm', 'Record the originating Story');
  const saved = ask('story ASK-ORIGIN', '--remember');
  const fromStory = ask('show the specification behind the first result', '--conversation=' + saved.conversation.id, '--revision=' + saved.conversation.revision);
  assert.equal(fromStory.evidence?.revision, first.commit, JSON.stringify(fromStory));
  const prep = [...choices(fromStory), '--supporting-evidence=' + saved.work.evidenceId, '--request=fix task receipt retention', '--kind=fix'];
  const plan = handoff(...prep);
  assert.equal(plan.status, 'prepared');
  assert.equal(plan.workId, null);
  assert.deepEqual(plan.specification.clauseIds, [CLAUSE]);
  assert.equal(plan.specification.stateCommit, first.commit);
  assert.equal(plan.specification.contentSha256, first.contentSha256);
  assert.equal(plan.specification.manifestSha256, observed.manifestSha256);
  assert.deepEqual(plan.evidence.map(entry => entry.id), [fromStory.evidence.id, saved.work.evidenceId]);
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*'), '');
  const resumed = ask('--resume', '--conversation=' + saved.conversation.id);
  assert.equal(resumed.task.id, plan.id);
  assert.equal(handoff(...choices(resumed), '--supporting-evidence=' + saved.work.evidenceId, '--request=fix task receipt retention', '--kind=fix').id, plan.id);
  const conflict = repo.raw(['work', 'handoff', ...choices(resumed), '--admission-key=' + plan.id,
    '--request=fix a different problem', '--kind=fix', '--for-person', '--json']);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stdout, /TASK_ADMISSION_KEY_CONFLICT/u);
  assert.equal(argvAllowed([CLI, 'work', 'handoff', plan.id, '--start', '--for-person'], 'authoring', {}), false);
  const agent = repo.raw(['work', 'handoff', plan.id, '--start', '--for-agent', '--for-person', '--json']);
  assert.notEqual(agent.status, 0);
  assert.match(agent.stdout, /TASK_HANDOFF_PERSON_REQUIRED/u);

  // Advance the library tip without replacing the saved revision.
  repo.git('switch', '-q', 'state');
  assert.notEqual((await publish(2)).commit, first.commit);
  repo.git('switch', '-q', 'main');
  const moved = ask('commits from 2000-01-01 to 2099-12-31 on HEAD', '--conversation=' + saved.conversation.id, '--revision=' + resumed.conversation.revision);
  assert.ok(moved.conversation.revision > plan.conversation.revision);

  const fault = path.join(repo.base, 'interrupt-admission.mjs');
  await writeFile(fault, `import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (to.endsWith(${JSON.stringify(plan.id + '.json')}) && JSON.parse(await fs.readFile(from, 'utf8')).status === 'accepted') process.exit(77);
      return rename(from, to);
    };
    syncBuiltinESMExports();
  `);
  const originalReceipt = path.join(repo.root, '.git', 'singularity-flow', 'task-admissions', plan.id + '.json');
  const argv = [CLI, 'work', 'handoff', plan.id, '--start', '--for-person', '--json'];
  const interrupted = exec(process.execPath, argv, { cwd: repo.root, env: { ...repo.env, NODE_OPTIONS: '--import=' + pathToFileURL(fault).href }, timeout: 45_000 });
  const retryWhilePending = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = toJson(await readFile(originalReceipt, 'utf8')).status;
      if (state === 'pending') return exec(process.execPath, argv, { cwd: repo.root, env: repo.env, timeout: 45_000 });
      if (state !== 'prepared') throw new Error(await readFile(originalReceipt, 'utf8'));
      await wait(25);
    }
    throw new Error('Story start did not reserve its ID');
  };
  const results = await Promise.allSettled([interrupted, retryWhilePending()]);
  assert.equal(results[0].status, 'rejected', JSON.stringify(results[0]));
  assert.equal(results[0].reason.code, 77, String(results[0].reason));
  assert.equal(results[1].status, 'fulfilled', String(results[1].reason));
  assert.ok(['pending', 'accepted'].includes(toJson(results[1].value.stdout).status));

  const recovered = handoff(plan.id);
  assert.equal(recovered.status, 'accepted', JSON.stringify(recovered));
  assert.equal(recovered.workId, 'TASK-1');
  const remoteBefore = repo.git('ls-remote', '--heads', 'origin', 'TASK-*');
  const before = repo.git('rev-parse', 'refs/heads/TASK-1');
  const retry = handoff(plan.id, '--start');
  assert.deepEqual(retry.outcome, recovered.outcome);
  assert.equal(repo.git('rev-parse', 'refs/heads/TASK-1'), before);
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*'), remoteBefore);
  assert.equal(remoteBefore.split('\n').length, 1);
  assert.match(remoteBefore, /refs\/heads\/TASK-1$/u);
  const taskPath = 'singularity/work-items/TASK-1/';
  const record = toJson(repo.git('show', 'TASK-1:' + taskPath + 'workflow.json'));
  const source = toJson(repo.git('show', 'TASK-1:' + taskPath + 'source.json'));
  assert.deepEqual(record.executionOrigin, {
    mode: 'itw-handoff', workId: recovered.workId, admissionId: recovered.id, requestSha256: source.taskHandoff.requestSha256
  });
  assert.deepEqual(source.taskHandoff.specification, plan.specification);
  assert.deepEqual(source.taskHandoff.evidence, plan.evidence);
  assert.equal(source.specification[0].stateCommit, first.commit);
  assert.match(source.specification[0].clauses[0].text, /revision 1/u);
  const status = toJson(repo.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(status.steps[0].status, 'in_progress');
  assert.ok(status.steps.every(step => step.approvedBy === null));
  assert.equal(ask('--resume', '--conversation=' + saved.conversation.id).task.workId, recovered.workId);
  assert.equal(toJson(await readFile(originalReceipt, 'utf8')).status, 'accepted');
});

test('R4 keeps stale pins and a different actor from creating work, and retains an occupied reservation for reconciliation', { timeout: 80_000 }, async t => {
  const { repo, first, ask, handoff, choices } = await fixture(t);
  const selected = ask(SPEC, '--remember');
  const plan = handoff(...choices(selected), '--request=fix retention', '--kind=fix');
  const stranger = repo.raw(['work', 'handoff', plan.id, '--start', '--for-person', '--json'], {
    environment: { ...repo.env, SINGULARITY_FLOW_TEST_IDENTITY: 'Different Person' }
  });
  assert.notEqual(stranger.status, 0);
  assert.match(stranger.stdout, /TASK_ADMISSION_UNAVAILABLE/u);
  const otherFiles = await readdir(path.join(repo.root, '.git', 'singularity-flow', 'task-admissions'));
  assert.deepEqual(otherFiles.filter(name => name.endsWith('.json')), [plan.id + '.json']);

  repo.git('switch', '-q', 'state');
  repo.git('rm', '-rq', revisionDirectory(SPEC, 1));
  repo.git('commit', '-qm', 'Withdraw the selected fixture revision');
  repo.git('push', '-q', 'origin', 'state');
  repo.git('switch', '-q', 'main');
  const refused = handoff(plan.id, '--start');
  assert.equal(refused.status, 'refused');
  assert.equal(refused.diagnostic.code, 'SPEC_LIBRARY_NOT_FOUND');
  assert.equal(refused.workId, null);
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*'), '');
  assert.equal(repo.git('rev-parse', 'refs/heads/state^'), first.commit);

  // A retained reservation whose branch cannot be proved to belong to this handoff stays unknown.
  // Reproduce the private record state left by an interrupted owner and an unrelated branch claim.
  const receiptPath = '.git/singularity-flow/task-admissions/' + plan.id + '.json';
  const interrupted = { ...toJson(await repo.read(receiptPath)), status: 'pending', workId: 'TASK-9', diagnostic: null };
  await repo.write(receiptPath, JSON.stringify(interrupted));
  repo.git('branch', 'TASK-9', 'main');
  const observed = handoff(plan.id, '--start');
  assert.equal(observed.status, 'unknown');
  assert.equal(observed.workId, 'TASK-9');
  assert.equal(repo.git('rev-parse', 'TASK-9'), repo.git('rev-parse', 'main'));
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*'), '');
});

test('R4 browser starts the reviewed task and reopens its receipt from a fresh tab', { timeout: 85_000 }, async t => {
  const { repo, first } = await fixture(t);
  const [{ startService }, { control }, { chromium }] = await Promise.all([
    import('../src/local-ui/server.mjs'), import('../src/local-ui/client.mjs'), import('playwright-core')
  ]);
  const service = await startService({ directory: path.join(repo.base, 'ask-task-browser') });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await service.close(); });
  async function openAsk() {
    const launch = await control(service.descriptor, 'bootstrap', { root: repo.root, environment: repo.env, clientId: crypto.randomUUID() });
    const page = await browser.newPage();
    await page.goto(launch.url);
    await page.getByRole('link', { name: 'Ask SFlow', exact: true }).click();
    return page;
  }
  const page = await openAsk();
  const question = page.getByRole('searchbox', { name: 'Ask a question' });
  await question.fill(SPEC);
  await question.press('Enter');
  await page.getByRole('button', { name: 'Open ' + SPEC + '@1 · Task fixture revision 1' }).click();
  await page.getByText('Prepare a task from this evidence', { exact: true }).click();
  await page.getByLabel('What should the task do?').fill('fix task receipt retention in the browser');
  await page.getByLabel('Task type').selectOption('fix');
  await page.getByLabel('Clause IDs (optional)').fill('REQ-001');
  const task = page.getByRole('region', { name: 'Task handoff' });
  await page.getByRole('button', { name: 'Review task plan' }).click();
  assert.equal(await task.locator('strong').textContent(), SPEC + '@1');
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*'), '');
  await task.getByRole('button', { name: 'Start this task' }).click();
  await task.getByRole('heading', { name: 'Task TASK-1' }).waitFor();
  await task.getByText('Task TASK-1 is recorded.', { exact: true }).waitFor();
  await page.close();

  const next = await openAsk();
  await next.getByRole('button', { name: 'Resume saved conversation' }).click();
  await next.getByRole('button', { name: 'Open task handoff' }).click();
  await next.getByRole('region', { name: 'Task handoff' }).getByText('Task TASK-1 is recorded.', { exact: true }).waitFor();
  const source = toJson(repo.git('show', 'TASK-1:singularity/work-items/TASK-1/source.json'));
  assert.equal(source.taskHandoff.specification.stateCommit, first.commit);
  assert.deepEqual(source.taskHandoff.specification.clauseIds, [CLAUSE]);
  assert.equal(repo.git('ls-remote', '--heads', 'origin', 'TASK-*').split('\n').length, 1);
});

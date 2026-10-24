/**
 * `wm brief` for a Story phase (World Model v5, M5): exactly what a phase's prompt carries, with the
 * record IDs its receipt names; a phase whose prompt cannot be composed yet shows the brief it would
 * carry now and says why; `--polish` with model use off keeps the fixed wording and says so.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };

const README = '# Orders Service\n\n## Business rules\n\n- An order needs at least one line.\n- Only placed orders can be cancelled.\n';

function run(cwd, command, ...args) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function storyRepository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-brief-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = path.join(parent, 'orders');
  await mkdir(repository);
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), repository, { recursive: true });
  await writeFile(path.join(repository, 'README.md'), README);
  run(repository, 'git', 'init', '-q', '-b', 'main');
  run(repository, 'git', 'config', 'user.name', 'Fixture');
  run(repository, 'git', 'config', 'user.email', 'fixture@example.com');
  run(repository, 'git', 'add', '-A');
  run(repository, 'git', 'commit', '-qm', 'Orders service');
  run(parent, 'git', 'clone', '-q', '--bare', repository, path.join(parent, 'origin.git'));
  run(repository, 'git', 'remote', 'add', 'origin', path.join(parent, 'origin.git'));
  run(repository, process.execPath, bin, 'init', '--smart-detect', '--yes');
  run(repository, 'git', 'push', '-q', 'origin', '--all');
  run(repository, process.execPath, bin, 'start', 'ORD-1', '--work-type', 'quick-fix', '--title', 'Let customers cancel a placed order',
    '--description', 'Cancelling an order that is already paid or shipped must still be refused.', '--from-branch', 'main', '--readiness-baseline', 'defer');
  return repository;
}

test('wm brief shows what a phase carries, and the brief a phase not yet composable would carry', async (t) => {
  const repository = await storyRepository(t);
  const brief = (...args) => JSON.parse(run(repository, process.execPath, bin, 'wm', 'brief', '--work-id', 'ORD-1', '--json', ...args));
  const intake = brief('--phase', 'intake');
  assert.equal(intake.status, 'ok');
  assert.equal(intake.composed, true);
  assert.equal(intake.profile, 'intake');
  assert.ok(intake.bytes <= intake.budget, `${intake.bytes} bytes`);
  assert.match(intake.text, /^# Repository brief: orders at [0-9a-f]{12} \(for intake, focused on this Story\)$/mu);
  assert.match(intake.text, /Only placed orders can be cancelled/u, 'the Story\'s rule is in the intake brief');
  assert.ok(intake.records.some((id) => /^R-[0-9a-f]{12}$/u.test(id)), 'the record IDs the receipt will name');
  assert.deepEqual(intake.phrasing, { by: 'template' });
  const later = brief('--phase', 'implement');
  assert.equal(later.composed, false);
  assert.match(later.note, /^This phase's prompt cannot be composed yet \(Phase implement inputs are not ready: implement requires approved input from intake.*\); this is the Repository brief it would carry now\.$/u);
  assert.match(later.text, /^# Repository brief: orders at [0-9a-f]{12} \(for implementation, focused on this Story\)$/mu);
  const polished = brief('--phase', 'intake', '--polish');
  assert.equal(polished.text, intake.text, 'without model use the fixed wording stands');
  assert.equal(polished.note, 'Model use is off, so the brief keeps its fixed wording.');
  assert.equal(run(repository, 'git', 'status', '--porcelain', '--', 'singularity'), '', 'reading a brief records nothing');
});

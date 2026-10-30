/**
 * SDA M5, SDA-AC-012, §11 and §19 items 12 and 14: a Story taken over on another laptop.
 *
 * Two laptops share only the remote. Each has its own home directory, machine state and machine
 * ID. Laptop A starts a Story with a laptop-local document and saves a configuration draft, then
 * backs both up. Laptop B takes the Story over:
 * - takeover says the local work left behind did not come along, and asks only for the document
 *   the current phase uses;
 * - nothing of laptop A's machine (its paths, machine ID, lock tokens) reaches laptop B's state;
 * - restoring A's backup on B brings back the draft, under its operation ID, and the document,
 *   under its ID, and restoring it twice changes nothing.
 * Then the approved configuration advances on A (the draft is approved there). Restoring the same
 * backup on a third laptop does not save the draft again: it is checked against the configuration
 * as it is now and refused, so an approved change never comes back as a waiting draft.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

function laptop(base, name) {
  const root = path.join(base, name);
  const env = { ...isolatedTestEnvironment(path.join(root, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: `Person on ${name}`, SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const flow = (cwd, args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
    if (status !== null) assert.equal(result.status, status, `${name}: singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const json = (cwd, args, status = 0) => JSON.parse(flow(cwd, [...args, '--json'], status).stdout);
  return { name, root, checkout: path.join(root, 'checkout'), machine: path.join(root, 'machine'), env, flow, json };
}

/** Every file under `directory`, as text, for searching a machine's state for another machine's values. */
async function texts(directory) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) found.push([file, await readFile(file, 'utf8').catch(() => '')]);
    }
  };
  await walk(directory);
  return found;
}

test('a Story taken over on another laptop discloses what stayed behind, reuses nothing of that laptop, and restores its backup', slowLane({ timeout: 900_000 }), async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-m5-laptops-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const seed = path.join(base, 'seed'); const remote = path.join(base, 'remote.git');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'README.md'), '# Two laptops\n');
  await initializeDefinition(seed);
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'seed');
  git(base, 'clone', '-q', '--bare', seed, remote);

  // Laptop A: a draft and a Story with a laptop-local document, published.
  const a = laptop(base, 'laptop-a');
  a.flow(base, ['bootstrap', remote, '--capability', 'laptops', '--into', a.checkout]);
  a.flow(a.checkout, ['instruction', 'create', 'tone', '--description', 'How to phrase comments.', '--instructions', 'Be kind and specific.']);
  const brief = path.join(a.root, 'brief.md');
  await writeFile(brief, 'The intake brief, kept only on laptop A.\n');
  const started = a.json(a.checkout, ['start', 'M5-1', '--isolated-worktree', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Two laptops', '--document', brief, '--document-name', 'Laptop brief', '--document-phases', 'intake', '--document-store', 'local']);
  const storyA = (started.data ?? started).repositoryPath;
  git(storyA, 'push', '-q', '-u', 'origin', 'M5-1');

  const carry = path.join(base, 'carry');
  const inside = a.json(a.checkout, ['backup', 'create', '--out', path.join(storyA, 'backup')], 1);
  assert.equal(inside.error.code, 'BACKUP_INSIDE_CHECKOUT', 'the only copy of a local document is never put inside a checkout');
  const created = a.json(a.checkout, ['backup', 'create', '--out', carry]);
  assert.deepEqual([created.configurationDrafts, created.documents], [1, 1]);
  const manifest = await readFile(path.join(carry, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes(a.root), 'a backup carries no path of the laptop that made it');
  assert.deepEqual(JSON.parse(manifest).notCarried.never, ['locks', 'sessions', 'caches and indexes', 'journals', 'temporary files']);

  // Laptop B takes the Story over.
  const b = laptop(base, 'laptop-b');
  b.flow(base, ['bootstrap', remote, '--capability', 'laptops', '--into', b.checkout]);
  const taken = b.json(b.checkout, ['session', 'takeover', 'M5-1']);
  assert.equal(taken.ready, false, 'intake uses the document that stayed on laptop A');
  assert.deepEqual(taken.unavailableDocuments.map((document) => document.name), ['Laptop brief']);
  assert.match(taken.localWorkNotCarried.message, /configuration drafts/);
  assert.match(taken.localWorkNotCarried.message, /not recoverable here unless/);
  assert.equal(taken.localWorkNotCarried.restore, 'singularity-flow backup restore <DIRECTORY>');

  // Nothing of laptop A's machine reached laptop B: no path, no machine ID, no lock token.
  const machineIdA = (await readFile(a.env.SINGULARITY_FLOW_MACHINE_ID_FILE, 'utf8')).trim();
  assert.notEqual(machineIdA, (await readFile(b.env.SINGULARITY_FLOW_MACHINE_ID_FILE, 'utf8')).trim());
  const locksA = (await texts(path.join(git(storyA, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'singularity-flow', 'locks')))
    .flatMap(([, text]) => [...text.matchAll(/"lockToken"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]));
  const stateB = [...await texts(b.machine), ...await texts(path.join(b.checkout, '.git', 'singularity-flow')),
    ['takeover result', JSON.stringify(taken)]];
  for (const [file, text] of stateB) {
    assert.ok(!text.includes(a.root), `${file} holds a path of laptop A`);
    assert.ok(!text.includes(machineIdA), `${file} holds laptop A's machine ID`);
    for (const token of locksA) assert.ok(!text.includes(token), `${file} holds a lock token of laptop A`);
  }

  // Restoring A's backup on B: the draft under its operation ID, the document under its ID.
  const preview = b.json(b.checkout, ['backup', 'inspect', carry]);
  assert.equal(preview.fromThisMachine, false);
  assert.deepEqual(preview.configurationDrafts.map((draft) => draft.status), ['to-restore']);
  assert.deepEqual(preview.documents.map((document) => [document.status, document.name]), [['to-restore', 'Laptop brief']]);
  const restored = b.json(b.checkout, ['backup', 'restore', carry]);
  assert.equal(restored.status, 'restored', JSON.stringify(restored, null, 2));
  assert.deepEqual(restored.counts.configurationDrafts, { restored: 1, 'already-saved': 0, 'already-approved': 0, refused: 0 });
  assert.equal(restored.counts.documents.restored, 1);
  assert.deepEqual(restored.effects, { shared: false, committed: false, pushed: false, proposed: false, approvalsChanged: false });
  const draftA = JSON.parse(manifest).configurationDrafts[0];
  const draftsB = b.json(b.checkout, ['configuration', 'drafts']).drafts;
  assert.deepEqual(draftsB.map((draft) => [draft.operationId, draft.description]), [[draftA.operationId, draftA.description]]);
  assert.equal(b.json(b.checkout, ['session', 'takeover', 'M5-1']).documentsToRestore, null, 'the document intake uses is back');
  const again = b.json(b.checkout, ['backup', 'restore', carry]);
  assert.deepEqual([again.counts.configurationDrafts['already-saved'], again.counts.documents['already-present']], [1, 1],
    'restoring the same backup again changes nothing');
  // A document the Story no longer holds, replaced or detached since the backup, is never restored.
  const moved = path.join(base, 'carry-moved');
  await cp(carry, moved, { recursive: true });
  const earlier = Buffer.from('An earlier version of the brief.\n');
  const earlierSha = createHash('sha256').update(earlier).digest('hex');
  await writeFile(path.join(moved, 'objects', earlierSha), earlier);
  const movedManifest = JSON.parse(await readFile(path.join(moved, 'manifest.json'), 'utf8'));
  movedManifest.documents.push({ workId: 'M5-1', key: `${earlierSha}/brief.md`, sha256: earlierSha, size: earlier.length });
  await writeFile(path.join(moved, 'manifest.json'), JSON.stringify(movedManifest));
  assert.deepEqual(b.json(b.checkout, ['backup', 'restore', moved]).documents.map((document) => document.status),
    ['already-present', 'superseded']);

  // The approved configuration advances on A: the draft is approved there. A laptop restoring the
  // backup now checks the draft against the configuration as it is, and never saves it again.
  a.flow(a.checkout, ['configuration', 'propose']);
  a.flow(a.checkout, ['configuration', 'approve', '--yes']);
  const c = laptop(base, 'laptop-c');
  c.flow(base, ['bootstrap', remote, '--capability', 'laptops', '--into', c.checkout]);
  const late = c.json(c.checkout, ['backup', 'restore', carry]);
  assert.deepEqual(late.configurationDrafts.map((draft) => draft.status), ['refused'], JSON.stringify(late, null, 2));
  assert.doesNotMatch(JSON.stringify(late.configurationDrafts[0]), /BACKUP_DRAFTS_UNAPPROVED/);
  assert.match(JSON.stringify(late.configurationDrafts[0].problems ?? late.configurationDrafts[0].refusal), /tone/,
    'refused because the approved configuration already holds the instruction');
  assert.deepEqual(c.json(c.checkout, ['configuration', 'drafts']).drafts, [], 'an approved change does not come back as a draft');
  assert.deepEqual(late.documents.map((document) => document.status), ['story-not-here']);
  assert.equal(late.documents[0].next, 'singularity-flow session takeover M5-1 --json');
});

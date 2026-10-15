/**
 * Story discovery in a blobless clone costs a fixed number of remote round trips. `[perf]`
 *
 * A blobless clone, the usual office checkout, holds no other Story's committed workflow.json, so
 * `session candidates` recovered the Stories from the remote, and read every ledger entry, the
 * pinned definition and each Story's state with a lazy fetch of its own: 18 round trips for eight
 * Stories, growing with every Story and every ledger entry. On Windows each one also starts Git's
 * HTTPS helper and the credential manager. A ledger entry now carries its Story's summary, so
 * such Stories are listed without any read; entries written before that are read with one fetch
 * for each kind of blob, once: what that proved is kept by commit, so the next listing reads only
 * the state branch (seven round trips on every listing before, about 11 s in the office).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { canonicalJson } from '../src/ledger.mjs';
import { compactCanonicalJson } from '../src/records.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(base, cwd, args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Discovery Tester',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json'),
      ...env
    }
  });
}

function identity(root) {
  run('git', ['config', 'user.name', 'Discovery Tester'], root);
  run('git', ['config', 'user.email', 'discovery@example.com'], root);
}

/** A remote whose ledger indexes `count` Stories published by this CLI. */
async function publishedStories(t, count) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-discovery-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  run('git', ['init', '-q', '--bare', remote], base);
  run('git', ['init', '-q', '-b', 'main', first], base);
  identity(first);
  await writeFile(path.join(first, 'README.md'), '# Discovery\n');
  assert.equal(flow(base, first, ['init']).status, 0);
  const definitionPath = path.join(first, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.ledger.enabled = true;
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', '.'], first);
  run('git', ['commit', '-qm', 'governance'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  run('git', ['push', '-q', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  for (let index = 1; index <= count; index += 1) {
    const started = flow(base, first, ['start', `DISC-${100 + index}`, '--from-branch', 'main', '--title', `Discovery ${index}`]);
    assert.equal(started.status, 0, started.stderr);
    run('git', ['switch', '-q', 'main'], first);
  }
  run('git', ['config', 'uploadpack.allowFilter', 'true'], remote);
  return { base, remote };
}

/** `session candidates` in a fresh blobless clone, with the Git processes it started. */
function candidatesInBloblessClone(base, remote, label) {
  const partial = path.join(base, `partial-${label}`);
  run('git', ['clone', '--quiet', '--filter=blob:none', '--single-branch', '--branch', 'main',
    pathToFileURL(remote).href, partial], base);
  return { partial, ...candidatesIn(base, partial) };
}

function candidatesIn(base, partial) {
  const result = flow(base, partial, ['session', 'candidates', '--json', '--diagnostics'], {
    SINGULARITY_FLOW_SUBPROCESS_PROBE: '1', SINGULARITY_FLOW_GIT_FACT_STORE: 'off'
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = (pattern) => result.stderr.split('\n')
    .map((line) => /^\s+(\d+)x\s+\d+ ms\s+(.*)$/u.exec(line)).filter(Boolean)
    .filter((match) => pattern.test(match[2])).reduce((sum, match) => sum + Number(match[1]), 0);
  return {
    discovery: JSON.parse(result.stdout),
    perBlobReads: calls(/^git cat-file blob$/u),
    byIdFetches: calls(/^git -c fetch\.negotiationAlgorithm=noop$/u),
    // The recovery's temporary clone and its fetch of the Stories' commits.
    recoveryTransfers: calls(/^git (?:-c maintenance\.auto=false|fetch\b)/u)
  };
}

/** Rewrite the remote ledger as a release before Story summaries wrote it. */
async function withoutSummaries(base, remote) {
  const work = path.join(base, 'rewrite');
  run('git', ['clone', '-q', '--single-branch', '--branch', 'state', remote, work], base);
  identity(work);
  const headPath = path.join(work, 'ledger/head.json');
  const head = JSON.parse(await readFile(headPath, 'utf8'));
  const byHash = new Map();
  const entriesRoot = path.join(work, 'ledger/entries');
  for (const capability of await readdir(entriesRoot)) {
    for (const file of await readdir(path.join(entriesRoot, capability))) {
      const absolute = path.join(entriesRoot, capability, file);
      byHash.set(path.basename(file, '.json'), { absolute, value: JSON.parse(await readFile(absolute, 'utf8')) });
    }
  }
  const chain = [];
  for (let cursor = head.entryHash; cursor; cursor = byHash.get(cursor).value.parentEntryHash) chain.unshift(byHash.get(cursor));
  let parent = null;
  for (const entry of chain) {
    const { workId, workType, phase, generation, branch } = entry.value.subject;
    const value = { ...entry.value, parentEntryHash: parent, subject: { workId, workType, phase, generation, branch } };
    const hash = createHash('sha256').update(compactCanonicalJson(value)).digest('hex');
    await unlink(entry.absolute);
    await writeFile(path.join(path.dirname(entry.absolute), `${hash}.json`), canonicalJson(value));
    parent = hash;
  }
  await writeFile(headPath, canonicalJson({ ...head, entryHash: parent }));
  run('git', ['add', '-A', 'ledger'], work);
  run('git', ['commit', '-qm', 'ledger without Story summaries'], work);
  run('git', ['push', '-q', 'origin', 'state'], work);
}

const comparable = (items) => JSON.parse(compactCanonicalJson(items.map(({ id, branch, title, createdAt, status, phase, progress, commitOid, aliases }) =>
  ({ id, branch, title, createdAt, status, phase, progress, commitOid, aliases }))));

test('a blobless clone lists summarized Stories with no Story read, and older entries in three fetches', async (t) => {
  const { base, remote } = await publishedStories(t, 3);

  const summarized = candidatesInBloblessClone(base, remote, 'summarized');
  assert.equal(summarized.discovery.source, 'state-ledger', 'no metadata recovery from the remote');
  assert.deepEqual(summarized.discovery.items.map((item) => item.id), ['DISC-101', 'DISC-102', 'DISC-103']);
  assert.equal(summarized.discovery.unavailableCount, 0);
  assert.equal(summarized.perBlobReads, 0);
  assert.equal(summarized.byIdFetches, 0);

  await withoutSummaries(base, remote);
  const older = candidatesInBloblessClone(base, remote, 'older');
  assert.equal(older.discovery.source, 'materialized-metadata-recovery');
  assert.equal(older.discovery.unavailableCount, 0);
  assert.deepEqual(comparable(older.discovery.items), comparable(summarized.discovery.items),
    'a summary lists exactly what the committed state proves');
  // One fetch for the ledger entries and head, one for the pinned definitions, one for the
  // Stories' workflow.json; this used to be one lazy fetch per blob: eight for three Stories.
  assert.equal(older.perBlobReads, 0);
  assert.equal(older.byIdFetches, 3);

  const again = candidatesIn(base, older.partial);
  assert.equal(again.discovery.source, 'state-ledger', 'proven once, not recovered on every listing');
  assert.equal(again.byIdFetches + again.recoveryTransfers + again.perBlobReads, 0);
  assert.deepEqual(comparable(again.discovery.items), comparable(summarized.discovery.items));

  // A damaged file is ignored and rewritten; it never removes or invents a Story.
  const remembered = path.join(older.partial, '.git/singularity-flow/story-summaries.json');
  const rows = JSON.parse(await readFile(remembered, 'utf8'));
  rows.items[0].title = '';
  await writeFile(remembered, JSON.stringify(rows));
  const repaired = candidatesIn(base, older.partial);
  assert.equal(repaired.discovery.source, 'materialized-metadata-recovery');
  assert.deepEqual(comparable(repaired.discovery.items), comparable(summarized.discovery.items));
  assert.equal(candidatesIn(base, older.partial).recoveryTransfers, 0);
});

/**
 * A publication asks Git only what its outcome depends on. `[perf]`
 *
 * Measured on a Story start (production bootstrap: approved configuration and a state ledger):
 * 216 Git processes. Publication validation ran the all-Stories ledger report (every remote
 * Story branch's intents, the whole ledger verified, its whole log read; about 33 processes)
 * whose warnings it then discarded, and the publication tree was built in a private index four
 * times. Each publish, submit and approval paid the same.
 */
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition } from '../src/config.mjs';
import { changes, commitIsolated } from '../src/git.mjs';
import { setAgentSession } from '../src/session.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { createWorkflow, loadConfig, loadWorkflow, validateWorkflow } from '../src/state.mjs';

const source = (relative) => fileURLToPath(new URL(`../src/${relative}`, import.meta.url));

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Publication Tester');
  git(root, 'config', 'user.email', 'publication@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Publication processes\n');
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial');
  return root;
}

/** Run `expression` in a fresh process with the subprocess probe; Git process counts by verb. */
function probe(root, expression) {
  const script = `const git = await import(${JSON.stringify(source('git.mjs'))}); ${expression};`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1', SINGULARITY_FLOW_GIT_FACT_STORE: 'off' }
  });
  const counts = {};
  for (const [, calls, key] of result.stderr.matchAll(/^\s+(\d+)x\s+\d+ ms\s+git (\S+)/gmu)) {
    counts[key] = (counts[key] ?? 0) + Number(calls);
  }
  return { status: result.status, stderr: result.stderr, counts };
}

test('an isolated commit builds its tree once and still admits exactly the bytes it commits', async (t) => {
  const root = await repository(t, 'sflow-commit-once-');
  await writeFile(path.join(root, 'governed.json'), '{"ready":true}\n');
  const head = git(root, 'rev-parse', 'HEAD');
  const committed = probe(root, `await git.commitIsolated(process.cwd(), 'governed', ['governed.json'], { expectedHead: ${JSON.stringify(head)} })`);
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(committed.counts['read-tree'], 1, 'one private index, not a second build to compare with');
  assert.equal(committed.counts['write-tree'], 1);
  assert.equal(git(root, 'show', '--format=', '--name-only', 'HEAD'), 'governed.json');

  // The admission the second build used to make now runs on the committed tree itself.
  await writeFile(path.join(root, 'leak.json'), '{"key":"AKIA1234567890ABCDEF"}\n');
  const before = git(root, 'rev-parse', 'HEAD');
  const refused = probe(root, `await git.commitIsolated(process.cwd(), 'leak', ['leak.json'], { expectedHead: ${JSON.stringify(before)} })`);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /SECRET_DETECTED|secret/i);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before, 'nothing was committed');
});

test('publication updates only owned index entries without a repository-wide stat refresh', async t => {
  const root = await repository(t, 'sflow-scoped-index-sync-');
  await writeFile(path.join(root, 'note.txt'), 'original note\n');
  git(root, 'add', 'note.txt'); git(root, 'commit', '-qm', 'tracked note');
  await writeFile(path.join(root, 'note.txt'), 'staged note\n'); git(root, 'add', 'note.txt');
  await writeFile(path.join(root, 'note.txt'), 'unstaged note\n');
  await writeFile(path.join(root, 'README.md'), 'unrelated worktree edit\n');
  const staged = git(root, 'ls-files', '--stage', '--', 'note.txt');
  const before = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'governed.json'), '{"ready":true}\n');
  // The publication boundary deliberately strips diagnostic Git environment overrides. Observe
  // the real child invocation in-process instead of weakening that isolation just for tracing.
  const resets = [], originalSpawn = childProcess.spawnSync;
  childProcess.spawnSync = (executable, args, options) => {
    if (args.includes('reset')) resets.push([...args]);
    return originalSpawn(executable, args, options);
  };
  syncBuiltinESMExports();
  let committed;
  try { committed = await commitIsolated(root, 'owned publication', ['governed.json'], { expectedHead: before }); }
  finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }
  assert.equal(git(root, 'rev-parse', 'HEAD'), committed);
  assert.equal(git(root, 'ls-files', '--stage', '--', 'note.txt'), staged);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'unstaged note\n');
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'unrelated worktree edit\n');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'note.txt');
  assert.equal(git(root, 'diff', '--name-only', 'HEAD~1', 'HEAD'), 'governed.json');
  assert.equal(resets.length, 1);
  assert.ok(resets[0].includes('--no-refresh'));
  assert.deepEqual(resets[0].slice(resets[0].indexOf('--') + 1), ['governed.json']);
});

test('owned checkout can retain fresh stat metadata while read snapshots and explicit policy stay read-only', async t => {
  const root = await repository(t, 'sflow-owned-index-stat-');
  const index = path.join(root, '.git', 'index'), readme = path.join(root, 'README.md');
  const content = await readFile(readme);
  const previous = process.env.GIT_OPTIONAL_LOCKS;
  try {
    delete process.env.GIT_OPTIONAL_LOCKS;
    await utimes(readme, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
    const originalIndex = await readFile(index);
    assert.equal(changes(root), '');
    assert.deepEqual(await readFile(index), originalIndex, 'ordinary reads do not write Git stat metadata');
    assert.equal(changes(root, { refreshIndex: true }), '');
    assert.notDeepEqual(await readFile(index), originalIndex, 'owned mutation retains verified timestamps');
    assert.deepEqual(await readFile(readme), content);
    assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(root, 'branch', '--show-current'), 'main');
    process.env.GIT_OPTIONAL_LOCKS = '0';
    await utimes(readme, new Date(Date.now() - 240000), new Date(Date.now() - 240000));
    const retained = await readFile(index);
    assert.equal(changes(root, { refreshIndex: true }), '');
    assert.deepEqual(await readFile(index), retained, 'explicit host policy wins');
  } finally {
    if (previous === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = previous;
  }
});

test('publication validation skips the all-Stories ledger report only where it cannot refuse', async (t) => {
  const root = await repository(t, 'sflow-ledger-report-');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initialize');
  git(root, 'switch', '-q', '-c', 'LEDGER-1');
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const actor = { name: 'Publication Tester', email: 'publication@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'developer', 'LEDGER-1', { phaseId: 'intake', source: 'test' });
  await createWorkflow(root, config, {
    id: 'LEDGER-1', title: 'Ledger report', baseBranch: 'main', workType: 'feature', agent: 'developer',
    source: { type: 'manual', key: 'LEDGER-1', title: 'Ledger report', description: 'Ledger report scope.',
      acceptanceCriteria: ['The report decides only what it can refuse.'] }
  });
  const story = await loadWorkflow(root, config, 'LEDGER-1');
  // The ledger is on but its state branch was never initialized, so the report has something to say.
  const withLedger = (ledger) => {
    const workflow = structuredClone(story);
    workflow.resolution = { ...workflow.resolution, ledger: { ...(workflow.resolution?.ledger ?? config.ledger), enabled: true, ...ledger } };
    return workflow;
  };
  const notInitialized = /Capability ledger branch 'state' is not initialized/;

  const shown = await validateWorkflow(root, config, withLedger({}));
  assert.ok(shown.warnings.some((warning) => notInitialized.test(warning)), 'validate and doctor still report it');
  const publication = await validateWorkflow(root, config, withLedger({}), { reportWarnings: false });
  assert.equal(publication.warnings.some((warning) => notInitialized.test(warning)), false);
  assert.equal(publication.valid, shown.valid, 'an unenforced report never changed the outcome');

  for (const enforced of [{ enforcement: 'required' }, { behind: 'block' }]) {
    const refused = await validateWorkflow(root, config, withLedger(enforced), { reportWarnings: false });
    assert.ok(refused.errors.some((error) => notInitialized.test(error)), JSON.stringify(enforced));
  }
});

test('a Candidate takes an admitted tree only with its governed paths', async (t) => {
  const root = await repository(t, 'sflow-admitted-tree-');
  const head = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const createdBy = { kind: 'human', id: 'publication@example.invalid' };
  for (const request of [
    { admittedTree: tree },
    { admittedTree: tree, paths: [] },
    { admittedTree: tree, paths: ['README.md'], exactCandidateCommit: head }
  ]) {
    await assert.rejects(freezeSgosCandidate(root, { createdBy, ...request }),
      (error) => error.code === 'SGOS_CANDIDATE_SCOPE_INVALID', JSON.stringify(Object.keys(request)));
  }
  assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# Publication processes\n');
});

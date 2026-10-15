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
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition } from '../src/config.mjs';
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

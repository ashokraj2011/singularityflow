import test from 'node:test'; import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import YAML from 'yaml';
import { assertCommitGitAdmission, installCommitPolicyHintParser } from '../src/util.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

const ENFORCE = 'git:\n  commitPolicy:\n    mode: enforce\n';
const OFF = 'git:\n  commitPolicy:\n    mode: off\n';
const WRITE = ['commit', '-m', 'an ordinary write'];
const refused = { code: 'RCP_OWNER_ADMISSION_REQUIRED' };

function repository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sflow-rcp-hint-'));
  t.after(() => { installCommitPolicyHintParser(null); rmSync(root, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Hint Tester');
  git('config', 'user.email', 'hint@example.invalid');
  writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { root, git };
}

/** A branch at sflow/config whose only definition says `definition`; the worktree has none. */
function approve({ root, git }, definition, ref = 'refs/heads/sflow/config') {
  git('switch', '-qc', 'approved');
  mkdirSync(path.join(root, 'singularity'));
  writeFileSync(path.join(root, 'singularity/workflow.yml'), definition);
  git('add', '.');
  git('commit', '-qm', 'approve');
  const commit = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  git('update-ref', ref, commit);
  git('branch', '-qD', 'approved');
  return commit;
}

const parsedMode = bytes => YAML.parse(bytes)?.git?.commitPolicy?.mode ?? 'absent';

test('another process writing the same .git during the read is no reason to refuse a person\'s own write', (t) => {
  const f = repository(t);
  mkdirSync(path.join(f.root, 'singularity'));
  writeFileSync(path.join(f.root, 'singularity/workflow.yml'), OFF);
  let reads = 0;
  installCommitPolicyHintParser((bytes) => {
    // A fetch, Git maintenance or an editor's own git config, landing inside the read.
    if (++reads === 1) appendFileSync(path.join(f.root, '.git/config'), '[sflow]\n\trace = 1\n');
    return parsedMode(bytes);
  });
  assert.doesNotThrow(() => assertCommitGitAdmission(f.root, WRITE));
  assert.equal(reads, 2, 'the read that overlapped the write decided nothing, and the next one settled');
});

test('a definition caught half written is read again, and only a policy that holds refuses', (t) => {
  const f = repository(t);
  const file = path.join(f.root, 'singularity/workflow.yml');
  mkdirSync(path.dirname(file));
  writeFileSync(file, 'git: [half written');
  installCommitPolicyHintParser((bytes) => {
    if (bytes.includes('half written')) writeFileSync(file, OFF);
    return parsedMode(bytes);
  });
  assert.doesNotThrow(() => assertCommitGitAdmission(f.root, WRITE));
  // The same file left unreadable keeps the protection: nobody can say no policy applies.
  writeFileSync(file, 'git: [unreadable');
  assert.throws(() => assertCommitGitAdmission(f.root, WRITE), refused);
});

test('a policy adopted during the read is honoured, not lost to the read that overlapped it', (t) => {
  const f = repository(t);
  const file = path.join(f.root, 'singularity/workflow.yml');
  mkdirSync(path.dirname(file));
  writeFileSync(file, OFF);
  installCommitPolicyHintParser((bytes) => {
    if (bytes === OFF) writeFileSync(file, ENFORCE);
    return parsedMode(bytes);
  });
  assert.throws(() => assertCommitGitAdmission(f.root, WRITE), refused);
});

for (const [label, ref, pack] of [
  ['a local branch', 'refs/heads/sflow/config', false],
  ['a packed local branch', 'refs/heads/sflow/config', true],
  ['a remote-tracking ref', 'refs/remotes/origin/sflow/config', false],
  ['a packed remote-tracking ref', 'refs/remotes/origin/sflow/config', true]
]) {
  test(`an enforced policy approved on ${label} refuses a Git write`, (t) => {
    const f = repository(t);
    approve(f, ENFORCE, ref);
    if (pack) f.git('pack-refs', '--all');
    assert.throws(() => assertCommitGitAdmission(f.root, WRITE), refused);
  });
}

test('a repository whose refs only Git can read is asked through Git, and still refuses', (t) => {
  const f = repository(t);
  try { execFileSync('git', ['init', '-q', '--ref-format=reftable', path.join(f.root, 'reftable-probe')], { stdio: 'ignore' }); }
  catch { return t.skip('this Git has no reftable support'); }
  rmSync(path.join(f.root, '.git'), { recursive: true, force: true });
  rmSync(path.join(f.root, 'reftable-probe'), { recursive: true, force: true });
  f.git('init', '-q', '-b', 'main', '--ref-format=reftable');
  f.git('config', 'user.name', 'Hint Tester');
  f.git('config', 'user.email', 'hint@example.invalid');
  f.git('add', '.');
  f.git('commit', '-qm', 'base');
  assert.doesNotThrow(() => assertCommitGitAdmission(f.root, WRITE));
  approve(f, ENFORCE);
  assert.throws(() => assertCommitGitAdmission(f.root, WRITE), refused);
});

test('a commit already read, and a repository with no approved ref, cost no Git process', async (t) => {
  const f = repository(t);
  const spawns = async () => {
    const timer = commandTimer('commit-policy-hint', { commandClass: 'mutation' });
    await withCommandTiming(timer, () => assertCommitGitAdmission(f.root, WRITE));
    return timer.finish().counters['git.spawns'] ?? 0;
  };
  assert.equal(await spawns(), 0, 'no approved ref to read');
  approve(f, OFF);
  assert.equal(await spawns(), 2, 'one approved tree and its one definition');
  // Any config or ref change asks again; this commit's answer is already known.
  appendFileSync(path.join(f.root, '.git/config'), '[sflow]\n\tchanged = 1\n');
  assert.equal(await spawns(), 0);
  f.git('pack-refs', '--all');
  assert.equal(await spawns(), 0);
});

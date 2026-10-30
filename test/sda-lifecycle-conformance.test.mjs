/**
 * SDA M4: the subject branch, behind the lifecycle authority adapter, and the deterministic test
 * adapter pass one conformance suite; the test adapter can never be selected as lifecycle authority.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { createGitLedgerAdapter } from '../src/sda/git-ledger-adapter.mjs';
import {
  LIFECYCLE_AUTHORITY_CONTRACT, lifecycleAuthorityDescriptor, selectLifecycleAuthority
} from '../src/sda/lifecycle-authority-contract.mjs';
import { createStoryBranchAuthority, lifecycleAuthority } from '../src/sda/story-branch-authority.mjs';
import { createMemoryLifecycleAuthority } from './helpers/sda-lifecycle-memory-adapter.mjs';
import { lifecycleAuthorityConformance } from './helpers/sda-lifecycle-conformance.mjs';
import { realGitForTest, writeGitTestWrapper } from './helpers/git-test-wrapper.mjs';

const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();
const identity = (cwd) => {
  git(cwd, ['config', 'user.name', 'Lifecycle Writer']);
  git(cwd, ['config', 'user.email', 'lifecycle@example.test']);
};

/**
 * A repository on its subject branch with a bare remote that has never seen that branch. Its Git is
 * wrapped on PATH for the lifetime of the fixture: with the marker present, the next push runs and
 * then reports a lost connection, as a response lost after receive-pack accepted the update would.
 */
async function gitFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-lifecycle-'));
  const remote = path.join(parent, 'remote.git');
  const work = path.join(parent, 'work');
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['init', '-q', '-b', 'main', work]);
  identity(work);
  await writeFile(path.join(work, 'README.md'), '# application\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-qm', 'application root']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  const subject = { kind: 'story', id: 'LIFE-1', branch: 'LIFE-1' };
  git(work, ['switch', '-q', '-c', subject.branch]);

  const wrappers = path.join(parent, 'git-wrapper');
  const marker = path.join(parent, 'lose-next-response');
  await writeGitTestWrapper(wrappers, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGitForTest())}, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
if (args.includes('push') && fs.existsSync(${JSON.stringify(marker)}) && result.status === 0) {
  fs.rmSync(${JSON.stringify(marker)});
  process.stderr.write('fatal: the remote end hung up unexpectedly\\n');
  process.exit(128);
}
process.exit(result.status == null ? 1 : result.status);
`);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrappers}${path.delimiter}${previousPath}`;

  let sequence = 0;
  return {
    authority: createStoryBranchAuthority(work),
    subject,
    target: { branch: subject.branch, remote: 'origin' },
    transition({ expectedRemoteSha, content }) {
      return {
        subject,
        allowedPaths: ['governed.json'],
        event: lifecycleEvent({ type: 'binding', subject, payload: { content } }),
        commit: { message: `[${subject.id}] ${content}` },
        publication: {
          mode: 'required', remote: 'origin', branch: subject.branch,
          ...(expectedRemoteSha === undefined ? {} : { expectedRemoteSha })
        },
        state: { write: () => writeFile(path.join(work, 'governed.json'), `${JSON.stringify({ content, sequence: ++sequence })}\n`) }
      };
    },
    async moveAuthority() {
      // Another clone publishes to the subject's branch first.
      const other = path.join(parent, `other-${++sequence}`);
      run('git', ['clone', '-q', '--branch', subject.branch, remote, other]);
      identity(other);
      await writeFile(path.join(other, 'other.txt'), `another writer ${sequence}\n`);
      git(other, ['add', 'other.txt']);
      git(other, ['commit', '-qm', 'another writer']);
      git(other, ['push', '-q', 'origin', subject.branch]);
      return git(other, ['rev-parse', 'HEAD']);
    },
    async loseNextResponse() { await writeFile(marker, 'lose\n'); },
    async cleanup() {
      process.env.PATH = previousPath;
      await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

function memoryFixture() {
  const authority = createMemoryLifecycleAuthority();
  const subject = { kind: 'story', id: 'LIFE-M', branch: 'LIFE-M' };
  return {
    authority,
    subject,
    target: { branch: subject.branch, remote: 'memory' },
    transition: ({ expectedRemoteSha, content }) => ({
      subject,
      event: { payload: { content } },
      publication: { mode: 'required', branch: subject.branch, ...(expectedRemoteSha === undefined ? {} : { expectedRemoteSha }) }
    }),
    moveAuthority: () => authority.moveAuthority(subject.branch),
    loseNextResponse: () => authority.loseNextResponse(),
    cleanup: () => {}
  };
}

lifecycleAuthorityConformance('story-branch authority', gitFixture);
lifecycleAuthorityConformance('memory lifecycle authority', memoryFixture);

test('only the production subject-branch adapter is selected as lifecycle authority', async () => {
  const selected = lifecycleAuthority(os.tmpdir());
  assert.deepEqual([selected.descriptor.id, selected.descriptor.contract, selected.descriptor.qualification],
    ['subject-branch', LIFECYCLE_AUTHORITY_CONTRACT, 'production']);
  assert.throws(() => selectLifecycleAuthority(createMemoryLifecycleAuthority()),
    (error) => error.code === 'SDA_ADAPTER_NOT_PRODUCTION');
  assert.throws(() => selectLifecycleAuthority(createGitLedgerAdapter(os.tmpdir(), { enabled: true, branch: 'state' })),
    (error) => error.code === 'SDA_ADAPTER_CONTRACT_MISMATCH');
  const partial = { descriptor: lifecycleAuthorityDescriptor({ id: 'partial', qualification: 'production', capabilities: ['exact-observation'] }) };
  assert.throws(() => selectLifecycleAuthority(partial),
    (error) => error.code === 'SDA_ADAPTER_CAPABILITY_UNSUPPORTED'
      && error.details.missing.join() === 'conditional-transition,pending-recovery,cancellation');
});

/** Real Git proof fixture shared by the native and compatibility conformance suites. */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../../src/util.mjs';
import { createLedgerIntent, initializeLedger, prepareLedgerAppend } from '../../src/ledger.mjs';
import { createGitLedgerAdapter } from '../../src/sda/git-ledger-adapter.mjs';
import { gitTestWrapperEnvironment, realGitForTest, writeGitTestWrapper } from './git-test-wrapper.mjs';
import { rewriteRecordedEntry } from './ledger-rewrite.mjs';

export const LEDGER = {
  enabled: true, branch: 'state', remote: 'origin', behind: 'block', enforcement: 'shadow',
  signing: 'off', trustTier: 'T0', maxRetries: 3
};

function git(cwd, args) {
  return run('git', args, { cwd });
}

/**
 * A repository with an initialized ledger and a local bare remote. Its Git is wrapped: when a
 * concurrent write is staged, the first push to the state branch first moves the remote's state ref
 * to that write, exactly as another clone's push landing a moment earlier would.
 */
export async function gitLedgerFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-conformance-'));
  const remote = path.join(parent, 'remote.git');
  const work = path.join(parent, 'work');
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['init', '-q', '-b', 'main', work]);
  git(work, ['config', 'user.name', 'Conformance Writer']);
  git(work, ['config', 'user.email', 'conformance@example.test']);
  await writeFile(path.join(work, 'README.md'), '# application\n');
  git(work, ['add', 'README.md']);
  git(work, ['commit', '-qm', 'application root']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);
  await initializeLedger(work, LEDGER);
  const sourceRevision = git(work, ['rev-parse', 'HEAD']).stdout.trim();

  const wrappers = path.join(parent, 'git-wrapper');
  const staged = path.join(parent, 'concurrent-write');
  await writeGitTestWrapper(wrappers, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGitForTest())};
const staged = ${JSON.stringify(staged)};
if (args[0] === 'push' && args.some((arg) => arg.endsWith(':refs/heads/state')) && fs.existsSync(staged)) {
  const commit = fs.readFileSync(staged, 'utf8').trim();
  fs.rmSync(staged);
  const moved = spawnSync(realGit, ['--git-dir', ${JSON.stringify(remote)}, 'update-ref', 'refs/heads/state', commit], { encoding: 'utf8' });
  if (moved.status !== 0) { process.stderr.write(moved.stderr); process.exit(1); }
}
const result = spawnSync(realGit, args, { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status == null ? 1 : result.status);
`);
  const env = gitTestWrapperEnvironment(wrappers);
  const adapter = createGitLedgerAdapter(work, LEDGER, { env });
  return {
    adapter,
    work,
    ledgerConfig: LEDGER,
    ledgerOptions: { env },
    sourceRevision,
    async concurrentAppend(event) {
      // Another clone builds its entry on the state it sees now and stages it for the race.
      const other = path.join(parent, 'other-clone');
      if (!existsSync(other)) {
        run('git', ['clone', '-q', remote, other]);
        git(other, ['config', 'user.name', 'Other Writer']);
        git(other, ['config', 'user.email', 'other@example.test']);
      }
      git(other, ['fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state']);
      const intent = createLedgerIntent({
        eventType: event.eventType, capabilityId: `story-${event.subject.workId}`,
        subject: event.subject, actor: event.actor, payload: event.payload
      });
      const prepared = await prepareLedgerAppend(other, LEDGER, intent, event.sourceRevision);
      git(other, ['push', '-q', 'origin', `${prepared.ledgerCommit}:refs/sda-conformance/staged`]);
      if (prepared.pinRef) git(other, ['push', '-q', 'origin', `${event.sourceRevision}:${prepared.pinRef}`]);
      await writeFile(staged, prepared.ledgerCommit);
    },
    async forgeDigest(id) {
      await rewriteRecordedEntry(work, parent, id, (entry) => ({ ...entry, payloadDigest: 'f'.repeat(64) }));
    },
    otherNamespace() {
      return createGitLedgerAdapter(work, { ...LEDGER, branch: 'state-other' }, { env });
    },
    cleanup: () => rm(parent, { recursive: true, force: true })
  };
}

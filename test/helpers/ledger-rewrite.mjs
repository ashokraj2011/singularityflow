/** Test-only: rewrite a recorded ledger entry as another writer could have left it. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, sha256 } from '../../src/ledger.mjs';
import { run } from '../../src/util.mjs';

function git(root, args) {
  return run('git', args, { cwd: root });
}

/**
 * Rewrite one recorded entry on the state branch the way another writer could have left it: an
 * older client (no payload digest) or a forged one. The entry, its idempotency index, its event
 * record and the head all move to the rewritten entry's hash, so only the digest differs.
 */
export async function rewriteRecordedEntry(root, parent, eventId, change) {
  const worktree = await mkdtemp(path.join(parent, 'rewrite-state-'));
  await rm(worktree, { recursive: true, force: true });
  git(root, ['fetch', 'origin', '+refs/heads/state:refs/remotes/origin/state']);
  git(root, ['worktree', 'add', '--detach', worktree, 'refs/remotes/origin/state']);
  const read = async (relative) => JSON.parse(await readFile(path.join(worktree, relative), 'utf8'));
  const write = (relative, value) => writeFile(path.join(worktree, relative), canonicalJson(value));
  const event = await read(`ledger/events/${eventId}.json`);
  const entryFile = git(worktree, ['ls-files', 'ledger/entries']).stdout.split('\n')
    .find((file) => file.endsWith(`/${event.entryHash}.json`));
  const entry = change(await read(entryFile));
  const entryHash = sha256(canonicalJson(entry));
  await rm(path.join(worktree, entryFile));
  const entryPath = `${path.posix.dirname(entryFile)}/${entryHash}.json`;
  await write(entryPath, entry);
  const indexFile = `ledger/idempotency/${event.idempotencyHash}.json`;
  const index = await read(indexFile);
  if (entry.payloadDigest === undefined) delete index.payloadDigest;
  else index.payloadDigest = entry.payloadDigest;
  await write(indexFile, { ...index, entryHash, entryPath });
  await write(`ledger/events/${eventId}.json`, { ...event, entryHash });
  await write('ledger/head.json', { ...(await read('ledger/head.json')), entryHash });
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-m', 'Rewrite one recorded entry']);
  git(worktree, ['push', 'origin', 'HEAD:refs/heads/state']);
  git(root, ['worktree', 'remove', '--force', worktree]);
}

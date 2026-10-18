/** Local, bounded reads of the exact state commit. Only proven missing ledger blobs may hydrate. */
import { run, SingularityFlowError } from './util.mjs';
import { readObjectsBatch } from './git-ref-tree.mjs';
import { safeGitDiagnosticReference } from './git-remote-diagnostics.mjs';
import { STORY_STATE_INDEX_LIMIT } from './story-state-index.mjs';
import { processResultSucceeded } from './process-result.mjs';

const HEAD = 'ledger/head.json';
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export async function readSessionStateIndex(root, commit, { ref, hydrate = null, env = process.env } = {}) {
  const localEnv = { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  const fail = (message, details = {}, code = 'SESSION_STATE_INDEX_INVALID') => {
    throw new SingularityFlowError(message, { code, details: { ref, commit, ...details } });
  };
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit ?? '')) fail('The state index requires one exact commit.');
  // Do not request %(objectsize): blobless clones have the tree, but not necessarily its blobs.
  const listed = run('git', ['ls-tree', '-r', '-z',
    '--format=%(objectmode)%x09%(objecttype)%x09%(objectname)%x09%(path)',
    commit, '--', HEAD, 'ledger/entries'], {
    cwd: root, env: localEnv, allowFailure: true, maxBuffer: 16 * 1024 * 1024, timeoutMs: 30_000
  });
  if (!processResultSucceeded(listed)) fail(
    `Git could not read the state index tree. ${safeGitDiagnosticReference(listed)}`,
    { timedOut: listed.timedOut === true, timeoutMs: listed.timeoutMs ?? null,
      exitCode: listed.status ?? null, signal: listed.signal ?? null }, 'SESSION_STATE_INDEX_UNAVAILABLE');
  const entries = new Map();
  const objectId = new RegExp(`^[0-9a-f]{${commit.length}}$`, 'u');
  for (const row of String(listed.stdout ?? '').split('\0')) {
    if (!row) continue;
    const [mode, type, oid, ...parts] = row.split('\t');
    const file = parts.join('\t');
    if (file !== HEAD && !/^ledger\/entries\/(?:[^/]+\/)*[^/]+\.json$/u.test(file)) continue;
    if (!['100644', '100755'].includes(mode) || type !== 'blob'
        || !objectId.test(oid ?? '')
        || file.split('/').some(part => !part || part === '.' || part === '..') || entries.has(file)) {
      fail('The state index contains invalid ledger file metadata.');
    }
    entries.set(file, oid);
    if (entries.size > STORY_STATE_INDEX_LIMIT + 1) fail('The state index exceeds its record bound.');
  }
  if (!entries.has(HEAD)) fail(`The state branch is missing ${HEAD}; it was not treated as an empty roster.`);
  const oids = [...new Set(entries.values())];
  const inspect = () => {
    const answers = readObjectsBatch(root, oids, { env: localEnv, checkOnly: true });
    if (!answers) fail('Git could not inspect the state index objects.', {}, 'SESSION_STATE_INDEX_UNAVAILABLE');
    let total = 0;
    const missing = [];
    for (const oid of oids) {
      const answer = answers.get(oid);
      if (answer?.status === 'unavailable' && answer.reason === 'object is not available locally') {
        missing.push(oid); continue;
      }
      if (answer?.status !== 'ok' || answer.type !== 'blob' || answer.oid !== oid) {
        fail('The state index contains an unreadable or invalid object.', { object: oid });
      }
      total += answer.size;
      if (answer.size > MAX_OBJECT_BYTES || total > MAX_TOTAL_BYTES) fail('The state index exceeds its byte bound.');
    }
    return missing;
  };
  let missing = inspect();
  if (missing.length && hydrate) {
    // Fetch blobs already proven by this immutable state tree, never application refs or history.
    for (let offset = 0; offset < missing.length; offset += 256) await hydrate(missing.slice(offset, offset + 256));
    missing = inspect();
  }
  if (missing.length) fail('The state branch exists, but required ledger objects are unavailable locally. '
    + 'Refresh the session listing to fetch state metadata; no application branches were scanned.',
  { missingObjectCount: missing.length, objects: missing.slice(0, 20) }, 'SESSION_STATE_INDEX_OBJECTS_UNAVAILABLE');
  const objects = readObjectsBatch(root, oids, { env: localEnv, maxObjectBytes: MAX_OBJECT_BYTES });
  if (!objects || oids.some(oid => objects.get(oid)?.status !== 'ok' || objects.get(oid)?.type !== 'blob')) {
    fail('The state index object bytes could not be verified.', {}, 'SESSION_STATE_INDEX_UNAVAILABLE');
  }
  const files = new Map([...entries].map(([file, oid]) => [file, objects.get(oid).bytes.toString('utf8')]));
  const head = files.get(HEAD); files.delete(HEAD);
  return { head, files };
}

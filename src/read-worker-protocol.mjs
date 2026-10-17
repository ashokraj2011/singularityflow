/** Closed read-only IPC vocabulary. This leaf deliberately imports no engine domain or launcher. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const READ_WORKER_FORMAT = 1;
export const READ_WORKER_MAX_REPLY_BYTES = 40 * 1024 * 1024;
export const READ_WORKER_MAX_QUEUE = 16;
const SLICES = new Set(['repository', 'lifecycle', 'capabilities', 'configuration', 'integrations']);

/** Eligibility is narrower than command classification: no author/review packets or mutation flags. */
export function warmReadRequest(args) {
  if (!Array.isArray(args) || args.length > 32 || args.some(a => typeof a !== 'string' || a.length > 1024)
      || args.at(-1) !== '--json') return null;
  const [method, ...rest] = args.slice(0, -1);
  if (['status', 'nextsteps', 'progress'].includes(method)) {
    if (rest.length > 1 || rest.some(value => !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,255}$/u.test(value))) return null;
    return { method, workId: rest[0] ?? null };
  }
  if (method === 'report') {
    const workId = rest[0] === '--format' ? null : rest[0];
    const flags = workId == null ? rest : rest.slice(1);
    if (flags.length !== 2 || flags[0] !== '--format' || flags[1] !== 'json'
        || (workId != null && !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,255}$/u.test(workId))) return null;
    return { method, workId };
  }
  if (method !== 'snapshot') return null;
  const included = [];
  let ifRevision = null;
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index], value = rest[index + 1];
    if (option === '--include' && SLICES.has(value)) included.push(value);
    else if (option === '--if-revision' && !ifRevision && /^[a-f0-9]{64}$/u.test(value ?? '')) ifRevision = value;
    else return null;
  }
  // Full snapshots have larger optional dependency closures; retain their CLI route.
  return included.length ? { method, included, ifRevision } : null;
}

/** Selected package/build binding; never a scan of the user's repository. */
export async function readWorkerBuildFingerprint(cli) {
  if (!path.isAbsolute(cli) || path.basename(cli) !== 'singularity-flow.mjs'
      || path.basename(path.dirname(cli)) !== 'bin') return null;
  const root = path.dirname(path.dirname(cli));
  const files = ['package.json', 'src/build-info.mjs', 'src/version.mjs',
    'src/read-worker.mjs', 'src/read-worker-protocol.mjs', 'src/read-worker-service.mjs',
    'src/read-worker-client.mjs'];
  const hash = createHash('sha256');
  try {
    for (const file of files) {
      const target = path.join(root, file), info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) return null;
      const bytes = await readFile(target);
      if (file === 'package.json' && JSON.parse(bytes).name !== 'singularity-flow') return null;
      // Installed packages are immutable and content/commit stamped. Unstamped editable sources
      // deliberately stay on the CLI: an in-place source edit must never hide behind warm code.
      if (file === 'src/build-info.mjs' && !/^\s*(?:commit|sourceSha256):\s*['"](?:[a-f0-9]{40}|(?:sha256:)?[a-f0-9]{64})['"]/mu.test(bytes.toString())) return null;
      hash.update(file).update('\0').update(bytes);
    }
    return { root: await realpath(root), fingerprint: hash.digest('hex') };
  } catch { return null; }
}

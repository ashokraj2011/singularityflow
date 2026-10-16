/** Optional installed-definition prewarming, never repository work or a readiness witness. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeCli } from './runner.ts';

type Location = { executable: string; cli: string };
type Result = { status: 'prepared' | 'unavailable' | 'cancelled' | 'failed' };
const preparations = new Map<string, Promise<Result>>();

/** Same executable/environment as real commands; a failed warmup is always retryable. */
export async function prewarmCliRuntime(location: Location, env: NodeJS.ProcessEnv, {
  signal, invoke = invokeCli
}: { signal?: AbortSignal; invoke?: typeof invokeCli } = {}): Promise<Result> {
  if (signal?.aborted) return { status: 'cancelled' };
  if (env.NODE_DISABLE_COMPILE_CACHE === '1') return { status: 'unavailable' };
  try {
    const root = path.resolve(path.dirname(location.cli), '..');
    const [manifestBytes, stamp] = await Promise.all([
      readFile(path.join(root, 'bundle', 'manifest.json')), readFile(path.join(root, 'src', 'build-info.mjs'))
    ]);
    if (manifestBytes.length > 64 * 1024 || stamp.length > 64 * 1024) return { status: 'unavailable' };
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    // Do not launch an old, partial or source-fallback CLI speculatively.
    if (manifest.format !== 2 || manifest.layout !== 'coarse-esm' || manifest.stamped !== true
        || manifest.buildInfoSha256 !== 'sha256:' + createHash('sha256').update(stamp).digest('hex')) {
      return { status: 'unavailable' };
    }
    const key = createHash('sha256').update(JSON.stringify([location.executable, location.cli,
      Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))]))
      .update(manifestBytes).update(stamp).digest('hex');
    if (signal?.aborted) return { status: 'cancelled' };
    const existing = preparations.get(key);
    if (existing) return existing;
    const pending = invoke<{ prepared?: boolean }>({
      executable: location.executable, cli: location.cli, repository: os.tmpdir(),
      args: ['--warm-runtime'], env: { ...env }, timeoutMs: 10_000, signal
    }).then(value => ({ status: value.prepared === true ? 'prepared' : 'unavailable' } as Result),
      () => ({ status: signal?.aborted ? 'cancelled' : 'failed' } as Result));
    preparations.set(key, pending);
    if (preparations.size > 8) preparations.delete(preparations.keys().next().value!);
    const result = await pending;
    if (result.status !== 'prepared' && preparations.get(key) === pending) preparations.delete(key);
    return result;
  } catch { return { status: 'unavailable' }; }
}

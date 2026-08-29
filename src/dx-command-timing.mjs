import { appendFile, chmod, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gitDir } from './git.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
export { incrementCommandCounter, withCommandTiming } from './dx-timing-context.mjs';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 90;
const LOG_NAME = 'timings.jsonl';
function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function commandTimer(command, input = {}) {
  const options = typeof input === 'bigint' ? { started: input } : input;
  const started = options.started ?? process.hrtime.bigint();
  const created = process.hrtime.bigint();
  const startedAt = new Date(Date.now() - (Number(created - started) / 1e6)).toISOString();
  const stages = {};
  const counters = {};
  let checkpoint = started;
  return {
    stage(name) {
      const now = process.hrtime.bigint();
      stages[name] = (stages[name] ?? 0) + (Number(now - checkpoint) / 1e6);
      checkpoint = now;
    },
    /**
     * Count bounded operation facts without recording arguments, paths, remotes, or content.
     * Names are deliberately caller-owned closed vocabulary; invalid names are refused so a
     * diagnostic cannot accidentally turn user input into telemetry keys.
     */
    increment(name, amount = 1) {
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(String(name ?? ''))) {
        throw new TypeError('Timing counter names must use lower-case dotted or kebab-case identifiers.');
      }
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new TypeError('Timing counter increments must be non-negative safe integers.');
      }
      counters[name] = (counters[name] ?? 0) + amount;
      return counters[name];
    },
    finish(extra = {}) {
      const ended = process.hrtime.bigint();
      return {
        schemaVersion: currentSchemaVersion('dx-command-timing'),
        event: 'dx.command-timing',
        commandClass: options.commandClass ?? 'unknown',
        command,
        operationId: options.operationId ?? null,
        startedAt,
        recordedAt: new Date().toISOString(),
        durationMs: Number(ended - started) / 1e6,
        stages,
        counters,
        outcome: 'success',
        fallback: 'none',
        ...extra
      };
    }
  };
}

export function writeCommandTimings(event) {
  const stages = Object.entries(event.stages ?? {})
    .map(([name, durationMs]) => `${name}=${durationMs.toFixed(1)}ms`).join(' ');
  const counters = Object.entries(event.counters ?? {})
    .map(([name, count]) => `${name}=${count}`).join(' ');
  const operation = event.operationId ? ` operation=${event.operationId}` : '';
  process.stderr.write(`[sflow timing] ${event.command}${operation} class=${event.commandClass} outcome=${event.outcome} total=${event.durationMs.toFixed(1)}ms${stages ? ` ${stages}` : ''}${counters ? ` ${counters}` : ''}\n`);
}

export function commandTimingDirectory(root) {
  return path.join(gitDir(root), 'singularity-flow', 'dx');
}

async function maintainCommandTimingLog(directory, now = Date.now()) {
  const maxBytes = positiveInteger(process.env.SINGULARITY_FLOW_DX_TIMING_MAX_BYTES, DEFAULT_MAX_BYTES);
  const retentionDays = positiveInteger(process.env.SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const active = path.join(directory, LOG_NAME);
  const current = await stat(active).catch(() => null);
  if (current?.size >= maxBytes) {
    const stamp = new Date(now).toISOString().replaceAll(':', '-').replaceAll('.', '-');
    await rename(active, path.join(directory, `timings-${stamp}.jsonl`));
  }
  const cutoff = now - (retentionDays * 24 * 60 * 60 * 1000);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^timings-.*\.jsonl$/.test(entry.name))
    .map(async (entry) => {
      const file = path.join(directory, entry.name);
      const metadata = await stat(file).catch(() => null);
      if (metadata && metadata.mtimeMs < cutoff) await unlink(file).catch(() => {});
    }));
}

export async function recordCommandTiming(root, event) {
  if (!root || process.env.SINGULARITY_FLOW_DISABLE_TIMING_LOG === '1') return;
  try {
    const directory = commandTimingDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => {});
    await maintainCommandTimingLog(directory);
    const file = path.join(directory, LOG_NAME);
    await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  } catch {
    // A machine-local diagnostic must never change command success or failure.
  }
}

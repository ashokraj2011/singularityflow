import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gitDir } from './git.mjs';

export function commandTimer(command, started = process.hrtime.bigint()) {
  const stages = [];
  let checkpoint = started;
  return {
    stage(name) {
      const now = process.hrtime.bigint();
      stages.push({ name, durationMs: Number(now - checkpoint) / 1e6 });
      checkpoint = now;
    },
    finish(extra = {}) {
      const ended = process.hrtime.bigint();
      return {
        schemaVersion: 1,
        command,
        recordedAt: new Date().toISOString(),
        durationMs: Number(ended - started) / 1e6,
        stages,
        ...extra
      };
    }
  };
}

export function writeCommandTimings(event) {
  const stages = event.stages.map((stage) => `${stage.name}=${stage.durationMs.toFixed(1)}ms`).join(' ');
  process.stderr.write(`[sflow timing] ${event.command} total=${event.durationMs.toFixed(1)}ms${stages ? ` ${stages}` : ''}\n`);
}

export async function recordCommandTiming(root, event) {
  if (!root || process.env.SINGULARITY_FLOW_DISABLE_TIMING_LOG === '1') return;
  try {
    const directory = path.join(gitDir(root), 'singularity-flow', 'performance');
    await mkdir(directory, { recursive: true });
    await appendFile(path.join(directory, 'commands.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // A machine-local diagnostic must never change command success or failure.
  }
}

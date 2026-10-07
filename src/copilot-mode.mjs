import { constants, lstatSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { withRegistryFileLease } from './file-lease.mjs';
import { SingularityFlowError } from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { resolvePersonalization } from './personalization.mjs';

export const COPILOT_PAUSE_MARKER = '<!-- sflow-copilot-pause -->';
export const COPILOT_PAUSE_GUARD = 'Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.';

export function copilotModeFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_COPILOT_MODE_FILE
    || path.join(home, '.singularity-flow', 'copilot-mode.json'));
}

/** One bounded local read; never Git, workspace discovery, telemetry, or network. */
export function readCopilotMode(file = copilotModeFile()) {
  let descriptor;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('unsafe mode file');
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 4096) throw new Error('unsafe mode file');
    // Keep the read bounded even if the preference grows after the metadata check.
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 4096) throw new Error('oversized mode file');
    const record = readRecord('copilot-mode-preference', bytes.subarray(0, length).toString('utf8')).record;
    if (typeof record.paused !== 'boolean') throw new Error('invalid mode record');
    return { paused: record.paused, stateAvailable: true, changedAt: record.changedAt ?? null };
  } catch (error) {
    if (error.code === 'ENOENT') return { paused: false, stateAvailable: true, changedAt: null };
    // A broken local preference must never cause the framework to take over the host.
    return { paused: true, stateAvailable: false, changedAt: null };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function setCopilotPaused(paused, file = copilotModeFile()) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new SingularityFlowError('Copilot mode must be stored in a regular machine-local directory.', { code: 'COPILOT_MODE_PATH_UNSAFE' });
  }
  return withRegistryFileLease(file, async () => {
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SingularityFlowError('Copilot mode must be a regular non-symlink file.', { code: 'COPILOT_MODE_PATH_UNSAFE' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = { schemaVersion: currentSchemaVersion('copilot-mode-preference'), paused, changedAt: new Date().toISOString() };
    const temporary = path.join(directory, `.copilot-mode-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
    return readCopilotMode(file);
  });
}

export function copilotModePresentation(mode = readCopilotMode()) {
  return {
    schemaVersion: 1, resultType: 'sflow-copilot-mode', ...mode, // schema-transient: computed local mode projection, never persisted
    scope: 'machine-local', storyStateChanged: false, repositoryChanged: false,
    nativeCopilot: mode.paused,
    personalization: mode.paused ? null : resolvePersonalization({ root: process.cwd() }),
    message: mode.paused
      ? 'SFlow Copilot guidance is paused. Use native Copilot. No Story, approval, branch, or checkout was changed.'
      : 'SFlow Copilot guidance is available through explicit skills or the selected SFlow agent. No Story was advanced.',
    commandGuidance: {
      command: `singularity-flow pause ${mode.paused ? 'off' : 'on'} --json`,
      copilotCommand: mode.paused ? '/sf-pause off' : '/sf-pause'
    }
  };
}

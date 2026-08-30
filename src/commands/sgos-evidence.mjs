/** Model-free portable SGOS Process Evidence export and verification. */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  compileSgosProcessEvidence, parseSgosProcessEvidence, serializeSgosProcessEvidence,
  SGOS_PROCESS_EVIDENCE_MAXIMUM_BYTES
} from '../sgos/process-evidence.mjs';
import { validateSgosCliOptions } from '../sgos/cli-options.mjs';
import {
  ensureSecureRepositoryDirectory, optionBoolean, optionString, secureRepositoryPath,
  SingularityFlowError
} from '../util.mjs';

const DIRECTORY_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF']);

function fail(message, code = 'SGOS_PROCESS_EVIDENCE_CLI_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function exactPositionals(positionals, expected, usage) {
  if (positionals.length !== expected) {
    fail(`Usage: ${usage}`, 'SGOS_PROCESS_EVIDENCE_USAGE', {
      expectedPositionals: expected, receivedPositionals: positionals.length
    });
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Publish one complete file atomically without ever replacing an existing path. */
async function publishNewRepositoryFile(root, candidate, bytes) {
  if (!candidate) fail('evidence export requires --out <FILE>.', 'SGOS_PROCESS_EVIDENCE_OUTPUT_REQUIRED');
  let target = await secureRepositoryPath(root, String(candidate), {
    label: 'Process Evidence output', mustExist: false, type: 'file'
  });
  if (target.exists) {
    fail(`Process Evidence output already exists: ${target.relative}.`,
      'SGOS_PROCESS_EVIDENCE_OUTPUT_EXISTS', { path: target.relative });
  }
  const directory = await ensureSecureRepositoryDirectory(root, path.dirname(target.relative), {
    label: 'Process Evidence output directory'
  });
  target = await secureRepositoryPath(root, target.relative, {
    label: 'Process Evidence output', mustExist: false, type: 'file'
  });
  if (target.exists) {
    fail(`Process Evidence output already exists: ${target.relative}.`,
      'SGOS_PROCESS_EVIDENCE_OUTPUT_EXISTS', { path: target.relative });
  }

  const temporary = path.join(
    directory.absolute, `.${path.basename(target.absolute)}.pending-${process.pid}-${randomUUID()}`
  );
  let handle;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // A hard link is the portable no-replace publication primitive. Unlike rename(), it cannot
      // silently replace a file created after the initial path check.
      await link(temporary, target.absolute);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      fail(`Process Evidence output already exists: ${target.relative}.`,
        'SGOS_PROCESS_EVIDENCE_OUTPUT_EXISTS', { path: target.relative });
    }
    await syncDirectory(directory.absolute);
    const published = await secureRepositoryPath(root, target.relative, {
      label: 'Process Evidence output', mustExist: true, type: 'file'
    });
    const observed = await readFile(published.absolute, 'utf8');
    if (observed !== bytes) {
      fail('Process Evidence output changed during atomic publication.',
        'SGOS_PROCESS_EVIDENCE_OUTPUT_CHANGED', { path: target.relative });
    }
    return published;
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readPortableFile(candidate) {
  if (!candidate) fail('evidence verify requires <FILE>.', 'SGOS_PROCESS_EVIDENCE_FILE_REQUIRED');
  const base = path.resolve(process.cwd());
  const secured = await secureRepositoryPath(base, String(candidate), {
    label: 'Process Evidence file', mustExist: true, type: 'file'
  });
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) fail('Process Evidence input must remain a regular file.', 'SGOS_PROCESS_EVIDENCE_FILE_INVALID');
    if (before.size > SGOS_PROCESS_EVIDENCE_MAXIMUM_BYTES) {
      fail('Process Evidence input exceeds the installed portable bundle limit.',
        'SGOS_PROCESS_EVIDENCE_LIMIT', {
          maximumBytes: SGOS_PROCESS_EVIDENCE_MAXIMUM_BYTES, actualBytes: before.size
        });
    }
    const bytes = await handle.readFile();
    const rebound = await secureRepositoryPath(base, secured.relative, {
      label: 'Process Evidence file', mustExist: true, type: 'file'
    });
    if ((before.ino !== 0 && rebound.entry?.ino !== before.ino)
        || (before.dev !== 0 && rebound.entry?.dev !== before.dev)) {
      fail('Process Evidence input changed while it was being read.',
        'SGOS_PROCESS_EVIDENCE_FILE_CHANGED', { path: secured.relative });
    }
    return { bytes, relative: secured.relative };
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail('Process Evidence input cannot be a symbolic link.',
        'SGOS_PROCESS_EVIDENCE_FILE_INVALID');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function emit(operation, value, options, summary, { changed = false } = {}) {
  return emitCommandResult(commandResult({
    operation: { id: operation, classification: changed ? 'mutation' : 'read' },
    outcome: succeeded('sgos.reported', { summary }),
    effects: changed ? effects({
      stateChanged: false,
      filesChanged: true,
      publicationCreated: false,
      externalSystemsChanged: false
    }) : noEffects(),
    restState: 'informational',
    data: { result: value }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}

async function exportEvidence(positionals, options) {
  exactPositionals(positionals, 3,
    'singularity-flow evidence export <PROCESS-ID> --out <REPOSITORY-FILE> [--json]');
  const root = repoRoot();
  const processId = positionals[2];
  const bundle = await compileSgosProcessEvidence(root, processId);
  const bytes = serializeSgosProcessEvidence(bundle);
  const output = await publishNewRepositoryFile(root, optionString(options, 'out'), bytes);
  const result = Object.freeze({
    processId: bundle.processId,
    processSha256: bundle.processSha256,
    bundleSha256: bundle.bundleSha256,
    output: output.relative,
    bytes: Buffer.byteLength(bytes, 'utf8'),
    integrity: 'valid',
    evidenceCompleteness: bundle.evidenceCompleteness,
    assurance: bundle.assurance,
    gaps: bundle.gaps,
    contradictions: bundle.contradictions
  });
  return emit('evidence.export', result, options,
    `Exported ${result.bundleSha256} to ${result.output}. `
      + `Integrity: ${result.integrity}; completeness: ${result.evidenceCompleteness}; `
      + `${result.gaps.length} explicit gap(s), ${result.contradictions.length} contradiction(s). `
      + 'This is not a signature or Authority Store proof.',
    { changed: true });
}

async function verifyEvidence(positionals, options) {
  exactPositionals(positionals, 3,
    'singularity-flow evidence verify <FILE> [--json]');
  const input = await readPortableFile(positionals[2]);
  const parsed = parseSgosProcessEvidence(input.bytes);
  if (parsed.report.integrity !== 'valid') {
    fail(`Process Evidence verification failed with ${parsed.report.contradictions.length} contradiction(s).`,
      'SGOS_PROCESS_EVIDENCE_VERIFICATION_FAILED', {
        file: input.relative,
        report: parsed.report
      });
  }
  const result = Object.freeze({ ...parsed.report, file: input.relative });
  return emit('evidence.verify', result, options,
    `Verified ${result.bundleSha256}. Integrity: ${result.integrity}; `
      + `completeness: ${result.evidenceCompleteness}; ${result.gaps.length} explicit gap(s). `
      + 'Authority and signature assurance remain exactly as declared by the bundle.');
}

export async function run(_argv, { positionals, options }) {
  const action = positionals[1] ?? 'verify';
  validateSgosCliOptions('evidence', action, options);
  if (action === 'export') return exportEvidence(positionals, options);
  if (action === 'verify') return verifyEvidence(positionals, options);
  fail(`Unknown evidence action '${action}'.`, 'UNKNOWN_SUBCOMMAND');
}

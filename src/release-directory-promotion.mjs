/** Crash-recoverable same-filesystem publication of a fully verified release directory. */
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  readStableReleaseJson, writeReleaseJsonNoClobber
} from './secure-release-files.mjs';

function locations(destination) {
  const absolute = path.resolve(destination);
  const parent = path.dirname(absolute);
  const name = path.basename(absolute);
  return {
    destination: absolute,
    parent,
    name,
    backup: path.join(parent, `.${name}.release-previous`),
    journal: path.join(parent, `.${name}.release-promotion.json`),
    candidatePrefix: `.${name}-candidate-`
  };
}

async function metadata(file) {
  return lstat(file).catch(() => null);
}

function ordinaryDirectory(info, label) {
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`${label} is not a safe ordinary directory.`);
  }
}

function parseJournal(journal, expected) {
  const keys = Object.keys(journal ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'backupName', 'candidateName', 'destinationName', 'kind', 'ownerPid', 'schemaVersion'
  ])) throw new Error('Release promotion journal fields are invalid; no path was changed.');
  if (journal.schemaVersion !== 1 // schema-transient: bounded local crash-recovery journal
      || journal.kind !== 'singularity-flow-release-directory-promotion'
      || journal.destinationName !== expected.name
      || journal.backupName !== path.basename(expected.backup)
      || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid < 1
      || typeof journal.candidateName !== 'string'
      || !journal.candidateName.startsWith(expected.candidatePrefix)
      || path.basename(journal.candidateName) !== journal.candidateName) {
    throw new Error('Release promotion journal identity is invalid; no path was changed.');
  }
  return journal;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this principal cannot signal it. All other errors remain
    // conservatively live except the operating system's explicit no-such-process result.
    return error?.code !== 'ESRCH';
  }
}

async function writeJournal(file, value) {
  await writeReleaseJsonNoClobber(file, value);
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncCandidateTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`Release candidate contains a non-ordinary entry: ${entry.name}.`);
    }
    if (entry.isDirectory()) await syncCandidateTree(target);
    else {
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) throw new Error(`Release candidate changed type: ${entry.name}.`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(directory);
}

/** Recover a prior interrupted swap before starting another promotion. */
export async function recoverReleaseDirectoryPromotion(destination, {
  assumeOwnerStopped = false,
  ownerIsAlive = processIsAlive
} = {}) {
  const expected = locations(destination);
  const journalInfo = await metadata(expected.journal);
  if (!journalInfo) {
    const backupInfo = await metadata(expected.backup);
    if (backupInfo) {
      ordinaryDirectory(backupInfo, 'Orphaned release backup');
      throw new Error(
        'An orphaned release backup has no durable promotion journal; inspect it before retrying.'
      );
    }
    return Object.freeze({ recovered: false, outcome: 'none' });
  }
  if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) {
    throw new Error('Release promotion journal is not a safe ordinary file; no path was changed.');
  }
  const journal = parseJournal((await readStableReleaseJson(expected.journal, {
    label: 'Release promotion journal', maxBytes: 8 * 1024
  })).value, expected);
  if (!assumeOwnerStopped && ownerIsAlive(journal.ownerPid)) {
    throw new Error(
      `Release promotion is currently owned by live process ${journal.ownerPid}; retry after it finishes.`
    );
  }
  const candidate = path.join(expected.parent, journal.candidateName);
  const [destinationInfo, backupInfo, candidateInfo] = await Promise.all([
    metadata(expected.destination), metadata(expected.backup), metadata(candidate)
  ]);
  ordinaryDirectory(destinationInfo, 'Release destination');
  ordinaryDirectory(backupInfo, 'Release backup');
  ordinaryDirectory(candidateInfo, 'Release candidate');

  let outcome;
  if (backupInfo && !destinationInfo) {
    // The old release moved, but the new one did not: restore the last known-good release.
    await rename(expected.backup, expected.destination);
    await syncDirectory(expected.parent);
    outcome = 'prior-restored';
  } else if (backupInfo && destinationInfo) {
    // The verified candidate reached the public name; only cleanup was interrupted.
    await rm(expected.backup, { recursive: true, force: true });
    await syncDirectory(expected.parent);
    outcome = 'promotion-retained';
  } else if (!backupInfo && destinationInfo && !candidateInfo) {
    // There was no prior release and the candidate reached the destination.
    outcome = 'promotion-retained';
  } else {
    // No public mutation completed. Preserve the prior destination (including intentional absence).
    outcome = destinationInfo ? 'prior-retained' : 'prior-absence-retained';
  }
  if (candidateInfo) await rm(candidate, { recursive: true, force: true });
  await rm(expected.journal, { force: true });
  await syncDirectory(expected.parent);
  return Object.freeze({ recovered: true, outcome });
}

/** Publish a verified candidate and leave enough durable state for next-run recovery. */
export async function promoteReleaseDirectory(candidate, destination, {
  afterStep = null,
  recoverOnError = true
} = {}) {
  const expected = locations(destination);
  const absoluteCandidate = path.resolve(candidate);
  if (path.dirname(absoluteCandidate) !== expected.parent
      || !path.basename(absoluteCandidate).startsWith(expected.candidatePrefix)) {
    throw new Error('Release candidate must use the guarded same-parent candidate path.');
  }
  await recoverReleaseDirectoryPromotion(expected.destination);
  const [candidateInfo, destinationInfo, backupInfo] = await Promise.all([
    metadata(absoluteCandidate), metadata(expected.destination), metadata(expected.backup)
  ]);
  ordinaryDirectory(candidateInfo, 'Release candidate');
  ordinaryDirectory(destinationInfo, 'Release destination');
  if (!candidateInfo) throw new Error('Release candidate does not exist.');
  if (backupInfo) throw new Error('Release backup was not reconciled before publication.');
  // Flush the fully verified candidate before publishing the durable intent journal. A power loss
  // can then expose either the prior tree or the complete candidate, never merely cached writes.
  await syncCandidateTree(absoluteCandidate);
  await writeJournal(expected.journal, {
    schemaVersion: 1, // schema-transient: bounded local crash-recovery journal
    kind: 'singularity-flow-release-directory-promotion',
    destinationName: expected.name,
    backupName: path.basename(expected.backup),
    candidateName: path.basename(absoluteCandidate),
    ownerPid: process.pid
  });
  try {
    await afterStep?.('journal-durable');
    if (destinationInfo) {
      await rename(expected.destination, expected.backup);
      await syncDirectory(expected.parent);
    }
    await afterStep?.('prior-moved');
    await rename(absoluteCandidate, expected.destination);
    await syncDirectory(expected.parent);
    await afterStep?.('candidate-moved');
    if (destinationInfo) {
      await rm(expected.backup, { recursive: true, force: true });
      await syncDirectory(expected.parent);
    }
    await rm(expected.journal, { force: true });
    await syncDirectory(expected.parent);
    return Object.freeze({ promoted: true, destination: expected.destination });
  } catch (error) {
    if (recoverOnError) {
      try {
        await recoverReleaseDirectoryPromotion(expected.destination, { assumeOwnerStopped: true });
      }
      catch (recoveryError) {
        throw new AggregateError([error, recoveryError],
          'Release promotion failed and automatic directory recovery also failed.');
      }
    }
    throw error;
  }
}

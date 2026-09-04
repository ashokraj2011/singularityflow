import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, rm } from 'node:fs/promises';

import { gitCommonDir, head } from '../git.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { run, secureRepositoryPath, SingularityFlowError, writeJson } from '../util.mjs';

const PROPOSAL_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function journalDirectory(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'journals', 'init');
}

function journalPath(root, proposalSha256) {
  return path.join(journalDirectory(root), `${proposalSha256.slice(7, 19)}.json`);
}

function sha(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readJournal(file) {
  try { return readRecord('smart-init-activation-journal', await readFile(file)).record; }
  catch (error) {
    throw new SingularityFlowError(
      'The smart-initialization recovery journal is unreadable. Preserve it for review; no repository file was changed.',
      { code: 'INI_RECOVERY_REQUIRED', cause: error, details: { journal: file } }
    );
  }
}

function currentRef(root) {
  const result = run('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function exactCommit(root, commit, journal) {
  const object = run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, allowFailure: true });
  if (object.status !== 0 || !Array.isArray(journal.writeSet) || !journal.writeSet.length) return false;
  const parent = run('git', ['rev-parse', `${commit}^`], { cwd: root, allowFailure: true });
  if (parent.status !== 0 || parent.stdout.trim() !== journal.baseCommit) return false;
  const changed = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit], {
    cwd: root, allowFailure: true
  });
  if (changed.status !== 0) return false;
  const actualPaths = changed.stdout.split('\0').filter(Boolean).sort();
  const expectedPaths = journal.writeSet.map((entry) => entry.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) return false;
  for (const expected of journal.writeSet) {
    const blob = run('git', ['show', `${commit}:${expected.path}`], { cwd: root, allowFailure: true });
    if (blob.status !== 0 || Buffer.byteLength(blob.stdout) !== expected.bytes
        || sha(Buffer.from(blob.stdout, 'utf8')) !== expected.sha256) return false;
  }
  return true;
}

async function restoreFreshPreimage(root, journal) {
  if (!Array.isArray(journal.writeSet) || !journal.writeSet.length) return { safe: false, reason: 'write-set-missing' };
  for (const expected of journal.writeSet) {
    const target = await secureRepositoryPath(root, expected.path, { label: 'Smart-init recovery target' });
    if (!target.exists) continue;
    if (expected.expectation !== 'create' || !target.entry?.isFile()) return {
      safe: false, reason: 'target-shape-changed', path: expected.path
    };
    const bytes = await readFile(target.absolute);
    if (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256) return {
      safe: false, reason: 'target-bytes-changed', path: expected.path
    };
  }
  for (const expected of [...journal.writeSet].reverse()) {
    const target = await secureRepositoryPath(root, expected.path, { label: 'Smart-init recovery target' });
    if (target.exists) await rm(target.absolute, { force: true });
  }
  return { safe: true };
}

function updatedJournal(journal, updates) {
  return {
    ...journal,
    schemaVersion: currentSchemaVersion('smart-init-activation-journal'),
    ...updates
  };
}

export async function pendingSmartInitRecovery(root) {
  let names;
  try { names = (await readdir(journalDirectory(root))).filter((name) => /^[a-f0-9]{12}\.json$/u.test(name)).sort(); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SingularityFlowError('Smart-initialization recovery state cannot be inspected.', {
      code: 'INI_RECOVERY_REQUIRED', cause: error
    });
  }
  for (const name of names) {
    const file = path.join(journalDirectory(root), name);
    const journal = await readJournal(file);
    if (['planned', 'validated'].includes(journal.status)) return { file, journal };
  }
  return null;
}

export async function readLatestSmartInitActivation(root) {
  const directory = path.join(root, 'singularity', 'receipts', 'initialization');
  let names;
  try { names = (await readdir(directory)).filter((name) => /^[a-f0-9]{12}\.json$/u.test(name)).sort(); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SingularityFlowError('Initialization receipts cannot be inspected.', {
      code: 'INI_CONFIGURATION_INVALID', cause: error
    });
  }
  let latest = null;
  for (const name of names) {
    const file = path.join(directory, name);
    let bytes; let record;
    try {
      bytes = await readFile(file);
      record = readRecord('smart-init-activation', bytes).record;
    } catch (error) {
      throw new SingularityFlowError(`Initialization receipt is unreadable: ${name}.`, {
        code: 'INI_CONFIGURATION_INVALID', cause: error
      });
    }
    if (!latest || String(record.activatedAt).localeCompare(String(latest.record.activatedAt), 'en') > 0
        || (record.activatedAt === latest.record.activatedAt && name.localeCompare(latest.name, 'en') > 0)) {
      latest = { name, file, bytes, record };
    }
  }
  return latest;
}

export async function assertNoPendingSmartInitRecovery(root) {
  const pending = await pendingSmartInitRecovery(root);
  if (!pending) return;
  throw new SingularityFlowError(
    `Smart initialization has an incomplete exact transaction. Run singularity-flow init --recover --proposal ${pending.journal.proposalSha256}.`,
    {
      code: 'INI_RECOVERY_REQUIRED',
      details: { proposalSha256: pending.journal.proposalSha256, status: pending.journal.status }
    }
  );
}

export async function recoverSmartInit(root, proposalSha256) {
  if (!PROPOSAL_PATTERN.test(String(proposalSha256 ?? ''))) throw new SingularityFlowError(
    'Smart-init recovery requires --proposal sha256:<64-lowercase-hex>.',
    { code: 'INI_RECOVERY_REQUIRED' }
  );
  const file = journalPath(root, proposalSha256);
  const journal = await readJournal(file);
  if (journal.proposalSha256 !== proposalSha256) throw new SingularityFlowError(
    'The recovery journal does not bind the requested proposal. No repository file was changed.',
    { code: 'INI_RECOVERY_REQUIRED' }
  );
  if (journal.status === 'complete') {
    if (!journal.activationCommit || !exactCommit(root, journal.activationCommit, journal)) throw new SingularityFlowError(
      'The completed initialization journal cannot prove its exact activation commit. Preserve it for review.',
      { code: 'INI_RECOVERY_REQUIRED' }
    );
    return { status: 'complete', proposalSha256, activationCommit: journal.activationCommit, changed: false };
  }
  if (journal.status === 'rolled-back') return {
    status: 'rolled-back', proposalSha256, activationCommit: null, changed: false
  };
  if (!['planned', 'validated'].includes(journal.status)) throw new SingularityFlowError(
    `Initialization recovery does not recognize journal state '${journal.status}'.`,
    { code: 'INI_RECOVERY_REQUIRED' }
  );
  const observedHead = head(root);
  const observedRef = currentRef(root);
  if (observedRef !== journal.checkedOutRef) throw new SingularityFlowError(
    `Initialization recovery requires ${journal.checkedOutRef}; current ref is ${observedRef ?? 'detached HEAD'}. No repository file was changed.`,
    { code: 'INI_RECOVERY_REQUIRED', details: { expectedRef: journal.checkedOutRef, currentRef: observedRef } }
  );
  if (observedHead !== journal.baseCommit) {
    if (!exactCommit(root, observedHead, journal)) throw new SingularityFlowError(
      'Repository history advanced after the interrupted initialization and is not its exact proposal-bound commit. Preserve the journal for review.',
      { code: 'INI_RECOVERY_REQUIRED', details: { baseCommit: journal.baseCommit, currentCommit: observedHead } }
    );
    await writeJson(file, updatedJournal(journal, { status: 'complete', activationCommit: observedHead }));
    return { status: 'complete', proposalSha256, activationCommit: observedHead, changed: true };
  }
  const restored = await restoreFreshPreimage(root, journal);
  if (!restored.safe) throw new SingularityFlowError(
    `Initialization recovery found repository bytes it cannot safely remove${restored.path ? ` at ${restored.path}` : ''}. Preserve the journal and review the path.`,
    { code: 'INI_RECOVERY_REQUIRED', details: restored }
  );
  await writeJson(file, updatedJournal(journal, { status: 'rolled-back', errorCode: 'INI_INTERRUPTED_ROLLED_BACK' }));
  return { status: 'rolled-back', proposalSha256, activationCommit: null, changed: true };
}

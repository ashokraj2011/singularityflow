/**
 * Story intake receipts: what a passing readiness preview observed, so Story start can verify it
 * instead of rediscovering it. `[perf]`
 *
 * A receipt authorizes nothing. It records, for one exact request, the approved configuration
 * revision and the remote state the preview saw, sealed with this repository's machine-local key.
 * Story start presents it back, observes every governed input again once, all at the same time, and
 * compares. An expired, edited, foreign or already used receipt, a different request or build, or
 * any difference in what start observes runs the full path instead. Readiness is always recomputed.
 *
 * Receipts live beside the other machine-local recovery records in the Git common directory, one
 * file each, created exclusively and readable only by their owner. A claim renames the file, so two
 * starts can never use the same receipt; a start that fails before any durable Story commit gives
 * it back. They carry credential-free remote URLs and commit identities, never a checkout path or
 * any intake content: the request itself is bound by digest.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { runningBuildIdentity } from './build-identity.mjs';
import { gitCommonDir } from './git.mjs';
import {
  sealMachineLocalPublicationReceipt, verifyMachineLocalPublicationReceipt
} from './publication-machine-integrity.mjs';
import { prepareSharedPublicationStorage } from './publication-storage.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const STORY_INTAKE_RECEIPT_TTL_MS = 15 * 60_000;
const PURPOSE = 'story-intake-receipt';
const DIRECTORY = 'intake-receipts';
const RECEIPT_ID = /^sir_[0-9a-f]{32}$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** `SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS=off` turns minting and use off everywhere. */
export function storyIntakeReceiptsDisabled(env = process.env) {
  return String(env.SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS ?? '').trim().toLowerCase() === 'off';
}

/**
 * The request a receipt answers. The preview and start each compute it from their own options, so
 * a start that differs in any of these runs the full path.
 */
export function storyIntakeInputsDigest({
  workId, workType, baseBranch, remote, capabilityId = null, references = [], readinessBaseline = 'reuse',
  testExecutionMode = 'changed-and-affected', qualityGateMode = 'hard'
}) {
  return `sha256:${recordSha256({
    workId: String(workId ?? ''),
    workType: String(workType ?? ''),
    baseBranch: String(baseBranch ?? ''),
    remote: String(remote ?? ''),
    capabilityId: capabilityId ?? null,
    readinessBaseline,
    testExecutionMode,
    qualityGateMode,
    references: [...references]
      .map((entry) => ({ id: String(entry.id), url: String(entry.url), branch: String(entry.branch) }))
      .sort((left, right) => left.id.localeCompare(right.id))
  })}`;
}

async function locationDigest(target) {
  return `sha256:${createHash('sha256').update(await realpath(target)).digest('hex')}`;
}

async function bindings(root) {
  return {
    commonDirectory: await locationDigest(gitCommonDir(root)),
    launchCheckout: await locationDigest(root)
  };
}

function validObjectId(value) { return typeof value === 'string' && OBJECT_ID.test(value); }

function validRepository(entry) {
  return entry && typeof entry.id === 'string' && entry.id
    && typeof entry.remote === 'string' && entry.remote
    && typeof entry.baseBranch === 'string' && entry.baseBranch
    && validObjectId(entry.baseCommit)
    && typeof entry.destinationRef === 'string' && entry.destinationRef.startsWith('refs/heads/')
    && typeof entry.fetch?.url === 'string' && entry.fetch.url && typeof entry.fetch.fingerprint === 'string'
    && (entry.push === null
      || (typeof entry.push?.url === 'string' && entry.push.url && typeof entry.push.fingerprint === 'string'))
    && (entry.state === null
      || (typeof entry.state?.branch === 'string' && entry.state.branch
        && (entry.state.commit === null || validObjectId(entry.state.commit))));
}

function validShape(record) {
  return record?.kind === PURPOSE && RECEIPT_ID.test(record.id ?? '')
    && typeof record.issuedAt === 'string' && typeof record.expiresAt === 'string'
    && typeof record.build === 'string' && typeof record.inputs === 'string'
    && typeof record.bindings?.commonDirectory === 'string'
    && typeof record.bindings?.launchCheckout === 'string'
    && typeof record.authority?.remote === 'string' && record.authority.remote
    && typeof record.authority.branch === 'string' && validObjectId(record.authority.commit)
    && (record.authority.sourceCommit === null || validObjectId(record.authority.sourceCommit))
    && Array.isArray(record.repositories) && record.repositories.length > 0
    && record.repositories.every(validRepository);
}

async function storage(root) {
  return prepareSharedPublicationStorage(root, DIRECTORY, 'Story intake receipt');
}

/** Remove expired receipts and abandoned claims. Best effort: a leftover file is only garbage. */
async function prune(directory, now) {
  let names = [];
  try { names = await readdir(directory); } catch { return; }
  await Promise.all(names.filter((name) => /^sir_[0-9a-f]{32}(?:\.claim-[0-9a-z-]+)?\.json$/u.test(name))
    .map(async (name) => {
      const target = path.join(directory, name);
      try {
        const info = await lstat(target);
        if (!info.isFile() || now - info.mtimeMs > STORY_INTAKE_RECEIPT_TTL_MS * 2) {
          await rm(target, { force: true });
        }
      } catch { /* already gone */ }
    }));
}

/**
 * Seal and store a receipt for a readiness preview that passed. `repositories` are what the preview
 * proved for each one: base commit, destination absent, dry run accepted, and the state tip it saw.
 */
export async function mintStoryIntakeReceipt(root, { inputs, authority, repositories, now = Date.now() }) {
  const directory = await storage(root);
  const id = `sir_${randomBytes(16).toString('hex')}`;
  const record = await sealMachineLocalPublicationReceipt(root, PURPOSE, {
    schemaVersion: currentSchemaVersion(PURPOSE),
    kind: PURPOSE,
    id,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STORY_INTAKE_RECEIPT_TTL_MS).toISOString(),
    build: runningBuildIdentity(),
    bindings: await bindings(root),
    inputs: storyIntakeInputsDigest(inputs),
    authority: {
      remote: authority.remote, branch: authority.branch, commit: authority.commit,
      sourceCommit: authority.sourceCommit ?? null
    },
    repositories: repositories.map((entry) => ({
      id: entry.id, remote: entry.remote, baseBranch: entry.baseBranch, baseCommit: entry.baseCommit,
      destinationRef: entry.destinationRef,
      fetch: { url: entry.fetch.url, fingerprint: entry.fetch.fingerprint },
      push: entry.push ? { url: entry.push.url, fingerprint: entry.push.fingerprint } : null,
      state: entry.state ? { branch: entry.state.branch, commit: entry.state.commit ?? null } : null
    }))
  });
  if (!validShape(record)) throw new Error('A Story intake receipt could not be formed from the preview result.');
  const handle = await open(path.join(directory, `${id}.json`), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await prune(directory, now);
  return { id, expiresAt: record.expiresAt };
}

/**
 * Take a receipt for one start. Returns why it cannot be used, or the verified record together with
 * `consume()` (a durable Story commit exists) and `release()` (nothing durable happened).
 */
export async function claimStoryIntakeReceipt(root, id, { inputs, now = Date.now(), env = process.env } = {}) {
  if (storyIntakeReceiptsDisabled(env)) return { status: 'rejected', reason: 'disabled' };
  if (!RECEIPT_ID.test(String(id ?? ''))) return { status: 'rejected', reason: 'malformed' };
  let directory;
  try { directory = await storage(root); } catch { return { status: 'rejected', reason: 'storage' }; }
  const target = path.join(directory, `${id}.json`);
  const claimed = path.join(directory, `${id}.claim-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  try { await rename(target, claimed); } catch (error) {
    return { status: 'rejected', reason: error?.code === 'ENOENT' ? 'missing' : 'storage' };
  }
  const discard = async () => { await rm(claimed, { force: true }).catch(() => {}); };
  const reject = async (reason) => { await discard(); return { status: 'rejected', reason }; };
  let record;
  try {
    const info = await lstat(claimed);
    if (!info.isFile() || info.size > 64 * 1024) return reject('unreadable');
    record = readRecord(PURPOSE, await readFile(claimed, 'utf8')).record;
  } catch {
    return reject('unreadable');
  }
  if (!validShape(record) || record.id !== id) return reject('unreadable');
  if (!await verifyMachineLocalPublicationReceipt(root, PURPOSE, record)) return reject('integrity');
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return reject('expired');
  if (record.build !== runningBuildIdentity()) return reject('build');
  const current = await bindings(root).catch(() => null);
  if (!current || current.commonDirectory !== record.bindings.commonDirectory
      || current.launchCheckout !== record.bindings.launchCheckout) return reject('binding');
  if (record.inputs !== storyIntakeInputsDigest(inputs)) return reject('inputs');
  let settled = false;
  return {
    status: 'claimed',
    receipt: record,
    consume: async () => {
      if (settled) return;
      settled = true;
      await discard();
    },
    release: async () => {
      if (settled) return;
      settled = true;
      await rename(claimed, target).catch(discard);
    }
  };
}

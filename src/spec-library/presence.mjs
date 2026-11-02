/**
 * How the specification library's person records stand under SF Guard (SPEC-PSS-v1 §10.9).
 *
 * A published revision and a published split are a person's steps with no Story, so they follow the
 * repository's signed SF Guard policy as it stood when they were recorded: while it was on, each
 * counts only with its presence seal (`presence.json` beside it), verified against the approver's
 * pinned key. A repository that never opted in reads every record as before.
 */
import { createHash } from 'node:crypto';

import { committedFileBytes } from '../git.mjs';
import { readRevisionSeal } from './library.mjs';
import { splitPath, splitSealPath } from './split.mjs';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const NOT_REQUIRED = Object.freeze({ counts: true, state: 'not-required', label: null, code: null, reason: null, signer: null });

/**
 * The library's SF Guard reader for one command: `revision(view, read)` and `split(view, record)` give
 * each record's verdict (`{ counts, state, label, code, reason }`) synchronously, from one policy read.
 */
export async function libraryPresence(root, { env = process.env } = {}) {
  const seals = await import('../presence/repository-seals.mjs');
  const policy = await seals.repositorySealPolicy(root);
  if (!policy) return { optedIn: false, revision: () => NOT_REQUIRED, split: () => NOT_REQUIRED };
  return {
    optedIn: true,
    revision(view, { specId, revision, manifestSha256, manifest }) {
      return seals.repositorySealVerdict(policy, {
        record: seals.sealedRecord('spec-revision', `${specId}@${revision}`, { manifestSha256 }), recordedAt: manifest?.recordedAt ?? null,
        seal: seals.parseSeal(readRevisionSeal(root, view, specId, revision, { env }))
      });
    },
    split(view, record) {
      const bytes = committedFileBytes(root, view.commit, splitPath(record.specId, record.split), { env });
      if (!bytes) return { counts: false, state: 'invalid', label: 'not counted: it cannot be read', code: 'PSS_RECORD_UNSIGNED', reason: 'it cannot be read', signer: null };
      return seals.repositorySealVerdict(policy, {
        record: seals.sealedRecord('spec-split', `${record.specId}#${record.split}`, { splitSha256: digest(bytes) }), recordedAt: record.recordedAt ?? null,
        seal: seals.parseSeal(committedFileBytes(root, view.commit, splitSealPath(record.specId, record.split), { env }) ?? null)
      });
    }
  };
}

/** The route for a revision that does not count: a person publishes it again, signed. */
export function revisionRoute(specId) {
  return `a person publishes ${specId} again from its draft, in their own terminal (singularity-flow spec author publish ${specId} --reviewed), where it takes their Touch ID; or name a revision that counts`;
}

/** Shared state-read revision metadata; no publication, ledger or mutation owner. */
import { createHash } from 'node:crypto';
import { branch, head } from './git.mjs';
import { stateFingerprint } from './util.mjs';
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function subjectRevision(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function revision(root, aggregate, statePath) {
  return {
    branch: branch(root),
    head: head(root),
    subjectRevision: subjectRevision(aggregate),
    statePath,
    stateSha256: stateFingerprint(statePath)
  };
}

export const STATE_REVISION = Symbol.for('singularity-flow.state-revision');

export function attachRevision(aggregate, value) {
  if (aggregate && typeof aggregate === 'object') {
    Object.defineProperty(aggregate, STATE_REVISION, { value, configurable: true, writable: true, enumerable: false });
  }
  return aggregate;
}


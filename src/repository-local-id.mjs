/**
 * The stable ID of one local Git repository, for a repository no remote names [SDA §5].
 *
 * A path is a local binding, never an identity: the ID is random, created once at registration in
 * the repository's own Git common directory, and never rewritten, so a moved checkout keeps it and
 * two clones never share one. Creation is create-only: a complete temporary file is linked into
 * place, and link() never replaces, so concurrent creators converge on the first one written.
 */
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ID = /^[a-f0-9]{32}$/u;

/** `<commonDir>/singularity-flow/local-repository-id`: one line, the ID (`--repository-id` names a workspace member, not this). */
export function localRepositoryIdFile(commonDir) {
  return path.join(commonDir, 'singularity-flow', 'local-repository-id');
}

function readId(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return ID.test(text) ? text : null;
  } catch { return null; }
}

/** The repository's ID, or null when it has none (and `create` is false or its Git directory is read-only). */
export function localRepositoryId(commonDir, { create = false } = {}) {
  if (typeof commonDir !== 'string' || !commonDir) return null;
  const file = localRepositoryIdFile(commonDir);
  const known = readId(file);
  if (known || !create) return known;
  const text = `${randomBytes(16).toString('hex')}\n`;
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, file); } catch (error) {
      if (error?.code === 'EEXIST') return readId(file);
      // A filesystem without hard links still gets a create-only write.
      writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    }
  } catch {
    // Another creator won, or the Git directory is read-only: keep whatever ID is there.
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* never written */ }
  }
  return readId(file);
}

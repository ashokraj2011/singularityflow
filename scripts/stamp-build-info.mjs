/**
 * Stamp the packing checkout's identity into `src/build-info.mjs`.
 *
 * `--version` printed a hand-maintained `0.9.0` and nothing else, so two installs built from
 * different clones — 369 changed lines of `cli.mjs` apart — were indistinguishable at the command
 * line. This writes the one fact that distinguishes them, at the only moment it is knowable: while
 * the tarball is being packed, inside the checkout being packed.
 *
 * Run by `install.sh` immediately before `npm pack`, and restored from a byte-for-byte temporary
 * backup immediately after, so the committed file stays the honest placeholder and only the
 * tarball carries a commit. Restoration is the caller's job because the caller is the one that
 * knows when packing finished, and because a stamper that restored itself would race its own output.
 *
 * `--print` reports what would be written without writing, which is what CI wants when it only needs
 * to record the provenance of an artifact it built some other way.
 *
 * Usage: `node scripts/stamp-build-info.mjs [--print]`
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stampBuildInfo, stampBuildInfoFile } from '../src/build-info-stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'build-info.mjs');

/**
 * Git, or null. Every value here is optional on purpose: packing a tarball out of an exported
 * directory with no `.git` is legitimate, and a stamp that threw would turn a working build into a
 * failed one over metadata.
 */
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return { ok: false, value: null };
  return { ok: true, value: result.stdout.trim() };
}

export function buildInfoFacts() {
  const commitResult = git('rev-parse', 'HEAD');
  const commit = commitResult.ok && commitResult.value ? commitResult.value : null;
  const status = commit ? git('status', '--porcelain') : { ok: false, value: null };
  const branch = commit ? git('rev-parse', '--abbrev-ref', 'HEAD') : { ok: false, value: null };
  return {
    commit,
    /** Reinstall uses a content digest instead because it deliberately executes no Git command. */
    sourceSha256: null,
    branch: branch.ok && branch.value ? branch.value : null,
    // `--porcelain` is empty exactly when the tree is clean. Untracked files count: they can be
    // imported by the build even though Git is not tracking them. A failed read is unknown, not
    // clean, so it is represented as null.
    dirty: status.ok ? Boolean(status.value) : null,
    builtAt: new Date().toISOString()
  };
}

/**
 * Replace only the five values, leaving the module's documentation intact.
 *
 * A regenerated file would drop the comment explaining why the file exists, and that comment is the
 * thing that stops the next person deleting it as clutter or adding it to `.gitignore` — which would
 * silently remove it from the tarball, since npm falls back to `.gitignore` with no `.npmignore`.
 */
export const stamp = stampBuildInfo;

/**
 * Only when run as a command — never on import.
 *
 * Without this guard, importing `stamp` or `buildInfoFacts` for a test *writes the file*, which is
 * how the test asserting the committed placeholder failed against a tree its own import had just
 * stamped. A module whose side effect is a file write must be able to be read without performing it.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const facts = buildInfoFacts();
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(facts, null, 2));
  } else {
    await stampBuildInfoFile(target, facts);
    console.log(`Stamped build info: ${facts.commit ? facts.commit.slice(0, 8) : 'no commit'}${facts.dirty ? ' (dirty tree)' : ''}`);
  }
}

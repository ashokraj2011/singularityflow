/**
 * Which build this is, as opposed to which version it calls itself.
 *
 * `VERSION` in `version.mjs` is a hand-maintained string. It was `0.9.0` across every build for
 * long enough that two installations 369 changed lines of `cli.mjs` apart both reported `0.9.0`, and
 * there was no way to tell from the outside which one was running. That is not a cosmetic problem:
 * the whole point of debugging against a checkout is that the checkout is what you are running, and
 * a version that cannot distinguish them lets you spend an afternoon fixing something the installed
 * build already fixed.
 *
 * The values below are the *unstamped* defaults, and they are deliberately not fabricated. A null
 * commit means nobody stamped this tree — it is being run from a checkout rather than from an
 * installed tarball — which is a true and useful thing to say. `install.sh` overwrites this file
 * immediately before `npm pack` and restores it immediately after, so the committed contents are
 * always the honest placeholder and only the tarball carries a real commit.
 *
 * This file must stay tracked by Git. `package.json` ships `src/`, and with no `.npmignore` present
 * npm falls back to `.gitignore` for exclusions, so a gitignored stamp would be silently dropped
 * from the tarball — the one place it needs to exist.
 *
 * @see scripts/stamp-build-info.mjs — the writer
 */
import { VERSION } from './version.mjs';

export const BUILD_INFO = Object.freeze({
  /** Full commit SHA the tarball was packed from, or null when running from a checkout. */
  commit: null,
  /** Branch that commit was on at pack time. Informational: branches move, commits do not. */
  branch: null,
  /** Whether the packing checkout had uncommitted changes. `install.sh` refuses these, but a
   *  hand-run `npm pack` does not, and a build from a dirty tree is not reproducible. */
  dirty: false,
  /** ISO-8601 instant the stamp was written. */
  builtAt: null,
  /** Absolute path of the checkout that produced the tarball — the answer to "which clone?". */
  builtFrom: null
});

/**
 * The one-line provenance shown by `--version` and `doctor`.
 *
 * Says "development checkout" rather than inventing a commit when unstamped, because the absence of
 * a stamp is exactly the case where a guess would mislead.
 */
export function versionLine(info = BUILD_INFO) {
  return `${VERSION} (${buildDescription(info)})`;
}

export function buildDescription(info = BUILD_INFO) {
  if (!info?.commit) return 'development checkout, not a packaged install';
  const parts = [info.commit.slice(0, 8)];
  if (info.dirty) parts.push('dirty tree');
  if (info.branch) parts.push(info.branch);
  if (info.builtAt) parts.push(`built ${info.builtAt}`);
  if (info.builtFrom) parts.push(`from ${info.builtFrom}`);
  return parts.join(' · ');
}

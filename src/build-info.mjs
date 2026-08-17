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
 * The values below are the *unstamped* defaults, and they are deliberately not fabricated. A build
 * may be identified by a Git commit or by the content digest already computed by the no-Git
 * reinstall transaction. If neither exists, nobody stamped this tree. `install.sh` overwrites this
 * file immediately before `npm pack` and restores it immediately after; reinstall stamps only its
 * disposable package copy.
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
  /** Exact validated source digest when the packager deliberately has no Git authority. */
  sourceSha256: null,
  /** Branch that commit was on at pack time. Informational: branches move, commits do not. */
  branch: null,
  /** Whether Git observed uncommitted changes; null for a content-digest-only build. */
  dirty: null,
  /** ISO-8601 instant the stamp was written. */
  builtAt: null
});

/**
 * The one-line provenance shown by `--build` and `doctor`.
 *
 * Says "development checkout" rather than inventing a commit when unstamped, because the absence of
 * a stamp is exactly the case where a guess would mislead.
 */
export function versionLine(info = BUILD_INFO) {
  return `${VERSION} (${buildDescription(info)})`;
}

export function buildDescription(info = BUILD_INFO) {
  if (!info?.commit && !info?.sourceSha256) return 'development checkout, not a stamped package';
  const parts = [info.commit
    ? info.commit.slice(0, 8)
    : `source ${String(info.sourceSha256).slice(0, 12)}`];
  if (info.dirty) parts.push('dirty tree');
  if (info.branch) parts.push(info.branch);
  if (info.builtAt) parts.push(`built ${info.builtAt}`);
  return parts.join(' · ');
}

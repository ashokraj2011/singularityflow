/**
 * Stamp the packing checkout's identity into `src/build-info.mjs`.
 *
 * `--version` printed a hand-maintained `0.9.0` and nothing else, so two installs built from
 * different clones — 369 changed lines of `cli.mjs` apart — were indistinguishable at the command
 * line. This writes the one fact that distinguishes them, at the only moment it is knowable: while
 * the tarball is being packed, inside the checkout being packed.
 *
 * Run by `install.sh` immediately before `npm pack`, and reverted immediately after, so the
 * committed file stays the honest placeholder and only the tarball carries a commit. Reverting is
 * the caller's job (`git checkout -- src/build-info.mjs`) because the caller is the one that knows
 * when packing finished, and because a stamper that restored itself would race its own output.
 *
 * `--print` reports what would be written without writing, which is what CI wants when it only needs
 * to record the provenance of an artifact it built some other way.
 *
 * Usage: `node scripts/stamp-build-info.mjs [--print]`
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src', 'build-info.mjs');

/**
 * Git, or null. Every value here is optional on purpose: packing a tarball out of an exported
 * directory with no `.git` is legitimate, and a stamp that threw would turn a working build into a
 * failed one over metadata.
 */
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

export function buildInfoFacts() {
  const commit = git('rev-parse', 'HEAD');
  return {
    commit,
    branch: commit ? git('rev-parse', '--abbrev-ref', 'HEAD') : null,
    // `--porcelain` is empty exactly when the tree is clean. Untracked files count: they can be
    // imported by the build even though Git is not tracking them.
    dirty: commit ? Boolean(git('status', '--porcelain')) : false,
    builtAt: new Date().toISOString(),
    builtFrom: root
  };
}

/**
 * Replace only the five values, leaving the module's documentation intact.
 *
 * A regenerated file would drop the comment explaining why the file exists, and that comment is the
 * thing that stops the next person deleting it as clutter or adding it to `.gitignore` — which would
 * silently remove it from the tarball, since npm falls back to `.gitignore` with no `.npmignore`.
 */
export function stamp(source, facts) {
  const literal = (value) => (value === null ? 'null' : typeof value === 'boolean' ? String(value) : `'${String(value).replace(/'/g, "\\'")}'`);
  let stamped = source;
  for (const [key, value] of Object.entries(facts)) {
    const pattern = new RegExp(`(^\\s*${key}:\\s*)[^,\\n]*(,?)$`, 'm');
    if (!pattern.test(stamped)) {
      throw new Error(`src/build-info.mjs has no '${key}' field to stamp. Update this script and that file together.`);
    }
    stamped = stamped.replace(pattern, `$1${literal(value)}$2`);
  }
  return stamped;
}

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
    await writeFile(target, stamp(await readFile(target, 'utf8'), facts), 'utf8');
    console.log(`Stamped build info: ${facts.commit ? facts.commit.slice(0, 8) : 'no commit'}${facts.dirty ? ' (dirty tree)' : ''} from ${facts.builtFrom}`);
  }
}

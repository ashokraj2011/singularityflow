import { identity, repoRoot } from '../git.mjs';
import { SnapshotCoordinator } from '../snapshot-coordinator.mjs';
import { optionBoolean, optionString, optionStrings } from '../util.mjs';

async function lightweightRepositorySlice(root, revision) {
  return {
    root,
    branch: revision.branch,
    head: revision.head,
    controlRoot: 'singularity',
    changes: revision.changedFiles,
    configurationChanges: [],
    otherChanges: [],
    // A read-model refresh must never wait for the GitHub CLI or the network. The local Git
    // identity is authoritative for commits; authenticated GitHub identity is loaded only by
    // workflows that actually need it.
    identities: { git: identity(root, { offline: true }) }
  };
}

export async function run(argv, { positionals, options }) {
  const root = repoRoot();
  const included = optionStrings(options, 'include');
  if (included.length === 1 && included[0] === 'repository') {
    const result = await new SnapshotCoordinator(root).capture(
      async ({ revision }) => ({ repository: await lightweightRepositorySlice(root, revision) }),
      {
        included,
        ifRevision: optionString(options, 'if-revision'),
        timings: optionBoolean(options, 'timings'),
        // A read model. Nothing here writes, so an edit arriving mid-read makes the answer slightly
        // old, not wrong — and refusing to answer leaves every view in the extension blank.
        consistency: 'best-effort'
      }
    );
    return console.log(JSON.stringify(result, null, 2));
  }
  /**
   * Every other shape of `snapshot`, assembled without `src/cli.mjs`. `[perf]`
   *
   * These used to fall through to the legacy path, which parses 162 modules to reach a function
   * that lives in `editor.mjs` — and then runs the whole legacy preamble on the way: a command
   * logger that opens a file, and a harness invocation that loads and validates the entire
   * definition purely to read `harnessImports.mode`. None of it is reachable from the answer.
   *
   * It mattered most for the one shape nobody had measured. `snapshot --json` with no `--include`
   * is what `apps/vscode/src/cli/client.ts` sends on activation and after every action, so the
   * extension was paying that toll on each of its refresh triggers while the sliced read beside it
   * paid none of it.
   *
   * This is the same bypass `--include repository` above already performs, applied to the rest of
   * the command rather than to the one shape that happened to get there first. The assembly itself
   * is unchanged — same coordinator, same `repositorySnapshot`, same consistency mode — so the
   * output is identical, which `test/snapshot.test.mjs` asserts by comparing the two byte for byte.
   *
   * Worth ~13 ms of ~500, measured as a paired A/B against the previous build with `about` and
   * `snapshot` as controls — noted because it is much less than it looks like it should be, and the
   * reason is worth knowing. `editor.mjs` is 52 ms of the 75 ms `cli.mjs` costs to parse, and the
   * expensive half of the preamble was already gone: `withDefinitionCache` stopped the definition
   * being re-read per slice. What remains dominant is neither of these. A full snapshot spends
   * ~324 ms of its ~485 in 48 subprocesses, nine of them the same `git branch --show-current`,
   * and that is where the next real saving is.
   */
  const [{ repositorySnapshot }, { withDefinitionCache }, { writeHumanTimings }] = await Promise.all([
    import('../editor.mjs'),
    import('../config.mjs'),
    import('../dx-timings.mjs')
  ]);
  const timings = optionBoolean(options, 'timings');
  /**
   * One parsed definition for the whole read. Every slice loads it, and re-reading and
   * re-validating the same file for each was measured at seven parses for a single snapshot.
   */
  return withDefinitionCache(async () => {
    const result = await new SnapshotCoordinator(root).capture(
      ({ included: requested }) => repositorySnapshot(
        root,
        positionals[1],
        optionString(options, 'initiative'),
        { included: requested }
      ),
      {
        included: included.length ? included : undefined,
        ifRevision: optionString(options, 'if-revision'),
        timings,
        consistency: 'best-effort'
      }
    );
    console.log(JSON.stringify(result, null, 2));
    // Timings go to stderr, so the JSON on stdout is the same either way. Preserved exactly as the
    // legacy handler had it: the human form adds the timing line, it does not replace the payload.
    if (!optionBoolean(options, 'json')) writeHumanTimings(result.timings);
  });
}

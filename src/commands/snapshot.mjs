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
   * Every other shape of `snapshot` is still assembled by the legacy path, but it is unambiguously
   * a read: the command is classified `read`, and nothing below it writes. So it may reuse one
   * parsed definition instead of re-reading and re-validating the same file for each slice — seven
   * times, measured, for a single `snapshot --json`, which is the shape the VS Code extension asks
   * for on every refresh.
   */
  const legacy = await import('./legacy.mjs');
  const { withDefinitionCache } = await import('../config.mjs');
  return withDefinitionCache(() => legacy.run(argv, { positionals, options }));
}

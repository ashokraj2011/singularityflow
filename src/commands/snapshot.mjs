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
      { included, ifRevision: optionString(options, 'if-revision'), timings: optionBoolean(options, 'timings') }
    );
    return console.log(JSON.stringify(result, null, 2));
  }
  const legacy = await import('./legacy.mjs');
  return legacy.run(argv, { positionals, options });
}

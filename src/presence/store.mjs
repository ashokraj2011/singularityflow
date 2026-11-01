/**
 * Where SF Guard's policy chain lives: `singularity/presence.json` in the approved configuration.
 *
 * Reading takes the approved configuration's copy (sflow/config, or this checkout's configuration
 * when there is no approved branch) and its history on that branch. Every committed version must keep
 * every event of the one before it, so a commit that deletes, shortens or rewrites the file cannot
 * turn SF Guard off: the reader keeps the longest chain the history shows and reports the rewrite
 * (PSS_POLICY_REWRITTEN). A deleted or rewritten history is caught by the remote check (M4).
 *
 * Writing is a configuration change like any other (`presence.set` in Workflow Studio): written
 * here when this checkout is the configuration, or proposed for review when an approved
 * configuration branch exists. Not opting in leaves the file absent and every behaviour unchanged.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  extendsPresenceChain, foldPresenceChain, parsePresenceChain, PRESENCE_CHAIN_PATH
} from './chain.mjs';

/** One version's chain, or null when the file is absent or unreadable there. */
function versionChain(text) {
  const parsed = parsePresenceChain(text);
  return parsed.chain;
}

/**
 * The longest chain `versions` (oldest first, `{ commit, chain }`) show without a rewrite, and each
 * version that did not keep the one before it. A rewrite a later version undid (it extends the kept
 * chain again) is `repaired`: history, not a problem.
 */
export function longestKeptChain(versions) {
  let kept = null;
  const rewrites = [];
  for (const version of versions) {
    if (!kept) { kept = version.chain ?? null; continue; }
    if (extendsPresenceChain(kept, version.chain)) {
      kept = version.chain;
      for (const rewrite of rewrites) rewrite.repaired = true;
    } else rewrites.push({ commit: version.commit ?? null, events: version.chain?.events?.length ?? 0, kept: kept.events.length, repaired: false });
  }
  return { chain: kept, rewrites };
}

/**
 * The effective SF Guard policy of `root`'s approved configuration: `{ source, chain, folded,
 * problems, historyChecked }`. Never throws for a damaged file: it reports and keeps the valid
 * prefix. `verify` reaches the signature check for tests.
 */
export async function readPresencePolicy(root, { verify } = {}) {
  const [{ withApprovedConfigurationRead }, { configurationReadRootForPath }, git] = await Promise.all([
    import('../approved-configuration-reader.mjs'), import('../configuration-read-scope.mjs'), import('../git.mjs')]);
  return withApprovedConfigurationRead(root, async (source) => {
    const directory = configurationReadRootForPath(root, PRESENCE_CHAIN_PATH);
    const text = await readFile(path.join(directory, PRESENCE_CHAIN_PATH), 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
    const parsed = parsePresenceChain(text);
    const problems = parsed.problem ? [parsed.problem] : [];
    // The branch the configuration comes from: the approved commit, or this checkout's HEAD.
    const tip = source?.commit ?? git.refCommit(root, 'HEAD');
    let historyChecked = false;
    let versions = [];
    if (tip) {
      const commits = git.pathRevisions(root, tip, PRESENCE_CHAIN_PATH);
      if (commits) {
        historyChecked = true;
        const files = git.committedFilesAtRevisions(root, commits.map((commit) => ({ key: commit, ref: commit, path: PRESENCE_CHAIN_PATH })));
        versions = commits.reverse().map((commit) => ({ commit, chain: versionChain(files.get(commit)?.toString('utf8') ?? null) }));
      }
    }
    // The file as it stands now comes last: an uncommitted addition extends the newest commit.
    const current = { commit: null, chain: parsed.chain };
    const { chain, rewrites } = longestKeptChain([...versions, current]);
    for (const rewrite of rewrites.filter((entry) => !entry.repaired)) {
      problems.push({ seq: null, kind: null, code: 'PSS_POLICY_REWRITTEN',
        message: `SF Guard's policy file ${rewrite.commit ? `at ${rewrite.commit.slice(0, 12)}` : 'as it stands now'} drops or rewrites events an earlier version had (${rewrite.events} kept of ${rewrite.kept}); the earlier chain stays in force.` });
    }
    const folded = foldPresenceChain(chain, verify ? { verify } : {});
    return { source: source ? { kind: source.kind ?? null, ref: source.ref ?? null, commit: source.commit ?? null } : null,
      chain, folded, problems: [...problems, ...folded.problems], historyChecked, present: text != null || Boolean(chain),
      repairedRewrites: rewrites.filter((entry) => entry.repaired).map(({ commit }) => commit) };
  }, { preferAuthority: true });
}

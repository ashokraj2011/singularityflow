/** Approved configuration recovery before isolated Story launch; never recreates shared policy. */
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  copyVerifiedStoryConfigurationDefinition, expectedStoryConfigurationMaterialization,
  loadStoryConfigurationSnapshot, readConfigurationSource, resolveNewStoryConfigurationAuthority
} from '../configuration-branch.mjs';
import { loadDefinition } from '../config.mjs';
import { withConfigurationReadRoot } from '../configuration-read-scope.mjs';
import { incrementCommandCounter } from '../dx-timing-context.mjs';
import { GitRemoteSession } from '../git-execution.mjs';
import { gitCommonDir } from '../git.mjs';
import { fosStoryConfigurationAuthority } from '../onboard.mjs';
import { SingularityFlowError } from '../util.mjs';

/** Reuse compilation, never live authority: prove exact bytes, then validate today's output roots. */
export async function loadMaterializedConfigurationDefinition(root, snapshot) {
  return withMaterializedConfigurationRead(root, snapshot, () => loadDefinition(root));
}

/**
 * Reuse only exact immutable inputs for one bounded consumer; live roots stay independently checked.
 *
 * The checkout carries the whole snapshot or its Story closure. Either way the expected files are
 * derived again from the verified approved bytes, never read from the record being checked.
 */
export async function withMaterializedConfigurationRead(root, snapshot, action) {
  copyVerifiedStoryConfigurationDefinition(snapshot, root);
  let expected = null;
  const verify = async () => {
    const source = await readConfigurationSource(root, { verify: true, exactBytes: true });
    const materialized = source && source.repository === snapshot.authority.remote && source.commit === snapshot.sourceCommit
      ? await expectedStoryConfigurationMaterialization(snapshot, source, root) : null;
    if (!materialized || !isDeepStrictEqual(source.assets, materialized.assets)) {
      throw new SingularityFlowError('Materialized configuration does not match its verified owner.', {
        code: 'STORY_CONFIGURATION_AUTHORITY_STALE'
      });
    }
    expected = materialized;
  };
  let verified = false;
  // Do not verify the same 161-file closure twice before the first reader. The provider fences
  // every actual load; capability-map consumers that need no definition are fenced before this
  // bounded local callback returns, still inside start's rollback boundary and before commit.
  return withConfigurationReadRoot(root, root, null, async () => {
    const result = await action();
    if (!verified) await verify();
    return result;
  }, {
    compiledDefinition: async () => {
      await verify();
      verified = true;
      incrementCommandCounter('configuration.compiled-materialized-reuse');
      // Consumers normalize definitions in place. No caller may mutate a later consumer's copy.
      return expected.definition();
    }
  });
}

export async function sealIsolatedStoryConfiguration(sourceRoot, workId, {
  readStoryPin, session = new GitRemoteSession({ cwd: sourceRoot }), fosOnly = false
} = {}) {
  const currentPin = await readStoryPin(sourceRoot);
  const authority = await fosStoryConfigurationAuthority(sourceRoot)
    ?? (fosOnly ? null : await resolveNewStoryConfigurationAuthority(sourceRoot, {
      pinnedRemote: currentPin.valid ? currentPin.source.repository : null, session
    }));
  if (!authority) return null;
  // Load approved authority before readiness. One verified immutable snapshot crosses the
  // managed-worktree boundary: no launch-file rewrite or fallback after an authority read failure.
  const snapshot = await loadStoryConfigurationSnapshot(authority, {
    session, useObjectCache: true, reuseAuthorityObservation: true
  });
  return Object.freeze({
    workId,
    sourceRepository: await realpath(sourceRoot),
    sourceCommonDir: await realpath(gitCommonDir(sourceRoot)),
    currentPin, authority, snapshot
  });
}

export async function bindIsolatedStoryConfiguration(handoff, prepared) {
  if (!handoff) return null;
  const sourceRepository = await realpath(prepared.sourceRepository);
  const targetRepository = await realpath(prepared.repositoryPath);
  const targetCommonDir = await realpath(gitCommonDir(prepared.repositoryPath));
  if (sourceRepository !== handoff.sourceRepository
      || targetCommonDir !== handoff.sourceCommonDir) {
    throw new SingularityFlowError(
      'The managed Story worktree does not belong to the checkout whose configuration authority was verified.', {
        code: 'AUTHORITY_PIN_INVALID'
      }
    );
  }
  return Object.freeze({ ...handoff, targetRepository });
}

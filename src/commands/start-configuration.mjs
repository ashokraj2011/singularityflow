/** Approved configuration recovery before isolated Story launch; never recreates shared policy. */
import { realpath } from 'node:fs/promises';
import {
  loadStoryConfigurationSnapshot, resolveNewStoryConfigurationAuthority
} from '../configuration-branch.mjs';
import { GitRemoteSession } from '../git-execution.mjs';
import { gitCommonDir } from '../git.mjs';
import { fosStoryConfigurationAuthority } from '../onboard.mjs';
import { SingularityFlowError } from '../util.mjs';

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

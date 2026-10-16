/** Approved configuration recovery before isolated Story launch; never recreates shared policy. */
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  copyVerifiedStoryConfigurationDefinition, loadStoryConfigurationSnapshot, readConfigurationSource,
  resolveNewStoryConfigurationAuthority
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
  const definition = copyVerifiedStoryConfigurationDefinition(snapshot, root);
  const expected = Object.fromEntries(snapshot.assets.map(entry => [entry.relative, {
    sha256: entry.sha256, object: entry.object, mode: entry.gitMode
  }]).sort(([a], [b]) => a.localeCompare(b)));
  const source = await readConfigurationSource(root, { verify: true, exactBytes: true });
  if (!source || source.repository !== snapshot.authority.remote || source.commit !== snapshot.sourceCommit
      || !isDeepStrictEqual(source.assets, expected)) {
    throw new SingularityFlowError('Materialized configuration does not match its verified owner.', {
      code: 'STORY_CONFIGURATION_AUTHORITY_STALE'
    });
  }
  return withConfigurationReadRoot(root, root, null, () => loadDefinition(root), {
    compiledDefinition: () => {
      incrementCommandCounter('configuration.compiled-materialized-reuse');
      return definition;
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

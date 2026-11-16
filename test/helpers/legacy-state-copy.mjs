/**
 * The configuration copy an earlier build wrote to the `state` branch, for tests of what reads one.
 *
 * SFlow no longer writes this copy (SCF:REQ-003), but copies that earlier builds wrote stay on
 * teams' state branches and must stay readable: never authority, and the evidence that a repository
 * lost its sflow/config (SCF:REQ-002). This writes one exactly as `capability publish` used to:
 * every configuration file at its own path, and `configuration/manifest.json` naming the
 * repository and the sflow/config commit it was copied from.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  canonicalConfigurationAssets, configurationAssetPaths, configurationAssetPolicyFromDirectory,
  STATE_CONFIGURATION_FORMAT, STATE_CONFIGURATION_MANIFEST
} from '../../src/configuration-branch.mjs';
import { gitRepositoryComparisonKey } from '../../src/git-repository-identity.mjs';
import { publishToStateBranch } from '../../src/ledger.mjs';
import { recordSha256 } from '../../src/records.mjs';
import { run } from '../../src/util.mjs';

const sorted = (value) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

/** Copy `remote`'s current sflow/config to its `branch` as an earlier build did. Returns the state commit. */
export async function writeLegacyStateCopy(remote, { branch = 'state', env = process.env } = {}) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-state-copy-'));
  try {
    run('git', ['clone', '-q', '--no-local', '--single-branch', '--branch', 'sflow/config', remote, scratch], { env });
    run('git', ['config', 'user.name', 'Earlier Build'], { cwd: scratch, env });
    run('git', ['config', 'user.email', 'earlier-build@example.test'], { cwd: scratch, env });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch, env }).stdout.trim();
    const policy = await configurationAssetPolicyFromDirectory(scratch);
    const paths = await configurationAssetPaths(scratch, policy);
    const assets = await canonicalConfigurationAssets(scratch, paths, { env });
    const files = {};
    const hashes = {};
    const records = {};
    for (const relative of paths) {
      const asset = assets.get(relative);
      files[relative] = asset.contents;
      hashes[relative] = asset.sha256;
      records[relative] = { sha256: asset.sha256, object: asset.object, mode: asset.mode };
    }
    files[STATE_CONFIGURATION_MANIFEST] = `${JSON.stringify({
      format: STATE_CONFIGURATION_FORMAT,
      layout: 'canonical-paths',
      subject: { repositoryIdentity: `sha256:${recordSha256({ repositoryKey: gitRepositoryComparisonKey(remote) })}` },
      source: { branch: 'sflow/config', commit },
      files: sorted(hashes),
      assets: sorted(records)
    }, null, 2)}\n`;
    const published = await publishToStateBranch(scratch, { enabled: true, remote: 'origin', branch }, files,
      'Publish reviewed capability map from sflow/config', {
        replaceRoots: ['configuration'], guardedRemoteRefs: { 'refs/heads/sflow/config': commit }, env
      });
    return published.commit ?? run('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`], { env }).stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

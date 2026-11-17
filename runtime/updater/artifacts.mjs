/** One package-pair check over the archive inspectors also used by install recovery. */
import { inspectNpmTarballBuildSources, inspectVsixBuildSources } from '../../scripts/install-staged-artifacts.mjs';

export async function inspectPair(tarball, vsix) {
  const inputs = await Promise.allSettled([
    inspectNpmTarballBuildSources(tarball),
    inspectVsixBuildSources(vsix)
  ]);
  const failure = inputs.find(result => result.status === 'rejected');
  if (failure) {
    const message = String(failure.reason.message).replace(/^Staged install recovery refused: /u, '');
    throw new Error('Package inspection failed: ' + message, { cause: failure.reason });
  }
  const [cli, extension] = inputs.map(result => result.value);
  if (cli.version !== extension.version) throw new Error('CLI and VS Code extension versions do not match.');
  if (cli.versionSource !== extension.versionSource || cli.buildInfoSource !== extension.buildInfoSource) {
    throw new Error('CLI and VS Code extension have different build content.');
  }
  return { version: cli.version, cliSha256: cli.sha256.slice(7), vsixSha256: extension.sha256.slice(7) };
}

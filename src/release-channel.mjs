/**
 * The small, machine-readable promise beside a release.
 *
 * It deliberately describes artifacts rather than installation state. Registries can mirror the
 * same files without rewriting this document, and an installer can verify bytes before executing
 * either the CLI or extension.
 */
export function releaseChannelManifest({
  version, commit, minNode, minVSCode, artifacts, builtWithNode = process.version
}) {
  if (!version || !commit || !minNode || !minVSCode) {
    throw new Error('Release channel metadata requires version, commit, minNode and minVSCode.');
  }
  const normalizedArtifacts = [...artifacts].map(({ name, sha256, kind }) => {
    if (!name || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) {
      throw new Error(`Release artifact '${name ?? 'unknown'}' requires a SHA-256 digest.`);
    }
    return Object.freeze({ name, kind, sha256 });
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (!normalizedArtifacts.length) throw new Error('A release channel cannot contain zero artifacts.');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'singularity-flow-release-channel',
    version,
    sourceCommit: commit,
    compatibility: { node: minNode, vscode: minVSCode },
    builtWithNode,
    artifacts: normalizedArtifacts
  });
}

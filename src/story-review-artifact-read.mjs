/** Immutable review artifact proof, loaded only at the packet-verification boundary. */
import { createHash } from 'node:crypto';
import { artifactSnapshotCheckoutMatches } from './artifact-review-read.mjs';
import { gitReadOutput, run, SingularityFlowError } from './util.mjs';

/** Bound Windows argv while verifying only exceptional, newline-equivalent file modes. */
function checkoutArtifactModes(root, commit, paths) {
  const modes = new Map();
  let offset = 0;
  while (offset < paths.length) {
    const chunk = [];
    let length = 0;
    while (offset < paths.length && (!chunk.length || length + paths[offset].length + 3 <= 8192)) {
      const next = paths[offset++];
      if (next.length + 3 > 8192) throw new SingularityFlowError(
        'Submitted artifact checkout mode proof exceeds the 8192-character path bound.',
        { code: 'STORY_REVIEW_EVIDENCE_INVALID' }
      );
      chunk.push(next); length += next.length + 3;
    }
    const output = gitReadOutput(run('git', ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', ...chunk], {
      cwd: root, allowFailure: true, timeoutMs: 5_000, maxBuffer: 128 * 1024
    }), 'Submitted artifact checkout modes');
    const requested = new Set(chunk);
    for (const entry of output.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, type] = entry.slice(0, tab).split(' ');
      const relative = entry.slice(tab + 1);
      if (requested.has(relative)) modes.set(relative, { mode, type });
    }
  }
  return modes;
}

/** Never read the worktree or rewrite submitted identities to repair a historical packet. */
export function reviewArtifactBindings(root, commit, artifacts, readBlob) {
  const representations = [];
  const removed = [];
  for (const artifact of artifacts) {
    if (artifact.removed === true) {
      if (!artifact.path || artifact.sha256 != null || ![0, null].includes(artifact.size ?? null)) {
        return { valid: false, reason: `does not show ${artifact.path || 'a removed artifact'} removed` };
      }
      removed.push(artifact.path);
      continue;
    }
    if (!artifact.path || !artifact.sha256 || !Number.isInteger(artifact.size) || artifact.size < 0) {
      return { valid: false, reason: 'has an incomplete artifact identity' };
    }
    const historical = readBlob(root, commit, artifact.path);
    const actualSha256 = createHash('sha256').update(historical.bytes).digest('hex');
    const submittedSha256 = String(artifact.sha256).replace(/^sha256:/, '');
    const exact = actualSha256 === submittedSha256 && historical.bytes.length === artifact.size;
    const checkout = historical.status === 0 && !exact && artifactSnapshotCheckoutMatches({
      exists: true, size: artifact.size, sha256: submittedSha256
    }, historical.bytes);
    if (historical.status !== 0 || (!exact && !checkout)) {
      return { valid: false, reason: `lacks the exact artifact ${artifact.path}` };
    }
    if (checkout) representations.push({ path: artifact.path, submittedSha256, committedSha256: actualSha256 });
  }
  if (representations.length || removed.length) {
    const paths = representations.map(item => item.path);
    const modes = checkoutArtifactModes(root, commit, [...paths, ...removed]);
    if (paths.some(relative => !['100644', '100755'].includes(modes.get(relative)?.mode)
        || modes.get(relative)?.type !== 'blob')) {
      return { valid: false, reason: 'has a non-regular artifact checkout representation' };
    }
    const present = removed.find(relative => modes.has(relative));
    if (present) return { valid: false, reason: `does not show ${present} removed` };
  }
  return { valid: true, representations };
}

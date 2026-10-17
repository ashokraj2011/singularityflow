/** One bounded Git read supplies both first-add and touch evidence for an exact Story path. */
import { run, SingularityFlowError } from './util.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';

export function readStoryPathHistory(root, relative, label, { runCommand = run } = {}) {
  const read = () => {
    incrementCommandCounter('story.history-batches');
    const result = runCommand('git', ['log', '--full-history',
      '--format=%x00sflow-commit:%H%x00', '--name-status', '-z', '--', relative], {
      cwd: root, allowFailure: true, maxBuffer: 4 * 1024 * 1024
    });
    if (result.status !== 0 || result.error || result.signal) {
      throw new SingularityFlowError(`${label} could not be read from Git history.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
    }
    const tokens = result.stdout.split('\0');
    const touches = [], additions = [];
    let commit = null;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index].replace(/^\n/u, '');
      if (!token) continue;
      const header = /^sflow-commit:([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(token);
      if (header) { commit = header[1]; touches.push(commit); continue; }
      if (!commit || !/^[ACDMRTUXB][0-9]*$/u.test(token)) {
        throw new SingularityFlowError(`${label} returned invalid Git history.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
      }
      const source = tokens[++index];
      const target = /^[RC]/u.test(token) ? tokens[++index] : source;
      if (source == null || target == null || (source !== relative && target !== relative)) {
        throw new SingularityFlowError(`${label} returned an unexpected Git path.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
      }
      if (token === 'A' && target === relative) additions.push(commit);
    }
    return { history: additions, touches };
  };
  // Reuse belongs to the Git fact owner, whose fingerprints include HEAD, shallow/graft state,
  // config, replacements and object availability. Never memoize just root/path in a read scope:
  // a governed blobless hydration can change history visibility without moving HEAD.
  return read();
}

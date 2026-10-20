/** One bounded Git read supplies both first-add and touch evidence for an exact Story path. */
import { run, SingularityFlowError } from './util.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { gitFactRequest, gitFactSnapshot } from './git-fact-cache.mjs';

const batches = new AsyncLocalStorage();

/** Only immutable Story namespaces, never application branches or the whole repository. */
export function withStoryHistoryBatch(root, prefixes, read) {
  const selected = prefixes.map(value => value.replace(/\/$/u, '') + '/');
  const existing = batches.getStore();
  if (existing?.root === path.resolve(root) && selected.every(value => existing.prefixes.includes(value))) return read();
  return batches.run({ root: path.resolve(root), prefixes: selected, stamp: null, histories: null }, read);
}

function visibility(root) {
  const request = gitFactRequest(['log', '--format=%H', 'HEAD', '--', '.'], { cwd: root, env: process.env });
  const observed = request && gitFactSnapshot(request);
  return observed && [...observed.values()].every(value => value !== null) ? JSON.stringify([...observed]) : null;
}

function batchedHistory(root, relative, label) {
  const scope = batches.getStore();
  if (!scope || scope.root !== path.resolve(root) || !scope.prefixes.some(prefix => relative.startsWith(prefix))) return null;
  const stamp = visibility(root);
  if (!stamp) return null;
  if (scope.stamp !== stamp) {
    incrementCommandCounter('story.history-batches');
    const result = run('git', ['log', '--full-history', '--format=%x00sflow-commit:%H:%P%x00',
      '--name-status', '-z', '--', ...scope.prefixes], { cwd: root, allowFailure: true, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0 || result.error || result.signal) throw new SingularityFlowError(
      `${label} could not be read from Git history.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
    const histories = new Map(), tokens = result.stdout.split('\0');
    let commit = null, merged = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index].replace(/^\n/u, '');
      if (!token) continue;
      const header = /^sflow-commit:([a-f0-9]{40}|[a-f0-9]{64}):((?:[a-f0-9]{40}|[a-f0-9]{64})(?: (?:[a-f0-9]{40}|[a-f0-9]{64}))*)?$/u.exec(token);
      if (header) { commit = header[1]; merged ||= (header[2] ?? '').includes(' '); continue; }
      if (!commit || !/^[ACDMRTUXB][0-9]*$/u.test(token)) throw new SingularityFlowError(
        `${label} returned invalid Git history.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
      const source = tokens[++index], target = /^[RC]/u.test(token) ? tokens[++index] : source;
      // A multi-path diff may detect a rename that an exact-path log reports as add/delete.
      // Do not substitute that different first-add interpretation for the original owner.
      merged ||= /^[RC]/u.test(token);
      if (!source || !target || ![source, target].some(value => scope.prefixes.some(prefix => value.startsWith(prefix)))) {
        throw new SingularityFlowError(`${label} returned an unexpected Git path.`, { code: 'WFA_DEPENDENCY_UNAVAILABLE' });
      }
      for (const name of new Set([source, target])) {
        if (!scope.prefixes.some(prefix => name.startsWith(prefix))) continue;
        const item = histories.get(name) ?? { history: [], touches: [] };
        if (item.touches.at(-1) !== commit) item.touches.push(commit);
        if (token === 'A' && name === target) item.history.push(commit);
        histories.set(name, item);
      }
    }
    // Path-limited merge traversal can include empty merge headers for one path but not another.
    // Retain the original exact-path semantics for such graphs; never infer an append-only proof.
    scope.histories = merged ? null : histories;
    scope.stamp = visibility(root) === stamp ? stamp : null;
  }
  if (!scope.stamp || !scope.histories) return null;
  const item = scope.histories.get(relative) ?? { history: [], touches: [] };
  return { history: [...item.history], touches: [...item.touches] };
}

export function readStoryPathHistory(root, relative, label, { runCommand = run } = {}) {
  const batch = runCommand === run ? batchedHistory(root, relative, label) : null;
  if (batch) return batch;
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

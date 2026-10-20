/** Invocation-local immutable tree inventories. No branch scan, writer or remote hydration. */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { run, SingularityFlowError } from './util.mjs';
import { gitFactRequest, gitFactSnapshot } from './git-fact-cache.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';

import { withStoryPathHistoryReader } from './story-path-history.mjs';

const contexts = new AsyncLocalStorage();
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function withStoryProvenance(root, itemRelative, read) {
  const namespaces = ['context/skill-amendments', 'context/test-recovery/command-amendments', 'config/wfa/snapshots']
    .map(relative => `${itemRelative}/${relative}`);
  return withStoryTreeReads(root, [`${itemRelative}/workflow.json`, ...namespaces],
    () => withStoryHistoryBatch(root, namespaces, read));
}

export function withStoryTreeReads(root, paths, read) {
  const existing = contexts.getStore();
  if (existing?.root === path.resolve(root) && paths.every(value => existing.paths.includes(value))) return read();
  return contexts.run({ root: path.resolve(root), paths, inventories: new Map() }, read);
}

export function storyTreeListing(root, commit, selected) {
  const context = contexts.getStore();
  if (!context || context.root !== path.resolve(root) || !(OID.test(commit) || commit === 'HEAD')
      || !selected.every(value => context.paths.some(prefix => value === prefix || value.startsWith(prefix + '/')))) return null;
  const request = gitFactRequest(['log', '--format=%H', 'HEAD', '--', '.'], { cwd: root, env: process.env });
  const observed = request && gitFactSnapshot(request);
  if (!observed || [...observed.values()].some(value => value === null)) return null;
  const stamp = JSON.stringify([...observed]);
  const key = `${commit}:${stamp}`;
  if (!context.inventories.has(key)) {
    incrementCommandCounter('story.tree-batches');
    const result = run('git', ['ls-tree', '-r', '-z', commit, '--', ...context.paths], {
      cwd: root, encoding: 'buffer', allowFailure: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 2 * 1024 * 1024
    });
    // Optional acquisition only. An unreadable/oversized inventory falls back to the exact owner,
    // which retains its original bounded error. Never convert it to an empty successful tree.
    if (result.status !== 0 || result.error || result.signal || !Buffer.isBuffer(result.stdout)
        || JSON.stringify([...(gitFactSnapshot(request) ?? [])]) !== stamp) return null;
    const entries = new Map();
    for (const line of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t'), name = line.slice(tab + 1);
      if (tab < 0 || entries.has(name) || !context.paths.some(prefix => name === prefix || name.startsWith(prefix + '/'))) return null;
      entries.set(name, line);
    }
    context.inventories.set(key, entries);
  }
  const entries = context.inventories.get(key);
  const lines = selected.flatMap(name => entries.has(name) ? [entries.get(name)] : []);
  return { status: 0, stdout: Buffer.from(lines.length ? lines.join('\0') + '\0' : '') };
}

const batches = new AsyncLocalStorage();

/** Only immutable Story namespaces, never application branches or the whole repository. */
export function withStoryHistoryBatch(root, prefixes, read) {
  const selected = prefixes.map(value => value.replace(/\/$/u, '') + '/');
  const existing = batches.getStore();
  if (existing?.root === path.resolve(root) && selected.every(value => existing.prefixes.includes(value))) return read();
  return batches.run({ root: path.resolve(root), prefixes: selected, stamp: null, histories: null },
    () => withStoryPathHistoryReader(root, (relative, label) => batchedHistory(root, relative, label), read));
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
    if (result.status !== 0 || result.error || result.signal) {
      // A combined inventory can exceed its bound while each exact record is still readable.
      // Fall back to the original owner, including its real failure, never an empty proof.
      scope.stamp = stamp;
      scope.histories = null;
      return null;
    }
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


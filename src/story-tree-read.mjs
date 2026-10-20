/** Invocation-local immutable tree inventories. No branch scan, writer or remote hydration. */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { run } from './util.mjs';
import { gitFactRequest, gitFactSnapshot } from './git-fact-cache.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';

const contexts = new AsyncLocalStorage();
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

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

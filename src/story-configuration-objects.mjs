/** Verify one configuration closure, never the application's ancestors or unrelated subtrees. */
import YAML from 'yaml';
import { readObjectsBatch, treeEntries } from './git-ref-tree.mjs';
import { configurationAssetPolicy, configurationAssetSearchRoots, isConfigurationAssetPath } from './configuration-assets.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';

export function configurationObjectClosure(root, commit, { env, runCommand, limits }) {
  const read = specs => {
    incrementCommandCounter('configuration.closure-tree-batches');
    return readObjectsBatch(root, specs, { env, runCommand, immutablePaths: true,
      maxObjectBytes: limits.listingBytes, maxBatchBytes: limits.materializedBytes });
  };
  const policyPaths = ['singularity/workflow.yml', 'singularity/portfolio.yml'];
  const initial = read([commit, ...policyPaths.map(relative => `${commit}:${relative}`)]);
  const source = initial?.get(commit);
  if (source?.status !== 'ok' || source.type !== 'commit') return null;
  const tree = /^tree ([a-f0-9]{40}|[a-f0-9]{64})\n/u.exec(source.bytes.toString('utf8'))?.[1];
  if (!tree || tree.length !== commit.length) return null;
  const documents = [];
  for (const relative of policyPaths) {
    const object = initial.get(`${commit}:${relative}`);
    if (object?.status === 'missing') { documents.push({}); continue; }
    if (object?.status !== 'ok' || object.type !== 'blob') return null;
    const text = object.bytes.toString('utf8');
    if (!Buffer.from(text).equals(object.bytes)) return null;
    documents.push(YAML.parse(text) ?? {});
  }
  const policy = configurationAssetPolicy(...documents);
  const roots = configurationAssetSearchRoots(policy);
  const files = new Map();
  let pending = [{ relative: '', object: tree }], directories = 0, bytes = 0, checkoutRequired = false;
  while (pending.length) {
    if ((directories += pending.length) > limits.files) return null;
    const objects = read([...new Set(pending.map(entry => entry.object))]);
    if (!objects) return null;
    const next = [];
    for (const directory of pending) {
      const object = objects.get(directory.object);
      if (object?.status !== 'ok' || object.type !== 'tree'
          || (bytes += object.bytes.length) > limits.materializedBytes) return null;
      const entries = treeEntries(object.bytes, commit.length);
      if (!entries) return null;
      const names = new Set();
      for (const entry of entries) {
        if (!entry.name || entry.name === '.' || entry.name === '..' || entry.name.toLowerCase() === '.git'
            || entry.name.includes('/') || names.has(entry.name)) return null;
        names.add(entry.name);
        const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
        if (entry.name === '.gitattributes' || relative === '.gitmodules') checkoutRequired = true;
        const selected = isConfigurationAssetPath(relative, policy);
        const ancestor = roots.some(value => value.startsWith(`${relative}/`));
        if (!selected && !ancestor) continue;
        if (entry.name.includes('\ufffd')) return null;
        if (/^0?40000$/u.test(entry.mode)) next.push({ relative, object: entry.oid });
        else if (selected) {
          if (!/^100(?:644|755)$/u.test(entry.mode)) return null;
          files.set(relative, { relative, mode: entry.mode, object: entry.oid });
          if (files.size > limits.files) return null;
        } else return null;
      }
    }
    pending = next;
  }
  // The policy blobs were read by exact path in the first batch. Bind them back to the fully
  // hash-verified tree walk so a truncated/forged listing cannot omit dependencies or widen roots.
  for (const relative of policyPaths) {
    const object = initial.get(`${commit}:${relative}`), entry = files.get(relative);
    if (object?.status === 'missing' ? entry != null : !entry || entry.object !== object.oid) return null;
  }
  return { files: [...files.values()], checkoutRequired };
}

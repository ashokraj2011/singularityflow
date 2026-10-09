/** Exact configuration objects, hydrated in bounded batches through the reviewed remote boundary. */
import { createHash } from 'node:crypto';
import { inheritEnterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import { run, SingularityFlowError } from './util.mjs';

const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const BATCH_SIZE = 128;
const fail = message => { throw new SingularityFlowError(message, { code: 'CONFIGURATION_RECREATE_UNSAFE' }); };

function git(root, args, env, extra = {}) {
  return run('git', args, { cwd: root, env, timeoutMs: 15_000, maxBuffer: MAX_BYTES, ...extra });
}

export class ConfigurationObjectReader {
  constructor(root, remote, env, runRemoteCommand) {
    this.root = root;
    this.remote = remote;
    this.env = inheritEnterpriseGitEnvironment(env, { ...env, GIT_NO_LAZY_FETCH: '1' });
    this.runRemoteCommand = runRemoteCommand;
    this.entries = new Map();
    this.objects = new Map();
    this.totalBytes = 0;
  }

  seal() {
    // Git versions at the supported floor do not all honor GIT_NO_LAZY_FETCH. Remove only
    // promisor registrations from this disposable owner checkout, after each explicit fetch.
    // Object packs and origin remain; no application repository or caller configuration is edited.
    const args = ['config', '--local', '--name-only', '--get-regexp',
      '^(remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone)$'];
    const listed = git(this.root, args, this.env, { allowFailure: true });
    if (listed.status === 1 && !listed.stdout && !listed.stderr) return;
    const keys = listed.stdout.trimEnd().split('\n');
    if (listed.status !== 0 || keys.length > 16 || keys.some(key =>
      !/^(?:extensions\.partialclone|remote\.(?:origin|sflow-frozen-[a-f0-9-]{36}:)\.(?:promisor|partialclonefilter))$/iu.test(key))) {
      fail('Cannot seal the temporary configuration object reader.');
    }
    for (const key of keys) git(this.root, ['config', '--local', '--unset-all', key], this.env);
    const after = git(this.root, args, this.env, { allowFailure: true });
    if (after.status !== 1 || after.stdout || after.stderr) fail('Configuration reader lazy-fetch suppression could not be verified.');
  }

  inventory(commit, paths, admit = () => true) {
    this.seal();
    if (!HASH.test(commit)) fail('Configuration inventory requires an exact commit.');
    const output = git(this.root, ['ls-tree', '-r', '-z', commit, '--', ...paths], this.env).stdout;
    const rows = output.split('\0').filter(Boolean);
    if (rows.length > MAX_ENTRIES) fail('The configuration tree exceeds the bounded recreation inventory.');
    const entries = [];
    for (const row of rows) {
      const separator = row.indexOf('\t');
      const relative = row.slice(separator + 1);
      if (separator < 0) fail('Malformed configuration tree inventory.');
      if (!admit(relative)) continue;
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(row.slice(0, separator));
      if (!match) fail(`Configuration asset '${relative}' is not a regular file.`);
      const entry = { commit, path: relative, mode: match[1], oid: match[2] };
      this.entries.set(`${commit}:${relative}`, entry);
      entries.push(entry);
    }
    if (this.entries.size > MAX_ENTRIES) fail('The configuration object inventory exceeds its budget.');
    return entries;
  }

  lookup(commit, relative) {
    const key = `${commit}:${relative}`;
    if (!this.entries.has(key)) {
      const entries = this.inventory(commit, [relative]);
      const entry = entries.find(item => item.path === relative) ?? null;
      // A directory must not masquerade as a missing file.
      if (!entry && entries.length) fail(`Configuration asset '${relative}' is not a regular file.`);
      this.entries.set(key, entry);
    }
    return this.entries.get(key);
  }

  check(oids) {
    if (!oids.length) return [];
    this.seal();
    const output = git(this.root, ['cat-file', '--batch-check'], this.env, { input: oids.join('\n') + '\n' }).stdout;
    const rows = output.trimEnd().split('\n');
    if (rows.length !== oids.length) fail('Incomplete configuration object inventory.');
    return rows.map((row, index) => {
      if (row === `${oids[index]} missing`) return oids[index];
      const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob (\d+)$/u.exec(row);
      if (!match || match[1] !== oids[index] || Number(match[2]) > MAX_BYTES) fail('Unsafe configuration object type or size.');
      return null;
    }).filter(Boolean);
  }

  async hydrate(entries) {
    const oids = [...new Set(entries.filter(Boolean).map(item => item.oid))].filter(oid => !this.objects.has(oid));
    const missing = this.check(oids);
    for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
      // Exact OIDs came only from admitted configuration paths in pinned commit trees.
      // No implicit cat-file fetch, source checkout, arbitrary path or fallback to per-file network.
      // A normal negotiation can produce a thin delta against a historical blob we deliberately
      // did not download. Refetch requests a self-contained pack instead of triggering lazy fetch.
      const result = await this.runRemoteCommand(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refetch',
        '--filter=blob:none', '--recurse-submodules=no', '--',
        this.remote, ...missing.slice(offset, offset + BATCH_SIZE)],
      { cwd: this.root, operation: 'remote-configuration', env: this.env });
      if (result.status !== 0) throw new SingularityFlowError(result.failure?.advice ?? 'Configuration objects could not be downloaded.',
        { code: 'CONFIGURATION_RECREATE_TRANSPORT_FAILED' });
    }
    if (this.check(oids).length) fail('Configuration object download was incomplete.');
    const blobs = readLocalGitBlobs(this.root, oids, { env: this.env,
      maximumBytes: MAX_BYTES - this.totalBytes, maximumObjectBytes: MAX_BYTES,
      code: 'CONFIGURATION_RECREATE_UNSAFE', label: 'Configuration recreation objects' });
    for (const [oid, bytes] of blobs) {
      this.totalBytes += bytes.length;
      if (this.totalBytes > MAX_BYTES) fail('Configuration recreation exceeded its bounded object byte budget.');
      this.objects.set(oid, { bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }

  file(commit, relative) {
    const entry = this.lookup(commit, relative);
    if (!entry) return null;
    const object = this.objects.get(entry.oid);
    if (!object) fail(`Configuration asset '${relative}' was not hydrated through the remote boundary.`);
    return { ...object, mode: entry.mode };
  }
}

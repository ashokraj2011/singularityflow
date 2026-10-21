/** One locked publication's immutable Git reads. Never caches HEAD, refs, identity or live files. */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { gitDisabledHooksPath } from './git-isolation-paths.mjs';

const contexts = new AsyncLocalStorage();
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 256;
const RELOCATING = /^(?:GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES)$/iu;

export async function withPublicationContext(root, action) {
  const frame = { root: path.resolve(root), reads: new Map(), bytes: 0, active: true };
  try { return await contexts.run(frame, action); }
  finally { frame.active = false; frame.reads.clear(); frame.bytes = 0; }
}

function immutableRead(args, input) {
  if (!Array.isArray(args) || args.length > 516) return false;
  if (args[0] === 'ls-tree' && args[1] === '-z' && OID.test(args[2] ?? '') && args[3] === '--') {
    return input === undefined && args.length > 4 && args.slice(4).every(p => typeof p === 'string' && p
      && !p.startsWith(':(') && !/[\x00\r\n]/u.test(p));
  }
  if (input !== undefined) return false;
  if (args.length === 4 && args[0] === 'ls-tree' && args[1] === '-r' && args[2] === '-z' && OID.test(args[3])) return true;
  if (args[0] === 'rev-parse' && args.length === 2) return /^(?:[a-f0-9]{40}|[a-f0-9]{64})\^\{(?:tree|commit)\}$/u.test(args[1]);
  // Rename/copy detection can depend on live Git configuration. Recompute that diff even when
  // both objects are immutable; only exact literal tree-entry bytes are shared here.
  return false;
}

function environmentKey(env) {
  if (Object.entries(env).some(([k, v]) => v && RELOCATING.test(k))) return null;
  // A private index and deterministic creator fields do not affect exact tree-entry reads.
  // Only the kernel's exact disabled-hooks override is equivalent to the ordinary environment;
  // every other counted configuration, replacement policy and host setting stays in the key.
  const disabledHooks = env.GIT_CONFIG_COUNT === '1' && env.GIT_CONFIG_KEY_0 === 'core.hooksPath'
    && env.GIT_CONFIG_VALUE_0 === gitDisabledHooksPath();
  return JSON.stringify(Object.entries(env).filter(([k, v]) => v !== undefined
    && !/^GIT_(?:INDEX_FILE|AUTHOR_.*|COMMITTER_.*)$/iu.test(k)
    && !(disabledHooks && ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].includes(k)))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** The callback returns already-validated bytes; failures never become successful cached reads. */
export function publicationGitRead(root, args, { env = process.env, input, maximumBytes = MAX_BYTES } = {}, read) {
  if (!immutableRead(args, input)) return read(env);
  // These closed forms read exact objects only, never replacement objects, a promisor remote,
  // or a pathspec interpreted from Candidate-owned text.
  const objectEnv = { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_LITERAL_PATHSPECS: '1' };
  const frame = contexts.getStore();
  if (!frame?.active || frame.root !== path.resolve(root) || input !== undefined) return read(objectEnv);
  const environment = environmentKey(objectEnv);
  if (environment === null) return read(objectEnv);
  const key = JSON.stringify([args, environment]);
  const found = frame.reads.get(key);
  if (found && found.length <= maximumBytes) {
    incrementCommandCounter('publication.immutable-read-hits');
    return Buffer.from(found);
  }
  const bytes = read(objectEnv);
  if (Buffer.isBuffer(bytes) && !frame.reads.has(key) && bytes.length <= maximumBytes
      && frame.reads.size < MAX_ENTRIES && frame.bytes + bytes.length <= MAX_BYTES) {
    frame.reads.set(key, Buffer.from(bytes)); frame.bytes += bytes.length;
  }
  return bytes;
}

/** Share exact object metadata across the writer and Candidate, never a mutable Git observation. */
export function publicationGitResult(root, args, options, execute) {
  if (!contexts.getStore()?.active || !immutableRead(args, options.input)
      || options.stdio && options.stdio !== 'pipe'
      || ![undefined, null, 'buffer', 'utf8', 'utf-8'].includes(options.encoding)) return execute(options);
  const binary = options.encoding === 'buffer' || options.encoding === null;
  const presentation = result => binary ? result : { ...result,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : result.stdout,
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr };
  let observed;
  const bytes = publicationGitRead(root, args, { ...options, maximumBytes: options.maxBuffer }, env => {
    observed = execute({ ...options, env, encoding: 'buffer' });
    if (observed.status !== 0 || observed.error || observed.signal != null || observed.timedOut || observed.outputOverflow) return null;
    return Buffer.isBuffer(observed.stdout) ? observed.stdout : Buffer.from(observed.stdout ?? '');
  });
  if (observed) return presentation(observed);
  return { status: 0, signal: null, stdout: binary
    ? Buffer.from(bytes) : bytes.toString(options.encoding ?? 'utf8'), stderr: binary ? Buffer.alloc(0) : '', error: null };
}

/** Commit-bound review reads. No durable packet, authorization or live-file bytes are cached. */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { readObjectsBatch } from './git-ref-tree.mjs';
import { gitFactBatch, gitFactRequest, rememberGitFact, withFreshGitFacts } from './git-fact-cache.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import { run, SingularityFlowError } from './util.mjs';

const scopes = new AsyncLocalStorage();
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const localEnv = () => ({ ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });

/** Reuse only within one read operation. A different checkout never shares its mutable view. */
export function withSourceReviewSnapshot(root, read) {
  root = path.resolve(root);
  if (scopes.getStore()?.root === root) return read();
  return scopes.run({ root, head: null, files: new Map(), fileBytes: 0, inputs: new Map(), proofs: new Map() }, read);
}

/** Retention/decision transactions must independently reload live bytes, HEAD and provenance. */
export function withFreshSourceReviewSnapshot(root, read) {
  return withFreshGitFacts(() => scopes.exit(() => withSourceReviewSnapshot(root, async () => {
    incrementCommandCounter('source-review.fresh-bindings');
    const before = snapshotHead(root);
    const result = await measureCommandSpan('source-review.fresh-binding', read);
    const after = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).stdout.trim();
    if (before !== after) throw new SingularityFlowError('Story HEAD moved during the fresh review binding check.', {
      code: 'SOURCE_REVIEW_BINDING_STALE'
    });
    return result;
  })));
}

function snapshotHead(root) {
  const scope = scopes.getStore();
  if (scope?.root === path.resolve(root) && scope.head) return scope.head;
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) throw new SingularityFlowError(
    'Cannot bind source review to an exact Story commit.', { code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE' });
  if (scope?.root === path.resolve(root)) scope.head = head;
  return head;
}

/** Pure derived packet reused by context/staging in one operation, never across a transaction. */
export function sharedSourceReviewInput(root, key, read) {
  return withSourceReviewSnapshot(root, () => {
    const scope = scopes.getStore();
    if (scope.inputs.has(key)) {
      incrementCommandCounter('source-review.snapshot-hits');
      return scope.inputs.get(key);
    }
    incrementCommandCounter('source-review.input-loads');
    const pending = measureCommandSpan('source-review.inputs', read);
    scope.inputs.set(key, pending);
    return pending;
  });
}

/** Batch only named inputs, not the repository tree. Missing/oversize entries keep legacy checks. */
export async function prefetchSourceReviewFiles(root, relatives) {
  const scope = scopes.getStore();
  if (scope?.root !== path.resolve(root)) return;
  const head = snapshotHead(root);
  const specs = [...new Set(relatives.filter(Boolean).map(relative => `${head}:${relative}`))]
    .filter(spec => !scope.files.has(spec));
  if (!specs.length) return;
  const entries = await measureCommandSpan('source-review.git-batch', () => {
    // Size only these named objects, then materialize a bounded total by immutable blob ID. Many
    // individually permitted binary attachments must not turn prefetch into gigabytes of RAM.
    const checked = readObjectsBatch(root, specs, { checkOnly: true });
    if (!checked) return null;
    let remaining = MAX_BATCH_BYTES - scope.fileBytes;
    const admitted = new Map();
    for (const [spec, entry] of checked) {
      if (entry.status !== 'ok' || entry.type !== 'blob' || entry.size > remaining) continue;
      admitted.set(spec, entry); remaining -= entry.size;
    }
    const objects = readObjectsBatch(root, [...new Set([...admitted.values()].map(entry => entry.oid))], {
      maxObjectBytes: MAX_BATCH_BYTES, maxBatchBytes: MAX_BATCH_BYTES
    });
    return new Map([...admitted].map(([spec, entry]) => [spec, objects?.get(entry.oid)]));
  });
  // A failed batch is not absence. The exact individual read below preserves the old refusal.
  for (const [spec, entry] of entries ?? []) {
    if (entry?.status === 'ok' && entry.type === 'blob') {
      scope.files.set(spec, entry.bytes); scope.fileBytes += entry.bytes.length;
    }
  }
}

/** Still compare every live file with these exact committed bytes, including CRLF handling. */
export function committedSourceReviewFile(root, relative) {
  const scope = scopes.getStore();
  const spec = `${snapshotHead(root)}:${relative}`;
  const bytes = scope?.root === path.resolve(root) ? scope.files.get(spec) : null;
  if (bytes) {
    incrementCommandCounter('source-review.blob-hits');
    return { status: 0, stdout: bytes };
  }
  return run('git', ['show', spec], { cwd: root, allowFailure: true, encoding: 'buffer' });
}

/** Memoize a validated proof only within this commit-bound operation. */
export function sharedSourceReviewProvenance(root, key, read) {
  const scope = scopes.getStore();
  if (scope?.root !== path.resolve(root)) return read();
  if (scope.proofs.has(key)) {
    incrementCommandCounter('source-review.provenance-hits');
    return scope.proofs.get(key);
  }
  const pending = measureCommandSpan('source-review.provenance', read);
  scope.proofs.set(key, pending);
  return pending;
}

/**
 * Immutable UTF-8 provenance objects share the existing private Git fact store across CLI calls.
 * Cache dependencies include shallow/graft/replacement/object availability and Git configuration;
 * TTL is not authority. Live sidecars, workflow, event/actor matching and hashes are always checked.
 * Cold misses are batched; failed, binary, oversized or invalid answers are never remembered.
 */
export function sourceReviewProvenanceObjects(root, specs) {
  const env = localEnv();
  const launch = resolvePlatformProcess('git', [], { environment: env, cwd: root });
  const executable = launch.physicalExecutable ?? launch.executable;
  const requests = new Map();
  const answers = new Map();
  const candidates = new Map(specs.map(spec => [spec, gitFactRequest(['show', spec], { cwd: root, env, executable })]));
  const cacheStarted = performance.now();
  const facts = gitFactBatch([...candidates.values()]);
  incrementCommandCounter('source-review.provenance-cache-ms', Math.max(0, Math.round(performance.now() - cacheStarted)));
  for (const [spec, request] of candidates) {
    const { cached, before } = facts.get(request);
    if (cached) {
      answers.set(spec, { status: 0, stdout: Buffer.from(cached.stdout, 'utf8') });
      incrementCommandCounter('source-review.provenance-hits');
    } else requests.set(spec, { request, before });
  }
  const entries = requests.size > 1 ? readObjectsBatch(root, [...requests.keys()], {
    env, maxObjectBytes: MAX_BATCH_BYTES, maxBatchBytes: MAX_BATCH_BYTES, immutablePaths: true
  }) : null;
  for (const [spec, { request, before }] of requests) {
    const entry = entries?.get(spec);
    const answer = entry?.status === 'ok' && entry.type === 'blob'
      ? { status: 0, stdout: entry.bytes }
      : run('git', ['show', spec], { cwd: root, env, allowFailure: true, encoding: 'buffer' });
    answers.set(spec, answer);
    if (answer.status !== 0 || !Buffer.isBuffer(answer.stdout)) continue;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(answer.stdout);
      // An empty/BOM-prefixed source is not rewritten by a lossy text round trip.
      if (Buffer.from(text, 'utf8').equals(answer.stdout)) rememberGitFact(request,
        { status: 0, stdout: text, stderr: '' }, { before });
    } catch { /* Binary/invalid historical bytes remain subject to the caller's exact checks. */ }
  }
  return answers;
}

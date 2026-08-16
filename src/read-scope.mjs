/**
 * One scope in which an expensive read-only fact is computed once. `[UXH:REQ-120]` `[DHR:REQ-093]`
 *
 * ## Why this is its own module, and must stay one
 *
 * It began inside `config.mjs`, beside `loadDefinition`, which is where the first memo was needed.
 * That was fine until `git.mjs` wanted the same scope for `branch()` — and `git.mjs` is imported by
 * essentially everything, so reaching into `config.mjs` for a five-line helper dragged the whole
 * configuration domain, and `agents.mjs` behind it, into the static import graph of every fast
 * command. `dx-performance.test.mjs` refuses that, correctly and by name.
 *
 * So: **no imports, and none may be added.** The scope holds a Map and three functions. Anything
 * that needs a dependency belongs in the caller, not here. That constraint is the module's whole
 * reason for existing separately, and the guard test is what will notice if it erodes.
 *
 * ## Why it is opt-in
 *
 * A process-wide memo would be the same mistake as memoizing `identity()`: `bootstrap` repairs a
 * repository by writing `workflow.yml` and reading it back, and `start`/`publish`/`resume` check out
 * branches mid-run. Handing either the value from before its own write turns a stale number into a
 * correctness bug.
 *
 * Opening the scope is therefore a claim — *this operation does not write* — and only read-only
 * operations make it. Writers never open one, so they cannot be affected by a cache they never
 * asked for. Nested calls share the outermost scope, and it is dropped on the way out whether the
 * operation returned or threw.
 */

let scope = null;

/** Open a read scope for the duration of `fn`, unless one is already open. */
export async function withReadScope(fn) {
  if (scope) return fn();
  scope = new Map();
  try { return await fn(); }
  finally { scope = null; }
}

/**
 * Compute `key` once per scope.
 *
 * The *promise* is stored rather than the result, because concurrent callers must share one
 * computation rather than each starting their own before the first has finished — which is the
 * shape that made `loadDefinition` parse the same file seven times.
 */
export async function scopedRead(key, compute) {
  if (!scope) return compute();
  if (scope.has(key)) return scope.get(key);
  const pending = (async () => compute())();
  scope.set(key, pending);
  return pending;
}

/**
 * The same, for a fact that is read synchronously.
 *
 * `branch()` is sync and stays sync: making it async to reach a cache would push `await` through
 * every caller of a one-line Git read. A falsy result is cached like any other — "Git said nothing"
 * is an answer, and recomputing it would defeat the point on exactly the repositories where the
 * call is slow.
 */
export function scopedReadSync(key, compute) {
  if (!scope) return compute();
  if (scope.has(key)) return scope.get(key);
  const value = compute();
  scope.set(key, value);
  return value;
}

/** Whether a scope is open, for a caller deciding whether a memo would be honoured. */
export function inReadScope() {
  return scope !== null;
}

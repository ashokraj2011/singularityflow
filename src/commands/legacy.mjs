let monolith = null;

/**
 * The rest of this command's module graph, loaded where the dispatcher can time it.
 *
 * `cli.mjs` is the dispatch target for seventy-nine of the 115 registered commands and has a
 * 264-module, 102k-line static closure — roughly 110 ms of load on a warm cache, against 10 ms for
 * the root entry. All of that used to happen inside `run`, which the dispatcher does not call until
 * after it has closed the `module-load` stage, so those commands reported `module-load=0.3ms` and
 * buried the real cost in `execute`. Measured: `logs` claimed less module load than `about`, a
 * command with three modules.
 *
 * A separate export rather than a top-level `import`, because the point of this shim is that the
 * monolith is *not* in the root dispatcher's graph. `cli-entry.mjs` awaits this when a module
 * offers it, so the cost is attributed without being paid any earlier.
 */
export async function load() {
  monolith ??= await import('../cli.mjs');
  return monolith;
}

export async function run(argv) {
  const { main } = await load();
  return main(argv);
}

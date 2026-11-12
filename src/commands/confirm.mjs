/**
 * `singularity-flow confirm <CODE>` reached the command table: the CLI entry normally swaps it for the command
 * the code stands for before dispatch (confirm-entry.mjs); an in-process caller that skipped the entry gets the same.
 */
export async function run(argv) {
  const [{ expandConfirmArgv }, { main }] = await Promise.all([import('../confirm-entry.mjs'), import('../cli.mjs')]);
  return main(expandConfirmArgv(argv));
}

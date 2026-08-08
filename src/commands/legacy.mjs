export async function run(argv) {
  const { main } = await import('../cli.mjs');
  return main(argv);
}

/** Approval packet orchestration does not need the legacy choices preamble. */
const modules = new Map();
function packet(positionals, options) {
  return positionals[1] === 'begin' && positionals[2] === 'approve' && options['review-packet'] === true;
}
export function load({ positionals, options }) {
  const name = packet(positionals, options) ? './approval-packet.mjs' : './choices.mjs';
  // Literal imports, so the bundled CLI carries both.
  if (!modules.has(name)) modules.set(name, name === './approval-packet.mjs' ? import('./approval-packet.mjs') : import('./choices.mjs'));
  return modules.get(name);
}

export async function run(argv, { positionals, options }) {
  const module = await load({ positionals, options });
  if (packet(positionals, options)) return module.run({ positionals, options });
  return module.run(argv, { positionals, options });
}

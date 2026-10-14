/** Select a session operation before loading unrelated session handlers. */
const modules = new Map();
export function load({ positionals }) {
  const name = positionals[1] === 'open' ? './session-open.mjs' : './session.mjs';
  // Literal imports, so the bundled CLI carries both.
  if (!modules.has(name)) modules.set(name, name === './session-open.mjs' ? import('./session-open.mjs') : import('./session.mjs'));
  return modules.get(name);
}

export async function run(argv, { positionals, options }) {
  const module = await load({ positionals });
  if (positionals[1] === 'open') return module.run({ positionals, options });
  return module.run(argv, { positionals, options });
}

/** Select a session operation before loading unrelated session handlers. */
const modules = new Map();
export async function load({ positionals, options = {} }) {
  // Unknown/effectful forms retain the old adapter and its exact option/refusal handling.
  const currentRead = positionals[1] === 'current'
    && (await import('../utility-entry.mjs')).scopedUtilityRead(positionals, options);
  const name = currentRead ? './session-current.mjs' : positionals[1] === 'takeover' ? './session-takeover.mjs' : positionals[1] === 'open' ? './session-open.mjs'
    : positionals[1] === 'open-local' && process.env.SINGULARITY_FLOW_SESSION_READS !== 'legacy'
      ? './session-open-local.mjs' : './session.mjs';
  // Literal imports, so the bundled CLI carries every adapter.
  if (!modules.has(name)) modules.set(name, name === './session-current.mjs' ? import('./session-current.mjs') : name === './session-takeover.mjs' ? import('./session-takeover.mjs') : name === './session-open.mjs' ? import('./session-open.mjs')
    : name === './session-open-local.mjs' ? import('./session-open-local.mjs') : import('./session.mjs'));
  return modules.get(name);
}

export async function run(argv, { positionals, options, invocationCwd }) {
  const module = await load({ positionals, options });
  if (positionals[1] === 'open') return module.run({ positionals, options, invocationCwd });
  return module.run(argv, { positionals, options, invocationCwd });
}

import { SingularityFlowError } from './util.mjs';

export const COMMAND_REGISTRY = Object.freeze([
  ['about'], ['help'], ['init'], ['choices'], ['start'], ['resume'], ['lens'], ['session'],
  ['inbox'], ['finalize'], ['status'], ['progress'], ['report'], ['telemetry'], ['guide'],
  ['next'], ['run'], ['cockpit', ['home']], ['logs'], ['doctor'], ['review'], ['workflow'],
  ['assign'], ['watch'], ['recover'], ['nextsteps', ['next-steps']], ['inputs'],
  ['prompt-packs'], ['documents'], ['prepare'], ['phase'], ['artifact'], ['pr'], ['submit'],
  ['approve'], ['reject'], ['sync'], ['ledger'], ['capabilities'], ['migrate-config'],
  ['validate'], ['gate'], ['wm'], ['jira'], ['plugin'], ['desktop'], ['initiative'], ['epic'],
  ['story'], ['workspace'], ['knowledge'], ['hook']
].map(([name, aliases = []]) => Object.freeze({ name, aliases: Object.freeze(aliases) })));

const canonical = new Map(COMMAND_REGISTRY.flatMap((entry) => [
  [entry.name, entry.name],
  ...entry.aliases.map((alias) => [alias, entry.name])
]));

export function canonicalCommand(name) {
  const result = canonical.get(name);
  if (!result) throw new SingularityFlowError(`Unknown command: ${name}`);
  return result;
}

export function validateCommandHandlers(handlers) {
  const missing = COMMAND_REGISTRY.map((entry) => entry.name).filter((name) => typeof handlers[name] !== 'function');
  const extra = Object.keys(handlers).filter((name) => !COMMAND_REGISTRY.some((entry) => entry.name === name));
  if (missing.length || extra.length) {
    throw new SingularityFlowError(`Command registry drift.${missing.length ? ` Missing handlers: ${missing.join(', ')}.` : ''}${extra.length ? ` Unregistered handlers: ${extra.join(', ')}.` : ''}`);
  }
  return handlers;
}

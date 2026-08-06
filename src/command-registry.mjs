import { SingularityFlowError } from './util.mjs';

export const COMMAND_REGISTRY = Object.freeze([
  ['about'], ['help'], ['init'], ['factory-reset'], ['reset-all'], ['fresh-install'], ['choices'], ['start'], ['resume'], ['agent'], ['session'],
  ['inbox'], ['finalize'], ['status'], ['progress'], ['report'], ['telemetry'], ['prompt-log'], ['guide'], ['refresh-branch'],
  ['next'], ['run'], ['cockpit', ['home']], ['logs'], ['doctor'], ['review'], ['workflow'],
  ['assign'], ['watch'], ['recover'], ['nextsteps', ['next-steps']], ['action'], ['inputs'],
  ['agents'], ['mcp'], ['documents'], ['prepare'], ['phase'], ['artifact'], ['pr'], ['stack'], ['regression'], ['submit'],
  ['approve'], ['reject'], ['reopen'], ['cancel'], ['sync'], ['ledger'], ['capabilities'], ['state'],
  ['validate'], ['gate'], ['wm'], ['jira'], ['plugin'], ['snapshot'], ['configuration'], ['initiative'], ['epic'],
  ['story'], ['workspace'], ['knowledge'], ['capability'], ['hook'], ['bootstrap']
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

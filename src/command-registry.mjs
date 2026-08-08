import { SingularityFlowError } from './util.mjs';

const READ_ONLY = new Set(['about', 'help', 'show', 'choices', 'inbox', 'status', 'progress', 'report', 'telemetry', 'guide', 'logs', 'doctor', 'review', 'nextsteps', 'inputs', 'spec', 'visual', 'snapshot', 'validate']);
const MODEL_OPTIONAL = new Set(['impact', 'prepare', 'next', 'run', 'wm']);
const STRUCTURED = new Set(['status', 'progress', 'report', 'impact', 'telemetry', 'doctor', 'inputs', 'snapshot', 'validate', 'gate']);

const LAZY_MODULES = Object.freeze({
  about: './commands/about.mjs',
  status: './commands/status.mjs',
  nextsteps: './commands/nextsteps.mjs',
  snapshot: './commands/snapshot.mjs'
});

function command([name, aliases = []]) {
  return Object.freeze({
    name,
    aliases: Object.freeze(aliases),
    modulePath: LAZY_MODULES[name] ?? './commands/legacy.mjs',
    classification: READ_ONLY.has(name) ? 'read' : 'mutation',
    modelPolicy: MODEL_OPTIONAL.has(name) ? 'optional' : 'none',
    output: STRUCTURED.has(name) ? 'human-or-json' : 'human'
  });
}

export const COMMAND_REGISTRY = Object.freeze([
  ['about'], ['help'], ['show'], ['harness'], ['init'], ['factory-reset'], ['reset-all'], ['fresh-install'], ['choices'], ['start'], ['resume'], ['agent'], ['session'],
  ['inbox'], ['finalize'], ['status'], ['progress'], ['report'], ['impact'], ['telemetry'], ['prompt-log'], ['guide'], ['refresh-branch'],
  ['next'], ['run'], ['cockpit', ['home']], ['logs'], ['doctor'], ['review'], ['workflow'],
  ['assign'], ['watch'], ['recover'], ['nextsteps', ['next-steps']], ['action'], ['inputs'], ['spec'],
  ['agents'], ['mcp'], ['visual'], ['documents'], ['prepare'], ['phase'], ['artifact'], ['pr'], ['stack'], ['regression'], ['submit'],
  ['approve'], ['reject'], ['reopen'], ['cancel'], ['sync'], ['ledger'], ['capabilities'], ['state'],
  ['validate'], ['gate'], ['wm'], ['jira'], ['plugin'], ['snapshot'], ['configuration'], ['initiative'], ['epic'],
  ['story'], ['workspace'], ['knowledge'], ['capability'], ['hook'], ['bootstrap']
].map(command));

const canonical = new Map(COMMAND_REGISTRY.flatMap((entry) => [
  [entry.name, entry.name],
  ...entry.aliases.map((alias) => [alias, entry.name])
]));

export function canonicalCommand(name) {
  const result = canonical.get(name);
  if (!result) throw new SingularityFlowError(`Unknown command: ${name}`);
  return result;
}

export function commandDefinition(name) {
  const normalized = canonicalCommand(name);
  return COMMAND_REGISTRY.find((entry) => entry.name === normalized);
}

export function validateCommandHandlers(handlers) {
  const missing = COMMAND_REGISTRY.map((entry) => entry.name).filter((name) => typeof handlers[name] !== 'function');
  const extra = Object.keys(handlers).filter((name) => !COMMAND_REGISTRY.some((entry) => entry.name === name));
  if (missing.length || extra.length) {
    throw new SingularityFlowError(`Command registry drift.${missing.length ? ` Missing handlers: ${missing.join(', ')}.` : ''}${extra.length ? ` Unregistered handlers: ${extra.join(', ')}.` : ''}`);
  }
  return handlers;
}

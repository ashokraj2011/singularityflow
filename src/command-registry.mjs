import { SingularityFlowError } from './util.mjs';

const READ_ONLY = new Set(['about', 'help', 'show', 'choices', 'inbox', 'status', 'progress', 'report', 'telemetry', 'guide', 'logs', 'doctor', 'review', 'nextsteps', 'inputs', 'spec', 'visual', 'snapshot', 'validate']);
const STRUCTURED = new Set(['status', 'progress', 'report', 'impact', 'telemetry', 'doctor', 'inputs', 'snapshot', 'validate', 'gate']);

const LAZY_MODULES = Object.freeze({
  about: './commands/about.mjs',
  status: './commands/status.mjs',
  nextsteps: './commands/nextsteps.mjs',
  snapshot: './commands/snapshot.mjs'
});

function operation(id, modelPolicy = 'never', overrides = {}) {
  return Object.freeze({
    id,
    command: overrides.command ?? id.split('.')[0],
    classification: overrides.classification ?? 'mutation',
    modelPolicy,
    fallback: overrides.fallback ?? null,
    output: overrides.output ?? 'human',
    externalDependencies: Object.freeze(overrides.externalDependencies ?? []),
    noModelFixture: overrides.noModelFixture ?? id.replaceAll('.', '-')
  });
}

function command([name, aliases = []]) {
  const classification = READ_ONLY.has(name) ? 'read' : 'mutation';
  const output = STRUCTURED.has(name) ? 'human-or-json' : 'human';
  return Object.freeze({
    name,
    aliases: Object.freeze(aliases),
    modulePath: LAZY_MODULES[name] ?? './commands/legacy.mjs',
    classification,
    modelPolicy: name === 'wm' || name === 'workspace' || name === 'pr' ? 'mixed' : 'never',
    output,
    operation: name === 'wm' || name === 'workspace' || name === 'pr'
      ? null
      : operation(name, 'never', { classification, output, noModelFixture: `${name}-model-free` })
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

const WM_MODEL_OPERATIONS = new Set(['build']);
const WM_NEVER_OPERATIONS = new Set(['init', 'inject', 'compose', 'show-prompt', 'cleanup', 'prompt', 'context', 'check', 'cache', 'light']);
const WORKSPACE_NEVER_OPERATIONS = new Set([
  'prune', 'list', 'current', 'prompt', 'create', 'open', 'archive-status', 'rename', 'archive',
  'restore', 'inspect', 'duplicate', 'capabilities', 'update', 'status', 'sync', 'repair', 'documents', 'forget', 'use'
]);
const WORKSPACE_IMPACT_OPERATIONS = new Set(['analyze', 'list', 'show', 'promote']);

function required(id) {
  return operation(id, 'required', {
    externalDependencies: ['copilot-cli'],
    ...(id === 'wm.build' ? { fallback: { operationId: 'wm.light', mode: 'guided' } } : {})
  });
}

function never(id, definition) {
  return operation(id, 'never', {
    classification: definition.classification,
    output: definition.output,
    noModelFixture: `${id.replaceAll('.', '-')}-model-free`
  });
}

function optional(id, fallbackOperationId, definition) {
  return operation(id, 'optional', {
    classification: definition.classification,
    output: definition.output,
    externalDependencies: ['copilot-cli'],
    fallback: { operationId: fallbackOperationId, mode: 'automatic' },
    noModelFixture: `${id.replaceAll('.', '-')}-fallback`
  });
}

function unclassified(id) {
  throw new SingularityFlowError(`Operation '${id}' has no model policy classification. Refusing to load its handler.`, {
    code: 'MODEL_POLICY_UNCLASSIFIED', details: { operationId: id }
  });
}

function resolveWorldModelOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'check';
  const id = `wm.${subcommand}`;
  if (WM_MODEL_OPERATIONS.has(subcommand)) return required(id);
  if (WM_NEVER_OPERATIONS.has(subcommand)) return never(id, definition);
  return unclassified(id);
}

function resolveWorkspaceOperation(definition, positionals, options) {
  const subcommand = positionals[1] ?? 'list';
  if (subcommand === 'copilot') return required('workspace.copilot');
  if (subcommand === 'impact') {
    const action = positionals[2] ?? 'list';
    if (!WORKSPACE_IMPACT_OPERATIONS.has(action)) return unclassified(`workspace.impact.${action}`);
    if (action === 'analyze' && options['dry-run'] !== true) return required('workspace.impact.analyze');
    return never(`workspace.impact.${action}`, definition);
  }
  if (WORKSPACE_NEVER_OPERATIONS.has(subcommand)) return never(`workspace.${subcommand}`, definition);
  return unclassified(`workspace.${subcommand}`);
}

function resolvePullRequestOperation(definition, positionals, options) {
  const subcommand = positionals[1] ?? 'plan';
  if (subcommand === 'describe') {
    return options.polish === true
      ? optional('pr.describe.polish', 'pr.describe', definition)
      : never('pr.describe', definition);
  }
  if (subcommand === 'plan') return never('pr.plan', definition);
  return unclassified(`pr.${subcommand}`);
}

export function resolveOperation({ requestedCommand, positionals, options = {} }) {
  const definition = commandDefinition(requestedCommand);
  if (definition.operation) return definition.operation;
  if (definition.name === 'wm') return resolveWorldModelOperation(definition, positionals);
  if (definition.name === 'workspace') return resolveWorkspaceOperation(definition, positionals, options);
  if (definition.name === 'pr') return resolvePullRequestOperation(definition, positionals, options);
  return unclassified(definition.name);
}

export function operationCatalog() {
  const direct = COMMAND_REGISTRY.flatMap((entry) => entry.operation ? [entry.operation] : []);
  const wm = [...WM_NEVER_OPERATIONS].map((name) => never(`wm.${name}`, commandDefinition('wm')))
    .concat([...WM_MODEL_OPERATIONS].map((name) => required(`wm.${name}`)));
  const workspace = [...WORKSPACE_NEVER_OPERATIONS].map((name) => never(`workspace.${name}`, commandDefinition('workspace')))
    .concat([required('workspace.copilot')])
    .concat([...WORKSPACE_IMPACT_OPERATIONS].map((name) => name === 'analyze'
      ? required('workspace.impact.analyze')
      : never(`workspace.impact.${name}`, commandDefinition('workspace'))));
  const prDefinition = commandDefinition('pr');
  const pullRequest = [
    never('pr.plan', prDefinition),
    never('pr.describe', prDefinition),
    optional('pr.describe.polish', 'pr.describe', prDefinition)
  ];
  return Object.freeze([
    operation('help.root', 'never', { classification: 'read' }),
    operation('version', 'never', { classification: 'read' }),
    ...direct, ...wm, ...workspace, ...pullRequest
  ].sort((a, b) => a.id.localeCompare(b.id)));
}

export function operationById(id) {
  return operationCatalog().find((entry) => entry.id === id) ?? null;
}

export function validateOperationRegistry() {
  const values = operationCatalog();
  const ids = new Set();
  for (const entry of values) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(entry.id)) throw new SingularityFlowError(`Invalid operation ID '${entry.id}'.`);
    if (ids.has(entry.id)) throw new SingularityFlowError(`Duplicate operation ID '${entry.id}'.`);
    if (!['read', 'mutation'].includes(entry.classification)) throw new SingularityFlowError(`Invalid classification for '${entry.id}'.`);
    if (!['never', 'optional', 'required'].includes(entry.modelPolicy)) throw new SingularityFlowError(`Invalid model policy for '${entry.id}'.`);
    if (!['human', 'human-or-json'].includes(entry.output)) throw new SingularityFlowError(`Invalid output contract for '${entry.id}'.`);
    if (!Array.isArray(entry.externalDependencies)) throw new SingularityFlowError(`Operation '${entry.id}' requires an externalDependencies array.`);
    if (entry.modelPolicy === 'never' && (typeof entry.noModelFixture !== 'string' || !entry.noModelFixture.trim())) {
      throw new SingularityFlowError(`Never-model operation '${entry.id}' requires an explicit no-model tripwire fixture.`);
    }
    if (entry.modelPolicy === 'optional' && !entry.fallback) throw new SingularityFlowError(`Optional operation '${entry.id}' requires a fallback.`);
    ids.add(entry.id);
  }
  for (const entry of values) {
    if (!entry.fallback) continue;
    const fallback = values.find((candidate) => candidate.id === entry.fallback.operationId);
    if (!fallback) throw new SingularityFlowError(`Operation '${entry.id}' references unknown fallback '${entry.fallback.operationId}'.`);
    if (fallback.modelPolicy !== 'never') throw new SingularityFlowError(`Fallback '${fallback.id}' for '${entry.id}' must have modelPolicy never.`);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (entry) => {
    if (visited.has(entry.id)) return;
    if (visiting.has(entry.id)) throw new SingularityFlowError(`Operation fallback cycle includes '${entry.id}'.`);
    visiting.add(entry.id);
    if (entry.fallback) visit(values.find((candidate) => candidate.id === entry.fallback.operationId));
    visiting.delete(entry.id); visited.add(entry.id);
  };
  values.forEach(visit);
  return true;
}

export function validateCommandHandlers(handlers) {
  const missing = COMMAND_REGISTRY.map((entry) => entry.name).filter((name) => typeof handlers[name] !== 'function');
  const extra = Object.keys(handlers).filter((name) => !COMMAND_REGISTRY.some((entry) => entry.name === name));
  if (missing.length || extra.length) {
    throw new SingularityFlowError(`Command registry drift.${missing.length ? ` Missing handlers: ${missing.join(', ')}.` : ''}${extra.length ? ` Unregistered handlers: ${extra.join(', ')}.` : ''}`);
  }
  return handlers;
}

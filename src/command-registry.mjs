import { didYouMean, optionBoolean, SingularityFlowError } from './util.mjs';

const READ_ONLY = new Set(['specify', 'plan', 'implement', 'verify', 'converge', 'about', 'help', 'show', 'choices', 'inbox', 'home', 'recommend', 'status', 'approvals', 'progress', 'guide', 'logs', 'doctor', 'nextsteps', 'snapshot', 'validate', 'explain']);
const STRUCTURED = new Set(['specify', 'plan', 'implement', 'verify', 'converge', 'start', 'home', 'recommend', 'status', 'approvals', 'progress', 'report', 'impact', 'telemetry', 'doctor', 'inputs', 'reinstall', 'snapshot', 'validate', 'gate', 'clarification', 'explain', 'fault', 'fix', 'repair', 'run']);
// `secrets` is here because `resolveOperation` returns `definition.operation` before it consults
// any resolver, so a command with a single registered operation never reaches its own resolver.
// Without this line `resolveSecretsOperation` is unreachable and the scan/protect split is inert.
const MODEL_FREE_MIXED_COMMANDS = new Set(['report', 'telemetry', 'review', 'inputs', 'spec', 'visual', 'clarification', 'story', 'constitution', 'secrets', 'fault', 'fix', 'repair']);

const LAZY_MODULES = Object.freeze({
  // The five verbs share one dispatcher; each is a registered command in its own right so the
  // registry, tripwires and help treat it like any other [SPK:REQ-010].
  specify: './commands/fast-path.mjs',
  plan: './commands/fast-path.mjs',
  implement: './commands/fast-path.mjs',
  verify: './commands/fast-path.mjs',
  converge: './commands/fast-path.mjs',
  about: './commands/about.mjs',
  home: './commands/home.mjs',
  recommend: './commands/recommend.mjs',
  status: './commands/status.mjs',
  approvals: './commands/approvals.mjs',
  nextsteps: './commands/nextsteps.mjs',
  snapshot: './commands/snapshot.mjs',
  // `explain` must answer from a global install with no repository, so it must never reach the
  // legacy dispatcher, which resolves a repository root before it does anything else.
  explain: './commands/explain.mjs'
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
  const mixed = name === 'wm' || name === 'workspace' || name === 'pr' || MODEL_FREE_MIXED_COMMANDS.has(name);
  return Object.freeze({
    name,
    aliases: Object.freeze(aliases),
    modulePath: LAZY_MODULES[name] ?? './commands/legacy.mjs',
    classification,
    modelPolicy: mixed ? 'mixed' : 'never',
    output,
    operation: mixed
      ? null
      : operation(name, 'never', { classification, output, noModelFixture: `${name}-model-free` })
  });
}

export const COMMAND_REGISTRY = Object.freeze([
  ['specify'], ['plan'], ['implement'], ['verify'], ['converge'],
  ['about'], ['help'], ['explain', ['docs']], ['show'], ['harness'], ['init'], ['factory-reset'], ['reset-all'], ['local-reset'], ['fresh-install'], ['reinstall'], ['choices'], ['start'], ['resume'], ['agent'], ['session'],
  ['inbox'], ['finalize'], ['status'], ['approvals', ['approval-chain']], ['progress'], ['report'], ['impact'], ['telemetry'], ['prompt-log'], ['guide'], ['refresh-branch'],
  ['next'], ['run'], ['fault'], ['fix'], ['repair'], ['home', ['cockpit']], ['recommend', ['what-next']], ['logs'], ['doctor'], ['review'], ['workflow'],
  ['assign'], ['watch'], ['recover'], ['nextsteps', ['next-steps']], ['action'], ['inputs'], ['spec'],
  ['agents'], ['mcp'], ['visual'], ['documents'], ['prepare'], ['phase'], ['artifact'], ['pr'], ['stack'], ['regression'], ['submit'],
  ['clarification'],
  ['approve'], ['reject'], ['reopen'], ['cancel'], ['sync'], ['ledger'], ['capabilities'], ['state'],
  ['validate'], ['gate'], ['wm'], ['jira'], ['plugin'], ['snapshot'], ['configuration'], ['constitution'], ['initiative'], ['epic'],
  ['story'], ['workspace'], ['knowledge'], ['capability'], ['hook'], ['bootstrap'], ['secrets'],
  // The first-run walkthrough already existed as `guide --first-run` and was the best teaching asset
  // in the product, buried behind a flag on a verb that also means something else. This is the front
  // door; the flag still works.
  ['quickstart', ['first-run']]
].map(command));

const canonical = new Map(COMMAND_REGISTRY.flatMap((entry) => [
  [entry.name, entry.name],
  ...entry.aliases.map((alias) => [alias, entry.name])
]));

export function canonicalCommand(name) {
  const result = canonical.get(name);
  // A mistyped command used to be answered with three words and nothing to do next. The correction
  // is almost always one edit away, and the two entry points below are the ones a newcomer needs.
  if (!result) throw new SingularityFlowError(
    `Unknown command '${name}'.${didYouMean(name, [...canonical.keys()])}`
    + " Run 'singularity-flow --help' for the command list, or 'singularity-flow quickstart' to be walked through one.",
    { code: 'UNKNOWN_COMMAND' });
  return result;
}

export function commandDefinition(name) {
  const normalized = canonicalCommand(name);
  return COMMAND_REGISTRY.find((entry) => entry.name === normalized);
}

const WM_MODEL_OPERATIONS = new Set(['build', 'ensure']);
const WM_NEVER_OPERATIONS = new Set(['init', 'inject', 'compose', 'show-prompt', 'cleanup', 'prompt', 'context', 'budget', 'facts', 'check', 'cache', 'light', 'availability', 'status', 'design-inventory']);

/**
 * The subcommands that only read, on commands whose *name* is not read-only.
 *
 * `command()` classifies from the command name, so every `workspace` and `wm` subcommand inherited
 * `mutation` — including `workspace list` and `wm status`, which write nothing. The same defect was
 * already fixed once for `report`, `telemetry`, `review`, `inputs`, `spec` and `visual` (see the
 * note in `cli-entry.mjs`) and these two were missed, so the DX timing dataset still counts a
 * workspace listing as a mutation and the audit record still discloses it as one.
 *
 * Two known mixtures are deliberately left as mutations rather than guessed at: `wm cache` takes
 * `status|clear` in a third positional, and `wm compose`/`wm inject` write unless `--dry-run` or
 * `--render-only` is passed. Splitting those means new operation IDs, new fixtures and a tripwire
 * pass of their own; calling them mutations is the wrong-but-safe direction in the meantime.
 */
const WORKSPACE_READ_OPERATIONS = new Set([
  'branches', 'list', 'current', 'prompt', 'archive-status', 'inspect', 'capabilities', 'status', 'documents', 'doctor'
]);
const WM_READ_OPERATIONS = new Set([
  'show-prompt', 'prompt', 'context', 'budget', 'facts', 'check', 'availability', 'status', 'design-inventory'
]);
const WORKSPACE_IMPACT_READ_OPERATIONS = new Set(['list', 'show']);
/** Scanning for credentials is pattern matching. A model in this path would be both slower and a way to leak the thing being looked for. */
export const SECRETS_SUBCOMMANDS = Object.freeze(['scan', 'protect']);
const WORKSPACE_NEVER_OPERATIONS = new Set([
  'branches', 'prune', 'list', 'current', 'prompt', 'create', 'open', 'archive-status', 'rename', 'archive',
  'restore', 'inspect', 'duplicate', 'capabilities', 'update', 'status', 'sync', 'repair', 'documents', 'forget', 'use',
  'prepare', 'doctor'
]);
// `workspace switch` is a live alias the handler accepts. Resolved to the operation it aliases
// rather than classified separately, so the registry and the dispatcher cannot drift apart again.
const WORKSPACE_SUBCOMMAND_ALIASES = new Map([['switch', 'use']]);
const WORKSPACE_IMPACT_OPERATIONS = new Set(['analyze', 'list', 'show', 'promote']);
const WORKSPACE_BOOTSTRAP_READ_ACTIONS = new Set(['status']);
const WORKSPACE_BOOTSTRAP_MUTATION_ACTIONS = new Set(['resume', 'abandon']);
const WORKSPACE_BOOTSTRAP_ACTIONS = new Set([
  ...WORKSPACE_BOOTSTRAP_READ_ACTIONS, ...WORKSPACE_BOOTSTRAP_MUTATION_ACTIONS
]);

/**
 * Each resolver's subcommand vocabulary, declared once.
 *
 * These are the lists the if-chains below branch on *and* the lists an unknown subcommand is
 * reported against. Hand-listing the vocabulary a second time inside the error would be two places
 * that must agree with nothing checking they do — which is how the wrong answer gets confident.
 */
const TELEMETRY_SUBCOMMANDS = Object.freeze(['status', 'reconcile']);
const VISUAL_SUBCOMMANDS = Object.freeze(['status', 'compare']);
const CLARIFICATION_SUBCOMMANDS = Object.freeze(['status', 'record']);
const FAULT_SUBCOMMANDS = Object.freeze(['report', 'list', 'show']);
const REPAIR_SUBCOMMANDS = Object.freeze(['list', 'status', 'authorize', 'attempt', 'cancel']);
const CONSTITUTION_READ_SUBCOMMANDS = Object.freeze(['check', 'show']);
const CONSTITUTION_MUTATION_SUBCOMMANDS = Object.freeze(['generate', 'except']);
const CONSTITUTION_SUBCOMMANDS = Object.freeze([...CONSTITUTION_READ_SUBCOMMANDS, ...CONSTITUTION_MUTATION_SUBCOMMANDS]);
const SPEC_READ_SUBCOMMANDS = Object.freeze(['coverage', 'trace']);
const SPEC_INDEX_SUBCOMMANDS = Object.freeze(['index', 'acceptance', 'tasks']);
const SPEC_SUBCOMMANDS = Object.freeze(['analyze', 'claims', ...SPEC_READ_SUBCOMMANDS, ...SPEC_INDEX_SUBCOMMANDS]);
const STORY_READ_SUBCOMMANDS = Object.freeze(['inbox', 'status', 'return']);
const STORY_MUTATION_SUBCOMMANDS = Object.freeze(['start', 'fetch', 'submit', 'finalize', 'checks', 'adjudicate', 'rework', 'advance']);
const STORY_INTERVAL_ACTIONS = Object.freeze(['status', 'checkpoint', 'reconcile', 'escalate', 'acknowledge']);
const STORY_BRANCH_ACTIONS = Object.freeze(['status', 'create', 'attach', 'promote']);
const STORY_INTENT_AMENDMENT_ACTIONS = Object.freeze(['status', 'propose', 'decide', 'acknowledge']);
const STORY_SUBCOMMANDS = Object.freeze([
  'converge', 'interval', 'branch', 'intent-amendment', ...STORY_READ_SUBCOMMANDS, ...STORY_MUTATION_SUBCOMMANDS
]);

/** Every command whose subcommands a resolver owns, for the guard that keeps these honest. */
export const RESOLVER_SUBCOMMANDS = Object.freeze({
  telemetry: TELEMETRY_SUBCOMMANDS,
  visual: VISUAL_SUBCOMMANDS,
  clarification: CLARIFICATION_SUBCOMMANDS,
  fault: FAULT_SUBCOMMANDS,
  repair: REPAIR_SUBCOMMANDS,
  constitution: CONSTITUTION_SUBCOMMANDS,
  spec: SPEC_SUBCOMMANDS,
  story: STORY_SUBCOMMANDS,
  wm: Object.freeze([...WM_MODEL_OPERATIONS, ...WM_NEVER_OPERATIONS]),
  workspace: Object.freeze(['copilot', 'impact', 'bootstrap', ...WORKSPACE_NEVER_OPERATIONS, ...WORKSPACE_SUBCOMMAND_ALIASES.keys()])
});

function required(id) {
  return operation(id, 'required', {
    externalDependencies: ['copilot-cli'],
    ...(id === 'wm.build' ? { fallback: { operationId: 'wm.light', mode: 'guided' } } : {})
  });
}

function never(id, definition, classification = definition.classification) {
  return operation(id, 'never', {
    classification,
    output: definition.output,
    noModelFixture: `${id.replaceAll('.', '-')}-model-free`
  });
}

/**
 * Secret scanning never invokes a model.
 *
 * Not a performance preference. Sending file content to a model to ask whether it contains a
 * credential would transmit the credential — the exact disclosure the command exists to prevent —
 * and would make the answer non-deterministic, so the same commit could be refused twice and
 * allowed the third time.
 */
function resolveSecretsOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'scan';
  if (subcommand === 'scan') return never('secrets.scan', definition, 'read');
  if (subcommand === 'protect') return never('secrets.protect', definition, 'mutation');
  return unknownSubcommand('secrets', subcommand, SECRETS_SUBCOMMANDS);
}

function resolveTelemetryOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'status') return never('telemetry.status', definition, 'read');
  if (subcommand === 'reconcile') return never('telemetry.reconcile', definition, 'mutation');
  return unknownSubcommand('telemetry', subcommand, TELEMETRY_SUBCOMMANDS);
}

function resolveOptionalOutputOperation(definition, options) {
  const raw = Array.isArray(options.out) ? options.out.at(-1) : options.out;
  return raw == null || raw === false || raw === ''
    ? never(`${definition.name}.render`, definition, 'read')
    : never(`${definition.name}.write`, definition, 'mutation');
}

function resolveInputsOperation(definition, options) {
  return optionBoolean(options, 'dry-run')
    ? never('inputs.dry-run', definition, 'read')
    : never('inputs.prepare', definition, 'mutation');
}

function resolveSpecOperation(definition, positionals, options) {
  const subcommand = positionals[1] ?? 'trace';
  /**
   * `analyze` writes nothing: it reads the artifact, evaluates the pinned policies, and prints.
   *
   * `--assisted` is the exception and has to be classified separately `[SPK:REQ-057]`. Classified as
   * `never` it would have been *unreachable* — the operation context forbids model execution for a
   * `never` operation, so the flag would have parsed, dispatched, and then refused itself. `optional`
   * with the deterministic report as its fallback says what is actually true: the model adds
   * candidates, and everything still works without one.
   */
  if (subcommand === 'analyze') {
    return optionBoolean(options, 'assisted')
      ? optional('spec.analyze.assisted', 'spec.analyze', definition)
      : never('spec.analyze', definition, 'read');
  }
  if (SPEC_READ_SUBCOMMANDS.includes(subcommand)) return never(`spec.${subcommand}`, definition, 'read');
  // The advisory task map is derived from the approved specification, so it lives with the other
  // clause-traceability operations rather than becoming a command of its own.
  if (SPEC_INDEX_SUBCOMMANDS.includes(subcommand)) {
    return optionBoolean(options, 'dry-run')
      ? never(`spec.${subcommand}.dry-run`, definition, 'read')
      : never(`spec.${subcommand}`, definition, 'mutation');
  }
  if (subcommand === 'claims') return never('spec.claims', definition, 'mutation');
  return unknownSubcommand('spec', subcommand, SPEC_SUBCOMMANDS);
}

function resolveVisualOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'status') return never('visual.status', definition, 'read');
  if (subcommand === 'compare') return never('visual.compare', definition, 'mutation');
  return unknownSubcommand('visual', subcommand, VISUAL_SUBCOMMANDS);
}

/**
 * `story` subcommands, classified individually. `[SPK:REQ-070]` `[SPK:REQ-073]` `[SPK:REQ-076]`
 *
 * `story` used to be one operation with one policy for everything from `inbox` to `finalize`, which
 * was harmless while every one of them was model-free. `story converge` breaks that: it must default
 * to `never` and produce deterministic facts `[SPK:REQ-073]`, while `--assisted` runs a governed
 * relay turn `[SPK:REQ-076]`. Those are two policies, so the subcommands need to be told apart —
 * and classifying only the interesting one would leave the rest silently inheriting a policy nobody
 * chose.
 */
function resolveStoryOperation(definition, positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'converge') {
    return optionBoolean(options, 'assisted')
      ? optional('story.converge.assisted', 'story.converge', definition)
      : never('story.converge', definition, 'mutation');
  }
  if (STORY_READ_SUBCOMMANDS.includes(subcommand)) return never(`story.${subcommand}`, definition, 'read');
  if (STORY_MUTATION_SUBCOMMANDS.includes(subcommand)) {
    return never(`story.${subcommand}`, definition, 'mutation');
  }
  if (subcommand === 'interval') {
    const action = positionals[2] ?? 'status';
    if (!STORY_INTERVAL_ACTIONS.includes(action)) return unknownSubcommand('story interval', action, STORY_INTERVAL_ACTIONS, 'action');
    return never(`story.interval.${action}`, definition, action === 'status' ? 'read' : 'mutation');
  }
  if (subcommand === 'branch') {
    const action = positionals[2] ?? 'status';
    if (!STORY_BRANCH_ACTIONS.includes(action)) return unknownSubcommand('story branch', action, STORY_BRANCH_ACTIONS, 'action');
    return never(`story.branch.${action}`, definition, action === 'status' ? 'read' : 'mutation');
  }
  if (subcommand === 'intent-amendment') {
    const action = positionals[2] ?? 'status';
    if (!STORY_INTENT_AMENDMENT_ACTIONS.includes(action)) {
      return unknownSubcommand('story intent-amendment', action, STORY_INTENT_AMENDMENT_ACTIONS, 'action');
    }
    return never(`story.intent-amendment.${action}`, definition, action === 'status' ? 'read' : 'mutation');
  }
  return unknownSubcommand('story', subcommand, STORY_SUBCOMMANDS);
}

/**
 * The constitution is configuration, not a phase `[SPK:CON-040]`, and none of its operations calls
 * a model: `generate` renders from the approved policy with a versioned renderer `[SPK:REQ-093]`,
 * which is precisely what makes generation byte-identical `[SPK:REQ-098]`.
 */
function resolveConstitutionOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'check';
  if (CONSTITUTION_READ_SUBCOMMANDS.includes(subcommand)) return never(`constitution.${subcommand}`, definition, 'read');
  if (CONSTITUTION_MUTATION_SUBCOMMANDS.includes(subcommand)) return never(`constitution.${subcommand}`, definition, 'mutation');
  return unknownSubcommand('constitution', subcommand, CONSTITUTION_SUBCOMMANDS);
}

function resolveClarificationOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'status') return never('clarification.status', definition, 'read');
  if (subcommand === 'record') return never('clarification.record', definition, 'mutation');
  return unknownSubcommand('clarification', subcommand, CLARIFICATION_SUBCOMMANDS);
}

function resolveFaultOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'list';
  if (['list', 'show'].includes(subcommand)) return never(`fault.${subcommand}`, definition, 'read');
  if (subcommand === 'report') return never('fault.report', definition, 'mutation');
  return unknownSubcommand('fault', subcommand, FAULT_SUBCOMMANDS);
}

function resolveFixOperation(definition, options) {
  if (optionBoolean(options, 'diagnose-only')) return never('fix.diagnose', definition, 'mutation');
  if (optionBoolean(options, 'plan-only')) return never('fix.preview', definition, 'read');
  return never('fix.request', definition, 'mutation');
}

function resolveRepairOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'list';
  if (['list', 'status'].includes(subcommand)) return never(`repair.${subcommand}`, definition, 'read');
  if (['authorize', 'attempt', 'cancel'].includes(subcommand)) return never(`repair.${subcommand}`, definition, 'mutation');
  return unknownSubcommand('repair', subcommand, REPAIR_SUBCOMMANDS);
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

/**
 * A subcommand the command does not have — which is to say, a typo.
 *
 * This used to raise the model-policy failure below, because the resolver's last line is reached
 * both when an operation was registered without a classification and when a reader simply mistyped.
 * Those are opposite audiences. The invariant is for whoever adds an operation and forgets to
 * classify it; a reader typing `workspace add` got told their command had "no model policy
 * classification" and that the handler was refused — a concept in no documentation, describing a
 * fault that was not theirs, with no mention of the word they got wrong or the words that work.
 *
 * `pr` was already patched for exactly this in isolation (see `resolvePullRequestOperation`). It was
 * the whole class, reached from eleven call sites.
 */
function unknownSubcommand(command, subcommand, known, slot = 'subcommand') {
  const available = [...new Set(known)].sort();
  throw new SingularityFlowError(
    `'${command}' has no ${slot} '${subcommand}'.${didYouMean(subcommand, available)}`
    + ` Available: ${available.join(', ')}.`,
    { code: 'UNKNOWN_SUBCOMMAND', details: { command, subcommand, available } }
  );
}

/**
 * The invariant the message above was borrowed from: a registered command that resolves to no
 * operation at all. That is a build-time mistake in this file, not something a reader can type.
 */
function unclassified(id) {
  throw new SingularityFlowError(`Operation '${id}' has no model policy classification. Refusing to load its handler.`, {
    code: 'MODEL_POLICY_UNCLASSIFIED', details: { operationId: id }
  });
}

function resolveWorldModelOperation(definition, positionals) {
  const subcommand = positionals[1] ?? 'check';
  const id = `wm.${subcommand}`;
  if (WM_MODEL_OPERATIONS.has(subcommand)) return required(id);
  if (WM_NEVER_OPERATIONS.has(subcommand)) return never(id, definition, WM_READ_OPERATIONS.has(subcommand) ? 'read' : 'mutation');
  return unknownSubcommand('wm', subcommand, RESOLVER_SUBCOMMANDS.wm);
}

function resolveWorkspaceOperation(definition, positionals, options) {
  const requested = positionals[1] ?? 'list';
  const subcommand = WORKSPACE_SUBCOMMAND_ALIASES.get(requested) ?? requested;
  if (subcommand === 'copilot') return required('workspace.copilot');
  if (subcommand === 'impact') {
    const action = positionals[2] ?? 'list';
    if (!WORKSPACE_IMPACT_OPERATIONS.has(action)) return unknownSubcommand('workspace impact', action, WORKSPACE_IMPACT_OPERATIONS, 'action');
    if (action === 'analyze' && !optionBoolean(options, 'dry-run')) return required('workspace.impact.analyze');
    return never(`workspace.impact.${action}`, definition, WORKSPACE_IMPACT_READ_OPERATIONS.has(action) ? 'read' : 'mutation');
  }
  if (subcommand === 'bootstrap') {
    const action = positionals[2] ?? 'status';
    if (!WORKSPACE_BOOTSTRAP_ACTIONS.has(action)) {
      return unknownSubcommand('workspace bootstrap', action, WORKSPACE_BOOTSTRAP_ACTIONS, 'action');
    }
    return never(
      `workspace.bootstrap.${action}`,
      definition,
      WORKSPACE_BOOTSTRAP_READ_ACTIONS.has(action) ? 'read' : 'mutation'
    );
  }
  if (WORKSPACE_NEVER_OPERATIONS.has(subcommand)) {
    return never(`workspace.${subcommand}`, definition, WORKSPACE_READ_OPERATIONS.has(subcommand) ? 'read' : 'mutation');
  }
  return unknownSubcommand('workspace', requested, RESOLVER_SUBCOMMANDS.workspace);
}

function resolvePullRequestOperation(definition, positionals, options) {
  const subcommand = positionals[1] ?? 'plan';
  if (subcommand === 'describe') {
    return optionBoolean(options, 'polish')
      ? optional('pr.describe.polish', 'pr.describe', definition)
      : never('pr.describe', definition);
  }
  // Everything else in this slot is a Work ID, not a subcommand — `pr [WORK-ID] [--create]` is the
  // documented form and the handler reads positionals[1] as the ID. Treating an ID as an unknown
  // subcommand refused every explicit-ID invocation before the handler could load, and the error
  // named a model-policy concept that appears in no documentation.
  return never('pr.plan', definition);
}

export function resolveOperation({ requestedCommand, positionals, options = {} }) {
  const definition = commandDefinition(requestedCommand);
  if (definition.operation) return definition.operation;
  if (definition.name === 'wm') return resolveWorldModelOperation(definition, positionals);
  if (definition.name === 'workspace') return resolveWorkspaceOperation(definition, positionals, options);
  if (definition.name === 'pr') return resolvePullRequestOperation(definition, positionals, options);
  if (definition.name === 'report' || definition.name === 'review') return resolveOptionalOutputOperation(definition, options);
  if (definition.name === 'secrets') return resolveSecretsOperation(definition, positionals);
  if (definition.name === 'telemetry') return resolveTelemetryOperation(definition, positionals);
  if (definition.name === 'inputs') return resolveInputsOperation(definition, options);
  if (definition.name === 'spec') return resolveSpecOperation(definition, positionals, options);
  if (definition.name === 'visual') return resolveVisualOperation(definition, positionals);
  if (definition.name === 'clarification') return resolveClarificationOperation(definition, positionals);
  if (definition.name === 'fault') return resolveFaultOperation(definition, positionals);
  if (definition.name === 'fix') return resolveFixOperation(definition, options);
  if (definition.name === 'repair') return resolveRepairOperation(definition, positionals);
  if (definition.name === 'story') return resolveStoryOperation(definition, positionals, options);
  if (definition.name === 'constitution') return resolveConstitutionOperation(definition, positionals);
  return unclassified(definition.name);
}

export function operationCatalog() {
  const direct = COMMAND_REGISTRY.flatMap((entry) => entry.operation ? [entry.operation] : []);
  const wm = [...WM_NEVER_OPERATIONS]
    .map((name) => never(`wm.${name}`, commandDefinition('wm'), WM_READ_OPERATIONS.has(name) ? 'read' : 'mutation'))
    .concat([...WM_MODEL_OPERATIONS].map((name) => required(`wm.${name}`)));
  const workspace = [...WORKSPACE_NEVER_OPERATIONS]
    .map((name) => never(`workspace.${name}`, commandDefinition('workspace'), WORKSPACE_READ_OPERATIONS.has(name) ? 'read' : 'mutation'))
    .concat([required('workspace.copilot')])
    .concat([...WORKSPACE_BOOTSTRAP_ACTIONS].map((name) => never(
      `workspace.bootstrap.${name}`,
      commandDefinition('workspace'),
      WORKSPACE_BOOTSTRAP_READ_ACTIONS.has(name) ? 'read' : 'mutation'
    )))
    .concat([...WORKSPACE_IMPACT_OPERATIONS].map((name) => name === 'analyze'
      ? required('workspace.impact.analyze')
      : never(`workspace.impact.${name}`, commandDefinition('workspace'), WORKSPACE_IMPACT_READ_OPERATIONS.has(name) ? 'read' : 'mutation')));
  const prDefinition = commandDefinition('pr');
  const pullRequest = [
    never('pr.plan', prDefinition),
    never('pr.describe', prDefinition),
    optional('pr.describe.polish', 'pr.describe', prDefinition)
  ];
  const telemetryDefinition = commandDefinition('telemetry');
  const reportDefinition = commandDefinition('report');
  const reviewDefinition = commandDefinition('review');
  const inputsDefinition = commandDefinition('inputs');
  const specDefinition = commandDefinition('spec');
  const storyDefinition = commandDefinition('story');
  const constitutionDefinition = commandDefinition('constitution');
  const visualDefinition = commandDefinition('visual');
  const clarificationDefinition = commandDefinition('clarification');
  const faultDefinition = commandDefinition('fault');
  const fixDefinition = commandDefinition('fix');
  const repairDefinition = commandDefinition('repair');
  const secretsDefinition = commandDefinition('secrets');
  const modelFreeMixed = [
    never('secrets.scan', secretsDefinition, 'read'),
    never('secrets.protect', secretsDefinition, 'mutation'),
    never('report.render', reportDefinition, 'read'),
    never('report.write', reportDefinition, 'mutation'),
    never('telemetry.status', telemetryDefinition, 'read'),
    never('telemetry.reconcile', telemetryDefinition, 'mutation'),
    never('review.render', reviewDefinition, 'read'),
    never('review.write', reviewDefinition, 'mutation'),
    never('inputs.dry-run', inputsDefinition, 'read'),
    never('inputs.prepare', inputsDefinition, 'mutation'),
    never('spec.analyze', specDefinition, 'read'),
    optional('spec.analyze.assisted', 'spec.analyze', specDefinition),
    never('spec.index', specDefinition, 'mutation'),
    never('spec.index.dry-run', specDefinition, 'read'),
    never('spec.claims', specDefinition, 'mutation'),
    never('spec.coverage', specDefinition, 'read'),
    never('spec.acceptance', specDefinition, 'mutation'),
    never('spec.acceptance.dry-run', specDefinition, 'read'),
    never('spec.tasks', specDefinition, 'mutation'),
    never('spec.tasks.dry-run', specDefinition, 'read'),
    never('spec.trace', specDefinition, 'read'),
    never('visual.status', visualDefinition, 'read'),
    never('visual.compare', visualDefinition, 'mutation'),
    never('clarification.status', clarificationDefinition, 'read'),
    never('clarification.record', clarificationDefinition, 'mutation'),
    never('fault.list', faultDefinition, 'read'),
    never('fault.show', faultDefinition, 'read'),
    never('fault.report', faultDefinition, 'mutation'),
    never('fix.diagnose', fixDefinition, 'mutation'),
    never('fix.preview', fixDefinition, 'read'),
    never('fix.request', fixDefinition, 'mutation'),
    never('repair.list', repairDefinition, 'read'),
    never('repair.status', repairDefinition, 'read'),
    never('repair.authorize', repairDefinition, 'mutation'),
    never('repair.attempt', repairDefinition, 'mutation'),
    never('repair.cancel', repairDefinition, 'mutation'),
    // The same vocabularies the resolvers branch on. These were a third hand-maintained copy of the
    // identical literals, so a subcommand could be added to the resolver and silently missing from
    // the catalog that `doctor`, the tripwires and the model-policy audit all read.
    ...STORY_READ_SUBCOMMANDS.map((name) => never(`story.${name}`, storyDefinition, 'read')),
    ...['converge', ...STORY_MUTATION_SUBCOMMANDS].map((name) => never(`story.${name}`, storyDefinition, 'mutation')),
    optional('story.converge.assisted', 'story.converge', storyDefinition),
    ...STORY_INTERVAL_ACTIONS
      .map((name) => never(`story.interval.${name}`, storyDefinition, name === 'status' ? 'read' : 'mutation')),
    ...STORY_BRANCH_ACTIONS
      .map((name) => never(`story.branch.${name}`, storyDefinition, name === 'status' ? 'read' : 'mutation')),
    ...STORY_INTENT_AMENDMENT_ACTIONS
      .map((name) => never(`story.intent-amendment.${name}`, storyDefinition, name === 'status' ? 'read' : 'mutation')),
    ...CONSTITUTION_READ_SUBCOMMANDS.map((name) => never(`constitution.${name}`, constitutionDefinition, 'read')),
    ...CONSTITUTION_MUTATION_SUBCOMMANDS.map((name) => never(`constitution.${name}`, constitutionDefinition, 'mutation'))
  ];
  return Object.freeze([
    operation('help.root', 'never', { classification: 'read' }),
    operation('version', 'never', { classification: 'read' }),
    ...direct, ...wm, ...workspace, ...pullRequest, ...modelFreeMixed
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

/**
 * Every operation a host model may route to, and nothing else. `[INT:IFC-030]` `[INT:CON-050]`
 *
 * One declaration per journey step in §8–§10, each traceable to the clause that asked for it. The
 * catalog is small on purpose: the surface a model can reach should be readable in one sitting by
 * whoever is accountable for it, and a hundred entries is not that.
 *
 * The kernel has many more operations than are declared here. The others are not "not yet
 * reachable" — they are unreachable, because nobody wrote a line for them, which is exactly how
 * an opt-in catalog is supposed to feel.
 *
 * `kernelOperation` is the honest form of "route through the existing operation" `[INT:CON-066]`:
 * the gateway name and the kernel name both appear, so the routing is data a reviewer can check
 * rather than a convention a handler is trusted to follow.
 */
import { operationCatalog } from '../command-registry.mjs';
import { compileOperationRegistry } from './registry.mjs';

/**
 * The planners the kernel provides, and whether this build actually has them.
 *
 * A planner with `run: null` is declared and not yet written. Declaring it is not a promise that it
 * works — `unimplementedPlanners` counts them and the ratchet below stops the count from growing —
 * but declaring the whole set up front is what lets the registry's rules be real from the start:
 * a declaration naming a planner nobody listed here is rejected at compile time.
 *
 * Declarations remain import-free; the planner map and ratchet below say which implementations are
 * present in this build.
 */
export const GATEWAY_PLANNERS = Object.freeze([
  'ast-status', 'ast-context', 'ast-query', 'ast-symbol', 'ast-references', 'ast-hierarchy', 'ast-module', 'ast-evidence-replay',
  'goal-inspect', 'goal-impact', 'goal-next', 'goal-trace',
  'home-overview', 'developer-next', 'work-list', 'work-continue', 'work-handoff', 'context-brief', 'work-start-intake', 'work-start',
  'work-draft-save', 'work-readiness', 'work-return', 'workspace-list', 'workspace-switch', 'workspace-materialize',
  'workspace-bootstrap-status', 'workspace-prepare-guide', 'repository-open-guide',
  'workspace-doctor-guide', 'workspace-explore-guide',
  'impact-quick', 'impact-quick-assisted', 'impact-what-if', 'impact-what-if-assisted',
  'problem-investigate', 'problem-investigate-assisted', 'repository-explore', 'intent-trace',
  'compare', 'watch-list', 'watch-create', 'watch-revoke', 'review-packet', 'review-open', 'help-explain'
].map((name) => Object.freeze({ name, run: null })));

/**
 * The ratchet. It only goes down.
 *
 * A declared planner that nothing implements is the failure mode this product keeps rediscovering:
 * something is declared, validated, and never reaches a consumer, and because everything it touches
 * passes, nobody notices for weeks. A count that a test asserts against turns that from an invisible
 * smell into a number someone has to look at and lower.
 */
export const MAX_UNIMPLEMENTED_GATEWAY_PLANNERS = 11;

/**
 * Which declared planners this build does not have.
 *
 * Measured against the planner map rather than against `GATEWAY_PLANNERS`, because the declarations
 * deliberately stay import-free: pulling the real planners in here would drag the workspace and docs
 * modules into every consumer of the registry, and the registry is on the startup path of everything
 * that resolves anything.
 */
export function unimplementedPlanners(planners = new Map()) {
  return Object.freeze(GATEWAY_PLANNERS
    .map((entry) => entry.name)
    .filter((name) => typeof planners.get?.(name) !== 'function')
    .sort());
}

const en = (...phrases) => ({ en: { version: 1, phrases } });

const READ = {
  classification: 'read',
  confirmation: 'none',
  resultContract: 'sflow-result-v2',
  externalDependencies: []
};

const ASSISTED = {
  classification: 'read',
  confirmation: 'none',
  resultContract: 'sflow-result-v2',
  modelPolicy: 'optional',
  externalDependencies: ['copilot-cli']
};

export const GATEWAY_DECLARATIONS = Object.freeze([
  {
    ...READ,
    id: 'goal.inspect',
    kernelOperation: 'goal.inspect',
    goals: ['work.list'],
    aliases: en('inspect governed goal', 'show governed goal execution'),
    subjects: ['goal', 'workspace'],
    argumentSchema: 'governed-goal-v1',
    planner: 'goal-inspect',
    noModelFixture: 'goal-inspect-model-free'
  },
  {
    ...READ,
    id: 'goal.impact',
    kernelOperation: 'goal.impact',
    goals: ['impact.quick'],
    aliases: en('show governed goal impact', 'preview goal execution scope'),
    subjects: ['goal', 'workspace'],
    argumentSchema: 'governed-goal-v1',
    planner: 'goal-impact',
    noModelFixture: 'goal-impact-model-free'
  },
  {
    ...READ,
    id: 'goal.next',
    kernelOperation: 'goal.next',
    goals: ['work.continue'],
    aliases: en('show governed goal next step', 'continue governed goal'),
    subjects: ['goal', 'workspace'],
    argumentSchema: 'governed-goal-v1',
    planner: 'goal-next',
    noModelFixture: 'goal-next-model-free'
  },
  {
    ...READ,
    id: 'goal.trace',
    kernelOperation: 'goal.trace',
    goals: ['intent.trace'],
    aliases: en('trace governed goal evidence', 'trace goal criterion'),
    subjects: ['goal', 'workspace'],
    argumentSchema: 'governed-goal-v1',
    planner: 'goal-trace',
    noModelFixture: 'goal-trace-model-free'
  },
  {
    ...READ,
    id: 'wm.ast.status',
    kernelOperation: 'wm.ast.status',
    goals: ['repository.explore'],
    aliases: en('show structural intelligence status', 'is AST intelligence available'),
    subjects: ['repository', 'workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'ast-status',
    noModelFixture: 'wm-ast-status-model-free'
  },
  {
    ...READ,
    id: 'wm.ast.context',
    kernelOperation: 'wm.ast.context',
    goals: ['repository.explore'],
    aliases: en('show bounded structural context', 'inspect repository symbols'),
    subjects: ['repository', 'story'],
    argumentSchema: 'ast-context-v2',
    planner: 'ast-context',
    noModelFixture: 'wm-ast-context-model-free'
  },
  {
    ...READ,
    id: 'wm.ast.query',
    kernelOperation: 'wm.ast.query',
    goals: ['repository.explore'],
    aliases: en('query repository symbols', 'find a structural fact'),
    subjects: ['repository', 'story'],
    argumentSchema: 'ast-query-v2',
    planner: 'ast-query',
    noModelFixture: 'wm-ast-query-model-free'
  },
  ...[
    ['symbol', 'ast-symbol', 'ast-symbol-v1', 'find a symbol declaration', 'show a symbol signature'],
    ['references', 'ast-references', 'ast-symbol-id-v1', 'find symbol references', 'who calls this symbol'],
    ['hierarchy', 'ast-hierarchy', 'ast-symbol-id-v1', 'show symbol hierarchy', 'what implements this symbol'],
    ['module', 'ast-module', 'ast-module-v1', 'show symbol module', 'find project module']
  ].map(([name, planner, argumentSchema, ...phrases]) => ({
    ...READ,
    id: `wm.ast.${name}`,
    kernelOperation: `wm.ast.${name}`,
    goals: ['repository.explore'],
    aliases: en(...phrases),
    subjects: ['repository', 'story'],
    argumentSchema,
    planner,
    noModelFixture: `wm-ast-${name}-model-free`
  })),
  {
    ...READ,
    id: 'wm.ast.evidence.replay',
    kernelOperation: 'wm.ast.evidence.replay',
    goals: ['repository.explore'],
    aliases: en('replay AST evidence', 'verify structural derivation'),
    subjects: ['repository', 'story'],
    argumentSchema: 'ast-evidence-replay-v1',
    planner: 'ast-evidence-replay',
    noModelFixture: 'wm-ast-evidence-replay-model-free'
  },
  // §3.2 The startup menu: the one screen a returning developer sees before deciding anything.
  {
    ...READ,
    id: 'home.overview',
    modelPolicy: 'never',
    goals: ['home'],
    aliases: en('home', 'where do I start', 'show me my day'),
    subjects: ['workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'home-overview',
    noModelFixture: 'home-overview-model-free'
  },

  /**
   * The one answer to "what should I do next?" across every developer surface.
   *
   * It composes the same durable Home projection with the ordered lifecycle guidance used by
   * `nextsteps`. It remains a read: the recommendation may preview a mutation, but selecting it
   * first resolves the registered read destination and never executes the displayed command.
   */
  {
    ...READ,
    id: 'developer.next',
    modelPolicy: 'never',
    goals: ['home', 'work.continue'],
    aliases: en('what should I do next', 'what now', 'recommend my next step'),
    subjects: ['workspace', 'story', 'initiative', 'epic'],
    argumentSchema: 'no-arguments-v1',
    planner: 'developer-next',
    noModelFixture: 'developer-next-model-free'
  },

  // §8.1 A filtered read of records that already exist, never a second work store `[INT:CON-060]`.
  {
    ...READ,
    id: 'work.list',
    modelPolicy: 'never',
    goals: ['work.list', 'home'],
    aliases: en('my work', 'what am I working on', 'current work'),
    subjects: ['workspace', 'story', 'initiative', 'epic'],
    argumentSchema: 'work-list-v1',
    planner: 'work-list',
    noModelFixture: 'work-list-model-free'
  },

  // §8.2 Continuation is reconstructed from governed state, never from what was said earlier `[INT:CON-062]`.
  {
    ...READ,
    id: 'work.continue',
    modelPolicy: 'never',
    goals: ['work.continue'],
    aliases: en('continue', 'pick up where I left off', 'carry on with this'),
    subjects: ['story', 'initiative', 'epic'],
    argumentSchema: 'work-subject-v1',
    planner: 'work-continue',
    noModelFixture: 'work-continue-model-free'
  },

  // §8.2 A projection of governed records and disclosed local evidence `[INT:REQ-178]` `[INT:CON-175]`.
  {
    ...READ,
    id: 'work.handoff',
    modelPolicy: 'never',
    goals: ['work.continue'],
    aliases: en('handoff packet', 'hand this over to someone', 'write up where this stands'),
    subjects: ['story', 'initiative', 'epic'],
    argumentSchema: 'work-handoff-v1',
    planner: 'work-handoff',
    noModelFixture: 'work-handoff-model-free'
  },

  /** A small phase briefing with independently expandable, session-sealed context slices. */
  {
    ...READ,
    id: 'context.brief',
    modelPolicy: 'never',
    goals: ['work.continue', 'repository.explore'],
    aliases: en(
      'give me the current context', 'brief this copilot session', 'what context applies here',
      'give copilot context for this change', 'show the target implementation',
      'expand impact finding', 'show affected tests', 'show the complete failure',
      'find similar completed work', 'why was this file omitted'
    ),
    subjects: ['story'],
    argumentSchema: 'context-brief-v1',
    planner: 'context-brief',
    noModelFixture: 'context-brief-model-free'
  },

  // §8.3 Intake reads and proposes; it creates nothing until the operation below `[INT:CON-065]`.
  {
    ...READ,
    id: 'work.start.intake',
    modelPolicy: 'never',
    goals: ['work.start'],
    aliases: en('I have an idea', 'start something new', 'new work'),
    subjects: ['workspace', 'repository'],
    argumentSchema: 'work-start-intake-v1',
    planner: 'work-start-intake',
    noModelFixture: 'work-start-intake-model-free'
  },

  /**
   * §8.3 The one operation here that creates governed records `[INT:CON-066]`.
   *
   * `exact-confirm` because the user has to see the normalized subject, repositories, profile and
   * intended effects and confirm *those* `[INT:CON-064]` — a yes/no prompt cannot carry that, and a
   * host-level "are you sure" would be confirming a sentence rather than a record.
   */
  {
    id: 'work.start',
    kernelOperation: 'start',
    classification: 'mutation',
    confirmation: 'exact-confirm',
    resultContract: 'sflow-result-v2',
    goals: ['work.start'],
    aliases: en('create the work item', 'begin governed work'),
    subjects: ['workspace', 'repository', 'story', 'initiative'],
    argumentSchema: 'work-start-v1',
    planner: 'work-start',
    noModelFixture: 'work-start-model-free'
  },

  // §8.3 Local, identity-scoped, and unable to supply approved inputs `[INT:CON-177]`.
  {
    id: 'work.draft.save',
    classification: 'mutation',
    modelPolicy: 'never',
    confirmation: 'host-confirm',
    resultContract: 'sflow-result-v2',
    externalDependencies: [],
    goals: ['work.start'],
    aliases: en('save this as a draft', 'keep this idea for later'),
    subjects: ['session'],
    argumentSchema: 'work-draft-save-v1',
    planner: 'work-draft-save',
    noModelFixture: 'work-draft-save-model-free'
  },

  {
    ...READ,
    /**
     * §6 The return briefing: what moved while you were away `[DHR:REQ-040]`.
     *
     * A read, and `model: never` — the whole point is that it is reconstructed from records rather
     * than remembered or narrated `[DHR:AC-17]`.
     */
    id: 'work.return',
    modelPolicy: 'never',
    goals: ['work.continue'],
    aliases: en('what changed while I was away', 'catch me up', 'where did I leave this'),
    subjects: ['story', 'initiative', 'epic'],
    argumentSchema: 'work-subject-v1',
    planner: 'work-return',
    noModelFixture: 'work-return-model-free'
  },

  // §8.7 A deterministic readiness planner, which is the only kind that may answer this `[INT:CON-180]`.
  {
    ...READ,
    id: 'work.readiness',
    modelPolicy: 'never',
    goals: ['work.ready'],
    aliases: en('am I ready', 'what is missing', 'why can this not advance'),
    subjects: ['story', 'initiative', 'epic'],
    argumentSchema: 'work-subject-v1',
    planner: 'work-readiness',
    noModelFixture: 'work-readiness-model-free'
  },

  // §8.4 Only what the configured registry makes visible; never a directory scan `[INT:CON-067]`.
  {
    ...READ,
    id: 'workspace.list',
    kernelOperation: 'workspace.list',
    goals: ['workspace.switch', 'home'],
    aliases: en('list workspaces', 'which workspaces can I see'),
    subjects: ['workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'workspace-list',
    noModelFixture: 'workspace-list-model-free'
  },

  /** Rootless Home recovery is still resolved and sealed like every other navigation choice. */
  {
    ...READ,
    id: 'workspace.bootstrap.status',
    kernelOperation: 'workspace.bootstrap.status',
    goals: ['workspace.switch', 'home'],
    aliases: en('continue workspace setup', 'show workspace setup progress'),
    subjects: ['workspace'],
    argumentSchema: 'workspace-bootstrap-status-v1',
    planner: 'workspace-bootstrap-status',
    noModelFixture: 'workspace-bootstrap-status-model-free'
  },

  /** A guide destination: the host owns the form, while the gateway owns whether it was selected. */
  {
    ...READ,
    id: 'workspace.prepare.guide',
    modelPolicy: 'never',
    goals: ['workspace.switch', 'home'],
    aliases: en('create a workspace', 'set up my first workspace'),
    subjects: ['workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'workspace-prepare-guide',
    noModelFixture: 'workspace-prepare-guide-model-free'
  },

  /** Existing-clone adoption is a host form with its own preservation proof. */
  {
    ...READ,
    id: 'repository.open.guide',
    modelPolicy: 'never',
    goals: ['workspace.switch', 'home'],
    aliases: en('open an existing repository', 'use an existing clone'),
    subjects: ['workspace', 'repository'],
    argumentSchema: 'no-arguments-v1',
    planner: 'repository-open-guide',
    noModelFixture: 'repository-open-guide-model-free'
  },

  /** Machine-wide diagnostics remain reachable before a workspace exists. */
  {
    ...READ,
    id: 'workspace.doctor.guide',
    modelPolicy: 'never',
    goals: ['workspace.switch', 'home'],
    aliases: en('run workspace diagnostics', 'diagnose workspace setup'),
    subjects: ['workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'workspace-doctor-guide',
    noModelFixture: 'workspace-doctor-guide-model-free'
  },

  /** Open the registered-workspace browser without scanning arbitrary directories. */
  {
    ...READ,
    id: 'workspace.explore.guide',
    modelPolicy: 'never',
    goals: ['workspace.switch', 'home'],
    aliases: en('explore workspaces', 'show saved workspaces'),
    subjects: ['workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'workspace-explore-guide',
    noModelFixture: 'workspace-explore-guide-model-free'
  },

  /**
   * §8.4 Switching changes local presentation context and nothing governed `[INT:CON-068]`.
   *
   * `host-confirm` rather than `exact-confirm`: there is one thing to confirm and its whole effect
   * is which workspace the next question is about.
   */
  {
    id: 'workspace.switch',
    kernelOperation: 'workspace.use',
    classification: 'mutation',
    confirmation: 'host-confirm',
    resultContract: 'sflow-result-v2',
    goals: ['workspace.switch'],
    aliases: en('switch workspace', 'change workspace', 'work in another workspace'),
    subjects: ['workspace'],
    argumentSchema: 'workspace-switch-v1',
    planner: 'workspace-switch',
    noModelFixture: 'workspace-switch-model-free'
  },

  // §8.4 A separate plan, because it writes to disk and reaches the network `[INT:REQ-071]`.
  {
    id: 'workspace.materialize',
    classification: 'mutation',
    modelPolicy: 'never',
    // §13 places materialization at host-confirm. It writes to disk and reaches the network, which
    // argued for more — but the plan itself already discloses target path, repositories, network
    // effects and storage, and an exact-confirm on top of that is a second reading of one decision.
    confirmation: 'host-confirm',
    resultContract: 'sflow-result-v2',
    externalDependencies: ['git'],
    goals: ['workspace.switch'],
    aliases: en('set up this workspace locally', 'clone this workspace'),
    subjects: ['workspace', 'repository'],
    argumentSchema: 'workspace-materialize-v1',
    planner: 'workspace-materialize',
    noModelFixture: 'workspace-materialize-model-free'
  },

  // §8.5 Deterministic facts first, and read-only throughout `[INT:REQ-073]` `[INT:CON-070]`.
  {
    ...READ,
    id: 'impact.quick',
    modelPolicy: 'never',
    goals: ['impact.quick'],
    aliases: en('quick impact analysis', 'what will this change affect', 'blast radius'),
    subjects: ['story', 'repository', 'workspace'],
    argumentSchema: 'impact-quick-v1',
    planner: 'impact-quick',
    noModelFixture: 'impact-quick-model-free'
  },

  // §8.5 Interpretation consumes the fact set and may not reclassify it `[INT:CON-069]`.
  {
    ...ASSISTED,
    id: 'impact.quick.assisted',
    goals: ['impact.quick'],
    aliases: en('interpret this impact', 'what are the risks in this change'),
    subjects: ['story', 'repository', 'workspace'],
    argumentSchema: 'impact-quick-v1',
    planner: 'impact-quick-assisted',
    fallback: 'impact.quick',
    noModelFixture: 'impact-quick-assisted-fallback'
  },

  // §8.6 A question asked before the source exists, and still read-only `[INT:CON-179]`.
  {
    ...READ,
    id: 'impact.what-if',
    modelPolicy: 'never',
    goals: ['impact.what-if'],
    aliases: en('what if I change this', 'hypothetical impact'),
    subjects: ['repository', 'workspace'],
    argumentSchema: 'impact-what-if-v1',
    planner: 'impact-what-if',
    noModelFixture: 'impact-what-if-model-free'
  },

  // §8.6 The half that separates assumption from evidence has to be labelled as such `[INT:CON-178]`.
  {
    ...ASSISTED,
    id: 'impact.what-if.assisted',
    goals: ['impact.what-if'],
    aliases: en('talk me through this hypothetical'),
    subjects: ['repository', 'workspace'],
    argumentSchema: 'impact-what-if-v1',
    planner: 'impact-what-if-assisted',
    fallback: 'impact.what-if',
    noModelFixture: 'impact-what-if-assisted-fallback'
  },

  // §10 Investigation gathers evidence; it does not conclude on its own.
  {
    ...READ,
    id: 'problem.investigate',
    modelPolicy: 'never',
    goals: ['problem.investigate'],
    aliases: en('investigate this bug', 'what caused this', 'find the cause'),
    subjects: ['repository', 'story', 'investigation'],
    argumentSchema: 'problem-investigate-v1',
    planner: 'problem-investigate',
    noModelFixture: 'problem-investigate-model-free'
  },

  {
    ...ASSISTED,
    id: 'problem.investigate.assisted',
    goals: ['problem.investigate'],
    aliases: en('help me reason about this failure'),
    subjects: ['repository', 'story', 'investigation'],
    argumentSchema: 'problem-investigate-v1',
    planner: 'problem-investigate-assisted',
    fallback: 'problem.investigate',
    noModelFixture: 'problem-investigate-assisted-fallback'
  },

  // §9 Exploration reads the repository the workspace already knows about.
  {
    ...READ,
    id: 'repository.explore',
    modelPolicy: 'never',
    goals: ['repository.explore'],
    aliases: en('explore this repository', 'how does this code work'),
    subjects: ['repository'],
    argumentSchema: 'repository-explore-v1',
    planner: 'repository-explore',
    noModelFixture: 'repository-explore-model-free'
  },

  // §9.1 Joined from records, never inferred from proximity or commit prose `[INT:REQ-185]` `[INT:CON-182]`.
  {
    ...READ,
    id: 'intent.trace',
    modelPolicy: 'never',
    goals: ['intent.trace'],
    aliases: en('why does this code exist', 'trace the intent', 'which decision produced this'),
    subjects: ['repository', 'document', 'story'],
    argumentSchema: 'intent-trace-v1',
    planner: 'intent-trace',
    noModelFixture: 'intent-trace-model-free'
  },

  // §9.2 Typed, both sides resolved exactly, reusing the existing diff authorities `[INT:CON-183]`.
  {
    ...READ,
    id: 'compare',
    modelPolicy: 'never',
    goals: ['compare'],
    aliases: en('compare these', 'what changed between them'),
    subjects: ['repository', 'story', 'document'],
    argumentSchema: 'compare-v1',
    planner: 'compare',
    noModelFixture: 'compare-model-free'
  },

  // §8.8 Watches are typed, identity-scoped and revocable `[INT:CON-181]`.
  {
    ...READ,
    id: 'watch.list',
    modelPolicy: 'never',
    goals: ['watch'],
    aliases: en('what am I watching', 'list my watches'),
    subjects: ['session', 'workspace'],
    argumentSchema: 'no-arguments-v1',
    planner: 'watch-list',
    noModelFixture: 'watch-list-model-free'
  },

  {
    id: 'watch.create',
    classification: 'mutation',
    modelPolicy: 'never',
    confirmation: 'host-confirm',
    resultContract: 'sflow-result-v2',
    externalDependencies: [],
    goals: ['watch'],
    aliases: en('watch this', 'notify me when this changes'),
    subjects: ['story', 'initiative', 'epic', 'repository', 'investigation'],
    argumentSchema: 'watch-create-v1',
    planner: 'watch-create',
    noModelFixture: 'watch-create-model-free'
  },

  {
    id: 'watch.revoke',
    classification: 'mutation',
    modelPolicy: 'never',
    confirmation: 'host-confirm',
    resultContract: 'sflow-result-v2',
    externalDependencies: [],
    goals: ['watch'],
    aliases: en('stop watching this', 'unsubscribe from this'),
    subjects: ['session'],
    argumentSchema: 'watch-revoke-v1',
    planner: 'watch-revoke',
    noModelFixture: 'watch-revoke-model-free'
  },

  /**
   * §8.1 The packet is a read; the decision is not the same operation `[INT:CON-061]`.
   *
   * Splitting them is what lets the guide explain readiness — which is genuinely useful — without
   * the explanation and the verdict living behind one name that could be resolved to either.
   */
  {
    ...READ,
    id: 'review.packet',
    modelPolicy: 'never',
    goals: ['review.open'],
    aliases: en('show me the review packet', 'what am I being asked to approve'),
    subjects: ['story', 'initiative', 'epic', 'document'],
    argumentSchema: 'work-subject-v1',
    planner: 'review-packet',
    noModelFixture: 'review-packet-model-free'
  },

  /**
   * §8.1 An approval, declared as what it is `[INT:CON-113]`.
   *
   * The kernel calls this a mutation because it writes; the gateway calls it an authorization
   * because a person decides it. The registry rules turn that word into the guarantee: ceremony
   * confirmation, never executable, and no next action a host can render as a button.
   */
  {
    id: 'review.open',
    kernelOperation: 'approve',
    classification: 'authorization',
    confirmation: 'ceremony',
    resultContract: 'sflow-result-v2',
    goals: ['review.open'],
    aliases: en('open the approval ceremony', 'take me to the approval'),
    subjects: ['story', 'initiative', 'epic'],
    argumentSchema: 'work-subject-v1',
    planner: 'review-open',
    noModelFixture: 'review-open-model-free'
  },

  // §5.5 Cited, bounded, and never a way to turn a documentation answer into an action `[INT:CON-040]`.
  {
    ...READ,
    id: 'help.explain',
    kernelOperation: 'explain',
    goals: ['help'],
    aliases: en('how does sflow work', 'explain this to me'),
    subjects: ['workspace', 'story', 'repository', 'document'],
    argumentSchema: 'help-explain-v1',
    planner: 'help-explain',
    noModelFixture: 'help-explain-model-free'
  }
]);

let compiled = null;

/** The shipped registry, compiled once. `[INT:REQ-051]` */
export function gatewayRegistry() {
  compiled ??= compileOperationRegistry({
    declarations: GATEWAY_DECLARATIONS,
    planners: GATEWAY_PLANNERS,
    kernelCatalog: operationCatalog()
  });
  return compiled;
}

export function gatewayOperation(id) {
  return gatewayRegistry().operations.find((entry) => entry.id === id) ?? null;
}

/** Is this kernel operation reachable from a host model at all? Absence is the answer for most of them. */
export function isGatewayReachable(operationId) {
  return gatewayRegistry().operations.some((entry) => entry.id === operationId || entry.kernelOperation === operationId);
}

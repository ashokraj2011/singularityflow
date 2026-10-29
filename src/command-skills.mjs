/**
 * Public CLI-to-Copilot crosswalk.
 *
 * The CLI registry is organised around parsable command families while Copilot skills are
 * organised around user journeys. Most names line up, but forcing a one-to-one naming rule would
 * make users choose implementation plumbing such as `prepare`, `artifact`, and `choices` instead
 * of the safer guided journey that owns it. This catalog records that distinction explicitly.
 *
 * The first skill is the primary route shown in compact help. Remaining skills are specialised
 * routes for subcommands in a command family. Tests keep both sides closed: every registered
 * command must be present, and every named skill must be packaged.
 */
import { canonicalCommand, COMMAND_REGISTRY } from './command-registry.mjs';
import { isTransportIntentId, parseArgs } from './util.mjs';

const entries = {
  pause: ['sf-pause'],
  specify: ['sf-specify'],
  plan: ['sf-plan'],
  implement: ['sf-implement'],
  verify: ['sf-verify'],
  converge: ['sf-converge'],
  about: ['sf-about'],
  help: ['sf-help'],
  explain: ['sf-docs', 'sf-explain-code', 'sf-explain'],
  show: ['sf-show'],
  harness: ['sf-harness'],
  init: ['sf-init'],
  precheck: ['sf-ready', 'sf-init'],
  onboard: ['sf-init'],
  authority: ['sf-init'],
  cache: ['sf-doctor'],
  'factory-reset': ['sf-factory-reset'],
  governance: ['sf-governance-rebuild'],
  'reset-all': ['sf-reset-all'],
  'local-reset': ['sf-local-reset'],
  local: ['sf-local'],
  'fresh-install': ['sf-fresh-install'],
  reinstall: ['sf-reinstall'],
  product: ['sf-product'],
  repositories: ['sf-repositories'],
  choices: ['sf-start', 'sf-approve'],
  start: ['sf-start'],
  resume: ['sf-resume'],
  return: ['sf-return'],
  agent: ['sf-agent'],
  session: ['sf-session', 'sf-stories'],
  inbox: ['sf-inbox'],
  finalize: ['sf-finalize'],
  status: ['sf-status'],
  approvals: ['sf-approvals'],
  progress: ['sf-progress'],
  report: ['sf-report'],
  receipt: ['sf-receipt'],
  impact: ['sf-impact'],
  telemetry: ['sf-telemetry'],
  context: ['sf-telemetry'],
  tokens: ['sf-telemetry'],
  'prompt-log': ['sf-prompt-log'],
  'help-metrics': ['sf-help'],
  guide: ['sf-help'],
  'refresh-branch': ['sf-refresh-branch'],
  next: ['sf-next'],
  run: ['sf-run'],
  fault: ['sf-fault', 'sf-fix'],
  fix: ['sf-fix'],
  repair: ['sf-fix'],
  goal: ['sf-goal'],
  journal: ['sf-journal'],
  push: ['sf-push'],
  integrations: ['sf-integrations'],
  auto: ['sf-auto'],
  adhoc: ['sf-adhoc'],
  land: ['sf-adhoc'],
  intent: ['sf-sgos', 'sf-sgos-create'],
  program: ['sf-sgos'],
  process: ['sf-sgos'],
  policy: ['sf-sgos'],
  task: ['sf-sgos'],
  request: ['sf-sgos'],
  evidence: ['sf-sgos', 'sf-evidence'],
  outcome: ['sf-outcome'],
  // Every Story skill's output rule runs it when a result came back cut off (agent-result-keeper.mjs).
  result: ['sf-code'],
  env: ['sf-environment'],
  candidate: ['sf-sgos'],
  'execution-unit': ['sf-sgos'],
  device: ['sf-sgos'],
  'authority-store': ['sf-sgos'],
  pack: ['sf-sgos'],
  learn: ['sf-learn'],
  memory: ['sf-sgos'],
  'meta-tool': ['sf-sgos'],
  home: ['sf-home'],
  gateway: ['sf-home'],
  recommend: ['sf-recommend'],
  logs: ['sf-logs'],
  doctor: ['sf-doctor'],
  check: ['sf-check'],
  review: ['sf-review'],
  'review-source': ['sf-review-source', 'sf-review-decide'],
  workflow: ['sf-workflows', 'sf-import-team', 'sf-build-workflow', 'sf-fix-workflow'],
  app: ['sf-run-app'],
  tests: ['sf-test'],
  skill: ['sf-skill'],
  instruction: ['sf-instructions'],
  assign: ['sf-assign'],
  watch: ['sf-watch'],
  recover: ['sf-recover'],
  appeal: ['sf-appeal'],
  nextsteps: ['sf-nextsteps'],
  action: ['sf-continue'],
  inputs: ['sf-inputs'],
  spec: ['sf-spec'],
  agents: ['sf-agents'],
  import: ['sf-import'],
  imports: ['sf-import'],
  marketplace: ['sf-import'],
  mcp: ['sf-mcp'],
  visual: ['sf-visual'],
  documents: ['sf-documents', 'sf-upload'],
  prepare: ['sf-phase', 'sf-code', 'sf-specify', 'sf-plan', 'sf-implement', 'sf-converge', 'sf-verify', 'sf-requirements', 'sf-design', 'sf-release', 'sf-document-intake', 'sf-scenario-check', 'sf-scenario-repair'],
  phase: ['sf-phase', 'sf-publish', 'sf-phase-documents', 'sf-code', 'sf-code-docs', 'sf-specify', 'sf-plan', 'sf-implement', 'sf-converge', 'sf-verify', 'sf-recover', 'sf-requirements', 'sf-design', 'sf-release', 'sf-document-intake', 'sf-scenario-check', 'sf-scenario-repair'],
  artifact: ['sf-phase'],
  pr: ['sf-pr', 'sf-stack'],
  stack: ['sf-stack'],
  regression: ['sf-regression-investigate'],
  submit: ['sf-submit'],
  clarification: ['sf-phase'],
  comprehension: ['sf-inspect'],
  change: ['sf-inspect'],
  proof: ['sf-inspect'],
  delivery: ['sf-inspect', 'sf-adhoc'],
  approve: ['sf-approve'],
  reject: ['sf-reject'],
  decision: ['sf-decide', 'sf-code'],
  decisions: ['sf-decide'],
  call: ['sf-call-add'],
  'upstream-issue': ['sf-decide'],
  reopen: ['sf-reject'],
  cancel: ['sf-cancel'],
  // `sync <INTENT-ID>` retries one saved push, the step /sf-push explains and runs.
  sync: ['sf-next', 'sf-push'],
  ledger: ['sf-ledger'],
  capabilities: ['sf-capabilities', 'sf-capability-doctor'],
  state: ['sf-admin'],
  validate: ['sf-doctor'],
  gate: ['sf-gate'],
  wm: ['sf-worldmodel', 'sf-show-prompt'],
  revision: ['sf-revision', 'sf-revise', 'sf-revision-attachments', 'sf-revision-checks'],
  revise: ['sf-revise'],
  jira: [
    'sf-jira-work', 'sf-jira-status', 'sf-jira-doctor', 'sf-jira-assigned', 'sf-jira-story',
    'sf-jira-board', 'sf-jira-update', 'sf-jira-initiative'
  ],
  plugin: ['sf-plugin'],
  snapshot: ['sf-snapshot'],
  configuration: ['sf-configuration'],
  constitution: ['sf-constitution'],
  initiative: [
    'sf-initiative-next', 'sf-initiative-start', 'sf-initiative-status', 'sf-initiative-phase',
    'sf-initiative-documents', 'sf-initiative-checklist', 'sf-initiative-evidence',
    'sf-initiative-approve', 'sf-initiative-materialize'
  ],
  epic: [
    'sf-epic-next', 'sf-epic-start', 'sf-epic-resume', 'sf-epic-status', 'sf-epic-sources',
    'sf-epic-requirements', 'sf-epic-planning', 'sf-epic-story-draft', 'sf-epic-stories', 'sf-epic-publish',
    'sf-epic-review', 'sf-epic-review-decision', 'sf-epic-merge-plan', 'sf-epic-complete',
    'sf-epic-drift', 'sf-epic-sync', 'sf-epic-journey'
  ],
  story: [
    'sf-inspect', 'sf-story-start', 'sf-story-inbox', 'sf-story-fetch', 'sf-story-branch',
    'sf-story-checks', 'sf-work-interval', 'sf-story-skill-version', 'sf-return', 'sf-reject',
    'sf-converge', 'sf-submit', 'sf-finalize', 'sf-mcp'
  ],
  workspace: [
    'sf-workspace', 'sf-workspace-bootstrap', 'sf-workspaces', 'sf-workspace-session',
    'sf-workspace-impact', 'sf-admin'
  ],
  copilot: ['sf-workspace-session'],
  knowledge: ['sf-knowledge'],
  capability: [
    'sf-capability-map', 'sf-capabilities', 'sf-capability-doctor',
    'sf-capability-add', 'sf-capability-protect', 'sf-capability-depend', 'sf-test-setup'
  ],
  why: ['sf-capabilities'],
  hook: ['sf-hook'],
  bootstrap: ['sf-capability-map', 'sf-quickstart'],
  secrets: ['sf-secrets'],
  quickstart: ['sf-quickstart']
};

export const COMMAND_SKILLS = Object.freeze(Object.fromEntries(
  Object.entries(entries).map(([command, skills]) => [command, Object.freeze([...skills])])
));

function route(defaultSkill, subcommands = {}) {
  return Object.freeze({
    defaultSkill,
    subcommands: Object.freeze({ ...subcommands })
  });
}

/**
 * Exact command-line routes whose Copilot journey is narrower than the command family's primary
 * skill. Keeping this beside `COMMAND_SKILLS` makes the crosswalk closed and inspectable: callers
 * no longer invent a skill name from a subcommand, and tests can prove every returned route is
 * packaged.
 */
export const COMMAND_LINE_SKILL_ROUTES = Object.freeze({
  // A person's own terminal steps among these (witness, risk, test-risk, ...) have no route at all:
  // OWN_TERMINAL_STEPS below.
  // A code step's author requests a Story test command in its own turn; /sf-decide's turn refused it.
  decision: route('sf-decide', { 'test-command': 'sf-code' }),
  'review-source': route('sf-review-source', {
    'decision-context': 'sf-review-decide', decide: 'sf-review-decide'
  }),
  session: route('sf-session', {
    candidates: 'sf-stories'
  }),
  explain: route('sf-docs', {
    code: 'sf-explain-code',
    '--subject': 'sf-explain'
  }),
  precheck: route('sf-ready'),
  // `sync <INTENT-ID>` goes to /sf-push by the ID's shape (skillForCommandLine); a Work ID stays here.
  sync: route('sf-next'),
  app: route('sf-run-app'),
  tests: route('sf-test'),
  choices: route('sf-start', {
    'begin start': 'sf-start',
    'begin approve': 'sf-approve'
  }),
  fault: route('sf-fault'),
  phase: route('sf-phase', {
    show: 'sf-phase-documents',
    publish: 'sf-publish',
    rollover: 'sf-recover'
  }),
  prepare: route('sf-phase'),
  workflow: route('sf-workflows', {
    'import-team': 'sf-import-team',
    build: 'sf-build-workflow',
    // /sf-fix-workflow begins with this read and drafts the fixes it lists as one reviewed proposal.
    validate: 'sf-fix-workflow'
  }),
  documents: route('sf-documents', {
    upload: 'sf-upload',
    add: 'sf-upload'
  }),
  pr: route('sf-pr'),
  // `evidence matrix` and `evidence scope` are the Story evidence views; every other evidence form
  // stays an SGOS family route.
  evidence: route('sf-sgos', {
    matrix: 'sf-evidence',
    scope: 'sf-evidence'
  }),
  // A read-only skill never gets a mutating route (route closure, 2026-10-28): these name no skill.
  delivery: route('sf-inspect', {
    'promotion-apply': null, 'local-runner-create': null, 'local-runner-run': null, select: null
  }),
  skill: route('sf-skill', { create: null, edit: null, attach: null, detach: null, remove: null }),
  cache: route('sf-doctor', { clear: null }),
  'help-metrics': route('sf-help', { on: null, off: null, clear: null }),
  repositories: route('sf-repositories', { 'cache clear': null }),
  gateway: route('sf-home', { serve: null }),
  capabilities: route('sf-capabilities', {
    doctor: 'sf-capability-doctor'
  }),
  wm: route('sf-worldmodel', {
    'show-prompt': 'sf-show-prompt'
  }),
  revision: route('sf-revision', {
    status: 'sf-revise',
    card: 'sf-revise',
    show: 'sf-revise',
    resume: 'sf-revise',
    abandon: 'sf-revise',
    capture: 'sf-revise',
    precheck: 'sf-revise',
    'attachments capabilities': 'sf-revision',
    'attachments preview': 'sf-revision-attachments',
    'attachments register': 'sf-revision-attachments',
    'attachments list': 'sf-revision-attachments',
    'attachments status': 'sf-revision-attachments',
    'attachments remove-preview': 'sf-revision-attachments',
    'attachments remove': 'sf-revision-attachments',
    'checks capabilities': 'sf-revision-checks',
    'checks plan': 'sf-revision-checks',
    'checks status': 'sf-revision-checks',
    'checks result': 'sf-revision-checks',
    'checks run': 'sf-revision-checks'
  }),
  revise: route('sf-revise'),
  capability: route('sf-capability-map', {
    'test-setup': 'sf-test-setup',
    onboard: 'sf-capability-map',
    add: 'sf-capability-add',
    protect: 'sf-capability-protect',
    depend: 'sf-capability-depend',
    show: 'sf-capabilities',
    of: 'sf-capabilities',
    tree: 'sf-capabilities',
    organisation: 'sf-capabilities',
    leads: 'sf-capability-doctor',
    fsck: 'sf-capability-doctor'
  }),
  bootstrap: route('sf-capability-map'),
  intent: route(null, {
    'workflow-guide': 'sf-sgos-create',
    'workflow-create': 'sf-sgos-create'
  }),
  jira: route('sf-jira-work', {
    status: 'sf-jira-status',
    doctor: 'sf-jira-doctor',
    assigned: 'sf-jira-assigned',
    list: 'sf-jira-assigned',
    pull: 'sf-jira-story',
    show: 'sf-jira-story',
    get: 'sf-jira-story',
    boards: 'sf-jira-board',
    board: 'sf-jira-board',
    transitions: 'sf-jira-update',
    transition: 'sf-jira-update',
    assign: 'sf-jira-update',
    priority: 'sf-jira-update',
    sprint: 'sf-jira-update',
    comment: 'sf-jira-update',
    projects: 'sf-jira-initiative',
    epics: 'sf-jira-initiative',
    children: 'sf-jira-initiative',
    permissions: 'sf-jira-initiative'
  }),
  initiative: route('sf-initiative-next', {
    approve: 'sf-initiative-approve',
    checklist: 'sf-initiative-checklist',
    documents: 'sf-initiative-documents',
    evidence: 'sf-initiative-evidence',
    materialize: 'sf-initiative-materialize',
    next: 'sf-initiative-next',
    phase: 'sf-initiative-phase',
    start: 'sf-initiative-start',
    status: 'sf-initiative-status'
  }),
  epic: route('sf-epic-next', {
    start: 'sf-epic-start',
    sources: 'sf-epic-sources',
    requirements: 'sf-epic-requirements',
    planning: 'sf-epic-planning',
    stories: 'sf-epic-stories',
    'create-stories': 'sf-epic-publish',
    complete: 'sf-epic-complete',
    review: 'sf-epic-review',
    'review-choice': 'sf-epic-review-decision',
    'merge-plan': 'sf-epic-merge-plan',
    drift: 'sf-epic-drift',
    sync: 'sf-epic-sync',
    status: 'sf-epic-status',
    report: 'sf-epic-status',
    resume: 'sf-epic-resume',
    next: 'sf-epic-next',
    journey: 'sf-epic-journey'
  }),
  story: route('sf-inspect', {
    start: 'sf-story-start',
    inbox: 'sf-story-inbox',
    fetch: 'sf-story-fetch',
    branch: 'sf-story-branch',
    checks: 'sf-story-checks',
    interval: 'sf-work-interval',
    return: 'sf-return',
    rework: 'sf-reject',
    // /sf-reject drafts and proposes an amendment. Its bare form returns a phase and its turn may not
    // decide or acknowledge one, so the amendment's read, decision and acknowledgement name no skill.
    'intent-amendment': null,
    'intent-amendment draft': 'sf-reject',
    'intent-amendment propose': 'sf-reject',
    'skill-version': 'sf-story-skill-version',
    'target-origin': 'sf-mcp',
    adjudicate: 'sf-converge',
    converge: 'sf-converge',
    submit: 'sf-submit',
    advance: 'sf-submit',
    finalize: 'sf-finalize',
    // The start turn prepares and discards its own checkout; /sf-inspect only reads (2026-10-28).
    'prepare-worktree': 'sf-story-start',
    'discard-worktree': 'sf-story-start',
    'references materialize': null,
    'test-policy confirm': null
  }),
  workspace: route('sf-workspace', {
    create: 'sf-workspace-bootstrap',
    prepare: 'sf-workspace-bootstrap',
    bootstrap: 'sf-workspace-bootstrap',
    doctor: 'sf-workspace-bootstrap',
    inspect: 'sf-workspace-bootstrap',
    reinitialize: 'sf-admin',
    consolidate: 'sf-admin',
    'migrate-schemas': 'sf-admin',
    list: 'sf-workspaces',
    current: 'sf-workspaces',
    prompt: 'sf-workspaces',
    copilot: 'sf-workspace-session',
    impact: 'sf-workspace-impact'
  })
});

function commandLineHead(commandLine) {
  const match = String(commandLine ?? '').trim().match(/^(?:singularity-flow|sflow)(?:\s+(.*))?$/u);
  if (!match) return null;
  const tokens = String(match[1] ?? '').trim().split(/\s+/u).filter(Boolean);
  if (!tokens.length || ['--help', '-h'].includes(tokens[0])) {
    return { command: 'help', arguments: Object.freeze([]) };
  }
  if (['--version', '-v'].includes(tokens[0])) {
    return { command: 'about', arguments: Object.freeze([]) };
  }
  try {
    return {
      command: canonicalCommand(tokens[0]),
      arguments: Object.freeze(tokens.slice(1))
    };
  } catch {
    return null;
  }
}

/**
 * The decision-list options a /sf-decide turn may record, after the person's explicit yes: they
 * write only upstream-issue records (copilot-mutation-guard.mjs). Every other choice is recorded in
 * the person's own terminal.
 */
export const DECISION_LIST_CHAT_OPTIONS = Object.freeze(['accept-risk', 'dismiss', 'return']);
const CHAT_CHOICE = new RegExp(`^d\\d{1,3}=(?:${DECISION_LIST_CHAT_OPTIONS.join('|')})$`, 'u');

/**
 * `decision plan` flags that correct an approved plan's rows. A correction is recorded only after a
 * person who approves the plan reviews the exact rows in a live terminal, so outside a preview it is
 * their own terminal step; a narrow amendment (`--add-location`) is not.
 */
export const PLAN_CORRECTION_FLAGS = Object.freeze(['add-row', 'set-fulfillment', 'add-test', 'remove-test', 'replace-test', 'remove-location', 'replace-location']);
export function planRowCorrectionStep([command, sub], options) {
  return command === 'decision' && sub === 'plan' && options['dry-run'] !== true
    && PLAN_CORRECTION_FLAGS.some((flag) => options[flag] !== undefined);
}

/**
 * Decisions recorded only after the person reviews their exact card in a live terminal
 * (captureTerminalActionAuthorization): an appeal's decision, attestation or risk, a Story test-policy
 * risk, amendment, baseline admission or attestation applied, and a test-scope confirmation. A Copilot
 * turn admitted them, then the terminal review refused the agent's shell, or a pty let an agent type
 * the person's confirmation (2026-10-28). Their previews stay open; `evidence-accept --review-ui`
 * is the browser review /sf-appeal opens for the person. A confirmed approver refresh is one too.
 */
const APPEAL_TERMINAL_REVIEWS = new Set(['decide', 'attest', 'risk-accept', 'risk-attest', 'risk-revoke', 'evidence-accept']);
const TEST_POLICY_TERMINAL_REVIEWS = new Set(['accept-risk', 'revoke-risk', 'attest-risk', 'amend', 'baseline-admission', 'attest']);
export function liveTerminalReviewStep([command, sub, verb], options) {
  if (command === 'appeal') return APPEAL_TERMINAL_REVIEWS.has(sub) && !(sub === 'evidence-accept' && options['review-ui'] === true);
  if (command === 'story' && sub === 'approvers') return verb === 'refresh' && options.confirm !== undefined;
  return command === 'story' && sub === 'test-policy'
    && ((TEST_POLICY_TERMINAL_REVIEWS.has(verb) && options.apply === true) || (verb === 'confirm' && options.confirm !== undefined));
}

/**
 * Steps only a person takes, in their own terminal. copilot-mutation-guard.mjs refuses each in every
 * turn, so a skill route to one only showed it again and pointed back to that skill: /sf-decide for
 * a witness (2026-10-26), then for an accepted test command and its decision-list record
 * (2026-10-27). No surface routes them to a skill. test/phase-mutation-contract.test.mjs holds the
 * guard's refusals and the routes to this list.
 */
export const OWN_TERMINAL_STEPS = Object.freeze([
  ['witness', ([command, sub]) => command === 'decision' && sub === 'witness'],
  ['risk', ([command, sub]) => command === 'decision' && sub === 'risk'],
  ['witness-exception-renewal', ([command, sub]) => command === 'decision' && sub === 'witness-exception'],
  ['test-run-risk', ([command, sub]) => command === 'decision' && ['test-risk', 'test-narrowing', 'evidence-reuse', 'visual-profile'].includes(sub)],
  ['test-command-decision', ([command, sub], options) => command === 'decision' && sub === 'test-command'
    && (options.accept !== undefined || options.revoke !== undefined)],
  // A /sf-decide turn records only chat options; any other choice, an answers file or the
  // interactive form is the person's.
  ['decision-list-record', ([command, sub], options) => command === 'decisions' && sub === 'record'
    && !(options.choose !== undefined && options.answers === undefined
      && [options.choose].flat().every((entry) => typeof entry === 'string' && CHAT_CHOICE.test(entry)))],
  ['set-aside', ([command], options) => command === 'recover' && options['set-aside'] === true],
  // Without --confirm it is a preview anyone may run.
  ['publication-set-aside', ([command, sub], options) => (command === 'sync' || (command === 'initiative' && sub === 'sync'))
    && options['set-aside'] === true && options.confirm !== undefined],
  ['workflow-delete', ([command, sub], options) => command === 'workflow' && sub === 'delete' && options.confirm !== undefined],
  ['target-origin-pin', ([command, sub], options) => command === 'story' && sub === 'target-origin' && options.confirm !== undefined],
  ['intent-amendment-decision', ([command, sub, verb]) => command === 'story' && sub === 'intent-amendment' && verb === 'decide'],
  ['knowledge-confirmation', ([command, sub, verb]) => command === 'wm'
    && ((sub === 'rules' && verb === 'confirm') || (sub === 'knowledge' && ['confirm', 'correct', 'reject'].includes(verb)))],
  ['spec-drift-decision', ([command, sub, verb]) => command === 'spec' && sub === 'drift' && verb === 'decide'],
  // The /sf-decide turn admitted it, then its live-terminal review refused the agent's shell (2026-10-28).
  ['plan-correction', planRowCorrectionStep],
  ['live-terminal-review', liveTerminalReviewStep],
  // Approving with --confirm-evidence also records the step's planned screenshots and inspections as
  // witnessed: a sign-off on evidence, like decision witness. A chat approval's receipt never bound
  // that list, and its Copilot route dropped the flag and looped (2026-10-29).
  ['approval-evidence-confirmation', ([command], options) => command === 'approve' && options['confirm-evidence'] === true],
  // `upstream-issue decide` for the bound Story is a /sf-decide turn's own; an amendment is not.
  ['upstream-amendment-decision', ([command, sub]) => command === 'upstream-issue' && ['decide-amendment', 'revalidate'].includes(sub)],
  ['environment-binding', ([command, sub]) => command === 'env' && ['bind', 'unbind'].includes(sub)]
].map(([id, matches]) => Object.freeze({ id, matches })));

/** The id of the own-terminal step this command line is, or null. */
export function ownTerminalStep(commandLine) {
  const parsed = commandLineHead(commandLine);
  if (!parsed) return null;
  const { positionals, options } = parseArgs([...parsed.arguments]);
  const words = [parsed.command, ...positionals];
  return OWN_TERMINAL_STEPS.find((step) => step.matches(words, options))?.id ?? null;
}

function exactRoute(routeEntry, commandArguments) {
  if (!routeEntry) return null;
  const candidates = Object.entries(routeEntry.subcommands)
    .map(([commandPrefix, skill]) => ({
      commandPrefix,
      skill,
      tokens: commandPrefix.split(/\s+/u).filter(Boolean)
    }))
    .sort((left, right) => right.tokens.length - left.tokens.length
      || left.commandPrefix.localeCompare(right.commandPrefix));
  return candidates.find(({ tokens }) => tokens.every(
    (token, index) => commandArguments[index] === token
  )) ?? null;
}

/**
 * Previewing a set-aside is a read any turn runs where it is named; /sf-next and /sf-initiative-next
 * only sync, so routing it there sent a lost race straight back into the same refusal (2026-10-29).
 */
function setAsidePreview(parsed) {
  return (parsed.command === 'sync' || (parsed.command === 'initiative' && parsed.arguments[0] === 'sync'))
    && parsed.arguments.includes('--set-aside');
}

/** Resolve one complete CLI invocation to the packaged skill that owns the same command family. */
export function skillForCommandLine(commandLine) {
  const parsed = commandLineHead(commandLine);
  if (!parsed) return null;
  // The operand is an ID no fixed prefix can name: `sync <INTENT-ID>` retries one saved push.
  if (parsed.command === 'sync' && isTransportIntentId(parsed.arguments[0])) return 'sf-push';
  if (ownTerminalStep(commandLine)) return null;
  if (setAsidePreview(parsed)) return null;
  const exact = COMMAND_LINE_SKILL_ROUTES[parsed.command];
  const match = exactRoute(exact, parsed.arguments);
  if (match?.skill === null) return null;
  return match?.skill ?? exact?.defaultSkill ?? primarySkillForCommand(parsed.command);
}

/**
 * True when an exact route names no skill (`null` above), the line is a person's own terminal step
 * or a set-aside preview: a registered command that no packaged skill carries out, so every surface
 * says it has no verified Copilot equivalent. Without the preview here, every refusal plan dropped
 * the set-aside it named.
 */
export function commandLineWithoutSkill(commandLine) {
  const parsed = commandLineHead(commandLine);
  return Boolean(parsed) && (ownTerminalStep(commandLine) !== null || setAsidePreview(parsed)
    || exactRoute(COMMAND_LINE_SKILL_ROUTES[parsed.command], parsed.arguments)?.skill === null);
}

export function skillsForCommand(name) {
  const command = canonicalCommand(name);
  return COMMAND_SKILLS[command] ?? Object.freeze([]);
}

export function primarySkillForCommand(name) {
  return skillsForCommand(name)[0] ?? null;
}

/** Markdown inserted into HELP.md at load time, from the same catalog command pages use. */
export function renderCommandSkillTable() {
  const rows = COMMAND_REGISTRY.map(({ name }) => {
    const skills = skillsForCommand(name).map((skill) => `\`/${skill}\``).join(', ');
    return `| \`singularity-flow ${name}\` | ${skills} |`;
  });
  return [
    '| Terminal command | Copilot skill |',
    '|---|---|',
    ...rows
  ].join('\n');
}

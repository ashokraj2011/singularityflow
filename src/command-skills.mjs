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

const entries = {
  specify: ['sf-specify'],
  plan: ['sf-plan'],
  implement: ['sf-implement'],
  verify: ['sf-verify'],
  converge: ['sf-converge'],
  about: ['sf-about'],
  help: ['sf-help'],
  explain: ['sf-docs'],
  show: ['sf-show'],
  harness: ['sf-harness'],
  init: ['sf-init'],
  precheck: ['sf-ready', 'sf-init'],
  onboard: ['sf-init'],
  authority: ['sf-init'],
  cache: ['sf-doctor'],
  'factory-reset': ['sf-factory-reset'],
  'reset-all': ['sf-reset-all'],
  'local-reset': ['sf-local-reset'],
  local: ['sf-local'],
  'fresh-install': ['sf-fresh-install'],
  reinstall: ['sf-reinstall'],
  repositories: ['sf-repositories'],
  choices: ['sf-start', 'sf-approve'],
  start: ['sf-start'],
  resume: ['sf-resume'],
  return: ['sf-return'],
  agent: ['sf-agent'],
  session: ['sf-session'],
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
  auto: ['sf-auto'],
  adhoc: ['sf-adhoc'],
  land: ['sf-adhoc'],
  intent: ['sf-sgos', 'sf-sgos-create'],
  program: ['sf-sgos'],
  process: ['sf-sgos'],
  policy: ['sf-sgos'],
  task: ['sf-sgos'],
  request: ['sf-sgos'],
  evidence: ['sf-sgos'],
  candidate: ['sf-sgos'],
  'execution-unit': ['sf-sgos'],
  device: ['sf-sgos'],
  'authority-store': ['sf-sgos'],
  pack: ['sf-sgos'],
  learn: ['sf-learn'],
  memory: ['sf-sgos'],
  'meta-tool': ['sf-sgos'],
  home: ['sf-home'],
  recommend: ['sf-recommend'],
  logs: ['sf-logs'],
  doctor: ['sf-doctor'],
  review: ['sf-review'],
  workflow: ['sf-workflows'],
  assign: ['sf-assign'],
  watch: ['sf-watch'],
  recover: ['sf-recover'],
  nextsteps: ['sf-nextsteps'],
  action: ['sf-continue'],
  inputs: ['sf-inputs'],
  spec: ['sf-spec'],
  agents: ['sf-agents'],
  mcp: ['sf-mcp'],
  visual: ['sf-visual'],
  documents: ['sf-documents', 'sf-upload'],
  prepare: ['sf-phase', 'sf-code', 'sf-specify', 'sf-plan', 'sf-implement', 'sf-converge', 'sf-verify'],
  phase: ['sf-phase', 'sf-code', 'sf-specify', 'sf-plan', 'sf-implement', 'sf-converge', 'sf-verify'],
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
  reopen: ['sf-reject'],
  cancel: ['sf-cancel'],
  sync: ['sf-next'],
  ledger: ['sf-ledger'],
  capabilities: ['sf-capabilities', 'sf-capability-doctor'],
  state: ['sf-admin'],
  validate: ['sf-doctor'],
  gate: ['sf-gate'],
  wm: ['sf-worldmodel', 'sf-show-prompt'],
  architecture: ['sf-architecture'],
  revision: ['sf-revision-attachments'],
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
    'sf-story-checks', 'sf-work-interval', 'sf-return', 'sf-reject', 'sf-converge', 'sf-submit', 'sf-finalize'
  ],
  workspace: [
    'sf-workspace', 'sf-workspace-bootstrap', 'sf-workspaces', 'sf-workspace-session',
    'sf-workspace-impact', 'sf-admin'
  ],
  copilot: ['sf-workspace-session'],
  knowledge: ['sf-knowledge'],
  capability: [
    'sf-capability-map', 'sf-capabilities', 'sf-capability-doctor',
    'sf-capability-add', 'sf-capability-protect', 'sf-capability-depend'
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
  choices: route('sf-start', {
    'begin start': 'sf-start',
    'begin approve': 'sf-approve'
  }),
  fault: route('sf-fault'),
  phase: route('sf-phase'),
  prepare: route('sf-phase'),
  documents: route('sf-documents', {
    upload: 'sf-upload',
    add: 'sf-upload'
  }),
  pr: route('sf-pr'),
  delivery: route('sf-inspect'),
  capabilities: route('sf-capabilities', {
    doctor: 'sf-capability-doctor'
  }),
  wm: route('sf-worldmodel', {
    'show-prompt': 'sf-show-prompt'
  }),
  capability: route('sf-capability-map', {
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
    'intent-amendment': 'sf-reject',
    adjudicate: 'sf-converge',
    converge: 'sf-converge',
    submit: 'sf-submit',
    advance: 'sf-submit',
    finalize: 'sf-finalize'
  }),
  workspace: route('sf-workspace', {
    create: 'sf-workspace-bootstrap',
    prepare: 'sf-workspace-bootstrap',
    bootstrap: 'sf-workspace-bootstrap',
    doctor: 'sf-workspace-bootstrap',
    inspect: 'sf-workspace-bootstrap',
    reinitialize: 'sf-admin',
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

function exactRouteSkill(routeEntry, commandArguments) {
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
  ))?.skill ?? routeEntry.defaultSkill;
}

/** Resolve one complete CLI invocation to the packaged skill that owns the same command family. */
export function skillForCommandLine(commandLine) {
  const parsed = commandLineHead(commandLine);
  if (!parsed) return null;
  const exact = COMMAND_LINE_SKILL_ROUTES[parsed.command];
  return exactRouteSkill(exact, parsed.arguments) ?? primarySkillForCommand(parsed.command);
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

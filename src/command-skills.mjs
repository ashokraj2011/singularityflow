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
  'factory-reset': ['sf-factory-reset'],
  'reset-all': ['sf-reset-all'],
  'local-reset': ['sf-local-reset'],
  'fresh-install': ['sf-fresh-install'],
  reinstall: ['sf-reinstall'],
  choices: ['sf-start', 'sf-approve'],
  start: ['sf-start'],
  resume: ['sf-resume'],
  agent: ['sf-agent'],
  session: ['sf-session'],
  inbox: ['sf-inbox'],
  finalize: ['sf-finalize'],
  status: ['sf-status'],
  approvals: ['sf-approvals'],
  progress: ['sf-progress'],
  report: ['sf-report'],
  impact: ['sf-impact'],
  telemetry: ['sf-telemetry'],
  'prompt-log': ['sf-prompt-log'],
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
  prepare: ['sf-phase', 'sf-specify', 'sf-plan', 'sf-implement', 'sf-converge', 'sf-verify'],
  phase: ['sf-phase', 'sf-specify', 'sf-plan', 'sf-implement', 'sf-converge', 'sf-verify'],
  artifact: ['sf-phase'],
  pr: ['sf-pr', 'sf-stack'],
  stack: ['sf-stack'],
  regression: ['sf-regression-investigate'],
  submit: ['sf-submit'],
  clarification: ['sf-phase'],
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
  jira: ['sf-jira-work', 'sf-jira-status', 'sf-jira-board', 'sf-jira-update', 'sf-jira-initiative'],
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
    'sf-epic-requirements', 'sf-epic-story-draft', 'sf-epic-stories', 'sf-epic-publish',
    'sf-epic-review', 'sf-epic-review-decision', 'sf-epic-merge-plan', 'sf-epic-complete',
    'sf-epic-drift', 'sf-epic-sync', 'sf-epic-journey'
  ],
  story: [
    'sf-inspect', 'sf-story-start', 'sf-story-inbox', 'sf-story-fetch', 'sf-story-branch',
    'sf-story-checks', 'sf-work-interval', 'sf-converge', 'sf-submit', 'sf-finalize'
  ],
  workspace: ['sf-workspace', 'sf-workspace-bootstrap', 'sf-workspaces', 'sf-workspace-session', 'sf-workspace-impact'],
  copilot: ['sf-workspace-session'],
  knowledge: ['sf-knowledge'],
  capability: ['sf-capability-map', 'sf-capabilities', 'sf-capability-doctor'],
  hook: ['sf-hook'],
  bootstrap: ['sf-capability-map', 'sf-quickstart'],
  secrets: ['sf-secrets'],
  quickstart: ['sf-quickstart']
};

export const COMMAND_SKILLS = Object.freeze(Object.fromEntries(
  Object.entries(entries).map(([command, skills]) => [command, Object.freeze([...skills])])
));

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

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  SingularityFlowError,
  optionBoolean,
  optionNumber,
  optionString,
  parseArgs,
  requirePositional,
  table
} from './util.mjs';
import { assertClean, branch, checkout, repoRoot } from './git.mjs';
import {
  approvePhase,
  CONFIG_PATH,
  createWorkflow,
  currentPhase,
  loadConfig,
  loadWorkflow,
  preparePhase,
  registerArtifact,
  rejectPhase,
  saveWorkflow,
  scanArtifacts,
  submitPhase,
  validateId,
  validateWorkflow
} from './state.mjs';
import { getIssue, issueToMarkdown, listFields, listMyIssues } from './jira.mjs';
import { installPlugin, listPlugins, pluginPath, uninstallPlugin } from './plugin.mjs';
import { runGovernanceGate } from './governance.mjs';

const VERSION = '0.4.0';

const HELP = `Singularity Flow ${VERSION}

Personal Copilot skills plus a deterministic Git-native SDLC utility.

Usage:
  singularity-flow init
  singularity-flow start <WORK-ID> [--title TEXT] [--description TEXT] [--base BRANCH] [--jira] [--fetch] [--allow-dirty]
  singularity-flow resume <WORK-ID> [--fetch] [--allow-dirty]
  singularity-flow status [WORK-ID] [--json]
  singularity-flow prepare [PHASE]
  singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
  singularity-flow artifact scan [--phase PHASE]
  singularity-flow submit [--phase PHASE] [--skip-checks]
  singularity-flow approve [--phase PHASE] [--by NAME] [--commit] [--message TEXT] [--yes]
  singularity-flow reject --reason TEXT [--by NAME]
  singularity-flow validate [--strict]
  singularity-flow gate [--terminal]
  singularity-flow jira list [--project KEY] [--type Story] [--limit 25] [--jql JQL] [--json]
  singularity-flow jira pull <WORK-ID> [--json]
  singularity-flow jira show <WORK-ID> [--json]      Alias for jira pull
  singularity-flow jira fields [--query TEXT] [--json]
  singularity-flow plugin install [--force]
  singularity-flow plugin uninstall | list | path

Optional Jira environment:
  JIRA_BASE_URL=https://company.atlassian.net
  JIRA_EMAIL=user@company.com
  JIRA_API_TOKEN=...
  SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD=customfield_12345
  SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD=customfield_10016
  SINGULARITY_FLOW_JIRA_SPRINT_FIELD=customfield_10020
  SINGULARITY_FLOW_JIRA_EXTRA_FIELDS=customfield_10001,customfield_10002

Typical flow:
  singularity-flow start ENG-142
  singularity-flow prepare requirements
  singularity-flow artifact scan
  singularity-flow submit
  singularity-flow approve --yes --commit
`;

function summary(workflow) {
  const active = currentPhase(workflow);
  console.log(`\n${workflow.workItem.id} — ${workflow.workItem.title}`);
  console.log(`Branch: ${workflow.workItem.branch}`);
  console.log(`Status: ${workflow.status}`);
  console.log(`Current phase: ${active ? `${active.id} (${active.status})` : 'complete'}`);
  if (active) {
    console.log(`Owner persona: ${active.owner ?? 'unassigned'}`);
    console.log(`Required artifact: ${active.requiredArtifact?.path ?? 'none'}`);
    console.log(`Registered artifacts: ${active.artifacts.length}`);
  }
}

async function confirm(phase) {
  if (!input.isTTY || !output.isTTY) throw new SingularityFlowError('Approval needs an interactive terminal or the explicit --yes flag.');
  const io = readline.createInterface({ input, output });
  try {
    const answer = await io.question(`Type ${phase.id} to approve ${phase.label}: `);
    return answer.trim() === phase.id;
  } finally {
    io.close();
  }
}

async function initCommand() {
  const root = repoRoot();
  await loadConfig(root, { create: true });
  console.log(`Created or verified ${CONFIG_PATH}`);
}

async function startCommand(positionals, options) {
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  let config = await loadConfig(root);
  validateId(config, id);

  const source = optionBoolean(options, 'jira')
    ? await getIssue(id)
    : {
        type: 'manual',
        id,
        key: null,
        url: null,
        title: optionString(options, 'title', id),
        description: optionString(options, 'description', ''),
        acceptanceCriteria: ''
      };

  if (!optionBoolean(options, 'allow-dirty')) assertClean(root);
  const base = optionString(options, 'base', config.defaultBaseBranch);
  checkout(root, id, { base, fetch: optionBoolean(options, 'fetch') });
  config = await loadConfig(root, { create: true });
  const workflow = await createWorkflow(root, config, {
    id,
    title: optionString(options, 'title', source.title || id),
    source,
    baseBranch: base
  });
  summary(workflow);
  console.log('\nNext in Copilot: /singularity-flow:requirements');
}

async function resumeCommand(positionals, options) {
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  const initialConfig = await loadConfig(root);
  validateId(initialConfig, id);
  if (branch(root) !== id && !optionBoolean(options, 'allow-dirty')) assertClean(root);
  checkout(root, id, { base: initialConfig.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, id);
  summary(workflow);
  const active = currentPhase(workflow);
  if (active) {
    const command = active.id === 'implementation' ? 'implement' : active.id === 'verification' ? 'verify' : active.id;
    console.log(`\nResume in Copilot: /singularity-flow:${command}`);
  }
}

async function statusCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, positionals[1]);
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify(workflow, null, 2));
    return;
  }
  summary(workflow);
  console.log(`\n${table(workflow.phaseOrder.map((id, index) => {
    const phase = workflow.phases[id];
    return { index: index + 1, phase: id, owner: phase.owner ?? '', status: phase.status, artifacts: phase.artifacts.length };
  }), [
    { key: 'index', label: '#' },
    { key: 'phase', label: 'PHASE' },
    { key: 'owner', label: 'OWNER' },
    { key: 'status', label: 'STATUS' },
    { key: 'artifacts', label: 'ARTIFACTS' }
  ])}`);
}

async function prepareCommand(positionals) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  console.log(await preparePhase(root, config, workflow, positionals[1]));
}

async function artifactCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'artifact subcommand');
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const phaseId = optionString(options, 'phase');
  if (subcommand === 'add') {
    const paths = positionals.slice(2);
    if (!paths.length) throw new SingularityFlowError('Provide at least one artifact path.');
    const records = [];
    for (const candidate of paths) records.push(await registerArtifact(root, workflow, candidate, { phaseId, kind: optionString(options, 'kind') }));
    await saveWorkflow(root, config, workflow);
    records.forEach((record) => console.log(`${record.kind}\t${record.path}`));
    return;
  }
  if (subcommand === 'scan') {
    const records = await scanArtifacts(root, config, workflow, phaseId);
    await saveWorkflow(root, config, workflow);
    if (!records.length) console.log('No changed artifacts found.');
    else records.forEach((record) => console.log(`${record.kind}\t${record.path}`));
    return;
  }
  throw new SingularityFlowError(`Unknown artifact subcommand: ${subcommand}`);
}

async function submitCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const phase = await submitPhase(root, config, workflow, {
    phaseId: optionString(options, 'phase'),
    runChecks: !optionBoolean(options, 'skip-checks')
  });
  console.log(`Phase ${phase.id} is awaiting approval with ${phase.artifacts.length} artifact(s).`);
  console.log('Next in Copilot: /singularity-flow:approve');
}

async function approveCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`${workflow.workItem.id} is complete.`);
  if (!optionBoolean(options, 'yes') && !(await confirm(phase))) throw new SingularityFlowError('Approval cancelled.');
  const result = await approvePhase(root, config, workflow, {
    phaseId: optionString(options, 'phase'),
    by: optionString(options, 'by'),
    createCommit: optionBoolean(options, 'commit'),
    message: optionString(options, 'message')
  });
  console.log(`Approved ${result.phase.id} by ${result.approval.approvedBy}.`);
  console.log(result.next ? `Current phase is now ${result.next.id}.` : 'Workflow is complete.');
}

async function rejectCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const phase = await rejectPhase(root, config, workflow, { reason: optionString(options, 'reason'), by: optionString(options, 'by') });
  console.log(`Rejected ${phase.id}; it is back in progress.`);
}

async function validateCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const result = await validateWorkflow(root, config, workflow, { strict: optionBoolean(options, 'strict') });
  result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (!result.valid) throw new SingularityFlowError(`Validation failed:\n- ${result.errors.join('\n- ')}`, { exitCode: 2 });
  console.log('Singularity Flow workflow is valid.');
}

async function gateCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const result = await runGovernanceGate(root, config, workflow, {
    terminal: optionBoolean(options, 'terminal') || process.env.SINGULARITY_FLOW_ENFORCE_TERMINAL === '1'
  });
  result.passes.forEach((message) => console.log(`  ✓ ${message}`));
  result.warnings.forEach((message) => console.warn(`  ~ ${message}`));
  if (result.errors.length) throw new SingularityFlowError(`Governance gate failed:\n- ${result.errors.join('\n- ')}`, { exitCode: 2 });
  console.log('Singularity Flow governance gate passed.');
}

async function jiraCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'Jira subcommand');
  if (subcommand === 'list') {
    const result = await listMyIssues({
      project: optionString(options, 'project'),
      issueType: optionString(options, 'type', 'Story'),
      limit: optionNumber(options, 'limit', 25),
      jql: optionString(options, 'jql')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.issues.length) console.log('No matching Jira work items found.');
    else console.log(table(result.issues.map((issue) => ({ key: issue.key, status: issue.status ?? '', priority: issue.priority ?? '', title: issue.title })), [
      { key: 'key', label: 'KEY' },
      { key: 'status', label: 'STATUS' },
      { key: 'priority', label: 'PRIORITY' },
      { key: 'title', label: 'SUMMARY' }
    ]));
    return;
  }
  if (['pull', 'show', 'get'].includes(subcommand)) {
    const key = requirePositional(positionals, 2, 'Jira work ID');
    const issue = await getIssue(key);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issue, null, 2));
    else console.log(issueToMarkdown(issue));
    return;
  }
  if (subcommand === 'fields') {
    const fields = await listFields({ query: optionString(options, 'query') });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(fields, null, 2));
    else if (!fields.length) console.log('No matching Jira fields found.');
    else console.log(table(fields, [
      { key: 'id', label: 'FIELD ID' },
      { key: 'name', label: 'NAME' },
      { key: 'custom', label: 'CUSTOM' },
      { key: 'type', label: 'TYPE' }
    ]));
    return;
  }
  throw new SingularityFlowError(`Unknown Jira subcommand: ${subcommand}`);
}

async function pluginCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'plugin subcommand');
  if (subcommand === 'install') return installPlugin({ force: optionBoolean(options, 'force') });
  if (subcommand === 'uninstall') return uninstallPlugin();
  if (subcommand === 'list') return listPlugins();
  if (subcommand === 'path') return console.log(pluginPath());
  throw new SingularityFlowError(`Unknown plugin subcommand: ${subcommand}`);
}

export async function main(argv) {
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return console.log(VERSION);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return console.log(HELP);
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0];
  if (!command || command === 'help') return console.log(HELP);
  if (command === 'version') return console.log(VERSION);
  switch (command) {
    case 'init': return initCommand();
    case 'start': return startCommand(positionals, options);
    case 'resume': return resumeCommand(positionals, options);
    case 'status': return statusCommand(positionals, options);
    case 'prepare': return prepareCommand(positionals, options);
    case 'artifact': return artifactCommand(positionals, options);
    case 'submit': return submitCommand(options);
    case 'approve': return approveCommand(options);
    case 'reject': return rejectCommand(options);
    case 'validate': return validateCommand(options);
    case 'gate': return gateCommand(options);
    case 'jira': return jiraCommand(positionals, options);
    case 'plugin': return pluginCommand(positionals, options);
    default: throw new SingularityFlowError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

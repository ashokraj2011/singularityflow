import readline from 'node:readline/promises';
import path from 'node:path';
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
import { assertClean, branch, checkout, identity, repoRoot } from './git.mjs';
import {
  approvePhase,
  commitAndPublish,
  CONFIG_PATH,
  createWorkflow,
  currentPhase,
  loadConfig,
  loadWorkflow,
  preparePhase,
  publishGeneration,
  registerArtifact,
  rejectPhase,
  saveWorkflow,
  scanArtifacts,
  submitPhase,
  syncPublication,
  validateId,
  validateWorkflow
} from './state.mjs';
import { getIssue, issueToMarkdown, listFields, listMyIssues } from './jira.mjs';
import { installPlugin, listPlugins, pluginPath, uninstallPlugin } from './plugin.mjs';
import { runGovernanceGate } from './governance.mjs';
import { worldModelCommand } from './worldmodel.mjs';
import { initializeDefinition, migrateLegacyConfig, resolveWorkType, WORKFLOW_PATH } from './config.mjs';
import { selectPersona, selectWorkType } from './session.mjs';
import { readJson } from './util.mjs';
import { addDocuments, documentCatalog, viewDocument } from './documents.mjs';
import { progressBar, progressSnapshot } from './progress.mjs';
import {
  desktopSnapshot,
  publishDesktopConfiguration,
  saveDesktopFile,
  selectDesktopPersona,
  validateDesktopConfiguration
} from './desktop.mjs';

const VERSION = '0.6.0';

const HELP = `Singularity Flow ${VERSION}

Personal Copilot skills plus a deterministic Git-native SDLC utility.

Usage:
  singularity-flow init
  singularity-flow start <WORK-ID> [--title TEXT] [--description TEXT] [--base BRANCH] [--jira] [--fetch] [--allow-dirty]
  singularity-flow resume <WORK-ID> [--fetch] [--allow-dirty]
  singularity-flow status [WORK-ID] [--json]
  singularity-flow progress [WORK-ID] [--json]
  singularity-flow documents list [WORK-ID] [--json]
  singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID] [--json]
  singularity-flow documents upload <PATH...> [--url URL] [--label TEXT] [--kind KIND]
  singularity-flow prepare [PHASE]
  singularity-flow phase publish [PHASE] [--usage-json FILE]
  singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
  singularity-flow artifact scan [--phase PHASE]
  singularity-flow submit [--phase PHASE] [--skip-checks]
  singularity-flow approve [WORK-ID] [--fetch] [--phase PHASE] [--yes]
  singularity-flow reject [WORK-ID] [--fetch] --reason TEXT [--to PHASE]
  singularity-flow sync
  singularity-flow migrate-config
  singularity-flow validate [--strict]
  singularity-flow gate [--terminal]
  singularity-flow wm init
  singularity-flow wm build [--phase PHASE] [--task TEXT] [--focus TEXT] [--depth quick|standard|deep]
  singularity-flow wm context <PHASE> [--task TEXT] [--concat] [--evidence]
  singularity-flow wm check
  singularity-flow jira list [--project KEY] [--type Story] [--limit 25] [--jql JQL] [--json]
  singularity-flow jira pull <WORK-ID> [--json]
  singularity-flow jira show <WORK-ID> [--json]      Alias for jira pull
  singularity-flow jira fields [--query TEXT] [--json]
  singularity-flow plugin install [--force]
  singularity-flow plugin uninstall | list | path
  singularity-flow desktop snapshot [WORK-ID] --json
  singularity-flow desktop validate --json
  singularity-flow desktop save <PATH>          Reads replacement content from stdin
  singularity-flow desktop publish [--message TEXT] --json
  singularity-flow desktop session <PERSONA> [--work-id ID] --json

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
  singularity-flow prepare intake
  singularity-flow phase publish intake
  singularity-flow submit
  singularity-flow approve --yes
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

function actionActor(root) {
  return process.env.SINGULARITY_FLOW_GITHUB_ACTOR
    ? { name: process.env.SINGULARITY_FLOW_GITHUB_ACTOR, login: process.env.SINGULARITY_FLOW_GITHUB_ACTOR, email: null }
    : identity(root);
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
  const wrote = await initializeDefinition(root);
  await worldModelCommand(root, ['wm', 'init'], {});
  console.log(wrote.length ? `Created ${wrote.join(', ')}` : `Verified ${WORKFLOW_PATH} and repository templates.`);
}

async function startCommand(positionals, options) {
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  const config = await loadConfig(root);
  validateId(config, id);
  const workType = await selectWorkType(config);
  const selectedPersona = await selectPersona(root, config, actionActor(root), id);

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
  const workflow = await createWorkflow(root, config, {
    id,
    title: optionString(options, 'title', source.title || id),
    source,
    baseBranch: base,
    workType,
    persona: selectedPersona.persona,
    resolved: resolveWorkType(config, workType)
  });
  await commitAndPublish(root, config, workflow, `[${id}][init] start ${workType} workflow`);
  summary(workflow);
  console.log('\nNext in Copilot: /singularity-flow:phase');
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
  const session = await selectPersona(root, config, actionActor(root), id);
  summary(workflow);
  console.log(`Active persona: ${session.persona}`);
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
  const selfApprovals = workflow.phaseOrder.flatMap((id) => workflow.phases[id].approvals.filter((item) => !item.invalidatedAt && item.selfApproval).map((item) => `${id}: ${item.actor?.name ?? 'unknown'} as ${item.persona}`));
  if (selfApprovals.length) console.warn(`\nSelf-approval warnings (not independent review):\n- ${selfApprovals.join('\n- ')}`);
}

async function progressCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config, positionals[1]); const progress = progressSnapshot(workflow);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(progress, null, 2));
  console.log(`\n${progress.workId} — ${progress.workType}`);
  console.log(`${progressBar(progress.percentage)} ${progress.percentage}%`);
  console.log(`${progress.approvedPhases} of ${progress.totalPhases} phases approved; current: ${progress.currentPhase ?? 'complete'} (${progress.currentPosition}/${progress.totalPhases})`);
  console.log(`Documents: ${progress.documents}  Tokens: ${progress.tokens.totalTokens || 'unavailable'}`);
  console.log(`\n${table(progress.phases, [
    { key: 'index', label: '#' }, { key: 'id', label: 'PHASE' }, { key: 'status', label: 'STATUS' },
    { key: 'generation', label: 'GEN' }, { key: 'approvals', label: 'APPROVED' }, { key: 'approvalsRequired', label: 'NEEDED' }, { key: 'tokens', label: 'TOKENS' }
  ])}`);
}

async function documentsCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'documents subcommand'); const root = repoRoot(); const config = await loadConfig(root);
  if (subcommand === 'list') {
    const workflow = await loadWorkflow(root, config, positionals[2]); const records = await documentCatalog(root, config, workflow);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(records, null, 2));
    if (!records.length) return console.log('No documents found.');
    return console.log(table(records.map((item) => ({ id: item.id, type: item.type, phase: item.phase ?? '', label: item.label, location: item.url ?? item.path ?? '' })), [
      { key: 'id', label: 'ID' }, { key: 'type', label: 'TYPE' }, { key: 'phase', label: 'PHASE' }, { key: 'label', label: 'LABEL' }, { key: 'location', label: 'LOCATION' }
    ]));
  }
  if (subcommand === 'view') {
    const reference = requirePositional(positionals, 2, 'document ID or path'); const workflow = await loadWorkflow(root, config, optionString(options, 'work-id')); const result = await viewDocument(root, config, workflow, reference);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.record.id} — ${result.record.label}`); console.log(`Type: ${result.record.type}${result.record.mimeType ? ` (${result.record.mimeType})` : ''}`);
    if (result.record.url) console.log(`URL: ${result.record.url}`);
    else console.log(`Path: ${result.absolutePath ?? pathForDisplay(root, result.record.path)}`);
    if (result.binary) console.log('Binary document: use the path above in an image, PDF, Figma, or desktop viewer.');
    else if (result.content != null) process.stdout.write(`\n${result.content}`);
    return;
  }
  if (['upload', 'add'].includes(subcommand)) {
    const workflow = await loadWorkflow(root, config); const records = await addDocuments(root, config, workflow, { files: positionals.slice(2), url: optionString(options, 'url'), label: optionString(options, 'label'), kind: optionString(options, 'kind') });
    const result = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][documents][upload] ${records.map((item) => item.id).join(',')}`);
    records.forEach((record) => console.log(`${record.id}\t${record.type}\t${record.url ?? record.path}`)); console.log(`Committed ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`); return;
  }
  throw new SingularityFlowError(`Unknown documents subcommand: ${subcommand}`);
}

function pathForDisplay(root, relative) { return path.join(root, relative); }

async function prepareCommand(positionals) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  console.log(await preparePhase(root, config, workflow, positionals[1]));
}

async function phaseCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'phase subcommand');
  if (subcommand !== 'publish') throw new SingularityFlowError(`Unknown phase subcommand: ${subcommand}`);
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  const usageFile = optionString(options, 'usage-json'); const usage = usageFile ? await readJson(usageFile) : null;
  const phase = await publishGeneration(root, config, workflow, { phaseId: positionals[2], usage });
  const result = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][generated:${phase.generation}] publish artifacts`, phase.artifacts.map((item) => item.path));
  console.log(`Published ${phase.id} generation ${phase.generation} at ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`);
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
  await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][submit] request approval`, phase.artifacts.map((item) => item.path));
  console.log(`Phase ${phase.id} is awaiting approval with ${phase.artifacts.length} artifact(s).`);
  console.log('Next in Copilot: /singularity-flow:approve');
}

async function decisionWorkflow(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[1];
  let config = await loadConfig(root);
  const workId = requestedId ?? branch(root);
  if (workId !== branch(root) || optionBoolean(options, 'fetch')) checkout(root, workId, { base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
  config = await loadConfig(root); const workflow = await loadWorkflow(root, config, workId);
  const session = await selectPersona(root, config, actionActor(root), workflow.workItem.id);
  return { root, config, workflow, session };
}

async function approveCommand(positionals, options) {
  const { root, config, workflow, session } = await decisionWorkflow(positionals, options);
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`${workflow.workItem.id} is complete.`);
  const selfApproval = (phase.generatedBy?.login ?? phase.generatedBy?.email ?? phase.generatedBy?.name) === (session.actor.login ?? session.actor.email ?? session.actor.name);
  console.log(`\nReviewing ${workflow.workItem.id} / ${phase.id} as ${session.persona}`);
  console.log(`Artifacts: ${phase.artifacts.map((item) => `${item.path} (${item.sha256?.slice(0, 18) ?? 'no hash'})`).join(', ')}`);
  console.log(`Checks: ${phase.checks.map((item) => `${item.command}=${item.status}`).join(', ') || 'none'}`);
  console.log(`Tokens: ${phase.usage.map((item) => item.totalTokens ?? item.status).join(', ') || 'unavailable'}`);
  console.log(`Prior approvals: ${phase.approvals.filter((item) => !item.invalidatedAt).map((item) => `${item.actor?.name ?? 'unknown'} as ${item.persona} (${item.decision})`).join(', ') || 'none'}`);
  if (selfApproval) console.warn('Warning: this identity generated the phase; approval will be recorded as self-approval.');
  if (!optionBoolean(options, 'yes') && !(await confirm(phase))) throw new SingularityFlowError('Approval cancelled.');
  const result = await approvePhase(root, config, workflow, {
    phaseId: optionString(options, 'phase'),
    channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : 'terminal'
  });
  await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][approve] ${result.approval.persona}`, phase.artifacts.map((item) => item.path));
  console.log(`Approved ${result.phase.id} by ${result.approval.approvedBy}.`);
  if (result.approval.selfApproval) console.warn(`Warning: ${result.phase.id} was self-approved; this is not independent review.`);
  console.log(result.next ? `Current phase is now ${result.next.id}.` : 'Workflow is complete.');
}

async function rejectCommand(positionals, options) {
  const { root, config, workflow, session } = await decisionWorkflow(positionals, options); const current = currentPhase(workflow);
  const target = optionString(options, 'to') ?? current.id;
  console.log(`Rejecting ${current.id} to ${target} as ${session.persona}; approvals from ${target} onward will be invalidated.`);
  const phase = await rejectPhase(root, config, workflow, { phaseId: optionString(options, 'phase'), target, reason: optionString(options, 'reason'), channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : 'terminal' });
  await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${current.id}][reject] return to ${phase.id}`);
  console.log(`Rejected ${current.id}; ${phase.id} is now in progress.`);
}

async function syncCommand() {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  const result = await syncPublication(root, config, workflow); console.log(`Pushed ${result.pushed.slice(0, 8)} to ${result.remote}/${result.branch}.`);
}

async function migrateConfigCommand() {
  const root = repoRoot(); const result = await migrateLegacyConfig(root); console.log(result.migrated ? `Migrated configuration to ${result.path}; upgraded ${result.migratedWorkItems} work item(s)${result.movedStateRoot ? ' and moved the previous state root to .singularity/' : ''}.` : result.reason);
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

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function desktopCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'desktop subcommand');
  const root = repoRoot();
  let result;
  if (subcommand === 'snapshot') result = await desktopSnapshot(root, positionals[2]);
  else if (subcommand === 'validate') result = await validateDesktopConfiguration(root);
  else if (subcommand === 'save') result = await saveDesktopFile(root, requirePositional(positionals, 2, 'configuration path'), await stdinText());
  else if (subcommand === 'publish') result = await publishDesktopConfiguration(root, optionString(options, 'message'));
  else if (subcommand === 'session') result = await selectDesktopPersona(root, optionString(options, 'work-id'), requirePositional(positionals, 2, 'persona'));
  else throw new SingularityFlowError(`Unknown desktop subcommand: ${subcommand}`);
  console.log(JSON.stringify(result, null, 2));
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
    case 'progress': return progressCommand(positionals, options);
    case 'documents': return documentsCommand(positionals, options);
    case 'prepare': return prepareCommand(positionals, options);
    case 'phase': return phaseCommand(positionals, options);
    case 'artifact': return artifactCommand(positionals, options);
    case 'submit': return submitCommand(options);
    case 'approve': return approveCommand(positionals, options);
    case 'reject': return rejectCommand(positionals, options);
    case 'sync': return syncCommand();
    case 'migrate-config': return migrateConfigCommand();
    case 'validate': return validateCommand(options);
    case 'gate': return gateCommand(options);
    case 'wm': return worldModelCommand(repoRoot(), positionals, options);
    case 'jira': return jiraCommand(positionals, options);
    case 'plugin': return pluginCommand(positionals, options);
    case 'desktop': return desktopCommand(positionals, options);
    default: throw new SingularityFlowError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

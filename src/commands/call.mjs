/**
 * `call`: a person's own agent folder, run as a user-defined agent (src/user-defined-agents.mjs).
 *
 *   singularity-flow call add <FOLDER> [--name ID] [--label TEXT] [--main FILE] [--output code|document] [--approval-group ID] [--json]
 *   singularity-flow call add <FOLDER> ... --confirm sha256:PLAN [--json]
 *   singularity-flow call add <FOLDER> --replace [...]   (a new copy of an existing agent's folder, same name)
 *   singularity-flow call list [--json]
 *   singularity-flow call show <NAME> [--json]
 *
 * `add` previews; with the plan digest it proposes one reviewed configuration change through
 * Workflow Studio's apply. A Story runs the agent with `start <WORK-ID> --agent <NAME>`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { configurationReadRoot } from '../configuration-read-scope.mjs';
import { gitCommonDir, repoRoot } from '../git.mjs';
import { action, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadDefinition } from '../config.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const USAGE = 'Use: singularity-flow call add <FOLDER> [--name ID] [--main FILE] [--output code|document] [--confirm sha256:PLAN] | call list | call show <NAME>';

const usage = () => { throw new SingularityFlowError(USAGE, { code: 'USER_AGENT_USAGE' }); };
const startCommand = (name) => `singularity-flow start <WORK-ID> --agent ${name}`;

function addArguments(folder, options) {
  return [folder, ...['name', 'label', 'main', 'output', 'approval-group'].flatMap((key) => {
    const value = optionString(options, key);
    return value ? [`--${key}`, value] : [];
  }), ...(optionBoolean(options, 'replace') ? ['--replace'] : [])];
}

const quoteArgument = (value) => (/^[A-Za-z0-9_./:@=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

async function addCommand(folder, options) {
  if (!folder) usage();
  const json = optionBoolean(options, 'json');
  const confirm = optionString(options, 'confirm');
  if (confirm && !DIGEST.test(confirm)) throw new SingularityFlowError('--confirm takes the plan digest the preview printed (sha256:…).', { code: 'USER_AGENT_USAGE' });
  const root = repoRoot();
  const { userDefinedAgentPlan, userDefinedAgentChangeSet, userDefinedPlanLines } = await import('../user-defined-agents.mjs');
  const replace = optionBoolean(options, 'replace');
  const choices = (output) => ({
    name: optionString(options, 'name') ?? null, label: optionString(options, 'label') ?? null,
    main: optionString(options, 'main') ?? null, output, approvalGroup: optionString(options, 'approval-group') ?? null, replace
  });
  let planned = await userDefinedAgentPlan(path.resolve(folder), choices(optionString(options, 'output') ?? 'code'));
  // A replaced folder keeps what its step makes unless --output says otherwise (Studio refuses a change).
  if (replace && !optionString(options, 'output')) {
    const existing = (await readAgents(root)).find((agent) => agent.name === planned.plan.name);
    if (existing?.output && existing.output !== planned.plan.output) planned = await userDefinedAgentPlan(path.resolve(folder), choices(existing.output));
  }
  const { plan } = planned;
  // The step's approvers: the group --approval-group names, else the first, as Workflow Studio's new step.
  const groups = Object.keys((await withApprovedConfigurationRead(root, () => loadDefinition(root), { preferAuthority: true })).approvalAuthorities ?? {});
  const changeSet = userDefinedAgentChangeSet(planned, { approvalGroup: groups[0] ?? null });
  const confirmCommand = `singularity-flow call add ${addArguments(folder, options).map(quoteArgument).join(' ')} --confirm ${plan.planSha256}`;
  if (!confirm) {
    // The same review Workflow Studio's apply gives the change, before anything is proposed.
    const { planStudioChangeSet } = await import('../workflow-studio.mjs');
    const studio = await withApprovedConfigurationRead(root, () => planStudioChangeSet(root, changeSet), { preferAuthority: true });
    const problems = studio.problems.map((entry) => entry.message);
    if (!json) {
      for (const line of userDefinedPlanLines(plan)) console.log(line);
      for (const problem of problems) console.log(`  Problem: ${problem}`);
      if (problems.length) console.log('Nothing can be proposed until these are fixed.');
      else {
        // Proposed by its short code, never the plan digest (confirm-code.mjs).
        const { safeCommandGuidance, commandRouteLines } = await import('../safe-command-guidance.mjs');
        console.log(['Propose it:', ...commandRouteLines(safeCommandGuidance({ command: confirmCommand }) ?? {})].join('\n'));
      }
    }
    emitCommandResult(commandResult({
      operation: { id: 'call.add.preview', classification: 'read' },
      outcome: succeeded('call.add.previewed', { name: plan.name, files: plan.files.length }),
      effects: noEffects(),
      next: problems.length ? [] : [action({ id: 'call.add.confirm', command: confirmCommand, rank: 'NOW', kind: 'review',
        label: plan.replace ? `Propose a new copy of ${plan.label}'s folder under the same name, as one reviewed configuration change.`
          : `Propose ${plan.label}: its folder copied unchanged, plus one agent, step and workflow, as one reviewed configuration change.` })],
      data: { ...plan, problems, warnings: studio.warnings.map((entry) => entry.message), confirmCommand: problems.length ? null : confirmCommand }
    }), { json });
    return;
  }
  if (confirm !== plan.planSha256) {
    throw new SingularityFlowError(`The folder or the choices changed since the preview (${plan.planSha256} now). Preview again and confirm the new plan.`,
      { code: 'USER_AGENT_PLAN_CHANGED', details: { planSha256: plan.planSha256 } });
  }
  // Workflow Studio's own apply: the same review, authority, proposal and saved drafts as Publish.
  const file = path.join(gitCommonDir(root), 'singularity-flow', 'user-defined', `${plan.name}-change-set.json`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(changeSet)}\n`, { mode: 0o600 });
  const legacy = await import('./legacy.mjs');
  const lines = [];
  const original = console.log;
  if (json) console.log = (...args) => lines.push(args.join(' '));
  try { await legacy.run(['workflow', 'studio', 'apply', '--change-set', file, '--propose', ...(json ? ['--json'] : [])]); }
  finally { console.log = original; }
  const proposal = json ? JSON.parse(lines.join('\n')) : null;
  if (!json) console.log(`Once the proposal is activated, start a Story that ${plan.label} runs: ${startCommand(plan.name)}, then /sf-call ${plan.name} in Copilot.`);
  emitCommandResult(commandResult({
    operation: { id: 'call.add', classification: 'mutation' },
    outcome: succeeded('call.add.proposed', { name: plan.name, files: plan.files.length }),
    effects: effects({ filesChanged: true, publicationCreated: true }),
    next: [action({ id: 'call.start', command: startCommand(plan.name), rank: 'SOON', kind: 'workflow',
      label: `Once the proposal is activated, start a Story that ${plan.label} runs.` })],
    data: { name: plan.name, planSha256: plan.planSha256, branch: proposal?.branch ?? null, proposal }
  }), { json });
}

async function readAgents(root) {
  const { listUserDefinedAgents } = await import('../user-defined-agents.mjs');
  return withApprovedConfigurationRead(root, async () => listUserDefinedAgents(await loadDefinition(root), configurationReadRoot(root)), { preferAuthority: true });
}

async function listCommand(options) {
  const json = optionBoolean(options, 'json');
  const agents = await readAgents(repoRoot());
  if (!json) {
    if (!agents.length) console.log('No user-defined agents yet. Add a folder with: singularity-flow call add <FOLDER>');
    for (const agent of agents) {
      console.log(`${agent.label} (${agent.name}): ${agent.files ?? '?'} file(s) in ${agent.folder}/, main ${agent.main ?? 'unknown'}${agent.manifest === 'matches' ? '' : ` — folder ${agent.manifest}`}`);
      console.log(`  Start: ${startCommand(agent.name)}`);
    }
  }
  emitCommandResult(commandResult({
    operation: { id: 'call.list', classification: 'read' },
    outcome: succeeded('call.listed', { count: agents.length }), effects: noEffects(),
    next: agents.length ? [] : [action({ id: 'call.add', command: 'singularity-flow call add <FOLDER>', rank: 'SOON', kind: 'workflow',
      label: 'Add a folder with a main agent and the skills it uses.' })],
    data: { agents }
  }), { json });
}

async function showCommand(name, options) {
  if (!name) usage();
  const json = optionBoolean(options, 'json');
  const agent = (await readAgents(repoRoot())).find((entry) => entry.name === name);
  if (!agent) throw new SingularityFlowError(`No user-defined agent is called '${name}'. List them with: singularity-flow call list`, { code: 'USER_AGENT_UNKNOWN' });
  if (!json) {
    console.log(`${agent.label} (${agent.name}): ${agent.description ?? ''}`);
    console.log(`  Folder: ${agent.folder}/ (${agent.files ?? '?'} files, main ${agent.main ?? 'unknown'}${agent.leftOut ? `, ${agent.leftOut} left out when added` : ''})`);
    console.log(`  Runs as step '${agent.step}' of workflow '${agent.workflow}'. Start: ${startCommand(agent.name)}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'call.show', classification: 'read' },
    outcome: succeeded('call.shown', { name }), effects: noEffects(),
    next: [action({ id: 'call.start', command: startCommand(agent.name), rank: 'SOON', kind: 'workflow', label: `Start a Story that ${agent.label} runs.` })],
    data: agent
  }), { json });
}

export async function run(argv, { positionals, options }) {
  const sub = positionals[1];
  if (sub === 'add') return addCommand(positionals[2], options);
  if (sub === 'list' || sub == null) return listCommand(options);
  if (sub === 'show') return showCommand(positionals[2], options);
  return usage();
}

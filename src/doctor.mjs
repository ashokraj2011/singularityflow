import path from 'node:path';
import { existsSync } from 'node:fs';
import { branch, changes, hasRemote, hasUpstream, head } from './git.mjs';
import { loadDefinition, WORKFLOW_PATH } from './config.mjs';
import { loadSession } from './session.mjs';
import { loadWorkflow, pendingPublicationPath, validateWorkflow, workflowPath } from './state.mjs';
import { run } from './util.mjs';
import { copilotTelemetryStatus } from './telemetry.mjs';

function check(id, status, message, fix = null) { return { id, status, message, fix }; }

export async function doctorSnapshot(root, { workId = null, offline = false } = {}) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', major >= 20 ? 'pass' : 'fail', `Node.js ${process.versions.node}`, major >= 20 ? null : 'Install Node.js 20 or newer.'));
  checks.push(check('git', 'pass', `Git repository ${root}`));
  const gitName = run('git', ['config', '--get', 'user.name'], { cwd: root, allowFailure: true }).stdout.trim();
  const gitEmail = run('git', ['config', '--get', 'user.email'], { cwd: root, allowFailure: true }).stdout.trim();
  checks.push(check('git-identity', gitName && gitEmail ? 'pass' : 'fail', gitName && gitEmail ? `Git identity ${gitName} <${gitEmail}>.` : 'Git user.name and/or user.email is missing.', gitName && gitEmail ? null : 'Configure git user.name and git user.email before creating lifecycle commits.'));
  const workflowConfig = path.join(root, WORKFLOW_PATH);
  if (!existsSync(workflowConfig)) {
    checks.push(check('configuration', 'fail', `${WORKFLOW_PATH} is missing.`, 'Run singularity-flow init.'));
    return summarize(root, checks, null, null);
  }
  let definition;
  try {
    definition = await loadDefinition(root);
    checks.push(check('configuration', 'pass', `${WORKFLOW_PATH} is valid (${Object.keys(definition.workTypes).length} workflows, ${Object.keys(definition.personas).length} personas).`));
  } catch (error) {
    checks.push(check('configuration', 'fail', error.message, `Repair ${WORKFLOW_PATH} or restore it from version control.`));
    return summarize(root, checks, null, null);
  }
  const telemetry = await copilotTelemetryStatus(root);
  checks.push(check(
    'copilot-telemetry',
    telemetry.ready ? 'pass' : 'warn',
    telemetry.ready
      ? `Copilot telemetry has ${telemetry.completedChatSpans} completed chat span(s) in the repository exporter.`
      : telemetry.fileConfigured
        ? `Copilot telemetry is configured, but no completed chat span is available yet (${telemetry.bytes} bytes).`
        : 'This process was not started with the repository-scoped Copilot telemetry exporter.',
    telemetry.ready
      ? null
      : telemetry.fileConfigured
        ? 'Finish the current Copilot response, then run singularity-flow telemetry status from the next turn.'
        : 'Fully exit Copilot, open a new terminal in this repository, verify `type copilot`, and start a new session.'
  ));
  const currentBranch = branch(root);
  const requested = workId ?? currentBranch;
  let workflow = null;
  if (existsSync(workflowPath(root, definition, requested))) {
    try {
      workflow = await loadWorkflow(root, definition, requested);
      const validation = await validateWorkflow(root, definition, workflow);
      checks.push(check('workflow-state', validation.valid ? 'pass' : 'fail', validation.valid ? `${requested} state is internally consistent.` : validation.errors.join(' '), validation.valid ? null : `Run singularity-flow recover ${requested} to inspect safe recovery options.`));
      const pending = existsSync(pendingPublicationPath(root, definition, requested));
      checks.push(check('publication', pending ? 'fail' : 'pass', pending ? 'A local lifecycle commit is waiting to be pushed.' : 'No lifecycle publication is pending.', pending ? 'Run singularity-flow sync.' : null));
      const active = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null;
      const assignmentMode = workflow.resolution?.collaboration?.assignmentMode ?? 'off';
      const assigned = active ? workflow.collaboration?.assignments?.[active.id] : null;
      if (active && assignmentMode !== 'off') checks.push(check('assignment', assigned ? 'pass' : assignmentMode === 'required' ? 'fail' : 'warn', assigned ? `${active.id} is assigned to ${assigned.assignee}.` : `${active.id} is unassigned (${assignmentMode}).`, assigned ? null : `Run singularity-flow assign ${active.id} <assignee>.`));
    } catch (error) {
      checks.push(check('workflow-state', 'fail', error.message, `Inspect ${workflowPath(root, definition, requested)} in Git history.`));
    }
  } else checks.push(check('workflow-state', 'skip', `No work item is associated with branch '${currentBranch}'.`, 'Run singularity-flow start <WORK-ID> or resume <WORK-ID>.'));
  const session = await loadSession(root, { required: false });
  if (!workflow) checks.push(check('session', session ? 'warn' : 'skip', session ? `Session selects ${session.persona} for ${session.workId}, but that work item is not open.` : 'No persona session is active.'));
  else if (!session) checks.push(check('session', 'warn', 'No persona is selected for this terminal.', `Run singularity-flow resume ${workflow.workItem.id}.`));
  else if (session.workId !== workflow.workItem.id) checks.push(check('session', 'warn', `Session belongs to ${session.workId}, not ${workflow.workItem.id}.`, `Run singularity-flow resume ${workflow.workItem.id}.`));
  else checks.push(check('session', 'pass', `Persona '${session.persona}' is active for ${session.workId}.`));
  checks.push(check('working-tree', changes(root).trim() ? 'warn' : 'pass', changes(root).trim() ? 'Working tree has uncommitted changes.' : 'Working tree is clean.', changes(root).trim() ? 'Review git status before lifecycle publication.' : null));
  const remote = definition.git?.remote ?? 'origin';
  if (!hasRemote(root, remote)) checks.push(check('remote', definition.git?.publish === 'required' ? 'fail' : 'warn', `Git remote '${remote}' is not configured.`, `Add the '${remote}' remote or set git.publish: off.`));
  else if (offline) checks.push(check('remote', 'skip', `Remote '${remote}' was not contacted in offline mode.`));
  else {
    const probe = run('git', ['ls-remote', '--exit-code', remote, 'HEAD'], { cwd: root, allowFailure: true });
    checks.push(check('remote', probe.status === 0 ? 'pass' : 'fail', probe.status === 0 ? `Remote '${remote}' is reachable.` : `Remote '${remote}' could not be reached.`, probe.status === 0 ? null : 'Restore Git authentication or network access, then run singularity-flow sync.'));
  }
  checks.push(check('upstream', hasUpstream(root) ? 'pass' : 'warn', hasUpstream(root) ? `Branch '${currentBranch}' tracks an upstream.` : `Branch '${currentBranch}' has no upstream.`, hasUpstream(root) ? null : 'The first successful lifecycle publication will establish it.'));
  return summarize(root, checks, workflow, session);
}

function summarize(root, checks, workflow, session) {
  const counts = Object.fromEntries(['pass', 'warn', 'fail', 'skip'].map((status) => [status, checks.filter((item) => item.status === status).length]));
  return { schemaVersion: 1, repository: root, branch: branch(root), head: head(root), workId: workflow?.workItem.id ?? null, persona: session?.persona ?? null, healthy: counts.fail === 0, counts, checks };
}

export function doctorText(report) {
  const icon = { pass: '✓', warn: '!', fail: '✗', skip: '·' };
  const lines = [`Singularity Flow doctor — ${report.healthy ? 'ready' : 'attention required'}`, `Repository: ${report.repository}`, `Branch: ${report.branch}`, ''];
  for (const item of report.checks) {
    lines.push(`${icon[item.status]} ${item.id}: ${item.message}`);
    if (item.fix) lines.push(`  Fix: ${item.fix}`);
  }
  lines.push('', `${report.counts.pass} passed · ${report.counts.warn} warnings · ${report.counts.fail} failures · ${report.counts.skip} skipped`);
  return `${lines.join('\n')}\n`;
}

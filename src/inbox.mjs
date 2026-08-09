import YAML from 'yaml';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import path from 'node:path';
import { fetchRemote, fileAtRef, remoteBranches } from './git.mjs';
import { table } from './util.mjs';
import { buildRepositorySubjectIndexFromRefs } from './repository-subject-index.mjs';

function activeApprovals(phase) {
  return (phase.approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved');
}

function waitingMinutes(submittedAt, now) {
  const submitted = Date.parse(submittedAt ?? '');
  if (!Number.isFinite(submitted)) return null;
  return Math.max(0, Math.floor((now.getTime() - submitted) / 60000));
}

function waitingLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function submittedEvent(workflow, phaseId) {
  return [...(workflow.history ?? [])].reverse().find((item) => item.event === 'phase_submitted' && item.phase === phaseId) ?? null;
}

export async function approvalInbox(root, definition, { fetch = true, now = new Date() } = {}) {
  const remote = definition.git?.remote ?? 'origin';
  if (fetch) fetchRemote(root, remote);
  const items = [];
  const refs = remoteBranches(root, remote).map((branch) => ({ branch, ref: `${remote}/${branch}` }));
  const index = await buildRepositorySubjectIndexFromRefs(root, { definition, refs });
  for (const subject of index.list('story')) {
    try {
      const workflow = subject.state;
      const ref = subject.location.ref;
      validateDefinition(YAML.parse(fileAtRef(root, ref, WORKFLOW_PATH) ?? ''));
      const phaseId = workflow.currentPhase;
      const phase = phaseId ? workflow.phases?.[phaseId] : null;
      if (!phase || phase.status !== 'awaiting_approval') continue;
      const approvals = activeApprovals(phase);
      const required = phase.approvalPolicy?.minimum ?? 1;
      const submitted = submittedEvent(workflow, phaseId);
      const minutes = waitingMinutes(phase.submittedAt, now);
      const workDirectory = path.posix.dirname(subject.location.path);
      items.push({
        id: subject.id,
        title: workflow.workItem?.title ?? subject.id,
        workType: workflow.workItem?.workType ?? 'legacy',
        phase: phaseId,
        phaseLabel: phase.label ?? phaseId,
        generation: phase.generation ?? 0,
        status: phase.status,
        approvalsReceived: approvals.length,
        approvalsRequired: required,
        approvalsRemaining: Math.max(0, required - approvals.length),
        reviewerAuthorities: phase.approvalPolicy?.authorities ?? [],
        submittedAt: phase.submittedAt ?? null,
        submittedBy: submitted?.actor ?? null,
        submittedAgent: submitted?.agent ?? null,
        waitingMinutes: minutes,
        waiting: waitingLabel(minutes),
        artifact: phase.requiredArtifact?.path ? `${workDirectory}/${phase.requiredArtifact.path}` : null,
        selfApprovalWarning: approvals.some((item) => item.selfApproval === true),
        remote,
        commit: subject.location.commit ?? null,
        commands: {
          attach: `singularity-flow session attach ${subject.id}`,
          review: `singularity-flow phase show ${phaseId}`,
          approve: `singularity-flow approve ${phaseId} --work-id ${subject.id} --fetch`,
          reject: `singularity-flow reject ${phaseId} --work-id ${subject.id} --fetch --reason <REASON>`
        }
      });
    } catch { /* Malformed or mismatched remote branches never enter the reviewer inbox. */ }
  }
  items.sort((left, right) => String(left.submittedAt ?? '').localeCompare(String(right.submittedAt ?? '')) || left.id.localeCompare(right.id));
  return { remote, fetched: fetch, generatedAt: now.toISOString(), count: items.length, items };
}

export function approvalInboxText(snapshot) {
  if (!snapshot.items.length) return `Pending approval inbox — ${snapshot.remote}\n\nNo phases are awaiting approval on committed remote work-item branches.\n`;
  const rows = snapshot.items.map((item) => ({
    id: item.id,
    title: item.title,
    phase: item.phase,
    generation: item.generation,
    approvals: `${item.approvalsReceived}/${item.approvalsRequired}`,
    waiting: item.waiting,
    authorities: item.reviewerAuthorities.join(', ') || 'any identified Git contributor',
    commit: item.commit?.slice(0, 8) ?? 'unknown'
  }));
  return `Pending approval inbox — ${snapshot.remote}\n\n${snapshot.count} phase${snapshot.count === 1 ? '' : 's'} awaiting approval, oldest first.\n\n${table(rows, [
    { key: 'id', label: 'WORK/JIRA ID' },
    { key: 'title', label: 'TITLE' },
    { key: 'phase', label: 'PHASE' },
    { key: 'generation', label: 'GEN' },
    { key: 'approvals', label: 'APPROVALS' },
    { key: 'waiting', label: 'WAITING' },
    { key: 'authorities', label: 'AUTHORITY GROUPS' },
    { key: 'commit', label: 'REMOTE COMMIT' }
  ])}\n\nChoose an item in Copilot with /sf-inbox. Run: singularity-flow session attach <WORK/JIRA-ID>.\n`;
}

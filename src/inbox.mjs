import YAML from 'yaml';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { fetchRemote, fileAtRef, refHead, remoteBranches } from './git.mjs';
import { validateId } from './state.mjs';
import { table } from './util.mjs';

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

function remoteWorkflow(root, definition, remote, id) {
  const ref = `${remote}/${id}`;
  const workRoot = String(definition.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '');
  const statePath = `${workRoot}/${id}/workflow.json`;
  const content = fileAtRef(root, ref, statePath);
  if (!content) return null;
  const workflow = JSON.parse(content);
  if (workflow?.workItem?.id !== id || workflow?.workItem?.branch !== id) return null;
  validateDefinition(YAML.parse(fileAtRef(root, ref, WORKFLOW_PATH) ?? ''));
  return { workflow, ref, workRoot };
}

export async function approvalInbox(root, definition, { fetch = true, now = new Date() } = {}) {
  const remote = definition.git?.remote ?? 'origin';
  if (fetch) fetchRemote(root, remote);
  const items = [];
  for (const id of remoteBranches(root, remote)) {
    try { validateId(definition, id); } catch { continue; }
    try {
      const resolved = remoteWorkflow(root, definition, remote, id);
      if (!resolved) continue;
      const { workflow, ref, workRoot } = resolved;
      const phaseId = workflow.currentPhase;
      const phase = phaseId ? workflow.phases?.[phaseId] : null;
      if (!phase || phase.status !== 'awaiting_approval') continue;
      const approvals = activeApprovals(phase);
      const required = phase.approvalPolicy?.minimum ?? 1;
      const submitted = submittedEvent(workflow, phaseId);
      const minutes = waitingMinutes(phase.submittedAt, now);
      items.push({
        id,
        title: workflow.workItem?.title ?? id,
        workType: workflow.workItem?.workType ?? 'legacy',
        phase: phaseId,
        phaseLabel: phase.label ?? phaseId,
        generation: phase.generation ?? 0,
        status: phase.status,
        approvalsReceived: approvals.length,
        approvalsRequired: required,
        approvalsRemaining: Math.max(0, required - approvals.length),
        reviewerPersonas: phase.approvalPolicy?.personas ?? [],
        submittedAt: phase.submittedAt ?? null,
        submittedBy: submitted?.actor ?? null,
        submittedPersona: submitted?.persona ?? null,
        waitingMinutes: minutes,
        waiting: waitingLabel(minutes),
        artifact: phase.requiredArtifact?.path ? `${workRoot}/${id}/${phase.requiredArtifact.path}` : null,
        selfApprovalWarning: approvals.some((item) => item.selfApproval === true),
        remote,
        commit: refHead(root, ref) ?? null,
        commands: {
          attach: `singularity-flow session attach ${id}`,
          review: `singularity-flow phase show ${phaseId}`,
          approve: `singularity-flow approve ${id} --fetch --phase ${phaseId}`,
          reject: `singularity-flow reject ${id} --fetch --reason <REASON>`
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
    personas: item.reviewerPersonas.join(', ') || 'any',
    commit: item.commit?.slice(0, 8) ?? 'unknown'
  }));
  return `Pending approval inbox — ${snapshot.remote}\n\n${snapshot.count} phase${snapshot.count === 1 ? '' : 's'} awaiting approval, oldest first.\n\n${table(rows, [
    { key: 'id', label: 'WORK/JIRA ID' },
    { key: 'title', label: 'TITLE' },
    { key: 'phase', label: 'PHASE' },
    { key: 'generation', label: 'GEN' },
    { key: 'approvals', label: 'APPROVALS' },
    { key: 'waiting', label: 'WAITING' },
    { key: 'personas', label: 'REVIEW PERSONAS' },
    { key: 'commit', label: 'REMOTE COMMIT' }
  ])}\n\nChoose an item with /sflow-inbox, then attach safely with singularity-flow session attach <WORK/JIRA-ID>.\n`;
}

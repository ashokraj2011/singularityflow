export function progressSnapshot(workflow) {
  const total = workflow.phaseOrder.length;
  const phases = workflow.phaseOrder.map((id, index) => {
    const phase = workflow.phases[id];
    const approvals = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved').length;
    return {
      index: index + 1,
      id,
      label: phase.label,
      status: phase.status,
      generation: phase.generation,
      approvals,
      approvalsRequired: phase.approvalPolicy.minimum ?? 1,
      tokens: phase.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
      tokenStatus: phase.usage.some((item) => item.status === 'exact') ? 'exact' : 'unavailable'
    };
  });
  const approved = phases.filter((phase) => phase.status === 'approved').length;
  const percentage = total ? Math.round((approved / total) * 100) : 100;
  return {
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    status: workflow.status,
    currentPhase: workflow.currentPhase,
    currentPosition: workflow.currentPhase ? workflow.phaseOrder.indexOf(workflow.currentPhase) + 1 : total,
    approvedPhases: approved,
    totalPhases: total,
    percentage,
    documents: workflow.documents?.count ?? 0,
    tokens: workflow.usage,
    phases
  };
}

export function progressBar(percentage, width = 30) {
  const filled = Math.round((Math.max(0, Math.min(100, percentage)) / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

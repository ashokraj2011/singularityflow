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

function phaseFlowAppearance(phase) {
  switch (phase.status) {
    case 'approved':
      return { symbol: '✓', description: `APPROVED (${phase.approvals}/${phase.approvalsRequired})` };
    case 'awaiting_approval':
      return { symbol: '◆', description: `AWAITING APPROVAL (${phase.approvals}/${phase.approvalsRequired})` };
    case 'in_progress':
      return { symbol: '▶', description: `IN PROGRESS · generation ${phase.generation}` };
    case 'not_started':
    case 'pending':
      return { symbol: '○', description: 'PENDING' };
    case 'rejected':
      return { symbol: '↺', description: 'RETURNED FOR REWORK' };
    default:
      return { symbol: '!', description: String(phase.status).replaceAll('_', ' ').toUpperCase() };
  }
}

export function progressFlow(progress) {
  if (!progress.phases.length) return '  ✓ Workflow complete';
  const labelWidth = Math.max(...progress.phases.map((phase) => phase.label.length));
  const lines = [];

  for (const [index, phase] of progress.phases.entries()) {
    const appearance = phaseFlowAppearance(phase);
    const current = phase.id === progress.currentPhase ? '  ← CURRENT' : '';
    lines.push(`  ${appearance.symbol} ${phase.label.padEnd(labelWidth)}  ${appearance.description}${current}`);
    if (index < progress.phases.length - 1) lines.push('  │', '  ▼');
  }

  if (!progress.currentPhase && progress.approvedPhases === progress.totalPhases) {
    lines.push('  │', '  ▼', '  ✓ WORKFLOW COMPLETE');
  }
  return lines.join('\n');
}

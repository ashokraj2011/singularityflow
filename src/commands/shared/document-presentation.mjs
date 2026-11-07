/** Labels shared by legacy document views and lists. No authority or byte reads. */
/** The phases a document is offered to, as a reader wants them: "all phases", or the list. */
export function documentPhasesLabel(record, phaseOrder = []) {
  if (!Array.isArray(record.phases)) return 'all phases';
  if (phaseOrder.length && phaseOrder.every((phaseId) => record.phases.includes(phaseId))) return 'all phases';
  return record.phases.join(', ');
}

export function documentTitle(record) {
  return `${record.id} — ${record.name ?? record.label ?? record.id}`;
}

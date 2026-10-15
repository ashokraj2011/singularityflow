/** Authoring capabilities, not a claim that a registry-pinned execution adapter is installed. */
export const WORKFLOW_INTENT_PATTERNS = Object.freeze([
  { id: 'sequence', label: 'Sequential phases', route: 'story-markup', status: 'supported' },
  { id: 'choice', label: 'Recorded-value branches and human choices', route: 'story-markup', status: 'supported' },
  { id: 'test-repair', label: 'Independent test / repair / retest', route: 'story-markup', status: 'supported' },
  { id: 'bounded-loop', label: 'Bounded backward routes with human escalation', route: 'story-markup', status: 'supported', budgetScope: 'per-decision, not a shared global repair counter' },
  { id: 'human-checkpoint', label: 'Authorized human approval checkpoints', route: 'story-markup', status: 'supported' },
  { id: 'parallel', label: 'Parallel work with an explicit join policy', route: 'sgos-reviewed-declaration', status: 'requires-qualified-runtime' },
  { id: 'foreach', label: 'Bounded batch / fan-out work', route: 'sgos-reviewed-declaration', status: 'requires-qualified-runtime' },
  { id: 'subprocess', label: 'Child workflows and cross-repository work', route: 'sgos-reviewed-declaration', status: 'requires-qualified-runtime' },
  { id: 'event-wait', label: 'External events, deadlines and durable waits', route: 'reviewed-runtime-integration', status: 'requires-qualified-runtime' },
  { id: 'compensation', label: 'Rollback / compensating effects', route: 'sgos-reviewed-declaration', status: 'requires-qualified-runtime' }
].map(Object.freeze));

export const WORKFLOW_INTENT_FAMILIES = Object.freeze([
  { id: 'software-change', label: 'Feature / bug fix', patterns: ['sequence', 'human-checkpoint'] },
  { id: 'visual-acceptance', label: 'Screenshot / document acceptance', patterns: ['test-repair', 'bounded-loop', 'human-checkpoint'] },
  { id: 'research-document', label: 'Research / documentation', patterns: ['sequence', 'human-checkpoint'] },
  { id: 'review-audit', label: 'Read-only review / audit', patterns: ['sequence', 'human-checkpoint'] },
  { id: 'migration', label: 'Migration / upgrade', patterns: ['sequence', 'choice', 'compensation'] },
  { id: 'parallel-work', label: 'Parallel specialist work', patterns: ['parallel'] },
  { id: 'multi-repository', label: 'Cross-repository program', patterns: ['subprocess', 'parallel'] },
  { id: 'event-driven', label: 'Event-driven operations', patterns: ['event-wait', 'choice'] },
  { id: 'batch', label: 'Batch / repeated-item work', patterns: ['foreach'] }
].map(Object.freeze));

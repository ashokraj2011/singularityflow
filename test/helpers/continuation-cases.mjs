/** Structural scenarios shared by legacy-output parity and provider-neutral rule tests. */
export function continuationCases() {
  const create = (name, change = () => {}, { code = false, convergence = false } = {}) => {
    const phase = { id: 'team-step', label: 'Team step', status: 'in_progress', generation: 1,
      defaultAgent: 'writer', generatedAgent: 'writer', generationPolicy: { requirement: 'required',
        task: code ? 'code' : 'document', defaultProducer: convergence ? 'deterministic' : 'governed-agent' },
      requiredArtifact: { kind: convergence ? 'convergence-report' : code ? 'implementation-summary' : 'specification', path: 'artifacts/team-step/result.md' },
      approvalPolicy: { authorities: ['reviewers'], minimum: 1 }, artifacts: [], checks: [], approvals: [],
      generationPublications: [{ generation: 1, record: { path: 'context/team-step-gen1.json', sha256: 'sha256:' + 'a'.repeat(64) } }] };
    const workflow = { workItem: { id: 'CONT-1', workType: 'custom', workTypeLabel: 'Custom',
      source: { type: 'manual', key: null, url: null } }, status: 'in_progress', currentPhase: phase.id,
      phaseOrder: [phase.id], phases: { [phase.id]: phase }, history: [],
      resolution: { sourceReview: { mode: 'enforce', phases: [phase.id], reviewerAgent: 'peer' },
        obligationGraph: { nodes: [{ id: phase.id, responsibilities: ['scope'] }] } } };
    const entry = { name, workflow, phase, review: null, draftEvidence: null, explicitProgress: false };
    change(entry); return entry;
  };
  return [
    create('document-unpublished', f => { f.phase.generation = 0; }),
    create('document-published-review-pin'),
    create('document-published-no-review', f => { f.workflow.resolution.sourceReview.mode = 'off'; }),
    create('document-no-approval', f => { f.phase.approvalPolicy.mode = 'none'; f.workflow.resolution.sourceReview.mode = 'off'; }),
    create('review-ready', f => { f.review = { status: 'ready' }; }),
    create('review-missing', f => { f.review = { status: 'missing' }; }),
    create('review-stale', f => { f.review = { status: 'stale', findings: [{ code: 'review-binding-stale' }] }; }),
    create('review-human-disposition', f => { f.review = { status: 'correction-required', findings: [{ code: 'human-disposition-required' }],
      pendingDispositions: [{ id: 'exclusion:SRI-1' }] }; }),
    create('review-author-correction', f => { f.review = { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] }; }),
    create('submitted-review-correction', f => { f.phase.status = 'awaiting_approval'; f.review = { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] }; }),
    create('author-is-reviewer', f => { f.phase.generatedAgent = 'peer'; }),
    create('submitted-author-is-reviewer', f => { f.phase.generatedAgent = 'peer'; f.phase.status = 'awaiting_approval'; }),
    create('amendment-acknowledgement-first', f => { f.phase.generatedAgent = 'peer';
      f.workflow.intentAmendments = [{ id: 'AMD-1', status: 'approved' }]; }),
    create('acknowledged-amendment', f => { f.workflow.intentAmendments = [{ id: 'AMD-1', status: 'approved', acknowledgedAt: '2026-11-01' }]; }),
    create('pending-routing-decision', f => { f.workflow.pendingDecision = { key: 'route-1', label: 'Delivery channel',
      options: [{ id: 'web', label: 'Web' }, { id: 'mobile', label: 'Mobile' }] }; }),
    create('closed', f => { f.workflow.currentPhase = null; f.workflow.status = 'closed'; f.phase.status = 'approved'; }),
    create('cancelled-with-decision', f => { f.workflow.status = 'cancelled'; f.workflow.pendingDecision = { key: 'old-route', label: 'Old', options: [] }; }),
    create('code-generation-not-open', f => { f.phase.generation = 0; }, { code: true }),
    create('code-generation-open', f => { f.phase.generation = 0; f.phase.generationIntent = { generation: 1, status: 'open' }; }, { code: true }),
    create('code-draft-missing', f => { f.phase.generation = 0; f.phase.generationIntent = { generation: 1, status: 'open' };
      f.draftEvidence = { draftExists: false, draftModified: false }; f.explicitProgress = true; }, { code: true }),
    create('code-draft-authored', f => { f.phase.generation = 0; f.phase.generationIntent = { generation: 1, status: 'open' };
      f.draftEvidence = { draftExists: true, draftModified: true }; f.explicitProgress = true; }, { code: true }),
    create('code-consumed-unpublished', f => { f.phase.generation = 0; f.phase.generationIntent = { generation: 1, status: 'consumed' }; }, { code: true }),
    create('code-reviewed-rejection', f => { f.phase.generationIntent = { generation: 1, status: 'consumed' };
      f.phase.rejectedAt = '2026-11-01'; f.workflow.changeRequests = [{ status: 'open', targetPhase: f.phase.id }]; }, { code: true }),
    create('code-source-review-correction', f => { f.phase.generationIntent = { generation: 1, status: 'consumed' };
      f.review = { status: 'correction-required', findings: [{ code: 'reviewer-blocker' }] }; }, { code: true }),
    create('code-skill-amendment', f => { f.phase.generationIntent = { generation: 1, status: 'consumed' };
      f.phase.skillAmendmentRevalidation = { state: 'affected', generationAtAdoption: 1 }; }, { code: true }),
    create('convergence-unpublished', f => { f.phase.generation = 0; }, { convergence: true }),
    create('convergence-no-record', f => { f.phase.generationPublications = []; }, { convergence: true }),
    create('convergence-retained', () => {}, { convergence: true }),
    create('convergence-unsafe-record', f => { f.phase.generationPublications[0].record.path = '../outside.json'; }, { convergence: true }),
    create('convergence-duplicate-record', f => { f.phase.generationPublications.push(structuredClone(f.phase.generationPublications[0])); }, { convergence: true }),
    create('intent-amendment-alternative', f => {
      const scope = structuredClone(f.phase); scope.id = 'business-scope'; scope.status = 'approved';
      f.workflow.phases[scope.id] = scope; f.workflow.phaseOrder.unshift(scope.id);
      f.workflow.resolution.obligationGraph.nodes = [{ id: scope.id, responsibilities: ['scope'] }, { id: f.phase.id, responsibilities: ['implement'] }];
    }, { code: true })
  ];
}

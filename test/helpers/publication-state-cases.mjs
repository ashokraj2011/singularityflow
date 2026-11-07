/** Data-only generation evidence; no actor authentication, tests or storage effects occur here. */
export function publicationStateCases() {
  const make = (name, change = () => {}) => {
    const entry = { name,
      workflow: { workItem: { id: 'GEN-STATE' }, resolution: { codeDelivery: { model: { minimumAssurance: 'unavailable' } } }, history: [] },
      phase: { id: 'custom-phase', generation: 1, status: 'in_progress', generatedBy: 'old-author', generatedAgent: 'old-agent',
        submissionArchitectureDecision: { generation: 1 }, generationCommit: 'old-commit', publicationCommit: 'old-publication',
        submittedAt: 'old-time', claimMaps: { planned: { id: 'retained-plan' }, observed: { id: 'old-observation' } },
        authorship: [{ generation: 1, producer: 'human' }],
        astGates: [{ generation: 1, id: 'old-ast' }], clarifications: [{ generation: 1, id: 'old-clarification' }],
        markers: [{ generation: 1, id: 'old-markers' }], telemetry: [{ generation: 1, id: 'old-telemetry' }],
        agentBriefs: [{ generation: 1, consumerPhase: 'later', id: 'old-brief' }],
        generationPublications: [{ generation: '1', id: 'old-publication' }],
        surgicalReopen: { members: ['summary'], reason: 'Reviewed correction' } },
      targetGeneration: 2, actor: { login: 'author', email: 'author@example.invalid' }, agent: 'phase-author',
      effectiveAuthorship: { producer: 'governed-agent', channel: 'copilot-host', changeOrigins: ['agent-edit'], details: { retained: true } },
      publishedAt: '2026-11-08T10:00:00.000Z', changeSetPath: 'context/code-delivery/custom-phase-gen2-changes.json',
      receiptPath: 'context/code-delivery/custom-phase-gen2.json', workingStateDigest: 'a'.repeat(64), testInputSha256: null,
      codeModelObservation: null, codeModelAssurance: 'unavailable', autoCandidate: null, autoCandidateVerification: null,
      deliveryPreflight: { generationIntentId: 'intent-2', changeSet: { digest: 'sha256:' + 'b'.repeat(64) },
        sourcePaths: ['src/value.js'], deletedSourcePaths: [], configurationPaths: ['package.json'], testPaths: ['test/value.test.js'], supportingTestPaths: [],
        changeClassification: { disposition: 'in-scope' }, sourceBindings: { mode: 'off', required: [], bindings: [] },
        acceptanceCriteria: { required: ['GEN-STATE:AC-001'], tagged: ['GEN-STATE:AC-001'], missing: [], ambiguous: [], bindings: [{ id: 'GEN-STATE:AC-001' }] } },
      astReceipt: { generation: 2, id: 'ast-2' },
      clarification: { path: 'clarifications-gen2.json', sha256: 'c'.repeat(64), record: { promptSha256: 'd'.repeat(64),
        responses: [{ id: 'Q-1' }], recordedAt: 'answer-time', recordedBy: { id: 'human' } } }, answeredMarkers: ['e'.repeat(64)],
      gate: { applies: true, record: { id: 'markers-2' } }, telemetry: { generation: 2, id: 'telemetry-2' },
      agentBriefs: [{ generation: 2, consumerPhase: 'z', id: 'brief-z' }, { generation: 2, consumerPhase: 'a', id: 'brief-a' }],
      catalog: { members: [{ path: 'artifacts/result.md' }] },
      diff: { preserved: [{ path: 'unchanged.md' }], changed: [{ path: 'result.md' }], incidental: [{ member: 'evidence' }] },
      generationPublication: { generation: 2, id: 'publication-2', record: null } };
    change(entry); return entry;
  };
  return [make('ordinary-code'), make('manual-code', f => { f.effectiveAuthorship.producer = 'human'; }),
    make('deterministic-code', f => { f.effectiveAuthorship.producer = 'deterministic'; }),
    make('minimal-optional-state', f => { for (const key of ['authorship', 'astGates', 'clarifications', 'markers', 'telemetry', 'agentBriefs', 'generationPublications', 'surgicalReopen', 'claimMaps']) delete f.phase[key]; }),
    make('replaced-current-generation', f => { f.targetGeneration = 1; f.astReceipt.generation = 1; f.telemetry.generation = 1;
      f.agentBriefs = [{ generation: 1, consumerPhase: 'a', id: 'new-brief' }]; f.generationPublication.generation = 1; }),
    make('no-optional-attestations', f => { f.astReceipt = null; f.clarification = { record: null }; f.gate = { applies: false }; f.agentBriefs = []; }),
    make('test-input-binding', f => { f.testInputSha256 = 'f'.repeat(64); }),
    make('source-bindings', f => { f.deliveryPreflight.sourceBindings = { mode: 'enforce', required: ['GEN-STATE:REQ-001'], bindings: [{ source: 'src/value.js' }] }; }),
    make('all-optional-evidence', f => { Object.assign(f.deliveryPreflight, { documentationCorrection: { phase: 'earlier' }, testingRepair: { config: true },
      fulfillment: [{ id: 'OBL-1' }], implementationBindings: { bound: true }, cornerCaseMatrix: { cells: [] }, excludedChanges: ['docs/outside.md'], testRecovery: { attempts: 1 } });
      Object.assign(f.deliveryPreflight.acceptanceCriteria, { witnesses: [{ id: 'test-1' }], unattachedTags: [{ id: 'unused' }], profiles: [{ framework: 'vitest' }] }); }),
    make('empty-optional-evidence', f => { Object.assign(f.deliveryPreflight, { fulfillment: [], excludedChanges: [] }); }),
    make('auto-candidate', f => { f.autoCandidate = { candidateId: 'C-2', candidateSha256: '1'.repeat(64), attemptId: 'attempt-2' };
      f.autoCandidateVerification = { verificationReceiptSha256: '2'.repeat(64) }; }),
    make('observed-model', f => { f.codeModelObservation = { mappingRevision: 3, provider: 'provider', requestedModel: 'requested', resolvedModel: 'resolved',
      invocationId: 'invocation-2', host: 'copilot-host', source: 'host-trace', observationIntegrity: 'verified-local', observedAt: 'observed-time', generation: 2 };
      f.codeModelAssurance = 'host-observed'; }),
    make('model-policy-default', f => { delete f.workflow.resolution.codeDelivery.model; }),
    make('no-declared-origins', f => { delete f.effectiveAuthorship.changeOrigins; }),
    make('retained-surgical-state', f => { delete f.phase.surgicalReopen; }),
    make('unordered-prior-generations', f => { f.phase.generationPublications = [{ generation: 3, id: 'future' }, { generation: '2', id: 'replace' }, { generation: 1, id: 'past' }]; })];
}

export function observePublicationState(api, input, schemaVersion) {
  const f = structuredClone(input), phase = f.phase;
  api.beginGenerationPublication(phase, { targetGeneration: f.targetGeneration, actor: f.actor, agent: f.agent, producer: f.effectiveAuthorship.producer });
  api.appendGenerationAuthorship(phase, f.effectiveAuthorship, f.publishedAt);
  api.resetGenerationDeliveryBindings(phase);
  const facts = { schemaVersion, changeSetPath: f.changeSetPath, receiptPath: f.receiptPath, workingStateDigest: f.workingStateDigest,
    testInputSha256: f.testInputSha256, effectiveAuthorship: f.effectiveAuthorship, codeModelObservation: f.codeModelObservation,
    codeModelAssurance: f.codeModelAssurance, autoCandidate: f.autoCandidate, autoCandidateVerification: f.autoCandidateVerification, publishedAt: f.publishedAt };
  const receipt = api.codeDeliveryPublicationReceipt(f.workflow, phase, f.deliveryPreflight, facts);
  api.recordCodeDeliveryPublication(phase, f.deliveryPreflight, facts);
  api.recordGenerationAstGate(phase, f.astReceipt);
  api.recordGenerationClarification(phase, f.clarification, f.answeredMarkers);
  api.recordGenerationMarkers(phase, f.gate, f.publishedAt);
  api.recordGenerationTelemetry(phase, f.telemetry);
  api.recordGenerationAgentBriefs(phase, f.agentBriefs);
  api.recordGenerationArtifactSet(phase, f.catalog, f.diff);
  api.recordGenerationPublication(phase, f.generationPublication);
  return { phase, receipt, workflow: f.workflow };
}

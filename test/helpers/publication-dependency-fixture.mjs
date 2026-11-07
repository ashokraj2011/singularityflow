/** Read-only dependency ports for native compatibility tests. No fixture operation reaches I/O. */
import { registerHooks } from 'node:module';
const key = Symbol.for('sflow.test.publication-dependencies');
let sequence = 0;
const target = new URL('../../src/phase-publication-readiness.mjs', import.meta.url).href;
const failure = value => {
  const error = new Error(value.message); if (value.code) error.code = value.code;
  if (value.details) error.details = structuredClone(value.details); return error;
};

export function dependencyFixture() {
  const phase = { id: 'team-draft', generation: 0, status: 'in_progress',
    generationPolicy: { defaultProducer: 'governed-agent', allowedProducers: ['governed-agent','human','external-tool','deterministic'] },
    requiredArtifact: { kind: 'requirements', path: 'artifacts/team-draft/document.md' } };
  return { phase, workflow: { workItem: { id: 'DEPENDENCIES-1' }, currentPhase: phase.id, phases: { [phase.id]: phase }, resolution: {} },
    config: { workItemRoot: 'singularity/work-items' }, options: { producer: 'governed-agent', generation: 1, agent: 'phase-author' },
    values: {
      inspectPendingEvidenceContracts: { paths: [], actions: [] }, assertPhaseRepairSettled: { status: 'ready' },
      assertPhaseAppealsResolved: null, requiredStepActionHold: null,
      collectInputs: { errors: [], warnings: [], records: [] }, inputReadinessFindings: [],
      assertMcpPhaseReadiness: { status: 'not-required' },
      phaseGroundingPreflight: { blockers: [], actions: [], check: { errors: [], warnings: [], record: null }, projection: { status: 'off' } },
      verifyClarificationRecord: { errors: [], warnings: [], record: null, path: null, sha256: null },
      verifyPhaseMcpRequirements: { errors: [] }, inspectDesignSourceReadiness: { errors: [] }, visualCoverageRefusal: { refusal: null }
    }, throws: {} };
}

export function publicationDependencyCases() {
  const cases = [], add = (name, change = () => {}) => { const f = dependencyFixture(); change(f); cases.push({ name, ...f }); };
  add('ready'); add('manual-ready', f => { f.options.producer = 'human'; });
  add('deterministic-ready', f => { f.options.producer = 'deterministic'; });
  add('evidence-contract', f => { f.values.inspectPendingEvidenceContracts.paths = ['context/evidence-contract.json']; });
  add('evidence-contract-action', f => { f.values.inspectPendingEvidenceContracts = { paths: ['context/evidence-contract.json'],
    actions: [{ command: 'singularity-flow appeal prepare --phase team-draft --json', skill: '/sf-appeal', id: 'retained-evidence' }] }; });
  add('evidence-unavailable', f => { f.throws.inspectPendingEvidenceContracts = { message: 'Evidence permission denied.', code: 'EACCES' }; });
  add('repair-loop', f => { f.throws.assertPhaseRepairSettled = { message: 'Repair must be rechecked.', code: 'REPAIR_PENDING', details: { repairLoop: { status: 'pending' } } }; });
  add('repair-quarantine', f => { f.throws.assertPhaseRepairSettled = { message: 'Repair journal is invalid.', code: 'PHASE_REPAIR_JOURNAL_INVALID' }; });
  add('appeal', f => { f.workflow.phaseAppeals = []; f.throws.assertPhaseAppealsResolved = { message: 'Scope appeal needs its owner.' }; });
  add('appeal-decisions', f => { f.workflow.phaseAppealDecisions = []; });
  add('integration', f => { f.values.requiredStepActionHold = { what: 'Delivery remains open', because: 'No retained receipt', nextAction: 'singularity-flow integrations status --json' }; });
  add('inputs', f => { f.values.collectInputs = { errors: ['Approved input is unavailable.'], warnings: ['Optional input is absent.'], records: [] }; });
  add('inputs-owners', f => { f.values.collectInputs = { errors: ['First approved file changed.','Second approved file is absent.'], warnings: [], records: [{}] };
    f.values.inputReadinessFindings = [{ phase: 'scope', path: 'scope.md', status: 'changed', restorable: true }, { phase: 'plan', path: 'plan.md', status: 'missing', restorable: false }]; });
  add('mcp-host', f => { f.throws.assertMcpPhaseReadiness = { message: 'Host needs setup.', code: 'MCP_UNREADY', details: { actions: [
    { command: 'singularity-flow mcp setup --json', label: 'Set up the pinned host' }, { command: 'singularity-flow mcp smoke --json', label: 'Record a smoke check' }] } }; });
  add('grounding', f => { f.values.phaseGroundingPreflight = { blockers: [{ code: 'grounding.missing', category: 'grounding', message: 'Grounding is absent.' }],
    actions: [{ command: 'singularity-flow wm compose --phase team-draft', skill: '/sf-worldmodel' }],
    check: { errors: ['Grounding is absent.'], warnings: ['Grounding observation warning.'], record: null }, projection: { status: 'missing' } }; });
  add('grounding-diagnostics-only', f => { f.values.phaseGroundingPreflight.check.errors = ['Advisory grounding diagnostic.']; });
  add('clarification', f => { f.values.verifyClarificationRecord = { errors: ['Clarification is missing.'], warnings: ['Inspect its binding.'], record: null, path: 'context/clarification.json' }; });
  add('clarification-compose', f => { f.values.verifyClarificationRecord = { errors: ['Compose before recording.'], warnings: [], record: null,
    composition: { command: 'singularity-flow wm compose --phase team-draft' } }; });
  add('manual-invalid-clarification', f => { f.options.producer = 'human'; f.values.verifyClarificationRecord = { errors: ['Saved answer is stale.'], warnings: [],
    record: { generation: 1, responses: [{ question: 'Scope?', answer: 'Confirmed.' }] }, path: 'context/clarification.json', sha256: 'a'.repeat(64) }; });
  add('manual-valid-clarification', f => { f.options.producer = 'human'; f.values.verifyClarificationRecord = { errors: [], warnings: [],
    record: { generation: 1, responses: [{ question: 'Scope?', answer: 'Confirmed.' }] }, path: 'context/clarification.json', sha256: 'a'.repeat(64) }; });
  add('mcp-evidence', f => { f.values.verifyPhaseMcpRequirements = { errors: ['Exact MCP receipt is missing.'], sourceCode: 'MCP_RECEIPT_MISSING' }; });
  add('design-source', f => { f.workflow.resolution.designSources = { capturePhase: f.phase.id }; f.values.inspectDesignSourceReadiness = {
    errors: ['Design source is ambiguous.'], code: 'DESIGN_SOURCE_AMBIGUOUS', message: 'Select the exact source.',
    routes: [{ label: 'Select a source', command: 'singularity-flow mcp design-sources status --json', skill: '/sf-mcp' }] }; });
  add('design-other-phase', f => { f.workflow.resolution.designSources = { capturePhase: 'other-phase' }; });
  add('visual', f => { f.phase.requiredArtifact.kind = 'visual-test-evidence'; f.values.visualCoverageRefusal = { refusal: { message: 'A profile is uncovered.', details: {
    errors: ['A profile is uncovered.'], uncovered: ['desktop'], covered: [], recoveryCommands: [
      { command: 'singularity-flow visual status --json', label: 'Inspect profiles' }, { command: 'singularity-flow visual capture --json', label: 'Capture current evidence' }] } } }; });
  add('several-failures', f => { f.values.inspectPendingEvidenceContracts.paths = ['context/evidence-contract.json'];
    f.throws.assertPhaseRepairSettled = { message: 'Repair remains pending.' }; f.values.collectInputs.errors = ['Input is stale.'];
    f.values.verifyClarificationRecord.errors = ['Answer is required.']; f.values.verifyPhaseMcpRequirements.errors = ['MCP receipt is required.']; });
  add('published-generation', f => { delete f.options.generation; f.phase.generation = 4; f.phase.status = 'awaiting_approval'; });
  return cases;
}

/** Only the native observer's declared ports are intercepted; new undeclared I/O fails closed. */
export async function capturePublicationDependencies(input) {
  const f = structuredClone(input), calls = [], token = String(++sequence);
  const map = globalThis[key] ??= new Map();
  map.set(token, { invoke(name, args) {
    calls.push(name);
    if (f.throws[name]) throw failure(f.throws[name]);
    if (name === 'upstreamChangeRoutes') return { routes: [{ phase: args[1], kind: 'upstream-owner' }], notes: [`Owned by ${args[1]}.`] };
    return structuredClone(f.values[name]);
  } });
  const modules = {
    './clarifications.mjs': ['verifyClarificationRecord'], './inputs.mjs': ['collectInputs','inputReadinessFindings'],
    './mcp-evidence.mjs': ['verifyPhaseMcpRequirements'], './mcp-readiness.mjs': ['assertMcpPhaseReadiness'],
    './phase-grounding-preflight.mjs': ['phaseGroundingPreflight'], './step-action-receipts.mjs': ['requiredStepActionHold'],
    './draft-evidence-hold.mjs': ['inspectPendingEvidenceContracts'], './upstream-routes.mjs': ['upstreamChangeRoutes'],
    './phase-repair-journal.mjs': ['assertPhaseRepairSettled'], './phase-appeals.mjs': ['assertPhaseAppealsResolved'],
    './design-sources.mjs': ['inspectDesignSourceReadiness'], './visual-coverage.mjs': ['visualCoverageRefusal']
  };
  const virtual = Object.fromEntries(Object.entries(modules).map(([file,names]) => [file, 'data:text/javascript,' + encodeURIComponent(
    names.map(name => `export const ${name}=(...args)=>globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})].get(${JSON.stringify(token)}).invoke(${JSON.stringify(name)},args);`).join('\n')
  )]));
  virtual['./util.mjs'] = 'data:text/javascript,' + encodeURIComponent(`export {SingularityFlowError} from ${JSON.stringify(new URL('../../src/foundation/failures.mjs', import.meta.url).href)};`);
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.split('?')[0] === target) {
      if (Object.hasOwn(virtual, specifier)) return { url: virtual[specifier], shortCircuit: true };
      if (specifier.startsWith('.') && !specifier.startsWith('./kernel/') && !specifier.startsWith('./foundation/')) throw new Error('Undeclared readiness port: ' + specifier);
    }
    return next(specifier, context);
  } });
  try {
    const native = await import(target + '?dependency-fixture=' + token);
    const result = await native.inspectPhasePublicationReadiness('/virtual/checkout', f.config, f.workflow, f.phase, f.options);
    return { result, calls };
  } finally { hooks.deregister(); map.delete(token); if (!map.size) delete globalThis[key]; }
}

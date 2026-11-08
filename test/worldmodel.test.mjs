import test from 'node:test';
import assert from 'node:assert/strict';
import { intentConflictRecovery, phasePromptExecutionContract, renderFinalClarificationGuard } from '../src/worldmodel.mjs';

test('code prompts disclose generation admission before edits and preserve unfinished delivery for custom phases', () => {
  for (const id of ['implementation', 'team-self-heal']) {
    const phase = { id, status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
      generationPolicy: { requirement: 'required', defaultProducer: 'governed-agent',
        allowedProducers: ['governed-agent'], task: 'code' } };
    const workflow = { workItem: { id: 'PROMPT-1' }, currentPhase: id,
      phases: { [id]: phase }, phaseOrder: [id], resolution: { phases: [] } };
    const rendered = () => phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n');
    assert.ok(rendered().includes('Code-edit prerequisite: follow `singularity-flow phase begin ' + id + ' --json`'));
    assert.match(rendered(), /Binding `ready` is not code-edit permission/);
    assert.match(rendered(), /preserve existing implementation and tests on resume/);
    assert.match(rendered(), /implementation summary and Agent brief/);
    assert.match(rendered(), /exact planned source\/test paths/);
    assert.match(rendered(), /manual test command does not publish/);
    phase.generationHighWatermark = 2;
    phase.generationIntent = { status: 'open', generation: 3 };
    assert.match(rendered(), /exact generation is open/);
    assert.doesNotMatch(rendered(), /Code-edit prerequisite: follow/);
    phase.generationIntent.status = 'consumed';
    assert.match(rendered(), new RegExp(`recover PROMPT-1 --phase ${id} --json`));
  }
});

test('phase prompts bind deterministic convergence to its exact publication and clarification contract', () => {
  const phase = {
    id: 'convergence',
    generationPolicy: {
      requirement: 'required',
      defaultProducer: 'deterministic',
      allowedProducers: ['deterministic'],
      producer: 'deterministic',
      task: 'analyze'
    }
  };
  const workflow = {
    resolution: {
      phases: [{ id: 'convergence', clarification: { mode: 'off' } }]
    }
  };
  const definition = {
    phases: { convergence: { generation: phase.generationPolicy, clarification: { mode: 'required' } } }
  };

  const contract = phasePromptExecutionContract(definition, workflow, phase);
  assert.equal(contract.deterministicOnly, true);
  assert.deepEqual(contract.publication, {
    producer: 'deterministic',
    channel: 'kernel-generator',
    allowedProducers: ['deterministic'],
    command: 'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator'
  });
  assert.equal(contract.clarification.mode, 'off');
  assert.equal(
    contract.command,
    'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator'
  );
  const rendered = contract.lines.join('\n');
  assert.match(rendered, /Default publication producer: `deterministic`/);
  assert.match(rendered, /Allowed publication producers: `deterministic`/);
  assert.match(rendered, /Required publication channel: `kernel-generator`/);
  assert.match(rendered, /Clarification mode: `off`; do not ask phase clarification questions/);
  assert.match(rendered, /pinned mode overrides generic skill, agent, and template guidance/);
  assert.match(rendered, /Exact publication command: `singularity-flow phase publish convergence --authored deterministic --channel kernel-generator`/);
  assert.match(rendered, /do not author or edit the phase artifact with a model, governed agent, or human/i);
});

test('a deterministic code step writes the code and lets prepare build its summary, and records what the approved documents lack as a departure', () => {
  const phase = { id: 'apply-fix', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    requiredArtifact: { kind: 'implementation-summary' },
    generationPolicy: { requirement: 'required', producer: 'deterministic', defaultProducer: 'deterministic',
      allowedProducers: ['deterministic'], task: 'code' } };
  const workflow = { workItem: { id: 'QF-1' }, currentPhase: phase.id, phases: { [phase.id]: phase },
    phaseOrder: [phase.id], resolution: { phases: [] } };
  const contract = phasePromptExecutionContract({ phases: {} }, workflow, phase);
  const rendered = contract.lines.join('\n');
  assert.equal(contract.deterministicOnly, true);
  assert.doesNotMatch(rendered, /implementation summary and Agent brief/u, 'a kernel-built summary is never completed by hand');
  assert.doesNotMatch(rendered, /Run only the deterministic kernel action/u, 'the code is still the agent\'s to write');
  assert.match(rendered, /run `singularity-flow prepare apply-fix`, which rebuilds the summary from what changed/u);
  assert.match(rendered, /never author or edit it by hand/u);
  // A code step's gap in the approved documents is a departure, decided once before approval [CQF:REQ-020].
  assert.match(rendered, /is a departure, not an upstream issue[^\n]*`singularity-flow departure record --kind <kind> --reason <why>`/u);
  assert.doesNotMatch(rendered, /raise it with `singularity-flow upstream-issue raise/u);
  assert.doesNotMatch(rendered, /## Upstream discrepancies/u, 'no heading in an artifact the agent may not edit');
  const guard = renderFinalClarificationGuard(phase.id, { mode: 'off' }, { deterministicOnly: true });
  assert.doesNotMatch(guard, /## Upstream discrepancies|`Assumption:`/u);
  assert.match(guard, /upstream-issue raise --phase <EARLIER>/u);
  assert.match(guard, /this guard grants no authoring authority/u);
  assert.match(renderFinalClarificationGuard(phase.id, { mode: 'off' }), /goes under `## Upstream discrepancies`/u);
  const code = renderFinalClarificationGuard(phase.id, { mode: 'off' }, { deterministicOnly: true, codeStep: true });
  assert.match(code, /is a departure, recorded with `singularity-flow departure record --kind <kind> --reason <why>`/u);
  assert.doesNotMatch(code, /upstream-issue raise|## Upstream discrepancies/u);
});

test('a scope step is asked for scenario and verification tables only when its template or policy has them', () => {
  const phase = { id: 'triage', status: 'in_progress', generation: 0, requiredArtifact: { kind: 'requirements', path: 'artifacts/triage.md' },
    generationPolicy: { requirement: 'required', producer: 'governed-agent', allowedProducers: ['governed-agent'] } };
  const workflow = { workItem: { id: 'QF-2' }, currentPhase: phase.id, phases: { [phase.id]: phase }, phaseOrder: [phase.id],
    resolution: { phases: [], obligationGraph: { nodes: [{ id: phase.id, responsibilities: ['scope'] }] } } };
  const render = (options) => phasePromptExecutionContract({ phases: {} }, workflow, phase, options).lines.join('\n');
  const short = render({ template: '# Triage\n\n## Acceptance criteria\n\n- TODO\n' });
  assert.doesNotMatch(short, /Scenario coverage: author|author a `## Verification intent` table/u);
  assert.match(short, /Optional tables: this step's template and policy ask for no `## Scenario coverage` or `## Verification intent` section; do not add one/u);
  const spec = render({ template: '# Spec\n\n## Scenario coverage\n\n## Verification intent\n' });
  assert.match(spec, /Scenario coverage: author S-number/u);
  assert.match(spec, /author a `## Verification intent` table/u);
  assert.doesNotMatch(spec, /Optional tables/u);
  phase.specificationQuality = { mode: 'enforce', scenarioCoverage: 'required' };
  assert.match(render({ template: '# Spec\n' }), /Scenario coverage: author S-number/u, 'a required table is asked for');
  delete phase.specificationQuality;
  assert.match(render(), /Scenario coverage: author S-number/u, 'an unknown template keeps the full contract');
  // The scope review is bounded; the whole inventory has a read-only route.
  assert.match(short, /read the whole inventory with `singularity-flow evidence scope QF-2 --json`/u);
  assert.match(short, /\[scope:<ITEM-ID>\]/u);
});

test('the pinned source names only the intent-conflict route its own workflow accepts', () => {
  const story = (ids, scopeId) => ({ workItem: { id: 'IC-1' }, phaseOrder: ids,
    phases: Object.fromEntries(ids.map((id) => [id, { id, ...(id === scopeId ? { requiredArtifact: { path: 'artifacts/scope.md' } } : {}) }])),
    resolution: { phases: [], obligationGraph: { nodes: ids.map((id) => ({ id, responsibilities: id === scopeId ? ['scope'] : [] })) } } });
  const scoped = story(['shape', 'build'], 'shape');
  const later = intentConflictRecovery({}, scoped, scoped.phases.build);
  assert.match(later, /propose it from this step with `singularity-flow story intent-amendment propose --file <FILE> --reason "<REASON>"`/u);
  assert.match(later, /approved scope of `shape`/u);
  const own = intentConflictRecovery({}, scoped, scoped.phases.shape);
  assert.match(own, /`shape` is not approved yet: revise\/review the scope draft/u);
  assert.doesNotMatch(own, /clarification/u, 'clarification off: never name a refused clarification record');
  scoped.phases.shape.clarification = { mode: 'when-needed' };
  assert.match(intentConflictRecovery({}, scoped, scoped.phases.shape), /record the human change in clarification and revise\/review/u);
  const flat = story(['fix', 'check'], null);
  const none = intentConflictRecovery({}, flat, flat.phases.check);
  assert.doesNotMatch(none, /intent-amendment propose/u, 'INTENT_AMENDMENT_UNSUPPORTED in a workflow with no scope step');
  assert.match(none, /upstream-issue raise --phase <EARLIER> --about <ID\|SECTION> --problem "<TEXT>" --proposed amend/u);
  for (const text of [later, own, none]) assert.match(text, /Never rewrite this pinned source/u);
});

test('evidence-planning instructions follow ownership for custom agents/phases, not a built-in planner name', () => {
  const phase = { id: 'team-solution', generationPolicy: { requirement: 'required', producer: 'governed-agent', allowedProducers: ['governed-agent'] } };
  const workflow = { workItem: { id: 'TEAM-1' }, phases: { 'team-solution': phase,
    'team-build': { id: 'team-build', generationPolicy: { task: 'code' } } },
    resolution: { phases: [], plannedClaims: { mode: 'required', owners: { 'team-build': phase.id } } } };
  assert.match(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /Fulfillment `evidence`/u);
  assert.match(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /actual `## Verification contracts` table/u);
  workflow.resolution.plannedClaims.owners = {};
  assert.doesNotMatch(phasePromptExecutionContract({ phases: {} }, workflow, phase).lines.join('\n'), /Evidence planning/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { phasePublicationDependencyInspection } from '../src/kernel/phase-admission.mjs';
import { dependencyFixture, publicationDependencyCases, capturePublicationDependencies } from './helpers/publication-dependency-fixture.mjs';

function inspection(change = () => {}) {
  const f = dependencyFixture(); change(f);
  const result = phasePublicationDependencyInspection(f.workflow, f.phase, f.options);
  const observe = (id, fields = {}) => result.observe(id, { binding: result.plan.binding, errors: [], ...fields });
  return { ...f, result, observe };
}
function finishRemaining(f, overrides = {}) {
  for (const check of f.result.plan.checks) {
    if (check.observe && !Object.hasOwn(overrides, check.id)) f.observe(check.id);
  }
  return f.result.finish();
}

test('26 original native readiness results, failure precedence, routes and read sequences retain their exact bytes', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-publication-dependencies/native-v1.json', import.meta.url), 'utf8'));
  for (const [index, entry] of publicationDependencyCases().entries()) {
    const result = await capturePublicationDependencies(entry);
    assert.equal(entry.name, baseline.cases[index].name);
    assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), baseline.cases[index].sha256, entry.name);
  }
});

test('a complete inspection requires every applicable read even when an earlier dependency already blocked', () => {
  const f = inspection();
  f.observe('evidence-contract', { errors: ['An evidence contract is unresolved.'] });
  assert.throws(() => f.result.finish(), error => error.code === 'PHASE_DEPENDENCY_OBSERVATION_INVALID'
    && error.details.missing.includes('inputs') && error.details.missing.includes('clarification'));
  const result = finishRemaining(f, { 'evidence-contract': true });
  assert.equal(result.ready, false); assert.equal(result.checks[0].blocked, true);
  assert.throws(() => f.observe('appeal'), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
});

test('applicability follows pinned structure rather than phase names and cannot be replaced by caller skip flags', () => {
  const f = inspection(f => { f.phase.id = 'custom-screen-check'; f.phase.requiredArtifact.kind = 'visual-test-evidence';
    f.workflow.resolution.designSources = { capturePhase: f.phase.id }; f.workflow.phaseAppealDecisions = []; });
  for (const id of ['appeal','design-source','visual-coverage']) assert.equal(f.result.requires(id), true, id);
  const before = structuredClone(f.workflow);
  assert.throws(() => f.observe('inputs', { skip: true }), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  assert.throws(() => f.result.requires('not-a-gate'), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  assert.equal(finishRemaining(f).ready, true); assert.deepEqual(f.workflow, before);
  const ordinary = inspection();
  for (const id of ['appeal','design-source','visual-coverage']) assert.equal(ordinary.result.requires(id), false);
});

test('clarification is always observed, but only the configured agent route blocks on its errors', () => {
  for (const producer of ['governed-agent','human','external-tool','deterministic','legacy-unspecified']) {
    const f = inspection(f => { f.options.producer = producer; });
    assert.equal(f.result.requires('clarification'), true);
    const check = f.observe('clarification', { errors: ['An answer is stale.'], recordPresent: true });
    assert.equal(check.blocked, producer === 'governed-agent');
    assert.equal(check.retainObservedRecord, producer === 'governed-agent');
    assert.equal(check.warnInvalidRecord, producer !== 'governed-agent');
    assert.equal(finishRemaining(f, { clarification: true }).ready, producer !== 'governed-agent');
  }
  const valid = inspection(f => { f.options.producer = 'human'; });
  assert.equal(valid.observe('clarification', { recordPresent: true }).retainObservedRecord, true);
});

test('grounding retains the existing blocker-count distinction instead of turning diagnostics into new holds', () => {
  const advisory = inspection();
  assert.equal(advisory.observe('grounding', { errors: ['An advisory diagnostic.'], blockerCount: 0 }).blocked, false);
  assert.equal(finishRemaining(advisory, { grounding: true }).ready, true);
  const blocking = inspection();
  assert.equal(blocking.observe('grounding', { errors: [], blockerCount: 1 }).blocked, true);
  assert.equal(finishRemaining(blocking, { grounding: true }).ready, false);
});

test('observations cannot be reused for another Story, phase, generation, producer or agent', () => {
  for (const [key, value] of Object.entries({ workId: 'OTHER', phase: 'other', generation: 2, producer: 'human', agent: 'someone-else' })) {
    const f = inspection();
    assert.throws(() => f.observe('inputs', { binding: { ...f.result.plan.binding, [key]: value } }), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
    assert.throws(() => f.result.finish(), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  }
  const f = inspection(); f.observe('inputs', { errors: ['The approved bytes changed.'] });
  assert.throws(() => f.observe('inputs'), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
});

test('source error codes remain intact, including numeric provider codes, and missing codes use one shared default', () => {
  for (const code of ['EACCES','ETIMEDOUT',-32002,0,'',false]) {
    const f = inspection(), check = f.observe('mcp-host', { errors: ['Native failure.'], sourceCode: code });
    assert.equal(check.code, code); assert.equal(check.blocked, true);
  }
  assert.equal(inspection().observe('mcp-host', { errors: ['Missing host.'] }).code, 'MCP_PHASE_NOT_READY');
});

test('observation data rejects getters and sparse diagnostics without executing caller code', () => {
  let reads = 0;
  const f = inspection(), input = { binding: f.result.plan.binding };
  Object.defineProperty(input, 'errors', { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => f.result.observe('inputs', input), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  const binding = { ...f.result.plan.binding };
  Object.defineProperty(binding, 'workId', { enumerable: true, get() { reads++; return 'OTHER'; } });
  assert.throws(() => f.observe('inputs', { binding }), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  const errors = [];
  Object.defineProperty(errors, '0', { enumerable: true, get() { reads++; return 'failure'; } });
  assert.throws(() => f.observe('inputs', { errors }), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  assert.throws(() => f.observe('inputs', { errors: Array(2) }), { code: 'PHASE_DEPENDENCY_OBSERVATION_INVALID' });
  assert.equal(reads, 0);
});

test('inspection results are immutable semantic data and never claim tests, publication or human approval', () => {
  const f = inspection(), before = structuredClone(f.workflow), result = finishRemaining(f);
  assert.equal(result.ready, true); assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(Object.isFrozen(f.result.plan.binding), true);
  assert.deepEqual(f.workflow, before); assert.equal(f.phase.generation, 0); assert.equal(f.phase.status, 'in_progress');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /singularity-flow|copilot|command|testExecutions|approvedBy|commit/);
});

test('all compiled dependency checks execute with infrastructure refused and an empty PATH', () => {
  const source = `
    import {registerHooks} from 'node:module';
    const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:'))throw new Error(specifier);return next(specifier,context);}});
    const {phasePublicationDependencyInspection}=await import(${JSON.stringify(new URL('../src/kernel/phase-admission.mjs', import.meta.url).href)});
    for(const producer of ['governed-agent','human','deterministic']){
      const phase={id:'custom',requiredArtifact:{kind:'visual-test-evidence'}};
      const workflow={workItem:{id:'PURE-1'},phaseAppeals:[],resolution:{designSources:{capturePhase:'custom'}}};
      const inspection=phasePublicationDependencyInspection(workflow,phase,{producer,generation:1});
      for(const check of inspection.plan.checks)inspection.observe(check.id,{binding:inspection.plan.binding,errors:[]});
      if(!inspection.finish().ready)throw new Error('unexpected hold');
    }
    hooks.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',source], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

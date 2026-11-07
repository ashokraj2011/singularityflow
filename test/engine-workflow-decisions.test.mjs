import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import * as core from '../src/kernel/workflow-decisions.mjs';
import * as native from '../src/workflow-decisions.mjs';
import * as inputs from '../src/kernel/decision-inputs.mjs';
import { workflowDecisionCases } from './helpers/workflow-decision-cases.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const phases = ['scope', 'plan', 'write', 'validate', 'finish'].map(id => ({ id, label: id.toUpperCase(),
  inputs: [], approval: { mode: 'required', authorities: ['reviewers'] },
  generationPolicy: { task: id === 'write' ? 'code' : 'document' } }));
const branch = { id: 'channel', label: 'Channel', after: 'scope', kind: 'branch',
  inputs: [{ name: 'channel', values: ['Web', 'Mobile'] }], routes: [
    { id: 'web', label: 'Web', when: { channel: 'Web' }, to: 'next' },
    { id: 'mobile', label: 'Mobile', to: 'validate' }] };
const loop = { id: 'until-valid', label: 'Until valid', after: 'validate', kind: 'loop',
  inputs: [{ name: 'valid', values: ['yes', 'no'] }], goal: { valid: 'yes' }, back: 'write', maxRounds: 2,
  enforceConditions: true };
function fixture(definitions = [branch, loop]) {
  const decisions = core.normalizeDecisions(definitions, { phases, approvalAuthorities: { reviewers: {} } });
  return { workItem: { id: 'ROUTING-2' }, currentPhase: 'validate', phaseOrder: phases.map(p => p.id),
    phases: Object.fromEntries(phases.map(p => [p.id, { ...structuredClone(p), status: 'in_progress', generation: 1 }])),
    resolution: { decisions }, decisionRounds: {} };
}

test('24 moved compiler/interpreter functions and every unchanged compatibility alias preserve their original bodies', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-workflow-decisions/native-v1.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/kernel/workflow-decisions.mjs', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('workflow-decisions.mjs', source, ts.ScriptTarget.Latest, true);
  for (const [name, expected] of Object.entries(baseline.functions)) {
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, name); assert.equal(sha256(declaration.body.getText(ast)), expected, name);
    if (name in native) assert.equal(native[name], core[name], name);
  }
  for (const [name, value] of Object.entries(inputs)) assert.equal(value, core[name], name);
});

test('35 native serialized results retain exact output, diagnostics, pending hashes and property ordering', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-workflow-decisions/native-v1.json', import.meta.url), 'utf8'));
  const observed = workflowDecisionCases(native);
  assert.deepEqual(observed.map(entry => entry.name), baseline.cases.map(entry => entry.name));
  for (const [index, value] of observed.entries()) assert.equal(sha256(JSON.stringify(value)), baseline.cases[index].sha256, value.name);
});

test('route selection returns detached predicates while native receipts keep their original rationale text', () => {
  const workflow = fixture(), phase = workflow.phases.scope;
  phase.decisionInputs = { decision: 'channel', values: { channel: 'Web' } };
  const before = structuredClone(workflow), outcome = core.decisionOutcomeFacts(workflow, phase);
  assert.deepEqual(outcome.because, { channel: { in: ['Web'] } });
  assert.equal(outcome.kind, 'next'); assert.equal(outcome.target, 'plan');
  assert.equal(native.decisionOutcome(workflow, phase).because, 'channel is Web');
  assert.deepEqual(workflow, before);
  outcome.because.channel.in.push('Mobile');
  assert.deepEqual(core.decisionAfter(workflow, phase.id).routes[0].when, { channel: { in: ['Web'] } });
});

test('loop limits pause instead of passing, and explicit earlier rework never manufactures a success', () => {
  const workflow = fixture(), phase = workflow.phases.validate;
  phase.decisionInputs = { decision: 'until-valid', values: { valid: 'no' } };
  const first = core.decisionOutcomeFacts(workflow, phase);
  assert.equal(first.kind, 'loop'); assert.equal(first.round, 1); assert.equal(first.because, null);
  assert.deepEqual(first.goal, { valid: { in: ['yes'] } });
  workflow.decisionRounds['until-valid'] = { count: 2 };
  const paused = core.decisionOutcomeFacts(workflow, phase), before = structuredClone(workflow);
  assert.equal(paused.kind, 'pause'); assert.equal(paused.reason, 'limit');
  const payload = core.pendingDecisionPayload(workflow, phase, paused, { at: 'explicit-time' });
  assert.equal(payload.askedAt, 'explicit-time'); assert.equal('key' in payload, false);
  assert.deepEqual(payload.options.map(route => route.id), ['again']);
  assert.deepEqual(core.resolveDecisionChoicePlan(workflow, payload, { to: 'scope' }), {
    route: { id: 'step', label: 'Go to SCOPE', to: 'scope' }, reach: { kind: 'backward', target: 'scope', skipped: [] }
  });
  assert.deepEqual(workflow, before);
  phase.decisionInputs.values.valid = 'yes';
  assert.equal(core.decisionOutcomeFacts(workflow, phase).target, 'finish');
});

test('forged pending options, echoed verdicts and changed targets cannot bypass pinned conditions', () => {
  const workflow = fixture(), phase = workflow.phases.validate;
  phase.decisionInputs = { decision: 'until-valid', values: { valid: 'no' } };
  workflow.decisionRounds['until-valid'] = { count: 2 };
  const pending = core.pendingDecisionPayload(workflow, phase, core.decisionOutcomeFacts(workflow, phase), { at: 'explicit-time' });
  pending.values.valid = 'yes';
  pending.options.push({ id: 'goal-met', label: 'Goal met', to: 'next' });
  pending.options.find(route => route.id === 'again').to = 'next';
  for (const option of ['goal-met', 'again']) assert.throws(() => core.resolveDecisionChoicePlan(workflow, pending, { option }),
    error => error.code === 'DECISION_CONDITION_REQUIRED' && error.details.allowedOption === 'again'
      && !error.message.includes('singularity-flow'));
  assert.equal(phase.decisionInputs.values.valid, 'no');
  assert.equal(core.decisionOutcomeFacts(workflow, phase).kind, 'pause');
});

test('skipped delivery analysis retains earlier completed rounds and offers no caller-controlled applicability bypass', () => {
  const workflow = fixture(), code = workflow.phases.write;
  workflow.resolution.plannedClaims = { mode: 'required', owners: { write: 'plan' }, clausePhases: ['scope'] };
  code.status = 'skipped'; code.generation = 0;
  assert.deepEqual(core.skippedDeliveryObligations(workflow), [{ phase: 'write', reason: "the claims 'plan' planned for it were never implemented" }]);
  assert.equal(core.skippedDeliveryObligations(workflow, { implementationNotApplicable: true }).length, 1);
  code.generation = 1; code.deliveryEvidence = { status: 'ready' };
  assert.deepEqual(core.skippedDeliveryObligations(workflow), []);
});

test('the complete compiler/interpreter imports and executes with all infrastructure and executables refused', () => {
  const url = new URL('../src/kernel/workflow-decisions.mjs', import.meta.url).href;
  const script = `
    import {registerHooks} from 'node:module';
    const blocked=[];const hooks=registerHooks({resolve(specifier,context,next){
      if(specifier.startsWith('node:')){blocked.push(specifier);throw new Error(specifier);}return next(specifier,context);
    }});
    const core=await import(${JSON.stringify(url)});
    const phases=${JSON.stringify(phases)},definitions=${JSON.stringify([branch, loop])};
    const decisions=core.normalizeDecisions(definitions,{phases,approvalAuthorities:{reviewers:{}}});
    const workflow={phaseOrder:phases.map(p=>p.id),phases:Object.fromEntries(phases.map(p=>[p.id,p])),resolution:{decisions}};
    const phase=workflow.phases.scope;phase.decisionInputs={decision:'channel',values:{channel:'Web'}};
    if(core.decisionOutcomeFacts(workflow,phase).target!=='plan')throw new Error('route mismatch');
    if(blocked.length)throw new Error('host imports attempted');hooks.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

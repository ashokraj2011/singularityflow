import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition, resolveWorkType, assertWorkTypeStartable } from '../src/config.mjs';
import { compileObligationGraph, obligationGraphStartable } from '../src/evidence/obligation-compiler.mjs';
import { phaseResponsibilities } from '../src/evidence/responsibilities.mjs';

const human = { mode: 'required', authorities: ['reviewers'], minimum: 1, rejectTo: [] };
const authorities = { reviewers: { label: 'Reviewers' }, owners: { label: 'Owners' } };
const step = (id, extra = {}) => ({ id, writeScope: 'artifact-only', approval: human, ...extra });
const scope = (id) => step(id, { artifact: { kind: 'requirements' } });
const code = (id) => step(id, { generation: { task: 'code' }, writeScope: 'source-and-artifact', artifact: { kind: 'implementation-summary' } });
const evidence = (id) => step(id, { artifact: { kind: 'test-evidence' } });

function feature(extra = {}) {
  return {
    id: 'feature',
    phases: [scope('requirements'), step('plan'), code('build'), evidence('check')],
    plannedClaims: { mode: 'required', clausePhases: ['requirements'], owners: { build: 'plan' } },
    approvalAuthorities: authorities,
    ...extra
  };
}

const codes = (compiled) => compiled.findings.map((entry) => entry.code);

test('a complete route compiles with every responsibility guaranteed at its end', () => {
  const compiled = compileObligationGraph(feature());
  assert.deepEqual(compiled.findings, []);
  assert.equal(obligationGraphStartable(compiled), true);
  assert.deepEqual(compiled.nodes.map((node) => node.responsibilities), [
    ['scope', 'review'], ['plan', 'review'], ['implement', 'verify', 'review'], ['verify', 'review']
  ]);
  assert.deepEqual(compiled.endpoints, [{
    from: 'check', decision: null, route: null,
    guaranteed: ['scope', 'plan', 'implement', 'verify', 'review'], missing: [], omits: []
  }]);
  assert.match(compiled.digest, /^sha256:[0-9a-f]{64}$/);
});

test('a decision that finishes before the code is written drops responsibilities on that route only', () => {
  const decisions = [{
    id: 'stop-early', after: 'requirements', kind: 'ask', anyStep: false,
    routes: [{ id: 'continue', to: 'next' }, { id: 'finish', to: 'end' }]
  }];
  const compiled = compileObligationGraph(feature({ decisions }));
  const finding = compiled.findings.find((entry) => entry.code === 'OBLIGATION_ROUTE_DROPS_RESPONSIBILITY');
  assert.ok(finding);
  assert.deepEqual(finding.subject.missing, ['plan', 'implement', 'verify']);
  assert.equal(finding.subject.route, 'finish');
  assert.match(finding.message, /route 'finish' of decision 'stop-early' after 'requirements' ends the Story without a plan, implementation and verification/);
  assert.equal(obligationGraphStartable(compiled), false);

  // A forward skip past the plan leaves the code step without one on that route.
  const skip = compileObligationGraph(feature({ decisions: [{ id: 'skip', after: 'requirements', kind: 'ask', anyStep: false, routes: [{ id: 'plan-it', to: 'next' }, { id: 'jump', to: 'build' }] }] }));
  assert.ok(codes(skip).includes('OBLIGATION_IMPLEMENT_WITHOUT_PLAN'));

  // An ask that allows any step can end anywhere, so it is checked as every route at once.
  const any = compileObligationGraph(feature({ decisions: [{ id: 'free', after: 'requirements', kind: 'ask', anyStep: true, routes: [] }] }));
  assert.ok(any.findings.some((entry) => entry.subject.route === 'any-step:end'));
});

test('an omission with an authority and a reason lets a route end without that responsibility, and only that one', () => {
  const omitScope = { responsibility: 'scope', reason: 'This workflow demonstrates the lifecycle and defines no requirement clauses.', authority: 'owners' };
  const noScope = { ...feature(), phases: [step('plan', { artifact: { kind: 'delivery-plan' } }), code('build'), evidence('check')], plannedClaims: { mode: 'omitted', clausePhases: [], owners: {} } };
  assert.deepEqual(compileObligationGraph(noScope).findings.map((entry) => entry.subject.missing ?? null).filter(Boolean), [['scope']]);
  const omitted = compileObligationGraph({ ...noScope, omits: [omitScope] });
  assert.deepEqual(omitted.findings, []);
  assert.deepEqual(omitted.endpoints[0].omits, [omitScope]);

  const invalid = compileObligationGraph({ ...noScope, omits: [{ responsibility: 'scope', reason: 'tbd', authority: 'nobody' }] });
  assert.deepEqual(codes(invalid).filter((code) => code === 'OBLIGATION_OMIT_INVALID').length, 2);
  const unnecessary = compileObligationGraph({ ...feature(), omits: [omitScope] });
  assert.deepEqual(codes(unnecessary), ['OBLIGATION_OMIT_UNNECESSARY']);
});

test('evidence must meet a review before the end, and a policy-only review is called out', () => {
  const unreviewed = compileObligationGraph(feature({ phases: [scope('requirements'), step('plan'), code('build'), evidence('check'), step('notes', { approval: 'none' })] }));
  assert.deepEqual(codes(unreviewed), []);
  const lastUnreviewed = compileObligationGraph(feature({ phases: [scope('requirements'), step('plan'), code('build'), evidence('check')].map((entry) => entry.id === 'check' ? { ...entry, approval: 'none' } : entry) }));
  assert.ok(codes(lastUnreviewed).includes('OBLIGATION_VERIFY_WITHOUT_REVIEW'));

  const policy = { mode: 'policy', authorities: ['reviewers'], minimum: 1, rejectTo: [] };
  const automatic = compileObligationGraph(feature({ phases: feature().phases.map((entry) => ({ ...entry, approval: policy })) }));
  assert.deepEqual(codes(automatic), ['OBLIGATION_REVIEW_POLICY_ONLY']);
  assert.equal(obligationGraphStartable(automatic), true, 'a warning never stops a Story starting');
});

test('responsibilities come from structure, so a consistently renamed workflow compiles to the same shape', () => {
  const renamed = {
    ...feature(),
    phases: [scope('scope-it'), step('plan-it'), code('code-it'), evidence('test-it')],
    plannedClaims: { mode: 'required', clausePhases: ['scope-it'], owners: { 'code-it': 'plan-it' } }
  };
  const left = compileObligationGraph(feature());
  const right = compileObligationGraph(renamed);
  assert.equal(left.shapeDigest, right.shapeDigest);
  assert.notEqual(left.digest, right.digest);
  assert.deepEqual(phaseResponsibilities(code('anything')), ['implement', 'verify', 'review']);
  assert.deepEqual(phaseResponsibilities(scope('anything'), { hasCodeStep: false }), ['scope', 'plan', 'review'],
    'a work type with no code step plans its changes where it defines its scope');
});

test('a retired planned-claim opt-out never starts a Story, but the catalog still loads', () => {
  const compiled = compileObligationGraph({ ...feature(), plannedClaims: { mode: 'retired-opt-out', clausePhases: [], owners: {} } });
  assert.ok(codes(compiled).includes('OBLIGATION_OPT_OUT_RETIRED'));
});

test('every packaged work type compiles with no finding, and a failing one is refused at start', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-obligations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  for (const id of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, id);
    assert.deepEqual(resolved.obligationGraph.findings, [], id);
    assert.equal(assertWorkTypeStartable(resolved), resolved);
  }
  assert.equal(resolveWorkType(definition, 'poc-lite').plannedClaims.mode, 'omitted');
  assert.deepEqual(resolveWorkType(definition, 'poc-lite').obligationGraph.endpoints[0].omits.map((entry) => entry.responsibility), ['scope']);
  assert.deepEqual(resolveWorkType(definition, 'quick-fix').obligationGraph.nodes.map((node) => node.id), ['intake', 'implement', 'verify']);

  const broken = structuredClone(definition);
  broken.workTypes.feature.decisions = [{ id: 'stop', after: 'requirements', kind: 'ask', label: 'Stop?', routes: [{ id: 'go', label: 'Go', to: 'next' }, { id: 'stop', label: 'Stop', to: 'end' }] }];
  assert.throws(() => assertWorkTypeStartable(resolveWorkType(broken, 'feature')), (error) => error.code === 'WORKFLOW_OBLIGATIONS_UNMET' || /would never be implemented/.test(error.message));

  // The same early finish, declared: each responsibility it leaves undone, with who decides why.
  const declared = structuredClone(definition);
  declared.workTypes.feature.decisions = [{ id: 'stop', after: 'requirements', kind: 'ask', label: 'Stop?', routes: [
    { id: 'go', label: 'Go', to: 'next' },
    { id: 'stop', label: 'Stop', to: 'end', omits: ['plan', 'implement', 'verify'].map((responsibility) => ({
      responsibility, reason: 'The requested behaviour already exists, so nothing is planned, built or tested.', authority: 'product-approvers' })) }
  ] }];
  const startable = resolveWorkType(declared, 'feature');
  assert.deepEqual(startable.obligationGraph.findings, []);
  assert.equal(assertWorkTypeStartable(startable), startable);
});

test('a route that omits review may let unreviewed evidence reach the end', () => {
  const unreviewed = feature({ phases: [scope('requirements'), step('plan'), code('build'), { ...evidence('check'), approval: 'none' }] });
  assert.ok(codes(compileObligationGraph(unreviewed)).includes('OBLIGATION_VERIFY_WITHOUT_REVIEW'));
  const omitted = compileObligationGraph({ ...unreviewed, omits: [{ responsibility: 'review', reason: 'A disposable fixture whose evidence nobody reviews by design.', authority: 'owners' }] });
  assert.ok(!codes(omitted).includes('OBLIGATION_VERIFY_WITHOUT_REVIEW'));
});

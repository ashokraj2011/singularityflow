/** Original graph and record identities, with local values only. */
import * as graph from '../../src/evidence/obligation-compiler.mjs';
import * as roles from '../../src/evidence/responsibilities.mjs';
import * as records from '../../src/records.mjs';

export const obligationModules = { graph, roles, records };
const approval = { mode: 'required', authorities: ['reviewers'], minimum: 1, rejectTo: [] };
const step = (id, patch = {}) => ({ id, writeScope: 'artifact-only', approval, ...patch });
const feature = patch => ({ id: 'example', approvalAuthorities: { reviewers: {}, owners: {} },
  phases: [step('requirements', { artifact: { kind: 'requirements' } }),
    step('plan', { artifact: { kind: 'delivery-plan' } }),
    step('build', { generation: { task: 'code' }, writeScope: 'source-and-artifact', artifact: { kind: 'implementation-summary' } }),
    step('check', { artifact: { kind: 'test-evidence' } })],
  plannedClaims: { mode: 'required', clausePhases: ['requirements'], owners: { build: 'plan' } }, ...patch });
const omit = responsibility => ({ responsibility, reason: 'This route is limited to a documented inspection with an explicit applicability decision.', authority: 'owners' });
const route = patch => ({ id: 'choose', after: 'requirements', kind: 'ask',
  routes: [{ id: 'continue', to: 'next' }, { id: 'finish', to: 'end' }], ...patch });
const cases = [
  {}, { phases: [] }, feature(), feature({ id: 'renamed-workflow' }),
  feature({ plannedClaims: { mode: 'retired-opt-out', clausePhases: [], owners: {} } }),
  feature({ decisions: [route({})] }), feature({ decisions: [route({ anyStep: true, routes: [] })] }),
  feature({ decisions: [route({ routes: [{ id: 'skip', to: 'build' }] })] }),
  feature({ decisions: [route({ routes: [{ id: 'exit', to: 'end', omits: ['plan', 'implement', 'verify'].map(omit) }] })] }),
  feature({ omits: [omit('scope')] }),
  feature({ omits: [{ responsibility: 'unknown', reason: 'tbd', authority: 'absent' }] }),
  feature({ omits: 'invalid' }), feature({ reworkLoops: [{ from: 'check', to: 'build' }] }),
  feature({ reworkLoops: [{ from: 'not-present', to: 'build' }] }),
  feature({ phases: feature().phases.map(phase => ({ ...phase, approval: { ...approval, mode: 'policy' } })) }),
  feature({ phases: feature().phases.map(phase => phase.id === 'check' ? { ...phase, approval: 'none' } : phase) }),
  feature({ phases: feature().phases.map(phase => phase.id === 'build' ? { ...phase, approval: { ...approval, rejectTo: ['plan'] } } : phase) }),
  feature({ phases: feature().phases.map(phase => ({ ...phase, approvalPolicy: 'none' })) }),
  feature({ phases: [step('documentation', { artifact: { kind: 'requirements' } })], plannedClaims: { mode: 'optional' }, omits: [omit('implement'), omit('verify')] }),
  feature({ phases: feature().phases.slice(1), plannedClaims: { mode: 'omitted', owners: {} }, omits: [omit('scope')] }),
  feature({ phases: feature().phases.map(phase => ({ ...phase, id: 'prefix-' + phase.id })),
    plannedClaims: { mode: 'required', clausePhases: ['prefix-requirements'], owners: { 'prefix-build': 'prefix-plan' } } }),
  feature({ decisions: [{ id: 'first', after: 'requirements', routes: [{ id: 'main', to: 'plan' }, { id: 'bypass', to: 'check' }] },
    { id: 'second', after: 'plan', routes: [{ id: 'main', to: 'build' }, { id: 'back', to: 'requirements' }] }] })
];
export function workflowObligationResults(modules = obligationModules) {
  return cases.map((raw, id) => {
    const input = structuredClone(raw);
    const compiled = modules.graph.compileObligationGraph(input);
    return { id, input, compiled, pinned: modules.graph.pinnedObligationGraph(compiled),
      startable: modules.graph.obligationGraphStartable(compiled), routeGraph: modules.graph.routeGraph(input),
      roles: (input.phases ?? []).map(phase => ({ id: phase.id, review: modules.roles.reviewKind(phase),
        responsibilities: modules.roles.phaseResponsibilities(phase) })) };
  });
}

const values = [
  ['null', () => null], ['empty', () => ({})], ['true', () => true], ['false', () => false],
  ['number', () => 1.25], ['negative-zero', () => -0], ['not-a-number', () => NaN], ['infinity', () => Infinity],
  ['undefined', () => undefined], ['string', () => 'record\n\u0000é'], ['decomposed', () => 'e\u0301'],
  ['surrogate', () => '\ud800'], ['array', () => [3, { z: 2, a: 1 }, null]],
  ['ordered', () => ({ z: 1, a: { y: 2, b: 3 } })], ['numeric-keys', () => ({ 10: 'ten', 2: 'two', a: 'letter' })],
  ['optional-fields', () => ({ z: undefined, a: null, b: false })], ['sparse-array', () => { const value = []; value[2] = 3; return value; }],
  ['date', () => new Date('2000-01-01T00:00:00Z')], ['map', () => new Map([['key', 2]])],
  ['null-prototype', () => Object.assign(Object.create(null), { z: 1, a: 2 })],
  ['prototype-key', () => JSON.parse('{"__proto__":{"x":1},"constructor":"data"}')],
  ['function', () => function example() {}], ['symbol', () => Symbol('example')],
  ['array-undefined', () => [undefined, null]], ['custom-to-json', () => ({ toJSON() { return { z: 1, a: 2 }; } })],
  ['bigint', () => 1n], ['cycle', () => { const value = {}; value.self = value; return value; }]
];
export function recordSerializationResults(module = records) {
  return values.map(([label, create], id) => ({ id, label, outputs: Object.fromEntries(
    ['canonicalJson', 'compactCanonicalJson', 'recordSha256'].map(name => {
      try { return [name, { value: module[name](create()) }]; }
      catch (error) { return [name, { error: { name: error.name, message: error.message, code: error.code ?? null } }]; }
    })) }));
}

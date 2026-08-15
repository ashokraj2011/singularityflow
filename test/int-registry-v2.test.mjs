import test from 'node:test';
import assert from 'node:assert/strict';

import { operationCatalog } from '../src/command-registry.mjs';
import {
  ARGUMENT_SCHEMAS, COMPARISON_SUBJECTS, argumentSchema, hasArgumentSchema, validateArguments
} from '../src/gateway/argument-schemas.mjs';
import { BROAD_GOALS, assertBroadGoal, isBroadGoal } from '../src/gateway/goals.mjs';
import {
  GATEWAY_DECLARATIONS, GATEWAY_PLANNERS, MAX_UNIMPLEMENTED_GATEWAY_PLANNERS,
  gatewayOperation, gatewayRegistry, isGatewayReachable, unimplementedPlanners
} from '../src/gateway/operations.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import {
  GATEWAY_CLASSIFICATIONS, OPERATION_REGISTRY_VERSION, RESULT_CONTRACT,
  compileOperationRegistry, normalizeAlias
} from '../src/gateway/registry.mjs';

const KERNEL = [
  { id: 'kernel.read', classification: 'read', modelPolicy: 'never', externalDependencies: [] },
  { id: 'kernel.write', classification: 'mutation', modelPolicy: 'never', externalDependencies: [] },
  { id: 'kernel.model', classification: 'mutation', modelPolicy: 'required', externalDependencies: ['copilot-cli'] }
];

const PLANNERS = [{ name: 'p-one', run: null }, { name: 'p-two', run: () => null }];

const declaration = (over = {}) => ({
  id: 'sample.read',
  classification: 'read',
  modelPolicy: 'never',
  confirmation: 'none',
  resultContract: RESULT_CONTRACT,
  externalDependencies: [],
  goals: ['work.list'],
  aliases: { en: { version: 1, phrases: ['sample phrase'] } },
  subjects: ['workspace'],
  argumentSchema: 'no-arguments-v1',
  planner: 'p-one',
  noModelFixture: 'sample-read-model-free',
  ...over
});

const compile = (declarations) => compileOperationRegistry({
  declarations, planners: PLANNERS, kernelCatalog: KERNEL
});

const rejects = (declarations, fragment) => assert.throws(
  () => compile(declarations),
  (error) => error.code === 'OPERATION_REGISTRY_INVALID' && error.message.includes(fragment),
  `expected rejection mentioning ${fragment}`
);

test('the shipped registry compiles, and says which version it is', () => {
  const registry = gatewayRegistry();
  assert.equal(registry.registryVersion, OPERATION_REGISTRY_VERSION);
  assert.equal(registry.resultContract, 'sflow-result-v2');
  assert.equal(registry.operations.length, GATEWAY_DECLARATIONS.length);
  assert.match(registry.contentHash, /^[0-9a-f]{64}$/);
});

test('every broad goal has somewhere to land', () => {
  const reachable = new Set(gatewayRegistry().operations.flatMap((entry) => entry.gateway.goals));
  for (const goal of BROAD_GOALS) assert.ok(reachable.has(goal), `no operation serves goal '${goal}'`);
});

test('reachability is opt-in, so most of the kernel is not reachable at all', () => {
  const kernel = operationCatalog();
  const registry = gatewayRegistry();
  assert.ok(kernel.length > registry.operations.length * 3, 'the kernel should be much larger than the gateway surface');
  assert.equal(isGatewayReachable('wm.build'), false);
  assert.equal(isGatewayReachable('workspace.impact.analyze'), false);
  assert.equal(isGatewayReachable('workspace.list'), true);
});

test('model policy and gateway reachability answer different questions', () => {
  // `[INT:CON-051]`. If either were derived from the other, one of these two sets would be empty.
  const registry = gatewayRegistry();
  const reachableModelFree = registry.operations.filter((entry) => entry.modelPolicy === 'never');
  assert.ok(reachableModelFree.length > 0, 'deterministic reads are exactly what should be reachable');

  const kernelModelDriven = operationCatalog().filter((entry) => entry.modelPolicy === 'required');
  assert.ok(kernelModelDriven.length > 0);
  assert.ok(
    kernelModelDriven.every((entry) => !isGatewayReachable(entry.id)),
    'a kernel operation that drives a model should not be host-routable in P0'
  );
});

test('a routed operation inherits its model policy and may not restate it', () => {
  const routed = compile([declaration({ id: 'routed.read', kernelOperation: 'kernel.read', modelPolicy: undefined })]);
  assert.equal(routed.operations[0].modelPolicy, 'never');
  assert.equal(routed.operations[0].kernelOperation, 'kernel.read');

  rejects([declaration({ id: 'routed.read', kernelOperation: 'kernel.read', modelPolicy: 'never' })], 'must not restate modelPolicy');
  rejects([declaration({ id: 'routed.read', kernelOperation: 'kernel.absent', modelPolicy: undefined })], 'not in the kernel catalog');
});

test('classification may be tightened to an authorization, never loosened to a read', () => {
  const tightened = compile([
    declaration({
      id: 'routed.approve',
      kernelOperation: 'kernel.write',
      modelPolicy: undefined,
      classification: 'authorization',
      confirmation: 'ceremony',
      noModelFixture: 'routed-approve-model-free',
      aliases: { en: { version: 1, phrases: ['approve the thing'] } }
    }),
    declaration()
  ]);
  assert.equal(tightened.operations.find((entry) => entry.id === 'routed.approve').classification, 'authorization');

  rejects(
    [declaration({ id: 'routed.lie', kernelOperation: 'kernel.write', modelPolicy: undefined, classification: 'read' })],
    "is declared 'read' but kernel operation"
  );
});

test('an authorization is a ceremony and is never executable', () => {
  const registry = gatewayRegistry();
  const authorizations = registry.operations.filter((entry) => entry.classification === 'authorization');
  assert.ok(authorizations.length > 0);
  for (const entry of authorizations) {
    assert.equal(entry.gateway.confirmation, 'ceremony');
    assert.equal(entry.executable, false);
  }

  rejects([declaration({ classification: 'authorization', confirmation: 'host-confirm' })], 'must use the ceremony confirmation class');
  rejects([declaration({ classification: 'authorization', confirmation: 'ceremony', executable: true })], 'must not be executable');
});

test('nothing that writes is confirmation class none', () => {
  rejects([declaration({ classification: 'mutation', confirmation: 'none' })], "must not be confirmation class 'none'");
  for (const entry of gatewayRegistry().operations) {
    if (entry.classification === 'read') continue;
    assert.notEqual(entry.gateway.confirmation, 'none', `${entry.id} writes with no confirmation`);
  }
});

test('a goal that reaches only writes is rejected', () => {
  // `[INT:CON-035]` `[INT:CON-036]`: a hint proposes a direction, it does not select a write.
  rejects(
    [declaration({ id: 'only.write', classification: 'mutation', confirmation: 'host-confirm', goals: ['watch'] })],
    "reaches only writes"
  );
});

test('an alias belongs to exactly one operation within a locale', () => {
  rejects(
    [declaration(), declaration({ id: 'sample.other', noModelFixture: 'sample-other-model-free' })],
    'is claimed by both'
  );
  // Normalization is case, punctuation and spacing — and nothing more speculative than that.
  rejects(
    [declaration(), declaration({
      id: 'sample.other',
      noModelFixture: 'sample-other-model-free',
      aliases: { en: { version: 1, phrases: ['  Sample,  PHRASE!  '] } }
    })],
    'is claimed by both'
  );
});

test('an alias shared across locales may not straddle classifications', () => {
  rejects([
    declaration({ aliases: { en: { version: 1, phrases: ['open the gate'] } } }),
    declaration({
      id: 'sample.approve',
      classification: 'authorization',
      confirmation: 'ceremony',
      noModelFixture: 'sample-approve-model-free',
      aliases: {
        en: { version: 1, phrases: ['authorise the gate'] },
        de: { version: 1, phrases: ['open the gate'] }
      }
    })
  ], 'is shared by');
});

test('a locale block without a version is not registry data', () => {
  rejects([declaration({ aliases: { en: { phrases: ['sample phrase'] } } })], 'has no integer version');
  rejects([declaration({ aliases: { de: { version: 1, phrases: ['beispiel'] } } })], 'no English aliases');
  rejects([declaration({ aliases: { en: { version: 1, phrases: [] } } })], 'has no phrases');
  rejects([declaration({
    aliases: { en: { version: 1, phrases: ['sample phrase'] }, 'not a locale': { version: 1, phrases: ['x'] } }
  })], 'not a locale tag');
});

test('a declaration cannot name a planner or schema that does not exist', () => {
  rejects([declaration({ planner: 'p-absent' })], 'which no planner provides');
  rejects([declaration({ argumentSchema: 'absent-v1' })], 'which does not exist');
});

test('every reachable operation has its own deterministic fixture', () => {
  rejects([declaration({ noModelFixture: '' })], 'has no deterministic fixture');
  rejects(
    [declaration(), declaration({
      id: 'sample.other',
      aliases: { en: { version: 1, phrases: ['another phrase'] } }
    })],
    'share fixture'
  );
  const fixtures = gatewayRegistry().operations.map((entry) => entry.noModelFixture);
  assert.equal(new Set(fixtures).size, fixtures.length);
});

test('an operation that may use a model falls back to one that cannot', () => {
  rejects([declaration({ modelPolicy: 'optional' })], 'declares no deterministic fallback');
  rejects([declaration({ modelPolicy: 'optional', fallback: 'sample.absent' })], 'which is not reachable');
  rejects([
    declaration({ modelPolicy: 'optional', fallback: 'sample.also-assisted' }),
    declaration({
      id: 'sample.also-assisted',
      modelPolicy: 'optional',
      fallback: 'sample.read',
      noModelFixture: 'sample-also-assisted-fallback',
      aliases: { en: { version: 1, phrases: ['another phrase'] } }
    })
  ], 'which may itself use a model');

  for (const entry of gatewayRegistry().operations) {
    if (entry.modelPolicy !== 'optional') continue;
    assert.equal(gatewayOperation(entry.fallback).modelPolicy, 'never', `${entry.id} has no model-free fallback`);
  }
});

test('bad vocabulary is rejected rather than absorbed', () => {
  rejects([declaration({ classification: 'sideways' })], 'expected one of read, mutation, authorization');
  rejects([declaration({ confirmation: 'maybe' })], 'expected one of');
  rejects([declaration({ goals: ['make.coffee'] })], 'is not a broad goal');
  rejects([declaration({ goals: [] })], 'declares no broad goal');
  rejects([declaration({ subjects: ['galaxy'] })], 'is not a known subject');
  rejects([declaration({ resultContract: 'sflow-result-v1' })], 'the gateway speaks sflow-result-v2');
  rejects([declaration({ id: 'Sample.Read' })], 'not a well-formed operation ID');
  assert.deepEqual([...GATEWAY_CLASSIFICATIONS], ['read', 'mutation', 'authorization']);
});

test('the content hash covers the contract and not the build', () => {
  const base = compile([declaration()]);
  const same = compileOperationRegistry({
    declarations: [declaration()],
    // The same contract, compiled by a build where one more planner happens to be implemented.
    planners: [{ name: 'p-one', run: () => null }, { name: 'p-two', run: () => null }],
    kernelCatalog: KERNEL
  });
  assert.equal(same.contentHash, base.contentHash);
  assert.deepEqual(same.unimplementedPlanners, []);

  const changed = compile([declaration({ subjects: ['workspace', 'story'] })]);
  assert.notEqual(changed.contentHash, base.contentHash);
});

test('the unimplemented-planner ratchet only goes down', () => {
  const registry = gatewayRegistry();
  const missing = unimplementedPlanners(gatewayPlanners());
  assert.ok(
    missing.length <= MAX_UNIMPLEMENTED_GATEWAY_PLANNERS,
    `${missing.length} declared planners are unimplemented (${missing.join(', ')});`
    + ` the ceiling is ${MAX_UNIMPLEMENTED_GATEWAY_PLANNERS} and lowering it is the point`
  );
  // And the ceiling tracks reality rather than drifting above it.
  assert.equal(missing.length, MAX_UNIMPLEMENTED_GATEWAY_PLANNERS, 'lower the ceiling to match');
  assert.equal(new Set(GATEWAY_PLANNERS.map((entry) => entry.name)).size, GATEWAY_PLANNERS.length);
  for (const entry of registry.operations) {
    assert.ok(GATEWAY_PLANNERS.some((planner) => planner.name === entry.gateway.planner));
  }
});

test('broad goals are a closed vocabulary', () => {
  assert.equal(BROAD_GOALS.length, 15);
  assert.equal(isBroadGoal('impact.quick'), true);
  assert.equal(isBroadGoal('impact.slow'), false);
  assert.throws(() => assertBroadGoal('impact.slow'), (error) => error.code === 'UNKNOWN_BROAD_GOAL');
});

test('alias normalization absorbs spelling, not meaning', () => {
  assert.equal(normalizeAlias('  What WILL this change  affect? '), 'what will this change affect');
  assert.equal(normalizeAlias('what-if'), 'what if');
  assert.notEqual(normalizeAlias('approve'), normalizeAlias('approvals'));
});

test('an argument schema accepts what it declares and nothing else', () => {
  assert.deepEqual(validateArguments('work-subject-v1', { workId: 'WRK-123' }), { workId: 'WRK-123' });
  assert.throws(
    () => validateArguments('work-subject-v1', { workId: 'WRK-123', force: true }),
    (error) => error.code === 'UNKNOWN_OPERATION_ARGUMENT'
  );
  // Missing and wrong are different answers: the resolver can ask for the first and only refuse the
  // second, so they must not share a code.
  assert.throws(
    () => validateArguments('work-subject-v1', {}),
    (error) => error.code === 'MISSING_OPERATION_ARGUMENT' && error.details.field === 'workId'
  );
  assert.throws(
    () => validateArguments('work-subject-v1', { workId: 'not valid!' }),
    (error) => error.code === 'INVALID_OPERATION_ARGUMENT'
  );
  assert.throws(() => validateArguments('absent-v1', {}), (error) => error.code === 'UNKNOWN_ARGUMENT_SCHEMA');
  // An absent optional field stays absent; it does not become null.
  assert.deepEqual(validateArguments('work-list-v1', {}), {});
  assert.deepEqual(validateArguments('work-list-v1', { group: 'active' }), { group: 'active' });
  assert.throws(() => validateArguments('work-list-v1', { group: 'someday' }), (error) => error.code === 'INVALID_OPERATION_ARGUMENT');
});

test('a ref argument is something Git will take, not something a shell will', () => {
  assert.deepEqual(validateArguments('impact-quick-v1', { baseRef: 'release/24.3' }), { baseRef: 'release/24.3' });
  for (const value of ['--upload-pack=touch x', '-u', 'a b', 'main..next', 'main\u0000', 'refs/heads/x.lock', 'x/']) {
    assert.throws(
      () => validateArguments('impact-quick-v1', { baseRef: value }),
      (error) => error.code === 'INVALID_OPERATION_ARGUMENT',
      `accepted ref ${JSON.stringify(value)}`
    );
  }
});

test('a path argument cannot leave the repository', () => {
  assert.deepEqual(
    validateArguments('intent-trace-v1', { repositoryId: 'checkout', path: 'src/pay.ts' }),
    { repositoryId: 'checkout', path: 'src/pay.ts' }
  );
  for (const value of ['/etc/passwd', 'C:\\secrets', '../../etc/passwd', 'src\\..\\..\\x', 'src/x\u0000.ts']) {
    assert.throws(
      () => validateArguments('intent-trace-v1', { repositoryId: 'checkout', path: value }),
      (error) => error.code === 'INVALID_OPERATION_ARGUMENT',
      `accepted path ${JSON.stringify(value)}`
    );
  }
  // A materialization target is the user's own directory, so absolute is fine and traversal is not.
  assert.ok(validateArguments('workspace-materialize-v1', { workspaceId: 'payments', targetPath: '/Users/me/code' }));
  assert.throws(() => validateArguments('workspace-materialize-v1', { workspaceId: 'payments', targetPath: '/Users/me/../etc' }),
    (error) => error.code === 'INVALID_OPERATION_ARGUMENT');
});

test('prose arguments are bounded and free of control characters', () => {
  assert.ok(validateArguments('problem-investigate-v1', { symptom: 'checkout fails\nafter address validation' }));
  assert.throws(() => validateArguments('problem-investigate-v1', { symptom: 'x\u0000y' }), (error) => error.code === 'INVALID_OPERATION_ARGUMENT');
  assert.throws(() => validateArguments('problem-investigate-v1', { symptom: 'x'.repeat(2001) }), (error) => error.code === 'INVALID_OPERATION_ARGUMENT');
  assert.throws(() => validateArguments('problem-investigate-v1', { symptom: '   ' }), (error) => error.code === 'INVALID_OPERATION_ARGUMENT');
});

test('every declared schema is versioned, and every named schema exists', () => {
  for (const entry of ARGUMENT_SCHEMAS) assert.match(entry.id, /-v[1-9][0-9]*$/);
  assert.equal(new Set(ARGUMENT_SCHEMAS.map((entry) => entry.id)).size, ARGUMENT_SCHEMAS.length);
  for (const entry of gatewayRegistry().operations) {
    assert.ok(hasArgumentSchema(entry.gateway.argumentSchema), `${entry.id} names a missing schema`);
    assert.ok(argumentSchema(entry.gateway.argumentSchema));
  }
  assert.ok(COMPARISON_SUBJECTS.includes('build'));
});

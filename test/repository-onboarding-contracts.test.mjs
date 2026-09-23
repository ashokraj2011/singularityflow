import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const planSchema = JSON.parse(await readFile(
  new URL('../schemas/repository-onboarding-plan.schema.json', import.meta.url), 'utf8'
));
const resultSchema = JSON.parse(await readFile(
  new URL('../schemas/repository-onboarding-result.schema.json', import.meta.url), 'utf8'
));
const recoverySchema = JSON.parse(await readFile(
  new URL('../schemas/repository-configuration-recovery.schema.json', import.meta.url), 'utf8'
));

const {
  parseRepositoryOnboardingPlan,
  parseRepositoryOnboardingResult
} = await import(new URL(
  '../apps/vscode/src/views/repository-onboarding-model.ts', import.meta.url
));

function pointer(document, reference) {
  assert.match(reference, /^#\//u);
  return reference.slice(2).split('/').reduce((value, key) => (
    value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')]
  ), document);
}

function typeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object'
    && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  return typeof value === type;
}

/** Bounded draft-2020-12 validator for the keywords used by these public contracts. */
function validate(document, shape, value, location = '$') {
  const errors = [];
  const check = (current, candidate, at) => {
    if (current.$ref) {
      const resolved = pointer(document, current.$ref);
      if (!resolved) errors.push(`${at}: unresolved ${current.$ref}`);
      else check(resolved, candidate, at);
      return;
    }
    if (current.anyOf) {
      if (!current.anyOf.some((branch) => validate(document, branch, candidate, at).length === 0)) {
        errors.push(`${at}: no anyOf branch matched`);
      }
      return;
    }
    if (current.oneOf) {
      const matches = current.oneOf.filter((branch) =>
        validate(document, branch, candidate, at).length === 0);
      if (matches.length !== 1) errors.push(`${at}: expected one branch, found ${matches.length}`);
      return;
    }
    if (Object.hasOwn(current, 'const') && !Object.is(candidate, current.const)) {
      errors.push(`${at}: expected ${JSON.stringify(current.const)}`);
    }
    if (current.enum && !current.enum.some((entry) => Object.is(entry, candidate))) {
      errors.push(`${at}: outside closed vocabulary`);
    }
    if (current.type) {
      const types = Array.isArray(current.type) ? current.type : [current.type];
      if (!types.some((type) => typeMatches(type, candidate))) {
        errors.push(`${at}: expected ${types.join('|')}`);
        return;
      }
    }
    if (typeof candidate === 'string') {
      if (current.minLength != null && candidate.length < current.minLength) {
        errors.push(`${at}: too short`);
      }
      if (current.maxLength != null && candidate.length > current.maxLength) {
        errors.push(`${at}: too long`);
      }
      if (current.pattern && !new RegExp(current.pattern, 'u').test(candidate)) {
        errors.push(`${at}: pattern mismatch`);
      }
    }
    if (typeof candidate === 'number' && current.minimum != null
        && candidate < current.minimum) errors.push(`${at}: below minimum`);
    if (Array.isArray(candidate)) {
      if (current.minItems != null && candidate.length < current.minItems) {
        errors.push(`${at}: too few items`);
      }
      if (current.uniqueItems
          && new Set(candidate.map((entry) => JSON.stringify(entry))).size !== candidate.length) {
        errors.push(`${at}: duplicate items`);
      }
      if (current.items) candidate.forEach((entry, index) =>
        check(current.items, entry, `${at}[${index}]`));
    }
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const required of current.required ?? []) {
        if (!Object.hasOwn(candidate, required)) errors.push(`${at}: missing ${required}`);
      }
      if (current.propertyNames) {
        for (const key of Object.keys(candidate)) check(current.propertyNames, key, `${at}{key}`);
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (current.properties?.[key]) check(current.properties[key], child, `${at}.${key}`);
        else if (current.additionalProperties === false) errors.push(`${at}: unknown ${key}`);
        else if (current.additionalProperties && typeof current.additionalProperties === 'object') {
          check(current.additionalProperties, child, `${at}.${key}`);
        }
      }
    }
  };
  check(shape, value, location);
  return errors;
}

function assertStrictObjectSchemas(value, location) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'object') {
    assert.ok(value.additionalProperties === false
      || (value.additionalProperties && typeof value.additionalProperties === 'object'),
    `${location} must close properties or validate every dynamic value`);
    for (const required of value.required ?? []) {
      assert.ok(Object.hasOwn(value.properties ?? {}, required),
        `${location} requires undeclared '${required}'`);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'properties' || key === '$defs') {
      for (const [name, entry] of Object.entries(child ?? {})) {
        assertStrictObjectSchemas(entry, `${location}.${key}.${name}`);
      }
    } else if (key === 'items' || key === 'additionalProperties') {
      assertStrictObjectSchemas(child, `${location}.${key}`);
    } else if (['oneOf', 'anyOf', 'allOf'].includes(key) && Array.isArray(child)) {
      child.forEach((entry, index) => assertStrictObjectSchemas(
        entry, `${location}.${key}[${index}]`
      ));
    }
  }
}

const commit = 'a'.repeat(40);
const planId = `sha256:${'b'.repeat(64)}`;
const repositoryIdentity = `sha256:${'c'.repeat(64)}`;
const preserved = [
  'application-head', 'application-working-tree', 'application-branches',
  'lifecycle-events', 'non-configuration-state', 'configuration-proposal-refs'
];
const nextActions = {
  shell: `singularity-flow capability onboard repository --confirm-plan ${planId} --json`,
  copilot: '/sf-capability-map'
};
const plan = {
  schemaVersion: 1,
  kind: 'repository-onboarding-plan/v1',
  repository: { url: 'ssh://git.internal/team/application.git', identity: repositoryIdentity },
  mode: 'auto',
  status: 'ready',
  primaryAction: 'continue',
  state: { kind: 'none', branch: 'state', commit: null },
  configuration: {
    branch: 'sflow/config', commit, status: 'current', schemaVersion: 2,
    currentSchemaVersion: 2, stateBranch: 'state', stateProjectionEnabled: true,
    seedChanges: [], validationError: null
  },
  observedRefs: {
    'refs/heads/sflow/config': commit,
    'refs/heads/state': null
  },
  effects: [{
    kind: 'local-registration', target: 'ssh://git.internal/team/application.git',
    action: 'remember'
  }],
  preserved,
  omitted: [],
  choices: [],
  availableModes: ['recreate', 'reset-local'],
  canApply: true,
  planId,
  nextActions,
  dryRun: true
};
const result = {
  schemaVersion: 1,
  kind: 'repository-onboarding-result/v1',
  planId,
  mode: 'auto',
  status: 'ready',
  primaryAction: 'continue',
  applied: true,
  changed: true,
  effects: plan.effects,
  preserved,
  availableModes: plan.availableModes,
  nextActions: {
    shell: 'singularity-flow capability onboard repository --dry-run --json',
    copilot: '/sf-capability-map'
  }
};

test('repository onboarding schemas are closed public v1 contracts', () => {
  for (const [name, schema] of [
    ['repository-onboarding-plan', planSchema],
    ['repository-onboarding-result', resultSchema]
  ]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(schema.properties.schemaVersion.const, 1, name);
    assert.equal(schema.additionalProperties, false, name);
    assertStrictObjectSchemas(schema, name);
  }
  assert.equal(recoverySchema.properties.kind.const, 'repository-configuration-recovery');
  assert.equal(recoverySchema.additionalProperties, false,
    'the existing durable recovery receipt remains a separate closed contract');
});

test('repository onboarding schemas accept exact plan/result envelopes and reject drift', () => {
  assert.deepEqual(validate(planSchema, planSchema, plan), []);
  assert.deepEqual(validate(resultSchema, resultSchema, result), []);

  const notSetUp = {
    ...plan,
    status: 'not-set-up',
    primaryAction: 'set-up-sflow',
    configuration: {
      ...plan.configuration, commit: null, status: 'missing', schemaVersion: null,
      stateBranch: null, stateProjectionEnabled: false
    },
    applicationSource: { branch: 'main', commit, ref: 'HEAD' },
    observedRefs: {
      HEAD: commit,
      'refs/heads/sflow/config': null,
      'refs/heads/state': null
    },
    effects: [
      { kind: 'configuration-recreate', target: 'sflow/config', action: 'create' },
      { kind: 'state-projection', target: 'state', action: 'refresh' },
      {
        kind: 'local-registration', target: 'ssh://git.internal/team/application.git',
        action: 'remember'
      }
    ]
  };
  const routing = {
    leadUrl: 'ssh://git.internal/platform/configuration.git',
    capabilityIds: ['application'], verified: true,
    repositoryId: 'application', configurationCommit: commit
  };
  const locator = {
    ...plan,
    status: 'linked-to-team-configuration',
    primaryAction: 'continue',
    state: { kind: 'delivery-locator', branch: 'state', commit, routing },
    routing,
    effects: [{
      kind: 'local-registration', target: routing.leadUrl, action: 'remember'
    }],
    availableModes: ['reset-local']
  };
  const mirror = {
    ...plan,
    status: 'ready-to-restore',
    primaryAction: 'restore-and-continue',
    state: {
      kind: 'configuration-mirror', branch: 'state', commit,
      sourceCommit: commit, subjectBound: true, repositoryBound: true, history: null,
      schemaVersion: 2, stateProjectionEnabled: true, compatibility: 'current',
      validationError: null, seedChanges: [], files: ['singularity/workflow.yml'],
      assets: {
        'singularity/workflow.yml': {
          sha256: 'd'.repeat(64), object: commit, mode: '100644'
        }
      }
    },
    configuration: {
      ...plan.configuration, commit: null, status: 'missing', schemaVersion: null,
      stateBranch: null, stateProjectionEnabled: false
    },
    effects: [
      { kind: 'configuration-restore', target: 'sflow/config', action: 'create' },
      { kind: 'state-projection', target: 'state', action: 'refresh' }
    ]
  };
  const resetResult = {
    ...result,
    mode: 'reset-local',
    effects: [{
      kind: 'local-registration', target: plan.repository.url, action: 'forget'
    }],
    availableModes: ['reset-local'],
    localReset: {
      targets: [plan.repository.url], leadRegistrationsRemoved: 1,
      organisationCachesRemoved: 0, remoteChanged: false
    }
  };
  const reviewResult = {
    ...result,
    status: 'configuration-review-required',
    primaryAction: 'review-choices',
    effects: [{
      kind: 'configuration-recreate',
      target: 'sflow/config-change/onboarding/create-aaaaaaaaaaaa',
      action: 'propose'
    }],
    proposal: {
      changed: true,
      branch: 'sflow/config-change/onboarding/create-aaaaaaaaaaaa',
      commit,
      candidateCommit: commit,
      files: ['singularity/workflow.yml'],
      reviewRequired: true,
      existing: false,
      conflict: false,
      published: true
    },
    review: {
      status: 'review-required',
      configurationReady: false,
      sourceBranch: 'sflow/config-change/onboarding/create-aaaaaaaaaaaa',
      targetBranch: 'sflow/config',
      proposalCommit: commit,
      candidateCommit: commit,
      published: true,
      existing: false,
      conflict: false,
      recovery: {
        action: 'merge-proposal',
        sourceBranch: 'sflow/config-change/onboarding/create-aaaaaaaaaaaa',
        targetBranch: 'sflow/config',
        proposalCommit: commit,
        afterMerge: 'singularity-flow capability onboard repository --dry-run --json'
      }
    }
  };
  const localPendingResult = {
    ...result,
    status: 'local-registration-pending',
    primaryAction: 'retry',
    effects: [],
    localRegistration: {
      status: 'pending',
      remembered: false,
      target: plan.repository.url,
      code: 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED',
      causeCode: 'EACCES',
      reason: 'Remote setup was preserved; local registration could not be written.',
      retry: result.nextActions
    }
  };
  for (const candidate of [notSetUp, locator, mirror]) {
    assert.deepEqual(validate(planSchema, planSchema, candidate), []);
  }
  const parsedNotSetUp = parseRepositoryOnboardingPlan(notSetUp);
  assert.ok(parsedNotSetUp,
    'VS Code accepts the fresh repository plan whose exact application source is HEAD');
  assert.equal(parsedNotSetUp.observedRefs.HEAD, commit);
  for (const unsafeRef of [
    'HEAD~1', 'refs/remotes/origin/main', 'refs/heads/state..other', 'refs/tags/release.lock'
  ]) {
    assert.equal(parseRepositoryOnboardingPlan({
      ...notSetUp,
      observedRefs: { ...notSetUp.observedRefs, [unsafeRef]: commit }
    }), null, `VS Code rejects unsafe observed ref '${unsafeRef}'`);
  }
  assert.deepEqual(validate(resultSchema, resultSchema, resetResult), []);
  assert.deepEqual(validate(resultSchema, resultSchema, reviewResult), []);
  assert.deepEqual(validate(resultSchema, resultSchema, localPendingResult), []);
  assert.ok(parseRepositoryOnboardingResult(reviewResult, planId));
  assert.ok(parseRepositoryOnboardingResult(localPendingResult, planId));
  assert.equal(parseRepositoryOnboardingResult({ ...reviewResult, review: null }, planId), null);
  assert.equal(parseRepositoryOnboardingResult({
    ...localPendingResult, localRegistration: null
  }, planId), null);

  for (const candidate of [
    { ...plan, schemaVersion: 2 },
    { ...plan, kind: 'repository-onboarding-plan/v2' },
    { ...plan, unreviewedMutation: true },
    { ...plan, planId: 'not-content-addressed' },
    { ...plan, state: { ...plan.state, branch: 'refs/heads/state' } }
  ]) assert.notDeepEqual(validate(planSchema, planSchema, candidate), []);

  for (const candidate of [
    { ...result, schemaVersion: 2 },
    { ...result, kind: 'repository-onboarding-result/v2' },
    { ...result, applied: false },
    { ...result, hiddenEffect: true }
  ]) assert.notDeepEqual(validate(resultSchema, resultSchema, candidate), []);
});

test('VS Code parsers accept v1 and fail closed on future or mismatched contracts', () => {
  assert.ok(parseRepositoryOnboardingPlan(plan));
  assert.ok(parseRepositoryOnboardingResult(result, planId));
  assert.equal(parseRepositoryOnboardingPlan({ ...plan, schemaVersion: 2 }), null);
  assert.equal(parseRepositoryOnboardingPlan({
    ...plan, kind: 'repository-onboarding-plan/v2'
  }), null);
  assert.equal(parseRepositoryOnboardingResult({ ...result, schemaVersion: 2 }, planId), null);
  assert.equal(parseRepositoryOnboardingResult({
    ...result, kind: 'repository-onboarding-result/v2'
  }, planId), null);
  assert.equal(parseRepositoryOnboardingResult(result, `sha256:${'d'.repeat(64)}`), null,
    'a valid result for another preview cannot authorize continuation');
});

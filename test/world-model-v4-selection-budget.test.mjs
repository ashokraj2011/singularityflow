import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson, sealRecord } from '../src/world-model/canonicalize.mjs';
import { assembleWmbV4Prompt } from '../src/world-model/compose/pinned-core.mjs';
import {
  candidateFactReferences, renderDeterministicCandidate
} from '../src/world-model/compose/candidate.mjs';
import {
  createFactLedger, factIdentityFromRecord
} from '../src/world-model/extract/fact-ledger.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  LEGACY_REGISTERED_SELECTION_POLICY,
  LEGACY_REGISTERED_SELECTION_POLICY_SHA256,
  REGISTERED_SELECTION_POLICY_SHA256,
  selectViewFacts,
  validateViewFactLedger
} from '../src/world-model/extract/selection.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget,
  createWorldModelViewOutputBudget
} from '../src/world-model/plan.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';
import { resolveBuiltInViewContract } from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { validateCompositionCandidate } from '../src/world-model/validate/candidate.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function largeContractSource(count = 96) {
  const contracts = Array.from({ length: count }, (_, index) => [
    `export interface Contract${index} {`,
    `  field${index}: string;`,
    `  enabled${index}: boolean;`,
    '}'
  ].join('\n'));
  return [
    ...contracts,
    'export class ContractImplementation implements Contract0 {',
    "  field0 = 'ready';",
    '  enabled0 = true;',
    '}',
    ...Array.from({ length: count }, (_, index) => (
      `export function operation${index}(value: string): string { return value; }`
    ))
  ].join('\n');
}

async function largeFixture(t, count = 96) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-selection-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMB Selection Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'contracts.ts'), largeContractSource(count));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'large contract fixture');
  const scopeManifest = createScopeManifest({
    capabilityId: 'large-contract-service',
    allowedPaths: ['src/**']
  });
  const registration = runDeterministicRegistration({
    root,
    scopeManifest,
    requestedViews: ['arch.contracts@4']
  });
  return {
    root,
    scopeManifest,
    contract: resolveBuiltInViewContract('arch.contracts@4'),
    registration
  };
}

function addMaterialContradictions(context, count = 1) {
  const eligible = context.registration.factLedger.facts.filter((fact) => (
    fact.status === 'available'
    && context.contract.factPolicy.requiredFactTypes.includes(fact.factType)
  ));
  assert.ok(eligible.length > 1, 'fixture must expose two eligible facts');
  const contradictionDrafts = Array.from({ length: count }, (_, index) => {
    const subject = eligible[index % eligible.length];
    const conflicting = eligible[(index + 1) % eligible.length];
    return {
      ...factIdentityFromRecord(subject),
      claim: `${subject.subject.id} has conflicting registered structural observation ${index}.`,
      status: 'contradicted',
      conflictsWith: [conflicting.id]
    };
  });
  return createFactLedger({
    sourceSnapshot: context.registration.sourceSnapshot,
    scopeManifest: context.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    evidenceCatalog: context.registration.evidenceCatalog,
    derivationIds: new Set(
      context.registration.derivationCatalog.derivations.map((entry) => entry.id)
    ),
    factDrafts: [
      ...context.registration.factLedger.facts.map(factIdentityFromRecord),
      ...contradictionDrafts
    ]
  });
}

test('large registered-v4 views preserve coverage and contradictions within exact budgets', async (t) => {
  const context = await largeFixture(t);
  const factLedger = addMaterialContradictions(context);
  const first = selectViewFacts({ factLedger, viewContract: context.contract });
  const second = selectViewFacts({ factLedger, viewContract: context.contract });

  assert.equal(first.selectionPolicySha256, REGISTERED_SELECTION_POLICY_SHA256);
  assert.equal(first.ledgerSha256, second.ledgerSha256);
  assert.equal(context.contract.budgets.maximumInputTokens, 8000);
  assert.ok(first.facts.length <= context.contract.facts.maximumSelectedFacts);
  assert.ok(factLedger.facts.length > context.contract.facts.maximumSelectedFacts);

  const selectedById = new Map(first.facts.map((fact) => [fact.id, fact]));
  const requiredTypes = new Set(first.requiredFactIds.map((id) => selectedById.get(id)?.factType));
  assert.deepEqual(
    [...requiredTypes].sort(),
    [...context.contract.factPolicy.requiredFactTypes].sort(),
    'every required Fact type must retain deterministic coverage'
  );
  assert.ok(first.materialContradictionFactIds.length > 0);
  assert.ok(first.materialContradictionFactIds.every((id) => selectedById.has(id)));
  const mandatoryIds = [...new Set([
    ...first.requiredFactIds,
    ...first.requiredUnavailableFactIds,
    ...first.materialContradictionFactIds
  ])];

  const promptInputs = {
    viewContract: context.contract,
    scopeManifest: context.scopeManifest,
    viewFactLedger: first,
    evidenceCatalog: context.registration.evidenceCatalog,
    consumerProfile: createWorldModelConsumerProfile(),
    outputBudget: createWorldModelViewOutputBudget(
      createWorldModelOutputBudget([context.contract]), context.contract
    )
  };
  const prompt = await assembleWmbV4Prompt(promptInputs);
  const repeatedPrompt = await assembleWmbV4Prompt(promptInputs);
  assert.deepEqual(prompt, repeatedPrompt);
  const factPacket = JSON.parse(
    prompt.regions.find((region) => region.id === 'composition-fact-packet').text
  );
  assert.equal(factPacket.sourceViewFactLedgerSha256, first.ledgerSha256);
  assert.equal(factPacket.availableFactCount, first.facts.length);
  assert.equal(factPacket.admittedFactCount, prompt.admittedFactIds.length);
  assert.deepEqual(factPacket.facts.map((fact) => fact.id).sort(), prompt.admittedFactIds);
  const admittedPromptIds = new Set(prompt.admittedFactIds);
  assert.ok(mandatoryIds.every((id) => admittedPromptIds.has(id)),
    'the prompt must admit every coverage, unavailable, and contradiction Fact');
  assert.ok(prompt.omittedFactIds.length > 0,
    'the fixture must exercise deterministic optional-Fact omission');
  assert.deepEqual(
    [...prompt.admittedFactIds, ...prompt.omittedFactIds].sort(),
    first.facts.map((fact) => fact.id).sort(),
    'prompt admission must account for every selected Fact exactly once'
  );
  const estimatedInputTokens = Math.ceil(Buffer.byteLength(prompt.prompt, 'utf8') / 4);
  assert.ok(
    estimatedInputTokens <= context.contract.budgets.maximumInputTokens,
    `the exact assembled prompt requires ${estimatedInputTokens} estimated input tokens, above `
      + `the registered ${context.contract.budgets.maximumInputTokens}-token ceiling`
  );

  const candidate = renderDeterministicCandidate(context.contract, first);
  assert.deepEqual(candidate, renderDeterministicCandidate(context.contract, second));
  const candidateReferences = new Set(candidateFactReferences(candidate));
  assert.ok(mandatoryIds.every((id) => candidateReferences.has(id)),
    'the candidate must admit every coverage, unavailable, and contradiction Fact');
  assert.ok(
    Math.ceil(Buffer.byteLength(canonicalJson(candidate), 'utf8') / 4)
      <= context.contract.budgets.maximumOutputTokens,
    'the exact rendered candidate must fit its registered output-token budget'
  );
  assert.equal(validateCompositionCandidate(candidate, {
    contract: context.contract,
    viewFactLedger: first,
    evidenceCatalog: context.registration.evidenceCatalog,
    scopeManifest: context.scopeManifest
  }).receipt.status, 'passed');

  // A model sees only the bounded composition Fact Packet, never the complete durable ledger.
  // Prove that a candidate composed solely from that packet is valid for the model route before
  // trying to smuggle in one of the deliberately omitted optional Facts below.
  const admittedFactIds = new Set(prompt.admittedFactIds);
  const admittedFactLedger = {
    ...first,
    facts: first.facts.filter((fact) => admittedFactIds.has(fact.id))
  };
  const modelCandidate = renderDeterministicCandidate(
    context.contract, admittedFactLedger, { outputBudget: promptInputs.outputBudget }
  );
  assert.equal(validateCompositionCandidate(modelCandidate, {
    contract: context.contract,
    viewFactLedger: first,
    evidenceCatalog: context.registration.evidenceCatalog,
    scopeManifest: context.scopeManifest,
    outputBudget: promptInputs.outputBudget,
    executionRoute: 'model',
    admittedFactIds: prompt.admittedFactIds
  }).receipt.status, 'passed');

  const omittedFactId = prompt.omittedFactIds[0];
  assert.ok(!mandatoryIds.includes(omittedFactId));
  const omittedFactCandidate = renderDeterministicCandidate(context.contract, {
    ...first,
    facts: first.facts.filter((fact) => (
      admittedFactIds.has(fact.id) || fact.id === omittedFactId
    ))
  }, { outputBudget: promptInputs.outputBudget });
  assert.ok(candidateFactReferences(omittedFactCandidate).includes(omittedFactId),
    'the fixture candidate must cite a Fact omitted from the bounded model prompt');
  assert.throws(
    () => validateCompositionCandidate(omittedFactCandidate, {
      contract: context.contract,
      viewFactLedger: first,
      evidenceCatalog: context.registration.evidenceCatalog,
      scopeManifest: context.scopeManifest,
      outputBudget: promptInputs.outputBudget,
      executionRoute: 'model',
      admittedFactIds: prompt.admittedFactIds
    }),
    (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN'
      && error.details.id === omittedFactId
  );
});

test('historical v1 registered selection ledgers remain accepted', async (t) => {
  const context = await largeFixture(t, 1);
  const requiredTypes = new Set(context.contract.factPolicy.requiredFactTypes);
  const retained = [];
  for (const factType of [...requiredTypes].sort()) {
    const fact = context.registration.factLedger.facts.find((entry) => entry.factType === factType);
    assert.ok(fact, `fixture must cover ${factType}`);
    retained.push(fact);
  }
  for (const factType of context.contract.factPolicy.requiredUnavailableSubjects) {
    const fact = context.registration.factLedger.facts.find((entry) => (
      entry.factType === factType && entry.status === 'unavailable'
    ));
    assert.ok(fact, `fixture must expose unavailable ${factType}`);
    retained.push(fact);
  }
  const historicalSource = sealRecord({
    ...context.registration.factLedger,
    facts: [...new Map(retained.map((fact) => [fact.id, fact])).values()]
      .sort((left, right) => left.id.localeCompare(right.id))
  }, 'ledgerSha256');
  const historical = selectViewFacts({
    factLedger: historicalSource,
    viewContract: context.contract,
    selectionPolicy: LEGACY_REGISTERED_SELECTION_POLICY
  });

  assert.equal(historical.selectionPolicySha256, LEGACY_REGISTERED_SELECTION_POLICY_SHA256);
  assert.equal(validateViewFactLedger(historical, {
    factLedger: historicalSource,
    viewContract: context.contract
  }).ledgerSha256, historical.ledgerSha256);
});

test('bounded selection never prunes material contradictions to satisfy a ceiling', async (t) => {
  const context = await largeFixture(t);
  const eligible = context.registration.factLedger.facts.filter((fact) => (
    fact.status === 'available'
    && context.contract.factPolicy.requiredFactTypes.includes(fact.factType)
  ));
  assert.ok(eligible.length > 1);
  const contradictionDrafts = Array.from(
    { length: context.contract.facts.maximumSelectedFacts + 1 },
    (_, index) => ({
      ...factIdentityFromRecord(eligible[index % eligible.length]),
      claim: `Registered structural observation ${index} is materially contradicted.`,
      status: 'contradicted',
      conflictsWith: [eligible[(index + 1) % eligible.length].id]
    })
  );
  const factLedger = createFactLedger({
    sourceSnapshot: context.registration.sourceSnapshot,
    scopeManifest: context.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    evidenceCatalog: context.registration.evidenceCatalog,
    derivationIds: new Set(
      context.registration.derivationCatalog.derivations.map((entry) => entry.id)
    ),
    factDrafts: [
      ...context.registration.factLedger.facts.map(factIdentityFromRecord),
      ...contradictionDrafts
    ]
  });

  assert.throws(
    () => selectViewFacts({ factLedger, viewContract: context.contract }),
    (error) => error.code === 'WMB_VIEW_FACT_BUDGET_EXCEEDED'
      && /minimum coverage and contradiction Facts/.test(error.message)
  );
});

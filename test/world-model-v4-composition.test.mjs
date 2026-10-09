import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assembleWmbV4Prompt, assertWmbV4PromptInputBudget, WMB_V4_REQUEST_BOUNDARY
} from '../src/world-model/compose/pinned-core.mjs';
import {
  canonicalFactSentence, deterministicArrangementFits, renderDeterministicCandidate
} from '../src/world-model/compose/candidate.mjs';
import {
  createFactLedger, factIdentityFromRecord
} from '../src/world-model/extract/fact-ledger.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { selectViewFacts } from '../src/world-model/extract/selection.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget,
  createWorldModelViewOutputBudget
} from '../src/world-model/plan.mjs';
import {
  BUILTIN_VIEW_REFERENCES, resolveBuiltInViewContract
} from '../src/world-model/registry/views.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import {
  validateCompositionCandidate, validateModelCompositionCandidate,
  validateWorldModelViewValidationReceipt
} from '../src/world-model/validate/candidate.mjs';
import {
  createWorldModelExecutionStamp, verifiedWorldModelExecutionRoute,
  WMB_V4_DETERMINISTIC_EXECUTION_SHA256, worldModelExecutionUnitManifestSha256
} from '../src/world-model/execution-profile.mjs';
import { recordSha256 } from '../src/records.mjs';
import { isWorldModelViewRetryableCode } from '../src/world-model/retry.mjs';
import { worldModelCompositionRecovery } from '../src/world-model/compose/composition-recovery.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-composition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMB Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'service.mjs'),
    "import { helper } from './support.mjs';\nexport function service() { return helper(); }\n"
  );
  await writeFile(path.join(root, 'src', 'support.mjs'), 'export function helper() { return 1; }\n');
  await writeFile(path.join(root, 'src', 'App.tsx'), 'export function App() { return null; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const scopeManifest = createScopeManifest({
    capabilityId: 'service', allowedPaths: ['src/**'],
    allowedSubjects: ['analysis', 'dependency-edge', 'file', 'symbol']
  });
  const registration = runDeterministicRegistration({
    root, scopeManifest, requestedViews: ['dev.impact@4']
  });
  return {
    root,
    contract: resolveBuiltInViewContract('dev.impact@4'),
    scopeManifest,
    evidenceCatalog: registration.evidenceCatalog,
    viewFactLedger: registration.viewFactLedgers[0]
  };
}

function validate(candidate, context) {
  return validateCompositionCandidate(candidate, context);
}

test('model composition cannot silently omit an admitted optional or unavailable fact', async (t) => {
  const context = await fixture(t);
  const required = new Set([
    ...context.viewFactLedger.requiredFactIds,
    ...context.viewFactLedger.requiredUnavailableFactIds,
    ...context.viewFactLedger.materialContradictionFactIds
  ]);
  const optional = context.viewFactLedger.facts.filter((fact) => !required.has(fact.id));
  assert.ok(optional.length);
  for (const omitted of optional.slice(0, 3)) {
    const reduced = { ...context.viewFactLedger,
      facts: context.viewFactLedger.facts.filter((fact) => fact.id !== omitted.id) };
    const candidate = renderDeterministicCandidate(context.contract, reduced);
    const options = { ...context, executionRoute: 'model',
      admittedFactIds: context.viewFactLedger.facts.map((fact) => fact.id) };
    assert.throws(() => validateModelCompositionCandidate(candidate, options),
      (error) => error.code === 'WMB_ADMITTED_FACT_OMITTED'
        && error.details.omittedFactIds.includes(omitted.id));
    const result = validate(candidate, { ...options,
      admittedFactIds: candidate.usedFactIds });
    assert.equal(result.receipt.status, 'passed', 'a legitimately smaller packet is still accepted');
    assert.ok(result.receipt.checks.some((check) => check.id === 'admitted-fact-coverage'));
    assert.equal(validate(candidate, { ...context, viewFactLedger: reduced }).receipt.status, 'passed',
      'the deterministic selection contract remains unchanged');
    const historicReceipt = structuredClone(result.receipt);
    historicReceipt.checks = historicReceipt.checks.filter((check) => check.id !== 'admitted-fact-coverage');
    delete historicReceipt.receiptSha256;
    historicReceipt.receiptSha256 = `sha256:${recordSha256(historicReceipt)}`;
    assert.doesNotThrow(() => validateWorldModelViewValidationReceipt(historicReceipt),
      'old receipt schema remains readable without claiming the new check passed');
  }
  assert.equal(isWorldModelViewRetryableCode('WMB_ADMITTED_FACT_OMITTED'), true);
  assert.ok(worldModelCompositionRecovery({ view: context.contract.id,
    failures: [{ code: 'WMB_ADMITTED_FACT_OMITTED' }] }));
  const unavailableLedger = structuredClone(context.viewFactLedger);
  const unavailable = unavailableLedger.facts.find((fact) => fact.id === optional[0].id);
  unavailable.status = 'unavailable';
  unavailable.claim = null;
  unavailable.reason = { code: 'analysis-unavailable', detail: 'Requested optional analysis is unavailable.' };
  const reduced = { ...unavailableLedger, facts: unavailableLedger.facts.filter((fact) => fact.id !== unavailable.id) };
  const candidate = renderDeterministicCandidate(context.contract, reduced);
  assert.throws(() => validate(candidate, { ...context, viewFactLedger: unavailableLedger,
    executionRoute: 'model', admittedFactIds: unavailableLedger.facts.map((fact) => fact.id) }),
  (error) => error.code === 'WMB_ADMITTED_FACT_OMITTED' && error.details.omittedFactIds.includes(unavailable.id),
  'unavailable optional facts cannot disappear either');
});

test('packet admission budgets complete narration and refuses an oversized mandatory witness early', async (t) => {
  const context = await fixture(t);
  const contract = structuredClone(context.contract);
  const ledger = structuredClone(context.viewFactLedger);
  const required = new Set([...ledger.requiredFactIds, ...ledger.requiredUnavailableFactIds,
    ...ledger.materialContradictionFactIds]);
  for (const fact of ledger.facts.filter((fact) => !required.has(fact.id))) {
    if (fact.status === 'unavailable') fact.reason.detail = 'Unavailable analysis. '.repeat(150);
    else fact.claim = 'Registered structural declaration. '.repeat(150);
  }
  const inputs = { viewContract: contract, viewFactLedger: ledger,
    scopeManifest: context.scopeManifest, evidenceCatalog: context.evidenceCatalog,
    consumerProfile: createWorldModelConsumerProfile(),
    outputBudget: createWorldModelViewOutputBudget(createWorldModelOutputBudget([contract]), contract) };
  const assembled = await assembleWmbV4Prompt(inputs);
  const admitted = ledger.facts.filter((fact) => assembled.admittedFactIds.includes(fact.id));
  assert.ok(deterministicArrangementFits(contract, admitted, { outputBudget: inputs.outputBudget }));
  assert.ok(assembled.factAdmission.excludedFacts.some((fact) => fact.reason === 'output-budget'));
  assert.equal(assembled.factAdmission.ledgerFactCount,
    assembled.factAdmission.admittedFactCount + assembled.factAdmission.excludedFacts.length);
  assert.ok([...required].every((id) => assembled.admittedFactIds.includes(id)));
  assert.ok(assertWmbV4PromptInputBudget(assembled.prompt, contract));
  inputs.outputBudget = structuredClone(inputs.outputBudget);
  inputs.outputBudget.viewBudgets[contract.id].maximumOutputTokens = 1;
  await assert.rejects(() => assembleWmbV4Prompt(inputs),
    (error) => error.code === 'WMB_OUTPUT_BUDGET_EXCEEDED' && error.details.mandatoryFacts === required.size);
});

test('composition validation accepts the registered candidate and refuses minted identities', async (t) => {
  const context = await fixture(t);
  const candidate = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  assert.equal(validate(candidate, context).receipt.status, 'passed');

  const semanticallyValidModelVariant = {
    ...structuredClone(candidate), tldrMarkdown: `${candidate.tldrMarkdown}\n`
  };
  assert.equal(validate(semanticallyValidModelVariant, {
    ...context,
    executionRoute: 'model',
    admittedFactIds: context.viewFactLedger.facts.map((fact) => fact.id)
  }).receipt.status, 'passed');
  assert.throws(
    () => validate(semanticallyValidModelVariant, context),
    (error) => error.code === 'WMB_DETERMINISTIC_CANDIDATE_MISMATCH'
  );

  const duplicate = structuredClone(candidate);
  duplicate.usedFactIds.push(duplicate.usedFactIds[0]);
  assert.throws(() => validate(duplicate, context), (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN');

  const mintedFact = structuredClone(candidate);
  mintedFact.tldrMarkdown = mintedFact.tldrMarkdown.replace(
    '[F:', 'FACT-ffffffffffffffff [F:'
  );
  assert.throws(() => validate(mintedFact, context), (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN');

  const mintedDerivation = structuredClone(candidate);
  mintedDerivation.tldrMarkdown = mintedDerivation.tldrMarkdown.replace(
    '[F:', 'DRV-ffffffffffffffff [F:'
  );
  assert.throws(() => validate(mintedDerivation, context), (error) => error.code === 'WMB_DERIVATION_INVALID');
});

test('scope validation accepts a registered source-file basename as a path, not a compound symbol', async (t) => {
  const base = await fixture(t);
  const contract = resolveBuiltInViewContract('arch.contracts@4');
  const registration = runDeterministicRegistration({
    root: base.root,
    scopeManifest: base.scopeManifest,
    requestedViews: ['arch.contracts@4']
  });
  const viewFactLedger = registration.viewFactLedgers[0];
  const appFact = viewFactLedger.facts.find((fact) => fact.claim?.includes('App.tsx'));
  assert.ok(appFact, 'fixture must expose a selected App.tsx fact');
  const candidate = renderDeterministicCandidate(contract, viewFactLedger);
  assert.match(JSON.stringify(candidate), /App\.tsx/);
  assert.equal(validateCompositionCandidate(candidate, {
    contract,
    viewFactLedger,
    evidenceCatalog: registration.evidenceCatalog,
    scopeManifest: base.scopeManifest
  }).receipt.status, 'passed');
});

test('model citation layout is repaired once and independently revalidated without changing facts', async (t) => {
  const context = await fixture(t);
  const canonical = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  const options = {
    ...context, executionRoute: 'model',
    admittedFactIds: context.viewFactLedger.facts.map((fact) => fact.id)
  };
  const ids = canonical.tldrMarkdown.match(/\[F:([^\]]+)\]$/)[1].split(',');
  assert.ok(ids.length >= 2);
  const facts = new Map(context.viewFactLedger.facts.map((fact) => [fact.id, fact]));
  for (const [name, text] of [
    ['per-sentence', ids.map((id) => `${canonicalFactSentence(facts.get(id))} [F:${id}]`).join(' ')],
    ['unsorted', [...ids].reverse().map((id) => canonicalFactSentence(facts.get(id))).join(' ') + ` [F:${[...ids].reverse().join(',')}]`],
    ['unsorted IDs only', canonical.tldrMarkdown.replace(`[F:${ids.join(',')}]`, `[F:${[...ids].reverse().join(',')}]`)],
    ['sentence order only', [...ids].reverse().map((id) => canonicalFactSentence(facts.get(id))).join(' ') + ` [F:${ids.join(',')}]`],
    ['duplicate IDs', canonical.tldrMarkdown.replace(`[F:${ids.join(',')}]`, `[F:${[...ids, ids[0]].join(',')}]`)],
    ['duplicate group', canonical.tldrMarkdown + ` [F:${ids.join(',')}]`],
    ['prefix', `[F:${ids.join(',')}] ` + canonical.tldrMarkdown.replace(/\s*\[F:[^\]]+\]$/, '')],
    ['wrapped paragraph', ids.map((id) => `${canonicalFactSentence(facts.get(id))} [F:${id}]`).join('\r\n')]
  ]) await t.test(name, () => {
    const malformed = { ...structuredClone(canonical), tldrMarkdown: text };
    const before = structuredClone(malformed);
    assert.throws(() => validateCompositionCandidate(malformed, options),
      (error) => ['WMB_FACT_REFERENCE_UNKNOWN', 'WMB_FACT_ASSURANCE_UPGRADED'].includes(error.code));
    const repaired = validateModelCompositionCandidate(JSON.stringify(malformed), options);
    assert.deepEqual(repaired.candidate, canonical);
    assert.deepEqual(malformed, before, 'the original provider output must be preserved');
    assert.equal(repaired.receipt.status, 'passed');
    assert.equal(repaired.formattingRepair.repairedUnits, 1);
    assert.notEqual(repaired.formattingRepair.originalCandidateSha256,
      repaired.formattingRepair.candidateSha256);
    assert.equal(validateCompositionCandidate(repaired.candidate, options).receipt.status, 'passed');
    assert.equal(validateModelCompositionCandidate(repaired.candidate, options).formattingRepair, undefined);
  });
  assert.equal(validateModelCompositionCandidate(canonical, options).formattingRepair, undefined);
});

test('citation repair never launders model claims, unknown identities, or missing obligations', async (t) => {
  const context = await fixture(t);
  const canonical = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  const options = {
    ...context, executionRoute: 'model',
    admittedFactIds: context.viewFactLedger.facts.map((fact) => fact.id)
  };
  const ids = canonical.tldrMarkdown.match(/\[F:([^\]]+)\]$/)[1].split(',');
  const facts = new Map(context.viewFactLedger.facts.map((fact) => [fact.id, fact]));
  const malformed = {
    ...structuredClone(canonical),
    tldrMarkdown: ids.map((id) => `${canonicalFactSentence(facts.get(id))} [F:${id}]`).join(' ')
  };
  const cases = [
    ['invented claim', (candidate) => { candidate.tldrMarkdown = `All runtime guarantees are proven. ${candidate.tldrMarkdown}`; }],
    ['unknown reference', (candidate) => { candidate.tldrMarkdown += ' [F:FACT-ffffffffffffffff]'; }],
    ['usedFactIds mismatch', (candidate) => { candidate.usedFactIds.pop(); }],
    ['missing reference', (candidate) => { candidate.sections[0].markdown = 'Invented uncited statement.'; }],
    ['schema mismatch', (candidate) => { candidate.unregisteredField = true; }],
    ['missing section', (candidate) => { candidate.sections.pop(); }],
    ['body access', (candidate) => { candidate.sections[0].markdown = '```js\nconst leaked = true;\n```'; }],
    ['minted metadata', (candidate) => { candidate.title = 'generated-at: 2026-01-01T00:00:00Z'; }]
  ];
  for (const [name, alter] of cases) await t.test(name, () => {
    const candidate = structuredClone(malformed);
    alter(candidate);
    assert.throws(() => validateModelCompositionCandidate(candidate, options));
  });
  assert.throws(() => validateModelCompositionCandidate(malformed, context),
    (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN',
    'the deterministic path never repairs model formatting');
  assert.throws(() => validateModelCompositionCandidate(malformed, {
    ...options, admittedFactIds: options.admittedFactIds.filter((id) => id !== ids[0])
  }), (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN');
  assert.throws(() => validateModelCompositionCandidate(malformed, {
    ...options, admittedFactIds: { invalid: true }
  }), (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN',
  'an invalid admission boundary must retain its typed refusal, not crash during repair');
});

test('deny-by-default body and kernel metadata guards cover alternate Markdown forms', async (t) => {
  const context = await fixture(t);
  const candidate = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  const factRef = `[F:${candidate.usedFactIds[0]}]`;

  for (const [forbidden, code] of [
    [`~~~js ${factRef}\nconst leaked = true; ${factRef}\n~~~ ${factRef}`, 'WMB_SOURCE_BODY_FORBIDDEN'],
    [`    const leaked = true; ${factRef}`, 'WMB_SOURCE_BODY_FORBIDDEN'],
    [`generated-at: 2026-01-01T00:00:00Z ${factRef}`, 'WMB_KERNEL_METADATA_FORBIDDEN']
  ]) {
    const changed = structuredClone(candidate);
    changed.sections[0].markdown = `${changed.sections[0].markdown}\n${forbidden}`;
    assert.throws(
      () => validate(changed, context),
      (error) => error.code === code,
      forbidden
    );
  }
});

test('scope validation refuses unquoted excluded paths and invented compound symbols', async (t) => {
  const context = await fixture(t);
  const candidate = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  const factRef = `[F:${candidate.usedFactIds[0]}]`;
  for (const [claim, token] of [
    [`src/admin/secrets.ts contains credentials. ${factRef}`, 'src/admin/secrets.ts'],
    [`PaymentGateway.stealSecret is called. ${factRef}`, 'PaymentGateway.stealSecret'],
    [`Hidden.tsx#Fake is called. ${factRef}`, 'Hidden.tsx#Fake']
  ]) {
    const changed = structuredClone(candidate);
    changed.sections[0].markdown = claim;
    assert.throws(
      () => validate(changed, context),
      (error) => error.code === 'WMB_SCOPE_VIOLATION' && error.details.token === token
    );
  }
});

test('the assurance template rejects counterfeit prose even when it borrows a valid Fact reference', async (t) => {
  const context = await fixture(t);
  const candidate = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  const factRef = `[F:${candidate.usedFactIds[0]}]`;
  for (const counterfeit of [
    `HiddenAdmin performs privileged work. ${factRef}`,
    `README.md is the production entry point. ${factRef}`,
    `pom.xml authorizes deployment. ${factRef}`,
    `secrets.yml contains a credential. ${factRef}`,
    `sha256:${'f'.repeat(64)} is the approved source. ${factRef}`,
    `Every transfer is safe. ${factRef}`
  ]) {
    const changed = structuredClone(candidate);
    changed.sections[0].markdown = counterfeit;
    assert.throws(
      () => validate(changed, context),
      (error) => [
        'WMB_FACT_ASSURANCE_UPGRADED', 'WMB_SCOPE_VIOLATION',
        'WMB_KERNEL_METADATA_FORBIDDEN'
      ].includes(error.code),
      counterfeit
    );
  }
});

test('material contradictions render and validate only in the registered contradiction section', async (t) => {
  const base = await fixture(t);
  const registration = runDeterministicRegistration({
    root: base.root,
    scopeManifest: base.scopeManifest,
    requestedViews: ['arch.contracts@4']
  });
  const contract = resolveBuiltInViewContract('arch.contracts@4');
  const eligibleTypes = new Set([
    ...contract.factPolicy.requiredFactTypes,
    ...contract.factPolicy.optionalFactTypes,
    ...contract.factPolicy.requiredUnavailableSubjects
  ]);
  const available = registration.factLedger.facts.filter(
    (fact) => fact.status === 'available' && eligibleTypes.has(fact.factType)
  );
  const subject = available[0];
  const conflicting = available.find((fact) => fact.id !== subject.id);
  assert.ok(subject && conflicting);
  const contradictionDraft = {
    ...factIdentityFromRecord(subject),
    claim: `${subject.subject.id} has conflicting registered structural observations.`,
    status: 'contradicted',
    conflictsWith: [conflicting.id]
  };
  const factLedger = createFactLedger({
    sourceSnapshot: registration.sourceSnapshot,
    scopeManifest: registration.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    evidenceCatalog: registration.evidenceCatalog,
    derivationIds: new Set(registration.derivationCatalog.derivations.map((entry) => entry.id)),
    factDrafts: [
      ...registration.factLedger.facts.map(factIdentityFromRecord), contradictionDraft
    ]
  });
  const viewFactLedger = selectViewFacts({ factLedger, viewContract: contract });
  const contradictionId = viewFactLedger.materialContradictionFactIds[0];
  assert.ok(contradictionId);
  const candidate = renderDeterministicCandidate(contract, viewFactLedger);
  const contradictionSection = candidate.sections.find(
    (section) => section.sectionId === 'contract-contradictions'
  );
  assert.match(contradictionSection.markdown, new RegExp(contradictionId));
  assert.equal(validate(candidate, {
    contract, viewFactLedger, scopeManifest: base.scopeManifest,
    evidenceCatalog: registration.evidenceCatalog
  }).receipt.status, 'passed');

  const misplaced = structuredClone(candidate);
  const contradictionLine = misplaced.sections
    .find((section) => section.sectionId === 'contract-contradictions')
    .markdown.split('\n').find((line) => line.includes(contradictionId));
  misplaced.sections.find((section) => section.sectionId === 'contract-contradictions')
    .markdown = misplaced.sections.find((section) => section.sectionId === 'contract-contradictions')
      .markdown.split('\n').filter((line) => !line.includes(contradictionId)).join('\n');
  misplaced.sections.find((section) => section.sectionId === 'public-contracts')
    .markdown += `\n${contradictionLine}`;
  assert.throws(
    () => validate(misplaced, {
      contract, viewFactLedger, scopeManifest: base.scopeManifest,
      evidenceCatalog: registration.evidenceCatalog
    }),
    (error) => error.code === 'WMB_CONTRADICTION_SUPPRESSED'
  );
});

test('each prompt contains only its view budget, admitted Facts, and evidence descriptors', async (t) => {
  const context = await fixture(t);
  const architecture = resolveBuiltInViewContract('arch.contracts@4');
  const aggregateBudget = createWorldModelOutputBudget([context.contract, architecture]);
  const viewBudget = createWorldModelViewOutputBudget(aggregateBudget, context.contract);
  const assembled = await assembleWmbV4Prompt({
    viewContract: context.contract,
    scopeManifest: context.scopeManifest,
    viewFactLedger: context.viewFactLedger,
    evidenceCatalog: context.evidenceCatalog,
    consumerProfile: createWorldModelConsumerProfile(),
    outputBudget: viewBudget
  });

  assert.deepEqual(Object.keys(viewBudget.viewBudgets), ['dev.impact']);
  assert.doesNotMatch(assembled.prompt, /arch\.contracts/);
  const boundary = assembled.prompt.indexOf(WMB_V4_REQUEST_BOUNDARY);
  for (const heading of [
    '## Fact Reference Grammar', '## Composition Candidate Schema',
    '## Registered View Contract'
  ]) {
    assert.ok(assembled.prompt.indexOf(heading) >= 0);
    assert.ok(assembled.prompt.indexOf(heading) < boundary, `${heading} must be stable above REQUEST INPUTS`);
  }
  for (const heading of [
    '## Consumer Profile', '## Output Budget', '## Scope Manifest',
    '## Composition Fact Packet', '## Evidence Catalog'
  ]) assert.ok(assembled.prompt.indexOf(heading) > boundary, `${heading} must remain in the volatile tail`);
  assert.match(assembled.prompt, /world-model-composition-candidate/);
  assert.match(assembled.prompt, /world-model-composition-fact-packet/);
  assert.doesNotMatch(assembled.prompt, /"kind":"world-model-view-fact-ledger"/);
  assert.match(assembled.prompt, /Every factual unit ends with exactly one trailing reference group/);
  assert.doesNotMatch(assembled.prompt, /\{\{[a-z_]+\}\}/);
  const admittedFactIds = new Set(assembled.admittedFactIds);
  const selectedEvidenceIds = new Set(
    context.viewFactLedger.facts
      .filter((fact) => admittedFactIds.has(fact.id))
      .flatMap((fact) => fact.evidenceIds)
  );
  assert.ok(selectedEvidenceIds.size > 0);
  for (const item of context.evidenceCatalog.items) {
    assert.equal(assembled.prompt.includes(item.id), selectedEvidenceIds.has(item.id), item.id);
  }
});

test('every v4 view prompt supplies the exact canonical usedFactIds list and narrative self-check', async (t) => {
  const base = await fixture(t);
  const registration = runDeterministicRegistration({
    root: base.root, scopeManifest: base.scopeManifest,
    requestedViews: BUILTIN_VIEW_REFERENCES
  });
  for (const reference of BUILTIN_VIEW_REFERENCES) {
    const contract = resolveBuiltInViewContract(reference);
    const viewFactLedger = registration.viewFactLedgers.find((ledger) => ledger.viewId === contract.id);
    const assembled = await assembleWmbV4Prompt({
      viewContract: contract, scopeManifest: base.scopeManifest, viewFactLedger,
      evidenceCatalog: registration.evidenceCatalog,
      consumerProfile: createWorldModelConsumerProfile(),
      outputBudget: createWorldModelViewOutputBudget(createWorldModelOutputBudget([contract]), contract)
    });
    const packet = JSON.parse(assembled.regions.find((region) => region.id === 'composition-fact-packet').text);
    const expected = [...new Set(packet.facts.map((fact) => fact.id))].sort();
    assert.deepEqual(packet.expectedUsedFactIds, expected, reference);
    assert.deepEqual(packet.expectedUsedFactIds, assembled.admittedFactIds, reference);
    assert.ok(packet.facts.filter((fact) => fact.status === 'unavailable')
      .every((fact) => packet.expectedUsedFactIds.includes(fact.id)), reference);
    assert.ok(assembled.omittedFactIds.every((id) => !packet.expectedUsedFactIds.includes(id)), reference);
    const instructions = assembled.prompt.slice(0, assembled.prompt.indexOf(WMB_V4_REQUEST_BOUNDARY))
      .replace(/\s+/g, ' ');
    assert.match(instructions, /`usedFactIds` must exactly copy `Composition Fact Packet.expectedUsedFactIds`/);
    assert.match(instructions, /every admitted ID once, case unchanged, in ascending lexical order/);
    assert.match(instructions, /`tldrMarkdown` and every `sections\[\]\.markdown`/);
    assert.match(instructions, /do not shorten the expected list/);
    assert.match(instructions, /Ledger facts omitted from the bounded packet are not admitted/);
    assert.ok(assertWmbV4PromptInputBudget(assembled.prompt, contract));
    const candidate = renderDeterministicCandidate(contract, {
      ...viewFactLedger, facts: packet.facts
    });
    candidate.usedFactIds = [...packet.expectedUsedFactIds];
    const options = { contract, scopeManifest: base.scopeManifest, viewFactLedger,
      evidenceCatalog: registration.evidenceCatalog, executionRoute: 'model',
      admittedFactIds: assembled.admittedFactIds };
    assert.equal(validateModelCompositionCandidate(candidate, options).receipt.status, 'passed', reference);
    const reordered = structuredClone(candidate);
    reordered.usedFactIds.reverse();
    assert.ok(reordered.usedFactIds.length > 1, reference);
    assert.throws(() => validateModelCompositionCandidate(reordered, options),
      (error) => error.code === 'WMB_FACT_REFERENCE_UNKNOWN'
        && error.message === 'usedFactIds must equal the exact referenced Fact set.', reference);
  }
});

test('mandatory-only prompt overflow is a typed input-budget refusal', async (t) => {
  const base = await fixture(t);
  const contract = resolveBuiltInViewContract('arch.contracts@4');
  const registration = runDeterministicRegistration({
    root: base.root,
    scopeManifest: base.scopeManifest,
    requestedViews: ['arch.contracts@4']
  });
  const viewFactLedger = structuredClone(registration.viewFactLedgers[0]);
  const mandatoryId = viewFactLedger.requiredFactIds[0];
  const mandatoryFact = viewFactLedger.facts.find((fact) => fact.id === mandatoryId);
  assert.ok(mandatoryFact, 'fixture must expose a required architecture Fact');
  // Overflow input-only metadata: inflating a canonical claim instead hits the independent
  // output-admission guard before this test can exercise the input ceiling.
  const evidenceCatalog = structuredClone(registration.evidenceCatalog);
  const mandatoryEvidence = evidenceCatalog.items.find((item) => mandatoryFact.evidenceIds.includes(item.id));
  assert.ok(mandatoryEvidence, 'required Fact must supply an admitted evidence descriptor');
  mandatoryEvidence.locator.symbol = `Mandatory architecture evidence ${'x'.repeat(40_000)}`;

  const aggregateBudget = createWorldModelOutputBudget([contract]);
  const assembled = await assembleWmbV4Prompt({
    viewContract: contract,
    scopeManifest: base.scopeManifest,
    viewFactLedger,
    evidenceCatalog,
    consumerProfile: createWorldModelConsumerProfile(),
    outputBudget: createWorldModelViewOutputBudget(aggregateBudget, contract)
  });

  const mandatoryIds = [...new Set([
    ...viewFactLedger.requiredFactIds,
    ...viewFactLedger.requiredUnavailableFactIds,
    ...viewFactLedger.materialContradictionFactIds
  ])].sort();
  assert.deepEqual(assembled.admittedFactIds, mandatoryIds);
  assert.throws(
    () => assertWmbV4PromptInputBudget(assembled.prompt, contract),
    (error) => error.code === 'WMB_INPUT_BUDGET_EXCEEDED'
      && error.details.estimatedInputTokens > error.details.maximumInputTokens
  );
});

test('sealed execution identity and materialized route stamp must agree', () => {
  const deterministicExecution = {
    executionUnitManifestSha256: WMB_V4_DETERMINISTIC_EXECUTION_SHA256
  };
  const modelExecution = {
    executionUnitManifestSha256: worldModelExecutionUnitManifestSha256({
      route: 'model', provider: 'copilot-cli', requestedModel: 'provider-model'
    })
  };
  assert.notEqual(modelExecution.executionUnitManifestSha256,
    worldModelExecutionUnitManifestSha256({
      route: 'model', provider: 'copilot-cli', requestedModel: 'other-model'
    }));
  const unknownExecution = {
    executionUnitManifestSha256: `sha256:${'a'.repeat(64)}`
  };
  const deterministicStamp = {
    executionUnit: 'deterministic-renderer@1', model: 'unavailable'
  };
  const modelStamp = createWorldModelExecutionStamp({
    route: 'model', provider: 'copilot-cli', requestedModel: 'provider-model',
    observedModel: 'provider-model', invocationId: 'invocation-1'
  });

  assert.equal(verifiedWorldModelExecutionRoute(
    deterministicExecution, deterministicStamp
  ), 'deterministic');
  assert.equal(verifiedWorldModelExecutionRoute(modelExecution, modelStamp), 'model');
  assert.equal(verifiedWorldModelExecutionRoute(modelExecution, modelStamp, {
    route: 'model', provider: 'copilot-cli', requestedModel: 'provider-model',
    observedModel: 'provider-model'
  }), 'model');
  assert.equal(verifiedWorldModelExecutionRoute(modelExecution, modelStamp, {
    route: 'model', provider: 'copilot-cli', requestedModel: 'other-model'
  }), null);
  assert.equal(verifiedWorldModelExecutionRoute(unknownExecution, modelStamp), null);
  assert.equal(verifiedWorldModelExecutionRoute(deterministicExecution, modelStamp), null);
  assert.equal(verifiedWorldModelExecutionRoute(modelExecution, deterministicStamp), null);
});

test('model execution stamps reject non-canonical, oversized, and unknown-provider profiles', () => {
  const execution = {
    executionUnitManifestSha256: worldModelExecutionUnitManifestSha256({
      route: 'model', provider: 'copilot-cli', requestedModel: 'fixture-model'
    })
  };
  const stamp = createWorldModelExecutionStamp({
    route: 'model', provider: 'copilot-cli', requestedModel: 'fixture-model',
    observedModel: 'fixture-model', invocationId: 'invoke-1'
  });
  const [, encoded, invocationId] = stamp.executionUnit.split(':');
  const unknownProvider = Buffer.from(JSON.stringify({
    provider: 'not-installed', requestedModel: 'fixture-model'
  })).toString('base64url');
  assert.equal(verifiedWorldModelExecutionRoute(execution, {
    ...stamp, executionUnit: `governed-model-composer@1:${unknownProvider}:${invocationId}`
  }), null);
  assert.equal(verifiedWorldModelExecutionRoute(execution, {
    ...stamp, executionUnit: `governed-model-composer@1:${encoded}${'A'.repeat(800)}:${invocationId}`
  }), null);
  assert.equal(verifiedWorldModelExecutionRoute(execution, {
    ...stamp, model: 'x'.repeat(257)
  }), null);
  assert.throws(() => createWorldModelExecutionStamp({
    route: 'deterministic', provider: 'copilot-cli'
  }));
});

test('deterministic placement files each fact under the section that names its type', async (t) => {
  const base = await fixture(t);
  const registration = runDeterministicRegistration({
    root: base.root,
    scopeManifest: base.scopeManifest,
    requestedViews: ['arch.contracts@4']
  });
  const contract = resolveBuiltInViewContract('arch.contracts@4');
  const viewFactLedger = selectViewFacts({ factLedger: registration.factLedger, viewContract: contract });
  const candidate = renderDeterministicCandidate(contract, viewFactLedger);
  // The summary may cite any fact; placement is about the registered body sections.
  const body = candidate.sections.filter((section) => contract.sections.some((entry) => (
    entry.id === section.sectionId && !['summary', 'contradiction', 'unavailable'].includes(entry.sectionKind)
  )));
  const sectionOf = (factId) => body.find((section) => section.markdown.includes(factId))?.sectionId ?? null;
  const expected = {
    interface: 'public-contracts', signature: 'public-contracts', 'schema-contract': 'public-contracts',
    'protocol-field': 'public-contracts', implementation: 'implementations', 'consumer-dependency': 'consumers'
  };
  const typed = viewFactLedger.facts.filter((fact) => fact.status === 'available' && expected[fact.factType]);
  assert.ok(typed.length, 'the fixture yields facts of section-named types');
  for (const fact of typed) assert.equal(sectionOf(fact.id), expected[fact.factType], `${fact.factType} ${fact.id}`);
  assert.equal(validate(candidate, {
    contract, viewFactLedger, scopeManifest: base.scopeManifest,
    evidenceCatalog: registration.evidenceCatalog
  }).receipt.status, 'passed');
});

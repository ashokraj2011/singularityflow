import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleWmbV4Prompt } from '../src/world-model/compose/pinned-core.mjs';
import { renderDeterministicCandidate } from '../src/world-model/compose/candidate.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget,
  createWorldModelViewOutputBudget
} from '../src/world-model/plan.mjs';
import { resolveBuiltInViewContract } from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { validateCompositionCandidate } from '../src/world-model/validate/candidate.mjs';

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
    contract: resolveBuiltInViewContract('dev.impact@4'),
    scopeManifest,
    evidenceCatalog: registration.evidenceCatalog,
    viewFactLedger: registration.viewFactLedgers[0]
  };
}

function validate(candidate, context) {
  return validateCompositionCandidate(candidate, context);
}

test('composition validation accepts the registered candidate and refuses minted identities', async (t) => {
  const context = await fixture(t);
  const candidate = renderDeterministicCandidate(context.contract, context.viewFactLedger);
  assert.equal(validate(candidate, context).receipt.status, 'passed');

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
    [`PaymentGateway.stealSecret is called. ${factRef}`, 'PaymentGateway.stealSecret']
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

test('each prompt contains only its view budget and referenced evidence descriptors', async (t) => {
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
  const selectedEvidenceIds = new Set(
    context.viewFactLedger.facts.flatMap((fact) => fact.evidenceIds)
  );
  assert.ok(selectedEvidenceIds.size > 0);
  for (const item of context.evidenceCatalog.items) {
    assert.equal(assembled.prompt.includes(item.id), selectedEvidenceIds.has(item.id), item.id);
  }
});

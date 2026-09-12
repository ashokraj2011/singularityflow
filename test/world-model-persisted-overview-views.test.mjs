import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES, PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES,
  renderPersistedOverviewView as renderPersistedOverviewViewRuntime
} from '../src/world-model/materialize/overview-view.mjs';
import {
  BUILTIN_VIEW_REFERENCES, normalizeBuiltInViewReference, normalizeWmpOverviewViewReference,
  resolveWmpOverviewViewContract, WMP_OVERVIEW_VIEW_ALIASES, WMP_OVERVIEW_VIEW_REFERENCES,
  WMP_OVERVIEW_VIEW_REGISTRY
} from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';

const MODEL_PAYLOAD_SHA256 = sha256({ kind: 'fixture-model-payload', version: 1 });
const VIEW_INPUTS_SHA256 = sha256({ kind: 'fixture-view-inputs', version: 1 });

function renderPersistedOverviewView(options) {
  return renderPersistedOverviewViewRuntime({
    modelPayloadSha256: MODEL_PAYLOAD_SHA256,
    viewInputsSha256: VIEW_INPUTS_SHA256,
    ...options
  });
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t, requestedView = 'repository.development@1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-overview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMP Overview Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  for (let index = 0; index < 16; index += 1) {
    await writeFile(
      path.join(root, 'src', `module-${String(index).padStart(2, '0')}.mjs`),
      `export function module${index}(value) { return value + ${index}; }\n`
    );
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const scopeManifest = createScopeManifest({
    capabilityId: 'overview-fixture',
    allowedPaths: ['src/**'],
    allowedSubjects: ['analysis', 'dependency-edge', 'file', 'symbol']
  });
  const registration = runDeterministicRegistration({
    root,
    scopeManifest,
    requestedViews: [requestedView],
    viewRegistry: WMP_OVERVIEW_VIEW_REGISTRY
  });
  return {
    sourceFactLedger: registration.factLedger,
    viewFactLedger: registration.viewFactLedgers[0]
  };
}

test('all five persisted overview contracts have a compatible deterministic extraction route', async (t) => {
  for (const reference of WMP_OVERVIEW_VIEW_REFERENCES) {
    const { viewFactLedger } = await fixture(t, reference);
    assert.equal(viewFactLedger.viewId, reference.replace(/@1$/, ''), reference);
  }
});

const capturedGaps = Object.freeze([
  Object.freeze({
    id: 'runtime-report',
    status: 'unavailable',
    reason: 'No report\r\n<script>alert(1)</script> [Run](command:unsafe)',
    inputSha256: `sha256:${'a'.repeat(64)}`
  }),
  Object.freeze({
    id: 'ownership-window',
    status: 'not-applicable',
    reason: 'No approved history window was captured.'
  })
]);

test('persisted overview registry is additive, exact, model-never, and aliases stay WMP-scoped', () => {
  assert.deepEqual(BUILTIN_VIEW_REFERENCES, [
    'arch.contracts@4', 'biz.rules@4', 'dev.hotspots@4', 'dev.impact@4'
  ]);
  assert.deepEqual(WMP_OVERVIEW_VIEW_REFERENCES, [
    'repository.architecture@1',
    'repository.business@1',
    'repository.development@1',
    'repository.security@1',
    'repository.testing@1'
  ]);
  assert.deepEqual(Object.keys(WMP_OVERVIEW_VIEW_ALIASES).sort(), [
    'architecture', 'business', 'development', 'security', 'testing'
  ]);
  for (const reference of WMP_OVERVIEW_VIEW_REFERENCES) {
    const contract = resolveWmpOverviewViewContract(reference);
    assert.equal(contract.version, 1);
    assert.equal(contract.model.mode, 'never');
    assert.equal(contract.bodyAccess.allowed, false);
    assert.equal(contract.crossViewReferences.allowed, false);
    assert.ok(contract.sections.every((section) => section.required));
  }
  assert.equal(normalizeWmpOverviewViewReference('business').reference, 'repository.business@1');
  assert.equal(
    normalizeWmpOverviewViewReference('repository.business').reference,
    'repository.business@1'
  );
  assert.throws(
    () => normalizeBuiltInViewReference('business'),
    (error) => error.code === 'WMB_VIEW_UNKNOWN'
  );
  assert.throws(
    () => normalizeWmpOverviewViewReference('biz.rules@4'),
    (error) => error.code === 'WMP_VIEW_UNKNOWN'
  );
});

test('persisted overview rendering is deterministic, explicit about gaps, and inert', async (t) => {
  const { sourceFactLedger, viewFactLedger } = await fixture(t);
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  globalThis.fetch = () => { throw new Error('renderer attempted network access'); };
  Math.random = () => { throw new Error('renderer attempted random access'); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  });

  const first = renderPersistedOverviewView({
    view: 'development', sourceFactLedger, viewFactLedger,
    capturedInputGaps: capturedGaps, outputFormat: 'md'
  });
  const second = renderPersistedOverviewView({
    view: 'repository.development@1',
    sourceFactLedger,
    viewFactLedger,
    capturedInputGaps: [...capturedGaps].reverse(),
    outputFormat: 'md'
  });
  assert.equal(first.content, second.content);
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(first.payloadSha256, sha256(Buffer.from(first.content, 'utf8')));
  assert.equal(first.bytes, Buffer.byteLength(first.content, 'utf8'));
  assert.ok(first.content.endsWith('\n'));
  assert.doesNotMatch(first.content, /\r|generated-at|<script>|\]\(command:/i);
  assert.match(first.content, /runtime\\-report/);
  assert.match(first.content, /command&#58;unsafe/);
  assert.ok(first.gaps.some((gap) => gap.id === 'runtime-report'));
  assert.ok(first.gaps.some((gap) => gap.status === 'unavailable' && gap.factId));
  assert.deepEqual(first.selectedFactIds, [...first.selectedFactIds].sort());
  assert.equal(first.selectedFactIds.length, viewFactLedger.facts.length);
  assert.equal(first.omittedFactIds.length, 0);

  const json = renderPersistedOverviewView({
    view: 'development', sourceFactLedger, viewFactLedger,
    capturedInputGaps: capturedGaps, outputFormat: 'json'
  });
  assert.doesNotMatch(json.content, /<script>|<\/script>/i);
  const parsed = JSON.parse(json.content);
  assert.equal(parsed.view.reference, 'repository.development@1');
  assert.equal(parsed.gaps.find((gap) => gap.id === 'runtime-report').reason.includes('<script>'), true);
  assert.equal(parsed.selection.selectedFacts, viewFactLedger.facts.length);
  assert.equal(parsed.selection.modelPayloadSha256, MODEL_PAYLOAD_SHA256);
  assert.equal(parsed.selection.viewInputsSha256, VIEW_INPUTS_SHA256);
  assert.match(parsed.selection.expansionHandle, /^wmp-view:sha256:[a-f0-9]{64}$/);

  const changedInputs = renderPersistedOverviewView({
    view: 'development', sourceFactLedger, viewFactLedger,
    capturedInputGaps: [{ ...capturedGaps[0], reason: 'A different captured limitation.' }],
    outputFormat: 'json'
  });
  assert.notEqual(
    JSON.parse(changedInputs.content).selection.expansionHandle,
    parsed.selection.expansionHandle,
    'the expansion handle must change with exact captured inputs'
  );

  const source = await readFile(
    new URL('../src/world-model/materialize/overview-view.mjs', import.meta.url), 'utf8'
  );
  assert.doesNotMatch(source, /from ['"]node:(?:child_process|fs|http|https|net|tls)['"]/);
  assert.doesNotMatch(source, /\b(?:fetch|request\.model|Date\.now|Math\.random)\s*\(/);
});

test('brief selection is byte-bounded, preserves limitations, and reports omissions', async (t) => {
  const { sourceFactLedger, viewFactLedger } = await fixture(t);
  const brief = renderPersistedOverviewView({
    view: 'development',
    sourceFactLedger,
    viewFactLedger,
    capturedInputGaps: capturedGaps,
    variant: 'brief',
    outputFormat: 'md'
  });
  assert.ok(brief.bytes <= PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES);
  assert.ok(brief.omittedFactIds.length > 0);
  for (const fact of viewFactLedger.facts.filter((entry) => ['unavailable', 'contradicted'].includes(entry.status))) {
    assert.ok(brief.selectedFactIds.includes(fact.id), `missing limitation ${fact.id}`);
  }
  assert.match(brief.content, new RegExp(`${brief.omittedFactIds.length} omitted`));

  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger, capturedInputGaps: capturedGaps,
      variant: 'brief', maximumBytes: 1
    }),
    (error) => error.code === 'WMP_BUDGET_TOO_SMALL'
      && error.details.neededBytes > error.details.maximumBytes
  );
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger, variant: 'brief',
      maximumBytes: PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES + 1
    })
  );
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger,
      maximumBytes: PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES + 1
    })
  );
});

test('renderer rejects unverified ledgers and malformed or duplicate captured gaps', async (t) => {
  const { sourceFactLedger, viewFactLedger } = await fixture(t);
  const tampered = structuredClone(viewFactLedger);
  const fact = tampered.facts.find((entry) => entry.claim !== null);
  fact.claim = `${fact.claim} invented`;
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger: tampered
    }),
    (error) => error.code === 'WMB_RECORD_HASH_MISMATCH'
  );
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger,
      capturedInputGaps: [capturedGaps[0], capturedGaps[0]]
    }),
    (error) => error.code === 'WMP_VIEW_INPUT_GAP_INVALID'
  );
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger,
      capturedInputGaps: [{ id: 'runtime-report', status: 'available', reason: 'not a gap' }]
    }),
    (error) => error.code === 'WMP_VIEW_INPUT_GAP_INVALID'
  );
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'business', sourceFactLedger, viewFactLedger
    }),
    (error) => error.code === 'WMB_VIEW_CONTRACT_MISMATCH'
  );

  assert.throws(
    () => renderPersistedOverviewView({ view: 'development', viewFactLedger }),
    (error) => error.code === 'WMP_SOURCE_FACT_LEDGER_REQUIRED'
  );
  assert.throws(
    () => renderPersistedOverviewViewRuntime({
      view: 'development', sourceFactLedger, viewFactLedger
    }),
    (error) => error.code === 'WMB_CONTRACT_INVALID'
  );

  const omittedRequired = viewFactLedger.requiredUnavailableFactIds[0];
  assert.ok(omittedRequired, 'fixture must include a required unavailable Fact');
  const resealed = sealRecord({
    ...structuredClone(viewFactLedger),
    facts: viewFactLedger.facts.filter((fact) => fact.id !== omittedRequired),
    requiredUnavailableFactIds: viewFactLedger.requiredUnavailableFactIds
      .filter((id) => id !== omittedRequired)
  }, 'ledgerSha256');
  assert.throws(
    () => renderPersistedOverviewView({
      view: 'development', sourceFactLedger, viewFactLedger: resealed
    }),
    (error) => error.code === 'WMB_SELECTION_INVALID'
  );
});

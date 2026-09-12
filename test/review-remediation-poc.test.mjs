import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { evaluateArchitectureIntentGate } from '../src/architecture-intent-gate.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { publishToStateBranch } from '../src/ledger.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';
import { resolveStoryExecutionContext } from '../src/story-execution-context.mjs';
import { run } from '../src/util.mjs';
import { assembleWmbV4Prompt } from '../src/world-model/compose/pinned-core.mjs';
import { renderDeterministicCandidate } from '../src/world-model/compose/candidate.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createDerivationCatalog, derivationIdentityFromRecord
} from '../src/world-model/extract/derivation-catalog.mjs';
import {
  createFactLedger, factIdentityFromRecord
} from '../src/world-model/extract/fact-ledger.mjs';
import { selectViewFacts } from '../src/world-model/extract/selection.mjs';
import {
  materializeWorldModelView, usageObservation
} from '../src/world-model/materialize/view.mjs';
import {
  buildWorldModelManifest, deriveWorldModelManifestDependencies
} from '../src/world-model/publish/manifest.mjs';
import { stageWorldModelPublication } from '../src/world-model/publish/transaction.mjs';
import {
  buildCalmProjection, validateCalmProjectionCandidate
} from '../src/world-model/projections/calm/projection.mjs';
import {
  createWorldModelViewOutputBudget
} from '../src/world-model/plan.mjs';
import {
  WMB_V4_DETERMINISTIC_EXECUTION_SHA256, WMB_V4_CANDIDATE_SCHEMA_SHA256,
  WMB_V4_VALIDATOR_SHA256
} from '../src/world-model/runtime.mjs';
import { validateCompositionCandidate } from '../src/world-model/validate/candidate.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args, options = {}) {
  return run('git', args, { cwd: root, ...options }).stdout.trim();
}

function invoke(env, cwd, args, { expectStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 180_000
  });
  assert.equal(result.status, expectStatus,
    `singularity-flow ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function invokeJson(env, cwd, args) {
  const result = invoke(env, cwd, [...args, '--json']);
  try { return JSON.parse(result.stdout); }
  catch (error) {
    assert.fail(`Command did not return JSON (${error.message}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function quiet(operation) {
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try { return await operation(); }
  finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
}

async function createAuthorityRemote(base) {
  const seed = path.join(base, 'authority-seed');
  const remote = path.join(base, 'authority.git');
  await mkdir(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.name', 'Authority Bootstrap']);
  git(seed, ['config', 'user.email', 'authority.bootstrap@example.invalid']);
  await writeFile(path.join(seed, 'README.md'), '# Review remediation authority\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'authority baseline']);
  git(base, ['clone', '-q', '--bare', seed, remote]);
  return { seed, remote };
}

async function customizeCapabilityProposal(root, branch) {
  git(root, ['fetch', '-q', 'origin', branch]);
  git(root, ['switch', '-q', '-c', branch, `origin/${branch}`]);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.git.publish = 'required';
  workflow.approvalSecurity = {
    profile: 'poc', allowSelfApproval: true, autoEnrollNewIdentities: false
  };
  workflow.worldModel.format = 'registered-v4';
  workflow.worldModel.promptSource = 'builtin';
  workflow.worldModel.grounding = 'off';
  workflow.worldModel.views = ['dev.impact'];
  workflow.worldModel.v4 = {
    composer: 'deterministic', consumer: 'developer', cachePolicy: 'reuse-valid',
    totalMaximumOutputTokens: 1400
  };
  workflow.worldModel.projections['arch.calm'].enabled = true;
  workflow.architectureIntent = {
    enabled: true,
    allowedPhases: ['planning'],
    blockRequiredUnfulfilledAt: ['verification']
  };
  for (const authority of Object.values(workflow.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  delete workflow.phases.planning.artifactSet;
  workflow.workTypes['review-remediation-poc'] = {
    label: 'Review remediation POC',
    description: 'Exercises the complete saved-Story architecture path.',
    phases: ['planning', 'verification'],
    phaseOverrides: {
      planning: { inputs: [] },
      verification: {
        inputs: ['planning'],
        approval: { rejectTo: ['planning', 'verification'] }
      }
    }
  };
  for (const phase of Object.values(workflow.phases)) {
    if (phase.worldModel?.views?.length) phase.worldModel.views = ['dev.impact'];
  }
  await writeFile(workflowPath, YAML.stringify(workflow));
  const agentDirectory = path.join(root, '.github', 'agents');
  for (const name of await readdir(agentDirectory)) {
    if (!name.endsWith('.agent.md')) continue;
    const target = path.join(agentDirectory, name);
    const source = await readFile(target, 'utf8');
    await writeFile(target, source.replace(
      /sflow-world-model-views: "[^"]*"/,
      'sflow-world-model-views: "dev.impact"'
    ));
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'review POC workflow policy']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  git(root, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  git(root, ['switch', '-q', 'main']);
  return commit;
}

async function createDeliveryRemote(base) {
  const seed = path.join(base, 'delivery-seed');
  const remote = path.join(base, 'delivery.git');
  await mkdir(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.name', 'Application Bootstrap']);
  git(seed, ['config', 'user.email', 'application.bootstrap@example.invalid']);
  await writeFile(path.join(seed, 'app.mjs'), 'export const serviceName = "poc-service";\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-q', '-m', 'application baseline']);
  git(base, ['clone', '-q', '--bare', seed, remote]);
  return { seed, remote };
}

async function writePhaseArtifact(root, accepted, phaseId, detail) {
  const phase = accepted.workflow.phases[phaseId];
  const target = path.join(
    root, accepted.definition.workItemRoot, accepted.workflow.workItem.id,
    phase.requiredArtifact.path
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `# ${phase.label}\n\n## Scope\n\n${detail}\n\n## Evidence\n\n`
    + 'This public POC uses the normal publication, submission, and approval boundaries. '
    + 'Every architecture decision is recomputed from the exact retained intent and registered '
    + 'world-model authority rather than trusted from editable prose.\n');
}

function createDeterministicViewExecution(runtime, execution, observation, contract) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-view-execution'),
    kind: 'world-model-view-execution',
    requestSha256: runtime.planned.request.requestSha256,
    viewId: contract.id,
    viewVersion: contract.version,
    executionUnitManifestSha256: WMB_V4_DETERMINISTIC_EXECUTION_SHA256,
    contextManifestSha256: execution.contextManifest.manifestSha256,
    viewFactLedgerSha256: execution.viewFactLedger.ledgerSha256,
    status: 'completed',
    candidateSha256: execution.validationReceipt.candidateSha256,
    validationReceiptSha256: execution.validationReceipt.receiptSha256,
    publishedViewSha256: execution.viewSha256,
    usageObservationSha256: observation.observationSha256
  };
  return readRecord(
    'world-model-view-execution', sealRecord(base, 'executionSha256')
  ).record;
}

/**
 * AC-605 permits a deterministic fixture at the projection/publication seam. The production
 * import extractor emits human-readable claims, so this fixture upgrades one real,
 * exact-source-bound import observation to the structured claim consumed by CALM. It rebuilds
 * and validates the complete registered publication graph before the low-level state write.
 * Lifecycle, intent, approval, verification, and gate operations still use the public CLI.
 */
async function publishStructuredArchitectureFixture(root, buildResult, ledgerConfig) {
  const runtime = buildResult.runtime;
  const original = runtime.registration.factLedger.facts.find((fact) => (
    fact.factType === 'import-dependency' && fact.subject.id.endsWith('->review-worker')
  ));
  assert.ok(original, 'the exact committed import must be registered before fixture projection');
  const sourceFile = runtime.planned.sourceSnapshot.files.find((entry) => entry.path === 'app.mjs');
  assert.ok(sourceFile, 'the pinned source snapshot must contain app.mjs');
  const evidence = runtime.registration.evidenceCatalog.items.find(
    (entry) => original.evidenceIds.includes(entry.id)
  );
  assert.equal(evidence.locator.path, 'app.mjs');
  assert.equal(evidence.sourceContentSha256, sourceFile.contentSha256);
  assert.equal(runtime.planned.sourceSnapshot.revision.commit, git(root, ['rev-parse', 'HEAD']));

  const existingDerivationIds = new Set(
    runtime.registration.derivationCatalog.derivations.map((entry) => entry.id)
  );
  const factDrafts = runtime.registration.factLedger.facts.map((fact) => ({
    ...factIdentityFromRecord(fact),
    ...(fact.id === original.id ? {
      claim: canonicalJson({
        external: true,
        source: 'poc-service',
        destination: 'review-worker',
        name: 'Review Worker',
        description: 'Source-observed review worker dependency.'
      }).trim()
    } : {})
  }));
  const factLedger = createFactLedger({
    sourceSnapshot: runtime.planned.sourceSnapshot,
    scopeManifest: runtime.planned.scopeManifest,
    extractorRegistry: runtime.planned.extractorRegistry,
    evidenceCatalog: runtime.registration.evidenceCatalog,
    derivationIds: existingDerivationIds,
    factDrafts
  });
  const outputFactIdsByDerivationId = Object.fromEntries(
    runtime.registration.derivationCatalog.derivations.map((entry) => [
      entry.id,
      factLedger.facts.filter((fact) => fact.derivationId === entry.id).map((fact) => fact.id)
    ])
  );
  const derivationCatalog = createDerivationCatalog({
    identities: runtime.registration.derivationCatalog.derivations.map(derivationIdentityFromRecord),
    outputFactIdsByDerivationId,
    statusByDerivationId: Object.fromEntries(
      runtime.registration.derivationCatalog.derivations.map((entry) => [entry.id, entry.status])
    ),
    evidenceCatalog: runtime.registration.evidenceCatalog,
    factLedger,
    extractorRegistry: runtime.planned.extractorRegistry
  });
  const viewFactLedgers = runtime.planned.viewRegistry.contracts
    .filter((contract) => contract.validity.status === 'active')
    .map((viewContract) => selectViewFacts({ factLedger, viewContract }));
  const requested = runtime.planned.requestedViews[0];
  const contract = requested.contract;
  const viewFactLedger = viewFactLedgers.find((entry) => entry.viewId === contract.id);
  const outputBudget = createWorldModelViewOutputBudget(runtime.planned.outputBudget, contract);
  const assembled = await assembleWmbV4Prompt({
    viewContract: contract,
    scopeManifest: runtime.planned.scopeManifest,
    viewFactLedger,
    evidenceCatalog: runtime.registration.evidenceCatalog,
    consumerProfile: runtime.planned.consumerProfile,
    outputBudget
  });
  const validated = validateCompositionCandidate(
    renderDeterministicCandidate(contract, viewFactLedger),
    {
      contract,
      viewFactLedger,
      evidenceCatalog: runtime.registration.evidenceCatalog,
      scopeManifest: runtime.planned.scopeManifest,
      outputBudget,
      candidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
      validatorSha256: WMB_V4_VALIDATOR_SHA256
    }
  );
  const materialized = materializeWorldModelView({
    candidate: validated.candidate,
    contract,
    viewFactLedger,
    scopeManifest: runtime.planned.scopeManifest,
    sourceSnapshot: runtime.planned.sourceSnapshot,
    evidenceCatalog: runtime.registration.evidenceCatalog,
    derivationCatalog,
    validationReceipt: validated.receipt,
    contextManifest: assembled.contextManifest,
    executionUnit: 'deterministic-renderer@1',
    generatedAt: '2026-09-12T00:00:00.000Z'
  });
  const observation = usageObservation({
    viewId: contract.id, prompt: '', output: materialized.markdown, usage: null
  });
  const availableView = {
    viewId: contract.id,
    viewVersion: contract.version,
    required: requested.required,
    status: 'available',
    path: `views/${contract.id}.md`,
    markdown: materialized.markdown,
    viewSha256: materialized.viewSha256,
    validationReceipt: validated.receipt,
    candidate: validated.candidate,
    contextManifest: assembled.contextManifest,
    viewFactLedger,
    usageObservation: observation,
    cache: 'miss'
  };
  availableView.execution = createDeterministicViewExecution(
    runtime, availableView, observation, contract
  );

  const selection = runtime.planned.requestedProjections[0];
  const candidate = buildCalmProjection({
    subject: runtime.planned.sourceSnapshot.subject,
    subjectLabel: runtime.planned.sourceSnapshot.subject.id,
    sourceManifestSha256: runtime.planned.sourceSnapshot.sourceManifestSha256,
    scopeSha256: runtime.planned.scopeManifest.scopeSha256,
    factLedger,
    capabilitySnapshot: runtime.planned.capabilitySnapshot,
    configurationSnapshot: runtime.planned.configurationSnapshot,
    includeGovernanceActors: selection.profile?.includeGovernanceActors !== false,
    includeControls: selection.profile?.includeControls !== false,
    includeFlows: selection.profile?.includeFlows !== false,
    includeExternalDependencies: selection.profile?.includeExternalDependencies
      ?? 'direct-architecture-only',
    projectionContract: selection.contract
  });
  const projected = await validateCalmProjectionCandidate(candidate, {
    strict: selection.validation?.strict !== false
  });
  const projection = {
    projectionId: selection.projectionId,
    projectionVersion: selection.contract.version,
    required: selection.required,
    status: 'available',
    path: selection.contract.output.path,
    projection: projected.projection,
    projectionBytes: projected.projectionBytes,
    projectionSha256: projected.projectionSha256,
    sourceMap: projected.sourceMap,
    receipt: projected.receipt,
    factSet: projected.factSet,
    refusal: null
  };
  const projectedSource = projection.sourceMap.elements.find(
    (entry) => entry.elementId === 'review-worker'
  )?.sources?.[0];
  const structuredFact = factLedger.facts.find((fact) => fact.id === projectedSource?.factId);
  assert.equal(structuredFact?.evidenceIds.includes(evidence.id), true);
  assert.equal(structuredFact?.factSha256, projectedSource?.sourceSha256);

  const dependencies = deriveWorldModelManifestDependencies({
    sourceSnapshot: runtime.planned.sourceSnapshot,
    scopeManifest: runtime.planned.scopeManifest,
    policySnapshotSha256: runtime.planned.request.policySnapshotSha256,
    viewRegistry: runtime.planned.viewRegistry,
    extractorRegistry: runtime.planned.extractorRegistry,
    evidenceCatalog: runtime.registration.evidenceCatalog,
    derivationCatalog,
    factLedger
  });
  const built = buildWorldModelManifest({
    subject: runtime.planned.sourceSnapshot.subject,
    dependencies,
    views: [availableView],
    projectionRegistry: runtime.planned.projectionRegistry,
    projections: [projection]
  });
  const staged = stageWorldModelPublication({
    manifest: built.manifest,
    dependencies,
    views: [availableView],
    projections: [projection],
    records: {
      sourceSnapshot: runtime.planned.sourceSnapshot,
      scopeManifest: runtime.planned.scopeManifest,
      viewRegistry: runtime.planned.viewRegistry,
      extractorRegistry: runtime.planned.extractorRegistry,
      evidenceCatalog: runtime.registration.evidenceCatalog,
      derivationCatalog,
      factLedger,
      buildRequest: runtime.planned.request,
      buildPlan: runtime.planned.plan,
      consumerProfile: runtime.planned.consumerProfile,
      outputBudget: runtime.planned.outputBudget,
      viewFactLedgers,
      contextManifests: [assembled.contextManifest],
      refusals: [],
      projectionRegistry: runtime.planned.projectionRegistry,
      capabilitySnapshot: runtime.planned.capabilitySnapshot,
      configurationSnapshot: runtime.planned.configurationSnapshot,
      toolchainLock: runtime.planned.toolchainLock
    }
  });
  return publishToStateBranch(
    root, ledgerConfig, staged.files,
    '[test-fixture][world-model] publish exact source-bound structured architecture fact',
    { replaceRoots: staged.replaceRoots }
  );
}

test('FIX:AC-605 complete public review-remediation path survives a second checkout and enforces evidence', {
  timeout: 360_000
}, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-remediation-poc-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const authority = await createAuthorityRemote(base);
  const delivery = await createDeliveryRemote(base);
  const operator = path.join(base, 'operator');
  git(base, ['clone', '-q', '--branch', 'main', authority.remote, operator]);
  git(operator, ['config', 'user.name', 'POC Operator']);
  git(operator, ['config', 'user.email', 'poc.operator@example.invalid']);

  const machine = path.join(base, 'machine');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(machine, 'organisation-cache'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(machine, 'bootstrap'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(machine, 'transport-outbox'),
    // Prove that the isolated capability checkout cannot borrow presentation identity globally.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(machine, 'empty-global-gitconfig')
  };

  const mapped = invokeJson(env, operator, [
    'capability', 'map', 'poc-service', '--lead', authority.remote,
    '--name', 'POC Service', '--kind', 'delivery', '--repository', delivery.remote
  ]);
  const proposalCommit = await customizeCapabilityProposal(operator, mapped.branch);
  const activated = invokeJson(env, operator, [
    'capability', 'activate', mapped.branch, '--lead', authority.remote,
    '--confirm', proposalCommit, '--acknowledge-unprotected'
  ]);
  assert.equal(activated.status, 'activated');
  assert.equal(activated.audit.recorded, true);
  assert.equal(activated.projection.published, true);
  assert.equal(activated.portability.portable, true);
  assert.ok(activated.portability.outcomes.some((entry) => entry.repository === delivery.remote));
  assert.equal(git(authority.remote, [
    'show', '-s', '--format=%an <%ae>', activated.audit.ledgerCommit
  ]), 'POC Operator <poc.operator@example.invalid>');
  assert.match(git(delivery.remote, [
    'show', 'state:singularity/capability-authority.json'
  ]), /poc-service/);

  const prepared = invokeJson(env, operator, [
    'workspace', 'prepare', authority.remote, '--id', 'review-remediation-poc',
    '--name', 'Review Remediation POC', '--base', path.join(base, 'workspaces'),
    '--capability', 'poc-service', '--lead-capability', 'poc-service', '--initialize'
  ]);
  assert.equal(prepared.status, 'waiting-user');
  const bootstrapped = invokeJson(env, operator, [
    'workspace', 'bootstrap', 'resume', prepared.bootstrapId,
    '--confirm', 'review-remediation-poc'
  ]);
  assert.equal(bootstrapped.status, 'ready');
  const deliveryRepository = Object.values(bootstrapped.result.workspace.repositories)
    .find((entry) => entry.capabilities?.includes('poc-service'));
  assert.ok(deliveryRepository, JSON.stringify(bootstrapped.result.workspace.repositories));
  const first = path.join(bootstrapped.result.workspace.path, deliveryRepository.path);
  git(first, ['config', 'user.name', 'POC Operator']);
  git(first, ['config', 'user.email', 'poc.operator@example.invalid']);
  const selected = invokeJson(env, operator, [
    'workspace', 'use', 'review-remediation-poc', '--repository', deliveryRepository.id
  ]);
  assert.equal(selected.repositoryPath, first);
  const workId = 'FIX-POC-605';
  const reviewWorkerRelationshipId = `sflow-rel-${sha256({
    kind: 'connects', source: 'poc-service', destination: 'review-worker',
    sourceInterface: null, destinationInterface: null, protocol: null
  }).slice(7, 27)}`;
  const started = invokeJson(env, first, [
    'start', workId, '--title', 'Review remediation public POC',
    '--description', 'Prove portable saved instructions and evidence-bound architecture enforcement.',
    '--acceptance-criteria', 'The exact saved Story closure and architecture decision remain enforceable.',
    '--from-branch', 'main', '--work-type', 'review-remediation-poc',
    '--capability', 'poc-service'
  ]);
  assert.equal(started.outcome.status, 'succeeded');
  assert.equal(started.data.currentPhase, 'planning');
  assert.equal(started.data.publication.pushed, true);

  const initialModel = await quiet(() => worldModelCommand(first, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic', json: true
  }));
  assert.equal(initialModel.status, 'completed');
  assert.equal(initialModel.runtime.availableViews[0].usageObservation.promptBytes, 0);
  assert.equal(initialModel.runtime.availableViews[0].usageObservation.providerInputTokens, null);

  let accepted = await loadAcceptedStoryExecution(first, workId);
  assert.equal(accepted.workflow.workflowSnapshot?.revision, 1);
  const firstExecution = await resolveStoryExecutionContext(
    first, accepted.definition, accepted.workflow,
    { agentId: 'architect', phaseId: 'planning', executionCatalog: accepted.executionCatalog }
  );
  assert.equal(firstExecution.identity.mode, 'workflow-snapshot');
  assert.match(firstExecution.identity.snapshotHash, /^sha256:[a-f0-9]{64}$/);

  const candidate = path.join(first, 'architecture-intent-poc.json');
  await writeFile(candidate, `${JSON.stringify({
    phase: 'planning',
    clauses: [{
      clauseId: `${workId}:ARCH-001`, operation: 'add-node',
      elementId: 'review-worker', required: true,
      value: { name: 'Review Worker', nodeType: 'system' }
    }, {
      clauseId: `${workId}:ARCH-002`, operation: 'add-relationship',
      elementId: reviewWorkerRelationshipId, required: true,
      value: {
        relationshipType: 'connects',
        source: { node: 'poc-service' },
        destination: { node: 'review-worker' }
      }
    }]
  }, null, 2)}\n`);
  const initialized = invokeJson(env, first, [
    'architecture', 'intent', 'init', '--work-id', workId,
    '--from', path.basename(candidate)
  ]);
  assert.equal(initialized.status, 'created');
  await rm(candidate);
  accepted = await loadAcceptedStoryExecution(first, workId);
  await writePhaseArtifact(
    first, accepted, 'planning',
    'The reviewed intent requires an exact-source-observed Review Worker architecture node.'
  );
  invoke(env, first, [
    'phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  invoke(env, first, ['submit', 'planning', '--skip-checks']);
  invoke(env, first, ['approve', 'planning', '--yes']);

  const second = path.join(base, 'machine-b');
  git(base, ['clone', '-q', '--branch', workId, delivery.remote, second]);
  git(second, ['config', 'user.name', 'POC Operator']);
  git(second, ['config', 'user.email', 'poc.operator@example.invalid']);
  invoke(env, second, ['resume', workId]);
  const liveAgentPath = path.join(second, '.github', 'agents', 'architect.agent.md');
  const liveAgent = await readFile(liveAgentPath, 'utf8');
  await writeFile(liveAgentPath, `${liveAgent}\nLIVE_AGENT_REPLACEMENT_MUST_NOT_RUN\n`);
  accepted = await loadAcceptedStoryExecution(second, workId);
  const secondExecution = await resolveStoryExecutionContext(
    second, accepted.definition, accepted.workflow,
    { agentId: 'architect', phaseId: 'planning', executionCatalog: accepted.executionCatalog }
  );
  assert.deepEqual(secondExecution.identity, firstExecution.identity);
  assert.equal(secondExecution.agent.text.includes('LIVE_AGENT_REPLACEMENT_MUST_NOT_RUN'), false);
  await writeFile(liveAgentPath, liveAgent);

  const applicationPath = path.join(second, 'app.mjs');
  const changedApplication = `${await readFile(applicationPath, 'utf8')}\nexport const reviewed = true;\n`;
  await writeFile(applicationPath, changedApplication);
  const unavailable = await quiet(() => worldModelCommand(second, ['wm', 'status'], {
    format: 'registered-v4', json: true
  }));
  assert.equal(unavailable.freshness.status, 'unavailable');
  assert.equal(unavailable.freshness.current, null);
  assert.equal(await readFile(applicationPath, 'utf8'), changedApplication);

  git(second, ['add', 'app.mjs']);
  git(second, ['commit', '-q', '-m', 'implement exact POC source change']);
  const missingModel = await quiet(() => worldModelCommand(second, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic', json: true
  }));
  assert.equal(missingModel.status, 'completed');
  invokeJson(env, second, [
    'architecture', 'intent', 'verify', '--work-id', workId
  ]);
  accepted = await loadAcceptedStoryExecution(second, workId);
  let gate = await evaluateArchitectureIntentGate(
    second, accepted.definition, accepted.workflow, 'verification'
  );
  assert.equal(gate.code, 'WMC_INTENT_UNFULFILLED');
  assert.match(gate.errors.join('\n'), /deviated|missing/);

  const reportPath = path.join(
    second, accepted.definition.workItemRoot, workId, 'context', 'architecture',
    'intent-fulfilment.json'
  );
  const honest = JSON.parse(await readFile(reportPath, 'utf8'));
  const tampered = sealRecord({
    ...honest,
    clauses: honest.clauses.map((clause) => ({
      ...clause, verdict: 'fulfilled', elementIds: [clause.clauseId.endsWith('001')
        ? 'review-worker' : reviewWorkerRelationshipId]
    })),
    blocking: false
  }, 'reportSha256');
  await writeFile(reportPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedBytes = await readFile(reportPath, 'utf8');
  gate = await evaluateArchitectureIntentGate(
    second, accepted.definition, accepted.workflow, 'verification'
  );
  assert.equal(gate.code, 'WMC_INTENT_REPORT_MISMATCH');
  assert.equal(await readFile(reportPath, 'utf8'), tamperedBytes);

  await writeFile(applicationPath, `${changedApplication}\nimport "review-worker";\n`);
  git(second, ['add', 'app.mjs']);
  git(second, ['commit', '-q', '-m', 'apply reviewed POC architecture change']);
  // The WMB source authority is an exact committed snapshot. Publish these reviewed application
  // commits before the later governed phase receipt so its push has one ordinary fast-forward.
  git(second, ['push', '-q', 'origin', `HEAD:refs/heads/${workId}`]);
  const fulfilledModel = await quiet(() => worldModelCommand(second, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic', json: true
  }));
  assert.equal(fulfilledModel.status, 'completed');
  await publishStructuredArchitectureFixture(second, fulfilledModel, accepted.workflow.ledger);
  const verified = invokeJson(env, second, [
    'architecture', 'intent', 'verify', '--work-id', workId
  ]);
  assert.equal(verified.blocking, false, JSON.stringify(verified, null, 2));
  accepted = await loadAcceptedStoryExecution(second, workId);
  gate = await evaluateArchitectureIntentGate(
    second, accepted.definition, accepted.workflow, 'verification'
  );
  assert.deepEqual(gate.errors, []);
  assert.match(gate.passes.join('\n'), /architecture intent fulfilled/);

  invoke(env, second, ['prepare', 'verification']);
  accepted = await loadAcceptedStoryExecution(second, workId);
  await writePhaseArtifact(
    second, accepted, 'verification',
    'The exact current CALM projection now satisfies the approved architecture intent.'
  );
  invoke(env, second, [
    'phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place'
  ]);
  invoke(env, second, ['submit', 'verification', '--skip-checks']);
  accepted = await loadAcceptedStoryExecution(second, workId);
  const submittedDecision = accepted.workflow.phases.verification
    .submissionArchitectureDecision?.identity;
  const approvalGate = await evaluateArchitectureIntentGate(
    second, accepted.definition, accepted.workflow, 'verification'
  );
  assert.deepEqual(
    approvalGate.architectureDecision, submittedDecision,
    JSON.stringify({ submittedDecision, currentDecision: approvalGate.architectureDecision }, null, 2)
  );
  invoke(env, second, ['approve', 'verification', '--yes']);
  accepted = await loadAcceptedStoryExecution(second, workId);
  assert.equal(accepted.workflow.phases.verification.status, 'approved');
  assert.deepEqual(
    accepted.workflow.phases.verification.submissionArchitectureDecision?.identity,
    gate.architectureDecision
  );
});

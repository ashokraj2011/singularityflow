import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import {
  ensureConfigurationBranch, loadStoryConfigurationSnapshot, materializeConfigurationSnapshot,
  resolveRemoteStoryConfigurationAuthority
} from '../src/configuration-branch.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { canonicalJson } from '../src/records.mjs';
import { buildGenerationAuthorship, importManualArtifact, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import {
  commitAndPublish, createWorkflow, loadConfig, loadWorkflow, publishGeneration, saveWorkflow,
  submitPhase, storyWelEnrollmentStatus, validateWorkflow
} from '../src/state.mjs';
import { finalizeDraftWorkflowSnapshot } from '../src/workflow-snapshots.mjs';
import { composePhasePrompt, worldModelCommand } from '../src/worldmodel.mjs';
import {
  resolveWorldModelRepositoryIdentityAuthority
} from '../src/world-model/history/repository-identity-authority.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import { removeTemporaryTree } from '../src/util.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function quiet(operation) {
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try { return await operation(); }
  finally { Object.assign(console, original); }
}

async function activePersistedStoryFixture(t) {
  const transport = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-publish-'));
  t.after(() => removeTemporaryTree(transport));
  const root = path.join(transport, 'application');
  const remote = path.join(transport, 'application.git');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Persisted WMP Publisher');
  git(root, 'config', 'user.email', 'persisted-wmp@example.invalid');
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.format = 'registered-v4';
  definition.worldModel.grounding = 'enforce';
  definition.worldModel.promptSource = 'builtin';
  definition.worldModel.views = ['dev.impact'];
  definition.worldModel.v4 = {
    composer: 'deterministic', consumer: 'developer', cachePolicy: 'reuse-valid',
    totalMaximumOutputTokens: 1400
  };
  for (const phase of Object.values(definition.phases)) {
    if (phase.worldModel?.views?.length) phase.worldModel.views = ['dev.impact'];
  }
  await writeFile(definitionPath, YAML.stringify(definition));
  for (const name of await readdir(path.join(root, '.github', 'agents'))) {
    if (!name.endsWith('.agent.md')) continue;
    const agentPath = path.join(root, '.github', 'agents', name);
    await writeFile(agentPath, (await readFile(agentPath, 'utf8')).replace(
      /sflow-world-model-views: "[^"]*"/,
      'sflow-world-model-views: "dev.impact"'
    ));
  }
  await writeFile(path.join(root, 'application.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'singularity', 'portfolio.yml'), YAML.stringify({
    version: 1,
    repositories: { application: { url: remote, defaultBranch: 'main' } }
  }));
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      application: {
        name: 'Application', kind: 'delivery', parent: null, repository: 'application',
        sourceRoots: ['application.mjs'], policy: { gitPublication: 'off' }
      }
    }
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize governed persisted WMP fixture');
  git(root, 'push', '-u', 'origin', 'main');
  await ensureConfigurationBranch(remote);
  const built = await withApprovedConfigurationRead(root, () => quiet(() => worldModelCommand(
    root, ['wm', 'build'], {
      format: 'registered-v4', views: 'dev.impact', capability: 'application'
    }
  )), {
    preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
  });
  assert.equal(built.status, 'completed', JSON.stringify(built));
  const approved = await withApprovedConfigurationRead(root, () => (
    resolveWorldModelRepositoryIdentityAuthority(root, { capabilityId: 'application' })
  ), {
    preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
  });
  await withApprovedConfigurationRead(root, () => buildAndPublishWorldModelV4(root, {
    outputDir: 'singularity/world-model',
    ledgerConfig: {
      enabled: true, branch: 'state', remote: 'origin', behind: 'block',
      enforcement: 'shadow', signing: 'off', trustTier: 'T0', maxRetries: 3
    },
    views: ['dev.impact'], composer: 'deterministic',
    capabilityId: approved.scopeManifest.capabilityId,
    allowedPaths: approved.scopeManifest.allowedPaths,
    sharedPaths: approved.scopeManifest.sharedPaths,
    excludedPaths: approved.scopeManifest.excludedPaths,
    allowedSubjects: approved.scopeManifest.allowedSubjects,
    maximumTraversalDepth: approved.scopeManifest.maximumTraversalDepth,
    policySnapshotSha256: approved.scopeManifest.policySourceSha256,
    persistedHistory: {
      savedViews: { views: ['development'], variants: ['brief', 'full'], format: 'md' }
    }
  }), {
    preferAuthority: true, refreshAuthority: true, requireAuthorityRefresh: true
  });
  assert.match(
    git(root, 'ls-tree', '-r', '--name-only', 'refs/remotes/origin/state'),
    /singularity\/world-model-history\/models\//u
  );

  const workId = 'WMP-PUBLISH-1';
  git(root, 'switch', '-c', workId);
  const approvedConfigurationAuthority = await resolveRemoteStoryConfigurationAuthority(remote);
  const approvedConfigurationSnapshot = await loadStoryConfigurationSnapshot(
    approvedConfigurationAuthority
  );
  await materializeConfigurationSnapshot(root, {
    authority: approvedConfigurationAuthority, snapshot: approvedConfigurationSnapshot
  });
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0], order: 0,
    clarification: { mode: 'off', maxQuestions: 5, topics: [], markers: { mode: 'block' } },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  const actor = {
    name: 'Persisted WMP Publisher', email: 'persisted-wmp@example.invalid', login: null
  };
  await setAgentSession(root, config, actor, 'product-owner', workId, {
    phaseId: 'intake', source: 'test'
  });
  const workflow = await createWorkflow(root, config, {
    id: workId, title: 'Publish exact persisted Story grounding',
    source: {
      type: 'manual', key: workId, title: 'Publish exact persisted Story grounding',
      description: 'Prove the lifecycle consumes the immutable persisted grounding receipt.',
      acceptanceCriteria: ['Publication accepts only the exact persisted grounding receipt.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    capabilityId: 'application', resolved, approvedConfigurationSnapshot
  });
  assert.equal(workflow.resolution.worldModelHistoryPin.status, 'active',
    JSON.stringify(workflow.resolution.worldModelHistoryPin));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'accept persisted grounding Story');

  const composed = await composePhasePrompt(root, {
    workId, phase: 'intake', agent: 'product-owner'
  });
  assert.match(composed, /Active Story phase contract/u);
  const phase = workflow.phases.intake;
  const target = path.join(root, config.workItemRoot, workId, phase.requiredArtifact.path);
  const source = path.join(root, 'persisted-wmp-intake.md');
  await writeFile(source, [
    '# Intake', '', '## Problem', '',
    'A governed publication must consume the exact persisted Story grounding receipt.', '',
    '## Outcome', '',
    'The lifecycle refuses missing or substituted receipts and accepts the original bytes.', '',
    '## Acceptance criteria', '',
    '- Missing persisted grounding is refused before lifecycle mutation.',
    '- Tampered persisted grounding is refused before lifecycle mutation.',
    '- Exact persisted grounding publishes generation one.', ''
  ].join('\n'));
  const imported = await importManualArtifact({
    sourcePath: source, targetPath: target, contract: phase.requiredArtifact
  });
  await rm(source);
  const authorship = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions({
      producer: 'governed-agent', channel: 'copilot-host', imported: true,
      externalAiUse: 'assisted'
    }),
    actor, governedAgentContext: 'product-owner', source: imported
  });
  const recordPath = path.join(root, config.workItemRoot, workId, 'context', 'intake-gen1.json');
  assert.ok(JSON.parse(await readFile(recordPath, 'utf8')).persistedGrounding);
  return { root, config, workflow, phase, target, authorship, recordPath };
}

async function publishFixtureGeneration(fixture) {
  const { root, config, workflow, phase, target, authorship } = fixture;
  return commitAndPublish(
    root, config, workflow,
    { type: 'artifact-generated', phaseId: phase.id, generation: 1 },
    `[${workflow.workItem.id}][phase:${phase.id}][generated:1] publish exact grounding`,
    [path.relative(root, target).replaceAll(path.sep, '/')],
    {
      beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(
        root, config, workflow, {
          phaseId: phase.id, authorship, persist: false,
          publicationTransaction: {
            publicationEvent,
            transactionId: transactionContext.transactionId,
            expectedHead: transactionContext.expectedHead
          }
        }
      )
    }
  );
}

test('a migrated pre-anchor Story is not reported as policy tampering', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-legacy-policy-anchor-'));
  t.after(() => removeTemporaryTree(root));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Legacy Author');
  git(root, 'config', 'user.email', 'legacy@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Legacy policy anchor compatibility\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'LEGACY-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const actor = { name: 'Legacy Author', email: 'legacy@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'developer', 'LEGACY-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'LEGACY-1',
    title: 'Continue a Story created before policy anchors',
    source: {
      type: 'manual', key: 'LEGACY-1', title: 'Continue a Story created before policy anchors',
      description: 'Exercise schema migration without inventing a policy receipt.',
      acceptanceCriteria: ['The migrated Story remains usable.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer'
  });

  const workflowFile = path.join(root, config.workItemRoot, 'LEGACY-1', 'workflow.json');
  const legacy = JSON.parse(await readFile(workflowFile, 'utf8'));
  legacy.schemaVersion = 1;
  delete legacy.resolution.policySha256;
  // These fields are supplied by storyWorkflowV1ToV2. Their absence proves this is exercising a
  // migrated creation record rather than merely a current record with its anchor deleted.
  for (const field of ['workType', 'workTypeLabel', 'sequenceGates', 'session', 'contextPolicy', 'templates', 'phases']) {
    delete legacy.resolution[field];
  }
  await writeFile(workflowFile, `${JSON.stringify(legacy, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'legacy Story creation');

  const migrated = await loadWorkflow(root, config, 'LEGACY-1');
  assert.equal(migrated.schemaVersion, currentSchemaVersion('story-workflow'));
  assert.equal(migrated.resolution.policySha256, undefined);
  const validation = await validateWorkflow(root, config, migrated);
  assert.equal(validation.errors.some((message) =>
    /immutable creation policy|operational policy differs/.test(message)), false,
  validation.errors.join('\n'));

  git(root, 'switch', 'main');
  git(root, 'switch', '-c', 'ANCHOR-BAD-1');
  await setAgentSession(root, config, actor, 'developer', 'ANCHOR-BAD-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'ANCHOR-BAD-1',
    title: 'Refuse a false creation anchor',
    source: {
      type: 'manual', key: 'ANCHOR-BAD-1', title: 'Refuse a false creation anchor',
      description: 'Bind the policy receipt to the creation bytes.',
      acceptanceCriteria: ['A mismatched creation digest is refused.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer'
  });
  const anchoredFile = path.join(root, config.workItemRoot, 'ANCHOR-BAD-1', 'workflow.json');
  const falselyAnchored = JSON.parse(await readFile(anchoredFile, 'utf8'));
  falselyAnchored.resolution.workTypeLabel = 'Manually weakened after receipt creation';
  await writeFile(anchoredFile, `${JSON.stringify(falselyAnchored, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'tampered anchored Story creation');

  const tampered = await loadWorkflow(root, config, 'ANCHOR-BAD-1');
  const tamperedValidation = await validateWorkflow(root, config, tampered);
  assert.equal(tamperedValidation.valid, false);
  assert.ok(tamperedValidation.errors.some((message) =>
    /creation policy anchor .* does not match its committed resolution bytes/.test(message)),
  tamperedValidation.errors.join('\n'));

  git(root, 'switch', 'main');
  git(root, 'switch', '-c', 'ANCHOR-MALFORMED-1');
  await setAgentSession(root, config, actor, 'developer', 'ANCHOR-MALFORMED-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'ANCHOR-MALFORMED-1',
    title: 'Keep WEL classification separate from policy validation',
    source: {
      type: 'manual', key: 'ANCHOR-MALFORMED-1',
      title: 'Keep WEL classification separate from policy validation',
      description: 'A malformed creation anchor is legacy for WEL and invalid for lifecycle policy.',
      acceptanceCriteria: ['Classification does not weaken the immutable policy gate.']
    },
    baseBranch: 'main',
    workType: 'feature',
    agent: 'developer'
  });
  const malformedFile = path.join(root, config.workItemRoot, 'ANCHOR-MALFORMED-1', 'workflow.json');
  const malformed = JSON.parse(await readFile(malformedFile, 'utf8'));
  malformed.resolution.policySha256 = 'not-a-policy-digest';
  await writeFile(malformedFile, `${JSON.stringify(malformed, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'malformed anchored Story creation');

  const classification = storyWelEnrollmentStatus(root, config, 'ANCHOR-MALFORMED-1');
  assert.equal(classification.classification, 'legacy');
  assert.equal(classification.reason, 'creation-anchor-malformed');
  const malformedWorkflow = await loadWorkflow(root, config, 'ANCHOR-MALFORMED-1');
  const malformedValidation = await validateWorkflow(root, config, malformedWorkflow);
  assert.equal(malformedValidation.valid, false);
  assert.ok(malformedValidation.errors.some((message) =>
    /creation policy anchor .* is malformed/.test(message)), malformedValidation.errors.join('\n'));
});

test('an honestly anchored v3 Story survives the deterministic convergence policy upgrade', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-v3-policy-anchor-'));
  t.after(() => removeTemporaryTree(root));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Upgrade Author');
  git(root, 'config', 'user.email', 'upgrade@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Anchored upgrade compatibility\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'V3-UPGRADE-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const actor = { name: 'Upgrade Author', email: 'upgrade@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'developer', 'V3-UPGRADE-1', {
    phaseId: 'intake', source: 'test'
  });
  await createWorkflow(root, config, {
    id: 'V3-UPGRADE-1',
    title: 'Read an anchored Story across a policy-strengthening migration',
    source: {
      type: 'manual', key: 'V3-UPGRADE-1',
      title: 'Read an anchored Story across a policy-strengthening migration',
      description: 'Exercise immutable policy validation across the v3 to v4 reader migration.',
      acceptanceCriteria: ['The authenticated v3 policy is compared in the current schema.']
    },
    baseBranch: 'main', workType: 'spec-driven-standard', agent: 'developer'
  });
  const workflowFile = path.join(root, config.workItemRoot, 'V3-UPGRADE-1', 'workflow.json');
  const v3 = JSON.parse(await readFile(workflowFile, 'utf8'));
  v3.schemaVersion = 3;
  v3.phases.convergence.generationPolicy = {
    requirement: 'none', producer: 'agent', defaultProducer: 'governed-agent',
    allowedProducers: ['governed-agent', 'human']
  };
  const resolved = v3.resolution.phases.find((phase) => phase.id === 'convergence');
  resolved.generation = {
    requirement: 'none', producer: 'agent', defaultProducer: 'governed-agent',
    allowedProducers: ['governed-agent', 'human']
  };
  delete v3.resolution.policySha256;
  v3.resolution.policySha256 = `sha256:${createHash('sha256').update(canonicalJson(v3.resolution)).digest('hex')}`;
  await writeFile(workflowFile, `${JSON.stringify(v3, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'anchored v3 Story creation');

  const migrated = await loadWorkflow(root, config, 'V3-UPGRADE-1');
  assert.equal(migrated.schemaVersion, currentSchemaVersion('story-workflow'));
  assert.equal(migrated.phases.convergence.generationPolicy.requirement, 'required');
  assert.deepEqual(migrated.phases.convergence.generationPolicy.allowedProducers, ['deterministic']);
  const validation = await validateWorkflow(root, config, migrated);
  assert.equal(validation.errors.some((message) =>
    /Resolved Story policy differs from the immutable creation commit/.test(message)), false,
  validation.errors.join('\n'));
});

test('governed publication verifies the exact persisted Story grounding receipt', async (t) => {
  const fixture = await activePersistedStoryFixture(t);
  const exactRecordText = await readFile(fixture.recordPath, 'utf8');
  const acceptedHead = git(fixture.root, 'rev-parse', 'HEAD');

  const missing = JSON.parse(exactRecordText);
  missing.persistedGrounding = null;
  await writeFile(fixture.recordPath, `${JSON.stringify(missing, null, 2)}\n`);
  await assert.rejects(
    () => publishFixtureGeneration(fixture),
    (error) => /requires a persisted grounding receipt/u.test(error?.message ?? '')
  );
  assert.equal(fixture.workflow.phases.intake.generation, 0);
  assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), acceptedHead);

  const tampered = JSON.parse(exactRecordText);
  tampered.persistedGrounding.groundingSha256 = `sha256:${'0'.repeat(64)}`;
  await writeFile(fixture.recordPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    () => publishFixtureGeneration(fixture),
    (error) => /persisted Story grounding verification failed/u.test(error?.message ?? '')
  );
  assert.equal(fixture.workflow.phases.intake.generation, 0);
  assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), acceptedHead);

  await writeFile(fixture.recordPath, exactRecordText);
  await publishFixtureGeneration(fixture);
  assert.equal(fixture.workflow.phases.intake.generation, 1);
  assert.equal(fixture.workflow.phases.intake.generationPublications.length, 1);
  assert.equal(fixture.workflow.phases.intake.authorship.at(-1).producer, 'governed-agent');
});

test('an enrolled v7 WFA Story loads, saves, validates, and publishes without policy drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-v7-wfa-policy-'));
  t.after(() => removeTemporaryTree(root));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WFA Upgrade Author');
  git(root, 'config', 'user.email', 'wfa-upgrade@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# WFA v7 migration compatibility\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'WFA-V7-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0],
    order: 0,
    clarification: { mode: 'off', maxQuestions: 5, topics: [], markers: { mode: 'block' } },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  const actor = {
    name: 'WFA Upgrade Author', email: 'wfa-upgrade@example.invalid', login: null
  };
  await setAgentSession(root, config, actor, 'developer', 'WFA-V7-1', {
    phaseId: 'intake', source: 'test'
  });

  await withOperationContext({
    operation: { id: 'test.v7-wfa-migration', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' },
    root,
    command: 'test'
  }, async () => {
    const created = await createWorkflow(root, config, {
      id: 'WFA-V7-1',
      title: 'Keep an enrolled v7 Story operational after upgrade',
      source: {
        type: 'manual', key: 'WFA-V7-1',
        title: 'Keep an enrolled v7 Story operational after upgrade',
        description: 'Exercise the WFA policy boundary across the v7 to v8 reader migration.',
        acceptanceCriteria: ['The Story publishes without changing its immutable policy identity.']
      },
      baseBranch: 'main', workType: 'feature', agent: 'developer', resolved
    });

    // Recreate the exact shape emitted by the previous writer. The current runtime initially
    // captured a v8 closure, so rebuild the still-unaccepted WFA draft after removing the field
    // that did not exist in v7; no accepted snapshot is ever rewritten by this helper.
    created.schemaVersion = 7;
    delete created.resolution.worldModelHistoryPin;
    await finalizeDraftWorkflowSnapshot(root, config, created);
    await saveWorkflow(root, config, created);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'create enrolled v7 Story');

    const migrated = await loadWorkflow(root, config, 'WFA-V7-1');
    assert.equal(migrated.schemaVersion, currentSchemaVersion('story-workflow'));
    assert.equal(Object.hasOwn(migrated.resolution, 'worldModelHistoryPin'), false,
      'the compatibility reader injected a new enumerable WFA policy field');

    // Exercise the ordinary current-writer path before validation. The saved aggregate is v8,
    // while its immutable creation commit and WFA closure remain authentic v7 policy bytes.
    await saveWorkflow(root, config, migrated);
    const reloaded = await loadWorkflow(root, config, 'WFA-V7-1');
    const validation = await validateWorkflow(root, config, reloaded);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.equal(validation.errors.some((message) =>
      /immutable creation commit|snapshot policy/.test(message)), false,
    validation.errors.join('\n'));

    // Exercise the ordinary governed-agent prompt path as well as the lifecycle write. A migrated
    // Story with no optional persisted-history pin must retain legacy projection grounding; it must
    // not be forced into the exact-history verifier or rely on the human-authorship bypass.
    const composed = await composePhasePrompt(root, {
      workId: 'WFA-V7-1', phase: 'intake', agent: 'developer'
    });
    assert.match(composed, /Active Story phase contract/u);
    const legacyGrounding = JSON.parse(await readFile(path.join(
      root, config.workItemRoot, 'WFA-V7-1', 'context', 'intake-gen1.json'
    ), 'utf8'));
    assert.equal(legacyGrounding.persistedGrounding, null);

    const phase = reloaded.phases.intake;
    const target = path.join(root, config.workItemRoot, 'WFA-V7-1', phase.requiredArtifact.path);
    const source = path.join(root, 'manual-v7-intake.md');
    await writeFile(source, [
      '# Intake', '',
      '## Problem', '',
      'Keep a WFA-enrolled Story usable after its aggregate is read by a newer runtime.', '',
      '## Outcome', '',
      'The authenticated v7 policy remains unchanged while the generation is published.', '',
      '## Acceptance criteria', '',
      '- Loading and saving does not change the immutable WFA policy identity.',
      '- Publication completes without treating migration as policy drift.', ''
    ].join('\n'));
    const imported = await importManualArtifact({
      sourcePath: source, targetPath: target, contract: phase.requiredArtifact
    });
    await rm(source);
    const authorship = buildGenerationAuthorship({
      options: normalizeAuthorshipOptions({
        producer: 'governed-agent', channel: 'copilot-host', imported: true,
        externalAiUse: 'assisted'
      }),
      actor,
      governedAgentContext: 'developer',
      source: imported
    });
    await commitAndPublish(
      root,
      config,
      reloaded,
      { type: 'artifact-generated', phaseId: 'intake', generation: 1 },
      '[WFA-V7-1][phase:intake][generated:1] publish migrated Story',
      [path.relative(root, target).replaceAll(path.sep, '/')],
      {
        beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(
          root, config, reloaded, {
            phaseId: 'intake', authorship, persist: false,
            publicationTransaction: {
              publicationEvent,
              transactionId: transactionContext.transactionId,
              expectedHead: transactionContext.expectedHead
            }
          }
        )
      }
    );
    assert.equal(reloaded.phases.intake.generation, 1);
    assert.equal(reloaded.phases.intake.generationPublications.length, 1);
    assert.equal(reloaded.phases.intake.authorship.at(-1).producer, 'governed-agent');
  });
});

test('a Story can complete through manual authorship with model mode disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-no-model-lifecycle-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Manual Author');
  git(root, 'config', 'user.email', 'manual@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Model-independent lifecycle\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'MANUAL-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  resolved.phases = [{
    ...resolved.phases[0],
    order: 0,
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['intake'] }
  }];
  const actor = { name: 'Manual Author', email: 'manual@example.invalid', login: null };
  await setAgentSession(root, config, actor, 'developer', 'MANUAL-1', { phaseId: 'intake', source: 'test' });

  await withOperationContext({
    operation: { id: 'test.manual-lifecycle', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' },
    root,
    command: 'test'
  }, async () => {
    const workflow = await createWorkflow(root, config, {
      id: 'MANUAL-1',
      title: 'Complete without a kernel model',
      source: { type: 'manual', key: 'MANUAL-1', title: 'Complete without a kernel model', description: 'Use reviewed human-authored evidence.', acceptanceCriteria: ['The lifecycle completes without a model invocation.'] },
      baseBranch: 'main',
      workType: 'feature',
      agent: 'developer',
      resolved
    });
    const phase = workflow.phases.intake;
    const target = path.join(root, 'singularity', 'work-items', 'MANUAL-1', phase.requiredArtifact.path);
    const source = path.join(root, 'manual-intake.md');
    await writeFile(source, `# Intake\n\n## Problem\n\nProve that a governed Story can complete without a kernel model call.\n\n## Outcome\n\nThe human-authored artifact is validated, published, and deterministically accepted.\n\n## Acceptance criteria\n\n- No model provider is invoked.\n- Authorship remains explicit and auditable.\n`);
    const imported = await importManualArtifact({ sourcePath: source, targetPath: target, contract: phase.requiredArtifact });
    await rm(source);
    const authorship = buildGenerationAuthorship({
      options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-import', imported: true, externalAiUse: 'none' }),
      actor,
      governedAgentContext: 'developer',
      source: imported
    });
    await commitAndPublish(
      root,
      config,
      workflow,
      { type: 'artifact-generated', phaseId: 'intake', generation: 1 },
      '[MANUAL-1][phase:intake][generated:1] publish manual artifact',
      [path.relative(root, target).replaceAll(path.sep, '/')],
      {
        beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
          phaseId: 'intake', authorship, persist: false,
          publicationTransaction: {
            publicationEvent,
            transactionId: transactionContext.transactionId,
            expectedHead: transactionContext.expectedHead
          }
        })
      }
    );
    const governedScope = phase.writeScope;
    phase.writeScope = governedScope === 'artifact-only' ? 'source-and-artifact' : 'artifact-only';
    const tampered = await validateWorkflow(root, config, workflow);
    assert.equal(tampered.valid, false);
    assert.ok(tampered.errors.some((message) =>
      /operational policy differs from the immutable profile snapshot/.test(message)));
    phase.writeScope = governedScope;
    await submitPhase(root, config, workflow, { phaseId: 'intake', runChecks: false });

    assert.equal(workflow.status, 'complete');
    assert.equal(workflow.currentPhase, null);
    assert.equal(workflow.phases.intake.status, 'approved');
    assert.equal(workflow.phases.intake.authorship.at(-1).producer, 'human');
    assert.equal(workflow.phases.intake.authorship.at(-1).kernelModel.invoked, false);
    assert.equal(workflow.schemaVersion, currentSchemaVersion('story-workflow'));
    assert.equal(workflow.phases.intake.generationPublications[0].architectureIntent, null);
    assert.equal(workflow.phases.intake.generationPublications[0].architectureDecision, null);
    assert.equal(workflow.phases.intake.submissionArchitectureDecision, null);
    assert.equal(workflow.usage.records, 0);
    const telemetry = JSON.parse(await readFile(path.join(root, workflow.phases.intake.telemetry[0].path), 'utf8'));
    assert.equal(workflow.phases.intake.telemetry[0].status, 'not-invoked');
    assert.equal(telemetry.source, 'not-invoked');
    assert.deepEqual(telemetry.usage, []);
  });
});

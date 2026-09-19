import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  globToRegExp,
  injectAgentPrompt,
  readPromptGeneration,
  recordInjection,
  renderInjection,
  resolveInjection,
  ruleMatches,
  validateInjectionDefinition
} from '../src/inject.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { compilePromptSections } from '../src/prompt-budget.mjs';
import { tokenEconomyDigest } from '../src/token-economy.mjs';
import {
  evaluateTokenReductionShadow, tokenReductionShadowFailure
} from '../src/token-reduction/shadow-evaluation.mjs';
import { readJson, run } from '../src/util.mjs';
import {
  canonicalJson as canonicalWmpJson, recordSha256, sealRecord
} from '../src/world-model/canonicalize.mjs';
import { createWmpGroundingPacket } from '../src/world-model/history/contracts.mjs';
import { PERSISTED_GROUNDING_COMPOSER_CONTRACT } from '../src/world-model/history/persisted-grounding-owner.mjs';
import {
  worldModelGroundingPacketPath,
  worldModelGroundingPacketPayloadPath
} from '../src/world-model/history/paths.mjs';

async function fixtureRoot({ placeholder = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-inject-'));
  run('git', ['init', '-q'], { cwd: root });
  await mkdir(path.join(root, 'singularity/world-model/architecture'), { recursive: true });
  await mkdir(path.join(root, 'singularity/world-model/domains'), { recursive: true });
  await mkdir(path.join(root, 'singularity/world-model/evidence'), { recursive: true });
  await mkdir(path.join(root, 'singularity/agents'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/architecture/overview.md'), '# Architecture\n\nHexagonal, event-driven.\n');
  await writeFile(path.join(root, 'singularity/world-model/domains/payments.md'), '# Payments domain\n\nPCI boundaries live here.\n');
  await writeFile(path.join(root, 'singularity/world-model/evidence/evidence.jsonl'), `${JSON.stringify({ id: 'E-1', claim: 'Observed architecture' })}\n`);
  await writeFile(path.join(root, 'singularity/world-model/manifest.json'), JSON.stringify({ schema_version: '1.0', repository_commit: 'a'.repeat(40), evidence: { path: 'evidence/evidence.jsonl' } }));
  await writeFile(path.join(root, 'singularity/agents/architect.md'), placeholder ? '# Architect\n\nDesign carefully.\n\n{{WORLD_MODEL}}\n' : '# Architect\n\nDesign carefully.\n');
  return root;
}

function definition(rules, mode = 'append') {
  return {
    agents: { architect: { label: 'Architect', source: '.github/agents/architect.agent.md', sha256: 'b'.repeat(64), prompt: '# Architect\n\nDesign carefully.\n\n{{WORLD_MODEL}}\n' } },
    phases: { design: {} },
    workTypes: { feature: {} },
    worldModel: { outputDir: 'singularity/world-model', injection: { mode, maxBytes: 32768, rules } }
  };
}

function shadowPrompt(workId, phase = 'design', generation = 1) {
  const workflowSnapshotSha256 = `sha256:${'3'.repeat(64)}`;
  const repositoryDomainSha256 = `sha256:${'2'.repeat(64)}`;
  const sourceSha256 = '6'.repeat(64);
  const tokenEconomy = {
    enabled: true,
    mode: 'observe',
    composer: 'legacy-v1',
    profile: 'test',
    profiles: {
      test: {
        maximumEstimatedPromptTokens: 1024,
        reservedOutputTokens: 128,
        maxExpansionTokens: 128,
        observationCapsuleTokens: 128,
        policyOnBudgetBreach: 'refuse'
      }
    }
  };
  const compiled = compilePromptSections([
    { id: 'phase-contract', text: '# Phase\n\nKeep the contract.', mandatory: true },
    { id: 'work-source', text: '# Source\n\nKeep the source.', mandatory: true }
  ], tokenEconomy, {
    evaluateTokenReductionShadow,
    tokenReductionShadowFailure,
    tokenReductionShadow: true,
    tokenReductionScope: { workId, phase, generation },
    tokenReductionReceiptContext: {
      subject: {
        repositoryDomainSha256, workId,
        workflowInstanceId: workflowSnapshotSha256, phase, generation
      },
      authority: {
        tokenEconomyPolicySha256: `sha256:${tokenEconomyDigest(tokenEconomy)}`,
        phaseContextPolicySha256: null,
        workflowSnapshotSha256,
        sourceSnapshotSha256: `sha256:${sourceSha256}`
      }
    }
  });
  return {
    compiled, workflowSnapshotSha256, repositoryDomainSha256, sourceSha256, tokenEconomy
  };
}

function durableShadowPromptBudget(compiled) {
  const value = structuredClone(compiled);
  delete value.text;
  if (value.tokenReduction?.record) delete value.tokenReduction.record.receipt;
  return value;
}

function wmpDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function wmpObjectRef(role, family, mediaType, value) {
  return {
    role, family, mediaType, sha256: wmpDigest(value), bytes: Buffer.byteLength(value)
  };
}

async function coordinatedPersistedGroundingFixture(workId, {
  packetMutator = null, pinMutator = null, sealedPinMutator = null
} = {}) {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const repositoryDomainSha256 = `sha256:${'1'.repeat(64)}`;
  const workflowInstanceId = `sha256:${'2'.repeat(64)}`;
  const authorityCommit = '4'.repeat(40);
  const authority = {
    repositoryDomainSha256, stateRef: 'refs/heads/state', authorityCommit,
    repositoryIdentitySha256: null
  };
  const payload = '# Persisted grounding\n\nExact historical context.\n\n---\n\n';
  const model = {
    modelKey: `sha256:${'6'.repeat(64)}`,
    bindingRef: wmpObjectRef(
      'model-binding', 'world-model-model-binding', 'application/json', '{"model":true}'
    ),
    modelPayloadSha256: `sha256:${'7'.repeat(64)}`
  };
  const renderedViews = [
    `# Architecture\n\nPinned.\n- Expansion: wmp-view:sha256:${'5'.repeat(64)}\n`,
    `# Development\n\nPinned.\n- Expansion: wmp-view:sha256:${'d'.repeat(64)}\n`
  ];
  const views = [
    {
      order: 0,
      viewKey: `sha256:${'8'.repeat(64)}`,
      bindingRef: wmpObjectRef(
        'view-binding', 'world-model-view-binding', 'application/json', '{"view":1}'
      ),
      variant: 'brief', format: 'md',
      renderedRef: wmpObjectRef('rendered-view', null, 'text/markdown', renderedViews[0]),
      expansionHandle: `wmp-view:sha256:${'5'.repeat(64)}`
    },
    {
      order: 1,
      viewKey: `sha256:${'e'.repeat(64)}`,
      bindingRef: wmpObjectRef(
        'view-binding', 'world-model-view-binding', 'application/json', '{"view":2}'
      ),
      variant: 'full', format: 'md',
      renderedRef: wmpObjectRef('rendered-view', null, 'text/markdown', renderedViews[1]),
      expansionHandle: `wmp-view:sha256:${'d'.repeat(64)}`
    }
  ];
  const pinCore = {
    schemaVersion: currentSchemaVersion('story-world-model-history-pin'),
    kind: 'story-world-model-history-pin', status: 'active', reasonCode: null,
    repositoryDomainSha256, sourceRevision: '9'.repeat(40),
    authority: {
      stateRef: authority.stateRef, authorityCommit,
      repositoryIdentitySha256: authority.repositoryIdentitySha256
    },
    historyDir: 'singularity/world-model-history', outputDir: 'singularity/world-model',
    model: {
      ...model,
      bindingPath: 'models/model-binding.json',
      bindingByteSha256: `sha256:${'a'.repeat(64)}`
    },
    views: views.map((view, index) => ({
      reference: index === 0 ? 'architecture@1' : 'development@1',
      variant: view.variant, format: view.format, viewKey: view.viewKey,
      bindingPath: `views/view-${index + 1}-binding.json`,
      bindingByteSha256: `sha256:${(index === 0 ? 'b' : 'f').repeat(64)}`,
      bindingRef: view.bindingRef, renderedRef: view.renderedRef,
      expansionHandle: view.expansionHandle
    })),
    phasePlans: [{
      phase: 'design', agent: 'architect', orderedViewKeys: views.map(({ viewKey }) => viewKey)
    }],
    composition: { maximumBytes: 32768 },
    closureSha256: `sha256:${'c'.repeat(64)}`
  };
  pinMutator?.(pinCore);
  const pin = sealRecord(pinCore, 'pinSha256');
  sealedPinMutator?.(pin);

  const packetInput = {
    subject: {
      repositoryDomainSha256, workId, workflowInstanceId, phase: 'design', generation: 1
    },
    model: structuredClone(model), views: structuredClone(views),
    composition: PERSISTED_GROUNDING_COMPOSER_CONTRACT,
    renderedBlock: wmpObjectRef('rendered-grounding', null, 'text/markdown', payload),
    budget: {
      mode: 'bytes', maximum: 32768, measured: Buffer.byteLength(payload),
      tokenizerSha256: null
    },
    authority
  };
  packetMutator?.(packetInput);
  const packet = createWmpGroundingPacket(packetInput);
  const packetText = canonicalWmpJson(packet);
  const packetPath = worldModelGroundingPacketPath(workId, packet.groundingSha256);
  const payloadPath = worldModelGroundingPacketPayloadPath(workId, packet.groundingSha256);
  await mkdir(path.join(root, path.dirname(packetPath)), { recursive: true });
  await writeFile(path.join(root, packetPath), packetText);
  await writeFile(path.join(root, payloadPath), payload);
  const receipt = {
    activation: 'story', pinSha256: pin.pinSha256,
    groundingSha256: packet.groundingSha256,
    packetRef: wmpObjectRef(
      'grounding-packet', 'world-model-grounding-packet', 'application/json', packetText
    ),
    renderedBlock: wmpObjectRef('rendered-grounding', null, 'text/markdown', payload),
    authority,
    files: [
      { path: packetPath, bytes: Buffer.byteLength(packetText), sha256: wmpDigest(packetText) },
      { path: payloadPath, bytes: Buffer.byteLength(payload), sha256: wmpDigest(payload) }
    ]
  };
  return {
    root, rendered, receipt, payload,
    workflow: {
      workItem: { id: workId },
      workflowSnapshot: { snapshotHash: workflowInstanceId },
      resolution: { worldModelHistoryPin: pin }
    },
    phase: { id: 'design', generation: 0 },
    workDir: path.join(root, 'singularity/work-items', workId)
  };
}

test('globToRegExp supports * and ** semantics', () => {
  assert.ok(globToRegExp('architecture/*').test('architecture/overview.md'));
  assert.ok(!globToRegExp('architecture/*').test('architecture/deep/file.md'));
  assert.ok(globToRegExp('src/api/**').test('src/api/v2/routes.mjs'));
  assert.ok(globToRegExp('**/payments.md').test('domains/payments.md'));
  assert.ok(!globToRegExp('domains/*.md').test('domains/payments.txt'));
});

test('ruleMatches evaluates agent, phase, workType, changedPaths, and labels', () => {
  const signals = { agent: 'architect', phase: 'design', workType: 'feature', changedPaths: ['src/api/routes.mjs'], labels: ['Payments'] };
  assert.ok(ruleMatches({ agent: 'architect' }, signals));
  assert.ok(!ruleMatches({ agent: 'developer' }, signals));
  assert.ok(ruleMatches({ phase: ['design', 'implementation'] }, signals));
  assert.ok(ruleMatches({ changedPaths: 'src/api/**' }, signals));
  assert.ok(!ruleMatches({ changedPaths: 'src/ui/**' }, signals));
  assert.ok(ruleMatches({ labels: ['payments'] }, signals));
  assert.ok(ruleMatches({}, signals));
});

test('resolveInjection unions includes across matched rules', () => {
  const config = definition([
    { when: { agent: 'architect' }, include: ['architecture/*'] },
    { when: { labels: ['payments'] }, include: ['domains/payments.md'], evidence: true, depth: 'deep' },
    { when: { agent: 'developer' }, include: ['development/*'] }
  ]);
  const resolved = resolveInjection(config, { agent: 'architect', labels: ['payments'] });
  assert.equal(resolved.matchedRules, 2);
  assert.deepEqual(resolved.includes.sort(), ['architecture/*', 'domains/payments.md']);
  assert.equal(resolved.evidence, true);
  assert.equal(resolved.depth, 'deep');
});

test('injection configuration validates references and safe includes', () => {
  const config = definition([{ when: { agent: 'architect', phase: 'design', workType: 'feature' }, include: ['domains/*.md'] }]);
  assert.equal(validateInjectionDefinition(config).rules.length, 1);
  config.worldModel.injection.rules[0].when.phase = 'missing';
  assert.throws(() => validateInjectionDefinition(config), /unknown phase 'missing'/);
  config.worldModel.injection.rules[0].when.phase = 'design';
  config.worldModel.injection.rules[0].include = ['../secret.md'];
  assert.throws(() => validateInjectionDefinition(config), /stay inside the world-model directory/);
});

test('renderInjection assembles matching model files with hashes and header', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: { agent: 'architect' }, include: ['architecture/*', 'domains/payments.md'] }]);
  const rendered = await renderInjection(root, config, { agent: 'architect' });
  assert.equal(rendered.sections.length, 2);
  assert.match(rendered.text, /Hexagonal/);
  assert.match(rendered.text, /PCI boundaries/);
  assert.match(rendered.text, /commit=aaaaaaaaaa/);
  assert.ok(rendered.sections.every((section) => /^[0-9a-f]{64}$/.test(section.sha256)));
});

test('renderInjection refuses rule bytes that differ from the validated model snapshot', async () => {
  const root = await fixtureRoot();
  const relative = 'architecture/overview.md';
  const original = await readFile(path.join(root, 'singularity/world-model', relative));
  const validatedModelFiles = [{
    path: relative,
    sha256: createHash('sha256').update(original).digest('hex'),
    size: original.length
  }];
  await writeFile(
    path.join(root, 'singularity/world-model', relative),
    '# Architecture\n\nReplaced after validation.\n'
  );
  await assert.rejects(
    () => renderInjection(
      root,
      definition([{ when: { agent: 'architect' }, include: ['architecture/*'] }]),
      { agent: 'architect' },
      { validatedModelFiles }
    ),
    (error) => error?.code === 'WORLD_MODEL_GROUNDING_INTEGRITY_FAILED'
      && /differs from the validated model snapshot/.test(error.message)
  );
});

test('renderInjection does not silently omit a validated file that disappears before selection', async () => {
  const root = await fixtureRoot();
  const relative = 'architecture/overview.md';
  const original = await readFile(path.join(root, 'singularity/world-model', relative));
  const validatedModelFiles = [{
    path: relative,
    sha256: createHash('sha256').update(original).digest('hex'),
    size: original.length
  }];
  await unlink(path.join(root, 'singularity/world-model', relative));

  await assert.rejects(
    () => renderInjection(
      root,
      definition([{ when: { agent: 'architect' }, include: ['architecture/*'] }]),
      { agent: 'architect' },
      { validatedModelFiles }
    ),
    (error) => error?.code === 'ENOENT'
  );
});

test('renderInjection enforces the UTF-8 source-byte budget with truncation', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: {}, include: ['**/*.md'] }]);
  config.worldModel.injection.maxBytes = 40;
  const rendered = await renderInjection(root, config, { agent: 'architect' });
  assert.ok(rendered.sections.some((section) => section.truncated));
  assert.equal(rendered.sections.reduce((sum, section) => sum + section.injectedBytes, 0), 40);
  assert.match(rendered.text, /truncated by injection budget/);
});

test('injectAgentPrompt replaces the placeholder', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: { agent: 'architect' }, include: ['architecture/*'] }], 'replace');
  const { text, injection } = await injectAgentPrompt(root, config, 'architect', {});
  assert.ok(injection.applied);
  assert.match(text, /Design carefully/);
  assert.match(text, /Hexagonal/);
  assert.ok(!text.includes('{{WORLD_MODEL}}'));
});

test('injectAgentPrompt replaces only the governed prompt body for a prompt-study variant', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: { agent: 'architect' }, include: ['architecture/*'] }], 'replace');
  const promptOverride = {
    text: '# Experimental architect\n\nUse evidence.\n\n{{WORLD_MODEL}}\n',
    studyRunId: 'architect-prompts@2',
    variant: { id: 'evidence-first', label: 'Evidence first' },
    sha256: 'b'.repeat(64)
  };
  const { text, injection } = await injectAgentPrompt(root, config, 'architect', {}, { promptOverride });
  assert.match(text, /Experimental architect/);
  assert.match(text, /Hexagonal/);
  assert.doesNotMatch(text, /Design carefully/);
  assert.deepEqual(injection.promptOverride, promptOverride);
});

test('injectAgentPrompt appends without a placeholder and respects off mode', async () => {
  const root = await fixtureRoot({ placeholder: false });
  const config = definition([{ when: {}, include: ['architecture/*'] }], 'append');
  config.agents.architect.prompt = '# Architect\n\nDesign carefully.\n';
  const appended = await injectAgentPrompt(root, config, 'architect', {});
  assert.match(appended.text, /Design carefully[\s\S]*Hexagonal/);
  const off = await injectAgentPrompt(root, definition([{ when: {}, include: ['architecture/*'] }], 'off'), 'architect', {});
  assert.equal(off.text.includes('Hexagonal'), false);
});

test('an explicit generic context arm removes the placeholder without reading model files', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: {}, include: ['architecture/*'] }], 'append');
  const disabled = await injectAgentPrompt(root, config, 'architect', {}, {
    disableWorldModelInjection: true
  });
  assert.doesNotMatch(disabled.text, /Hexagonal|WORLD_MODEL/);
  assert.equal(disabled.injection.mode, 'off');
  assert.equal(disabled.injection.matchedRules, 0);
  assert.deepEqual(disabled.injection.sections, []);
});

test('non-matching signals leave the agent prompt untouched', async () => {
  const root = await fixtureRoot();
  const { text, injection } = await injectAgentPrompt(root, definition([{ when: { agent: 'developer' }, include: ['architecture/*'] }]), 'architect', {});
  assert.equal(injection.sections.length, 0);
  assert.equal(injection.applied, false);
  assert.ok(!text.includes('{{WORLD_MODEL}}'));
});

test('evidence rules use the manifest evidence path', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(root, definition([{ when: {}, include: ['architecture/*'], evidence: true }]), { agent: 'architect' });
  assert.ok(rendered.sections.some((section) => section.path.endsWith('evidence/evidence.jsonl')));
});

test('recordInjection writes an auditable generation context record', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' });
  const workflow = { workItem: { id: 'ENG-9' } };
  const phase = { id: 'design', generation: 1 };
  const workDir = path.join(root, 'singularity/work-items/ENG-9');
  const renderedText = '# Exact composed design prompt\n';
  const { record, file } = await recordInjection(root, workflow, phase, {
    ...rendered, agent: 'architect', renderedText, fresh: true,
    sourceComparison: { status: 'fresh', reasonCode: null }
  }, { workDir });
  assert.equal(record.generation, 2);
  assert.equal(file, 'singularity/work-items/ENG-9/context/design-gen2.json');
  const written = await readJson(path.join(root, file));
  assert.equal(written.workId, 'ENG-9');
  assert.equal(written.files.length, 1);
  assert.match(written.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(written.modelCommit, 'a'.repeat(40));
  assert.equal(written.schemaVersion, currentSchemaVersion('prompt-injection'));
  assert.equal(written.renderedSha256, createHash('sha256').update(renderedText).digest('hex'));
  assert.equal(
    await readFile(path.join(root, written.promptPath), 'utf8'),
    renderedText
  );
  assert.deepEqual(written.groundingAvailability, {
    status: 'available', reasonCode: null
  });
  assert.deepEqual(written.sourceComparison, { status: 'fresh', reasonCode: null });
  assert.deepEqual(written.executionContext, { mode: 'legacy-live' });
  assert.equal(written.tokenReduction, null);
  assert.equal(written.persistedGrounding, null);
});

test('prompt injection binds one exact persisted Story grounding packet and detects payload tampering', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workId = 'ENG-WMP-PACKET';
  const repositoryDomainSha256 = `sha256:${'1'.repeat(64)}`;
  const workflowInstanceId = `sha256:${'2'.repeat(64)}`;
  const authorityCommit = '4'.repeat(40);
  const payload = '# Persisted grounding\n\nExact historical context.\n\n---\n\n';
  const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const objectRef = (role, family, mediaType, value) => ({
    role, family, mediaType, sha256: digest(value), bytes: Buffer.byteLength(value)
  });
  const renderedView = '# Architecture\n\nPinned.\n- Expansion: wmp-view:sha256:'
    + `${'5'.repeat(64)}\n`;
  const packet = createWmpGroundingPacket({
    subject: {
      repositoryDomainSha256, workId, workflowInstanceId, phase: 'design', generation: 1
    },
    model: {
      modelKey: `sha256:${'6'.repeat(64)}`,
      bindingRef: objectRef(
        'model-binding', 'world-model-model-binding', 'application/json', '{"model":true}'
      ),
      modelPayloadSha256: `sha256:${'7'.repeat(64)}`
    },
    views: [{
      order: 0,
      viewKey: `sha256:${'8'.repeat(64)}`,
      bindingRef: objectRef(
        'view-binding', 'world-model-view-binding', 'application/json', '{"view":true}'
      ),
      variant: 'brief', format: 'md',
      renderedRef: objectRef('rendered-view', null, 'text/markdown', renderedView),
      expansionHandle: `wmp-view:sha256:${'5'.repeat(64)}`
    }],
    composition: PERSISTED_GROUNDING_COMPOSER_CONTRACT,
    renderedBlock: objectRef('rendered-grounding', null, 'text/markdown', payload),
    budget: {
      mode: 'bytes', maximum: 32768, measured: Buffer.byteLength(payload),
      tokenizerSha256: null
    },
    authority: {
      repositoryDomainSha256, stateRef: 'refs/heads/state', authorityCommit,
      repositoryIdentitySha256: null
    }
  });
  const pin = sealRecord({
    schemaVersion: currentSchemaVersion('story-world-model-history-pin'),
    kind: 'story-world-model-history-pin',
    status: 'active',
    reasonCode: null,
    repositoryDomainSha256,
    sourceRevision: '9'.repeat(40),
    authority: {
      stateRef: 'refs/heads/state', authorityCommit, repositoryIdentitySha256: null
    },
    historyDir: 'singularity/world-model-history',
    outputDir: 'singularity/world-model',
    model: {
      modelKey: packet.model.modelKey,
      bindingPath: 'models/model-binding.json',
      bindingByteSha256: `sha256:${'a'.repeat(64)}`,
      bindingRef: packet.model.bindingRef,
      modelPayloadSha256: packet.model.modelPayloadSha256
    },
    views: [{
      reference: 'architecture@1',
      variant: packet.views[0].variant,
      format: packet.views[0].format,
      viewKey: packet.views[0].viewKey,
      bindingPath: 'views/architecture-binding.json',
      bindingByteSha256: `sha256:${'b'.repeat(64)}`,
      bindingRef: packet.views[0].bindingRef,
      renderedRef: packet.views[0].renderedRef,
      expansionHandle: packet.views[0].expansionHandle
    }],
    phasePlans: [{
      phase: 'design', agent: 'architect', orderedViewKeys: [packet.views[0].viewKey]
    }],
    composition: { maximumBytes: 32768 },
    closureSha256: `sha256:${'c'.repeat(64)}`
  }, 'pinSha256');
  const pinSha256 = pin.pinSha256;
  const packetText = canonicalWmpJson(packet);
  const packetPath = worldModelGroundingPacketPath(workId, packet.groundingSha256);
  const payloadPath = worldModelGroundingPacketPayloadPath(workId, packet.groundingSha256);
  await mkdir(path.join(root, path.dirname(packetPath)), { recursive: true });
  await writeFile(path.join(root, packetPath), packetText);
  await writeFile(path.join(root, payloadPath), payload);
  const receipt = {
    activation: 'story', pinSha256, groundingSha256: packet.groundingSha256,
    packetRef: objectRef(
      'grounding-packet', 'world-model-grounding-packet', 'application/json', packetText
    ),
    renderedBlock: objectRef('rendered-grounding', null, 'text/markdown', payload),
    authority: packet.authority,
    files: [
      { path: packetPath, bytes: Buffer.byteLength(packetText), sha256: digest(packetText) },
      { path: payloadPath, bytes: Buffer.byteLength(payload), sha256: digest(payload) }
    ]
  };
  const workflow = {
    workItem: { id: workId },
    workflowSnapshot: { snapshotHash: workflowInstanceId },
    resolution: {
      worldModelHistoryPin: pin
    }
  };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items', workId);
  const renderedText = `# Prompt\n\n${payload}Continue.\n`;
  const recorded = await recordInjection(root, workflow, phase, {
    ...rendered, agent: 'architect', renderedText, fresh: true,
    sourceComparison: { status: 'fresh', reasonCode: null }, persistedGrounding: receipt
  }, { workDir });
  assert.deepEqual(recorded.record.persistedGrounding, receipt);
  const replayed = await readPromptGeneration(root, workflow, phase, {
    workDir, agent: 'architect'
  });
  assert.deepEqual(replayed.record.persistedGrounding, receipt);

  const recordFile = path.join(root, recorded.file);
  const originalRecordText = await readFile(recordFile, 'utf8');
  const oversizedRecord = JSON.parse(originalRecordText);
  oversizedRecord.persistedGrounding.files.find(({ path: file }) => file === payloadPath).bytes
    = (32 * 1024 * 1024) + 1;
  await writeFile(recordFile, JSON.stringify(oversizedRecord));
  await assert.rejects(
    () => readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
      && /invalid payload identity/u.test(error.message)
  );

  const invalidUtf8 = Buffer.from(payload);
  invalidUtf8[0] = 0xff;
  const invalidUtf8Record = JSON.parse(originalRecordText);
  invalidUtf8Record.persistedGrounding.files.find(({ path: file }) => file === payloadPath).sha256
    = digest(invalidUtf8);
  await writeFile(recordFile, JSON.stringify(invalidUtf8Record));
  await writeFile(path.join(root, payloadPath), invalidUtf8);
  await assert.rejects(
    () => readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
      && /payload is not valid UTF-8/u.test(error.message)
  );

  await writeFile(recordFile, originalRecordText);
  await writeFile(path.join(root, payloadPath), payload);
  if (process.platform !== 'win32') {
    await unlink(path.join(root, payloadPath));
    await symlink(
      path.join(root, 'singularity/world-model/architecture/overview.md'),
      path.join(root, payloadPath)
    );
    await assert.rejects(
      () => readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' }),
      (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
        && /could not safely resolve its payload/u.test(error.message)
    );
    await unlink(path.join(root, payloadPath));
    await writeFile(path.join(root, payloadPath), payload);
  }

  await writeFile(path.join(root, payloadPath), `${payload}tampered\n`);
  await assert.rejects(
    () => readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
});

test('persisted Story grounding refuses coordinated substitutions outside its sealed phase plan', async (t) => {
  const cases = [
    {
      name: 'alternate model',
      mutate: {
        packetMutator(packet) {
          packet.model = {
            modelKey: `sha256:${'0'.repeat(64)}`,
            bindingRef: wmpObjectRef(
              'model-binding', 'world-model-model-binding', 'application/json',
              '{"model":"substituted"}'
            ),
            modelPayloadSha256: `sha256:${'a'.repeat(64)}`
          };
        }
      }
    },
    {
      name: 'reordered view selection',
      mutate: {
        packetMutator(packet) {
          packet.views = packet.views.toReversed().map((view, order) => ({ ...view, order }));
        }
      }
    },
    {
      name: 'different phase-agent plan',
      mutate: {
        pinMutator(pin) {
          pin.phasePlans[0].agent = 'developer';
        }
      }
    },
    {
      name: 'different composition budget',
      mutate: {
        packetMutator(packet) {
          packet.budget.maximum = 16384;
        }
      }
    },
    {
      name: 'mutated sealed pin',
      mutate: {
        sealedPinMutator(pin) {
          pin.composition.maximumBytes = 16384;
        }
      }
    }
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async () => {
      const fixture = await coordinatedPersistedGroundingFixture(
        `ENG-WMP-FORGE-${index + 1}`, entry.mutate
      );
      await assert.rejects(
        () => recordInjection(
          fixture.root, fixture.workflow, fixture.phase, {
            ...fixture.rendered,
            agent: 'architect',
            renderedText: `# Prompt\n\n${fixture.payload}Continue.\n`,
            fresh: true,
            sourceComparison: { status: 'fresh', reasonCode: null },
            persistedGrounding: fixture.receipt
          },
          { workDir: fixture.workDir }
        ),
        (error) => error?.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
      );
    });
  }
});

test('prompt injection persists and verifies the exact advisory TKR composition receipt', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workId = 'ENG-TKR-SHADOW';
  const {
    compiled, workflowSnapshotSha256, repositoryDomainSha256, sourceSha256, tokenEconomy
  } = shadowPrompt(workId);
  const workflow = {
    workItem: { id: workId },
    workflowSnapshot: { snapshotHash: workflowSnapshotSha256 },
    resolution: {
      tokenEconomy,
      sourceSha256,
      capability: {
        effectiveResolution: { repository: { identitySha256: repositoryDomainSha256 } }
      }
    }
  };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items', workId);
  const recorded = await recordInjection(root, workflow, phase, {
    ...rendered,
    agent: 'architect',
    renderedText: compiled.text,
    promptBudget: durableShadowPromptBudget(compiled),
    tokenReduction: compiled.tokenReduction.record.receipt
  }, { workDir });

  assert.equal(recorded.record.tokenReduction.activation, 'shadow');
  assert.equal(recorded.record.tokenReduction.receiptSha256,
    compiled.tokenReduction.record.receiptSha256);
  assert.equal(recorded.record.promptBudget.tokenReduction.mode, 'shadow');
  assert.equal(recorded.record.promptBudget.tokenReduction.record.scope.generation, 1);
  assert.equal(recorded.record.promptBudget.economics.prompt.tkrCandidatePromptBytes,
    compiled.tokenReduction.record.candidateRef.bytes);
  const verified = await readPromptGeneration(root, workflow, phase, {
    workDir, agent: 'architect'
  });
  assert.deepEqual(verified.tokenReductionVerification, { status: 'verified', code: null });
  assert.deepEqual(verified.record.promptBudget, recorded.record.promptBudget);

  const receiptPath = path.join(root, recorded.file);
  const originalReceiptBytes = await readFile(receiptPath, 'utf8');
  const corruptSummaryOnly = JSON.parse(originalReceiptBytes);
  corruptSummaryOnly.promptBudget.tokenReduction.record.candidateRef.bytes += 1;
  const corruptSummaryCore = structuredClone(
    corruptSummaryOnly.promptBudget.tokenReduction.record
  );
  delete corruptSummaryCore.shadowSha256;
  corruptSummaryOnly.promptBudget.tokenReduction.record.shadowSha256 = recordSha256(
    corruptSummaryCore
  );
  await writeFile(receiptPath, `${JSON.stringify(corruptSummaryOnly, null, 2)}\n`);
  const summaryDegraded = await readPromptGeneration(root, workflow, phase, {
    workDir, agent: 'architect'
  });
  assert.equal(summaryDegraded.tokenReductionVerification.status, 'verified');
  assert.equal(summaryDegraded.record.promptBudget.tokenReduction, undefined);
  const summaryBytesBeforeReuse = await readFile(receiptPath, 'utf8');
  const summaryReused = await recordInjection(root, workflow, phase, {
    ...rendered,
    agent: 'architect',
    renderedText: compiled.text,
    promptBudget: durableShadowPromptBudget(compiled),
    tokenReduction: compiled.tokenReduction.record.receipt
  }, { workDir });
  assert.equal(summaryReused.reused, true);
  assert.equal(await readFile(receiptPath, 'utf8'), summaryBytesBeforeReuse,
    'a bad advisory summary must not block or rewrite the selected legacy prompt');

  await writeFile(receiptPath, originalReceiptBytes);
  const corruptShadow = JSON.parse(originalReceiptBytes);
  // Coordinate every public hash as an attacker could. The reader must still derive the exact
  // candidate from the trusted legacy snapshot instead of accepting a self-consistent claim.
  const inventedCandidateSha256 = `sha256:${'f'.repeat(64)}`;
  corruptShadow.tokenReduction.candidatePrompt.sha256 = inventedCandidateSha256;
  corruptShadow.tokenReduction.composition.sha256 = inventedCandidateSha256;
  corruptShadow.tokenReduction.compositionManifestSha256 = recordSha256(
    corruptShadow.tokenReduction.composition
  );
  const receiptCore = structuredClone(corruptShadow.tokenReduction);
  delete receiptCore.receiptSha256;
  corruptShadow.tokenReduction.receiptSha256 = recordSha256(receiptCore);
  const shadowSummary = corruptShadow.promptBudget.tokenReduction.record;
  shadowSummary.receiptSha256 = corruptShadow.tokenReduction.receiptSha256;
  shadowSummary.candidateRef.sha256 = inventedCandidateSha256;
  const shadowCore = structuredClone(shadowSummary);
  delete shadowCore.shadowSha256;
  shadowSummary.shadowSha256 = recordSha256(shadowCore);
  await writeFile(receiptPath, `${JSON.stringify(corruptShadow, null, 2)}\n`);
  const degraded = await readPromptGeneration(root, workflow, phase, {
    workDir, agent: 'architect'
  });
  assert.equal(degraded.text, compiled.text);
  assert.equal(degraded.tokenReductionVerification.status, 'unavailable');
  assert.equal(degraded.record.tokenReduction, null);
  assert.equal(degraded.record.promptBudget.tokenReduction, undefined);
  assert.equal(
    Object.hasOwn(degraded.record.promptBudget.economics.prompt, 'tkrCandidatePromptBytes'),
    false
  );

  const bytesBeforeReuse = await readFile(receiptPath, 'utf8');
  const reused = await recordInjection(root, workflow, phase, {
    ...rendered,
    agent: 'architect',
    renderedText: compiled.text,
    promptBudget: durableShadowPromptBudget(compiled),
    tokenReduction: compiled.tokenReduction.record.receipt
  }, { workDir });
  assert.equal(reused.reused, true);
  assert.equal(reused.tokenReductionVerification.status, 'unavailable');
  assert.equal(await readFile(receiptPath, 'utf8'), bytesBeforeReuse,
    'advisory degradation must not rewrite immutable prompt history');

  corruptShadow.tokenReduction.activation = 'active';
  await writeFile(receiptPath, `${JSON.stringify(corruptShadow, null, 2)}\n`);
  const nonShadowWorkflow = structuredClone(workflow);
  nonShadowWorkflow.resolution.tokenEconomy.mode = 'assist';
  await assert.rejects(
    () => readPromptGeneration(
      root, nonShadowWorkflow, phase, { workDir, agent: 'architect' }
    ),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
});

test('receipt-only recovery restores exact legacy bytes despite corrupt advisory TKR', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workId = 'ENG-TKR-RECEIPT-RECOVERY';
  const {
    compiled, workflowSnapshotSha256, repositoryDomainSha256, sourceSha256, tokenEconomy
  } = shadowPrompt(workId);
  const workflow = {
    workItem: { id: workId },
    workflowSnapshot: { snapshotHash: workflowSnapshotSha256 },
    resolution: {
      tokenEconomy,
      sourceSha256,
      capability: {
        effectiveResolution: { repository: { identitySha256: repositoryDomainSha256 } }
      }
    }
  };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items', workId);
  const injection = {
    ...rendered,
    agent: 'architect',
    renderedText: compiled.text,
    promptBudget: durableShadowPromptBudget(compiled),
    tokenReduction: compiled.tokenReduction.record.receipt
  };
  const recorded = await recordInjection(root, workflow, phase, injection, { workDir });
  const receiptPath = path.join(root, recorded.file);
  const promptPath = path.join(root, recorded.promptFile);
  await unlink(promptPath);

  const corrupt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const inventedCandidateSha256 = `sha256:${'e'.repeat(64)}`;
  corrupt.tokenReduction.candidatePrompt.sha256 = inventedCandidateSha256;
  corrupt.tokenReduction.composition.sha256 = inventedCandidateSha256;
  corrupt.tokenReduction.compositionManifestSha256 = recordSha256(
    corrupt.tokenReduction.composition
  );
  const corruptCore = structuredClone(corrupt.tokenReduction);
  delete corruptCore.receiptSha256;
  corrupt.tokenReduction.receiptSha256 = recordSha256(corruptCore);
  const corruptBytes = `${JSON.stringify(corrupt, null, 2)}\n`;
  await writeFile(receiptPath, corruptBytes);

  const recovered = await recordInjection(root, workflow, phase, injection, { workDir });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.text, compiled.text);
  assert.equal(recovered.tokenReductionVerification.status, 'unavailable');
  assert.equal(recovered.record.tokenReduction, null);
  assert.equal(await readFile(receiptPath, 'utf8'), corruptBytes,
    'recovery must preserve the existing immutable receipt');
  assert.equal(await readFile(promptPath, 'utf8'), compiled.text,
    'recovery must restore only the exact selected legacy snapshot');
});

test('prompt injection strips an advisory summary that is not bound to its receipt', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workId = 'ENG-TKR-SPLIT';
  const {
    compiled, workflowSnapshotSha256, repositoryDomainSha256, sourceSha256, tokenEconomy
  } = shadowPrompt(workId);
  const workflow = {
    workItem: { id: workId },
    workflowSnapshot: { snapshotHash: workflowSnapshotSha256 },
    resolution: {
      tokenEconomy,
      sourceSha256,
      capability: {
        effectiveResolution: { repository: { identitySha256: repositoryDomainSha256 } }
      }
    }
  };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items', workId);
  const promptBudget = durableShadowPromptBudget(compiled);
  const shadow = promptBudget.tokenReduction.record;
  shadow.receiptSha256 = `sha256:${'f'.repeat(64)}`;
  const core = structuredClone(shadow);
  delete core.shadowSha256;
  shadow.shadowSha256 = recordSha256(core);

  const recorded = await recordInjection(root, workflow, phase, {
    ...rendered,
    agent: 'architect',
    renderedText: compiled.text,
    promptBudget,
    tokenReduction: compiled.tokenReduction.record.receipt
  }, { workDir });
  assert.equal(recorded.record.tokenReduction.receiptSha256,
    compiled.tokenReduction.record.receipt.receiptSha256);
  assert.equal(recorded.record.promptBudget.tokenReduction, undefined);
  assert.equal(Object.hasOwn(
    recorded.record.promptBudget.economics.prompt, 'tkrCandidatePromptBytes'
  ), false);
});

test('v5 receipt-only generation recovers after advisory shadow fields are introduced', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workId = 'ENG-TKR-V5-RECOVERY';
  const {
    compiled, workflowSnapshotSha256, repositoryDomainSha256, sourceSha256, tokenEconomy
  } = shadowPrompt(workId);
  const workflow = {
    workItem: { id: workId },
    workflowSnapshot: { snapshotHash: workflowSnapshotSha256 },
    resolution: {
      tokenEconomy,
      sourceSha256,
      capability: {
        effectiveResolution: { repository: { identitySha256: repositoryDomainSha256 } }
      }
    }
  };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items', workId);
  const injection = {
    ...rendered,
    agent: 'architect',
    renderedText: compiled.text,
    promptBudget: durableShadowPromptBudget(compiled),
    tokenReduction: compiled.tokenReduction.record.receipt
  };
  const first = await recordInjection(root, workflow, phase, injection, { workDir });
  await unlink(path.join(root, first.promptFile));
  const legacy = JSON.parse(await readFile(path.join(root, first.file), 'utf8'));
  legacy.schemaVersion = 5;
  delete legacy.tokenReduction;
  delete legacy.promptBudget.tokenReduction;
  delete legacy.promptBudget.economics.prompt.tkrCandidatePromptBytes;
  delete legacy.promptBudget.economics.prompt.tkrCandidateByteDelta;
  delete legacy.promptBudget.economics.prompt.tkrCandidateAssurance;
  await writeFile(path.join(root, first.file), `${JSON.stringify(legacy, null, 2)}\n`);

  const recovered = await recordInjection(root, workflow, phase, injection, { workDir });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.storedVersion, 5);
  assert.equal(recovered.record.schemaVersion, currentSchemaVersion('prompt-injection'));
  assert.equal(recovered.text, compiled.text);
});

test('snapshot-backed prompt persistence never invents live provenance when an adapter omits it', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workflow = {
    workItem: { id: 'ENG-SNAPSHOT-OMITTED' },
    workflowSnapshot: { snapshotHash: `sha256:${'a'.repeat(64)}` }
  };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-SNAPSHOT-OMITTED');
  const { record } = await recordInjection(root, workflow, phase, {
    ...rendered, agent: 'architect', renderedText: '# Snapshot-backed prompt\n'
  }, { workDir });
  assert.deepEqual(record.executionContext, { mode: 'historical-unproven' });
});

test('recordInjection requires stable reasons for stale or unavailable source comparisons', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' });
  const workflow = { workItem: { id: 'ENG-SOURCE' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-SOURCE');
  await assert.rejects(
    recordInjection(root, workflow, phase, {
      ...rendered, agent: 'architect', renderedText: '# Source comparison\n', fresh: false,
      sourceComparison: { status: 'unavailable', reasonCode: 'contains arbitrary prose' }
    }, { workDir }),
    /stable reason code/
  );
});

test('recordInjection preserves prompt-study, agent, and remote-skill provenance', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' });
  const workflow = { workItem: { id: 'ENG-10' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-10');
  const promptStudy = {
    studyRunId: 'architect-prompts@2',
    variant: { id: 'evidence-first', label: 'Evidence first' },
    governedAgent: { id: 'architect', sha256: 'a'.repeat(64) },
    phase: 'design'
  };
  const promptDefinition = {
    path: 'singularity/work-items/ENG-10/measurement/prompt.md',
    sourcePath: 'singularity/prompts/architect-evidence.md',
    sha256: 'b'.repeat(64),
    bytes: 42
  };
  const remoteSkills = [{ id: 'security-guide', sha256: 'c'.repeat(64) }];
  const { record } = await recordInjection(root, workflow, phase, {
    ...rendered,
    agent: 'architect',
    renderedText: '# Exact prompt-study composition\n',
    promptStudy,
    promptDefinition,
    remoteSkills
  }, { workDir });
  assert.deepEqual(record.promptStudy, promptStudy);
  assert.deepEqual(record.promptDefinition, promptDefinition);
  assert.deepEqual(record.remoteSkills, remoteSkills);
});

test('recordInjection refuses diagnostic prose and paths in durable grounding reasons', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  await assert.rejects(
    () => recordInjection(root, { workItem: { id: 'ENG-11' } }, {
      id: 'design', generation: 0
    }, {
      ...rendered,
      agent: 'architect',
      groundingAvailability: {
        status: 'unavailable',
        reasonCode: 'missing at /Users/example/private/repository'
      }
    }, { workDir: path.join(root, 'singularity/work-items/ENG-11') }),
    /stable reason code/
  );
});

test('recordInjection reuses a verified generation without rewriting its receipt or snapshot', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workflow = { workItem: { id: 'ENG-REUSE' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-REUSE');
  const injection = {
    ...rendered,
    agent: 'architect',
    task: 'design',
    renderedText: '# Immutable generation prompt\n',
    compositionCache: { key: 'a'.repeat(64), hit: false }
  };

  const first = await recordInjection(root, workflow, phase, injection, { workDir });
  const recordBefore = await readFile(path.join(root, first.file), 'utf8');
  const promptBefore = await readFile(path.join(root, first.promptFile), 'utf8');
  const second = await recordInjection(root, workflow, phase, {
    ...injection,
    compositionCache: { ...injection.compositionCache, hit: true }
  }, { workDir });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.record.injectedAt, first.record.injectedAt);
  assert.equal(await readFile(path.join(root, first.file), 'utf8'), recordBefore);
  assert.equal(await readFile(path.join(root, first.promptFile), 'utf8'), promptBefore);
  const verified = await readPromptGeneration(root, workflow, phase, {
    workDir, agent: 'architect', task: 'design'
  });
  assert.equal(verified.text, injection.renderedText);
  assert.equal(verified.record.compositionCache.key, 'a'.repeat(64));
  assert.equal(verified.record.compositionCache.promptSha256, verified.record.renderedSha256);
});

test('recordInjection refuses a different composition for an occupied generation', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workflow = { workItem: { id: 'ENG-CONFLICT' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-CONFLICT');
  const first = await recordInjection(root, workflow, phase, {
    ...rendered, agent: 'architect', renderedText: '# First prompt\n'
  }, { workDir });
  const recordBefore = await readFile(path.join(root, first.file), 'utf8');

  await assert.rejects(
    () => recordInjection(root, workflow, phase, {
      ...rendered, agent: 'architect', renderedText: '# Different prompt\n'
    }, { workDir }),
    (error) => error.code === 'PROMPT_GENERATION_CONFLICT'
  );
  await assert.rejects(
    () => recordInjection(root, workflow, phase, {
      ...rendered, agent: 'developer', renderedText: '# First prompt\n'
    }, { workDir }),
    (error) => error.code === 'PROMPT_GENERATION_CONFLICT',
    'the same bytes under a different agent are still a different governed composition'
  );
  assert.equal(await readFile(path.join(root, first.file), 'utf8'), recordBefore);
  assert.equal(await readFile(path.join(root, first.promptFile), 'utf8'), '# First prompt\n');
});

test('prompt-generation reuse refuses a corrupt snapshot instead of replacing it', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workflow = { workItem: { id: 'ENG-CORRUPT' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-CORRUPT');
  const injection = { ...rendered, agent: 'architect', renderedText: '# Original prompt\n' };
  const first = await recordInjection(root, workflow, phase, injection, { workDir });
  await writeFile(path.join(root, first.promptFile), '# Locally changed prompt\n');

  await assert.rejects(
    () => readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
  await assert.rejects(
    () => recordInjection(root, workflow, phase, injection, { workDir }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
  assert.equal(await readFile(path.join(root, first.promptFile), 'utf8'), '# Locally changed prompt\n');
});

test('prompt-generation persistence repairs an exact interrupted pair and refuses changed orphan bytes', async () => {
  const renderedText = '# Pair prompt\n';

  const promptOnlyRoot = await fixtureRoot();
  const promptOnlyWorkflow = { workItem: { id: 'ENG-PROMPT-ONLY' } };
  const phase = { id: 'design', generation: 0 };
  const promptOnlyWorkDir = path.join(promptOnlyRoot, 'singularity/work-items/ENG-PROMPT-ONLY');
  const promptOnlyPath = path.join(promptOnlyWorkDir, 'context/prompts/design-gen1.md');
  await mkdir(path.dirname(promptOnlyPath), { recursive: true });
  await writeFile(promptOnlyPath, renderedText);
  const promptOnlyRendered = await renderInjection(
    promptOnlyRoot, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const repairedPromptOnly = await recordInjection(promptOnlyRoot, promptOnlyWorkflow, phase, {
    ...promptOnlyRendered, agent: 'architect', renderedText
  }, { workDir: promptOnlyWorkDir });
  assert.equal(repairedPromptOnly.recovered, true);
  assert.equal((await readPromptGeneration(
    promptOnlyRoot, promptOnlyWorkflow, phase,
    { workDir: promptOnlyWorkDir, agent: 'architect' }
  )).text, renderedText);

  const receiptOnlyRoot = await fixtureRoot();
  const receiptOnlyWorkflow = { workItem: { id: 'ENG-RECEIPT-ONLY' } };
  const receiptOnlyWorkDir = path.join(receiptOnlyRoot, 'singularity/work-items/ENG-RECEIPT-ONLY');
  const receiptOnlyRendered = await renderInjection(
    receiptOnlyRoot, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const recorded = await recordInjection(receiptOnlyRoot, receiptOnlyWorkflow, phase, {
    ...receiptOnlyRendered, agent: 'architect', renderedText
  }, { workDir: receiptOnlyWorkDir });
  await unlink(path.join(receiptOnlyRoot, recorded.promptFile));
  const repairedReceiptOnly = await recordInjection(receiptOnlyRoot, receiptOnlyWorkflow, phase, {
    ...receiptOnlyRendered, agent: 'architect', renderedText
  }, { workDir: receiptOnlyWorkDir });
  assert.equal(repairedReceiptOnly.recovered, true);
  assert.equal(await readFile(path.join(receiptOnlyRoot, recorded.promptFile), 'utf8'), renderedText);

  const corruptReceiptRoot = await fixtureRoot();
  const corruptReceiptWorkflow = { workItem: { id: 'ENG-CORRUPT-RECEIPT' } };
  const corruptReceiptWorkDir = path.join(
    corruptReceiptRoot, 'singularity/work-items/ENG-CORRUPT-RECEIPT'
  );
  const corruptRendered = await renderInjection(
    corruptReceiptRoot, definition([{ when: {}, include: ['architecture/*'] }]),
    { agent: 'architect' }
  );
  const corruptRecorded = await recordInjection(
    corruptReceiptRoot, corruptReceiptWorkflow, phase,
    {
      ...corruptRendered,
      agent: 'architect',
      renderedText,
      compositionCache: { key: 'c'.repeat(64) }
    },
    { workDir: corruptReceiptWorkDir }
  );
  await unlink(path.join(corruptReceiptRoot, corruptRecorded.promptFile));
  const corruptReceiptPath = path.join(corruptReceiptRoot, corruptRecorded.file);
  const corruptReceipt = JSON.parse(await readFile(corruptReceiptPath, 'utf8'));
  corruptReceipt.compositionCache.promptSha256 = 'd'.repeat(64);
  await writeFile(corruptReceiptPath, `${JSON.stringify(corruptReceipt, null, 2)}\n`);
  await assert.rejects(
    () => recordInjection(corruptReceiptRoot, corruptReceiptWorkflow, phase, {
      ...corruptRendered,
      agent: 'architect',
      renderedText,
      compositionCache: { key: 'c'.repeat(64) }
    }, { workDir: corruptReceiptWorkDir }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
  await assert.rejects(readFile(path.join(corruptReceiptRoot, corruptRecorded.promptFile), 'utf8'), /ENOENT/);

  const changedRoot = await fixtureRoot();
  const changedWorkflow = { workItem: { id: 'ENG-CHANGED-ORPHAN' } };
  const changedWorkDir = path.join(changedRoot, 'singularity/work-items/ENG-CHANGED-ORPHAN');
  const changedPath = path.join(changedWorkDir, 'context/prompts/design-gen1.md');
  await mkdir(path.dirname(changedPath), { recursive: true });
  await writeFile(changedPath, '# Different orphan prompt\n');
  const changedRendered = await renderInjection(
    changedRoot, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  await assert.rejects(
    () => recordInjection(changedRoot, changedWorkflow, phase, {
      ...changedRendered, agent: 'architect', renderedText
    }, { workDir: changedWorkDir }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
});

test('concurrent first composers cannot overwrite one prompt-generation slot', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workflow = { workItem: { id: 'ENG-RACE' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-RACE');
  const candidates = ['# Concurrent prompt A\n', '# Concurrent prompt B\n'];
  const settled = await Promise.allSettled(candidates.map((renderedText) => recordInjection(
    root, workflow, phase, { ...rendered, agent: 'architect', renderedText }, { workDir }
  )));
  const completed = settled.filter((result) => result.status === 'fulfilled');
  const refused = settled.filter((result) => result.status === 'rejected');

  assert.equal(completed.length, 1);
  assert.equal(refused.length, 1);
  assert.ok(['SUBJECT_LOCK_BUSY', 'PROMPT_GENERATION_CONFLICT'].includes(refused[0].reason.code));
  const stored = await readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' });
  assert.ok(candidates.includes(stored.text));
  assert.equal(
    stored.record.renderedSha256,
    createHash('sha256').update(stored.text).digest('hex')
  );
  const losingText = candidates.find((candidate) => candidate !== stored.text);
  await assert.rejects(
    () => recordInjection(root, workflow, phase, {
      ...rendered, agent: 'architect', renderedText: losingText
    }, { workDir }),
    (error) => error.code === 'PROMPT_GENERATION_CONFLICT'
  );
  assert.equal(
    (await readPromptGeneration(root, workflow, phase, { workDir, agent: 'architect' })).text,
    stored.text,
    'a retry after the concurrent writer completes still cannot replace the winning snapshot'
  );
});

test('a path occupied at the final persistence boundary is preserved and refused', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(
    root, definition([{ when: {}, include: ['architecture/*'] }]), { agent: 'architect' }
  );
  const workflow = { workItem: { id: 'ENG-EXTERNAL-RACE' } };
  const phase = { id: 'design', generation: 0 };
  const workDir = path.join(root, 'singularity/work-items/ENG-EXTERNAL-RACE');
  const foreign = '# Created by another process\n';

  await assert.rejects(
    () => recordInjection(root, workflow, phase, {
      ...rendered, agent: 'architect', renderedText: '# Candidate prompt\n'
    }, {
      workDir,
      beforePersist: async ({ promptFile }) => {
        await mkdir(path.dirname(promptFile), { recursive: true });
        await writeFile(promptFile, foreign);
      }
    }),
    (error) => error.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED'
  );
  assert.equal(
    await readFile(path.join(workDir, 'context/prompts/design-gen1.md'), 'utf8'),
    foreign,
    'exclusive publication must not replace a path that wins the final race'
  );
  await assert.rejects(
    readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'),
    /ENOENT/
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
import { readJson, run } from '../src/util.mjs';

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
    ...rendered, agent: 'architect', renderedText
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

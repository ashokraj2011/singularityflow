import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordInjection } from '../src/inject.mjs';
import { recordClarificationResponses } from '../src/clarifications.mjs';
import { expectedPreparationContextPaths, expectedStepOwnedPaths } from '../src/recovery-preparation-context.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { run } from '../src/util.mjs';

async function fixture(t, phaseId = 'custom-specification') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-recovery-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  const phase = { id: phaseId, generation: 0, clarification: { mode: 'required', maxQuestions: 5 } };
  const config = { workItemRoot: 'governed/items', agents: { architect: {} } };
  const workflow = { workItem: { id: 'CTX-1' }, resolution: {
    agents: config.agents, phases: [{ id: phaseId, clarification: phase.clarification }]
  } };
  const itemRoot = `${config.workItemRoot}/${workflow.workItem.id}`;
  const recorded = await recordInjection(root, workflow, phase, {
    agent: 'architect', sections: [], renderedText: '# Governed phase prompt\n',
    groundingAvailability: { status: 'unavailable', reasonCode: 'WORLD_MODEL_UNAVAILABLE' },
    sourceComparison: { status: 'unavailable', reasonCode: 'WORLD_MODEL_UNAVAILABLE' }
  }, { workDir: path.join(root, itemRoot) });
  const clarification = await recordClarificationResponses(root, config, workflow, phase, {
    responses: [{ id: 'scope', question: 'What is in scope?', answer: 'The approved scope.' }],
    actor: { name: 'Human Reviewer' }, agent: 'architect'
  });
  const changedPaths = [recorded.file, recorded.promptFile, clarification.path];
  const options = { itemRoot, generation: 1, changedPaths };
  const inspect = overrides => expectedPreparationContextPaths(root, config, workflow, phase, {
    ...options, ...overrides
  });
  return { root, phase, config, workflow, itemRoot, recorded, clarification, changedPaths, inspect };
}

test('recovery recognizes validated generated context for built-in and custom phases and roots', async t => {
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-signoff']) {
    await t.test(id, async t => {
      const value = await fixture(t, id);
      const before = await Promise.all(value.changedPaths.map(relative => readFile(path.join(value.root, relative))));
      assert.deepEqual(await value.inspect(), value.changedPaths);
      assert.deepEqual(await Promise.all(value.changedPaths.map(relative => readFile(path.join(value.root, relative)))), before);
    });
  }
});

test('recovery never admits wrong Story, phase, generation, agent, schema, or snapshot identity', async t => {
  for (const [label, mutate] of [
    ['Story', record => { record.workId = 'OTHER'; }],
    ['phase', record => { record.phase = 'other-phase'; }],
    ['generation', record => { record.generation = 2; }],
    ['agent', record => { record.agent = 'unknown'; }],
    ['schema', record => { record.schemaVersion = 999; }],
    ['snapshot path', record => { record.promptPath = 'outside.md'; }],
    ['snapshot digest', record => { record.renderedSha256 = '0'.repeat(64); }]
  ]) await t.test(label, async t => {
    const value = await fixture(t);
    const record = structuredClone(value.recorded.record);
    mutate(record);
    await writeFile(path.join(value.root, value.recorded.file), JSON.stringify(record));
    assert.deepEqual(await value.inspect(), []);
  });
});

test('recovery leaves a tampered prompt pair manual and hands an interrupted half to composition', async t => {
  const value = await fixture(t);
  await writeFile(path.join(value.root, value.recorded.promptFile), '# Tampered prompt\n');
  assert.deepEqual(await value.inspect(), []);
  // Composition repairs an interrupted pair only when its fresh candidate matches the surviving half
  // byte for byte; holding the half for a person refused that composition.
  await unlink(path.join(value.root, value.recorded.promptFile));
  assert.deepEqual(await value.inspect(), [value.recorded.file]);
  const record = await readFile(path.join(value.root, value.recorded.file));
  await unlink(path.join(value.root, value.recorded.file));
  await writeFile(path.join(value.root, value.recorded.promptFile), value.recorded.text);
  assert.deepEqual(await value.inspect(), [value.recorded.promptFile]);
  await writeFile(path.join(value.root, value.recorded.file), record);
  await writeFile(path.join(value.root, value.recorded.promptFile), value.recorded.text);
  await writeFile(path.join(value.root, value.recorded.file), '{invalid JSON');
  assert.deepEqual(await value.inspect(), []);
});

test('invalid clarification does not acquire authority from a valid composed prompt', async t => {
  for (const [label, mutate] of [
    ['Story', record => { record.workId = 'OTHER'; }],
    ['phase', record => { record.phase = 'other-phase'; }],
    ['generation', record => { record.generation = 2; }],
    ['mode', record => { record.mode = 'off'; }],
    ['actor', record => { record.recordedBy = null; }],
    ['agent', record => { record.agent = 'other-agent'; }],
    ['grounding hash', record => { record.groundingRecordSha256 = '0'.repeat(64); }],
    ['prompt hash', record => { record.promptSha256 = '0'.repeat(64); }],
    ['prompt path', record => { record.promptPath = 'outside.md'; }],
    ['completion', record => { record.completed = false; }]
  ]) await t.test(label, async t => {
    const value = await fixture(t);
    const record = structuredClone(value.clarification.record);
    mutate(record);
    await writeFile(path.join(value.root, value.clarification.path), JSON.stringify(record));
    assert.deepEqual(await value.inspect(), [value.recorded.file, value.recorded.promptFile]);
  });
});

test('the skills audit and its skill copies are the step\'s own record, judged on their own identity', async t => {
  const value = await fixture(t);
  value.config.agents = value.workflow.resolution.agents = { architect: {}, reviewer: {} };
  const copy = `${value.itemRoot}/context/agent-snapshots/architect/qa-checklist-abc.md`;
  const audit = `${value.itemRoot}/context/agents-${value.phase.id}-gen1.json`;
  const text = '# QA checklist\n';
  await mkdir(path.dirname(path.join(value.root, copy)), { recursive: true });
  await writeFile(path.join(value.root, copy), text);
  const record = { schemaVersion: currentSchemaVersion('agent-context-audit'), workId: 'CTX-1', phase: value.phase.id, generation: 1,
    agent: 'architect', nativeCopilotAgent: null, agentSourceSha256: '0'.repeat(64), recordedAt: '2026-10-16T00:00:00.000Z',
    files: [{ id: 'qa-checklist', type: 'skill', url: 'library:qa-checklist', size: text.length, path: copy,
      sha256: createHash('sha256').update(text).digest('hex') }] };
  const write = async (changes = {}) => writeFile(path.join(value.root, audit), JSON.stringify({ ...record, ...changes }));
  const owned = async (changedPaths = [audit, copy]) => new Set(await expectedStepOwnedPaths(value.root, value.config, value.workflow,
    value.phase, { itemRoot: value.itemRoot, generation: 1, changedPaths }));
  await write();
  assert.deepEqual(await owned(), new Set([audit, copy]));
  assert.deepEqual(await owned([audit]), new Set([audit]), 'a copy committed earlier is not this check\'s concern');
  for (const [label, changes] of [['Story', { workId: 'OTHER' }], ['phase', { phase: 'other-phase' }],
    ['generation', { generation: 2 }], ['unconfigured agent', { agent: 'developer' }],
    ['another agent than the prompt record names', { agent: 'reviewer' }]]) {
    await write(changes);
    assert.deepEqual(await owned(), new Set(), label);
  }
  await write();
  await writeFile(path.join(value.root, copy), '# Edited checklist\n');
  assert.deepEqual(await owned(), new Set(), 'an edited copy is not the composed bytes');
  await writeFile(path.join(value.root, copy), text);
  await writeFile(path.join(value.root, audit), '{invalid JSON');
  assert.deepEqual(await owned(), new Set());
  // Left alone: its prompt pair committed (not among the changed paths), or never written.
  await write();
  assert.deepEqual(await owned(), new Set([audit, copy]), 'the committed prompt record still names the agent');
  await unlink(path.join(value.root, value.recorded.file));
  await unlink(path.join(value.root, value.recorded.promptFile));
  assert.deepEqual(await owned(), new Set([audit, copy]), 'composition stopped before writing the prompt');
  await write({ agent: 'reviewer' });
  assert.deepEqual(await owned(), new Set([audit, copy]), 'without a prompt record, any agent the Story configures');
});

test('records the open step writes are its own only when they name this Story, step and generation', async t => {
  const value = await fixture(t);
  const step = `${value.phase.id}-gen1`;
  const context = `${value.itemRoot}/context`;
  const put = async (relative, content) => {
    await mkdir(path.dirname(path.join(value.root, relative)), { recursive: true });
    await writeFile(path.join(value.root, relative), typeof content === 'string' ? content : JSON.stringify(content));
    return relative;
  };
  const identity = { workId: 'CTX-1', phase: value.phase.id, generation: 1 };
  const png = 'PNG bytes';
  value.phase.remoteOutputs = [{ agent: 'architect', resource: 'brief', generation: 1 }];
  const owned = [
    await put(`${value.itemRoot}/STATUS.md`, '# Status\n'),
    await put(`${context}/superseded/${step}-0123456789ab/${step}.json`, {}),
    await put(`${context}/superseded/${step}-0123456789ab/${step}.md`, '# Earlier prompt\n'),
    await put(`${context}/superseded/${step}-0123456789ab/reason.json`, { phase: value.phase.id, generation: 1, reason: 'inputs changed' }),
    await put(`${context}/design-sources-${step}.json`, { kind: 'design-source-provenance', ...identity }),
    await put(`${context}/work-intervals/${step}-baseline.json`, { kind: 'work-interval-baseline', workId: 'CTX-1', phaseId: value.phase.id, generation: 1 }),
    await put(`${context}/spec-indexes/${step}.json`, identity),
    await put(`${context}/claims/${step}-planned.json`, identity),
    await put(`${context}/remote-output-architect-brief-${step}.json`, {}),
    await put(`${context}/mcp/records/mcp-1.json`, { id: 'mcp-1', workId: 'CTX-1', phase: value.phase.id, targetGeneration: 1,
      output: { path: 'context/mcp/outputs/mcp-1/screen.png', sha256: createHash('sha256').update(png).digest('hex') } }),
    await put(`${context}/mcp/outputs/mcp-1/screen.png`, png),
    await put(`${context}/design-inventory/${'a'.repeat(64)}/digest.json`, { kind: 'design-inventory-digest', workId: 'CTX-1', sourceSetSha256: 'a'.repeat(64) }),
    await put(`${context}/design-inventory/${'a'.repeat(64)}/digest.md`, '# Design inventory digest\n')
  ];
  const foreign = [
    await put(`${context}/superseded/${value.phase.id}-gen2-0123456789ab/reason.json`, { phase: value.phase.id, generation: 2 }),
    await put(`${context}/design-sources-other-gen1.json`, { kind: 'design-source-provenance', ...identity, phase: 'other' }),
    await put(`${context}/work-intervals/other-gen1-baseline.json`, { kind: 'work-interval-baseline', workId: 'CTX-1', phaseId: 'other', generation: 1 }),
    await put(`${context}/remote-output-architect-unlisted-${step}.json`, {}),
    await put(`${context}/mcp/records/mcp-2.json`, { id: 'mcp-2', workId: 'OTHER', phase: value.phase.id, targetGeneration: 1 }),
    await put(`${context}/mcp/records/mcp-3.json`, { id: 'mcp-3', workId: 'CTX-1', phase: value.phase.id, targetGeneration: 1,
      output: { path: 'context/mcp/outputs/mcp-3/screen.png', sha256: '0'.repeat(64) } }),
    await put(`${context}/mcp/outputs/mcp-3/screen.png`, 'edited after it was recorded'),
    await put(`${context}/design-inventory/${'b'.repeat(64)}/digest.json`, { kind: 'design-inventory-digest', workId: 'OTHER', sourceSetSha256: 'b'.repeat(64) }),
    await put(`${context}/ast/derivations/${'c'.repeat(64)}.json`, { integritySha256: 'c'.repeat(64) }),
    await put(`${context}/notes.json`, identity),
    await put(`${value.itemRoot}/artifacts/elsewhere.md`, '# Not this step\n')
  ];
  const admitted = await expectedStepOwnedPaths(value.root, value.config, value.workflow, value.phase, {
    itemRoot: value.itemRoot, generation: 1, changedPaths: [...owned, ...foreign] });
  // mcp-3's record names this step; only its edited output copy stays for review.
  assert.deepEqual(new Set(admitted), new Set([...owned, `${context}/mcp/records/mcp-3.json`]));
  assert.deepEqual(await expectedStepOwnedPaths(value.root, value.config, value.workflow, value.phase, {
    itemRoot: value.itemRoot, generation: 2, changedPaths: owned }), [], 'another generation owns nothing here');
});

test('convergence, spec, skill-copy and repository records SFlow commands write are recognised by identity', async t => {
  const value = await fixture(t);
  const context = `${value.itemRoot}/context`;
  const put = async (relative, content) => {
    await mkdir(path.dirname(path.join(value.root, relative)), { recursive: true });
    await writeFile(path.join(value.root, relative), typeof content === 'string' ? content : JSON.stringify(content));
    return relative;
  };
  const skill = '# Skill text\n';
  const skillSha = createHash('sha256').update(skill).digest('hex');
  // A published scope step in rework: spec commands write at its published generation, 2.
  const workflow = { ...value.workflow, phases: { [value.phase.id]: value.phase,
    scope: { id: 'scope', generation: 2, status: 'in_progress' } } };
  const convergence = { ...value.phase, requiredArtifact: { path: 'artifacts/convergence/convergence.md', kind: 'convergence-report' } };
  const owned = [
    await put(`${context}/spec-indexes/scope-gen2.json`, { workId: 'CTX-1', phase: 'scope', generation: 2 }),
    await put(`${context}/claims/scope-gen2-planned.json`, { workId: 'CTX-1', phase: 'scope', generation: 2 }),
    await put(`${context}/spec-quality/scope-gen2-assisted.json`, { workId: 'CTX-1' }),
    await put(`${context}/acceptance/${value.phase.id}-gen1.json`, { workId: 'CTX-1', phase: value.phase.id, generation: 1 }),
    await put(`${context}/agent-snapshots/architect/qa-checklist-${skillSha}.md`, skill),
    await put('.vscode/mcp.json', '{"servers":{}}\n'),
    await put('docs/knowledge/confirmations.yml', 'reviews:\n  - id: k1\n    status: confirmed\n')
  ];
  const foreign = [
    await put(`${context}/spec-indexes/scope-gen1.json`, { workId: 'CTX-1', phase: 'scope', generation: 1 }),
    await put(`${context}/spec-indexes/unknown-gen1.json`, { workId: 'CTX-1', phase: 'unknown', generation: 1 }),
    await put(`${context}/acceptance/scope-gen2.json`, { workId: 'OTHER', phase: 'scope', generation: 2 }),
    await put(`${context}/spec-quality/scope-gen2.json`, { workId: 'CTX-1' }),
    await put(`${context}/agent-snapshots/architect/edited-${skillSha}.md`, '# Edited\n'),
    await put(`${context}/agent-snapshots/stranger/qa-checklist-${skillSha}.md`, skill),
    await put(`${context}/convergence/iteration-1.json`, { workId: 'CTX-1', iteration: 1 }),
    await put('docs/knowledge/notes.yml', 'reviews: []\n'),
    await put('README.md', '# Changed\n')
  ];
  const changedPaths = [...owned, ...foreign];
  const inspect = (phase, flow = workflow) => expectedStepOwnedPaths(value.root, value.config, flow, phase, {
    itemRoot: value.itemRoot, generation: 1, changedPaths });
  assert.deepEqual(new Set(await inspect(value.phase)), new Set(owned), 'a convergence record outside a convergence step stays manual');
  assert.ok((await inspect(convergence)).includes(`${context}/convergence/iteration-1.json`));
  await put('docs/knowledge/confirmations.yml', 'reviews:\n  - id: k1\n    status: guessed\n');
  assert.ok(!(await inspect(value.phase)).includes('docs/knowledge/confirmations.yml'), 'not a confirmations file');
});

test('a step owns its artifact directory only when no other step keeps artifacts there', async t => {
  const value = await fixture(t);
  const artifact = relative => ({ requiredArtifact: { path: relative } });
  const at = relative => `${value.itemRoot}/${relative}`;
  for (const relative of ['artifacts/review/review.md', 'artifacts/review/notes.md', 'artifacts/review/evidence/screen.png',
    'artifacts/plan/plan.md', 'artifacts/review/tasks.md']) {
    await mkdir(path.dirname(path.join(value.root, at(relative))), { recursive: true });
    await writeFile(path.join(value.root, at(relative)), `# ${relative}\n`);
  }
  const phase = { id: 'review', generation: 0, ...artifact('artifacts/review/review.md') };
  const inspect = workflow => expectedStepOwnedPaths(value.root, value.config, workflow, phase, {
    itemRoot: value.itemRoot, generation: 1, changedPaths: ['artifacts/review/notes.md', 'artifacts/review/evidence/screen.png',
      'artifacts/plan/plan.md', 'artifacts/review/tasks.md'].map(at) });
  const workflow = { workItem: { id: 'CTX-1' }, phases: { review: phase, plan: { id: 'plan', ...artifact('artifacts/plan/plan.md') } } };
  assert.deepEqual(new Set(await inspect(workflow)), new Set(['artifacts/review/notes.md', 'artifacts/review/evidence/screen.png', 'artifacts/review/tasks.md'].map(at)));
  // A step whose artifact sits one level up shares the directory: only declared members count.
  const shared = { ...workflow, phases: { ...workflow.phases, summary: { id: 'summary', ...artifact('artifacts/summary.md') } },
    resolution: { phases: [{ id: 'review', artifactSet: 'review-set' }], artifactSets: { 'review-set': { primary: 'review.md',
      members: [{ path: 'review.md', role: 'review', required: true }, { path: 'tasks.md', role: 'tasks', authority: 'advisory' }] } } } };
  assert.deepEqual(await inspect(shared), [at('artifacts/review/tasks.md')]);
  // A folder member covers the files below it.
  const folder = { ...shared, resolution: { ...shared.resolution, artifactSets: { 'review-set': { primary: 'review.md',
    members: [{ path: 'review.md', role: 'review', required: true }, { path: 'evidence/', role: 'evidence', required: true }] } } } };
  assert.deepEqual(await inspect(folder), [at('artifacts/review/evidence/screen.png')]);
  // A step that keeps no artifact (a sign-off) shares no directory with anybody.
  const signOff = { ...workflow, phases: { ...workflow.phases, approval: { id: 'approval' } } };
  assert.deepEqual(new Set(await inspect(signOff)), new Set(await inspect(workflow)));
});

test('recovery never sweeps in older generations, another Story, or arbitrary context files', async t => {
  const value = await fixture(t);
  assert.deepEqual(await value.inspect({ generation: 2 }), []);
  assert.deepEqual(await value.inspect({ changedPaths: [
    `${value.itemRoot}/context/custom-specification-gen0.json`,
    'governed/items/OTHER/context/custom-specification-gen1.json',
    `${value.itemRoot}/context/notes.json`
  ] }), []);
});

test('recovery refuses linked or oversized generated records without discarding them', async t => {
  const value = await fixture(t);
  const target = path.join(value.root, value.recorded.file);
  const original = await readFile(target);
  const linkTarget = path.join(value.root, 'linked-record.json');
  await writeFile(linkTarget, original);
  await unlink(target);
  try { await symlink(linkTarget, target); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('Windows host does not permit symlink fixtures'); return;
    }
    throw error;
  }
  assert.deepEqual(await value.inspect(), []);
  assert.deepEqual(await readFile(target), original);
  await unlink(target);
  await writeFile(target, Buffer.alloc(32 * 1024 * 1024 + 1));
  assert.deepEqual(await value.inspect(), []);
});

test('recovery refuses preparation context under a linked parent directory', async t => {
  const value = await fixture(t);
  const context = path.join(value.root, value.itemRoot, 'context');
  const relocated = path.join(value.root, 'relocated-context');
  await rename(context, relocated);
  try { await symlink(relocated, context, 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('Windows host does not permit symlink fixtures'); return;
    }
    throw error;
  }
  assert.deepEqual(await value.inspect(), []);
  assert.equal(await readFile(path.join(relocated, 'prompts', `${value.phase.id}-gen1.md`), 'utf8'),
    value.recorded.text);
});

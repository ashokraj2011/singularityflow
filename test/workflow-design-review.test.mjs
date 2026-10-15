import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compileWorkflowMarkup } from '../src/workflow-markup.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { planWorkflowImport, applyWorkflowImport, exportWorkflowBundle } from '../src/workflow-transfer.mjs';
import { renderAgentSkills } from '../src/agents.mjs';
import { inspectWorkflowAttachments } from '../src/workflow-intent-attachments.mjs';
import { withWorkflowIntentCatalog } from '../src/workflow-intent-catalog.mjs';

const example = await readFile(new URL('../examples/demo-tagged-workflow.xml', import.meta.url), 'utf8');
const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
async function temporary(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-design-review-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10 })); return root; }
function run(cwd, command, args, env = {}) { const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_ENV: 'test', ...env } }); assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); }

test('optional design review reflects native scope, approvals and return routes without changing the portable bundle', async () => {
  const ordinary = await compileWorkflowMarkup(example), reviewed = await compileWorkflowMarkup(example, { designReview: true });
  assert.equal(ordinary.designReview, undefined);
  assert.deepEqual(reviewed.bundle, ordinary.bundle); assert.equal(reviewed.bundleSha256, ordinary.bundleSha256);
  const design = reviewed.designReview;
  assert.equal(design.phases.length, 4); assert.equal(design.inspection, null);
  assert.equal(design.phases[2].writeScope, 'source-and-artifact');
  assert.equal(design.phases[1].approval.mode, 'required');
  assert.ok(design.edges.some(edge => edge.from === 'demo-tagged-repair' && edge.to === 'demo-tagged-test' && edge.kind === 'return' && edge.maxRounds === 3));
  assert.ok(reviewed.routeSimulation.scenarios.some(row => row.kind === 'exhausted' && row.outcome === 'pause' && row.pausedFor.length));
  assert.equal(reviewed.effects.storyChanged, false); assert.match(design.notice, /not approval or execution/u);
});

test('phase guidance is hash-bound, composes instructions at their skill steps and matches normal post-import composition', async t => {
  const result = await compileWorkflowMarkup(example, { inspectPhase: 'demo-tagged-test' });
  const inspection = result.designReview.inspection;
  assert.equal(inspection.phase, 'demo-tagged-test'); assert.equal(inspection.instructions.length, 3);
  assert.match(inspection.text, /Before checking, follow <instruction/u);
  assert.match(inspection.text, /Record the tested revision/u); assert.ok(!inspection.text.includes('Keep the changed files'));
  assert.equal(inspection.sha256, 'sha256:' + createHash('sha256').update(inspection.text).digest('hex'));
  assert.equal(inspection.runtimeContextIncluded, false); assert.equal(inspection.display, 'complete');
  const root = await temporary(t); await initializeDefinition(root);
  const plan = await planWorkflowImport(root, result.bundle); await applyWorkflowImport(root, result.bundle, { expectedPlanSha256: plan.planSha256 });
  const resolved = resolveWorkType(await loadDefinition(root), 'demo-tagged');
  const guidance = await renderAgentSkills(root, { workItem: { id: 'EXAMPLE', workType: 'demo-tagged' } }, resolved.phases[1], { agent: inspection.agent.id });
  assert.ok(inspection.text.endsWith(guidance.text));
  const reexported = await exportWorkflowBundle(root, ['demo-tagged']);
  assert.deepEqual(reexported.assets.filter(item => ['skill','instruction'].includes(item.kind)), result.bundle.assets.filter(item => ['skill','instruction'].includes(item.kind)));
});

test('inspection cannot select a foreign phase, write a bundle, accept repeated flags or create candidate files', async t => {
  const root = await temporary(t), file = path.join(root, 'candidate.xml'); await writeFile(file, example);
  await assert.rejects(compileWorkflowMarkup(example, { inspectPhase: 'other-phase' }), { code: 'WORKFLOW_MARKUP_PHASE_UNKNOWN' });
  await assert.rejects(compileWorkflowMarkup(example, { inspectPhase: 'demo-tagged-test', out: path.join(root, 'must-not-exist.json') }));
  for (const args of [['--inspect-phase', 'other-phase'], ['--design-review', '--design-review'], ['--inspect-phase', 'demo-tagged-test', '--out', 'bad.json']]) {
    const r = spawnSync(process.execPath, [cli, 'workflow', 'markup', 'compile', file, ...args, '--json'], { cwd: root, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
  }
  assert.deepEqual(await readdir(root), ['candidate.xml']);
});

test('attachment relationships resolve only within the selection, report missing/external references and retain scoped metadata', async t => {
  const root = await temporary(t); await mkdir(path.join(root, 'checks'));
  const skill = path.join(root, 'checks/SKILL.md'), instruction = path.join(root, 'ui.instructions.md');
  await writeFile(skill, 'Use [UI rules](../ui.instructions.md), [missing](missing.md) and [outside](https://example.invalid/private).');
  await writeFile(instruction, '---\napplyTo: "src/**/*.tsx"\n---\nKeep keyboard access.');
  const captured = await inspectWorkflowAttachments({ folders: [root] });
  const procedure = captured.items.find(item => item.name.endsWith('/SKILL.md'));
  assert.deepEqual(procedure.references.map(ref => ref.status), ['resolved', 'not-in-capture', 'external']);
  assert.equal(procedure.references[0].targetId, captured.items.find(item => item.name.endsWith('/ui.instructions.md')).id);
  assert.ok(!JSON.stringify(procedure.references).includes('https://'));
  assert.equal(captured.items.find(item => item.classification.kind === 'instruction').classification.scope, 'src/**/*.tsx');
  await writeFile(instruction, '['.repeat(128 * 1024));
  const repeated = await inspectWorkflowAttachments({ files: [instruction] });assert.equal(repeated.items[0].referenceCount, 0);
});

test('an attached source can compile, pass reviewed import and start its own Story in an isolated local repository', async t => {
  const base = await temporary(t), root = path.join(base, 'checkout'), remote = path.join(base, 'origin.git'); await mkdir(root);
  run(base, 'git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  run(root, 'git', ['init', '-q', '-b', 'main']);run(root, 'git', ['config', 'user.name', 'Designer test']);run(root, 'git', ['config', 'user.email', 'designer@example.invalid']);run(root, 'git', ['remote', 'add', 'origin', remote]);
  await writeFile(path.join(root, 'README.md'), '# Isolated designer acceptance\n'); await initializeDefinition(root);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const local = path.join(base, 'INSTRUCTIONS.md'); await writeFile(local, 'Only authorized humans approve final acceptance.');
  const captured = await inspectWorkflowAttachments({ files: [local] });
  const original = captured.items[0];
  // This deterministic candidate is the model boundary fixture, not a claim that Copilot ran.
  const catalog = await withWorkflowIntentCatalog(null, { source: 'installed' }, value => value.sourceSha256);
  const source = example.replace('version="1"', `version="2" catalog="${catalog}" catalog-source="installed"`)
    .replace('The agent proposes a route; only authorized humans approve scope, returns and final acceptance.', original.content)
    .replace('</workflow>', `<attachment id="${original.id}" sha256="${original.sha256}" kind="instruction" maps-to="instruction:demo-tagged-authority"/>
      <intent family="visual-acceptance"><description>Check, repair and retain evidence with human checkpoints.</description>
      <requirement id="test-and-repair" maps-to="phase:demo-tagged-test phase:demo-tagged-repair">Test independently and repair failures.</requirement><pattern ref="test-repair"/><pattern ref="human-checkpoint"/></intent></workflow>`);
  const compiled = await compileWorkflowMarkup(source, { designReview: true });
  assert.equal(compiled.attachmentMappings[0].id, original.id);
  assert.ok(compiled.bundle.assets.find(item => item.kind === 'instruction' && item.id === 'demo-tagged-authority').content.includes(original.content));
  const plan = await planWorkflowImport(root, compiled.bundle); assert.equal(plan.status, 'ready', JSON.stringify(plan.conflicts));
  await applyWorkflowImport(root, compiled.bundle, { expectedPlanSha256: plan.planSha256 });
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.worldModel.grounding = 'off'; definition.repositoryReadiness.requiredBeforeStory = false;
  for (const authority of Object.values(definition.approvalAuthorities)) authority.members = [{ name: 'Designer test', email: 'designer@example.invalid' }];
  await writeFile(definitionFile, YAML.stringify(definition));
  run(root, 'git', ['add', '.']);run(root, 'git', ['commit', '-qm', 'Approve isolated test configuration']);run(root, 'git', ['push', '-q', '-u', 'origin', 'main']);run(root, 'git', ['push', '-q', 'origin', 'main:refs/heads/sflow/config']);
  const state = JSON.parse(run(root, process.execPath, [cli, 'start', 'DESIGNER-E2E', '--work-type', 'demo-tagged', '--from-branch', 'main', '--isolated-worktree', '--title', 'Designer acceptance', '--description', 'Verify generated workflow intake without running application code.', '--json'], {
    SINGULARITY_FLOW_TEST_IDENTITY: 'Designer test', SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'no-workspace'), SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'no-registry') }));
  const started = state.data ?? state; assert.ok(started.repositoryPath);
  const story = JSON.parse(await readFile(path.join(started.repositoryPath, 'singularity/work-items/DESIGNER-E2E/workflow.json'), 'utf8'));
  assert.equal(story.workItem.workType, 'demo-tagged'); assert.equal(story.currentPhase, 'demo-tagged-intake');
  assert.equal(await readFile(local, 'utf8'), original.content);
});

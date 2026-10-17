import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { catalogAgentView } from '../src/agent-catalog-presentation.mjs';
import { boundedAgentOutput, completeAgentResult } from '../src/agent-output.mjs';

test('compact catalog retains exact full definitions, attachment scope and protected actions', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const skills = Array.from({ length: 7 }, (_, i) => ({ id: `example-${i}`, label: `Example ${i}`, description: 'Verify behavior',
    instructions: 'Exact instructions. '.repeat(100), path: `skills/example-${i}/SKILL.md`, instructionRefs: ['standards'],
    usedBy: [{ workflow: 'one-workflow', phases: ['check'], use: 'Check only this phase' }] }));
  const result = { resultType: 'sflow-utility-entry', operation: 'skill list', repositoryPath: f.repository,
    readCompleted: true, data: { resultType: 'skill-master', skills, problems: [], drafts: [{ id: 'pending', status: 'review-required' }] } };
  const rendered = await boundedAgentOutput(JSON.stringify(result), { cwd: f.repository });
  assert.ok(Buffer.byteLength(rendered) <= 7500);
  const view = JSON.parse(rendered);
  assert.equal(view.catalogView.metadataOnly, true);
  assert.equal(view.catalogView.shown, 7);
  assert.equal(view.data.skills[0].instructions, undefined);
  assert.deepEqual(view.data.skills[0].usedBy, skills[0].usedBy);
  assert.deepEqual(view.data.drafts, result.data.drafts);
  const fullText = await readFile(view.agentOutput.path, 'utf8');
  assert.equal(view.agentOutput.sha256, 'sha256:' + createHash('sha256').update(fullText).digest('hex'));
  assert.deepEqual(JSON.parse(fullText).data.skills, skills);
  assert.equal(view.data.skills[0].recordSha256, 'sha256:' + createHash('sha256').update(JSON.stringify(skills[0])).digest('hex'));
  assert.equal(catalogAgentView({ ...result, operation: 'skill show example-0' }), null);
  for (const packet of [{ resultType: 'sflow-phase-entry', context: { text: 'Required author prompt' } },
    { resultType: 'sflow-source-review-context', sources: [{ text: 'Exact source' }] }, { ...result, error: { code: 'NO_AUTHORITY' } }]) {
    assert.equal(catalogAgentView(packet), null, 'review, authoring, refusals are not catalog summaries');
  }
});

test('selected long instructions round-trip through exact retained text without catalog expansion', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const instructions = 'Retain exact Unicode instructions: café.\n'.repeat(200);
  const result = { resultType: 'skill-master', skills: [{ id: 'long-skill', instructions }] };
  const rendered = await boundedAgentOutput(JSON.stringify(result), { cwd: f.repository });
  const view = JSON.parse(rendered);
  assert.equal(view.skills[0].detailField, 'skills[0]');
  const retained = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
  assert.equal(await readFile(retained.skills[0].instructions.textFile, 'utf8'), instructions);
  assert.equal(completeAgentResult(rendered).skills[0].instructions, instructions);
});

test('workflow metadata is bounded and binds exact original phase contracts; large lists declare more', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const result = { resultType: 'sflow-utility-entry', operation: 'workflow list', repositoryPath: f.repository,
    data: Array.from({ length: 40 }, (_, i) => ({ id: `workflow-${i}`, label: `Workflow ${i}`, status: 'pending-review',
      phases: [{ id: 'check', approval: { authorities: ['human-reviewers'] } }] })) };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: f.repository }));
  assert.equal(view.catalogView.total, 40);
  assert.equal(view.catalogView.more, true);
  assert.ok(view.catalogView.shown > 0 && view.catalogView.shown <= 20);
  if (view.catalogView.detailLevel === 'identity') assert.equal(view.data[0].phaseCount, 1);
  else assert.deepEqual(view.data[0].phases, ['check']);
  assert.equal(view.data[0].status, 'pending-review', 'a candidate is never shown as active');
  assert.deepEqual(JSON.parse(await readFile(view.agentOutput.path, 'utf8')).data, result.data);
});

test('identity-first fallback lists every name before rich partial scope metadata', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const skills = Array.from({ length: 11 }, (_, i) => ({ id: `skill-${i}`, label: `Skill ${i}`,
    description: 'Detailed description '.repeat(30), instructions: 'Do exactly this. '.repeat(100),
    usedBy: Array.from({ length: 8 }, (_, j) => ({ workflow: `workflow-${j}`, phases: ['check'], use: 'Bound phase scope' })) }));
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'skill-master', skills }), { cwd: f.repository }));
  assert.equal(view.catalogView.detailLevel, 'identity');
  assert.equal(view.catalogView.more, false);
  assert.deepEqual(view.skills.map(row => row.id), skills.map(row => row.id));
  assert.deepEqual(completeAgentResult(view).skills, skills, 'attachment scope and instructions stay exact for selected expansion');
  const workflows = Array.from({ length: 20 }, (_, i) => ({ id: `workflow-${i}`, label: `Workflow ${i}`,
    description: 'Workflow purpose and instructions '.repeat(10), governs: 'story', status: 'current',
    phases: Array.from({ length: 6 }, (_, j) => ({ id: `phase-${j}`, approval: { authorities: ['reviewers'] } })) }));
  const workflowView = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'sflow-utility-entry',
    operation: 'workflow list', data: workflows }), { cwd: f.repository }));
  assert.equal(workflowView.catalogView.detailLevel, 'identity');
  assert.equal(workflowView.catalogView.more, false);
  assert.deepEqual(workflowView.data.map(row => row.id), workflows.map(row => row.id));
  assert.deepEqual(completeAgentResult(workflowView).data, workflows);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { applyInputsBlock, collectInputs, renderInputsBlock } from '../src/inputs.mjs';
import { createPlanningContext } from '../src/planning.mjs';
import { snapshot } from '../src/util.mjs';

const machineRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-planning-dedup-machine-'));
const machineEnvironment = {
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineRoot, 'workspaces.json'),
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineRoot, 'active-workspace.json'),
  SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineRoot, 'lead-registry.json'),
  SINGULARITY_FLOW_WMB_SHARED_CACHE: path.join(machineRoot, 'wmb-cache')
};
const originalEnvironment = Object.fromEntries(
  Object.keys(machineEnvironment).map((key) => [key, process.env[key]])
);
Object.assign(process.env, machineEnvironment);
after(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(machineRoot, { recursive: true, force: true });
});

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function occurrences(text, value) { return text.split(value).length - 1; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

test('planning projects a prepared draft before budgeting without changing raw source identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-planning-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Planning Dedup Tester']);
  git(root, ['config', 'user.email', 'planning-dedup@example.invalid']);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.planning = { ...definition.planning, maxContextBytes: 16_384 };
  await writeFile(definitionPath, YAML.stringify(definition));

  const id = 'PLAN-REPEAT';
  const itemRelative = `singularity/work-items/${id}`;
  const itemDirectory = path.join(root, itemRelative);
  const inputPath = `${itemRelative}/artifacts/intake/intake.md`;
  const targetPath = `${itemRelative}/artifacts/design/design.md`;
  const approvedMarker = 'APPROVED-RETRY-BOUNDARY: Stop after exactly three failed attempts.';
  const draftMarker = 'UNIQUE-CURRENT-DRAFT: Preserve the authored recovery design.';
  const approved = `# Approved intake\n\n${approvedMarker}\n\n${'Approved supporting evidence. '.repeat(320)}\n`;
  await mkdir(path.dirname(path.join(root, inputPath)), { recursive: true });
  await mkdir(path.dirname(path.join(root, targetPath)), { recursive: true });
  await writeFile(path.join(root, inputPath), approved);
  const inputSnapshot = await snapshot(path.join(root, inputPath));
  const phase = {
    id: 'design', label: 'Design', defaultAgent: 'architect', status: 'in_progress', generation: 0,
    requiredArtifact: { path: 'artifacts/design/design.md', kind: 'design', minimumBytes: 1 },
    inputs: [{ phase: 'intake', optional: false, maxBytes: null, path: 'artifacts/intake/intake.md' }],
    generationPolicy: {
      requirement: 'required', defaultProducer: 'governed-agent',
      allowedProducers: ['governed-agent', 'human'], producer: 'agent', task: null
    },
    approvalPolicy: { authorities: [], minimum: 0 }, qualityCommands: [], writeScope: 'artifact-only'
  };
  const workflow = {
    workItem: { id, workType: 'feature', workTypeLabel: 'Feature', title: 'Bounded retry handling' },
    currentPhase: phase.id, phaseOrder: ['intake', phase.id],
    resolution: {
      worldModelGrounding: 'off', inputsMode: 'enforce',
      intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' },
      phases: [{ id: phase.id, inputs: phase.inputs }]
    },
    phases: {
      intake: {
        id: 'intake', status: 'approved', generation: 1,
        approvedAt: '2026-09-03T00:00:00.000Z', approvedBy: 'reviewer',
        requiredArtifact: { path: 'artifacts/intake/intake.md' },
        artifacts: [{ path: inputPath, status: 'approved', ...inputSnapshot }]
      },
      design: phase
    },
    changeRequests: []
  };
  await writeFile(path.join(itemDirectory, 'source.json'), JSON.stringify({
    type: 'manual', id, title: workflow.workItem.title,
    description: 'Preserve approved inputs and unique current draft content.',
    acceptanceCriteria: [], labels: []
  }));
  await writeFile(path.join(itemDirectory, 'workflow.json'), JSON.stringify(workflow));
  const inputs = await collectInputs(root, workflow, phase, { itemDirectory, itemRelative });
  assert.deepEqual(inputs.errors, []);
  const inputBlock = renderInputsBlock(inputs).text;
  const prepared = applyInputsBlock(
    `# Current design draft\n\n{{inputs}}\n\n${draftMarker}\n`, inputBlock, inputs.mode
  );
  assert.ok(Buffer.byteLength(inputBlock + prepared) > definition.planning.maxContextBytes,
    'the unprojected replay must exceed the context bound before the unique draft tail');
  await writeFile(path.join(root, targetPath), prepared);
  const draftSnapshot = await snapshot(path.join(root, targetPath));
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Initialize isolated planning repetition fixture']);
  const beforeHead = git(root, ['rev-parse', 'HEAD']);

  const result = await createPlanningContext(root, {
    scope: 'work-item', id, phase: phase.id, agent: 'architect', target: 'artifact'
  });

  assert.equal(occurrences(result.context, approvedMarker), 1);
  assert.equal(occurrences(result.context, '<!-- singularity-flow:inputs:start -->'), 1);
  assert.equal(occurrences(result.context, draftMarker), 1);
  assert.equal(result.manifest.context.truncated, false);
  const retainedContext = await readFile(result.contextPath, 'utf8');
  assert.doesNotMatch(retainedContext, /# Reply personalization/);
  assert.equal(digest(retainedContext), result.manifest.context.sha256,
    'the host reply overlay is outside the retained planning prompt hash');
  const approvedSource = result.manifest.sources.find((source) => source.kind === 'approved-input');
  const draftSource = result.manifest.sources.find((source) => source.kind === 'current-draft');
  assert.equal(approvedSource.sha256, inputSnapshot.sha256);
  assert.equal(approvedSource.bytes, inputSnapshot.size);
  assert.equal(draftSource.sha256, draftSnapshot.sha256);
  assert.equal(draftSource.bytes, draftSnapshot.size);
  assert.equal(await readFile(path.join(root, targetPath), 'utf8'), prepared);
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(git(root, ['status', '--short']), '');
});

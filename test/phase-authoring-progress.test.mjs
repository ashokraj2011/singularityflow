import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { phaseAuthoringProgress, readPhaseDraftEvidence } from '../src/phase-authoring-progress.mjs';
import { deriveMutationContract, mutationContractPresentation } from '../src/phase-mutation-contract.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { resolveWorkType } from '../src/config.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { phaseUsesDeterministicGeneration } from '../src/manual-authorship.mjs';
import { authoredArtifactFingerprint } from '../src/publication-preflight.mjs';

function workflow(id = 'team-repair', { code = true } = {}) {
  const phase = { id, status: 'in_progress', generation: 0, writeScope: code ? 'source-and-artifact' : 'artifact-only',
    generationPolicy: { requirement: 'required', task: code ? 'code' : 'document',
      defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: `artifacts/${id}/summary.md`, kind: code ? 'implementation-summary' : 'document' } };
  return { workItem: { id: 'PROGRESS-1' }, currentPhase: id, phaseOrder: [id], phases: { [id]: phase }, resolution: {}, history: [] };
}

test('draft milestones never infer code completion, governed test success or publication', () => {
  for (const id of ['implementation', 'self-heal', 'team-defined-build']) {
    const source = workflow(id);
    const phase = source.phases[id];
    const inspect = draftEvidence => phaseAuthoringProgress(source, phase, { draftEvidence });
    const begin = inspect({ draftExists: false, draftModified: false });
    assert.equal(begin.stage, 'open-code-generation');
    assert.equal(begin.next.command, `singularity-flow phase begin ${id} --json`);
    assert.equal(begin.next.copilotCommand, '/sf-code');
    assert.match(begin.instruction, /before any application edit/);
    phase.generationIntent = { status: 'open', generation: 1 };
    const missing = inspect({ draftExists: false, draftModified: false });
    assert.equal(missing.stage, 'create-missing-draft');
    assert.equal(missing.next.command, `singularity-flow prepare ${id}`);
    assert.match(missing.instruction, /Keep existing application edits and tests/);
    assert.match(missing.instruction, /Agent brief.*source\/test bindings/);
    assert.equal(inspect({ draftExists: true, draftModified: false }).stage, 'complete-draft');
    const authored = inspect({ draftExists: true, draftModified: true });
    assert.equal(authored.stage, 'validate-existing-draft');
    assert.equal(authored.next.command, `singularity-flow phase prepublish ${id} --for-agent --json`);
    assert.equal(authored.next.copilotCommand, '/sf-code', 'keep the repair-capable author, not a publish-only turn');
    const before = structuredClone(source);
    const guide = workflowGuide(source, { authoringProgress: authored });
    assert.equal(guide.nextActions[0].command, authored.next.command);
    assert.equal(guide.nextActions[0].reason, authored.instruction);
    const steps = workflowNextSteps(source, { authoringProgress: authored });
    assert.equal(steps[0].command, authored.next.command);
    assert.equal(steps[0].authoringStage, authored.stage);
    assert.deepEqual(source, before);
    for (const progress of [begin, missing, authored]) {
      assert.equal(progress.preserveExistingWork, true);
      assert.equal(progress.codeComplete, 'not-inferred');
      assert.equal(progress.publishReady, false);
      assert.equal(progress.testsAttested, false);
      assert.equal(progress.automaticApproval, false);
      assert.equal(progress.next.modelFreeCommand, null);
    }
  }
});

test('checkpoint allocation and consumed generations share the permission boundary, not a blind begin', () => {
  const source = workflow();
  const phase = source.phases[source.currentPhase];
  phase.generationHighWatermark = 4;
  phase.generationIntent = { status: 'open', generation: 1 };
  assert.equal(phaseAuthoringProgress(source, phase).stage, 'open-code-generation');
  assert.equal(mutationContractPresentation(deriveMutationContract({ definition: {}, workflow: source })).codeAuthoringReady, false);
  phase.generationIntent.generation = 5;
  assert.equal(phaseAuthoringProgress(source, phase).codeGenerationOpen, true);
  assert.equal(mutationContractPresentation(deriveMutationContract({ definition: {}, workflow: source })).codeAuthoringReady, true);
  phase.generationIntent.status = 'consumed';
  const successor = phaseAuthoringProgress(source, phase);
  assert.equal(successor.stage, 'review-successor');
  assert.equal(successor.next.copilotCommand, '/sf-recover');
  assert.match(successor.next.command, /recover PROGRESS-1 --phase team-repair/);
  assert.equal(deriveMutationContract({ definition: {}, workflow: source }).next[0].command, successor.next.command);
  assert.equal(mutationContractPresentation(deriveMutationContract({ definition: {}, workflow: source })).codeAuthoringReady, false);
});

test('all seeded/example phases and future document/code phases use structural milestones', async () => {
  let count = 0;
  for (const file of ['../templates/workflow.yml', '../examples/workflow-with-quality-gates.yml']) {
    const definition = YAML.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    for (const workType of Object.keys(definition.workTypes)) {
      for (const resolved of resolveWorkType(definition, workType).phases) {
        const source = workflow(resolved.id, { code: phaseRequiresCodeDelivery(resolved) });
        const phase = source.phases[resolved.id];
        phase.generationPolicy = resolved.generation;
        if (phaseRequiresCodeDelivery(phase)) phase.generationIntent = { status: 'open', generation: 1 };
        const progress = phaseAuthoringProgress(source, phase, {
          draftEvidence: { draftExists: true, draftModified: true }
        });
        if (phaseUsesDeterministicGeneration(phase) || phase.generationPolicy.requirement === 'none') assert.equal(progress, null);
        else {
          assert.equal(progress.stage, 'validate-existing-draft', `${workType}/${resolved.id}`);
          assert.ok(progress.next?.copilotCommand);
          assert.match(progress.next.command, /phase prepublish/);
        }
        count++;
      }
    }
  }
  assert.ok(count >= 50);
  const custom = workflow('new-team-report', { code: false });
  assert.equal(phaseAuthoringProgress(custom, custom.phases[custom.currentPhase], {
    draftEvidence: { draftExists: true, draftModified: true }
  }).next.copilotCommand, '/sf-phase');
});

test('read-only drafting milestones never override approval, decision, integrity or archived boundaries', () => {
  const source = workflow();
  const phase = source.phases[source.currentPhase];
  const progress = phaseAuthoringProgress(source, phase);
  phase.status = 'awaiting_approval';
  assert.equal(phaseAuthoringProgress(source, phase), null);
  assert.match(workflowGuide(source, { authoringProgress: progress }).nextActions[0].command, /approve/);
  phase.status = 'in_progress';
  source.pendingDecision = { label: 'Route', by: ['human'], options: [{ id: 'repair', label: 'Repair' }], key: 'exact' };
  assert.match(workflowGuide(source, { authoringProgress: progress }).nextActions[0].command, /decision show/);
  delete source.pendingDecision;
  source.status = 'cancelled';
  assert.match(workflowGuide(source, { authoringProgress: progress }).nextActions[0].command, /documents list/);
  source.currentPhase = null;
  assert.equal(phaseAuthoringProgress(source, phase), null);
});

test('current primary artifact inspection ignores managed-only edits and never rewrites bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-authoring-milestones-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = workflow('custom-report', { code: false });
  const phase = source.phases[source.currentPhase];
  const config = { workItemRoot: 'team/stories' };
  const relative = `${config.workItemRoot}/PROGRESS-1/${phase.requiredArtifact.path}`;
  const file = path.join(root, relative);
  const inspect = changedPaths => readPhaseDraftEvidence(root, config, source, phase, { changedPaths });
  assert.deepEqual(await inspect([]), { draftExists: false, draftModified: false });
  await mkdir(path.dirname(file), { recursive: true });
  const template = '# Summary\n\nTODO author the current report.\n';
  phase.authoringBaseline = { path: phase.requiredArtifact.path, fingerprint: authoredArtifactFingerprint(template) };
  const managed = `${template}\n<!-- singularity-flow:inputs:start -->\nApproved input\n<!-- singularity-flow:inputs:end -->\n`;
  await writeFile(file, managed);
  assert.deepEqual(await inspect([relative]), { draftExists: true, draftModified: false });
  await writeFile(file, managed.replace('TODO author the current report.', 'The implemented behavior is recorded, with current evidence.'));
  const bytes = await readFile(file);
  assert.deepEqual(await inspect([]), { draftExists: true, draftModified: true });
  assert.deepEqual(await readFile(file), bytes);
  delete phase.authoringBaseline;
  assert.deepEqual(await inspect([relative]), { draftExists: true, draftModified: true });
  assert.deepEqual(await inspect([]), { draftExists: true, draftModified: false });
  await rm(file);
  await writeFile(path.join(root, 'outside.md'), 'Do not read this as a governed draft.');
  await symlink(path.join(root, 'outside.md'), file);
  await assert.rejects(inspect([]), /symlink|symbolic|linked/i);
});

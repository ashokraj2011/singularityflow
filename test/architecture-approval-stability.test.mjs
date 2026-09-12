import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createArchitectureIntentStabilityGuard } from '../src/architecture-intent-gate.mjs';
import { resolveArchitectureIntentPublicationBinding } from '../src/architecture-intent-service.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { canonicalJson } from '../src/world-model/canonicalize.mjs';
import { createArchitectureIntent } from '../src/world-model/projections/calm/projection.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function intent(workId, elementId) {
  return createArchitectureIntent({
    workId,
    phase: 'planning',
    generation: 1,
    base: {
      worldModelManifestSha256: `sha256:${'a'.repeat(64)}`,
      calmProjectionSha256: `sha256:${'b'.repeat(64)}`
    },
    clauses: [{
      clauseId: `${workId}:ARCH-001`,
      operation: 'remove-node',
      elementId,
      required: false,
      value: {}
    }]
  });
}

test('approval aborts when architecture intent changes after validation and before staging', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-architecture-approval-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Architecture Reviewer']);
  git(root, ['config', 'user.email', 'architecture-reviewer@example.invalid']);

  const workId = 'WRK-ARCH-RACE';
  const relativeDirectory = `singularity/work-items/${workId}`;
  const relativeIntent = `${relativeDirectory}/context/architecture/architecture-intent.json`;
  const target = path.join(root, relativeIntent);
  const accepted = intent(workId, 'legacy-service');
  const concurrent = intent(workId, 'different-service');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, canonicalJson(accepted));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'published architecture intent']);

  const policy = {
    enabled: true,
    allowedPhases: ['planning'],
    blockRequiredUnfulfilledAt: ['verification']
  };
  const definition = { workItemRoot: 'singularity/work-items', architectureIntent: policy };
  const phase = {
    id: 'planning', generation: 1, generationPublications: []
  };
  const workflow = {
    workItem: { id: workId },
    resolution: { workItemRoot: 'singularity/work-items', architectureIntent: policy },
    phaseOrder: ['planning', 'verification'],
    phases: { planning: phase, verification: { id: 'verification', generation: 0 } }
  };
  const binding = await resolveArchitectureIntentPublicationBinding(
    root, definition, workflow, phase, 1
  );
  phase.generationPublications.push({ generation: 1, architectureIntent: binding });
  const stabilityGuard = await createArchitectureIntentStabilityGuard(
    root, definition, workflow, phase, 1, { operation: 'the approval commit' }
  );
  const before = git(root, ['rev-parse', 'HEAD']);
  let injected = false;

  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject: { kind: 'story', id: workId, branch: 'main' },
      allowedPaths: [relativeDirectory],
      event: lifecycleEvent({
        type: 'phase-approved',
        subject: { kind: 'story', id: workId, branch: 'main' },
        phaseId: 'planning',
        generation: 1,
        actor: { kind: 'human', id: 'architecture-reviewer@example.invalid' }
      }),
      commit: { message: `[${workId}][phase:planning][approve] architecture-reviewers` },
      publication: { mode: 'off', branch: 'main', remote: 'origin' },
      state: { write: async () => ({}) },
      stabilityGuard,
      fault: async (stage) => {
        if (stage !== 'after-state-write') return;
        injected = true;
        await writeFile(target, canonicalJson(concurrent));
      }
    }),
    (error) => error?.code === 'PUBLICATION_SNAPSHOT_CHANGED'
      && /Architecture intent evidence changed/.test(error.message)
  );

  assert.equal(injected, true);
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(await readFile(target, 'utf8'), canonicalJson(accepted));

  const unavailableGuard = await createArchitectureIntentStabilityGuard(
    root, definition, workflow, phase, 1, { operation: 'the approval commit' }
  );
  await writeFile(target, '{"incomplete":');
  await assert.rejects(
    unavailableGuard,
    (error) => error?.code === 'PUBLICATION_SNAPSHOT_CHANGED'
      && Object.hasOwn(error.details ?? {}, 'causeCode')
      && !Object.hasOwn(error.details ?? {}, 'cause')
  );
  await writeFile(target, canonicalJson(accepted));
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
});

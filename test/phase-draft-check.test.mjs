import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { phaseDraftCheck } from '../src/phase-draft-check.mjs';

async function fixture({ producer = 'governed-agent', status = 'in_progress' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-draft-check-'));
  const artifactPath = 'singularity/work-items/DRAFT-1/artifacts/planning/plan.md';
  const absolute = path.join(root, artifactPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, '# Plan\n\nTODO describe the implementation sequence.\n');
  const phase = {
    id: 'planning', label: 'Planning', status, generation: status === 'in_progress' ? 0 : 1,
    generationPolicy: {
      defaultProducer: producer,
      allowedProducers: [producer]
    },
    requiredArtifact: {
      path: 'artifacts/planning/plan.md', minimumBytes: 20,
      validation: { requiredHeadings: ['Plan'], forbiddenPlaceholders: [] }
    },
    artifacts: []
  };
  const workflow = {
    workItem: { id: 'DRAFT-1' }, currentPhase: 'planning',
    resolution: { phases: [], artifactSets: {} }, phases: { planning: phase }
  };
  return { root, config: { workItemRoot: 'singularity/work-items' }, workflow, phase, absolute };
}

function boundSession(item, overrides = {}) {
  return { workId: item.workflow.workItem.id, phaseId: item.phase.id, agent: 'architect', ...overrides };
}

test('phase draft check reports actionable authoring findings without changing bytes or invoking a model', async () => {
  const item = await fixture();
  try {
    const before = await readFile(item.absolute, 'utf8');
    const result = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.equal(result.resultType, 'sflow-phase-draft-check');
    assert.equal(result.status, 'correction-required');
    assert.equal(result.producer, 'governed-agent');
    assert.equal(result.correction.class, 'agent-authoring');
    assert.equal(result.correction.sameTurn, true);
    assert.equal(result.correction.automatic, false);
    assert.equal(result.correction.maximumChangedFingerprints, 3);
    assert.equal(result.modelInvocations, 0);
    assert.equal(result.mutates, false);
    assert.match(result.findings[0].message, /unresolved placeholder 'TODO'.*line 3/i);
    assert.equal(result.commands.recheck, 'singularity-flow phase draft-check planning --json');
    assert.equal(await readFile(item.absolute, 'utf8'), before);

    await writeFile(item.absolute, '# Plan\n\nImplement the approved change, then run the mapped tests.\n');
    const clean = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.equal(clean.status, 'ready');
    assert.deepEqual(clean.findings, []);
    assert.notEqual(clean.artifact.fingerprint, result.artifact.fingerprint);
    assert.match(clean.commands.publish, /phase publish planning --authored governed-agent --channel copilot-host/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('phase draft check reports duplicated or truncated managed metadata before publish', async () => {
  const item = await fixture();
  try {
    item.phase.authoringBaseline = {
      generation: 1, path: item.phase.requiredArtifact.path,
      fingerprint: 'sha256:baseline', bytes: 1
    };
    await writeFile(item.absolute, [
      '<!-- singularity-flow:metadata', '{', '  "schemaVersion": 1', '}', '-->', '',
      '<!-- singularity-flow:metadata', '{', '  "schemaVersion": 1,',
      '# Plan', '', 'Implement the approved sequence and mapped tests.', ''
    ].join('\n'));
    const result = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.equal(result.status, 'correction-required');
    assert.equal(result.findings[0].code, 'artifact.metadata.invalid');
    assert.equal(result.findings[0].line, 7);
    assert.match(result.findings[0].message, /rerun prepare once to restore the engine-owned envelope/i);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('phase draft check never offers same-turn overwrite for human review content', async () => {
  const item = await fixture({ producer: 'human' });
  try {
    const result = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase);
    assert.equal(result.status, 'correction-required');
    assert.equal(result.correction.class, 'human-input');
    assert.equal(result.correction.sameTurn, false);
    assert.equal(result.correction.skill, null);
    assert.match(result.correction.guidance, /will not replace human-authored or unknown-authored content/i);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('phase draft check requires exact Story and phase session ownership for agent correction', async () => {
  const item = await fixture();
  try {
    for (const session of [
      null,
      boundSession(item, { workId: 'OTHER-STORY' }),
      boundSession(item, { phaseId: 'requirements' }),
      boundSession(item, { agent: null })
    ]) {
      const result = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, { session });
      assert.equal(result.configuredProducer, 'governed-agent');
      assert.equal(result.producer, 'unknown');
      assert.equal(result.ownership.proven, false);
      assert.equal(result.correction.class, 'human-input');
      assert.equal(result.correction.sameTurn, false);
    }
    const owned = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.equal(owned.ownership.proven, true);
    assert.equal(owned.producer, 'governed-agent');
    assert.equal(owned.correction.sameTurn, true);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('Story draft fingerprint covers sorted supporting review artifacts', async () => {
  const item = await fixture();
  try {
    item.phase.artifactSet = 'planning-review';
    item.workflow.resolution.artifactSets = {
      'planning-review': {
        primary: 'plan.md',
        members: [
          { path: 'notes.md', role: 'notes', required: false, authority: 'governed' },
          { path: 'plan.md', role: 'primary', required: true, authority: 'governed' }
        ]
      }
    };
    const notes = path.join(path.dirname(item.absolute), 'notes.md');
    await writeFile(item.absolute, '# Plan\n\nImplement the approved change.\n');
    await writeFile(notes, '# Notes\n\nTODO capture the rollout owner.\n');
    const first = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.deepEqual(first.artifacts.map((artifact) => artifact.path), [
      'singularity/work-items/DRAFT-1/artifacts/planning/notes.md',
      'singularity/work-items/DRAFT-1/artifacts/planning/plan.md'
    ]);
    assert.equal(first.artifact.path, 'singularity/work-items/DRAFT-1/artifacts/planning/plan.md');

    await writeFile(notes, '# Notes\n\nThe rollout owner is the platform team.\n');
    const second = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.equal(second.status, 'ready');
    assert.equal(second.artifact.fingerprint, first.artifact.fingerprint);
    assert.notEqual(second.draftFingerprint, first.draftFingerprint);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('an awaiting-approval artifact requires a new generation instead of changing reviewed bytes', async () => {
  const item = await fixture({ status: 'awaiting_approval' });
  try {
    const result = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
      session: boundSession(item)
    });
    assert.equal(result.status, 'correction-required');
    assert.equal(result.correction.sameTurn, false);
    assert.equal(result.correction.requiresNewGeneration, true);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test('draft correction uses the task owner instead of hard-coding the generic phase skill', async () => {
  const code = await fixture();
  const convergence = await fixture({ producer: 'deterministic' });
  try {
    code.phase.id = 'implementation';
    code.phase.generationPolicy.task = 'code';
    code.workflow.currentPhase = 'implementation';
    code.workflow.phases = { implementation: code.phase };
    const codeResult = await phaseDraftCheck(
      code.root, code.config, code.workflow, code.phase,
      { session: boundSession(code, { phaseId: 'implementation', agent: 'developer' }) }
    );
    assert.equal(codeResult.correction.skill, '/sf-code');

    convergence.phase.id = 'convergence';
    convergence.phase.generationPolicy.defaultProducer = 'deterministic';
    convergence.phase.generationPolicy.allowedProducers = ['deterministic'];
    convergence.workflow.currentPhase = 'convergence';
    convergence.workflow.phases = { convergence: convergence.phase };
    const convergenceResult = await phaseDraftCheck(
      convergence.root, convergence.config, convergence.workflow, convergence.phase
    );
    assert.equal(convergenceResult.configuredProducer, 'deterministic');
    assert.equal(convergenceResult.correction.skill, null,
      'kernel regeneration is never presented as agent authoring');
  } finally {
    await rm(code.root, { recursive: true, force: true });
    await rm(convergence.root, { recursive: true, force: true });
  }
});

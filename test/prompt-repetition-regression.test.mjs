import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { registerReference, resolveReference } from '../src/harness-imports.mjs';
import {
  promptAuditStatus, recordPromptAudit, setPromptAudit
} from '../src/prompt-audit.mjs';
import { snapshot } from '../src/util.mjs';
import { setAgentSession } from '../src/session.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');
const promptRepetitionMachineState = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-repeat-machine-'));
const promptRepetitionEnvironment = {
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(promptRepetitionMachineState, 'workspaces.json'),
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(promptRepetitionMachineState, 'active-workspace.json'),
  SINGULARITY_FLOW_LEAD_REGISTRY: path.join(promptRepetitionMachineState, 'lead-registry.json'),
  SINGULARITY_FLOW_WMB_SHARED_CACHE: path.join(promptRepetitionMachineState, 'wmb-shared-cache')
};
const originalMachineEnvironment = Object.fromEntries(
  Object.keys(promptRepetitionEnvironment).map((key) => [key, process.env[key]])
);
Object.assign(process.env, promptRepetitionEnvironment);
after(async () => {
  for (const [key, value] of Object.entries(originalMachineEnvironment)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(promptRepetitionMachineState, { recursive: true, force: true });
});

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function flow(root, args) {
  const machineState = path.join(root, '.isolated-machine-state');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'lead-registry.json')
    }
  });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function occurrences(text, value) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += value.length;
  }
  return count;
}

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Prompt Repetition Tester']);
  git(root, ['config', 'user.email', 'prompt-repetition@example.com']);
  return root;
}

async function compositionFixture(t) {
  const root = await repository(t, 'sflow-prompt-repetition-');
  await initializeDefinition(root);

  const workId = 'REPEAT-1';
  const itemRelative = `singularity/work-items/${workId}`;
  const itemDirectory = path.join(root, itemRelative);
  const inputPath = `${itemRelative}/artifacts/intake/intake.md`;
  const referencePath = `${itemRelative}/artifacts/intake/convergence-evidence.md`;
  const sharedParagraph = 'The approved retry boundary is three attempts, after which processing stops and reports a durable failure to the operator.';
  const uniqueReferenceParagraph = 'The convergence check uniquely observed that the recovery marker remains queryable after the terminal attempt.';
  const managedFillerMarker = 'MANAGED-INPUT-REPLAY-MUST-NOT-REACH-THE-MODEL';
  const managedReplay = Array.from({ length: 320 }, (_, index) =>
    `${managedFillerMarker}-${String(index).padStart(3, '0')} ${'captured upstream evidence '.repeat(3)}`
  ).join('\n');
  const referenceText = [
    '# Convergence evidence', '',
    '<!-- singularity-flow:inputs:start -->',
    '## Captured approved intake', '', sharedParagraph, '', managedReplay,
    '<!-- singularity-flow:inputs:end -->', '',
    '## Producer-authored convergence result', '', uniqueReferenceParagraph, ''
  ].join('\n');

  assert.ok(Buffer.byteLength(referenceText.slice(0, referenceText.indexOf('<!-- singularity-flow:inputs:end -->')), 'utf8') > 16_384,
    'the managed block must cross the normal preview bound to reproduce truncation-before-projection');

  await mkdir(path.dirname(path.join(root, inputPath)), { recursive: true });
  await writeFile(path.join(root, inputPath), [
    '# Approved intake', '', sharedParagraph, '',
    'The phase input also fixes the owner and acceptance boundary.'
  ].join('\n'));
  await writeFile(path.join(root, referencePath), referenceText);
  await writeFile(path.join(itemDirectory, 'source.json'), `${JSON.stringify({
    type: 'manual', id: workId, title: 'Bounded retry handling',
    description: 'Preserve unique convergence evidence without replaying approved input text.',
    acceptanceCriteria: ['Shared evidence is presented once.'], labels: []
  }, null, 2)}\n`);

  git(root, ['add', 'singularity', '.github/agents']);
  git(root, ['commit', '-m', 'Initialize prompt projection fixture']);
  const referenceBytes = await readFile(path.join(root, referencePath));
  const registered = await registerReference(root, {
    repository: { id: 'fixture', origin: null },
    subject: { kind: 'story', id: workId, branch: workId, subjectRevision: 1 },
    artifact: {
      phaseId: 'intake', generation: 1, outputId: 'convergence-evidence',
      path: referencePath, mediaType: 'text/markdown'
    },
    revision: {
      commitSha: git(root, ['rev-parse', 'HEAD']),
      sha256: createHash('sha256').update(referenceBytes).digest('hex'),
      bytes: referenceBytes.length
    },
    visibility: 'model'
  });
  const input = await snapshot(path.join(root, inputPath));
  await writeFile(path.join(itemDirectory, 'workflow.json'), `${JSON.stringify({
    workItem: { id: workId, workType: 'feature', title: 'Bounded retry handling' },
    currentPhase: 'design',
    phaseOrder: ['intake', 'design'],
    resolution: {
      worldModelGrounding: 'warn',
      inputsMode: 'enforce',
      harnessImports: { mode: 'record', previewTextBytes: 16_384, totalEnvelopeBytes: 32_768 }
    },
    phases: {
      intake: {
        id: 'intake', status: 'approved', generation: 1,
        approvedAt: '2026-09-03T00:00:00.000Z', approvedBy: 'reviewer',
        requiredArtifact: { path: 'artifacts/intake/intake.md' },
        artifacts: [{ path: inputPath, status: 'approved', ...input }]
      },
      design: {
        id: 'design', label: 'Design', defaultAgent: 'developer', status: 'in_progress', generation: 0,
        requiredArtifact: { path: 'artifacts/design/design.md', kind: 'design', minimumBytes: 1 },
        inputs: [{ phase: 'intake', optional: false, maxBytes: null, path: 'artifacts/intake/intake.md' }],
        generationPolicy: {
          requirement: 'required', defaultProducer: 'governed-agent',
          allowedProducers: ['governed-agent', 'human'], producer: 'agent', task: null
        },
        approvalPolicy: { authorities: [], minimum: 0 },
        writeScope: 'artifact-only'
      }
    },
    lineage: {
      submissions: [{
        phase: 'intake', generation: 1,
        projection: { references: [{ handle: registered.handle, required: true }] }
      }]
    },
    changeRequests: []
  }, null, 2)}\n`);

  return {
    root, workId, sharedParagraph, uniqueReferenceParagraph, managedFillerMarker,
    referenceText, registered
  };
}

test('governed reference projection precedes the byte bound for a large managed input block', async (t) => {
  const fixture = await compositionFixture(t);
  const projectionOptions = {
    authoredMarkdown: true,
    maxBytes: 16_384,
    totalEnvelopeBytes: 32_768
  };
  const projected = await resolveReference(fixture.root, fixture.registered.handle, projectionOptions);
  const projectedAgain = await resolveReference(fixture.root, fixture.registered.handle, projectionOptions);

  assert.deepEqual(projectedAgain, projected, 'projection of the immutable reference is deterministic');
  assert.equal(projected.source.rawBytes, Buffer.byteLength(fixture.referenceText, 'utf8'),
    'source authority continues to describe the complete registered artifact');
  assert.equal(projected.source.rawSha256,
    createHash('sha256').update(fixture.referenceText).digest('hex'),
    'source authority remains bound to the unprojected registered bytes');
  assert.ok(projected.managedBytesExcluded > 16_384,
    'the projection excludes a managed replay larger than the configured preview bound');
  assert.ok(projected.preview.text.includes(fixture.uniqueReferenceParagraph),
    'producer-authored text after the oversized managed block survives projection');
  assert.ok(!projected.preview.text.includes(fixture.sharedParagraph),
    'captured input text inside the managed block is projected out');
  assert.ok(!projected.preview.text.includes(fixture.managedFillerMarker),
    'no prefix of the oversized managed block leaks through the bounded preview');
  assert.ok(projected.preview.bytes <= projectionOptions.maxBytes);

  const args = [
    'wm', 'compose', '--phase', 'design', '--work-id', fixture.workId,
    '--agent', 'developer', '--render-only'
  ];

  const first = flow(fixture.root, args);
  const second = flow(fixture.root, args);

  assert.equal(second, first, 'the same governed inputs produce the same projected prompt');
  assert.equal(occurrences(first, fixture.sharedParagraph), 1,
    'the captured phase input remains visible but is not replayed by the governed reference');
  assert.equal(occurrences(first, fixture.managedFillerMarker), 0,
    'managed replay filler is absent from the composed prompt');
  assert.equal(occurrences(first, fixture.uniqueReferenceParagraph), 1,
    'reference-only evidence remains visible after projection');
});

test('an immediate identical wm-compose miss reuses the audit record without appending raw prompt bytes', async (t) => {
  const root = await repository(t, 'sflow-prompt-audit-repeat-');
  const status = await setPromptAudit(root, true);
  const input = {
    agent: 'architect',
    phase: 'convergence',
    workId: 'REPEAT-2',
    workType: 'spec-driven-standard',
    generation: 1,
    task: 'analyze',
    source: 'wm-compose',
    prompt: '# Deterministic governed prompt\n\nInspect the approved evidence once.\n',
    compositionCache: { key: 'c'.repeat(64), hit: false }
  };

  const first = await recordPromptAudit(root, input);
  const rawAfterFirst = await readFile(status.logFile, 'utf8');
  const repeated = await recordPromptAudit(root, { ...input, compositionCache: { ...input.compositionCache } });
  const rawAfterRepeat = await readFile(status.logFile, 'utf8');

  assert.equal(repeated.id, first.id);
  assert.equal(repeated.deduplicated, true);
  assert.equal(rawAfterRepeat, rawAfterFirst, 'the append-only log does not receive a second prompt body');
  assert.equal((await promptAuditStatus(root)).count, 1);
});

test('phase prompt selection keeps a current explicit agent override but drops an outgoing phase agent', async (t) => {
  const fixture = await compositionFixture(t);
  const definition = await loadDefinition(fixture.root);
  const render = (args = []) => flow(fixture.root, [
    'wm', 'compose', '--phase', 'design', '--work-id', fixture.workId,
    '--render-only', ...args
  ]);

  await setAgentSession(
    fixture.root, definition, null, 'architect', fixture.workId,
    { phaseId: 'design', source: 'explicit-override' }
  );
  assert.equal(render(), render(['--agent', 'architect']),
    'a session override bound to the current phase remains the selected prompt agent');

  await setAgentSession(
    fixture.root, definition, null, 'architect', fixture.workId,
    { phaseId: 'intake', source: 'phase-default' }
  );
  assert.equal(render(), render(['--agent', 'developer']),
    'an outgoing phase session cannot create a second prompt under the previous agent');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { activeClauseCapsule, buildActiveClauseCapsule } from '../src/active-clause-capsule.mjs';
import { buildSpecIndex } from '../src/specifications.mjs';
import { snapshot } from '../src/util.mjs';

test('active clause capsule carries every predecessor clause verbatim with risks and clarifications', () => {
  const workflow = {
    workItem: { id: 'ORDER-1' },
    phaseOrder: ['requirements', 'design', 'implementation'],
    phases: {
      requirements: { id: 'requirements', generation: 1 }, design: { id: 'design', generation: 1 }, implementation: { id: 'implementation', generation: 1 }
    },
    changeRequests: [{
      id: 'CR-001', status: 'open', targetPhase: 'implementation',
      clauseIds: ['ORDER:AC-004'], comment: 'Retain the retry constraint.'
    }]
  };
  const records = { indexes: [{
    phase: 'requirements', source: { path: 'requirements.md', sha256: 'a'.repeat(64) },
    clauses: [{
      id: 'ORDER:AC-004', body: 'Retries stop after three attempts.', bodySha256: 'b'.repeat(64),
      source: { path: 'requirements.md', line: 12 }, dependsOn: ['ORDER:REQ-001']
    }]
  }] };
  const result = buildActiveClauseCapsule(
    records, workflow, workflow.phases.implementation, { risks: ['Retry storms'] }
  );
  assert.match(result.text, /# Active Clause Capsule/);
  assert.match(result.text, /Retries stop after three attempts\./);
  assert.equal(result.capsule.clauses[0].representation, 'verbatim');
  assert.equal(result.capsule.clauses[0].continuityProof, 'present-verbatim');
  assert.deepEqual(result.capsule.openRisks, ['Retry storms']);
  assert.deepEqual(result.capsule.clarifications[0].clauseIds, ['ORDER:AC-004']);
  assert.match(result.capsule.capsuleSha256, /^sha256:[a-f0-9]{64}$/);
});

test('active clause capsule never imports the current or later phase indexes', () => {
  const workflow = {
    workItem: { id: 'ORDER-2' }, phaseOrder: ['requirements', 'implementation'],
    phases: { requirements: { id: 'requirements', generation: 1 }, implementation: { id: 'implementation', generation: 1 } }
  };
  const records = { indexes: [{
    phase: 'implementation', source: { sha256: 'a'.repeat(64) },
    clauses: [{ id: 'ORDER:REQ-999', body: 'Future text', bodySha256: 'b'.repeat(64), dependsOn: [] }]
  }] };
  const result = buildActiveClauseCapsule(records, workflow, workflow.phases.implementation);
  assert.equal(result.capsule.clauses.length, 0);
  assert.equal(result.text, '');
});

test('legacy workflows without phaseOrder degrade to a safe empty predecessor set', () => {
  const workflow = {
    workItem: { id: 'ORDER-LEGACY' }, currentPhase: 'design',
    phases: { design: { id: 'design', generation: 1 } }
  };
  const records = { indexes: [{
    phase: 'design', source: { sha256: 'a'.repeat(64) },
    clauses: [{ id: 'ORDER:CURRENT', body: 'Current clause', bodySha256: 'b'.repeat(64) }]
  }] };
  const result = buildActiveClauseCapsule(records, workflow, workflow.phases.design);
  assert.equal(result.text, '');
  assert.deepEqual(result.capsule.clauses, []);
});

async function anchoredFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-clause-capsule-'));
  const itemRelative = 'singularity/work-items/ORDER-TRUST';
  const itemDirectory = path.join(root, itemRelative);
  const sourceRelative = `${itemRelative}/artifacts/requirements/requirements.md`;
  const indexRelative = `${itemRelative}/context/spec-indexes/requirements-gen1.json`;
  await mkdir(path.dirname(path.join(root, sourceRelative)), { recursive: true });
  await writeFile(path.join(root, sourceRelative), [
    '# Requirements', '', '[ORDER:REQ-001] Preserve approved retry behavior.'
  ].join('\n'));
  const source = await snapshot(path.join(root, sourceRelative));
  const index = await buildSpecIndex(root, sourceRelative, {
    workId: 'ORDER-TRUST', phase: 'requirements', generation: 1,
    outputPath: indexRelative, policy: { mode: 'enforce', namespace: 'ORDER' }
  });
  const workflow = {
    workItem: { id: 'ORDER-TRUST' }, phaseOrder: ['requirements', 'implementation'],
    phases: {
      requirements: {
        id: 'requirements', status: 'approved', generation: 1,
        specIndex: {
          generation: 1, path: indexRelative, clauses: index.clauses.length,
          indexSha256: index.indexSha256, sourceSha256: index.source.sha256
        },
        artifacts: [{ path: sourceRelative, status: 'approved', ...source }]
      },
      implementation: { id: 'implementation', status: 'not_started', generation: 0 }
    }
  };
  return { root, itemDirectory, indexRelative, sourceRelative, workflow };
}

test('active clause capsule verifies the approved source and durable index anchor before injection', async () => {
  const value = await anchoredFixture();
  const result = await activeClauseCapsule(
    value.itemDirectory, value.workflow, value.workflow.phases.implementation, null, { root: value.root }
  );
  assert.match(result.text, /Preserve approved retry behavior/);

  const tamperedIndex = JSON.parse(await readFile(path.join(value.root, value.indexRelative), 'utf8'));
  tamperedIndex.clauses[0].body = 'Weaken the approved retry behavior.';
  await writeFile(path.join(value.root, value.indexRelative), `${JSON.stringify(tamperedIndex, null, 2)}\n`);
  await assert.rejects(
    () => activeClauseCapsule(
      value.itemDirectory, value.workflow, value.workflow.phases.implementation, null, { root: value.root }
    ),
    (error) => error.code === 'SPECIFICATION_INDEX_UNTRUSTED'
  );
});

test('active clause capsule refuses a stale source or workflow anchor before model composition', async () => {
  const staleSource = await anchoredFixture();
  await writeFile(path.join(staleSource.root, staleSource.sourceRelative), '# Requirements\n\n[ORDER:REQ-001] Altered.\n');
  await assert.rejects(
    () => activeClauseCapsule(
      staleSource.itemDirectory, staleSource.workflow,
      staleSource.workflow.phases.implementation, null, { root: staleSource.root }
    ),
    (error) => error.code === 'SPECIFICATION_INDEX_UNTRUSTED'
      && error.details.problems.some((problem) => /source/.test(problem))
  );

  const staleAnchor = await anchoredFixture();
  staleAnchor.workflow.phases.requirements.specIndex.clauses += 1;
  await assert.rejects(
    () => activeClauseCapsule(
      staleAnchor.itemDirectory, staleAnchor.workflow,
      staleAnchor.workflow.phases.implementation, null, { root: staleAnchor.root }
    ),
    (error) => error.code === 'SPECIFICATION_INDEX_UNTRUSTED'
      && error.details.problems.some((problem) => /clause count/.test(problem))
  );
});

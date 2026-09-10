import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderArtifactTemplate } from '../src/config.mjs';
import { readRecord } from '../src/schema-migrations.mjs';
import {
  captureWorkflowSnapshot, verifyWorkflowSnapshot, workflowSnapshotDrift
} from '../src/workflow-snapshots.mjs';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wfa-'));
  const templatePath = 'singularity/templates/implementation.md';
  const agentPath = '.github/agents/developer.agent.md';
  const template = '# Implementation\n\nWork: {{work.id}}\n';
  const agent = '# Developer\n\nImplement only the accepted Story.\n';
  await mkdir(path.join(root, path.dirname(templatePath)), { recursive: true });
  await mkdir(path.join(root, path.dirname(agentPath)), { recursive: true });
  await writeFile(path.join(root, templatePath), template);
  await writeFile(path.join(root, agentPath), agent);
  const config = {
    workItemRoot: 'singularity/work-items',
    templatesRoot: 'singularity/templates',
    agentCatalog: [{
      id: 'developer', file: path.join(root, agentPath), source: agentPath,
      scope: 'repository', sha256: digest(agent),
      dependencies: [{ id: 'remote-handbook', type: 'template', optional: true,
        url: 'https://user:secret@example.invalid/private.md' }]
    }]
  };
  const workflow = {
    schemaVersion: 5,
    workItem: {
      id: 'WFA-1', title: 'Portable Story', workType: 'feature',
      createdAt: '2026-09-10T00:00:00.000Z'
    },
    resolution: {
      configurationSource: {
        repository: 'https://example.invalid/config.git', commit: 'a'.repeat(40),
        filesSha256: 'b'.repeat(64)
      },
      phases: [{ id: 'implementation', template: 'implementation.md', defaultAgent: 'developer' }],
      templates: { implementation: { path: templatePath, sha256: digest(template) } }
    }
  };
  return { root, config, workflow, templatePath, agentPath, template };
}

test('a Story snapshot closes policy, template, and governed-agent bytes for offline reuse', async () => {
  const value = await fixture();
  try {
    value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
      value.root, value.config, value.workflow
    );
    assert.equal(value.workflow.resolution.templates.implementation.source, 'workflow-snapshot');
    assert.match(value.workflow.resolution.templates.implementation.path,
      /config\/wfa\/blobs\/sha256\/[a-f0-9]{64}$/);

    // Removing every live authoring source proves the reader consumes the accepted closure.
    await rm(path.join(value.root, value.templatePath));
    await rm(path.join(value.root, value.agentPath));
    const verified = await verifyWorkflowSnapshot(value.root, value.config, value.workflow);
    assert.equal(verified.status, 'ready');
    assert.equal(verified.assets, 2);
    assert.equal(verified.executionDependencies[0].availability, 'remote-optional');

    const rendered = await renderArtifactTemplate(
      value.root, value.config, value.workflow.resolution.phases[0], {
        id: 'WFA-1', title: 'Portable Story', workType: 'feature', inputs: '',
        templateSnapshot: value.workflow.resolution.templates.implementation
      }
    );
    assert.match(rendered, /Work: WFA-1/);

    const manifestText = await readFile(
      path.join(value.root, value.workflow.workflowSnapshot.manifestPath), 'utf8'
    );
    assert.doesNotMatch(manifestText, /user:secret|private\.md/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('snapshot verification rejects changed content-addressed bytes', async () => {
  const value = await fixture();
  try {
    value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
      value.root, value.config, value.workflow
    );
    const manifest = readRecord('workflow-snapshot', JSON.parse(await readFile(
      path.join(value.root, value.workflow.workflowSnapshot.manifestPath), 'utf8'
    ))).record;
    await writeFile(path.join(value.root, manifest.assets[0].blob.path), 'tampered');
    await assert.rejects(
      verifyWorkflowSnapshot(value.root, value.config, value.workflow),
      (error) => error.code === 'WFA_SNAPSHOT_INVALID'
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('legacy Stories stay readable and drift compares provenance without network access', async () => {
  const value = await fixture();
  try {
    assert.deepEqual(await verifyWorkflowSnapshot(value.root, value.config, value.workflow), {
      status: 'legacy', enrolled: false, closure: 'unproven', reason: 'snapshot-reference-absent'
    });
    value.workflow.workflowSnapshot = await captureWorkflowSnapshot(
      value.root, value.config, value.workflow
    );
    const same = await workflowSnapshotDrift(
      value.root, value.config, value.workflow, value.workflow.resolution.configurationSource
    );
    assert.equal(same.drift, 'unchanged');
    const changed = await workflowSnapshotDrift(value.root, value.config, value.workflow, {
      ...value.workflow.resolution.configurationSource, commit: 'c'.repeat(40)
    });
    assert.equal(changed.drift, 'revision-changed/effective-policy-unchanged');
    const policyChanged = await workflowSnapshotDrift(value.root, value.config, value.workflow, {
      ...value.workflow.resolution.configurationSource,
      commit: 'd'.repeat(40), filesSha256: 'e'.repeat(64)
    });
    assert.equal(policyChanged.drift, 'changed');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

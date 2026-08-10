import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeMcpServers } from '../src/mcp.mjs';
import { recordMcpEvidence } from '../src/mcp-evidence.mjs';
import {
  buildDesignSourceSet, renderDesignSourcePromptContext, selectDesignSourceRecords,
  verifyDesignSourceLifecycle
} from '../src/design-sources.mjs';
import { promoteDesignSource } from '../src/state-stores.mjs';
import { snapshot } from '../src/util.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mmi-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const itemDirectory = path.join(root, 'singularity/work-items/STORY-1');
  await mkdir(itemDirectory, { recursive: true });
  const mcpServers = normalizeMcpServers({
    figma: {
      hostReference: 'figma', agents: ['product-designer'],
      phases: ['design-intake'], tools: ['get_metadata'],
      evidence: { captureToolCalls: true, captureResults: true }
    }
  }, { agents: ['product-designer'], phases: ['design-intake', 'design-inventory'] });
  const workflow = {
    workItem: { id: 'STORY-1', workType: 'figma-mobile' },
    currentPhase: 'design-intake',
    phaseOrder: ['design-intake', 'design-inventory'],
    phases: {
      'design-intake': { id: 'design-intake', status: 'in_progress', generation: 0, approvals: [], designSourceSets: [], artifacts: [], requiredArtifact: { path: 'artifacts/design-intake/design-intake.md' } },
      'design-inventory': { id: 'design-inventory', status: 'not_started', generation: 0, approvals: [], artifacts: [], requiredArtifact: { path: 'artifacts/design-inventory/design-inventory.md' } }
    },
    resolution: {
      workItemRoot: 'singularity/work-items',
      mcpServers,
      designSources: {
        capturePhase: 'design-intake', consumeIn: ['design-inventory'],
        staleness: 'warn', requireApprovedSet: true, inventoryDigest: 'optional'
      }
    },
    history: []
  };
  return { root, itemDirectory, workflow };
}

test('design-source-pin-round-trip: Figma XML becomes an approval-bound source set and downstream provenance', async () => {
  const { root, itemDirectory, workflow } = await fixture();
  const source = path.join(root, 'figma-metadata.xml');
  await writeFile(source, '<frame id="1:3" name="Checkout" />\n');
  const recorded = await recordMcpEvidence(root, workflow, {
    kind: 'design-source', server: 'figma', tool: 'get_metadata', phase: 'design-intake',
    outputPath: 'figma-metadata.xml', fileKey: 'checkout-file', fileVersion: 'v17',
    fileVersionCreatedAt: '2026-08-06T00:00:00.000Z', nodes: ['1-3'],
    agent: 'product-designer', actor: { name: 'Designer', email: 'designer@example.test' },
    itemDirectory
  });
  assert.equal(recorded.record.format, 'figma-mcp-metadata-xml');
  assert.deepEqual(recorded.record.nodes, ['1:3']);

  workflow.phases['design-intake'].generation = 1;
  const built = await buildDesignSourceSet(root, workflow, { itemDirectory });
  workflow.phases['design-intake'].approvals.push({
    decision: 'approved', generation: 1, designSourceSet: built.binding
  });
  workflow.phases['design-intake'].status = 'approved';
  workflow.phases['design-inventory'].status = 'in_progress';

  const rendered = await renderDesignSourcePromptContext(root, workflow, workflow.phases['design-inventory'], {
    itemDirectory, record: true
  });
  assert.match(rendered.markdown, /Approved design sources/);
  assert.match(rendered.markdown, /checkout-file @ v17/);
  assert.doesNotMatch(rendered.markdown, /<frame/);
  assert.equal(rendered.files[0].category, 'design-source-provenance');
  const provenance = JSON.parse(await readFile(path.join(root, rendered.files[0].path), 'utf8'));
  assert.equal(provenance.approvedSet.setSha256, built.binding.setSha256);
  assert.equal(provenance.records[0].outputSha256, recorded.record.outputSha256);
  const provenanceSnapshot = await snapshot(path.join(root, rendered.files[0].path));
  assert.equal(rendered.files[0].sha256, provenanceSnapshot.sha256);
  assert.equal(rendered.files[0].bytes, provenanceSnapshot.size);

  const valid = await verifyDesignSourceLifecycle(root, workflow, { itemDirectory });
  assert.equal(valid.errors.length, 0);
  assert.match(valid.passes.join('\n'), /design sources: 1 record/);

  await writeFile(path.join(itemDirectory, recorded.record.output.path), 'tampered');
  const tampered = await verifyDesignSourceLifecycle(root, workflow, { itemDirectory });
  assert.match(tampered.errors.join('\n'), /changed after capture/);
});

test('candidate promotion explicitly reopens capture and pins the next generation selection', async () => {
  const { root, itemDirectory, workflow } = await fixture();
  const config = { workItemRoot: 'singularity/work-items' };
  await writeFile(path.join(root, 'design-v1.xml'), '<frame id="1:3" name="Checkout" />\n');
  const first = await recordMcpEvidence(root, workflow, {
    kind: 'design-source', server: 'figma', tool: 'get_metadata', outputPath: 'design-v1.xml',
    fileKey: 'checkout-file', fileVersion: 'v1', fileVersionCreatedAt: '2026-08-05T00:00:00.000Z',
    nodes: ['1:3'], agent: 'product-designer', itemDirectory
  });
  workflow.phases['design-intake'].generation = 1;
  const approved = await buildDesignSourceSet(root, workflow, { itemDirectory });
  workflow.phases['design-intake'].approvals.push({ decision: 'approved', designSourceSet: approved.binding });

  await writeFile(path.join(root, 'design-v2.xml'), '<frame id="1:3" name="Checkout revised" />\n');
  const second = await recordMcpEvidence(root, workflow, {
    kind: 'design-source', server: 'figma', tool: 'get_metadata', outputPath: 'design-v2.xml',
    fileKey: 'checkout-file', fileVersion: 'v2', fileVersionCreatedAt: '2026-08-06T00:00:00.000Z',
    nodes: ['1:3'], agent: 'product-designer', itemDirectory
  });
  workflow.phases['design-intake'].status = 'approved';
  workflow.phases['design-inventory'].status = 'approved';
  workflow.phases['design-inventory'].approvals.push({ decision: 'approved' });
  workflow.currentPhase = null; workflow.status = 'complete';

  const result = await promoteDesignSource(root, config, workflow, {
    candidateRecordId: second.record.id, actor: { name: 'Reviewer', email: 'reviewer@example.test' }, agent: 'product-designer'
  });
  assert.equal(result.capturePhase, 'design-intake');
  assert.deepEqual(result.invalidatedPhases, ['design-intake', 'design-inventory']);
  assert.equal(workflow.currentPhase, 'design-intake');
  assert.equal(workflow.phases['design-intake'].status, 'in_progress');
  assert.equal(workflow.phases['design-inventory'].status, 'not_started');
  assert.equal(workflow.phases['design-inventory'].approvals[0].invalidatedAt != null, true);
  assert.equal(workflow.phases['design-intake'].designSourceSelection['checkout-file'], second.record.id);
  assert.equal(approved.sourceSet.records[0].recordId, first.record.id, 'the existing approved binding remains unchanged');

  workflow.phases['design-intake'].generation = 2;
  const replacement = await buildDesignSourceSet(root, workflow, {
    itemDirectory, selectionByFileKey: workflow.phases['design-intake'].designSourceSelection
  });
  assert.equal(replacement.sourceSet.records[0].recordId, second.record.id);
});

test('multiple Figma versions require an explicit record selection', () => {
  const records = [
    { id: 'one', kind: 'design-source', phase: 'design-intake', targetGeneration: 1, fileKey: 'file', fileVersion: 'v1', outputSha256: 'a' },
    { id: 'two', kind: 'design-source', phase: 'design-intake', targetGeneration: 1, fileKey: 'file', fileVersion: 'v2', outputSha256: 'b' }
  ];
  const ambiguous = selectDesignSourceRecords(records, { capturePhase: 'design-intake', targetGeneration: 1 });
  assert.equal(ambiguous.selected.length, 0);
  assert.equal(ambiguous.ambiguities.length, 1);
  const selected = selectDesignSourceRecords(records, {
    capturePhase: 'design-intake', targetGeneration: 1, selectionByFileKey: { file: 'two' }
  });
  assert.deepEqual(selected.selected.map((record) => record.id), ['two']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const { buildVisualAssuranceView } = await import(source('views/visual-assurance-model.ts'));
const { visualAssuranceHtml } = await import(source('views/visual-assurance-page.ts'));

const snapshot = {
  workItems: [], initiatives: [], selectedWorkId: 'MOB-42', selectedInitiativeId: null,
  initiative: null, workflow: null,
  mcp: { servers: [{ id: 'figma', label: 'Figma', hostReference: 'figma', agents: [], phases: [], tools: ['get_file'], required: true, approval: 'confirm', configured: true, readiness: 'needs-attestation', readinessReasons: ['Host readiness has not been attested on this machine.'], sources: ['workspace'] }], inventory: [], errors: [], warnings: [] },
  visualAssurance: {
    schemaVersion: 1, configured: true, workId: 'MOB-42', phase: 'visual-verification',
    itemDirectory: 'singularity/work-items/MOB-42', policy: {},
    designSources: { approvedSet: { setSha256: 'a'.repeat(64), phase: 'design-intake', generation: 1, records: [{ recordId: 'design-1' }] }, candidates: [{ fileKey: 'mobile', approvedVersion: '17', candidateVersion: '18', classification: 'newer' }], stale: [], errors: [], warnings: [], passes: [] },
    inventory: { path: 'context/design-inventory/digest.json', sha256: 'b'.repeat(64), bytes: 400, digest: { digestSha256: 'c'.repeat(64), counts: { nodes: 10, components: 2, componentSets: 1, instances: 4 } } },
    evidence: { errors: [], warnings: [], passes: [], records: [
      { id: 'design-1', kind: 'design-source', server: 'figma', tool: 'get_file', phase: 'design-intake', targetGeneration: 1, fileVersion: '17', outputSha256: 'd'.repeat(64), output: { path: 'context/mcp/design.png', sha256: 'd'.repeat(64), mediaType: 'image/png' } },
      { id: 'screen-1', kind: 'visual-artifact', server: 'playwright', tool: 'screenshot', phase: 'visual-verification', targetGeneration: 1, profileId: 'mobile', outputSha256: 'e'.repeat(64), output: { path: 'context/mcp/actual.png', sha256: 'e'.repeat(64), mediaType: 'image/png' } }
    ] },
    coverage: { status: 'pass', mode: 'enforce', phase: 'visual-verification', generation: 1, profiles: [{ id: 'mobile', label: 'Mobile', width: 390, height: 844, deviceScaleFactor: 3 }], covered: [{ profileId: 'mobile', recordId: 'screen-1' }], uncovered: [], stale: [], duplicates: [], warnings: [], errors: [] },
    comparisons: [{ id: 'visual-1', status: 'pass', profileId: 'mobile', differingPixels: 20, differingPixelRatio: .002, path: 'artifacts/visual-verification/evidence/visual-1.json', expected: { path: 'context/mcp/design.png', sha256: 'd'.repeat(64) }, actual: { path: 'context/mcp/actual.png', sha256: 'e'.repeat(64) }, diffImage: { path: 'artifacts/visual-verification/evidence/visual-1-diff.png', sha256: 'f'.repeat(64) } }],
    readiness: { status: 'ready', errors: [], warnings: [], passes: ['visual coverage verified'] }
  }
};

test('visual assurance joins design sources, profiles, comparisons, and governed MCP evidence', () => {
  const view = buildVisualAssuranceView(snapshot);
  assert.equal(view.workId, 'MOB-42');
  assert.equal(view.summary.designSources, 1);
  assert.equal(view.summary.profilesCovered, 1);
  assert.equal(view.summary.comparisonsPassed, 1);
  assert.equal(view.designSources[0].fileVersion, '17');
  assert.equal(view.visualArtifacts[0].profileId, 'mobile');
  assert.equal(view.servers[0].id, 'figma');
  assert.deepEqual(view.servers[0].reasons, ['Host readiness has not been attested on this machine.']);
});

test('visual assurance page exposes explicit review and network controls without auto-running them', () => {
  const html = visualAssuranceHtml(buildVisualAssuranceView(snapshot), null, null, (path) => `vscode-resource:${path}`);
  assert.match(html, /Visual Assurance · MOB-42/);
  assert.match(html, /Approved source set/);
  assert.match(html, /Mobile/);
  assert.match(html, /0\.20%/);
  assert.match(html, /Run network doctor/);
  assert.match(html, /Side by side/);
  assert.match(html, /Overlay/);
  assert.match(html, /Diff/);
  assert.match(html, /vscode-resource:context\/mcp\/design\.png/);
  assert.match(html, /candidate version/);
  assert.match(html, /Attest host readiness/);
  assert.match(html, /Host readiness has not been attested/);
  assert.match(html, /Opening or refreshing this dashboard performs local checks only/);
  assert.doesNotMatch(html, /<script/);
});

test('visual assurance renders a useful empty state before a Story is selected', () => {
  const view = buildVisualAssuranceView(null);
  assert.equal(view.available, false);
  assert.match(visualAssuranceHtml(view, null, null), /Start or resume a Story/);
});

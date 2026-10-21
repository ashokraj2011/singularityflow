import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const { buildVisualAssuranceView } = await import(pathToFileURL(source('views/visual-assurance-model.ts')).href);
const { visualAssuranceHtml, VISUAL_ASSURANCE_SCRIPT } = await import(pathToFileURL(source('views/visual-assurance-page.ts')).href);

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

test('visual assurance exposes candidate promotion as an explicit confirmed decision', () => {
  const candidateSnapshot = structuredClone(snapshot);
  candidateSnapshot.visualAssurance.designSources.candidates = [{
    fileKey: 'checkout', approvedVersion: 'v1', candidateVersion: 'v2',
    candidateRecordId: 'mcp-candidate-2', classification: 'newer-version-confirmed'
  }];
  const html = visualAssuranceHtml(buildVisualAssuranceView(candidateSnapshot), null, null);
  assert.match(html, /Promote candidate/);
  assert.match(html, /data-promote-candidate="mcp-candidate-2"/);
  assert.match(VISUAL_ASSURANCE_SCRIPT, /promote-candidate/);
});

test('visual assurance renders a useful empty state before a Story is selected', () => {
  const view = buildVisualAssuranceView(null);
  assert.equal(view.available, false);
  assert.match(visualAssuranceHtml(view, null, null), /Start or resume a Story/);
});

test('Visual Assurance shows a screen size decided not to apply as not applicable, with who decided and why', () => {
  const coverage = {
    status: 'warn', mode: 'enforce', phase: 'visual-verification', generation: 1,
    profiles: [{ id: 'phone', label: 'Phone', width: 390, height: 844, deviceScaleFactor: 1 }, { id: 'tablet', label: 'Tablet', width: 834, height: 1194, deviceScaleFactor: 1 }],
    covered: [{ profileId: 'phone', recordId: 'NVC-001' }], uncovered: [], stale: [], duplicates: [], warnings: [], errors: [],
    notApplicable: [{ profileId: 'tablet', decisionId: 'VPD-001', reason: 'This app ships to phones only; there is no tablet layout.',
      actor: 'design.reviewer@example.invalid', authorityGroup: 'design-reviewers', at: '2026-10-19T10:00:00.000Z' }]
  };
  const snapshot = { workItems: [], initiatives: [], mcp: { servers: [] }, visualAssurance: {
    schemaVersion: 1, configured: true, workId: 'MOB-1', phase: 'visual-verification', itemDirectory: 'singularity/work-items/MOB-1', policy: {},
    designSources: { approvedSet: null, candidates: [], stale: [], errors: [], warnings: [], passes: [] }, inventory: null,
    evidence: { records: [], errors: [], warnings: [], passes: [] }, coverage, comparisons: [],
    readiness: { status: 'attention', errors: [], warnings: [], passes: [] } } };
  const view = buildVisualAssuranceView(snapshot);
  assert.deepEqual(view.profiles.map((profile) => [profile.id, profile.status]), [['phone', 'covered'], ['tablet', 'not-applicable']]);
  assert.deepEqual(view.profiles[1].notApplicable, { decisionId: 'VPD-001', reason: 'This app ships to phones only; there is no tablet layout.',
    decidedBy: 'design.reviewer@example.invalid through design-reviewers', at: '2026-10-19T10:00:00.000Z' });
  assert.deepEqual([view.summary.profilesCovered, view.summary.profilesNotApplicable, view.summary.profilesTotal], [1, 1, 2]);
  const html = visualAssuranceHtml(view, null, null);
  const card = html.slice(html.indexOf('data-profile-status="not-applicable"'));
  assert.match(card, /<strong>Tablet<\/strong><span class="pill">Not applicable<\/span>/u);
  assert.match(card, /Decided by design\.reviewer@example\.invalid through design-reviewers on 2026-10-19 \(VPD-001\): This app ships to phones only/u);
  assert.match(card, /An exception for this Story, not passing evidence\./u);
  assert.doesNotMatch(card.slice(0, card.indexOf('</article>')), /No matching visual artifact/u, 'never shown as missing');
  assert.match(html, /1\/1 covered · 1 not applicable/u);
  // Without a decision the same screen size is missing, exactly as before.
  delete coverage.notApplicable;
  coverage.uncovered = ['tablet'];
  const missing = buildVisualAssuranceView(snapshot);
  assert.equal(missing.profiles[1].status, 'missing');
  assert.match(visualAssuranceHtml(missing, null, null), /1\/2 covered<\/span>/u);
});

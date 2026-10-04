/**
 * Disposable Git fixture for XPL2 tests: a real repository change plus controlled, integrity-valid
 * comprehension projections (region-level cause graph, recorded delivery evidence, clause sources).
 * It mirrors the Change Explorer prototype's shape without claiming any of it is live evidence.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildCodeExplanation } from '../../src/comprehension/code-explanation.mjs';
import { buildChangeRegionManifest } from '../../src/comprehension/contracts.mjs';
import { buildComprehensionDiffPreview } from '../../src/comprehension/diff-preview.mjs';
import { buildComprehensionEvidenceProjection } from '../../src/comprehension/evidence-projection.mjs';
import { comprehensionSourceReferences } from '../../src/comprehension/source-expansion.mjs';
import { recordSha256 } from '../../src/records.mjs';
import { buildRepositoryChangeSet } from '../../src/repository-change-set.mjs';

const SHA = (character) => `sha256:${character.repeat(64)}`;
const canonical = (value) => `sha256:${recordSha256(value)}`;

export function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);

function lines(count, render) {
  return `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;
}

/** A region-scoped cause graph over the named regions, bound to the exact manifest. */
export function regionGraph(manifest, associations) {
  const nodes = [];
  const edges = [];
  for (const { clauseId, path: file } of associations) {
    const region = manifest.regions.find((entry) => (entry.location.pathAfter ?? entry.location.pathBefore) === file);
    if (!region) throw new Error(`fixture region ${file} is missing`);
    const causeNode = `cause:acceptance-clause:${clauseId}`;
    const regionNode = `region:${region.regionSha256}`;
    if (!nodes.some((node) => node.id === causeNode)) {
      nodes.push({
        id: causeNode, type: 'cause', causeKind: 'acceptance-clause', causeId: clauseId,
        statement: `Fixture clause ${clauseId}.`, statementSha256: SHA('8'), authorityRecordSha256: SHA('7'),
        authorityStatus: 'approved'
      });
    }
    if (!nodes.some((node) => node.id === regionNode)) {
      nodes.push({
        id: regionNode, type: 'change-region', regionId: region.regionId, regionSha256: region.regionSha256,
        pathBefore: region.location.pathBefore, pathAfter: region.location.pathAfter,
        operation: region.operation, assurance: 'diff-derived'
      });
    }
    edges.push({
      id: `edge:${clauseId}:${region.regionSha256}`, type: 'cause-to-change-region', from: causeNode, to: regionNode,
      relationship: 'implements', bindingSha256: SHA('6'), confirmationDecisionSha256: SHA('5')
    });
  }
  const core = {
    schemaVersion: 1,
    kind: 'comprehension-intent-graph',
    authoritative: false,
    authority: 'unverified-observation',
    lifecycleGate: false,
    candidateBinding: manifest.candidateBinding,
    candidateSha256: manifest.compatibilityCandidateSha256,
    manifestSha256: manifest.manifestSha256,
    coverageResultSha256: SHA('9'),
    nodes,
    edges,
    counts: { nodes: nodes.length, causes: nodes.filter((node) => node.type === 'cause').length, regions: nodes.length, edges: edges.length },
    availability: { causeGraph: 'available', structure: 'unavailable', structureReason: 'resource-fallback-no-ast-required', durableAuthority: 'unavailable' },
    diagnosticCodes: []
  };
  return { ...core, graphSha256: canonical(core) };
}

/**
 * Build the fixture. Options select which optional sources exist so tests can exercise WEL-off,
 * no-cause, no-Story and stale-evidence journeys independently.
 */
export async function createXpl2Fixture(t, {
  withGraph = true, withStory = true, deliveryCurrent = true, wel = 'disabled'
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'XPL2 Fixture');
  git(root, 'config', 'user.email', 'xpl2@example.test');
  await mkdir(path.join(root, 'src', 'export'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'src/export/service.ts'), lines(60, (n) => n === 1 ? 'export function exportOrders(range) {' : `  const step${n} = ${n};`));
  await writeFile(path.join(root, 'src/export/filters.ts'), lines(20, (n) => `export const filter${n} = ${n};`));
  await writeFile(path.join(root, 'src/export/format.ts'), lines(45, (n) => n === 40 ? 'export function formatDate(order) {'
    : n === 41 ? '  return order.createdAt.toISOString();' : n === 42 ? '}' : `// line ${n}`));
  await writeFile(path.join(root, 'src/index.ts'), lines(10, (n) => `export * from './part${n}.ts';`));
  await writeFile(path.join(root, 'assets/export-badge.png'), PNG);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');

  await writeFile(path.join(root, 'src/export/service.ts'), lines(60, (n) => n === 1 ? 'export function exportOrders(range) {'
    : n === 5 ? '  const step5 = range.start;' : n === 50 ? '  const step50 = range.end;' : `  const step${n} = ${n};`));
  await writeFile(path.join(root, 'src/export/filters.ts'), lines(20, (n) => n === 10 ? 'export const filter10 = (order) => order.status !== "cancelled";' : `export const filter${n} = ${n};`));
  await writeFile(path.join(root, 'src/export/format.ts'), lines(45, (n) => n === 40 ? 'export function formatDate(order, timezone) {'
    : n === 41 ? '  return formatInZone(order.createdAt, timezone);' : n === 42 ? '}' : `// line ${n}`));
  await writeFile(path.join(root, 'src/index.ts'), lines(10, (n) => n === 3 ? "export * from './export/service.ts';" : `export * from './part${n}.ts';`));
  await writeFile(path.join(root, 'assets/export-badge.png'), Buffer.concat([PNG, Buffer.from([1, 2, 3, 0])]));

  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: base, subject: { kind: 'comprehension-observation' } });
  const manifest = buildChangeRegionManifest(changeSet);
  const diff = buildComprehensionDiffPreview(root, changeSet);
  const graph = withGraph ? regionGraph(manifest, [
    { clauseId: 'ORD:AC-001', path: 'src/export/service.ts' },
    { clauseId: 'ORD:AC-002', path: 'src/export/filters.ts' },
    { clauseId: 'ORD:AC-003', path: 'src/export/format.ts' }
  ]) : null;
  const workflow = withStory ? {
    workItem: { id: 'ORD-418', title: 'Export orders as CSV', branch: 'ORD-418' },
    phaseOrder: ['specification', 'implementation'],
    resolution: { wel: { mode: wel } },
    history: [],
    publicationProjections: [],
    phases: {
      specification: { status: 'approved', generation: 1, artifacts: [] },
      implementation: {
        status: 'in_progress',
        generation: 2,
        deliveryEvidence: {
          status: 'validated',
          changeSet: { digest: deliveryCurrent ? manifest.changeSetSha256 : SHA('3') },
          receiptSha256: SHA('4'),
          sourcePaths: ['src/export/service.ts', 'src/export/filters.ts', 'src/export/format.ts', 'src/index.ts'],
          testPaths: [],
          supportingTestPaths: [],
          acceptanceCriteria: {
            required: ['ORD:AC-001', 'ORD:AC-002', 'ORD:AC-003'],
            tagged: ['ORD:AC-001', 'ORD:AC-002'],
            missing: ['ORD:AC-003'],
            bindings: [
              { clauseId: 'ORD:AC-001', testSource: 'test/export-range.test.ts', bindingAssurance: 'namespace-qualified' },
              { clauseId: 'ORD:AC-002', testSource: 'test/export-cancel.test.ts', bindingAssurance: 'namespace-qualified' }
            ]
          },
          testExecutions: [
            { commandId: 'range-test', status: 'passed', receiptSha256: SHA('2'), affectedRoots: ['src/export'] },
            { commandId: 'cancellation-test', status: 'passed', receiptSha256: SHA('1'), affectedRoots: ['src/export'] }
          ]
        }
      }
    }
  } : null;
  const context = {
    repository: root, base, source: 'explicit',
    workId: withStory ? 'ORD-418' : null, phase: withStory ? 'implementation' : null
  };
  const evidence = buildComprehensionEvidenceProjection({ workflow, phaseId: context.phase, manifest });
  const codeExplanation = buildCodeExplanation({ context, manifest, diff, graph, evidence });
  const sourceReferences = manifest.regions.flatMap((region) => comprehensionSourceReferences(manifest, region)
    .map((reference) => ({
      regionId: reference.regionId, regionSha256: reference.regionSha256, side: reference.side, path: reference.path,
      fileType: reference.fileType, ref: reference.ref, referenceSha256: reference.referenceSha256
    })));
  const clauseSources = withStory ? {
    status: 'available', reason: null,
    artifacts: [{
      path: 'singularity/work-items/ORD-418/specification.md', phase: 'specification', phaseStatus: 'approved',
      status: 'read', reason: null, digest: SHA('a'),
      clauses: [
        { id: 'ORD:AC-001', type: 'AC', line: 12, body: 'Export only orders inside the selected date range.', bodySha256: SHA('b') },
        { id: 'ORD:AC-002', type: 'AC', line: 14, body: 'Exclude cancelled orders from the export.', bodySha256: SHA('c') },
        { id: 'ORD:AC-003', type: 'AC', line: 16, body: 'Format timestamps in the user timezone.', bodySha256: SHA('d') }
      ]
    }]
  } : null;
  const replay = withStory ? {
    replaySha256: SHA('e'), workId: 'ORD-418', focus: { type: 'all', value: null },
    events: [
      { kind: 'phase-approved', phase: 'specification', generation: 1, at: '2026-09-27T09:00:00.000Z', provenance: 'lifecycle' },
      { kind: 'generation-published', phase: 'implementation', generation: 2, at: '2026-09-28T09:00:00.000Z', provenance: 'lifecycle' }
    ],
    counts: { matched: 2, returned: 2 }, truncated: false
  } : null;
  return {
    root, base, manifest, diff, graph, workflow, evidence, codeExplanation, sourceReferences, clauseSources, replay,
    input: { context, manifest, codeExplanation, evidence, workflow, clauseSources, replay, sourceReferences }
  };
}

/**
 * A disposable repository: `baseline` files are committed, then `change` is applied to the working
 * tree. Values are strings or Buffers; `null` in `change` deletes the file.
 */
export async function createChangeRepository(t, { baseline, change = {}, prepare = null, apply = null }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-repo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'XPL2 Fixture');
  git(root, 'config', 'user.email', 'xpl2@example.test');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(baseline)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  if (prepare) await prepare(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const base = git(root, 'rev-parse', 'HEAD');
  for (const [file, content] of Object.entries(change)) {
    if (content === null) await rm(path.join(root, file), { force: true });
    else {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
  }
  if (apply) await apply(root);
  return { root, base };
}

/** The exact comprehension slice the extension leases for the Comprehension Center. */
export async function comprehensionSlice(root) {
  const { repositorySnapshot } = await import('../../src/editor.mjs');
  return (await repositorySnapshot(root, null, null, { included: ['comprehension'] })).comprehension;
}

/** The pure XPL2 input for an existing repository change, with optional region associations. */
export async function xpl2InputFor(root, base, { associations = [], workflow = null, clauseSources = null, replay = null } = {}) {
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: base, subject: { kind: 'comprehension-observation' } });
  const manifest = buildChangeRegionManifest(changeSet);
  const diff = buildComprehensionDiffPreview(root, changeSet);
  const graph = associations.length ? regionGraph(manifest, associations) : null;
  const context = { repository: root, base, source: 'explicit', workId: workflow?.workItem?.id ?? null, phase: workflow ? 'implementation' : null };
  const evidence = buildComprehensionEvidenceProjection({ workflow, phaseId: context.phase, manifest });
  const codeExplanation = buildCodeExplanation({ context, manifest, diff, graph, evidence });
  const sourceReferences = manifest.regions.flatMap((region) => comprehensionSourceReferences(manifest, region)
    .map((reference) => ({
      regionId: reference.regionId, regionSha256: reference.regionSha256, side: reference.side, path: reference.path,
      fileType: reference.fileType, ref: reference.ref, referenceSha256: reference.referenceSha256
    })));
  return { manifest, diff, input: { context, manifest, codeExplanation, evidence, workflow, clauseSources, replay, sourceReferences } };
}

/** Run the real CLI in a repository with isolated machine state; returns the parsed JSON result. */
export function cliJson(root, home, args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url)), ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_NO_MODEL: '1', GIT_TERMINAL_PROMPT: '0',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(home, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(home, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(home, 'leads.json')
    }
  });
  // JSON results and refusals use stdout; retain compatibility with older stderr refusals.
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const json = parse(result.stdout) ?? parse(result.stderr);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

/** A disposable HOME so CLI runs never read or write the real machine state. */
export async function isolatedHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

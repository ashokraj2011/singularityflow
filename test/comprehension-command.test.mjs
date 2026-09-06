import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function command(root, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-comprehension-command-'));
  t.after(() => spawnSync('rm', ['-rf', root]));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'CMP Tester']);
  git(root, ['config', 'user.email', 'cmp@example.test']);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), '{}\n');
  await writeFile(path.join(root, '.gitignore'), 'review/\n');
  const storyDirectory = path.join(root, 'singularity', 'work-items', 'CMP-STORY');
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'CMP-STORY', title: 'Replay test', workType: 'feature', branch: 'CMP-STORY' },
    status: 'in_progress',
    currentPhase: 'implementation',
    phaseOrder: ['intake', 'implementation'],
    phases: {
      intake: { id: 'intake', label: 'Intake', status: 'approved', generation: 1 },
      implementation: {
        id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1
      }
    },
    history: [
      {
        at: '2026-09-01T00:00:01.000Z', actor: 'private@example.test',
        event: 'phase_generated', phase: 'implementation', detail: 'private model summary'
      },
      {
        at: '2026-09-01T00:00:02.000Z', actor: 'private@example.test',
        event: 'workflow_reopened', phase: 'intake', detail: 'private reason'
      }
    ],
    publicationProjections: [{
      commit: 'a'.repeat(40),
      event: {
        type: 'artifact-generated', eventId: 'EV-001', sourceCommit: 'a'.repeat(40),
        createdAt: '2026-09-01T00:00:01.000Z', phaseId: 'implementation', generation: 1
      }
    }]
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'service.txt'), 'before\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  await writeFile(path.join(root, 'service.txt'), 'after\n');
  await writeFile(path.join(root, 'new.txt'), 'new\n');
  return root;
}

test('comprehension regions is a model-free, read-only exact change projection', async (t) => {
  const root = await repository(t);
  const before = git(root, ['status', '--porcelain=v1']);
  const privateState = path.join(root, '.git', 'singularity-flow');
  const privateStateExisted = await lstat(privateState).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)
  );
  const result = command(root, ['--no-model', 'comprehension', 'regions', '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'comprehension.regions');
  assert.deepEqual(response.effects, {
    stateChanged: false,
    filesChanged: false,
    publicationCreated: false,
    externalSystemsChanged: false
  });
  assert.equal(response.data.mode, 'observe-only');
  assert.equal(response.data.context.repository, await realpath(root));
  assert.equal(response.data.manifest.granularity, 'resource');
  assert.equal(response.data.manifest.structuralAssurance, 'unavailable');
  assert.equal(response.data.manifest.counts.regions, 2);
  assert.deepEqual(
    response.data.manifest.regions.map((region) => region.location.pathAfter),
    ['new.txt', 'service.txt']
  );
  assert.equal(await lstat(path.join(root, '.git', 'singularity-flow', 'ast')).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)
  ), false);
  assert.equal(await lstat(privateState).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)
  ), privateStateExisted);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
});

test('comprehension check reports incomplete coverage without turning observation into a gate', async (t) => {
  const root = await repository(t);
  const result = command(root, ['--no-model', 'comprehension', 'check', '--base', 'HEAD', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'comprehension.check');
  assert.equal(response.outcome.status, 'succeeded');
  assert.equal(response.data.mode, 'observe-only');
  assert.equal(response.data.coverage.verdict, 'incomplete');
  assert.equal(response.data.coverage.authoritative, false);
  assert.equal(response.data.coverage.lifecycleGate, false);
  assert.equal(response.data.coverage.counts.materialRegions, 2);
  assert.equal(response.data.coverage.counts.unresolved, 2);
  assert.match(JSON.stringify(response.data.coverage.unresolved), /No primary disposition is registered/);
  assert.equal(await readFile(path.join(root, 'service.txt'), 'utf8'), 'after\n');
});

test('comprehension graph and explain are model-free bidirectional read projections', async (t) => {
  const root = await repository(t);
  const before = git(root, ['status', '--porcelain=v1']);
  const graphResult = command(root, [
    '--no-model', 'comprehension', 'graph', '--base', 'HEAD', '--json'
  ]);
  assert.equal(graphResult.status, 0, graphResult.stderr);
  const graph = JSON.parse(graphResult.stdout);
  assert.equal(graph.operation.id, 'comprehension.graph');
  assert.equal(graph.data.graph.authoritative, false);
  assert.equal(graph.data.graph.counts.regions, 2);
  assert.equal(graph.data.graph.counts.edges, 0);
  assert.equal(graph.data.graph.availability.structure, 'unavailable');

  const fileResult = command(root, [
    '--no-model', 'comprehension', 'explain', 'file', 'new.txt', '--base', 'HEAD', '--json'
  ]);
  assert.equal(fileResult.status, 0, fileResult.stderr);
  const file = JSON.parse(fileResult.stdout);
  assert.equal(file.operation.id, 'comprehension.explain');
  assert.equal(file.data.explanation.status, 'available');
  assert.equal(file.data.explanation.nodes.length, 1);
  assert.equal(file.data.explanation.nodes[0].pathAfter, 'new.txt');

  const symbolResult = command(root, [
    '--no-model', 'comprehension', 'explain', 'symbol', 'service.main', '--base', 'HEAD', '--json'
  ]);
  assert.equal(symbolResult.status, 0, symbolResult.stderr);
  const symbol = JSON.parse(symbolResult.stdout);
  assert.equal(symbol.data.explanation.status, 'unavailable');
  assert.equal(symbol.data.explanation.reasonCode, 'CMP_STRUCTURE_UNAVAILABLE');
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
});

test('comprehension walkthrough validates typed claims without model, AST, writes, or authority', async (t) => {
  const root = await repository(t);
  const graphResult = command(root, [
    '--no-model', 'comprehension', 'graph', '--base', 'HEAD', '--json'
  ]);
  assert.equal(graphResult.status, 0, graphResult.stderr);
  const graphEnvelope = JSON.parse(graphResult.stdout);
  const graph = graphEnvelope.data.graph;
  const region = graph.nodes.find((node) =>
    node.type === 'change-region' && node.pathAfter === 'service.txt');
  const hash = (value) => `sha256:${recordSha256(value)}`;
  const textHash = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
  const claimText = 'The service resource changed in this Candidate.';
  const claimCore = {
    schemaVersion: 1, kind: 'walkthrough-claim', claimId: 'WCL-001',
    text: claimText, textSha256: textHash(claimText), claimClass: 'diff-fact',
    assertionType: 'file-changed', subjectRefs: ['file:service.txt'],
    regionRefs: [region.regionId], causeRefs: [], evidenceRefs: [],
    verification: { status: 'proposed', verifier: null, resultSha256: null },
    assurance: 'unavailable'
  };
  const dependencyManifest = {
    causeGraphSha256: graph.graphSha256,
    changeRegionManifestSha256: graph.manifestSha256,
    structuralViewManifestSha256: null, evidenceManifestSha256: null,
    policySha256: null, extractorVersionsSha256: null
  };
  const narrative = 'This walkthrough describes only the exact changed service resource.';
  const draftCore = {
    schemaVersion: 1, kind: 'comprehension-walkthrough-draft',
    walkthroughId: 'WLK-COMMAND-001',
    subject: { candidateSha256: graph.candidateSha256, sourceTreeSha256: null },
    audience: 'maintainer', mode: 'change-walkthrough',
    narrative: { content: narrative, contentSha256: textHash(narrative) },
    claims: [{ ...claimCore, claimSha256: hash(claimCore) }],
    dependencyManifest, dependencyManifestSha256: hash(dependencyManifest)
  };
  const draft = { ...draftCore, draftSha256: hash(draftCore) };
  await mkdir(path.join(root, 'review'), { recursive: true });
  await writeFile(path.join(root, 'review', 'walkthrough.json'), JSON.stringify(draft));
  const before = git(root, ['status', '--porcelain=v1']);
  const result = command(root, [
    '--no-model', 'comprehension', 'walkthrough', 'validate', 'review/walkthrough.json',
    '--base', 'HEAD', '--json'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'comprehension.walkthrough.validate');
  assert.equal(response.operation.classification, 'read');
  assert.equal(response.data.validation.status, 'validated');
  assert.equal(response.data.validation.modelInvoked, false);
  assert.equal(response.data.validation.claims[0].assurance, 'diff-verified');
  assert.equal(Object.hasOwn(response.data.validation, 'narrative'), false);
  assert.deepEqual(response.effects, {
    stateChanged: false, filesChanged: false, publicationCreated: false,
    externalSystemsChanged: false
  });
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
  assert.equal(await lstat(path.join(root, '.git', 'singularity-flow', 'ast')).then(
    () => true, (error) => error?.code === 'ENOENT' ? false : Promise.reject(error)
  ), false);

  await writeFile(path.join(root, 'review', 'previous-validation.json'), result.stdout);
  const revalidation = command(root, [
    '--no-model', 'comprehension', 'walkthrough', 'revalidate',
    'review/walkthrough.json', 'review/previous-validation.json',
    '--base', 'HEAD', '--json'
  ]);
  assert.equal(revalidation.status, 0, revalidation.stderr);
  const revalidationResponse = JSON.parse(revalidation.stdout);
  assert.equal(revalidationResponse.operation.id, 'comprehension.walkthrough.revalidate');
  assert.equal(revalidationResponse.data.validation.status, 'unchanged');
  assert.equal(revalidationResponse.data.validation.counts.unchanged, 1);
  assert.equal(revalidationResponse.data.validation.authoritative, false);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);

  await writeFile(path.join(root, 'walkthrough-unignored.json'), JSON.stringify(draft));
  const circular = command(root, [
    '--no-model', 'comprehension', 'walkthrough', 'validate', 'walkthrough-unignored.json',
    '--base', 'HEAD', '--json'
  ]);
  assert.notEqual(circular.status, 0);
  assert.match(circular.stderr, /part of the Candidate it describes/);
  assert.match(circular.stderr, /ignored repository-local evidence path/);
});

test('comprehension replay projects existing Story history without reading the working diff', async (t) => {
  const root = await repository(t);
  const before = git(root, ['status', '--porcelain=v1']);
  const result = command(root, [
    '--no-model', 'comprehension', 'replay', 'phase', 'implementation',
    '--work-id', 'CMP-STORY', '--json'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'comprehension.replay');
  assert.equal(response.data.replay.workId, 'CMP-STORY');
  assert.equal(response.data.replay.focus.type, 'phase');
  assert.equal(response.data.replay.events.length, 1);
  assert.equal(response.data.replay.events[0].provenance, 'attested-lifecycle');
  assert.equal(response.data.replay.mutatesProcess, false);
  assert.doesNotMatch(JSON.stringify(response.data.replay), /private|model summary/);
  assert.deepEqual(response.effects, {
    stateChanged: false,
    filesChanged: false,
    publicationCreated: false,
    externalSystemsChanged: false
  });
  const human = command(root, [
    '--no-model', 'comprehension', 'replay', 'kind', 'story.reopened',
    '--work-id', 'CMP-STORY'
  ]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /operational-history/);
  assert.match(human.stdout, /not SGOS Process replay and changes no state/);
  assert.doesNotMatch(human.stdout, /private@example|private reason/);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
});

test('comprehension replay refuses missing Story context and options it would otherwise ignore', async (t) => {
  const root = await repository(t);
  const missing = command(root, [
    '--no-model', 'comprehension', 'replay', '--work-id', 'MISSING-STORY', '--json'
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No governed Story matches 'MISSING-STORY'/);
  const ignored = command(root, [
    '--no-model', 'comprehension', 'replay', '--work-id', 'CMP-STORY',
    '--phase', 'implementation', '--json'
  ]);
  assert.notEqual(ignored.status, 0);
  assert.match(ignored.stderr, /does not accept --phase/);
  assert.match(ignored.stderr, /replay phase <PHASE>/);
});

test('an explicit base never bypasses a requested Story context', async (t) => {
  const root = await repository(t);
  const result = command(root, [
    '--no-model', 'comprehension', 'regions', '--base', 'HEAD', '--work-id', 'DOES-NOT-EXIST', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DOES-NOT-EXIST/);
});

test('phase-scoped observation requires a Story and gives a repository-only recovery path', async (t) => {
  const root = await repository(t);
  const result = command(root, [
    '--no-model', 'comprehension', 'regions', '--phase', 'implementation', '--base', 'HEAD', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--phase requires --work-id or an attached Story/);
  assert.match(result.stderr, /use --base without --phase/);
});

test('comprehension evidence files are bounded before JSON parsing', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'too-large.json'), Buffer.alloc((1024 * 1024) + 1, 0x20));
  const result = command(root, [
    '--no-model', 'comprehension', 'check', '--base', 'HEAD', '--bindings', 'too-large.json', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1048576-byte diagnostic input ceiling/);
});

test('comprehension evidence cannot escape the resolved repository', async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-comprehension-outside-'));
  t.after(() => spawnSync('rm', ['-rf', outside]));
  const file = path.join(outside, 'bindings.json');
  await writeFile(file, '[]\n');
  const result = command(root, [
    '--no-model', 'comprehension', 'check', '--base', 'HEAD', '--bindings', file, '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /(?:in|out)side the repository|must be repository-relative|escap/i);
});

test('comprehension evidence record collections are bounded', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'too-many.json'), `${JSON.stringify(new Array(2001).fill({}))}\n`);
  const result = command(root, [
    '--no-model', 'comprehension', 'check', '--base', 'HEAD', '--bindings', 'too-many.json', '--json'
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /2000-record diagnostic input ceiling/);
});

test('human output labels the compatibility subject and resolved repository honestly', async (t) => {
  const root = await repository(t);
  const canonicalRoot = await realpath(root);
  const result = command(root, ['--no-model', 'comprehension', 'regions', '--base', 'HEAD']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Repository: ${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /Repository change-set subject: sha256:/);
  assert.doesNotMatch(result.stdout, /^Candidate:/m);
});

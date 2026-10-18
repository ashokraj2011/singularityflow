import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { previewScopeInventory } from '../src/evidence/graph.mjs';
import { bindAcceptedPhaseInterpretation } from '../src/phase-roles.mjs';
import { phaseOwnsScope, scopeAuthoringCheckpoint } from '../src/scope/authoring.mjs';
import { recordScopeDecision } from '../src/scope/decisions.mjs';
import { scopeItemId } from '../src/scope/extract.mjs';
import { buildScopeInventory } from '../src/scope/inventory.mjs';
import { phasePromptExecutionContract } from '../src/worldmodel.mjs';
import { buildSpecIndex } from '../src/specifications.mjs';
import { SKP_CONTRACT_COMPILER, SKP_PHASE_BINDING_VERSION } from '../src/skp-contract.mjs';
import { SKP_PARSER_PROFILE } from '../src/skp-package.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-authoring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'team/stories/SCOPE-1');
  const artifact = 'artifacts/discover/spec.md';
  await mkdir(path.join(directory, 'artifacts/discover'), { recursive: true });
  await mkdir(path.join(directory, 'context'), { recursive: true });
  const source = { acceptanceCriteria: ['test cases', 'The formatter must reject negative integers.'] };
  await writeFile(path.join(directory, 'source.json'), JSON.stringify(source));
  await writeFile(path.join(directory, 'brief.md'), 'The operator must retain ordinary arithmetic.\n');
  await writeFile(path.join(directory, 'documents.json'), JSON.stringify({ documents: [{
    id: 'DOC-001', type: 'file', path: 'team/stories/SCOPE-1/brief.md', mimeType: 'text/markdown'
  }] }));
  await writeFile(path.join(directory, 'context/clarifications-discover-gen1.json'), JSON.stringify({
    phase: 'discover', responses: [{ id: 'Q-001', status: 'answered', answer: 'The hexadecimal output must use uppercase digits.' }]
  }));
  const draft = '# Specification\n\n[SCOPE-1:REQ-001] The formatter must reject negative integers.\n';
  const absolute = path.join(directory, artifact);
  await writeFile(absolute, draft);
  const phase = { id: 'discover', status: 'in_progress', generation: 0,
    requiredArtifact: { kind: 'requirements', path: artifact },
    approvalPolicy: { authorities: ['scope-reviewers'], mode: 'required' } };
  const workflow = { workItem: { id: 'SCOPE-1' }, currentPhase: phase.id,
    phaseOrder: [phase.id, 'build'], phases: { [phase.id]: phase, build: { id: 'build' } },
    resolution: { workItemRoot: 'team/stories', obligationGraph: { nodes: [
      { id: phase.id, responsibilities: ['scope'] }, { id: 'build', responsibilities: ['implement'] }
    ] } } };
  return { root, directory, absolute, artifact, draft, phase, workflow, source, definition: { workItemRoot: 'team/stories' } };
}

test('scope authors see short requests, documents and answered clarifications before handoff; draft repairs are read-only previews', async t => {
  const item = await fixture(t);
  const before = structuredClone(item.workflow);
  const review = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.equal(review.status, 'repair-or-human-decision');
  assert.equal(review.unresolvedCount, 3);
  assert.equal(review.blocking, false);
  assert.equal(review.mutationAuthority, false);
  assert.equal(review.previewOnly, true);
  assert.deepEqual(review.humanAuthorities, ['scope-reviewers']);
  const tests = review.items.find(entry => entry.text === 'test cases');
  assert.equal(tests.repair.sourceReference, `[scope:${scopeItemId('story', 'test cases')}]`);
  assert.equal(tests.repair.artifactPath, `team/stories/SCOPE-1/${item.artifact}`);
  assert.equal(tests.humanDecision.requiresActualHumanChoice, true);
  assert.equal(tests.humanDecision.commandGuidance.copilotCommand, '/sf-decide');
  assert.match(tests.humanDecision.commandGuidance.command, /decision scope SCOPE-1 --item SRI-/u);
  assert.ok(review.items.some(entry => entry.sourceId === 'DOC-001'));
  assert.ok(review.items.some(entry => entry.sourceId === 'clarification:discover:Q-001'));
  assert.deepEqual(item.workflow, before, 'preview neither decides scope nor changes lifecycle');
  assert.equal(await readFile(item.absolute, 'utf8'), item.draft);

  // Actual drafting is the author's job; references alone cannot invent a requirement or a test pass.
  const clauses = review.items.map((entry, index) => `[SCOPE-1:AC-00${index + 1}] ${entry.text === 'test cases'
    ? 'Executable regressions verify supported conversion, rejected inputs and unchanged arithmetic.' : entry.text} ${entry.repair.sourceReference}`);
  await writeFile(item.absolute, `${item.draft}\n${clauses.join('\n\n')}\n`);
  const covered = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.equal(covered.status, 'covered');
  assert.equal(covered.unresolvedCount, 0);
  const official = await previewScopeInventory(item.root, item.definition, item.workflow);
  assert.equal(official.items.find(entry => entry.id === tests.id).disposition, 'unresolved', 'an editable draft is not approved evidence');
  assert.deepEqual(item.workflow, before);

  // Test fixture approval: retain the actual index so downstream reads use the same authored links.
  item.phase.generation = 1;
  item.phase.status = 'approved';
  await buildSpecIndex(item.root, `team/stories/SCOPE-1/${item.artifact}`, { workId: 'SCOPE-1', phase: item.phase.id, generation: 1,
    outputPath: 'team/stories/SCOPE-1/context/spec-indexes/discover-gen1.json' });
  item.workflow.currentPhase = 'build';
  const retained = await previewScopeInventory(item.root, item.definition, item.workflow);
  assert.equal(retained.summary.unresolved, 0, 'approved source links stop the later-phase surprise');
  item.workflow.currentPhase = item.phase.id;
  item.phase.status = 'in_progress';
  await unlink(item.absolute);
  const successor = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.equal(successor.unresolvedCount, 4, 'a missing successor draft cannot borrow the retained old draft coverage');
});

test('comment-only and fenced references cannot claim coverage; a compiled criteria skill can repair its own draft', async t => {
  const item = await fixture(t);
  const marker = `[scope:${scopeItemId('story', 'test cases')}]`;
  await writeFile(item.absolute, `${item.draft}\n[SCOPE-1:AC-001] Executable regressions verify conversion. <!-- ${marker} -->\n\n\`\`\`\n${marker}\n\`\`\`\n`);
  const hidden = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.ok(hidden.items.some(entry => entry.text === 'test cases'));
  item.phase.kind = 'skill';
  item.phase.requiredArtifact.kind = 'custom:criteria';
  item.phase.skillBinding = { schemaVersion: SKP_PHASE_BINDING_VERSION, compiler: SKP_CONTRACT_COMPILER,
    parserProfile: SKP_PARSER_PROFILE, compilationSha256: `sha256:${'a'.repeat(64)}`,
    bindingRefs: { outputs: [{ path: item.artifact, kind: 'custom:criteria', required: true, claimRole: 'criteria' }] } };
  await writeFile(item.absolute, `${item.draft}\n[SCOPE-1:AC-001] Executable regressions verify conversion. ${marker}\n`);
  const visible = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.equal(visible.status, 'repair-or-human-decision');
  assert.ok(visible.items.every(entry => entry.text !== 'test cases'), 'the criteria-producing skill receives the real draft preview');
});

test('a real human scope choice clears the advisory and carries forward without a new prompt or a fake test pass', async t => {
  const item = await fixture(t);
  const inventory = await buildScopeInventory(item.root, item.directory, item.workflow, { source: item.source, clauses: [] });
  for (const entry of inventory.items) recordScopeDecision(item.workflow, {
    item: entry.id, disposition: 'deferred', reason: 'The scope authority defers this request to a separate delivery.',
    actor: 'reviewer@example.invalid', authorityGroup: 'scope-reviewers', at: '2026-10-18T10:00:00Z',
    inventory, knownClauseIds: []
  });
  const before = structuredClone(item.workflow.scopeDispositions);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const review = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
    assert.equal(review.unresolvedCount, 0);
    assert.equal(review.status, 'covered');
  }
  item.phase.status = 'approved';
  item.workflow.currentPhase = 'build';
  assert.equal(await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.workflow.phases.build), null,
    'implementation does not reopen the earlier authoring checkpoint');
  const later = await previewScopeInventory(item.root, item.definition, item.workflow);
  assert.ok(later.items.every(entry => entry.disposition === 'deferred'));
  assert.deepEqual(item.workflow.scopeDispositions, before);
});

test('a retained publication never receives direct draft repair instructions', async t => {
  const item = await fixture(t);
  item.phase.generation = 1;
  item.phase.generationIntent = { status: 'consumed', generation: 1 };
  const review = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.equal(review.draftPreview, false);
  assert.equal(review.status, 'human-decision');
  assert.ok(review.items.every(entry => entry.repair === null));
  assert.match(review.instruction, /preserve it/u);
  assert.equal(await readFile(item.absolute, 'utf8'), item.draft);
});

test('unavailable or changed pinned source is diagnosed, never declared covered or made into a blanket readiness gate', async t => {
  const item = await fixture(t);
  item.workflow.resolution.sourceSha256 = '0'.repeat(64);
  const review = await scopeAuthoringCheckpoint(item.root, item.definition, item.workflow, item.phase);
  assert.equal(review.status, 'unavailable');
  assert.equal(review.blocking, false);
  assert.equal(review.mutationAuthority, false);
  assert.ok(review.inspect.command);
  assert.match(review.message, /immutable Story source snapshot/u);
  assert.equal(item.workflow.scopeDispositions, undefined);
});

test('the same scope checkpoint applies by responsibility across every seeded workflow and future custom names', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  let checked = 0;
  for (const id of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, id);
    const workflow = { resolution: resolved, phases: Object.fromEntries(resolved.phases.map(phase => [phase.id, phase])) };
    for (const phase of resolved.phases) {
      const node = resolved.obligationGraph.nodes.find(entry => entry.id === phase.id);
      assert.equal(phaseOwnsScope(workflow, phase), node.responsibilities.includes('scope'), `${id}/${phase.id}`);
      checked += 1;
    }
  }
  assert.ok(checked > 30, 'audit all seeded phase definitions, not only the standard workflow');
  t.diagnostic(`Audited ${Object.keys(definition.workTypes).length} seeded workflows and ${checked} phase definitions.`);
  const phase = { id: 'custom-discovery', requiredArtifact: { kind: 'requirements' } };
  assert.equal(phaseOwnsScope({ phases: { [phase.id]: phase } }, phase), true, 'explicit legacy requirements producer');
  assert.equal(phaseOwnsScope({}, { ...phase, kind: 'skill' }), false, 'an unverified skill cannot claim scope by artifact name');
  const legacy = { phases: { [phase.id]: phase } };
  bindAcceptedPhaseInterpretation(legacy, {}, { [phase.id]: ['scope'] });
  assert.equal(phaseOwnsScope(legacy, phase), true, 'verified legacy interpretation');
  const renamed = { ...phase, requiredArtifact: { kind: 'skill' } };
  const custom = { phases: { [phase.id]: renamed }, resolution: {
    obligationGraph: { nodes: [{ id: phase.id, responsibilities: ['scope'] }] }
  } };
  assert.equal(phaseOwnsScope(custom, renamed), true, 'skill-owned criteria use the same structural role');
  const prompt = phasePromptExecutionContract({}, custom, renamed).lines.join('\n');
  assert.match(prompt, /Scope repair first/u);
  assert.match(prompt, /not a blanket phase blocker/u);
  assert.equal(phaseOwnsScope({ resolution: { obligationGraph: { nodes: [{ id: phase.id, responsibilities: [] }] } } }, phase), false,
    'an explicit pinned omission is not overridden by a name or artifact fallback');
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { extractNormativeStatements, normalizeStatement, scopeItemId, statementSha256, storySourceStatements } from '../src/scope/extract.mjs';
import { buildScopeInventory } from '../src/scope/inventory.mjs';
import { recordScopeDecision } from '../src/scope/decisions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'singularity-flow.mjs');

test('the extractor finds requirements by structure and strong modals, never "should" or code', () => {
  const statements = extractNormativeStatements([
    '# Brief', '',
    'The export must include headers. It should be quick. Users may sort.', '',
    '## Acceptance criteria', '',
    '| Clause | Observable outcome |', '|---|---|',
    '| [W-1:AC-001] | The exported value equals 2. |',
    '- Users can download a CSV file',
    '- Users can download a CSV file',
    '## Notes', '',
    '```', 'The parser must not appear in code.', '```',
    '<!-- The comment must be skipped. -->',
    'Given a signed-in user When they export Then a file downloads'
  ].join('\n'), { sourceId: 'DOC-001' });
  assert.deepEqual(statements.map((entry) => [entry.line, entry.signal, normalizeStatement(entry.text)]), [
    [3, 'modal', 'the export must include headers'],
    [9, 'structured', 'the exported value equals 2'],
    [10, 'structured', 'users can download a csv file'],
    [18, 'scenario', 'given a signed-in user when they export then a file downloads']
  ]);
  assert.equal(statementSha256('The value equals 2.'), statementSha256('  the VALUE equals 2 '), 'identity ignores case, spacing and punctuation');
  assert.match(scopeItemId('story', 'The value equals 2.'), /^SRI-[0-9a-f]{12}$/);
  assert.notEqual(scopeItemId('story', 'x must be y'), scopeItemId('DOC-001', 'x must be y'), 'an item belongs to its source');

  const story = storySourceStatements({
    description: 'Change the value. The API must stay stable. It should be fast.',
    acceptanceCriteria: ['The exported value equals 2.', { text: 'Old callers keep working.' }],
    constraints: ['No new dependency']
  });
  assert.deepEqual(story.map((entry) => [entry.field, entry.signal, entry.text]), [
    ['acceptanceCriteria', 'structured', 'The exported value equals 2.'],
    ['acceptanceCriteria', 'structured', 'Old callers keep working.'],
    ['constraints', 'structured', 'No new dependency'],
    ['description', 'modal', 'The API must stay stable.']
  ]);
});

async function storyDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'singularity/work-items/W-1');
  await mkdir(path.join(directory, 'inputs/DOC-001'), { recursive: true });
  await mkdir(path.join(directory, 'context'), { recursive: true });
  await writeFile(path.join(directory, 'inputs/DOC-001/brief.md'), '# Brief\n\nThe export must include headers.\nThe exported value equals 2 and must be stable.\n');
  await writeFile(path.join(directory, 'documents.json'), JSON.stringify({ schemaVersion: 3, workId: 'W-1', documents: [
    { id: 'DOC-001', type: 'file', name: 'Brief', path: 'singularity/work-items/W-1/inputs/DOC-001/brief.md', mimeType: 'text/markdown', sha256: 'a'.repeat(64) },
    { id: 'DOC-002', type: 'url', name: 'Design', url: 'https://example.test/design' },
    { id: 'DOC-003', type: 'file', name: 'Old', path: 'x', status: 'detached' }
  ] }));
  await writeFile(path.join(directory, 'context/clarifications-intake-gen1.json'), JSON.stringify({
    workId: 'W-1', phase: 'intake', generation: 1,
    responses: [{ id: 'Q-001', question: 'Headers?', answer: 'Yes. The export must include headers.', status: 'answered' }]
  }));
  return { root, directory };
}

const workflow = (extra = {}) => ({
  workItem: { id: 'W-1', title: 'Change the value' }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake'],
  phases: { intake: { id: 'intake', status: 'in_progress', generation: 1, approvals: [], approvalPolicy: { mode: 'required', authorities: ['product-approvers'] } } },
  resolution: { obligationGraph: { nodes: [{ id: 'intake', responsibilities: ['scope', 'plan', 'review'] }], endpoints: [] } },
  ...extra
});

test('the inventory lists every statement and source, includes what a clause states, and blocks the rest', async (t) => {
  const { root, directory } = await storyDirectory(t);
  const source = { description: 'The API must stay stable.', acceptanceCriteria: ['The exported value equals 2.'] };
  const clauses = [{ id: 'W-1:AC-001', body: 'The exported value equals 2.' }];
  const inventory = await buildScopeInventory(root, directory, workflow(), { source, clauses });

  const sources = Object.fromEntries(inventory.sources.map((entry) => [entry.id, entry]));
  assert.equal(sources['DOC-002'].readable, false);
  assert.equal(sources['DOC-002'].reason, 'external-reference', 'an unreadable source is reported, never silently reviewed');
  assert.equal(sources['DOC-003'], undefined, 'a detached document is not a source');
  assert.ok(sources['clarification:intake:Q-001'], 'answered clarifications are sources');

  const byText = (text) => inventory.items.find((item) => item.text === text && item.sourceId === 'story');
  assert.equal(byText('The exported value equals 2.').disposition, 'included');
  assert.deepEqual(byText('The exported value equals 2.').clauseIds, ['W-1:AC-001']);
  assert.equal(byText('The API must stay stable.').disposition, 'unresolved');
  const headers = inventory.items.filter((item) => normalizeStatement(item.text) === 'the export must include headers');
  assert.deepEqual(headers.map((item) => item.disposition), ['unresolved', 'duplicate'], 'a statement repeated verbatim in another source is a duplicate');
  assert.equal(inventory.items.find((item) => item.id === 'DOC-002').disposition, 'unresolved');
  assert.equal(inventory.structurallyComplete, false);

  const graph = evidenceGraph({ workflow: workflow(), records: { indexes: [] }, scope: inventory });
  const evaluation = evaluateEvidence(graph);
  const scopeRows = evaluation.rows.filter((row) => row.type === 'SCOPE');
  assert.ok(scopeRows.every((row) => row.result === 'pending' || row.result === 'not-applicable'));
  assert.ok(evaluation.findings.some((entry) => entry.code === 'SCOPE_ITEMS_UNRESOLVED'));
  assert.equal(evaluation.decision.gate, 'block');
  assert.match(scopeRows.find((row) => row.result === 'pending').actions[0].command, /decision scope --item (?:SRI-|DOC-)/);
});

test('a scope decision disposes of an item while its statement is unchanged, and lapses when it changes', async (t) => {
  const { root, directory } = await storyDirectory(t);
  const source = { description: 'The API must stay stable.' };
  const story = workflow();
  const inventory = await buildScopeInventory(root, directory, story, { source, clauses: [] });
  const item = inventory.items.find((entry) => entry.text === 'The API must stay stable.');
  const decide = (overrides = {}) => recordScopeDecision(story, {
    item: item.id, disposition: 'excluded', reason: 'Stability is owned by the platform team, not this Story.',
    actor: 'po@example.test', authorityGroup: 'product-approvers', at: '2026-10-03T00:00:00.000Z', inventory, knownClauseIds: [], ...overrides
  });
  assert.throws(() => decide({ disposition: 'included' }), (error) => error.code === 'SCOPE_CLAUSES_REQUIRED');
  assert.throws(() => decide({ disposition: 'included', clauseIds: ['W-1:AC-009'] }), (error) => error.code === 'SCOPE_CLAUSE_UNKNOWN');
  assert.throws(() => decide({ clauseIds: ['W-1:AC-001'] }), (error) => error.code === 'SCOPE_CLAUSES_UNEXPECTED');
  assert.throws(() => decide({ reason: 'too short' }), (error) => error.code === 'SCOPE_REASON_REQUIRED');
  assert.throws(() => decide({ item: 'SRI-000000000000' }), (error) => error.code === 'SCOPE_ITEM_UNKNOWN');
  decide();
  const decided = await buildScopeInventory(root, directory, story, { source, clauses: [] });
  assert.equal(decided.items.find((entry) => entry.id === item.id).disposition, 'excluded');
  const evaluation = evaluateEvidence(evidenceGraph({ workflow: story, records: { indexes: [] }, scope: decided }));
  assert.equal(evaluation.rows.find((row) => row.id === item.id).result, 'not-applicable', 'a scope decision is shown, never as an exception');

  // The same item from a changed statement is a different item; the old decision applies to nothing.
  const changed = await buildScopeInventory(root, directory, story, { source: { description: 'The API must stay stable for a year.' }, clauses: [] });
  assert.equal(changed.items.find((entry) => entry.text === 'The API must stay stable for a year.').disposition, 'unresolved');
});

test('a decision that scope does not apply covers every undisposed statement, visibly', async (t) => {
  const { root, directory } = await storyDirectory(t);
  const inventory = await buildScopeInventory(root, directory, workflow(), {
    source: { description: 'The API must stay stable.' }, clauses: [], scopeNotApplicable: true
  });
  assert.ok(inventory.items.length > 0);
  assert.ok(inventory.items.every((item) => item.disposition !== 'unresolved'));
  const covered = inventory.items.find((item) => item.text === 'The API must stay stable.');
  assert.deepEqual([covered.disposition, covered.coveredBy], ['informative', 'scope-not-applicable']);
  assert.equal(inventory.structurallyComplete, true);
});

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Scope Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('the CLI shows the inventory and records a scope decision through the scope step\'s group', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-scope-cli-'));
  const remote = `${root}-remote.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const git = (...args) => run('git', args, root).stdout.trim();
  const sflow = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Scope Tester');
  git('config', 'user.email', 'scope@example.test');
  await writeFile(path.join(root, 'README.md'), '# Scope fixture\n');
  sflow('init');
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.worldModel.grounding = 'off';
  definition.git.publish = 'off';
  definition.repositoryReadiness = { ...(definition.repositoryReadiness ?? {}), requiredBeforeStory: false };
  definition.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(definition.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(file, YAML.stringify(definition));
  git('add', '.');
  git('commit', '-qm', 'Govern the fixture');
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');
  sflow('start', 'SCOPE-1', '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value',
    '--description', 'Change the value. The public API must stay stable.');

  const shown = JSON.parse(sflow('evidence', 'scope', '--json').stdout);
  assert.equal(shown.operation.id, 'evidence.scope');
  const item = shown.data.scope.items.find((entry) => entry.text === 'The public API must stay stable.');
  assert.equal(item.disposition, 'unresolved');
  assert.match(sflow('evidence', 'scope').stdout, /Unresolved \(1\):\n {2}SRI-[0-9a-f]{12} \[story\] The public API must stay stable\./);

  sflow('decision', 'scope', '--item', item.id, '--as', 'excluded', '--reason', 'The API contract is out of scope for this Story.');
  const after = JSON.parse(sflow('evidence', 'scope', '--json').stdout).data.scope;
  assert.equal(after.items.find((entry) => entry.id === item.id).disposition, 'excluded');
  assert.equal(after.structurallyComplete, true);
  const workflowState = JSON.parse(await readFile(path.join(root, 'singularity/work-items/SCOPE-1/workflow.json'), 'utf8'));
  assert.equal(workflowState.scopeDispositions.at(-1).authorityGroup, 'product-approvers');
  assert.equal(workflowState.history.at(-1).event, 'scope_decided');
});
